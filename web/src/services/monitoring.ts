import { ApiError, api, unwrap } from '@/lib/api';

/**
 * Monitoring adapter — MO01 (`/monitoring`), MO02 (`/monitoring/alerts/:id`)
 * and MO03 (`/monitoring/cadence`).
 *
 * design_plan.md §4.4 (monitoring block), §5.9 ("Mention maintenance … decay")
 * and §6.3's display rules. Three separate backend surfaces are bound here, and
 * they are **not** interchangeable:
 *
 *  1. `projects/:id/monitoring/*` — the snapshot, the delta and the manual
 *     alert check. §6.3: the snapshot reads *the latest completed run*, a
 *     different cohort from a pooled measurement summary; the two must not be
 *     presented as equivalent.
 *  2. `projects/:id/alerts` — the G07 triage surface. This is the one with a
 *     lifecycle; `projects/:id/monitoring/alerts` returns raw `Alert` rows with
 *     a JSON-*string* `payload` and no triage state at all.
 *  3. `projects/:id/cadences/:taskKind` — G07's per-task-kind cadence rules.
 *
 * A fourth, older surface is also read on MO03 and is labelled as such there:
 * `projects/:id/monitoring/schedule`, the pre-G07 `ScheduleConfig` row. It is
 * one row per project shared with the technical-audit schedule, and
 * `monitoring` is **not** a valid cadence task kind — so the monitoring cadence
 * cannot be rendered from the cadence API and is fetched from its own route.
 */

/* ────────────────────────── snapshot and delta ───────────────────────── */

/**
 * `GET /monitoring/snapshot`.
 *
 * Every measured field is nullable and null means "no run has produced it", not
 * zero. §6.3's rule applies to each: "If observations=0, render 'Not measured'".
 * `observations` and `crawlerHits` are always numbers — a count of nothing is
 * legitimately 0 — but the two rate fields and the score are not.
 */
export interface MonitorSnapshot {
  projectId: string;
  scoreTotal: number | null;
  scoreBand: string | null;
  /** The score run the total came from — the link back to its evidence. */
  scoreRunId: string | null;
  mentionRate: number | null;
  citationRate: number | null;
  /** Always present. 0 here means the latest completed run observed nothing. */
  observations: number;
  crawlerHits: number;
  /** When the server assembled this snapshot. */
  takenAt: string;
}

export interface MonitorScoreDelta {
  /** Null when only one score run exists — there is nothing to compare against. */
  before: number | null;
  /** Non-null whenever `score` itself is non-null. */
  after: number | null;
  /** `after - before`; positive is an improvement. Null with only one run. */
  change: number | null;
}

export interface MonitorMeasurementDelta {
  /** Null when only one completed measurement run exists. */
  observationsBefore: number | null;
  observationsAfter: number | null;
}

/**
 * `GET /monitoring/delta`.
 *
 * Both blocks are null when there are fewer than two runs of that kind. Note
 * what this route does **not** return: the ids or dates of the runs it
 * compared, and no rubric/coverage version. §6.4 requires those to be part of
 * the comparison key, so MO01 reports the delta but does not claim the two runs
 * are comparable, and does not draw an improvement arrow.
 */
export interface MonitorDelta {
  projectId: string;
  score: MonitorScoreDelta | null;
  measurement: MonitorMeasurementDelta | null;
  checkedAt: string;
}

/** One regression found by a manual check. Not an alert row: no id, no date. */
export interface AlertCheckFinding {
  kind: string;
  severity: string;
  message: string;
}

