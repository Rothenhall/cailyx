import { api, unwrap } from '@/lib/api';

/**
 * Durable-run adapter (G07) — design_plan.md screen PJ11 "Run center".
 *
 * The backend does the interpretation this screen depends on: a run carries a
 * server-computed `coverage` breakdown and a server-computed `actions` block
 * saying which operations are currently permitted and why not. That matters,
 * because §10.4 requires a scan or generation to show prerequisites and
 * disable start accordingly — and the only place that can honestly answer
 * "may I cancel this?" is the server that knows what the run has already spent.
 */

export type JobRunStatus =
  | 'queued'
  | 'running'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobCoverage {
  /** Steps that reached a terminal state (succeeded + failed + skipped). */
  settled: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
  running: number;
  /** Items requested across all steps. */
  attemptedItems: number;
  /** Items that actually answered. */
  succeededItems: number;
  /**
   * Plain-language coverage sentence the server supplies **only when it is not
   * simply "everything worked"** — null when every step succeeded. Show it
   * verbatim: it is the backend's own account of what did not complete, and
   * re-deriving it in the browser would let the two disagree.
   */
  disclosure?: string | null;
}

/** Server-computed action availability, so the UI never guesses. */
export interface RunActions {
  canRetry: boolean;
  canCancel: boolean;
  retryBlockedReason: string | null;
  cancelBlockedReason: string | null;
}

export interface JobStep {
  id: string;
  name: string;
  position: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string | null;
  finishedAt: string | null;
  attempted: number;
  succeeded: number;
  error: string | null;
  costUsd: number;
}

export interface JobRun {
  id: string;
  projectId: string;
  taskKind: string;
  idempotencyKey: string | null;
  status: JobRunStatus;
  /** Human-readable current stage. No invented percentage or ETA. */
  stage: string | null;
  attempt: number;
  maxAttempts: number;
  heartbeatAt: string | null;
  /** True when the run claims to be running but its heartbeat is past threshold. */
  heartbeatStale: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  input: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  error: string | null;
  costUsd: number;
  /** Credits are a separate unit and are never summed with `costUsd`. */
  costCredits: number;
  /** False when cancelling cannot undo the work already done. */
  reversible: boolean;
  triggeredBy: string | null;
  trigger: string;
  cadenceRuleId: string | null;
  createdAt: string;
  updatedAt: string;
  coverage: JobCoverage;
  actions: RunActions;
  steps?: JobStep[];
}

export async function listRuns(
  projectId: string,
  filter?: { taskKind?: string; status?: string; limit?: number },
  options?: { signal?: AbortSignal },
) {
  const payload = await api.get<{ runs: JobRun[] }>(`/projects/${projectId}/jobs`, {
    ...options,
    query: filter,
  });
  return unwrap<JobRun[]>(payload, 'runs');
}

export async function getRun(projectId: string, jobId: string, options?: { signal?: AbortSignal }) {
  return api.get<JobRun>(`/projects/${projectId}/jobs/${jobId}`, options);
}

/**
 * Retries a run.
 *
 * The caller must read `actions.canRetry` first: a retry on a run that already
 * spent money, or whose items all succeeded, is rejected server-side, and
 * §10.4 forbids blindly retrying a paid operation.
 */
export async function retryRun(projectId: string, jobId: string) {
  return api.post<JobRun>(`/projects/${projectId}/jobs/${jobId}/retry`);
}

/**
 * Cancels a run.
 *
 * The response states whether already-spent or irreversible work remains. That
 * is surfaced verbatim — the UI must never imply a cancellation refunded
 * anything.
 */
export async function cancelRun(projectId: string, jobId: string) {
  return api.post<JobRun>(`/projects/${projectId}/jobs/${jobId}/cancel`);
}


// ── Onboarding run (OP07) ───────────────────────────────────────────────

/**
 * The project's onboarding run as a durable, resumable record.
 *
 * `run` is `null` — not a 404 — when the project has no durable onboarding run
 * yet, because "not started here yet" is a state the screen renders. The
 * `legacy` block carries the pre-G07 `onboardingStatus`/`onboardingStep`/
 * `onboardingError` fields read-only, so the two records can be compared
 * during the transition instead of silently disagreeing.
 */
export interface OnboardingRunView {
  run: JobRun | null;
  /** The first stage that has not succeeded — null when there is none. */
  nextStage: string | null;
  nextStageLabel: string | null;
  nextStagePosition: number | null;
  totalStages: number;
  /** Whether this process can run the next stage right now. */
  executorAvailable: boolean;
  /** Plain statement of what resuming would do, or why it cannot. */
  resumeDisclosure: string;
  legacy: {
    onboardingStatus: string;
    onboardingStep: string | null;
    onboardingError: string | null;
  };
}

export interface OnboardingResumeResult {
  resumed: boolean;
  /** Why not, when not. Never null on a no-op. */
  reason: string | null;
  advancedStage: string | null;
  run: JobRun;
}

