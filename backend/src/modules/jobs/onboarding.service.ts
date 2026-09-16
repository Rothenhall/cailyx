/**
 * OnboardingService — G07: the Day-1 pipeline as a durable, resumable run.
 *
 * The onboarding pipeline is fifteen stages long and spends real money in the
 * middle of them (an AEO audit, a backlink pull, an LLM strategy build). Before
 * this file its only record of progress was `Project.onboardingStep`, which
 * says where it is but not what it spent, what it produced, which stages
 * already succeeded, or why one of them failed. A restart lost that.
 *
 * So an onboarding run is a `JobRun` with `taskKind: 'onboarding'` and one
 * `JobStep` per stage, and resuming means "continue from the first stage that
 * did not succeed" — the same shape `AeoAuditService.resume` already uses for
 * its own stages ("skips any stage/surface already completed"), generalised.
 *
 * **The stage executors are an extension point, not a reimplementation.** The
 * pipeline body lives in the `clients` module, which owns those integrations;
 * this module must not import it. A module registers its runner with
 * {@link registerStageExecutor} — exactly the `registerHandler` idiom
 * `PipelineQueueService` already uses — and {@link resume} drives it. Until a
 * stage has an executor, resume says so plainly rather than pretending the
 * stage ran.
 *
 * @module onboarding.service
 */

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { JobStep } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { JobsService } from './jobs.service';
import { onboardingStepSkeleton, ONBOARDING_STAGES, type JobRunDto } from './jobs.types';
import type { CreateOnboardingRunDto, ResumeOnboardingRunDto } from './dto/onboarding.dto';

/** What a stage executor is handed. */
export interface OnboardingStageContext {
  projectId: string;
  runId: string;
  stage: string;
  /** Parameters recorded on the run when it was created. */
  input: Record<string, unknown>;
}

/** What a stage executor reports back. Artifacts are merged into the run. */
export interface OnboardingStageResult {
  /** Items the stage asked for (pages crawled, engines queried…). Defaults to 1. */
  attempted?: number;
  /** Items that actually answered. Defaults to `attempted`. */
  succeeded?: number;
  /** Artifact ids/keys to merge into the run's `artifacts` column. */
  artifacts?: Record<string, unknown>;
  /** Cost the stage incurred, added to the run. */
  costUsd?: number;
  costCredits?: number;
  /** Set false when this stage's side effects cannot be undone. */
  reversible?: boolean;
}

/** A runner for one named stage, registered by the module that owns it. */
export type OnboardingStageExecutor = (context: OnboardingStageContext) => Promise<OnboardingStageResult>;

/** What the client needs to render the onboarding surface honestly. */
export interface OnboardingRunView {
  /** Null when this project has no durable onboarding run yet. */
  run: JobRunDto | null;
  /** The first stage that has not succeeded — null when there is none. */
  nextStage: string | null;
  nextStageLabel: string | null;
  nextStagePosition: number | null;
  totalStages: number;
  /** Whether this process can run the next stage right now. */
  executorAvailable: boolean;
  /** Plain statement of what resuming would do, or why it cannot. */
  resumeDisclosure: string;
  /**
   * The pre-G07 orchestrator's own fields, read-only, so the two records can be
   * compared during the transition instead of silently disagreeing.
   */
  legacy: { onboardingStatus: string; onboardingStep: string | null; onboardingError: string | null };
}

export interface ResumeResult {
  resumed: boolean;
  /** Why not, when not. Never null on a no-op. */
  reason: string | null;
  advancedStage: string | null;
  run: JobRunDto;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  /** stage name → executor, populated by the module that owns the pipeline. */
  private readonly executors = new Map<string, OnboardingStageExecutor>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Register the runner for one onboarding stage. Called by the module that
   * owns those integrations (the Day-1 pipeline in `clients`), so this module
   * never has to depend on it.
   */
  registerStageExecutor(stage: string, executor: OnboardingStageExecutor): void {
    this.executors.set(stage, executor);
    this.logger.log(`Registered onboarding stage executor: ${stage}`);
  }

  /** True when this process can run `stage`. */
  hasExecutor(stage: string): boolean {
    return this.executors.has(stage);
  }

  // ── Create ────────────────────────────────────────────────────────────

  /**
   * Create the project's onboarding run, or return the existing one.
   *
   * The default idempotency key is `onboarding:<projectId>`, because a project
   * has exactly one Day-1 pipeline: a double-submitted form, a retried HTTP
   * request or a second operator must not start a second one (design_plan
   * §10.3 — "Never blindly retry … project creation"). Re-running onboarding
   * after it finished is a deliberate act, so it takes a deliberate key.
   */
  async create(
    projectId: string,
    dto: CreateOnboardingRunDto,
    actorUserId: string,
  ): Promise<{ run: JobRunDto; created: boolean; view: OnboardingRunView }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, domain: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const result = await this.jobs.createRun({
      projectId,
      taskKind: 'onboarding',
      idempotencyKey: dto.idempotencyKey ?? `onboarding:${projectId}`,
      trigger: 'pipeline',
      triggeredBy: actorUserId,
      input: { domain: project.domain, ...(dto.input ?? {}) },
      steps: onboardingStepSkeleton(),
      maxAttempts: 3,
      stage: 'queued',
    });

