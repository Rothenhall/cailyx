import { ModuleRef } from '@nestjs/core';
import { BudgetsService } from '../budgets/budgets.service';
/**
 * JobsService — G07: the durable job ledger.
 *
 * The whole point of this file is that `JobRun`/`JobStep` rows in SQLite are
 * the truth about what ran, what it cost and what is left, so that a client
 * reload, an API restart or a killed worker cannot make the app forget a paid
 * run (design_plan §10.3: "Local memory is not a durable job ledger").
 *
 * Four behaviours here are load-bearing and are not to be relaxed:
 *
 * 1. **Create-or-return-existing.** {@link createRun} with an `idempotencyKey`
 *    that already exists returns the *existing* run and reports
 *    `outcome: 'existing'` — it never starts a second run. The database's
 *    unique index is the arbiter, so two concurrent callers cannot both win:
 *    the loser gets `P2002` and re-reads the winner's row.
 * 2. **Bounded recovery, never duplication.** {@link recoverStaleRuns}
 *    reconciles runs whose heartbeat went stale while `status = 'running'`.
 *    It marks *that* run interrupted; it never creates a replacement. A
 *    worker restart therefore yields exactly one recoverable run.
 * 3. **Honest cancellation.** {@link cancel} returns what was already spent
 *    and whether the work is reversible. It never implies a refund.
 * 4. **`partial` is a status.** Run status is derived from steps
 *    ({@link settle}), so three of five engines answering reads as
 *    `partial` with a coverage sentence, not as `completed`.
 *
 * @module jobs.service
 */

import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, type JobRun, type JobStep } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PipelineQueueService, type EnqueueTrackingRequest, type JobRunTracker } from './pipeline-queue.service';
import { computeCoverage, deriveStatusFromSteps, toStepDtos } from './lib/coverage.util';
import {
  JOB_NAME_TASK_KIND,
  JOB_RUN_STATUSES,
  PIPELINE_JOB_NAME,
  TERMINAL_RUN_STATUSES,
  type JobRunDto,
  type JobRunStatus,
  type JobTrigger,
  type RunActions,
  type TaskKind,
} from './jobs.types';

/** How the create-or-return-existing call resolved. */
export type CreateRunOutcome =
  /** A new run row was created by this call. */
  | 'created'
  /** The idempotency key already existed — this is that run, returned untouched. */
  | 'existing'
  /** Another run of the same task kind is in flight on this project (per-project run lock). */
  | 'locked';

export interface CreateRunResult {
  outcome: CreateRunOutcome;
  run: JobRun;
}

export interface CreateRunInput {
  projectId: string;
  taskKind: TaskKind | string;
  /**
   * De-duplication key. Two calls with the same key share one run forever,
   * even after it finishes: a scheduler tick that fires twice for the same
   * scheduled instant must not buy the same data twice.
   */
  idempotencyKey?: string | null;
  input?: Record<string, unknown>;
  trigger?: JobTrigger;
  triggeredBy?: string | null;
  cadenceRuleId?: string | null;
  stage?: string | null;
  maxAttempts?: number;
  reversible?: boolean;
  /** Steps to create alongside the run, in order. */
  steps?: Array<{ name: string; position?: number }>;
  /** Cost ceiling carried into the run's input for the executor to honour. */
  maxCostUsd?: number | null;
  /** Human label for the run in the job list, e.g. "Technical audit — example.com". */
  label?: string;
}

/** The disclosure a cancel response must carry. */
export interface CancelResult {
  run: JobRunDto;
  cancelled: true;
  /** What the run has already spent. Recorded cost, never an estimate. */
  spentUsd: number;
  spentCredits: number;
  /** Whether cancelling can still undo what the run produced. */
  reversible: boolean;
  /** True when spend or irreversible side effects remain after cancelling. */
  hasUnrecoverableWork: boolean;
  /** The sentence the caller must surface. */
  statement: string;
  /** Always false. Cancelling never returns money or credits. */
  refunded: false;
  /** Steps that were mid-flight when the cancel landed. */
  interruptedSteps: string[];
}

export interface RetryResult {
  run: JobRunDto;
  attempt: number;
  maxAttempts: number;
  /** Steps reset back to pending because they did not produce a result. */
  resetSteps: string[];
  /** Steps left succeeded — retry never re-buys a result that already exists. */
  preservedSteps: string[];
  /** True when the run was handed back to the queue. */
  requeued: boolean;
  /** Why it was not requeued, when it was not. Never a silent no-op. */
  requeueBlockedReason: string | null;
}

export interface RecoveryReport {
  /** Runs reconciled by this sweep. */
  recovered: number;
  /** Cut-off used: heartbeats older than this are stale. */
  staleAfterMs: number;
  runs: Array<{
    id: string;
    projectId: string;
    taskKind: string;
    /** Null for a run that never started, which has no heartbeat to report. */
    lastHeartbeatAt?: string | null;
    /** How it was reconciled: a dead worker, or a job that never started. */
    recoveredAs?: 'failed-stale-heartbeat' | 'failed-never-started';
    error?: string;
  }>;
}

