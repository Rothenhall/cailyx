/**
 * Pipeline Queue Service — runs the client-facing audit pipelines
 * (technical audit, SEO audit, presence discovery, AEO audit) on a shared
 * BullMQ queue instead of inline inside the HTTP request.
 *
 * Mirrors the Queue/Worker/ioredis shape already used by SchedulingService,
 * but is always on: this is now the primary run path for those pipelines,
 * not an opt-in recurring-schedule backend, so Redis is a required
 * dependency here rather than an optional one.
 *
 * Feature services register their own processor via `registerHandler` in
 * their own constructor (the same extension-point shape technical-audit
 * already uses on SchedulingService), so this module never needs to import
 * the four feature modules.
 *
 * @module pipeline-queue.service
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';

export type PipelineJobHandler = (data: any) => Promise<unknown>;

export type PipelineJobStatus = {
  status: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'not_found';
  result?: unknown;
  error?: string;
  attemptsMade?: number;
};

const QUEUE_NAME = 'cailyx-pipeline';
/** Kept low — jobs run Playwright renders and hit external APIs (GSC, PSI, LLM surfaces). */
const WORKER_CONCURRENCY = 2;

@Injectable()
export class PipelineQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineQueueService.name);
  private readonly queue: Queue;
  private readonly redis: Redis;
  private workerConnection: Redis | null = null;
  private worker: Worker | null = null;

  private readonly handlers = new Map<string, PipelineJobHandler>();

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    // ioredis emits `error` on every failed reconnect, and an `error` event
    // with no listener is fatal in Node. With `maxRetriesPerRequest: null` it
    // retries forever, so a Redis that is simply not running took the whole
    // API process down in a loop -- the queue is optional infrastructure and
    // must never be able to do that. Logged at warn, not error: an absent
    // Redis in local dev is a known state, not an incident.
    this.redis.on('error', (err: Error) => {
      this.logger.warn(`Redis connection: ${err.message}`);
    });
    this.queue = new Queue(QUEUE_NAME, { connection: this.redis });
  }

  async onModuleInit(): Promise<void> {
    this.workerConnection = this.redis.duplicate();
    // `duplicate()` makes a fresh connection with its own event emitter, so it
    // needs its own listener — the one on `this.redis` does not cover it.
    this.workerConnection.on('error', (err: Error) => {
      this.logger.warn(`Redis worker connection: ${err.message}`);
    });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const handler = this.handlers.get(job.name);
        if (!handler) {
          throw new Error(`No pipeline handler registered for job: ${job.name}`);
        }
        this.logger.log(`Processing job ${job.name} (${job.id})`);
        return handler(job.data);
      },
      { connection: this.workerConnection, concurrency: WORKER_CONCURRENCY },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Job completed: ${job.name} (${job.id})`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job failed: ${job?.name} (${job?.id}) — ${err.message}`);
    });

    this.logger.log('Pipeline queue worker started');
  }

  /** Release the worker + both Redis connections on shutdown/HMR reload. */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
      await this.queue.close();
      this.workerConnection?.disconnect();
      this.redis.disconnect();
      this.logger.log('Pipeline queue connections closed');
    } catch (err) {
      this.logger.warn(`Pipeline queue teardown error: ${(err as Error).message}`);
    }
  }

  /** Register the processor for a job name. Called by each feature service's constructor. */
  registerHandler(jobName: string, handler: PipelineJobHandler): void {
    this.handlers.set(jobName, handler);
    this.logger.log(`Registered pipeline handler: ${jobName}`);
  }

  async enqueue(
    jobName: string,
    data: Record<string, unknown>,
    opts?: JobsOptions,
  ): Promise<{ jobId: string }> {
    const job = await this.queue.add(jobName, data, opts);
    return { jobId: job.id! };
  }

  async getStatus(jobId: string): Promise<PipelineJobStatus> {
    const job = await this.queue.getJob(jobId);
    if (!job) return { status: 'not_found' };

    const state = await job.getState();
    if (state === 'completed') {
      return { status: 'completed', result: job.returnvalue, attemptsMade: job.attemptsMade };
    }
    if (state === 'failed') {
      return { status: 'failed', error: job.failedReason, attemptsMade: job.attemptsMade };
    }
    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      return { status: state, attemptsMade: job.attemptsMade };
    }
    // waiting-children, prioritized, unknown, etc. — treat as still queued
    return { status: 'waiting', attemptsMade: job.attemptsMade };
  }
}
