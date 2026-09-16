/**
 * Shared types and status vocabularies for G07 — the durable job ledger,
 * whole-program cadence and onboarding runs.
 *
 * SQLite has no enums: `JobRun.status`, `JobStep.status` and
 * `CadenceRule.frequency` are `String` columns whose permitted values are
 * documented on the Prisma models. This file is the single source of truth
 * for those vocabularies so a controller, a service and the queue worker
 * never disagree about what a status means.
 *
 * @module jobs.types
 */

/**
 * Every task kind the durable ledger accepts. This is deliberately wider than
 * "the kinds a handler exists for today": a kind with no registered handler
 * still gets an honest ledger row (queued, never advanced) rather than being
 * rejected — the alternative is a module inventing its own status table.
 *
 * G07 contract: "Include AEO, SERP, mentions, backlinks, gap/score/report
 * dependencies in supported task kinds."
 */
export type TaskKind =
  | 'technical-audit'
  | 'seo-audit'
  | 'aeo-audit'
  | 'presence'
  | 'serp'
  | 'mentions'
  | 'backlinks'
  | 'gap'
  | 'score'
  | 'report'
  | 'content-generation'
  | 'onboarding'
  // G16 — the public diagnostic request queues a receipt run under this kind.
  // Absent from this list, it was rejected by the jobs route's own DTO
  // validation, so a caller could not filter to the runs that intake produced.
  | 'diagnostic-request';

export const TASK_KINDS: readonly TaskKind[] = [
  'technical-audit',
  'seo-audit',
  'aeo-audit',
  'presence',
  'serp',
  'mentions',
  'backlinks',
  'gap',
  'score',
  'report',
  'content-generation',
  'onboarding',
  'diagnostic-request',
];

/**
 * The BullMQ job name each task kind maps onto, where one exists.
 *
 * Only the four audit pipelines currently run on `PipelineQueueService`.
 * Kinds absent from this map (serp, mentions, backlinks, gap, score, report,
 * content-generation, onboarding) have no queue entry point yet — retrying
 * one resets its ledger row without pretending it was re-enqueued, and the
 * response says so. See `JobsService.retry`.
 */
export const PIPELINE_JOB_NAME: Partial<Record<TaskKind, string>> = {
  'technical-audit': 'technical-audit',
  'seo-audit': 'seo-audit',
  presence: 'presence-discovery',
  'aeo-audit': 'aeo-audit-resume',
};

/**
 * The inverse of {@link PIPELINE_JOB_NAME}: the task kind a queue job name
 * belongs to. Derived from that map rather than written a second time, so the
 * two cannot drift — this is what the queue reads when it attaches a durable
 * run to a job it is about to enqueue (G07/A7).
 */
export const JOB_NAME_TASK_KIND: Readonly<Record<string, TaskKind>> = (() => {
  const map: Record<string, TaskKind> = {};
  for (const taskKind of Object.keys(PIPELINE_JOB_NAME) as TaskKind[]) {
    const jobName = PIPELINE_JOB_NAME[taskKind];
    if (jobName) map[jobName] = taskKind;
  }
  return map;
})();

/** JobRun.status. `partial` is a real terminal state, not a synonym for failed. */
export type JobRunStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';
export const JOB_RUN_STATUSES: readonly JobRunStatus[] = [
  'queued',
  'running',
  'partial',
  'completed',
  'failed',
  'cancelled',
];

/** Terminal run states: nothing further will happen without an explicit action. */
export const TERMINAL_RUN_STATUSES: readonly JobRunStatus[] = [
  'partial',
  'completed',
  'failed',
  'cancelled',
];

/** JobStep.status. */
export type JobStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export const JOB_STEP_STATUSES: readonly JobStepStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
];

/** How a run came to exist — `JobRun.trigger`. */
export type JobTrigger = 'manual' | 'cadence' | 'pipeline' | 'retry';
export const JOB_TRIGGERS: readonly JobTrigger[] = ['manual', 'cadence', 'pipeline', 'retry'];

/** CadenceRule.frequency. */
export type CadenceFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'off';export const CADENCE_FREQUENCIES: readonly CadenceFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'off',
];

/** Frequencies that need a `dayOfWeek` anchor (0 = Sunday, per the schema). */
export const WEEKLY_FREQUENCIES: readonly CadenceFrequency[] = ['weekly', 'biweekly'];