/** `GET /monitoring/snapshot` — 404 when neither scoring nor measurement has run. */
export async function getMonitoringSnapshot(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<MonitorSnapshot> {
  return api.get<MonitorSnapshot>(`/projects/${projectId}/monitoring/snapshot`, options);
}

export async function getMonitoringDelta(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<MonitorDelta> {
  return api.get<MonitorDelta>(`/projects/${projectId}/monitoring/delta`, options);
}

/**
 * `POST /monitoring/check` — compares the two latest runs and raises alerts.
 *
 * A **bare array** of findings is returned, not the rows that were written: a
 * regression that is still open updates its existing alert instead of adding
 * one, so this response is "what regressed", never "what was created". An empty
 * array means nothing crossed a threshold — it does not mean the check failed.
 */
export async function runMonitoringCheck(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<AlertCheckFinding[]> {
  const payload = await api.post<unknown>(
    `/projects/${projectId}/monitoring/check`,
    undefined,
    options,
  );
  if (!Array.isArray(payload)) {
    throw ApiErrorShape('The alert check did not return its findings as a list.', payload);
  }
  return payload as AlertCheckFinding[];
}

/* ──────────────────────────── alerts: triage ─────────────────────────── */

export type AlertKind = 'score-drop' | 'mention-drop' | 'scheduled-run-failed';

export const ALERT_KINDS: readonly AlertKind[] = [
  'score-drop',
  'mention-drop',
  'scheduled-run-failed',
];

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  'score-drop': 'Score drop',
  'mention-drop': 'Mention rate drop',
  'scheduled-run-failed': 'Scheduled run failed',
};

export type AlertSeverity = 'info' | 'warning' | 'critical';

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical'];

/**
 * The triage lifecycle. `resolved` and `dismissed` are terminal for this
 * episode: a later firing of the same condition opens a **new** alert rather
 * than re-opening this one.
 */
export type AlertTriageStatus = 'new' | 'acknowledged' | 'assigned' | 'resolved' | 'dismissed';

export const ALERT_TRIAGE_STATUS_LABEL: Record<AlertTriageStatus, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export interface AlertLifecycle {
  status: AlertTriageStatus;
  /** False when no lifecycle row exists yet; every field below falls back. */
  tracked: boolean;
  /** How many times this condition has been seen; 1 when untracked. */
  occurrences: number;
  lastSeenAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  assigneeId: string | null;
  workItemId: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  dedupeKey: string | null;
  /**
   * The transitions the **server** will currently accept.
   *
   * MO02 renders its controls from these booleans and nothing else, so a
   * control that would be answered with a 409 (resolving a resolved alert,
   * re-acknowledging someone else's acknowledgement) is never drawn.
   */
  actions: {
    canAcknowledge: boolean;
    canAssign: boolean;
    canResolve: boolean;
  };
}

/** One alert with its triage state (`GET /projects/:id/alerts`). */
export interface AlertDto {
  id: string;
  projectId: string;
  kind: string;
  severity: string;
  message: string;
  /** Parsed server payload — for these kinds it carries the before/after runs. */
  payload: Record<string, unknown>;
  /** When the condition was first seen. */
  createdAt: string;
  status: AlertTriageStatus;
  lifecycle: AlertLifecycle;
  scopeNote: string;
}

export interface ListAlertsFilter {
  kind?: AlertKind;
  severity?: AlertSeverity;
  status?: AlertTriageStatus;
  limit?: number;
}

/** `GET /alerts` — wrapped in `{ alerts: [...] }`. */
export async function listAlerts(
  projectId: string,
  filter?: ListAlertsFilter,
  options?: { signal?: AbortSignal },
): Promise<AlertDto[]> {
  const payload = await api.get<{ alerts: AlertDto[] }>(`/projects/${projectId}/alerts`, {
    ...options,
    query: {
      kind: filter?.kind,
      severity: filter?.severity,
      status: filter?.status,
      limit: filter?.limit,
    },
  });
  return unwrap<AlertDto[]>(payload, 'alerts');
}

export async function getAlert(
  projectId: string,
  alertId: string,
  options?: { signal?: AbortSignal },
): Promise<AlertDto> {
  return api.get<AlertDto>(`/projects/${projectId}/alerts/${alertId}`, options);
}

/**
 * `POST /alerts/:alertId/acknowledge` — records that someone has seen it.
 *
 * Idempotent for the same operator, a 409 for a different one. Callers should
 * gate on `lifecycle.actions.canAcknowledge` rather than discovering that.
 */
export async function acknowledgeAlert(projectId: string, alertId: string): Promise<AlertDto> {
  return api.post<AlertDto>(`/projects/${projectId}/alerts/${alertId}/acknowledge`);
}

/** `POST /alerts/:alertId/assign` — the assignee must be a live operator account. */
export async function assignAlert(
  projectId: string,
  alertId: string,
  assigneeId: string,
): Promise<AlertDto> {
  return api.post<AlertDto>(`/projects/${projectId}/alerts/${alertId}/assign`, { assigneeId });
}

/**
 * `POST /alerts/:alertId/resolve` — closes this episode.
 *
 * Resolution text is required and is not decoration: resolving is a decision
 * about the response, never a claim that the measurement was re-verified.
 * Terminal — the server answers 409 if the alert is already closed.
 */
export async function resolveAlert(
  projectId: string,
  alertId: string,
  input: { resolution: string; workItemId?: string },
): Promise<AlertDto> {
  return api.post<AlertDto>(`/projects/${projectId}/alerts/${alertId}/resolve`, input);
}

/**
 * What a resolved alert may state, read off the payload when the kind is known.
 *
 * These payload keys are the alert's evidence (§4.4 MO02: "Kind/severity/
 * evidence, source runs"). They are read defensively — a payload is
 * server-supplied JSON and older rows may predate a key — and anything absent
 * is reported as unrecorded rather than as zero.
 */
export interface AlertEvidence {
  beforeRunId: string | null;
  afterRunId: string | null;
  before: number | null;
  after: number | null;
  /** Points for a score drop; a rate difference for a mention drop. */
  change: number | null;
  /** Any payload keys this build does not model, shown verbatim. */
  extra: Array<{ key: string; value: string }>;
}

function readNumber(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

const EVIDENCE_KEYS = new Set([
  'beforeRunId',
  'afterRunId',
  'before',
  'after',
  'change',
  'changePoints',
  'changeRate',
]);

export function readAlertEvidence(alert: AlertDto): AlertEvidence {
  const payload = alert.payload ?? {};
  const extra: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (EVIDENCE_KEYS.has(key)) continue;
    extra.push({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    });
  }
  return {
    beforeRunId: readString(payload, 'beforeRunId'),
    afterRunId: readString(payload, 'afterRunId'),
    before: readNumber(payload, 'before'),
    after: readNumber(payload, 'after'),
    change: readNumber(payload, 'change', 'changePoints', 'changeRate'),
    extra,
  };
}

/* ─────────────────────────────── cadences ────────────────────────────── */

export type CadenceFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'off';

export const CADENCE_FREQUENCIES: readonly CadenceFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'off',
];

export const CADENCE_FREQUENCY_LABEL: Record<CadenceFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  off: 'Manual only',
};

