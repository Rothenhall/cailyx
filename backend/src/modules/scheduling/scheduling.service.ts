/**
 * Scheduling Service — Manages recurring audit jobs via BullMQ v6.
 *
 * Uses JobScheduler for repeatable/cron jobs.
 * Stores schedule config in the database via PrismaService.
 *
 * @module scheduling.service
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, JobScheduler } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';

export type ScheduledTaskHandler = (projectId: string, targetUrl: string) => Promise<void>;

@Injectable()
export class SchedulingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulingService.name);
  private queue: Queue;
  private worker: Worker | null = null;
  private redis: Redis;
  /** The worker's own duplicated connection — tracked so it can be closed. */
  private workerConnection: Redis | null = null;

  private readonly handlers = new Map<string, ScheduledTaskHandler>();

  constructor(private readonly prisma: PrismaService) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('cailyx-scheduled-tasks', { connection: this.redis });
  }

  async onModuleInit(): Promise<void> {
    this.workerConnection = this.redis.duplicate();
    this.worker = new Worker(
      'cailyx-scheduled-tasks',
      async (job) => {
        const { taskName, projectId, targetUrl } = job.data;
        const handler = this.handlers.get(taskName);
        if (handler) {
          this.logger.log(`Running scheduled task: ${taskName} for project ${projectId}`);
          await handler(projectId, targetUrl);
        } else {
          this.logger.warn(`No handler registered for task: ${taskName}`);
        }
      },
      { connection: this.workerConnection },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Scheduled task completed: ${job.name}`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Scheduled task failed: ${job?.name} — ${err.message}`);
    });

    this.logger.log('Scheduling service initialized');
  }

  /**
   * Release the BullMQ worker + both Redis connections on shutdown/HMR reload.
   * Without this, every `nest start --watch` reload and every test that boots
   * the app leaks a Worker and two ioredis sockets that keep retrying forever.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
      await this.queue.close();
      this.workerConnection?.disconnect();
      this.redis.disconnect();
      this.logger.log('Scheduling service connections closed');
    } catch (err) {
      this.logger.warn(`Scheduling teardown error: ${(err as Error).message}`);
    }
  }

  registerHandler(taskName: string, handler: ScheduledTaskHandler): void {
    this.handlers.set(taskName, handler);
    this.logger.log(`Registered handler for task: ${taskName}`);
  }

  async setSchedule(
    projectId: string,
    cadence: 'weekly' | 'monthly' | 'manual-only',
    targetUrl: string,
    taskName: string = 'technical-audit',
  ): Promise<{ cadence: string; nextRunAt: string | null; active: boolean }> {
    // Remove existing scheduled job
    await this.removeExistingJobs(projectId, taskName);

    if (cadence === 'manual-only') {
      await this.prisma.scheduleConfig.upsert({
        where: { projectId },
        create: { projectId, cadence, active: false, nextRunAt: null },
        update: { cadence, active: false, nextRunAt: null },
      });
      this.logger.log(`Schedule set to manual-only for project ${projectId}`);
      return { cadence, nextRunAt: null, active: false };
    }

    const cronExpr = cadence === 'weekly' ? '0 0 * * 1' : '0 0 1 * *';
    const nextRunAt = this.getNextRunDate(cadence);

    // Use JobScheduler for repeatable jobs (BullMQ v6 API)
    await this.queue.upsertJobScheduler(
      `${taskName}:${projectId}`,
      { pattern: cronExpr },
      { data: { taskName, projectId, targetUrl } },
    );

    await this.prisma.scheduleConfig.upsert({
      where: { projectId },
      create: { projectId, cadence, active: true, nextRunAt },
      update: { cadence, active: true, nextRunAt },
    });

    this.logger.log(`Schedule set to ${cadence} for project ${projectId}, next run: ${nextRunAt.toISOString()}`);
    return { cadence, nextRunAt: nextRunAt.toISOString(), active: true };
  }

  async getSchedule(projectId: string): Promise<{ cadence: string; nextRunAt: string | null; active: boolean }> {
    const config = await this.prisma.scheduleConfig.findUnique({ where: { projectId } });
    if (!config) {
      return { cadence: 'manual-only', nextRunAt: null, active: false };
    }
    return {
      cadence: config.cadence,
      nextRunAt: config.nextRunAt?.toISOString() || null,
      active: config.active,
    };
  }

  async removeSchedule(projectId: string, taskName: string = 'technical-audit'): Promise<void> {
    await this.removeExistingJobs(projectId, taskName);
    await this.prisma.scheduleConfig.updateMany({
      where: { projectId },
      data: { active: false, nextRunAt: null, cadence: 'manual-only' },
    });
  }

  private async removeExistingJobs(projectId: string, taskName: string): Promise<void> {
    try {
      await this.queue.removeJobScheduler(`${taskName}:${projectId}`);
    } catch {
      // Job scheduler may not exist — ignore
    }
  }

  private getNextRunDate(cadence: 'weekly' | 'monthly'): Date {
    const now = new Date();
    if (cadence === 'weekly') {
      const next = new Date(now);
      const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
      next.setDate(now.getDate() + daysUntilMonday);
      next.setHours(0, 0, 0, 0);
      return next;
    } else {
      return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    }
  }
}