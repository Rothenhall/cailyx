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
 * G07 added two things here, both opt-in and both inert for a job that does
 * not ask for them:
 *
 * - **Heartbeats.** A job whose data carries a `jobRunId` is announced to the
 *   registered {@link JobRunTracker}, which the durable ledger implements. The
 *   worker writes a heartbeat every {@link HEARTBEAT_INTERVAL_MS} while the
 *   handler runs and reports the outcome when it returns or throws. A job
 *   without a `jobRunId` behaves exactly as it did before.
 * - **`projectId` on status reads.** {@link getStatus} now reports the job's
 *   own `projectId` so a `GET .../jobs/:jobId` handler has something to check
 *   the URL's `:projectId` against (G03 —
 *   `ScopeValidationService.assertJobBelongsToProject` was written against
 *   this field and had nothing to read until now).
 *
 * **Who attaches a `jobRunId` (G07/A7).** The four audit modules enqueue their
 * own jobs and none of them knows about the ledger — deliberately, since the
 * package boundary runs the other way. So the queue attaches the run itself:
 * {@link enqueue} asks the tracker for a run for this job (name + project) and,
 * when the tracker creates one, hands the job a `jobRunId` merged into its
 * data. A job that already carries one keeps it; a job whose data has no
 * `projectId`, whose name maps to no task kind, or whose run could not be
 * created is enqueued **untracked, exactly as before** — the ledger is
 * bookkeeping and must never be able to stop the work it would have recorded.
 * Set `PIPELINE_AUTO_TRACK_RUNS=0` to turn the whole thing off.
 *
 * @module pipeline-queue.service
 */

import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
// The single job-name → task-kind map. Imported rather than re-derived so the
// budget gate and the run ledger can never disagree about what a job is called.
import { JOB_NAME_TASK_KIND } from './jobs.types';

export type PipelineJobHandler = (data: any) => Promise<unknown>;

export type PipelineJobStatus = {
  status: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'not_found';
  result?: unknown;
  error?: string;
  attemptsMade?: number;
  /**
   * The `projectId` the job was enqueued for, when its data carried one.
   * Present for every audit pipeline; absent for a job enqueued without one,
   * in which case a scoped caller must treat the job as not-found rather than
   * assume it is theirs.
   */
  projectId?: string;
};

/**
 * What the queue tells the tracker about a job it is about to enqueue, so the
 * tracker can create the run that the job will then carry.
 */
export interface EnqueueTrackingRequest {
  /** The BullMQ job name, e.g. `technical-audit`. */
  jobName: string;
  /** The project the job belongs to — what scopes the run. */
  projectId: string;
  /** How many queue attempts the job was queued with, when the caller set it. */
  attempts?: number;
  /** The job's own parameters, minus any run id. Recorded as the run's `input`. */
  data: Record<string, unknown>;
}

/**
 * The durable ledger's view of a queue job. Implemented by `JobsService` and
 * registered through {@link PipelineQueueService.registerRunTracker}. Kept as
 * an interface (rather than a direct dependency) so the queue never depends
 * on the jobs service — the same inversion `registerHandler` already uses.
 */
export interface JobRunTracker {
  /**
   * Create the durable run for a job the queue is about to enqueue.
   *
   * Returns the run id to have the job carry it, or `null` to leave the job
   * untracked — which is the honest answer when this job must not share a run
   * (another run of the same kind is already in flight, say) or when nothing
   * about the job can be scoped to a run. Returning null is never an error:
   * the job still runs.
   */
  onEnqueue(request: EnqueueTrackingRequest): Promise<{ jobRunId: string } | null>;
  /** Called once when a tracked attempt starts. `queueAttempt` is 1-based. */
  onStart(jobRunId: string, jobName: string, queueAttempt: number): Promise<void>;
  /** Called periodically while the handler runs. Must be cheap. */
  onHeartbeat(jobRunId: string): Promise<void>;
  /**
   * Called once when the handler returns or throws. `willRetry` is true when
   * another queue attempt is still available, so the ledger can hold the run
   * in a queued-again state instead of failing it prematurely.
   */
  onSettled(jobRunId: string, outcome: { ok: boolean; error?: string; willRetry: boolean }): Promise<void>;
  /** Consulted before the handler runs, so a cancelled run is not paid for. */
  isCancelled(jobRunId: string): Promise<boolean>;
}

