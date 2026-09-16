/**
 * Shared types and vocabularies for G13 — comparable outcomes, report periods
 * and evidence manifests.
 *
 * Contract source: design_plan.md G13 (line 1671) and the metric dictionary /
 * comparison policy in §6.3 (line 792) and §6.4 (line 819).
 *
 * Two type-level decisions in this file are the contract, not decoration:
 *
 * 1. {@link Metric} and {@link MetricDelta} are **discriminated unions on
 *    `state`**, and the `value` property exists **only** on the measured
 *    branch. "Empty is not zero" is therefore enforced by the compiler: a
 *    consumer that has not narrowed on `state === 'measured'` cannot read a
 *    value at all, so it cannot accidentally render `0` for a period that was
 *    never measured. §6.3: "If observations=0, render 'Not measured' even
 *    though current measurement summary returns zero rates."
 *
 * 2. {@link Comparability} separates `comparable` from `methodology-break`
 *    structurally, and `deltas` exists **only** on the comparable branch. A
 *    methodology break therefore cannot be presented as movement: there is no
 *    delta field to read (§6.4, "A changed key creates a methodology break. …
 *    do not draw an unqualified improvement arrow").
 *
 * SQLite has no enums: every status column below is a `String` whose permitted
 * values are documented on the Prisma model. This file is the single source of
 * truth for those vocabularies so a controller, a service and the portal
 * projection never disagree about what a state means.
 *
 * @module results.types
 */

// ── Source vocabulary ───────────────────────────────────────────────────

/**
 * Every kind of row an `EvidenceManifest` can pin.
 *
 * Deliberately explicit rather than free text: the manifest's job is to name
 * exactly which rows a snapshot was built from, and "which source types exist"
 * is part of that contract. A source type that this system cannot read yet is
 * reported as an *omission* with a reason (see {@link EvidenceSource.omissions}),
 * never silently absent from the manifest.
 */
export type EvidenceSourceType =
  | 'measurement-run'
  | 'observation'
  | 'score-run'
  | 'aeo-audit'
  | 'aeo-surface-run'
  | 'technical-audit'
  | 'seo-audit'
  | 'presence-discovery'
  | 'authority-scan'
  | 'backlinks-summary'
  | 'crawler-hit'
  | 'competitor'
  | 'content-brief'
  | 'report'
  | 'work-item'
  | 'attachment';

export const EVIDENCE_SOURCE_TYPES: readonly EvidenceSourceType[] = [
  'measurement-run',
  'observation',
  'score-run',
  'aeo-audit',
  'aeo-surface-run',
  'technical-audit',
  'seo-audit',
  'presence-discovery',
  'authority-scan',
  'backlinks-summary',
  'crawler-hit',
  'competitor',
  'content-brief',
  'report',
  'work-item',
  'attachment',
];

/** Why a source row counts as pending rather than succeeded or failed. */
export interface EvidenceFailure {
  /** The pinned row this failure belongs to, when it is per-row. */
  id: string | null;
  reason: string;
}

/**
 * One source type's contribution to an evidence bundle.
 *
 * `expected` / `succeeded` / `failed` / `pending` are the coverage disclosure
 * §6.3 names ("Coverage — successful agreed evidence units / planned units").
 * They are attempt counts, not measurements: `succeeded: 0` here is a fact
 * about collection, and the *metric* it feeds is still reported as
 * `not-measured` rather than as a zero rate.
 */
export interface EvidenceSource {
  sourceType: EvidenceSourceType;
  /** Pinned row ids, oldest first. Empty when the source contributed nothing. */
  ids: string[];
  /** Rows the source holds for this project/window. */
  expected: number;
  succeeded: number;
  failed: number;
  /** Started and not finished. Disclosed, never dropped. */
  pending: number;
  failures: EvidenceFailure[];
  /**
   * The newest timestamp the *source itself* carries (a run's finish time, an
   * observation's creation time) — the real freshness of this evidence.
   * Never the period end; see {@link EvidenceFreshness}.
   */
  observedAt: string | null;
  /** The oldest real timestamp in the window, so a thin slice is visible. */
  oldestObservedAt: string | null;
  /** Rows this source has for the project that fall outside the requested window. */
  outsideWindow: number;
  /** Expected but absent, named rather than silently missing. */
  omissions: string[];
}

/**
 * Freshness, kept deliberately separate from the window.
 *
 * The bug this shape exists to make impossible: rendering "last updated" from
 * the newest source row and calling it "the period end". They are two
 * different facts and they are two different fields here, with
 * {@link sourcesPredatePeriodEnd} stating the relationship rather than
 * leaving a reader to infer it. design_plan §6.3: a latest-source timestamp
 * must never be mislabeled as the period end.
 */