/** Frequencies that need a `dayOfMonth` anchor. */
export const MONTHLY_FREQUENCIES: readonly CadenceFrequency[] = ['monthly', 'quarterly'];

/**
 * The Day-1 pipeline stages, in order — the step skeleton every onboarding
 * run is created with.
 *
 * Names match the `onboardingStep` values the existing `clients` orchestrator
 * writes (`project.onboardingStep`), so the durable ledger and the legacy
 * column can be read side by side during the transition instead of silently
 * disagreeing. Stage *labels* are the operator-facing text.
 */
export interface OnboardingStage {
  name: string;
  label: string;
}

export const ONBOARDING_STAGES: readonly OnboardingStage[] = [
  { name: 'enrichment', label: 'Company enrichment' },
  { name: 'entity-audit', label: 'Entity clarity audit' },
  { name: 'technical-audit', label: 'Technical audit' },
  { name: 'digital-presence', label: 'Digital presence discovery' },
  { name: 'tech-stack', label: 'Tech stack detection' },
  { name: 'competitors', label: 'Competitor discovery' },
  { name: 'gap-analysis', label: 'Content gap analysis' },
  { name: 'strategy', label: 'Strategy build' },
  { name: 'findings', label: 'Findings write-up' },
  { name: 'keyword-research', label: 'Keyword research' },
  { name: 'growth-execution', label: 'Growth execution plan' },
  { name: 'aeo-audit', label: 'Answer-engine audit' },
  { name: 'backlinks', label: 'Backlink profile' },
  { name: 'report', label: 'First report' },
];

/** The step rows an onboarding run is created with. */
export function onboardingStepSkeleton(): Array<{ name: string; position: number }> {
  return ONBOARDING_STAGES.map((s, i) => ({ name: s.name, position: i }));
}

/**
 * Coverage disclosure for a run: how much of the requested work actually
 * produced a result. `attempted`/`succeeded` come from the step rows, never
 * from a percentage invented for display.
 */
export interface JobCoverage {
  /** Steps that reached a terminal state (succeeded + failed + skipped). */
  settled: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
  running: number;
  /** Sum of JobStep.attempted across steps — items requested. */
  attemptedItems: number;
  /** Sum of JobStep.succeeded across steps — items that answered. */
  succeededItems: number;
  /**
   * Plain-language coverage sentence, present only when it is not simply
   * "everything worked". Null when every step succeeded.
   */
  disclosure: string | null;
}

/** A JobStep as returned by the API. */
export interface JobStepDto {
  id: string;
  name: string;
  position: number;
  status: JobStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  attempted: number;
  succeeded: number;
  error: string | null;
  costUsd: number;
}

/** A JobRun as returned by the API, with its steps and coverage. */
export interface JobRunDto {
  id: string;
  projectId: string;
  taskKind: string;
  idempotencyKey: string | null;
  status: JobRunStatus;
  stage: string | null;
  attempt: number;
  maxAttempts: number;
  heartbeatAt: string | null;
  /** True when the run claims to be running but its heartbeat is past the stale threshold. */
  heartbeatStale: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  input: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  error: string | null;
  costUsd: number;
  costCredits: number;
  reversible: boolean;
  triggeredBy: string | null;
  trigger: string;
  cadenceRuleId: string | null;
  createdAt: string;
  updatedAt: string;
  coverage: JobCoverage;
  /** Server-computed action availability, so the UI never guesses. */
  actions: RunActions;
  steps?: JobStepDto[];
}

/** Which actions the server will currently accept for a run. */
export interface RunActions {
  canRetry: boolean;
  canCancel: boolean;
  /** Why an action is unavailable — null when it is available. */
  retryBlockedReason: string | null;
  cancelBlockedReason: string | null;
}

/** CadenceRule as returned by the API. */
export interface CadenceRuleDto {
  /** False when no CadenceRule row exists yet — the returned values are the defaults, not stored ones. */
  configured: boolean;
  id: string | null;
  projectId: string;
  taskKind: string;
  frequency: CadenceFrequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  timezone: string;
  enabled: boolean;
  params: Record<string, unknown>;
  prerequisites: string[];
  maxCostUsd: number | null;
  lastRunAt: string | null;
  lastJobRunId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  pausedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
