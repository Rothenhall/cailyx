/**
 * Types for the Monitoring module (PRD 6.12, FR-12.1–12.4) and the G07 alert
 * triage surface.
 *
 * @module monitoring.types
 */

/** Monitoring snapshot: one point-in-time health read. */
export interface MonitorSnapshot {
  projectId: string;
  scoreTotal: number | null;
  scoreBand: string | null;
  scoreRunId: string | null;
  mentionRate: number | null;
  citationRate: number | null;
  observations: number;
  crawlerHits: number;
  takenAt: string;
}

/**
 * Delta between the two latest score runs (and measurement trend).
 *
 * Deliberately two points, not a series (G19/D19): the shape carries the last
 * two stored runs only, with no `from`/`to` window and no per-period rows. A
 * caller that needs a period series has to read it from the module that owns
 * the underlying history. `measurement` counts observations, not mentions —
 * the mention-rate comparison lives in `checkDeltas`, which is what raises
 * the alert.
 */
export interface MonitorDelta {
  projectId: string;
  /** Null until at least one score run is stored. `before`/`change` stay null until a second exists. */
  score: { before: number | null; after: number | null; change: number | null } | null;
  /** Null until at least one completed measurement run is stored. */
  measurement: { observationsBefore: number | null; observationsAfter: number | null } | null;
  checkedAt: string;
}

/**
 * Alert kinds raised by monitors.
 *
 * A skipped cadence tick is deliberately **not** an alert kind: G07 requires an
 * unmet prerequisite to be a quiet skip with a recorded reason
 * (`CadenceRule.lastError`), not a nightly failure in the feed. This vocabulary
 * stays limited to actual regressions.
 */
export type AlertKind = 'score-drop' | 'mention-drop' | 'scheduled-run-failed';

/**
 * Lifecycle status vocabulary for `AlertLifecycle.status`.
 *
 * `dismissed` is part of the schema's vocabulary and is terminal, but this
 * package exposes no dismiss route (the G07 contract lists detail /
 * acknowledge / assign / resolve). It is listed so the transition table is
 * complete and no future action can silently invent a sixth state.
 */
export type AlertTriageStatus = 'new' | 'acknowledged' | 'assigned' | 'resolved' | 'dismissed';
export const ALERT_TRIAGE_STATUSES: readonly AlertTriageStatus[] = [
  'new',
  'acknowledged',
  'assigned',
  'resolved',
  'dismissed',
];

/** Terminal triage states — a re-firing of the same condition starts a new episode. */
export const TERMINAL_TRIAGE_STATUSES: readonly AlertTriageStatus[] = ['resolved', 'dismissed'];

/**
 * Permitted triage transitions. A resolved alert is terminal: re-opening it is
 * a new alert episode (see `AlertsService.record`), never a status flip on a
 * closed one, so the record of what was done and when survives.
 */
export const ALERT_TRIAGE_TRANSITIONS: Record<AlertTriageStatus, AlertTriageStatus[]> = {
  new: ['acknowledged', 'assigned', 'resolved', 'dismissed'],
  acknowledged: ['assigned', 'resolved', 'dismissed'],
  assigned: ['acknowledged', 'resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
};

/**
 * The triage row as returned by the API. `occurrences` and `lastSeenAt` are
 * what make de-duplication visible instead of silent: the same condition
 * re-firing nightly counts up on one row rather than filling the feed.
 */
export interface AlertLifecycleDto {
  status: AlertTriageStatus;
  /** True when an AlertLifecycle row exists. False means never triaged, which reads as `new`. */
  tracked: boolean;
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
  /** Triage actions the server will currently accept. */
  actions: { canAcknowledge: boolean; canAssign: boolean; canResolve: boolean };
}

/** An alert plus its triage state. */
export interface AlertDto {
  id: string;
  projectId: string;
  kind: string;
  severity: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Lifecycle status, defaulting to `new` for an alert with no triage row yet. */
  status: AlertTriageStatus;
  lifecycle: AlertLifecycleDto;
  /**
   * Explicit reminder, carried on every alert: monitoring re-reads what other
   * modules already produced. An alert about a regression is not a verified
   * end-to-end check of the pipeline that would fix it (design_plan G07:
   * "no full-chain claim from the current monitoring check").
   */
  scopeNote: string;
}