export interface EvidenceFreshness {
  /** Newest real observation/source date across every pinned source. */
  latestSourceObservedAt: string | null;
  /** Oldest real observation/source date across every pinned source. */
  earliestSourceObservedAt: string | null;
  /** The window's own end, copied from the stored period. Never derived from sources. */
  periodEndsOn: string;
  /** True when the newest source predates the period end — coverage is not complete to the window edge. */
  sourcesPredatePeriodEnd: boolean;
  /** Whole days between the newest source and the period end. Null when nothing was observed. */
  stalenessDays: number | null;
  /** Per source type, the newest real date. The `sourceDates` JSON column. */
  perSource: Partial<Record<EvidenceSourceType, string>>;
  /** The sentence a surface can render without re-deriving any of the above. */
  statement: string;
}

/** How the projection was narrowed for its audience. */
export type ResultsAudience = 'operator' | 'client' | 'public';

/** Everything an @ClientPortal() caller may see, and the honest accounting of what was removed. */
export interface ResultsOmission {
  /** Machine key of what was left out. */
  key: string;
  /** Why it was left out, in the words §6.4 uses. */
  reason: string;
}

// ── Metrics ─────────────────────────────────────────────────────────────

/**
 * Units are explicit and never interchangeable. §6.3 and AGENT-BRIEF rule 4:
 * percentage points are not relative percentages, credits are not dollars.
 */
export type MetricUnit =
  /** A rubric total, 0-100. Not a percentage of anything. */
  | 'points'
  /** A rate in the 0-1 range, carrying its numerator and denominator. */
  | 'ratio'
  /** The difference between two ratios, expressed in points. 20% -> 30% is +10 pp. */
  | 'percentage-points'
  /** A count of rows. */
  | 'count'
  /** Milliseconds. */
  | 'milliseconds';

/**
 * What the metric was computed over — the comparison key of §6.4 minus the
 * window, which lives on {@link ResultsWindow}. A change in any of these is
 * what makes two periods non-comparable.
 */
export interface MetricScope {
  cohortId: string | null;
  methodologyHash: string | null;
  querySetId: string | null;
  querySetVersion: number | null;
  /** Engine/surface ids. Empty means "not pinned" — a comparability gap, not "all". */
  engines: string[];
  markets: string[];
  transport: string | null;
  /** Model/judge identifier, when the source recorded one. */
  model: string | null;
}

/**
 * The sampling disclosure §6.4 requires.
 *
 * "Requested n>=5 is a sampling floor, not a significance test or proof of
 * five successful responses per prompt. Repeated answers are not independent
 * people." So this carries the floor, whether it was met, and the counts —
 * and never a confidence interval or a significance badge, because no
 * approved statistical method exists in this system yet.
 */
export interface SampleDisclosure {
  /** Observations selected for this metric inside the window. */
  observations: number;
  /** The requested repeats-per-prompt floor. design_plan's floor is 5. */
  samplingFloor: number;
  meetsSamplingFloor: boolean;
  /** Distinct prompts represented. */
  prompts: number;
  /** Distinct repeat indexes seen (1..n). */
  repeats: number;
  /** Distinct engine/surface ids seen. */
  engines: number;
  /** Always set, always says the same thing — the caveat belongs with the number. */
  note: string;
}

/** Fields every metric carries, measured or not. */
export interface MetricBase {
  key: string;
  label: string;
  unit: MetricUnit;
  /** One sentence saying what the number means and what it is not. */
  definition: string;
  sample: SampleDisclosure;
  scope: MetricScope;
  /** Human-readable caveats specific to this metric in this window. */
  notes: string[];
}

/**
 * A metric that was actually computed. `value` exists only here — see the
 * module docstring.
 */
export interface MeasuredMetric extends MetricBase {
  state: 'measured';
  value: number;
  /** Present for counted rates; the denominator is never hidden. */
  numerator?: number;
  denominator?: number;
}

/**
 * A metric that was not computed. There is **no `value` property**, so a
 * consumer cannot read one without switching on `state` first, and there is
 * no default that silently becomes zero.
 */
export interface NotMeasuredMetric extends MetricBase {
  state: 'not-measured';
  /** Why there is no number. Never "0" and never "no data found" without saying what was looked for. */
  reason: string;
  /** What would have to exist for this to become measurable. */
  prerequisite: string;
}

export type Metric = MeasuredMetric | NotMeasuredMetric;

/**
 * A change between two comparable periods.
 *
 * `value` exists only on the measured branch, for the same reason
 * {@link MeasuredMetric} does: "we could not compare these" must not be
 * representable as a delta of zero.
 */
