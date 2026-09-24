/**
 * Progress module types.
 *
 * Three layers, kept apart on purpose:
 *   - `ProgressLedger` — deterministic evidence: comparable result changes,
 *     the verified work that preceded them, and a graded link between the two.
 *   - `ProgressStory` — the written page, produced only from the ledger.
 *   - `ReportProgressSection` — the resolved, capped, client-safe page a
 *     report freezes and both renderers draw.
 *
 * @module progress.types
 */

// ─── Work targeting ─────────────────────────────────────────────

export const PROGRESS_TARGET_KINDS = ['dimension', 'surface', 'competitor', 'market'] as const;
export type ProgressTargetKind = (typeof PROGRESS_TARGET_KINDS)[number];

/** What a piece of work is aimed at moving — stored as JSON on `WorkItem.targets`. */
export interface ProgressTarget {
  kind: ProgressTargetKind;
  /** Dimension key, surface key, competitor name, or ISO market code. */
  value: string;
}

// ─── Ledger ─────────────────────────────────────────────────────

/** One comparable audit in the series, as the numbers the page quotes. */
export interface ProgressCheckpoint {
  auditId: string;
  finishedAt: string;
  observations: number;
  unbrandedObservations: number;
  /** 0-1, counted. */
  mentionRate: number;
  unbrandedMentionRate: number;
  citationRate: number;
  /** Judged: answers that led with the client. Null when the stance pass did not run. */
  ledCount: number | null;
  judgedCount: number | null;
}

export type MovementScope = 'overall' | 'unbranded' | 'citation' | 'led' | 'dimension' | 'surface' | 'market' | 'competitor';
export type MovementWindow = 'since-previous' | 'since-baseline';

/**
 * A change that cleared the materiality floor between two comparable audits.
 *
 * Rates are 0-1. `led` is a judged count and is never presented as a rate —
 * `from`/`to` are counts and `fromN`/`toN` the judged totals. `competitor`
 * is the share of answers naming that rival while the client was absent, so
 * a fall is the improvement.
 */
export interface MetricMovement {
  id: string;
  scope: MovementScope;
  /** Dimension key, surface key, market code or competitor name; null for project-wide scopes. */
  key: string | null;
  label: string;
  unit: 'rate' | 'count';
  from: number;
  to: number;
  fromN: number;
  toN: number;
  delta: number;
  improvement: boolean;
  window: MovementWindow;
  fromAuditId: string;
  toAuditId: string;
}

/** One piece of delivered work, client-visible only. */
export interface WorkEvidence {
  id: string;
  kind: 'work-item' | 'publication' | 'milestone';
  title: string;
  discipline: string | null;
  completedAt: string;
  targets: ProgressTarget[];
  /** Where `targets` came from: set by an operator, derived from the AEO gap the work was raised for, or none. */
  targetSource: 'tagged' | 'gap' | 'none';
}

/**
 * How strongly the ledger may connect a result change to work (PLAN.md §7's
 * graded claims):
 *   A — verified work named this exact slice, finished before the audit that
 *       showed the change;
 *   B — verified work finished in the window, not aimed at this slice;
 *   C — no delivered work in the window; the change is reported, never credited.
 */
export type ClaimGrade = 'A' | 'B' | 'C';

export interface ProgressLink {
  id: string;
  movementId: string;
  grade: ClaimGrade;
  /** WorkEvidence ids, targeted first, at most three. */
  workIds: string[];
}

export type ProgressLayout = 'compact' | 'extended';

export interface ProgressLedger {
  version: 1;
  projectId: string;
  auditId: string;
  comparabilityKey: string;
  /** Chronological, comparable audits only; `[0]` is the baseline, the last is this audit. */
  checkpoints: ProgressCheckpoint[];
  baselineAuditId: string;
  previousAuditId: string;
  /** Engines and markets the comparison covers — named on the page (PLAN.md §7). */
  surfaceLabels: string[];
  markets: string[];
  /** Material changes only, improvements and declines both. */
  movements: MetricMovement[];
  /** Work finished since the baseline audit, newest first. */
  work: WorkEvidence[];
  links: ProgressLink[];
  /**
   * Headline-level declines since the previous audit. "If it went down, it
   * goes in the headline" (PLAN.md §7) — the page must say these.
   */
  mustDisclose: string[];
  /** True when at least one improvement cleared the floor. The page exists only then. */
  realProgress: boolean;
  layout: ProgressLayout;
}

// ─── Story ──────────────────────────────────────────────────────

export interface ProgressStory {
  headline: string;
  drivers: Array<{ linkId: string; text: string }>;
  nextFocus: string[];
}

// ─── Report section (frozen, client-safe) ───────────────────────

/** One KPI: where it stands now, where it started, and the change — with the numbers a before→after mark is drawn from. */
export interface ReportProgressTile {
  label: string;
  /** "33%" or "11 of 62". */
  now: string;
  before: string;
  /** "+24 pts" / "+8". */
  delta: string;
  /** The reference point, tile-sized: "baseline, 12 Mar 2026". */
  window: string;
  /** The change is good for the client (a rival's share falling counts as good). */
  improvement: boolean;
  /** True when the number went up — the arrow's direction, independent of whether that is good. */
  rising: boolean;
  /** Before→after marks on one 0..max scale (percent points, or counts out of the judged total). */
  meter: { from: number; to: number; max: number };
}

export interface ReportProgressDriver {
  text: string;
  grade: ClaimGrade;
  /** "Title — 12 Mar 2026" lines for the work behind this change. */
  evidence: string[];
}

export interface ReportProgressCheckpointRow {
  label: string;
  date: string;
  unbranded: string;
  overall: string;
  led: string;
  /** Whole percent, for the column chart. */
  unbrandedValue: number;
  overallValue: number;
  isCurrent: boolean;
}

export interface ReportProgressSection {
  reviewId: string;
  auditId: string;
  layout: ProgressLayout;
  headline: string;
  tiles: ReportProgressTile[];
  drivers: ReportProgressDriver[];
  checkpoints: ReportProgressCheckpointRow[];
  /** Top of the audit-by-audit chart's 0-based percent scale — shared by both renderers. */
  chartMax: number;
  delivered: {
    items: Array<{ title: string; date: string; kind: string }>;
    moreCount: number;
    sinceBaselineTotal: number;
  };
  nextFocus: string[];
  provenanceNote: string;
  frozenAt: string;
}

// ─── API ────────────────────────────────────────────────────────

export type ProgressReviewStatus = 'draft' | 'approved' | 'rejected' | 'not-applicable';

export interface ProgressReviewDto {
  id: string;
  projectId: string;
  auditId: string;
  auditFinishedAt: string;
  previousAuditId: string | null;
  baselineAuditId: string | null;
  status: ProgressReviewStatus;
  reason: string | null;
  layout: ProgressLayout;
  ledger: ProgressLedger | null;
  story: ProgressStory | null;
  storySource: 'llm' | 'template' | null;
  /** The page exactly as a report would draw it, for operator preview before approval. */
  preview: ReportProgressSection | null;
  model: string | null;
  costUsd: number;
  generatedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}
