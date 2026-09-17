/**
 * Types for the Cailyx **digital-performance** score family
 * (platform_improvement_plan.md §5.2–§5.5, phase P14).
 *
 * §5.2: this is a DIFFERENT score from the five-dimension
 * `ScoreRun`/`ScoreRubric` roll-up in `scoring.types.ts`. "The existing score
 * answers a narrower AI/search-readiness question. The requested Cailyx score
 * covers broader digital performance. These are not interchangeable." Nothing
 * in this file changes, renames or reinterprets a legacy row.
 *
 * @module digital-performance.types
 */

/** The score family key. Written on every run so a reader can never confuse it with the legacy family. */
export const DIGITAL_PERFORMANCE_FAMILY = 'digital-performance';

/** The six proposed buckets, in canonical display order (§5.2's table). */
export const DIGITAL_PERFORMANCE_BUCKETS = [
  'website-health',
  'google-visibility',
  'ai-visibility',
  'online-profiles',
  'social-activity',
  'content-quality',
] as const;

export type DigitalPerformanceBucket = (typeof DIGITAL_PERFORMANCE_BUCKETS)[number];

/** §5.3's distinct bucket states. They are five, not two — "we have not looked" and "we looked and it broke" are different facts. */
export type BucketState =
  | 'measured'
  | 'not-measured'
  | 'not-applicable'
  | 'outdated'
  | 'failed';

/** Run status. `incomplete` is the conservative first-version default whenever ANY applicable bucket is unmeasured or invalid. */
export type RunStatus = 'complete' | 'incomplete';

/** §5.5 comparison state between a run and the run before it. */
export type ComparisonState = 'new-segment' | 'comparable' | 'scoring-changed';

/** Applicability is a recorded decision, never inferred (§5.3 rule 1). */
export type Applicability = 'applicable' | 'not-applicable';

// ─── Versioned methodology configuration (§5.4: thresholds are configurable) ──

/**
 * One bucket's configuration inside a methodology version. Every threshold the
 * plan flags as "needing agreement" lives here rather than in code, so a later
 * approved change is a new methodology version and not a rewrite.
 */
export interface MethodologyBucketConfig {
  key: DigitalPerformanceBucket;
  label: string;
  /** Proposed weight. The weights are a product decision (§22 D01) — see `WEIGHTS_ARE_APPROVED`. */
  weight: number;
  /** The formula version for this bucket, e.g. `website-health/1`. */
  metricVersion: string;
  /** A source older than this is `outdated`, never silently scored. */
  maxAgeDays: number;
  /** The smallest denominator this bucket will score. Below it the bucket is `not-measured`. */
  minSample: number;
  /** §5.5 — where a bucket card sends a reader for client-safe detail. */
  detailPath: string;
  detailQuery?: string | null;
  /** What the bucket measures — displayed verbatim so scope is never implied. */
  scope: Record<string, unknown>;
  /** Deterministic thresholds, documented in docs/analysis/digital-performance-score.md. */
  thresholds: Record<string, unknown>;
}

export interface MethodologyConfig {
  /** Human-readable rounding rule. Only the final total and the coverage figure are rounded. */
  rounding: string;
  buckets: MethodologyBucketConfig[];
  /**
   * Optional band table. Deliberately absent from v1: the plan does not define
   * band names for this score, and inventing them here would present an
   * unapproved judgement as a settled one. The column exists so a later
   * approved version can add bands without a schema change.
   */
  bands?: Array<{ max: number; band: string }>;
}

// ─── Deterministic metric inputs ──────────────────────────────────────────────

/**
 * One submetric's exact arithmetic. §5.4 requires numerator, denominator, units
 * and rounding per submetric; §5.3 rule 3 requires the formula be
 * deterministic — LLM prose never sets a score.
 */
export interface MetricInput {
  id: string;
  /** The business question this submetric answers, in plain English. */
  question: string;
  /** false for facts we record but deliberately do NOT score (e.g. engagement counts with no defensible benchmark). */
  scored: boolean;
  numerator: number | null;
  denominator: number | null;
  units: string;
  rounding: string;
  /** 0-100, or null when the submetric did not produce a value. */
  value: number | null;
  /** Why this submetric is excluded from its bucket's mean (never "0 because unknown"). */
  excluded?: string;
  /** Extra deterministic facts (medians, surfaces, margins) recorded for the reader. */
  facts?: Record<string, string | number | null>;
}