const QUEUE_NAME = 'cailyx-pipeline';
/** Kept low — jobs run Playwright renders and hit external APIs (GSC, PSI, LLM surfaces). */
const WORKER_CONCURRENCY = 2;
/**
 * How often a tracked job refreshes its run heartbeat. The ledger's stale
 * threshold (default 5 minutes) is deliberately several multiples of this.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

@Injectable()
export class PipelineQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineQueueService.name);
  private readonly queue: Queue;
  private readonly redis: Redis;
  private workerConnection: Redis | null = null;
  private worker: Worker | null = null;

  private readonly handlers = new Map<string, PipelineJobHandler>();
  private runTracker: JobRunTracker | null = null;

  /**
   * Whether {@link enqueue} attaches a durable run to the jobs it queues.
   * On by default — the every-run-is-recorded behaviour is the point of G07 —
   * and switchable off with `PIPELINE_AUTO_TRACK_RUNS=0` for a deployment that
   * wants the ledger out of the enqueue path entirely.
   */
  private readonly autoTrackRuns: boolean;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
    this.autoTrackRuns = !['0', 'false', 'off'].includes(
      (process.env.PIPELINE_AUTO_TRACK_RUNS ?? '1').trim().toLowerCase(),
    );
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
        return this.runHandler(job.name, job.data, job.attemptsMade ?? 0, job.opts?.attempts ?? 1, handler);
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

  /**
   * Run one queue job, reporting to the durable ledger when the job asked to
   * be tracked. Every tracker call is wrapped: bookkeeping must never be able
   * to fail a job that otherwise succeeded, or change what a handler returns.
   */
  private async runHandler(
    jobName: string,
    data: unknown,
    attemptsMade: number,
    attemptsAllowed: number,
    handler: PipelineJobHandler,
  ): Promise<unknown> {
    const jobRunId = readJobRunId(data);
    const tracker = this.runTracker;
    if (!jobRunId || !tracker) return handler(data);

    const queueAttempt = attemptsMade + 1;
    const willRetryOnFailure = queueAttempt < attemptsAllowed;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    try {
      await this.callTracker(() => tracker.onStart(jobRunId, jobName, queueAttempt));

      // A run cancelled while it sat in the queue must not be paid for. This is
      // checked once, before any spend, not continuously.
      if (await this.callTracker(() => tracker.isCancelled(jobRunId))) {
        this.logger.warn(`Job ${jobName} skipped: run ${jobRunId} was cancelled before it started`);
        return { skipped: true, reason: 'The run was cancelled before this attempt started.' };
      }

      heartbeatTimer = setInterval(() => {
        void this.callTracker(() => tracker.onHeartbeat(jobRunId));
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      const result = await handler(data);
      await this.callTracker(() => tracker.onSettled(jobRunId, { ok: true, willRetry: false }));
      return result;
    } catch (err) {
      await this.callTracker(() =>
        tracker.onSettled(jobRunId, {
          ok: false,
          error: (err as Error).message,
          willRetry: willRetryOnFailure,
        }),
      );
      throw err;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  /** Tracker bookkeeping is best-effort: log and continue, never rethrow. */
  private async callTracker(fn: () => Promise<boolean | void>): Promise<boolean> {
    try {
      const result = await fn();
      return result === true;
    } catch (err) {
      this.logger.warn(`Job run tracker call failed (job unaffected): ${(err as Error).message}`);
      return false;
    }
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

  /** True when a processor for this job name is registered in this process. */
  hasHandler(jobName: string): boolean {
    return this.handlers.has(jobName);
  }

  /**
   * Register the durable-ledger tracker (G07). Called once by `JobsService`
   * on module init; without it, tracked jobs still run, they just leave no
   * heartbeat behind.
   */
  registerRunTracker(tracker: JobRunTracker): void {
    this.runTracker = tracker;
    this.logger.log('Registered job run tracker');
  }

  /**
   * Enqueue a job, attaching a durable run to it when one can be created.
   *
   * The run is created **before** the job is added, so a crash between the two
   * leaves a `queued` run that is visible in the ledger rather than a job
   * nobody recorded. The order is the only thing this method guarantees about
   * the ledger: a run that appears here has a job, and a job that carries a
   * `jobRunId` has a run.
   *
   * @returns the queue's job id, and the durable `jobRunId` when the job is
   *          tracked (null when it is not — the caller does not have to care,
   *          it is returned so a feature module can link to the run).
   */
  async enqueue(
    jobName: string,
    data: Record<string, unknown>,
    opts?: JobsOptions,
  ): Promise<{ jobId: string; jobRunId: string | null }> {
    await this.assertBudgetAllows(jobName, data);
    const attached = await this.attachRun(jobName, data, opts?.attempts);
    const job = await this.queue.add(jobName, attached.data, opts);
    if (attached.jobRunId) {
      this.logger.log(`Job ${jobName} (${job.id}) tracked as run ${attached.jobRunId}`);
    }
    return { jobId: job.id!, jobRunId: attached.jobRunId };
  }

  /**
   * The budget gate, when the budget module is present.
   *
   * Held as an optional collaborator rather than a constructor dependency so
   * the queue can still be constructed in isolation (the G07 harness does
   * exactly that). `JobsModule` calls this once at bootstrap.
   */
  private budgetGate: { assertWithinBudget(projectId: string, taskKind: string): Promise<unknown> } | null = null;

  /** Registers the budget gate. Idempotent; last registration wins. */
  setBudgetGate(gate: {
    assertWithinBudget(projectId: string, taskKind: string): Promise<unknown>;
  }): void {
    this.budgetGate = gate;
  }

  /**
   * Refuse to queue work that would breach a hard budget ceiling.
   *
   * This is the only place every background run passes through, including the
   * runs with no UI in front of them, so it is where a cap has to be enforced
   * to be real. `ReservationsService.reserve` was previously called only by the
   * API, which meant a `BudgetPolicy` bounded nothing that ran on a schedule.
   *
   * Deliberately narrow, in three ways:
   *
   *  - **A project with no policy is untouched.** The gate asks the budget
   *    module, and the common case answers "no ceiling applies" without
   *    creating anything.
   *  - **Only hard enforcement refuses.** A soft ceiling is advisory by design;
   *    turning it into a blocker would change what someone configured.
   *  - **A budget-check failure does not stop the work.** If the policy read
   *    itself errors, the job is enqueued and the error logged. The opposite
   *    order would mean a availability problem in the budget module silently
   *    halts every pipeline — a much worse failure than an overrun.
   */
  private async assertBudgetAllows(jobName: string, data: Record<string, unknown>): Promise<void> {
    if (!this.budgetGate) return;
    const projectId = readProjectId(data);
    if (typeof projectId !== 'string' || projectId.length === 0) return;

    const taskKind = JOB_NAME_TASK_KIND[jobName] ?? jobName;
    try {
      await this.budgetGate.assertWithinBudget(projectId, taskKind);
    } catch (err) {
      // A hard ceiling breach is a decision, not a fault: it propagates and
      // nothing is queued.
      if (err instanceof ConflictException) throw err;
      this.logger.warn(
        `Budget pre-flight for ${jobName} on project ${projectId} could not be evaluated (${
          err instanceof Error ? err.message : String(err)
        }); enqueueing anyway.`,
      );
    }
  }

  /**
   * Ask the tracker for a run for this job, and hand the job its id.
   *
   * Every reason not to attach is a reason to enqueue anyway: an untracked job
   * is the pre-G07 behaviour, and losing a paid audit because the ledger was
   * unreachable would be a far worse failure than a missing row.
   */
  private async attachRun(
    jobName: string,
    data: Record<string, unknown>,
    attempts: number | undefined,
  ): Promise<{ data: Record<string, unknown>; jobRunId: string | null }> {
    // A caller that attached its own run keeps it: this path exists for the
    // feature modules that do not know the ledger exists.
    const existing = readJobRunId(data);
    if (existing) return { data, jobRunId: existing };
    if (!this.autoTrackRuns || !this.runTracker) return { data, jobRunId: null };

    const projectId = readProjectId(data);
    if (!projectId) {
      // Reported, not silent: this is the one adoption a feature module has to
      // make for its jobs to appear in the ledger (see the module README).
      this.logger.debug(
        `Job ${jobName} is not tracked: its data carries no projectId, so no run can be scoped to it.`,
      );
      return { data, jobRunId: null };
    }

    try {
      // The run's `input` is the job's own parameters; the run id is not one
      // of them, so it is stripped before the tracker records them.
      const parameters: Record<string, unknown> = { ...data };
      delete parameters.jobRunId;
      const created = await this.runTracker.onEnqueue({
        jobName,
        projectId,
        ...(attempts != null ? { attempts } : {}),
        data: parameters,
      });
      if (!created) return { data, jobRunId: null };
      return { data: { ...data, jobRunId: created.jobRunId }, jobRunId: created.jobRunId };
    } catch (err) {
      this.logger.warn(
        `Could not create a durable run for ${jobName} — enqueuing it untracked so the work still happens: ${(err as Error).message}`,
      );
      return { data, jobRunId: null };
    }
  }

  /**
   * Status of a queued job. Also carries the job's `projectId` so a scoped
   * route can prove the job belongs to the `:projectId` in its URL before
   * returning anything (G03) — the job's full data is deliberately *not*
   * exposed, because it can carry a `userId` or run parameters that are
   * nobody else's business.
   */
  async getStatus(jobId: string): Promise<PipelineJobStatus> {
    const job = await this.queue.getJob(jobId);
    if (!job) return { status: 'not_found' };

    const projectId = readProjectId(job.data);
    const state = await job.getState();
    if (state === 'completed') {
      return { status: 'completed', result: job.returnvalue, attemptsMade: job.attemptsMade, projectId };
    }
    if (state === 'failed') {
      return { status: 'failed', error: job.failedReason, attemptsMade: job.attemptsMade, projectId };
    }
    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      return { status: state, attemptsMade: job.attemptsMade, projectId };
    }
    // waiting-children, prioritized, unknown, etc. — treat as still queued
    return { status: 'waiting', attemptsMade: job.attemptsMade, projectId };
  }
}

/** The `jobRunId` a durable-ledger-tracked job carries, if any. */
function readJobRunId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>).jobRunId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The `projectId` a job was enqueued for, if any. */
function readProjectId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>).projectId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