export async function getOnboardingRun(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<OnboardingRunView> {
  return api.get<OnboardingRunView>(`/projects/${projectId}/onboarding`, options);
}

/**
 * Creates the onboarding run, or returns the existing one.
 *
 * The default idempotency key is `onboarding:<projectId>`, so a repeated POST
 * returns the existing run (200) instead of starting a second one (201).
 * §10.3 is explicit that project creation is never blindly retried, and this
 * carries the same rule onto the pipeline: the response's `created` flag says
 * which of the two happened, and the screen reports it rather than guessing.
 */
export async function createOnboardingRun(
  projectId: string,
  input?: { idempotencyKey?: string; input?: Record<string, unknown> },
): Promise<{ run: JobRun; created: boolean; view: OnboardingRunView }> {
  return api.post<{ run: JobRun; created: boolean; view: OnboardingRunView }>(
    `/projects/${projectId}/onboarding`,
    input ?? {},
  );
}

export async function getOnboardingRunById(
  projectId: string,
  runId: string,
  options?: { signal?: AbortSignal },
): Promise<OnboardingRunView> {
  return api.get<OnboardingRunView>(`/projects/${projectId}/onboarding/${runId}`, options);
}

/**
 * Resumes from the first stage that did not succeed.
 *
 * Stages that already succeeded are not re-run. When no executor for the next
 * stage is registered in the server process, `resumed: false` comes back with
 * a reason — the screen shows that reason verbatim rather than a stage that
 * pretends to have run. A 409 means finished, genuinely still running, or out
 * of retry budget; each carries a different next action.
 */
export async function resumeOnboardingRun(
  projectId: string,
  runId: string,
  input?: { force?: { restartSucceededStages?: boolean } },
): Promise<OnboardingResumeResult> {
  return api.post<OnboardingResumeResult>(
    `/projects/${projectId}/onboarding/${runId}/resume`,
    input ?? {},
  );
}

/**
 * The named stage list an onboarding run walks, in the backend's own order and
 * with the backend's own labels.
 *
 * Label-only: the screen renders the *name* of the stage the run reports and
 * never a percentage or an ETA it computed itself. design_plan §4.2's rule for
 * OP07 is "named stage, elapsed time" — there is no honest denominator for a
 * pipeline whose stages differ in length by orders of magnitude.
 *
 * These mirror `ONBOARDING_STAGES` in `jobs.types.ts`. A stage the server adds
 * later renders by its raw name rather than being dropped, which is why the
 * lookup below falls back instead of filtering.
 */
export const ONBOARDING_STAGES: ReadonlyArray<{ name: string; label: string }> = [
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

const ONBOARDING_STAGE_LABELS = new Map(ONBOARDING_STAGES.map((s) => [s.name, s.label]));

/** A stage's display label, falling back to its raw name for an unknown stage. */
export function onboardingStageLabel(name: string): string {
  return ONBOARDING_STAGE_LABELS.get(name) ?? name;
}

// ── Cadence rules, as the API actually returns them (PJ10) ──────────────

export type CadenceFrequency = 'daily' | 'weekly' | 'monthly' | 'manual';

/**
 * One task kind's schedule, in the wire's own field names.
 *
 * `configured` is the field that matters and is *not* the same as `enabled`: a
 * kind with no rule row yet is returned with `configured: false` and the
 * documented defaults. Showing those defaults as if they were stored settings
 * would turn "no schedule exists" into "here is your schedule".
 */
export interface CadenceRuleDto {
  /** False when no rule row exists yet — the other values are defaults, not stored ones. */
  configured: boolean;
  id: string | null;
  projectId: string;
  taskKind: string;
  frequency: CadenceFrequency;
  /** 0–6, Sunday = 0. Required by a weekly rule. */
  dayOfWeek: number | null;
  /** Required by a monthly rule. */
  dayOfMonth: number | null;
  hour: number;
  /** IANA. `nextRunAt` is recomputed in this zone, never the viewer's. */
  timezone: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /** Prerequisites that must be met before the rule ticks. */
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

export async function listCadenceRules(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<CadenceRuleDto[]> {
  const payload = await api.get<{ cadences: CadenceRuleDto[] }>(
    `/projects/${projectId}/cadences`,
    options,
  );
  return unwrap<CadenceRuleDto[]>(payload, 'cadences');
}

/** The weekday names a weekly rule's `dayOfWeek` refers to, Sunday first. */
export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * A one-line description of a frequency and its anchor.
 *
 * Returns the anchor as text rather than promising a clock time: §7.3 warns
 * that the existing schedulers poll hourly and use approximate day offsets, so
 * a "Mondays at 09:00" claim would be a promise the implementation does not
 * make. The stored hour and zone are still shown verbatim beside the schedule.
 */
export function describeCadenceFrequency(rule: CadenceRuleDto): string {
  switch (rule.frequency) {
    case 'daily':
      return 'Every day';
    case 'weekly':
      return rule.dayOfWeek === null
        ? 'Weekly (no weekday stored)'
        : `Weekly on ${WEEKDAY_LABELS[rule.dayOfWeek] ?? `day ${rule.dayOfWeek}`}`;
    case 'monthly':
      return rule.dayOfMonth === null
        ? 'Monthly (no day-of-month stored)'
        : `Monthly on day ${rule.dayOfMonth}`;
    case 'manual':
      return 'Manual only — no automatic tick';
    default:
      return rule.frequency;
  }
}