export interface RecordStepInput {
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attempted?: number;
  succeeded?: number;
  error?: string | null;
  costUsd?: number;
  position?: number;
}

/** Same response shape for both outcomes so the client never guesses. */
export interface RunStatusSummary {
  run: JobRunDto;
  /** False when the run already existed under this idempotency key. */
  created: boolean;
  /** True when another run of this kind was already in flight (409 to the caller). */
  locked: boolean;
  lockedBy: string | null;
}

/** Env-var integer with a fallback, so a typo cannot yield NaN. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parse a JSON object column, tolerating a hand-edited/corrupt row. */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

/**
 * The acting operator a job's data names, if it names one. Jobs enqueued by
 * the audit modules carry either the operator's `userId` (seo-audit) or a
 * `triggeredByUserId` (the queue's own retry path); anything else is not an
 * actor and must not be stored as one.
 */
function readActor(data: Record<string, unknown>): string | null {
  for (const key of ['triggeredByUserId', 'userId'] as const) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

@Injectable()
export class JobsService implements JobRunTracker, OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  /**
   * Heartbeat cadence the queue worker writes while a handler runs. Comfortably
   * below {@link staleAfterMs} so one missed tick is not read as a dead worker.
   */
  private readonly heartbeatIntervalMs = envInt('JOB_HEARTBEAT_INTERVAL_MS', 30_000);

  /** Age at which a `running` run's heartbeat is treated as a dead worker. */
  private readonly staleAfterMs = envInt('JOB_HEARTBEAT_STALE_MS', 300_000);

  /**
   * How long an in-flight run keeps the per-project+kind lock. A run that is
   * heartbeat-ing keeps refreshing `updatedAt`, so this only expires for a run
   * nobody is working on — which is exactly when the lock should stop blocking.
   */
  private readonly lockWindowMs = envInt('JOB_LOCK_WINDOW_MS', 3_600_000);
  /**
   * How long a run may sit in `queued` without ever having started before the
   * sweep declares it abandoned. Deliberately far longer than any normal queue
   * wait — a busy worker is not a dead one, and marking live work failed would
   * be worse than leaving a stale row.
   */
  private readonly abandonedQueuedAfterMs = Math.max(
    // Floor of five minutes. A `queued` run is not dead just because a worker
    // has not reached it yet, and this value does double duty: it bounds the
    // per-project lock as well as the sweep. Set below normal queue latency it
    // does real damage — observed in testing at 20s, where the sweep failed a
    // run that was still legitimately waiting and the worker then found its own
    // run already dead.
    envInt('JOB_ABANDONED_QUEUED_MS', 1_800_000),
    300_000,
  );

  /** Recovery sweep period; 0 disables the background sweep. */
  private readonly recoverySweepMs = envInt('JOB_RECOVERY_SWEEP_MS', 60_000);

  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PipelineQueueService,
    /**
     * Optional: `BudgetsService` when `BudgetsModule` is registered. Resolved
     * lazily so this module does not hard-depend on the budget module.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Register this service as the queue's run tracker and start the recovery
   * sweep. Registration happens after the queue's own `onModuleInit` (Nest
   * initialises dependencies first), so the worker is already up — it simply
   * has no jobs to track yet.
   */
  onModuleInit(): void {
    this.queue.registerRunTracker(this);

    // Connect the budget gate. Registered here rather than injected into the
    // queue's constructor so the queue stays constructible without the budget
    // module (the G07 harness builds exactly that graph). `BudgetsService` is
    // optional: if the module is absent, `get` returns undefined and the gate
    // stays null, which the queue treats as "no budget module, no gate".
    const gate = this.moduleRef?.get(BudgetsService, { strict: false });
    if (gate) {
      this.queue.setBudgetGate(gate);
      this.logger.log('Budget gate attached — queued runs are checked against hard ceilings');
    }
    if (this.recoverySweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweep();
      }, this.recoverySweepMs);
      // Never hold the process open for a maintenance sweep.
      this.sweepTimer.unref?.();
      this.logger.log(
        `Job ledger ready — heartbeat every ${this.heartbeatIntervalMs}ms, stale after ${this.staleAfterMs}ms, recovery sweep every ${this.recoverySweepMs}ms`,
      );
    } else {
      this.logger.log('Job ledger ready — background recovery sweep disabled (JOB_RECOVERY_SWEEP_MS=0)');
    }
  }

  /** Guard against overlapping sweeps when the DB is slow. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const report = await this.recoverStaleRuns();
      if (report.recovered > 0) {
        this.logger.warn(
          `Recovered ${report.recovered} interrupted job run(s): ${report.runs.map((r) => `${r.taskKind}/${r.id}`).join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Job recovery sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ── Creation (idempotency + per-project run lock) ─────────────────────

  /**
   * Create a run, or return the run that already exists under this
   * `idempotencyKey`. Safe under concurrent callers: the unique index on
   * `JobRun.idempotencyKey` decides the winner and the loser re-reads it.
   *
   * @returns `outcome: 'existing'` when the key was already used (the caller
   *          must NOT enqueue anything), `'locked'` when another run of the
   *          same kind is in flight on this project, `'created'` otherwise.
   */
  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const key = input.idempotencyKey?.trim() || null;

    // Idempotency first: it is the stronger guarantee. A duplicate scheduler
    // tick must return the original run, not a conflict.
    if (key) {
      const existing = await this.prisma.jobRun.findUnique({ where: { idempotencyKey: key } });
      if (existing) return { outcome: 'existing', run: existing };
    }

    const inflight = await this.findInFlightRun(input.projectId, String(input.taskKind));
    if (inflight) {
      // A concurrent caller may have created *this very run* between our
      // key lookup and here. If it is the same logical run, it is the answer
      // the caller asked for — not a conflict.
      if (key && inflight.idempotencyKey === key) return { outcome: 'existing', run: inflight };
      return { outcome: 'locked', run: inflight };
    }

    const steps = input.steps ?? [];
    const data: Prisma.JobRunUncheckedCreateInput = {
      projectId: input.projectId,
      taskKind: String(input.taskKind),
      idempotencyKey: key,
      status: 'queued',
      stage: input.stage ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      input: JSON.stringify({
        ...(input.input ?? {}),
        ...(input.maxCostUsd != null ? { maxCostUsd: input.maxCostUsd } : {}),
      }),
      artifacts: '{}',
      reversible: input.reversible ?? true,
      triggeredBy: input.triggeredBy ?? null,
      trigger: input.trigger ?? 'manual',
      cadenceRuleId: input.cadenceRuleId ?? null,
    };

    try {
      const run = await this.prisma.jobRun.create({ data });
      if (steps.length > 0) {
        await this.prisma.jobStep.createMany({
          data: steps.map((s, i) => ({
            jobRunId: run.id,
            name: s.name,
            position: s.position ?? i,
            status: 'pending',
          })),
        });
      }
      this.logger.log(`Job run created: ${run.taskKind} on ${run.projectId} (${run.id}, trigger=${run.trigger})`);
      return { outcome: 'created', run };
    } catch (err) {
      if (key && this.isUniqueViolation(err)) {
        // Another caller won the race between our lookup and our insert.
        const winner = await this.readByIdempotencyKey(key);
        if (winner) {
          this.logger.log(`Duplicate job run suppressed — returning existing ${winner.id} for key ${key}`);
          return { outcome: 'existing', run: winner };
        }
      }
      throw err;
    }
  }

  /**
   * The winner of a concurrent create commits before our constraint violation
   * is raised, but on SQLite the visibility of that commit is worth one short
   * retry rather than a 500 to the caller.
   */
  private async readByIdempotencyKey(key: string): Promise<JobRun | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await this.prisma.jobRun.findUnique({ where: { idempotencyKey: key } });
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    return null;
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }

  /**
   * A run of the same kind on the same project that is still in flight —
   * the per-project run lock (design_plan G07: "per-project run locks").
   * Bounded by {@link lockWindowMs} so a run nobody is working on cannot
   * block the schedule forever.
   */
  private async findInFlightRun(projectId: string, taskKind: string): Promise<JobRun | null> {
    const now = Date.now();
    // Two statuses, two different notions of "alive", because they fail
    // differently. A `running` run is alive while its worker is heartbeating.
    // A `queued` run has no heartbeat to read, so the only evidence is its age
    // — and treating it as in-flight for the full lock window is what let one
    // abandoned run block every later run of that kind for an hour.
    //
    // The queued bound is deliberately the same constant the recovery sweep
    // uses: past this point the sweep will have marked the run failed, so
    // blocking on it any longer would be blocking on something that no longer
    // claims to be in flight.
    return this.prisma.jobRun.findFirst({
      where: {
        projectId,
        taskKind,
        OR: [
          { status: 'running', updatedAt: { gte: new Date(now - this.lockWindowMs) } },
          { status: 'queued', updatedAt: { gte: new Date(now - this.abandonedQueuedAfterMs) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  /**
   * Runs for one project, newest first. `steps` is only loaded for the runs
   * actually returned, so a long history does not fan out into N queries.
   */
  async listRuns(
    projectId: string,
    filters: { taskKind?: string; status?: string; limit?: number } = {},
  ): Promise<{ runs: JobRunDto[] }> {
    const where: Prisma.JobRunWhereInput = { projectId };
    if (filters.taskKind) where.taskKind = filters.taskKind;
    if (filters.status) {
      if (!JOB_RUN_STATUSES.includes(filters.status as JobRunStatus)) {
        throw new ConflictException(`Unknown run status: ${filters.status}`);
      }
      where.status = filters.status;
    }

    const runs = await this.prisma.jobRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, filters.limit ?? 50)),
    });
    const withSteps = await this.attachSteps(runs);
    return { runs: withSteps };
  }

  /**
   * One run, scoped to `projectId` — a run id from another project must 404
   * rather than resolve (AGENT-BRIEF rule 1).
   */
  async getRun(projectId: string, runId: string): Promise<JobRunDto> {
    const run = await this.prisma.jobRun.findFirst({ where: { id: runId, projectId } });
    if (!run) throw new NotFoundException(`Job run ${runId} not found for project ${projectId}`);
    const [dto] = await this.attachSteps([run]);
    return dto;
  }

  /** The most recent run of a kind on a project, or null. */
  async findLatestRun(projectId: string, taskKind: string, includeSteps = false): Promise<JobRunDto | null> {
    const run = await this.prisma.jobRun.findFirst({
      where: { projectId, taskKind },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) return null;
    if (!includeSteps) {
      return this.toRunDto(run, computeCoverage([]), []);
    }
    const [dto] = await this.attachSteps([run]);
    return dto;
  }

  private async attachSteps(runs: JobRun[]): Promise<JobRunDto[]> {
    if (runs.length === 0) return [];
    // No Prisma relation exists between JobRun and JobStep (the schema keeps
    // them linked by column only), so the steps are fetched explicitly.
    const steps = await this.prisma.jobStep.findMany({
      where: { jobRunId: { in: runs.map((r) => r.id) } },
      orderBy: { position: 'asc' },
    });
    const byRun = new Map<string, JobStep[]>();
    for (const step of steps) {
      const list = byRun.get(step.jobRunId);
      if (list) list.push(step);
      else byRun.set(step.jobRunId, [step]);
    }
    return runs.map((run) => {
      const runSteps = byRun.get(run.id) ?? [];
      return this.toRunDto(run, computeCoverage(runSteps), runSteps);
    });
  }

  /** The wire shape of a run, including what the server will currently accept. */
  toRunDto(run: JobRun, coverage: ReturnType<typeof computeCoverage>, steps: JobStep[]): JobRunDto {
    const status = run.status as JobRunStatus;
    const heartbeatRef = run.heartbeatAt ?? run.startedAt ?? run.updatedAt;
    return {
      id: run.id,
      projectId: run.projectId,
      taskKind: run.taskKind,
      idempotencyKey: run.idempotencyKey,
      status,
      stage: run.stage,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      heartbeatAt: run.heartbeatAt ? run.heartbeatAt.toISOString() : null,
      heartbeatStale:
        status === 'running' && Date.now() - heartbeatRef.getTime() > this.staleAfterMs,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      input: parseJsonObject(run.input),
      artifacts: parseJsonObject(run.artifacts),
      error: run.error,
      costUsd: run.costUsd,
      costCredits: run.costCredits,
      reversible: run.reversible,
      triggeredBy: run.triggeredBy,
      trigger: run.trigger,
      cadenceRuleId: run.cadenceRuleId,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      coverage,
      actions: this.actionsFor(run),
      ...(steps.length > 0 ? { steps: toStepDtos(steps) } : {}),
    };
  }

  /**
   * Which actions the server will accept, mirroring the checks in
   * {@link retry} and {@link cancel} — computed here so the UI never offers a
   * control the API will reject, and never hides one it would accept.
   */
  private actionsFor(run: JobRun): RunActions {
    const terminal = TERMINAL_RUN_STATUSES.includes(run.status as JobRunStatus);
    const running = run.status === 'running';
    const attemptsLeft = run.attempt < run.maxAttempts;

    const retryBlockedReason = running
      ? 'The run is still running — cancel it first.'
      : !attemptsLeft
        ? `Retry budget exhausted (attempt ${run.attempt} of ${run.maxAttempts}).`
        : null;
    const cancelBlockedReason = terminal ? `The run already finished (${run.status}).` : null;

    return {
      canRetry: retryBlockedReason === null,
      canCancel: cancelBlockedReason === null,
      retryBlockedReason,
      cancelBlockedReason,
    };
  }

  // ── Worker-facing lifecycle ───────────────────────────────────────────

  /**
   * Mark a run as running (idempotent). Called by the queue worker when a
   * tracked job starts and by feature modules that drive a run themselves.
   */
  async markRunning(runId: string, stage?: string, attempt?: number): Promise<void> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId } });
    if (!run || run.status === 'cancelled') return;
    await this.prisma.jobRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        stage: stage ?? run.stage,
        startedAt: run.startedAt ?? new Date(),
        heartbeatAt: new Date(),
        // The queue's attempt counter is the real number of tries; the ledger
        // never reports fewer attempts than were actually made.
        attempt: attempt != null ? Math.max(run.attempt, attempt) : run.attempt,
      },
    });
  }

  /** Refresh the liveness signal. Cheap, called on a timer by the worker. */
  async heartbeat(runId: string): Promise<void> {
    // updateMany, not update: a heartbeat for a run that was deleted or
    // cancelled must not throw and must not resurrect it.
    await this.prisma.jobRun.updateMany({
      where: { id: runId, status: { not: 'cancelled' } },
      data: { heartbeatAt: new Date() },
    });
  }

  /** Move the run to a new human-readable stage, refreshing the heartbeat. */
  async setStage(runId: string, stage: string): Promise<void> {
    await this.prisma.jobRun.updateMany({
      where: { id: runId, status: { not: 'cancelled' } },
      data: { stage, heartbeatAt: new Date() },
    });
  }

  /**
   * Record (or update) one step of a run, then re-derive the run's status.
   * This is how `partial` is produced: a step that fails does not fail the
   * run, it lowers its coverage.
   */
  async recordStep(runId: string, step: RecordStepInput): Promise<JobRunDto> {
    const run = await this.prisma.jobRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Job run ${runId} not found`);

    const existing = await this.prisma.jobStep.findFirst({ where: { jobRunId: runId, name: step.name } });
    const now = new Date();
    const isTerminalStep = step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped';

    // Plain values (not Prisma's Update-input wrapper types) so the same object
    // is valid for both an update and a create.
    const values = {
      status: step.status,
      attempted: step.attempted ?? existing?.attempted ?? 0,
      succeeded: step.succeeded ?? existing?.succeeded ?? 0,
      error: step.error ?? null,
      costUsd: step.costUsd ?? existing?.costUsd ?? 0,
      startedAt:
        step.status === 'running' || isTerminalStep ? (existing?.startedAt ?? now) : (existing?.startedAt ?? null),
      finishedAt: isTerminalStep ? now : null,
    };

    if (existing) {
      await this.prisma.jobStep.update({ where: { id: existing.id }, data: values });
    } else {
      const position = step.position ?? (await this.prisma.jobStep.count({ where: { jobRunId: runId } }));
      await this.prisma.jobStep.create({ data: { ...values, jobRunId: runId, name: step.name, position } });
    }

    if (isTerminalStep) {
      // Keep the run's heartbeat fresh too: a long handler that reports steps
      // but forgets to heartbeat must not be swept as dead.
      await this.prisma.jobRun.updateMany({
        where: { id: runId, status: { not: 'cancelled' } },
        data: { heartbeatAt: now, stage: step.name },
      });
    }
    const settled = await this.settle(runId);
    return settled;
  }

  /**
   * Re-derive a run's status from its steps. A run that nobody has reported
   * on keeps its stored status: silence from the steps is not evidence that
   * the run produced nothing (design_plan §3.5 — no invented zeroes).
   *
   * `cancelled` is terminal and is never overwritten here.
   */
  async settle(runId: string): Promise<JobRunDto> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Job run ${runId} not found`);
    const steps = await this.prisma.jobStep.findMany({ where: { jobRunId: runId }, orderBy: { position: 'asc' } });

    if (run.status !== 'cancelled') {
      const derived = deriveStatusFromSteps(steps);
      if (derived && derived !== 'queued' && derived !== 'running' && derived !== run.status) {
        await this.prisma.jobRun.update({
          where: { id: runId },
          data: {
            status: derived,
            finishedAt: TERMINAL_RUN_STATUSES.includes(derived) ? (run.finishedAt ?? new Date()) : null,
          },
        });
      }
    }

    const fresh = await this.prisma.jobRun.findUnique({ where: { id: runId } });
    return this.toRunDto(fresh ?? run, computeCoverage(steps), steps);
  }

  /**
   * Add cost to a run — the money question cancellation has to answer.
   * `reversible: false` means the side effects cannot be undone, which is
   * what makes a cancel disclosure say "unrecoverable".
   */
  async addCost(runId: string, usd = 0, credits = 0, reversible?: boolean): Promise<void> {
    if (usd === 0 && credits === 0 && reversible === undefined) return;
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Job run ${runId} not found`);
    await this.prisma.jobRun.update({
      where: { id: runId },
      data: {
        costUsd: run.costUsd + usd,
        costCredits: run.costCredits + credits,
        ...(reversible !== undefined ? { reversible } : {}),
      },
    });
  }

  /**
   * Cooperative cancellation check for a running handler: call it at a step
   * boundary so a cancel takes effect instead of being ignored until the run
   * finishes. Cancelling does not kill the process, and this method does not
   * pretend otherwise.
   */
  async isCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: runId }, select: { status: true } });
    return run?.status === 'cancelled';
  }

  /** {@link isCancelled} as a throw, for handlers that should stop and report. */
  async assertActive(runId: string): Promise<void> {
    if (await this.isCancelled(runId)) {
      throw new ConflictException(`Job run ${runId} was cancelled — stopping here.`);
    }
  }

  // ── JobRunTracker (called by the BullMQ worker) ───────────────────────

  /**
   * The queue is about to enqueue a job that carries no run of its own: give
   * it one, so the heartbeat, the recovery sweep and the job list have
   * something real to point at (G07/A7 — this is the wiring that was inert).
   *
   * Two things this deliberately does **not** do:
   *
   * - **It does not adopt a run that belongs to another job.** When another
   *   run of the same kind is already in flight the per-project lock reports
   *   `locked`, and this returns `null` instead of sharing that run: two
   *   concurrent jobs reporting into one row would let the faster one settle
   *   the slower one's run, and a run that says `completed` while work is
   *   still running is exactly the lie the ledger exists to prevent. The job
   *   runs untracked and that is logged.
   * - **It does not invent an idempotency key.** Queue jobs are the unit of
   *   work here; a caller that needs duplicate-tick safety passes a key
   *   through `JobsService.createRun` itself (that is what the cadence path
   *   does). Minting a key the caller never chose would silently suppress a
   *   run the operator genuinely asked for twice.
   */
  async onEnqueue(request: EnqueueTrackingRequest): Promise<{ jobRunId: string } | null> {
    const taskKind = JOB_NAME_TASK_KIND[request.jobName];
    if (!taskKind) {
      this.logger.debug(`No task kind maps to queue job "${request.jobName}" — enqueuing it untracked.`);
      return null;
    }

    const result = await this.createRun({
      projectId: request.projectId,
      taskKind,
      trigger: 'pipeline',
      // The job's own parameters, so the run says what was actually requested.
      input: request.data,
      triggeredBy: readActor(request.data),
      ...(request.attempts != null ? { maxAttempts: request.attempts } : {}),
    });

    if (result.outcome === 'created') return { jobRunId: result.run.id };

    this.logger.log(
      `Not tracking this "${request.jobName}" job on ${request.projectId}: ` +
        (result.outcome === 'locked'
          ? `run ${result.run.id} of the same kind is already in flight, and two jobs must not settle one run. ` +
            'It runs untracked; the ledger keeps no heartbeat for it.'
          : `it duplicates run ${result.run.id} under idempotency key ${result.run.idempotencyKey ?? 'none'}.`),
    );
    return null;
  }

  /**
   * A tracked queue job started. `queueAttempt` is BullMQ's 1-based attempt
   * number, folded into the run so the ledger and the queue agree on how many
   * tries this run has had.
   */
  async onStart(jobRunId: string, jobName: string, queueAttempt: number): Promise<void> {
    await this.markRunning(jobRunId, jobName, queueAttempt);
  }

  /** Periodic liveness refresh while a tracked handler runs. */
  async onHeartbeat(jobRunId: string): Promise<void> {
    await this.heartbeat(jobRunId);
  }

  /**
   * A tracked queue job returned or threw.
   *
   * - success → the run completes, then its steps may refine that to
   *   `partial` (or `failed`) if some of them did not answer;
   * - failure with another queue attempt pending → the run goes back to
   *   `queued` with the error recorded, because that is literally what it is
   *   waiting for — and so the heartbeat sweep does not mistake it for dead
   *   work;
   * - failure with no attempt left → `failed`.
   *
   * A cancelled run is never resurrected by a late completion.
   */
  async onSettled(
    jobRunId: string,
    outcome: { ok: boolean; error?: string; willRetry: boolean },
  ): Promise<void> {
    const run = await this.prisma.jobRun.findUnique({ where: { id: jobRunId } });
    if (!run || run.status === 'cancelled') return;

    if (!outcome.ok) {
      await this.prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: outcome.willRetry ? 'queued' : 'failed',
          error: outcome.error ?? 'The worker reported a failure with no message.',
          finishedAt: outcome.willRetry ? null : new Date(),
          heartbeatAt: new Date(),
        },
      });
      return;
    }

    const steps = await this.prisma.jobStep.findMany({ where: { jobRunId } });
    await this.prisma.jobRun.update({
      where: { id: jobRunId },
      data: { status: 'completed', finishedAt: new Date(), heartbeatAt: new Date() },
    });
    // Step detail is more specific than the handler's own verdict: a run whose
    // third of five engines failed is partial, whatever the handler returned.
    if (steps.length > 0) await this.settle(jobRunId);
  }

  // ── Recovery ──────────────────────────────────────────────────────────

  /**
   * Reconcile runs whose heartbeat went stale while still claiming to run —
   * a worker that was restarted or killed mid-run.
   *
   * The reconciliation is *on the existing row*: the run is marked failed with
   * an explicit "interrupted" reason and stays retryable through
   * {@link retry}. No replacement run is created, ever, so a worker restart
   * yields exactly one recoverable run rather than a duplicate — and a second
   * sweep immediately after finds nothing to do.
   *
   * @param staleAfterMs heartbeat age at which a run is considered dead.
   */
  async recoverStaleRuns(
    staleAfterMs: number = this.staleAfterMs,
    abandonedQueuedAfterMs: number = this.abandonedQueuedAfterMs,
  ): Promise<RecoveryReport> {
    // Two distinct failure shapes, reconciled together because both leave a run
    // that no worker will ever settle.
    //
    // 1. A run that claims to be `running` whose worker has gone quiet.
    // 2. A run that has sat in `queued` and never started at all.
    //
    // The second was previously invisible, and it is not harmless: the
    // per-project run lock counts `queued` as in flight, so one abandoned run
    // stops every later run of that task kind from being tracked for a full
    // lock window — and the abandoned row itself sits at `queued` forever,
    // which the run centre faithfully renders as "queued" long after the job
    // is gone. Reconciling it both tells the truth and releases the lock.
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stale = await this.prisma.jobRun.findMany({
      where: {
        status: 'running',
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, startedAt: { lt: cutoff } },
          { heartbeatAt: null, startedAt: null, updatedAt: { lt: cutoff } },
        ],
      },
      take: 200,
    });

    const runs: RecoveryReport['runs'] = [];

    const abandoned = await this.prisma.jobRun.findMany({
      where: {
        status: 'queued',
        // Never started, so there is no worker to be late — only a job that
        // never arrived. A run that HAS been picked up is handled by the
        // `running` sweep above once its heartbeat goes stale.
        startedAt: null,
        heartbeatAt: null,
        updatedAt: { lt: new Date(Date.now() - abandonedQueuedAfterMs) },
      },
      take: 200,
    });

    for (const run of abandoned) {
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error:
            `Never started: this run has been queued since ${run.createdAt.toISOString()} ` +
            `(${Math.round((Date.now() - run.createdAt.getTime()) / 1000)}s) and no worker ever picked it up. ` +
            'The job may have been lost with its queue, or the worker may have been down. Retry it explicitly ' +
            'if the work should be attempted — nothing was restarted automatically.',
        },
      });
      await this.settle(run.id);
      runs.push({
        id: run.id,
        taskKind: run.taskKind,
        projectId: run.projectId,
        recoveredAs: 'failed-never-started',
      });
    }


    for (const run of stale) {
      const reference = run.heartbeatAt ?? run.startedAt ?? run.updatedAt;
      const error =
        `Interrupted: no worker heartbeat since ${reference.toISOString()} ` +
        `(${Math.round((Date.now() - reference.getTime()) / 1000)}s). The worker that was running this job ` +
        `stopped, so the run is not in progress. Nothing was restarted automatically — retry it explicitly ` +
        `if the work should be re-attempted.`;

      // Any step the dead worker left mid-flight is marked failed here: it did
      // not finish, and leaving it 'running' would make the run look alive.
      await this.prisma.jobStep.updateMany({
        where: { jobRunId: run.id, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted: worker heartbeat went stale.' },
      });
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'failed', error, finishedAt: new Date() },
      });
      await this.settle(run.id);

      runs.push({
        id: run.id,
        projectId: run.projectId,
        taskKind: run.taskKind,
        lastHeartbeatAt: run.heartbeatAt ? run.heartbeatAt.toISOString() : null,
        error,
      });
    }

    return { recovered: runs.length, staleAfterMs, runs };
  }

  // ── Retry / cancel ────────────────────────────────────────────────────

  /**
   * Retry a finished run, bounded by `maxAttempts`.
   *
   * Steps that already succeeded are **kept**: a retry re-attempts what did
   * not produce a result, it does not buy the whole run again. Failed,
   * interrupted and skipped steps go back to pending.
   *
   * @throws ConflictException while running, or once the retry budget is used.
   */
  async retry(projectId: string, runId: string, actorUserId?: string): Promise<RetryResult> {
    const run = await this.prisma.jobRun.findFirst({ where: { id: runId, projectId } });
    if (!run) throw new NotFoundException(`Job run ${runId} not found for project ${projectId}`);
    if (run.status === 'running') {
      throw new ConflictException('The run is still running — cancel it before retrying.');
    }
    if (run.attempt >= run.maxAttempts) {
      throw new ConflictException(
        `Retry budget exhausted: attempt ${run.attempt} of ${run.maxAttempts}. Raise maxAttempts deliberately if this work should run again.`,
      );
    }

    const steps = await this.prisma.jobStep.findMany({ where: { jobRunId: runId }, orderBy: { position: 'asc' } });
    const resetSteps: string[] = [];
    const preservedSteps: string[] = [];
    for (const step of steps) {
      if (step.status === 'succeeded') {
        preservedSteps.push(step.name);
        continue;
      }
      resetSteps.push(step.name);
      await this.prisma.jobStep.update({
        where: { id: step.id },
        data: { status: 'pending', startedAt: null, finishedAt: null, error: null },
      });
    }

    const updated = await this.prisma.jobRun.update({
      where: { id: runId },
      data: {
        status: 'queued',
        attempt: run.attempt + 1,
        error: null,
        finishedAt: null,
        stage: null,
        heartbeatAt: null,
        trigger: 'retry',
        triggeredBy: actorUserId ?? run.triggeredBy,
      },
    });

    const afterSteps = await this.prisma.jobStep.findMany({
      where: { jobRunId: runId },
      orderBy: { position: 'asc' },
    });
    const requeue = await this.enqueueRun(updated, preservedSteps.length > 0 ? { resume: true } : {});
    return {
      run: this.toRunDto(updated, computeCoverage(afterSteps), afterSteps),
      attempt: updated.attempt,
      maxAttempts: updated.maxAttempts,
      resetSteps,
      preservedSteps,
      requeued: requeue.requeued,
      requeueBlockedReason: requeue.reason,
    };
  }

  /**
   * Cancel a run. The response states plainly what is already spent and
   * whether the work can still be undone; it never implies money came back.
   *
   * Cancelling is cooperative for a run that is mid-flight: the ledger flips
   * immediately (so the job list is truthful) and a cooperating handler stops
   * at its next {@link assertActive} boundary. A handler that never checks
   * keeps running, and the disclosure says nothing to the contrary.
   *
   * @throws ConflictException when the run already finished.
   */
  async cancel(projectId: string, runId: string, reason?: string): Promise<CancelResult> {
    const run = await this.prisma.jobRun.findFirst({ where: { id: runId, projectId } });
    if (!run) throw new NotFoundException(`Job run ${runId} not found for project ${projectId}`);
    if (TERMINAL_RUN_STATUSES.includes(run.status as JobRunStatus)) {
      throw new ConflictException(`The run already finished (${run.status}) and cannot be cancelled.`);
    }

    const runningSteps = await this.prisma.jobStep.findMany({ where: { jobRunId: runId, status: 'running' } });
    await this.prisma.jobStep.updateMany({
      where: { jobRunId: runId, status: 'running' },
      data: { status: 'failed', finishedAt: new Date(), error: 'Cancelled before this step finished.' },
    });

    const updated = await this.prisma.jobRun.update({
      where: { id: runId },
      // 'cancelled' is set directly (never derived): confirm the reason is
      // recorded where a reader will look for it.
      data: {
        status: 'cancelled',
        finishedAt: new Date(),
        error: reason ? `Cancelled: ${reason}` : 'Cancelled by an operator.',
      },
    });

    const steps = await this.prisma.jobStep.findMany({ where: { jobRunId: runId }, orderBy: { position: 'asc' } });
    const spentUsd = updated.costUsd;
    const spentCredits = updated.costCredits;
    const hasUnrecoverableWork = !updated.reversible || spentUsd > 0 || spentCredits > 0;

    return {
      run: this.toRunDto(updated, computeCoverage(steps), steps),
      cancelled: true,
      spentUsd,
      spentCredits,
      reversible: updated.reversible,
      hasUnrecoverableWork,
      statement: this.cancelStatement(spentUsd, spentCredits, updated.reversible),
      refunded: false,
      interruptedSteps: runningSteps.map((s) => s.name),
    };
  }

  /**
   * The cancel sentence. Deliberately blunt about what is *not* recovered:
   * the schema records what a run spent, and nothing in this system refunds.
   */
  private cancelStatement(spentUsd: number, spentCredits: number, reversible: boolean): string {
    const spend =
      spentUsd > 0 || spentCredits > 0
        ? `USD ${spentUsd.toFixed(2)} and ${spentCredits} credits were already spent on this run`
        : 'No spend is recorded for this run';
    const recovery = !reversible
      ? 'its side effects are marked irreversible, so work it already produced is not undone'
      : spentUsd > 0 || spentCredits > 0
        ? 'its side effects are marked reversible, so what it produced can still be undone'
        : 'no irreversible work is outstanding, so nothing is lost by cancelling';
    return (
      `${spend}, and ${recovery}. Cancelling stops further work only — ` +
      `already-spent cost is not refunded, in money or credits.`
    );
  }

  /**
   * Hand a run back to the pipeline queue, when this task kind has a queue
   * entry point and a handler is registered in this process.
   *
   * Never a silent no-op: when it cannot enqueue, the reason comes back with
   * the result so the caller can say "recorded, not restarted" honestly.
   */
  async enqueueRun(
    run: JobRun,
    extraInput: Record<string, unknown> = {},
  ): Promise<{ requeued: boolean; jobId: string | null; reason: string | null }> {
    const jobName = PIPELINE_JOB_NAME[run.taskKind as TaskKind];
    if (!jobName) {
      return {
        requeued: false,
        jobId: null,
        reason: `Task kind "${run.taskKind}" has no queue entry point — the run was reset in the ledger and will not start itself.`,
      };
    }
    if (!this.queue.hasHandler(jobName)) {
      return {
        requeued: false,
        jobId: null,
        reason: `No handler is registered for "${jobName}" in this process — the run was reset in the ledger and will not start itself.`,
      };
    }

    const input = { ...parseJsonObject(run.input), ...extraInput };
    const { jobId } = await this.queue.enqueue(
      jobName,
      // projectId is included even for handlers that ignore it: a job's data
      // is the only thing a status read has to check the URL's :projectId
      // against (G03), and jobRunId is what makes the heartbeat work.
      { ...input, projectId: run.projectId, jobRunId: run.id, triggeredBy: run.trigger, triggeredByUserId: run.triggeredBy },
      { attempts: Math.max(1, run.maxAttempts - run.attempt + 1), backoff: { type: 'exponential', delay: 30_000 } },
    );
    return { requeued: true, jobId, reason: null };
  }

  /**
   * Create a run and immediately hand it to the queue, in that order: the
   * ledger row exists before any worker can touch the work, so a crash between
   * the two leaves a `queued` run that is visible rather than invisible.
   */
  async createAndEnqueue(input: CreateRunInput): Promise<CreateRunResult & { requeued: boolean; requeueBlockedReason: string | null }> {
    const result = await this.createRun(input);
    if (result.outcome !== 'created') {
      return { ...result, requeued: false, requeueBlockedReason: null };
    }
    const requeue = await this.enqueueRun(result.run);
    return { ...result, requeued: requeue.requeued, requeueBlockedReason: requeue.reason };
  }
}