/** §10.4 / the cadence API: a weekly rule needs a weekday, a monthly one a day. */
export function cadenceNeedsDayOfWeek(frequency: string): boolean {
  return frequency === 'weekly' || frequency === 'biweekly';
}

export function cadenceNeedsDayOfMonth(frequency: string): boolean {
  return frequency === 'monthly' || frequency === 'quarterly';
}

/**
 * The task kinds `GET /cadences` returns, in the server's order.
 *
 * The list always contains **all** of them, including kinds with no stored rule
 * (`configured: false` and every other field at its default). A missing
 * schedule is a state, not a missing row — so MO03 lists them rather than
 * hiding the unconfigured ones.
 */
export const CADENCE_TASK_KINDS: readonly string[] = [
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
];

export const CADENCE_TASK_KIND_LABEL: Record<string, string> = {
  'technical-audit': 'Website health check',
  'seo-audit': 'Search performance audit',
  'aeo-audit': 'AI visibility run',
  presence: 'Brand and presence scan',
  serp: 'Search result lookups',
  mentions: 'Mention checks',
  backlinks: 'Backlinks snapshot',
  gap: 'Competitor gap',
  score: 'Scoring',
  report: 'Report generation',
  'content-generation': 'Content generation',
  onboarding: 'Onboarding pipeline',
};

/**
 * One cadence rule (`GET /cadences/:taskKind`).
 *
 * `configured: false` means no rule row exists: every other value is the
 * server's default rather than a stored setting, and `id`/`createdAt`/
 * `updatedAt` are null.
 *
 * There is **no `paused` boolean** — a paused rule is `pausedAt !== null`. Use
 * `isCadencePaused`. A paused rule is not a failed one: it has been
 * deliberately stopped and has no `lastError` from that.
 */