export type MetricDelta =
  | {
      key: string;
      label: string;
      state: 'measured';
      unit: Extract<MetricUnit, 'points' | 'percentage-points'>;
      /** current - baseline, in `unit`. Signed; the sign is not a judgement. */
      value: number;
      /** Both values, so a surface can show the pair rather than the change alone. */
      current: number;
      baseline: number;
      /**
       * The rows the two sides came from, so a delta is traceable to evidence.
       * Null where the metric's source is not a single pinnable row (a rate is
       * computed from many observations, and those are pinned by the manifest).
       */
      sourceIds: { current: string | null; baseline: string | null };
      note: string;
    }
  | {
      key: string;
      label: string;
      state: 'not-measured';
      unit: MetricUnit;
      reason: string;
      prerequisite: string;
    };

// ── Comparability ───────────────────────────────────────────────────────

/** Which component of the §6.4 comparison key a check covers. */
export type ComparabilityKey =
  | 'query-set'
  | 'query-set-version'
  | 'engines'
  | 'markets'
  | 'transport'
  | 'rubric-version'
  | 'repeats-policy'
  | 'window-length';

export interface ComparabilityCheck {
  key: ComparabilityKey;
  label: string;
  current: string | null;
  baseline: string | null;
  same: boolean;
  /** True when a difference on this key invalidates the comparison outright. */
  isBreak: boolean;
  note: string;
}

/** A recorded methodology break, as persisted on `MeasurementCohort.breaks`. */
export interface MethodologyBreak {
  at: string;
  reason: string;
  previousHash: string | null;
  currentHash: string | null;
  /** The cohort the comparison was against, when the break was recorded by a comparison. */
  againstCohortId?: string | null;
  keys?: ComparabilityKey[];
}

/** The period (and cohort) a comparison ran against. */
export interface BaselineRef {
  periodId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  cohortId: string | null;
  methodologyHash: string | null;
  /** Where the window came from — a stored period, or explicit request bounds. */
  windowSource: 'period' | 'request';
}

/**
 * The comparability verdict.
 *
 * `deltas` appears only on the `comparable` branch. On a methodology break the
 * response carries the break, the checks that produced it, and the withheld
 * metric keys — and no deltas at all, so no surface can render movement that
 * the two runs do not actually support.
 */
export type Comparability =
  | {
      state: 'comparable';
      baseline: BaselineRef;
      checks: ComparabilityCheck[];
      deltas: MetricDelta[];
      note: string;
    }
  | {
      state: 'methodology-break';
      baseline: BaselineRef;
      checks: ComparabilityCheck[];
      /** Just recorded, or already on the cohort. Deduplicated by baseline pair. */
      breaks: MethodologyBreak[];
      reason: string;
      /** The sentence stating that the delta was withheld, and why. */
      withheld: string;
      /** Metric keys that *would* have carried a delta. Named, not silently gone. */
      withheldMetricKeys: string[];
    }
  | {
      state: 'no-baseline';
      reason: string;
      prerequisite: string;
    };

// ── Window ──────────────────────────────────────────────────────────────

/**
 * The reporting window actually served.
 *
 * `stored: true` is the reproducibility guarantee: the bounds came from a
 * `ReportPeriod` row and were not re-derived from today's date. A window
 * assembled from a request is `stored: false` and says so, because the same
 * URL will return a different window tomorrow (§6.4 and G13 acceptance,
 * "exact historical window reproducible").
 */
export interface ResultsWindow {
  /** How the window was decided. */
  appliedBy: 'period' | 'request' | 'default';
  periodId: string | null;
  label: string | null;
  /** Inclusive start, ISO 8601 UTC. */
  startsOn: string;
  /** Inclusive end, ISO 8601 UTC. */
  endsOn: string;
  /** The IANA timezone the bounds were resolved in. */
  timezone: string;
  /** True when the bounds came from a stored ReportPeriod. */
  stored: boolean;
  /** Whole days covered. */
  days: number;
  /** Set when the window is *not* stored, so a caller knows why it will move. */
  reproducibilityNote: string | null;
}

// ── The view ────────────────────────────────────────────────────────────

export interface CohortSummary {
  id: string;
  name: string;
  querySetId: string | null;
  querySetVersion: number | null;
  engines: string[];
  markets: string[];
  transport: string | null;
  methodologyHash: string | null;
  baselineRunId: string | null;
  baselineAt: string | null;
  breaks: MethodologyBreak[];
}

/** A pending or failed collection, disclosed rather than dropped. */
export interface ObservationDisclosure {
  sourceType: EvidenceSourceType;
  id: string;
  status: string;
  /** What is wrong or outstanding, in the source's own words where it has any. */
  detail: string;
  observedAt: string | null;
}

/**
 * Business outcomes stay explicitly unmeasured until a CRM/conversion linkage
 * exists. `Lead` rows are Cailyx's own sales pipeline (PRD 6.11) and are never
 * a client's revenue — so they are described here and never summed into ROI.
 */