    const run = await this.jobs.getRun(projectId, result.run.id);
    return { run, created: result.outcome === 'created', view: await this.view(projectId, run) };
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /**
   * The project's current onboarding run (newest first), with what resume
   * would do next. Returns `run: null` — not a 404 — when the durable ledger
   * has no onboarding run for this project, because "not started here yet" is
   * a state the screen has to render, not an error.
   */
  async read(projectId: string): Promise<OnboardingRunView> {
    const run = await this.jobs.findLatestRun(projectId, 'onboarding', true);
    return this.view(projectId, run);
  }

  /** One onboarding run, scoped to its project. */
  async getRun(projectId: string, runId: string): Promise<OnboardingRunView> {
    const row = await this.prisma.jobRun.findFirst({
      where: { id: runId, projectId, taskKind: 'onboarding' },
    });
    if (!row) throw new NotFoundException(`Onboarding run ${runId} not found for project ${projectId}`);
    return this.view(projectId, await this.jobs.getRun(projectId, runId));
  }

  // ── Resume ────────────────────────────────────────────────────────────

  /**
   * Advance the run by one stage: the first stage that has not succeeded.
   *
   * Resume does **not** consume the run's retry budget when it is advancing to
   * a stage that was never attempted — the budget bounds *retries*, and the
   * number of stages in a pipeline is not a retry count. Re-attempting a stage
   * that already failed does consume it, so a stage that keeps failing stops
   * rather than looping all night.
   *
   * **What "already running" means.** A stage is in flight when its *step* is
   * `running` — that is the row the executor itself claims before it starts and
   * settles when it returns, so it is the only direct evidence that work is
   * happening. The run's own status is not a substitute: a stage that settled
   * with stages still pending derives to `running` too (coverage rule: "pending
   * behind a settled step"), so guarding on the run's status plus heartbeat
   * freshness would have refused the *next* stage for
   * `JOB_HEARTBEAT_STALE_MS` after every one that completed — a fourteen-stage
   * Day-1 pipeline would have taken a heartbeat window per stage.
   *
   * The stage is claimed with a compare-and-set on the step row, so two
   * simultaneous resumes cannot both buy the same stage: whichever loses the
   * update gets a 409 rather than a second paid run.
   *
   * @throws NotFoundException no such onboarding run.
   * @throws ConflictException the run is finished, a stage is already in
   *         flight, or the retry budget for a failed stage is used up.
   */
  async resume(
    projectId: string,
    runId: string,
    actorUserId: string,
    dto: ResumeOnboardingRunDto = {},
  ): Promise<ResumeResult> {
    const row = await this.prisma.jobRun.findFirst({
      where: { id: runId, projectId, taskKind: 'onboarding' },
    });
    if (!row) throw new NotFoundException(`Onboarding run ${runId} not found for project ${projectId}`);

    const current = await this.jobs.getRun(projectId, runId);
    if (row.status === 'completed') {
      throw new ConflictException(
        `The onboarding run already completed (${current.finishedAt ?? 'no finish time recorded'}). Create a new run with an explicit idempotencyKey to re-run onboarding.`,
      );
    }
    if (row.status === 'cancelled') {
      throw new ConflictException(
        'The onboarding run was cancelled. Retry it from the job ledger (POST /jobs/:jobId/retry) to continue it.',
      );
    }

    const steps = await this.prisma.jobStep.findMany({
      where: { jobRunId: runId },
      orderBy: { position: 'asc' },
    });

    const inFlight = steps.find((s) => s.status === 'running');
    if (inFlight) {
      throw new ConflictException(
        `Stage "${inFlight.name}" is in flight (started ${inFlight.startedAt ? inFlight.startedAt.toISOString() : 'at an unrecorded time'}). ` +
          'Wait for it to settle — a stage that is genuinely stuck is reconciled by the recovery sweep, after which this stage can be resumed.',
      );
    }

    const next = this.firstIncompleteStage(steps, dto.force?.restartSucceededStages === true);
    if (!next) {
      const settled = await this.jobs.settle(runId);
      return {
        resumed: false,
        reason: 'Every onboarding stage has succeeded — there is nothing left to resume.',
        advancedStage: null,
        run: settled,
      };
    }

    const retryingFailedStage = next.status === 'failed';
    if (retryingFailedStage && row.attempt >= row.maxAttempts) {
      throw new ConflictException(
        `Retry budget exhausted for this onboarding run (attempt ${row.attempt} of ${row.maxAttempts}). ` +
          `Stage "${next.name}" keeps failing; raise maxAttempts deliberately if it should be re-attempted.`,
      );
    }

    const executor = this.executors.get(next.name);
    if (!executor) {
      // Nothing is started, and nothing is recorded as if it had been: an
      // unresumable stage must not leave a run stuck in `running` to be swept.
      return {
        resumed: false,
        reason:
          `No executor for stage "${next.name}" is registered in this process, so resuming cannot advance it. ` +
          `The stage's own module registers one with OnboardingService.registerStageExecutor().`,
        advancedStage: null,
        run: current,
      };
    }

    // Claim the stage. Only one caller can move this row out of a settled
    // status, so a second concurrent resume is refused instead of re-running
    // (and re-paying for) a stage that is already underway.
    const claim = await this.prisma.jobStep.updateMany({
      where: { id: next.id, status: { in: ['pending', 'failed', 'skipped'] } },
      data: { status: 'running', startedAt: new Date(), finishedAt: null },
    });
    if (claim.count === 0) {
      throw new ConflictException(
        `Another resume is already advancing stage "${next.name}" — this call did not start anything.`,
      );
    }

    await this.jobs.markRunning(runId, next.name, retryingFailedStage ? row.attempt + 1 : row.attempt);
    await this.jobs.recordStep(runId, { name: next.name, status: 'running' });

    const context: OnboardingStageContext = {
      projectId,
      runId,
      stage: next.name,
      input: (current.input ?? {}) as Record<string, unknown>,
    };
    this.logger.log(`Onboarding ${runId}: stage "${next.name}" started by ${actorUserId}`);

    try {
      const result = await executor(context);
      const attempted = result.attempted ?? 1;
      await this.jobs.recordStep(runId, {
        name: next.name,
        status: 'succeeded',
        attempted,
        succeeded: result.succeeded ?? attempted,
        costUsd: result.costUsd,
      });
      if (result.costUsd || result.costCredits) {
        await this.jobs.addCost(runId, result.costUsd ?? 0, result.costCredits ?? 0, result.reversible);
      }
      if (result.artifacts) {
        const merged = { ...(current.artifacts ?? {}), ...result.artifacts };
        await this.prisma.jobRun.update({
          where: { id: runId },
          data: { artifacts: JSON.stringify(merged) },
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      await this.jobs.recordStep(runId, {
        name: next.name,
        status: 'failed',
        attempted: 1,
        succeeded: 0,
        error: message,
      });
      this.logger.error(`Onboarding ${runId}: stage "${next.name}" failed — ${message}`);
    }

    const settled = await this.jobs.settle(runId);
    return {
      resumed: true,
      reason: null,
      advancedStage: next.name,
      run: settled,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Whether a stage has to run, and its step row. */
  private firstIncompleteStage(
    steps: JobStep[],
    includeSucceeded: boolean,
  ): JobStep | null {
    if (steps.length === 0) return null;
    for (const step of steps) {
      if (step.status === 'succeeded' && !includeSucceeded) continue;
      return step;
    }
    return null;
  }

  /** The view model: what is left, and what resume would actually do. */
  private async view(projectId: string, run: JobRunDto | null): Promise<OnboardingRunView> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { onboardingStatus: true, onboardingStep: true, onboardingError: true },
    });
    const legacy = {
      onboardingStatus: project?.onboardingStatus ?? 'pending',
      onboardingStep: project?.onboardingStep ?? null,
      onboardingError: project?.onboardingError ?? null,
    };

    if (!run) {
      return {
        run: null,
        nextStage: null,
        nextStageLabel: null,
        nextStagePosition: null,
        totalStages: ONBOARDING_STAGES.length,
        executorAvailable: false,
        resumeDisclosure:
          'No durable onboarding run exists for this project. Create one (POST /onboarding) to take over the Day-1 pipeline.',
        legacy,
      };
    }

    const steps = run.steps ?? [];
    const next = steps.find((s) => s.status !== 'succeeded') ?? null;
    const stage = next ? ONBOARDING_STAGES.find((s) => s.name === next.name) : undefined;
    const executorAvailable = next ? this.executors.has(next.name) : false;

    let resumeDisclosure: string;
    if (!next) {
      resumeDisclosure = 'Every onboarding stage succeeded.';
    } else if (run.status === 'cancelled') {
      resumeDisclosure = `This run was cancelled. Retry it from the job ledger to continue from "${next.name}".`;
    } else if (!executorAvailable) {
      resumeDisclosure =
        `Next stage: "${next.name}". No executor for it is registered in this process, so resume cannot advance it yet.`;
    } else {
      resumeDisclosure = `Resuming runs stage "${next.name}" (${next.position + 1} of ${steps.length}).`;
    }

    return {
      run,
      nextStage: next ? next.name : null,
      nextStageLabel: stage?.label ?? next?.name ?? null,
      nextStagePosition: next ? next.position : null,
      totalStages: steps.length || ONBOARDING_STAGES.length,
      executorAvailable,
      resumeDisclosure,
      legacy,
    };
  }
}