/** One source row the bucket read, with its own age. §5.3: source references and source ages are stored per bucket. */
export interface SourceRef {
  kind: string;
  ref: string;
  observedAt: string | null;
  ageDays: number | null;
}

/** What a bucket evaluator produces before the state machine is applied. */
export interface BucketEvaluation {
  /** Whether a successful source record exists at all. */
  hasSource: boolean;
  /** Timestamp of the newest SUCCESSFUL source record. */
  latestSuccessAt: Date | null;
  /** Timestamp of the newest attempt, successful or not. */
  latestAttemptAt: Date | null;
  /** True when the newest attempt (which is newer than the newest success) recorded a failure. */
  latestAttemptFailed: boolean;
  /** The failure the source reported, verbatim-ish, for the bucket's missing reasons. */
  failureReason?: string;
  /** Why there is no successful source at all, when there is none. */
  absentReason?: string;
  submetrics: MetricInput[];
  sources: SourceRef[];
  /** Disclosures: scope measured, what the metric does not claim, known limitations. */
  notes: string[];
  /** Extra plain-English reasons this bucket cannot be scored yet. */
  missingReasons: string[];
  /** The denominator the min-sample gate is checked against. */
  sample: number;
  windowStart: Date | null;
  windowEnd: Date | null;
}

/** A fully resolved bucket, ready to persist. */
export interface ResolvedBucket {
  key: DigitalPerformanceBucket;
  label: string;
  weight: number;
  applicability: Applicability;
  applicabilityReason?: string;
  state: BucketState;
  value: number | null;
  weightedPoints: number;
  effectiveWeight: number;
  contribution: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  metricVersion: string;
  metricInputs: MetricInput[];
  thresholds: Record<string, unknown>;
  sources: SourceRef[];
  maxAgeDays: number;
  minSample: number;
  missingReasons: string[];
  notes: string[];
  detailPath: string;
  detailQuery: string | null;
}

// ─── Read models ──────────────────────────────────────────────────────────────

/** §5.5 — one comparable stretch of runs. Scores are never averaged across segments. */
export interface ComparisonSegment {
  index: number;
  comparisonKey: string;
  runs: Array<{
    id: string;
    createdAt: string;
    status: RunStatus;
    total: number | null;
    evidenceCoverage: number;
    bucketValues: Record<string, number | null>;
  }>;
  /** Only present from the second segment on: "Scoring changed" at this run. */
  scoringChangedAt: string | null;
}

/**
 * The period a bucket's detail destination should be opened with (§5.5).
 *
 * `path` is nullable because the stored column is: a methodology bucket is
 * *required* to declare a `detailPath` (the service refuses one without it), but
 * the column itself is a nullable Prisma string, and a run written before that
 * requirement existed would carry none. A null path is rendered as "no detail
 * page is recorded for this area" rather than as a link to nowhere.
 */
export interface DetailTarget {
  path: string | null;
  query: string | null;
  period: { start: string | null; end: string | null };
}

// ─── Client-safe projection (P15, §3.5 "safe projection") ─────────────────────
//
// §4.6 draws the line explicitly: a client may see "source names, dates, counts
// checked, what was missing, and why a comparison is unavailable"; staff-only
// detail is "run IDs, model versions, raw samples, source joins, charge
// estimates, and retry diagnostics". Everything below is the client side of
// that line, and it is a *projection* of the stored run rather than a second
// calculation: the numbers are the same numbers, with the internal handles
// removed. §4.3:
//  - raw bucket/run state strings become plain labels (`BUCKET_STATE_LABEL`),
//  - the methodology version stays in the "How this score is calculated" sheet
//    rather than in a headline,
//  - a `SourceRef.ref` (an audit id, a snapshot id, a storage row count) is
//    dropped rather than shown: it is an internal record handle.

/**
 * Plain labels for §5.3's five bucket states. A client screen must never print
 * `not-measured` or `outdated` — those are storage values, not sentences.
 */