export interface BusinessOutcomes {
  state: 'not-measured';
  reason: string;
  prerequisite: string;
  /** What the system actually holds, labelled with what it actually is. */
  presentRows: {
    /** Cailyx's own inbound sales pipeline for this project. Not client revenue. */
    cailyxLeadPipeline: { count: number; whatItIs: string; whatItIsNot: string };
    /** Count of self-reported allowed AI-source responses. Self-report; no causal ROI. */
    aiAttributedResponses: { count: number; whatItIs: string; whatItIsNot: string };
  };
}

/** The closing bookkeeping: what was withheld, what is pending, what is sampled. */
export interface DisclosureBlock {
  /** Work that started and has not reported. */
  pending: ObservationDisclosure[];
  /** Collection that failed, with its reason. Never silently dropped. */
  failed: ObservationDisclosure[];
  /** Whole-source caveats a surface must render next to the numbers. */
  caveats: string[];
  /** Everything deliberately removed from this projection for its audience. */
  omitted: ResultsOmission[];
  /** The audience this projection was narrowed for. */
  audience: ResultsAudience;
}

/** The result of one `GET .../results` call. */
export interface ResultsView {
  projectId: string;
  generatedAt: string;
  audience: ResultsAudience;
  window: ResultsWindow;
  cohort: CohortSummary | null;
  /** Every metric the dictionary defines, each measured or explicitly not. */
  metrics: Metric[];
  comparability: Comparability;
  evidence: EvidenceBundleView;
  businessOutcomes: BusinessOutcomes;
  disclosure: DisclosureBlock;
  notes: string[];
}

/** An evidence bundle plus its storage state. */
export interface EvidenceBundleView {
  /** The persisted `EvidenceManifest.id`, when one is pinned for this period+subject. */
  manifestId: string | null;
  /** True when `manifestId` is set — the snapshot is reproducible from stored ids. */
  pinned: boolean;
  sources: Partial<Record<EvidenceSourceType, string[]>>;
  coverage: Partial<Record<EvidenceSourceType, EvidenceCoverage>>;
  freshness: EvidenceFreshness;
  omissions: string[];
  /**
   * Sources whose pinned id list was cut short because the row count exceeded
   * {@link EVIDENCE_PIN_LIMIT}. Named here rather than silently present: the
   * counts and the window bounds remain exact, but the id list is a prefix.
   */
  truncations: string[];
  scoreRunId: string | null;
  rubricVersion: string | null;
}

/** The coverage triple stored in `EvidenceManifest.coverage`. */
export interface EvidenceCoverage {
  expected: number;
  succeeded: number;
  failed: number;
  pending: number;
  /** Named reasons for the failed count. */
  failedReason: string | null;
  /**
   * How many ids were pinned for this source. Equal to `expected` unless the
   * source exceeded {@link EVIDENCE_PIN_LIMIT}.
   */
  pinnedCount: number;
  /** True when the pinned id list is a prefix of a larger set. */
  truncated: boolean;
}

/** A stored manifest, as returned by the read endpoints. */
export interface EvidenceManifestView extends EvidenceBundleView {
  id: string;
  projectId: string;
  subjectType: string;
  subjectId: string | null;
  periodId: string | null;
  cohortId: string | null;
  createdAt: string;
  /** The window the manifest was built for, resolved from its period when one is set. */
  window: ResultsWindow | null;
}

// ── Metric keys ─────────────────────────────────────────────────────────

/**
 * The metric keys this module serves. A key present here always appears in the
 * response, measured or not — the dictionary is not filtered down to whatever
 * happened to have data, because a missing row is exactly the ambiguity
 * "empty is not zero" exists to remove.
 */
export type MetricKey =
  | 'rubricScore'
  | 'mentionRate'
  | 'citationRate'
  | 'shareOfVoice'
  | 'observations'
  | 'coverage'
  | 'crawlerActivity'
  | 'referringDomains';

export const METRIC_KEYS: readonly MetricKey[] = [
  'rubricScore',
  'mentionRate',
  'citationRate',
  'shareOfVoice',
  'observations',
  'coverage',
  'crawlerActivity',
  'referringDomains',
];

/** The sampling floor design_plan §6.4 names. Not a significance test. */
export const SAMPLING_FLOOR = 5;

/**
 * How many row ids a manifest pins per source type.
 *
 * Pinning a bounded prefix keeps a manifest write small while the counts and
 * window bounds stay exact, and any source that exceeded the limit is named in
 * `truncations` rather than being silently shortened.
 */
export const EVIDENCE_PIN_LIMIT = 500;

/** The default rolling window when a caller names neither a period nor bounds. */
export const DEFAULT_WINDOW_DAYS = 30;

/** Substrings that must never reach an operator-facing `error` disclosure. */
export const SECRET_PATTERN = /(api[_-]?key|secret|token|password|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]{8,})/i;