export interface CadenceRule {
  configured: boolean;
  id: string | null;
  projectId: string;
  taskKind: string;
  frequency: string;
  /** 0–6, Sunday = 0. Required for weekly/biweekly. */
  dayOfWeek: number | null;
  /** 1–31. Required for monthly/quarterly. */
  dayOfMonth: number | null;
  /** Local hour in `timezone`, 0–23. There is no minute field. */
  hour: number;
  timezone: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /** Capability keys that must all be ready before this rule ticks. */
  prerequisites: string[];
  maxCostUsd: number | null;
  lastRunAt: string | null;
  lastJobRunId: string | null;
  /**
   * What happened at the last tick: `'queued'`, `'queued-not-started'`,
   * `'duplicate'` or `'skipped'`. Null before the first tick.
   */
  lastStatus: string | null;
  /**
   * Why the last tick went the way it did.
   *
   * A **skip is by design**, not a failure: an unmet prerequisite skips the
   * tick and records the reason here so it is not noisy every night. Use
   * `isCadenceSkip(lastStatus)` before deciding how to present this — it is not
   * always an error.
   */
  lastError: string | null;
  nextRunAt: string | null;
  /** Set while the rule is paused. Null when it is not. */
  pausedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function isCadencePaused(rule: CadenceRule): boolean {
  return rule.pausedAt !== null;
}

/**
 * Whether the last tick was a deliberate skip rather than a failure.
 *
 * The backend writes `'skipped'` when a rule is disabled, paused, manual-only,
 * or its prerequisites are unmet, and `'queued-not-started'` when it created a
 * run no worker could pick up. Neither is a fault in the rule.
 */
export function isCadenceSkip(lastStatus: string | null): boolean {
  return lastStatus === 'skipped';
}

/** A rule that produced no run for a reason that is not the rule's fault alone. */
export function isCadenceNotStarted(lastStatus: string | null): boolean {
  return lastStatus === 'queued-not-started';
}

/** `GET /cadences` — wrapped in `{ cadences: [...] }`, all task kinds. */
export async function listCadences(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<CadenceRule[]> {
  const payload = await api.get<{ cadences: CadenceRule[] }>(
    `/projects/${projectId}/cadences`,
    options,
  );
  return unwrap<CadenceRule[]>(payload, 'cadences');
}

export interface PutCadenceInput {
  frequency?: CadenceFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour?: number;
  timezone?: string;
  enabled?: boolean;
  /** `true` pauses; omitted leaves an existing pause in place; `false` clears it. */
  paused?: boolean;
  prerequisites?: string[];
  maxCostUsd?: number;
}

/**
 * `PUT /cadences/:taskKind` — create or replace a rule.
 *
 * Admin/delivery-lead only: a schedule is a standing commitment to spend. The
 * pause is sticky — a later PUT that omits `paused` does not clear it.
 */
export async function putCadence(
  projectId: string,
  taskKind: string,
  input: PutCadenceInput,
): Promise<CadenceRule> {
  return api.put<CadenceRule>(`/projects/${projectId}/cadences/${taskKind}`, input);
}

export type TickOutcomeKind =
  | 'started'
  | 'duplicate'
  | 'skipped'
  | 'not_due'
  | 'locked';

/** `POST /cadences/:taskKind/run-now`. */
export interface TickOutcome {
  projectId: string;
  taskKind: string;
  outcome: TickOutcomeKind;
  /** Why, in the server's words. Non-null for every non-started outcome. */
  reason: string | null;
  jobRunId: string | null;
  nextRunAt: string | null;
}

/**
 * `POST /cadences/:taskKind/run-now` — tick a rule out of band.
 *
 * Refused with a 409 when the rule is paused, or when prerequisites are unmet
 * and `overridePrerequisites` was not set. A manual tick never moves the
 * schedule.
 */
export async function runCadenceNow(
  projectId: string,
  taskKind: string,
  input: { overridePrerequisites?: boolean; reason?: string } = {},
): Promise<TickOutcome> {
  return api.post<TickOutcome>(
    `/projects/${projectId}/cadences/${taskKind}/run-now`,
    input,
  );
}

/* ───────────────── monitoring schedule (pre-G07 surface) ─────────────── */

/**
 * `GET /monitoring/schedule` — the older `ScheduleConfig` row.
 *
 * Read on MO03 only because the monitoring cadence does not exist as a cadence
 * rule: `monitoring` is not a valid task kind, so `GET /cadences/monitoring`
 * answers 400. This route is one row per project and is **shared with the
 * technical-audit schedule**, which the screen states rather than hiding.
 */
export interface MonitoringSchedule {
  cadence: string;
  nextRunAt: string | null;
  active: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
}

export async function getMonitoringSchedule(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<MonitoringSchedule> {
  return api.get<MonitoringSchedule>(`/projects/${projectId}/monitoring/schedule`, options);
}

export type MonitoringCadence = 'weekly' | 'monthly' | 'manual-only';

export const MONITORING_CADENCES: readonly MonitoringCadence[] = [
  'weekly',
  'monthly',
  'manual-only',
];

export const MONITORING_CADENCE_LABEL: Record<MonitoringCadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  'manual-only': 'Manual only',
};

export async function setMonitoringSchedule(
  projectId: string,
  cadence: MonitoringCadence,
): Promise<MonitoringSchedule> {
  return api.put<MonitoringSchedule>(`/projects/${projectId}/monitoring/schedule`, { cadence });
}

/* ──────────────────────────────── helpers ────────────────────────────── */

/**
 * An error for a body that is the wrong shape for its route.
 *
 * §10.2: an unexpected shape must be reported, not read as "no data". Same
 * purpose as `unwrap` for the wrapped routes, used on the bare-array ones.
 */
function ApiErrorShape(message: string, body: unknown): ApiError {
  return new ApiError({ kind: 'unknown', status: 0, message, body });
}