export const BUCKET_STATE_LABEL: Record<BucketState, string> = {
  measured: 'Measured',
  'not-measured': 'Not measured yet',
  'not-applicable': 'Not relevant to your business',
  outdated: 'Results are out of date',
  failed: 'The last update did not finish',
};

/**
 * Client-safe source names, keyed by the `kind` prefix a bucket evaluator
 * writes. A kind outside this table is still shown, humanised from its own
 * prefix, so a newly added source appears rather than vanishing.
 */
const SOURCE_KIND_LABEL: Record<string, string> = {
  TechnicalAudit: 'Website check',
  AuditPage: 'Pages checked',
  GoogleDataSnapshot: 'Google Search Console',
  AeoAudit: 'AI answer audit',
  AeoStance: 'AI answers checked',
  'surfaces measured': 'AI tools checked',
  PresenceAccount: 'Online accounts',
  PresencePost: 'Social posts',
  'channels in scope': 'Social channels checked',
  ContentBrief: 'Content plans',
  ContentRevision: 'Saved content',
};

/** The label a client sees for a stored source kind — never the raw kind. */
export function sourceKindLabel(kind: string): string {
  const prefix = kind.split(':')[0];
  return SOURCE_KIND_LABEL[prefix] ?? SOURCE_KIND_LABEL[kind] ?? humanise(prefix);
}

function humanise(value: string): string {
  const spaced = value
    .replace(/[_:]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced === '') return 'Measured result';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One bucket source a client may see: a name and dates, never a record handle. */
export interface ClientSafeBucketSource {
  kind: string;
  label: string;
  observedAt: string | null;
  ageDays: number | null;
}

export interface ClientSafeScoreBucket {
  key: string;
  label: string;
  weight: number;
  applicability: Applicability;
  applicabilityReason: string | null;
  state: BucketState;
  /** `BUCKET_STATE_LABEL[state]` — so no screen has to map a storage value. */
  stateLabel: string;
  /** null unless measured. An absent value always carries a state and a reason. */
  value: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  /** Plain-English reasons this bucket is not measured. Never "0 because unknown". */
  missingReasons: string[];
  /** Disclosures — what the bucket measures and what it deliberately does not claim. */
  notes: string[];
  /** The business questions this bucket's submetrics answer (§5.4), in plain English. */
  questions: string[];
  sources: ClientSafeBucketSource[];
  detail: DetailTarget;
}

/** One run as a client reads it. `total` is null whenever the run is incomplete. */
export interface ClientSafeScoreRun {
  id: string;
  createdAt: string;
  status: RunStatus;
  statusLabel: string;
  total: number | null;
  evidenceCoverage: number;
  coverageMeaning: string;
  comparison: {
    state: ComparisonState;
    segmentIndex: number;
    scoringChanged: boolean;
    changeInTotal: number | null;
    changeUnavailableReason: string | null;
  };
  buckets: ClientSafeScoreBucket[];
}

/**
 * What a client may read about the Cailyx score family.
 *
 * `latest` and `lastComplete` are two separate objects with distinct ids, so
 * §5.3 rule 7 holds here too: a previous complete score can be shown as "Last
 * complete score — [date]" and its total can never be blended with newly
 * measured buckets, because there is no shape in which to blend them.
 */
export interface ClientSafeScoreView {
  family: string;
  scoreName: string;
  methodology: {
    version: number;
    label: string;
    weightsApproved: boolean;
    approvalNote: string;
  };
  latest: ClientSafeScoreRun | null;
  lastComplete: ClientSafeScoreRun | null;
  lastCompleteIsLatest: boolean;
  note: string | null;
}

/** §5.5's "How this score works" sheet, in plain English and from stored config. */
export interface ScoreExplanation {
  headline: string;
  missingDataRule: string;
  totalRule: string;
  coverageRule: string;
  comparisonRule: string;
  buckets: Array<{
    key: string;
    label: string;
    weight: number;
    /** Plain-English "what this covers" drawn from the bucket's own disclosure. */
    covers: string[];
    /** What the bucket deliberately does not claim. */
    excludes: string[];
  }>;
  methodologyVersion: number;
}
