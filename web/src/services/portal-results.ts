import { api } from '@/lib/api';
import type { CoverageIssue, CoverageSummary } from '@/types';

/**
 * Client-side results adapter (design_plan G13) — CP07 "results".
 *
 * Route: `@ClientPortal() @Controller('portal/projects/:projectId')` in
 * `backend/src/modules/results/results.controller.ts`. The client is resolved
 * from the session; the project in the URL is asserted against that client.
 *
 * ## The two contract-bearing shapes below
 *
 * 1. **`Metric` is a discriminated union on `state`, and `value` exists only on
 *    the measured branch.** "Empty is not zero" is therefore enforced by the
 *    compiler: a screen that has not narrowed on `state === 'measured'` cannot
 *    read a number at all, so it cannot render `0` for a window that was never
 *    measured (§6.3).
 * 2. **`Comparability` separates `comparable` from `methodology-break`
 *    structurally, and `deltas` exists only on the comparable branch.** On a
 *    break there is no delta array to read and no before/after pair to subtract,
 *    so a screen cannot draw an improvement arrow the two runs do not support
 *    (§6.4).
 *
 * Both are mirrored here from `backend/src/modules/results/results.types.ts`
 * for the fields this surface renders. The payload is already the *client*
 * projection: `ResultsService.project(view, 'client')` removes lead rows,
 * personal contact data, operator identifiers, raw model answers, internal
 * notes, unpublished drafts and commercial costs, and names each removal in
 * `disclosure.omitted`.
 *
 * @module services/portal-results
 */

export type PortalMetricUnit =
  | 'points'
  | 'ratio'
  | 'percentage-points'
  | 'count'
  | 'milliseconds';

export interface PortalMetricScope {
  cohortId: string | null;
  methodologyHash: string | null;
  querySetId: string | null;
  querySetVersion: number | null;
  /** Engine/surface ids. Empty means "not pinned" — not "all". */
  engines: string[];
  markets: string[];
  transport: string | null;
  model: string | null;
}

export interface PortalSampleDisclosure {
  observations: number;
  samplingFloor: number;
  meetsSamplingFloor: boolean;
  prompts: number;
  repeats: number;
  engines: number;
  note: string;
}

interface PortalMetricBase {
  key: string;
  label: string;
  unit: PortalMetricUnit;
  definition: string;
  sample: PortalSampleDisclosure;
  scope: PortalMetricScope;
  notes: string[];
}

export interface PortalMeasuredMetric extends PortalMetricBase {
  state: 'measured';
  value: number;
  numerator?: number;
  denominator?: number;
}

export interface PortalNotMeasuredMetric extends PortalMetricBase {
  state: 'not-measured';
  /** Why there is no number. */
  reason: string;
  /** What would have to exist for this to become measurable. */
  prerequisite: string;
}

export type PortalMetric = PortalMeasuredMetric | PortalNotMeasuredMetric;

export type PortalMetricDelta =
  | {
      key: string;
      label: string;
      state: 'measured';
      unit: 'points' | 'percentage-points';
      /** current − baseline, in `unit`. The sign is not a judgement. */
      value: number;
      current: number;
      baseline: number;
      sourceIds: { current: string | null; baseline: string | null };
      note: string;
    }
  | {
      key: string;
      label: string;
      state: 'not-measured';
      unit: PortalMetricUnit;
      reason: string;
      prerequisite: string;
    };

export type PortalComparabilityKey =
  | 'query-set'
  | 'query-set-version'
  | 'engines'
  | 'markets'
  | 'transport'
  | 'rubric-version'
  | 'repeats-policy'
  | 'window-length';

export interface PortalComparabilityCheck {
  key: PortalComparabilityKey;
  label: string;
  current: string | null;
  baseline: string | null;
  same: boolean;
  /** True when a difference on this key invalidates the comparison outright. */
  isBreak: boolean;
  note: string;
}

export interface PortalBaselineRef {
  periodId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  cohortId: string | null;
  methodologyHash: string | null;
  windowSource: 'period' | 'request';
}

export interface PortalMethodologyBreak {
  at: string;
  reason: string;
  previousHash: string | null;
  currentHash: string | null;
  keys?: PortalComparabilityKey[];
}

export type PortalComparability =
  | {
      state: 'comparable';
      baseline: PortalBaselineRef;
      checks: PortalComparabilityCheck[];
      deltas: PortalMetricDelta[];
      note: string;
    }
  | {
      state: 'methodology-break';
      baseline: PortalBaselineRef;
      checks: PortalComparabilityCheck[];
      breaks: PortalMethodologyBreak[];
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

export interface PortalResultsWindow {
  appliedBy: 'period' | 'request' | 'default';
  periodId: string | null;
  label: string | null;
  /** Inclusive start, ISO 8601. */
  startsOn: string;
  /** Inclusive end, ISO 8601. */
  endsOn: string;
  timezone: string;
  /** True when the bounds came from a stored ReportPeriod. */
  stored: boolean;
  days: number;
  /** Set when the window is *not* stored, so a caller knows why it will move. */
  reproducibilityNote: string | null;
}

export interface PortalCohortSummary {
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
  breaks: PortalMethodologyBreak[];
}

export type PortalEvidenceSourceType =
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

export interface PortalEvidenceCoverage {
  expected: number;
  succeeded: number;
  failed: number;
  pending: number;
  failedReason: string | null;
  pinnedCount: number;
  truncated: boolean;
}

export interface PortalEvidenceFreshness {
  /** Newest real observation/source date. Never the period end. */
  latestSourceObservedAt: string | null;
  earliestSourceObservedAt: string | null;
  /** The window's own end, copied from the stored period. */
  periodEndsOn: string;
  sourcesPredatePeriodEnd: boolean;
  stalenessDays: number | null;
  perSource: Partial<Record<PortalEvidenceSourceType, string>>;
  statement: string;
}

export interface PortalEvidenceBundle {
  manifestId: string | null;
  /** True when the snapshot is reproducible from stored ids. */
  pinned: boolean;
  sources: Partial<Record<PortalEvidenceSourceType, string[]>>;
  coverage: Partial<Record<PortalEvidenceSourceType, PortalEvidenceCoverage>>;
  freshness: PortalEvidenceFreshness;
  omissions: string[];
  truncations: string[];
  scoreRunId: string | null;
  rubricVersion: string | null;
}

export interface PortalObservationDisclosure {
  sourceType: PortalEvidenceSourceType;
  id: string;
  status: string;
  detail: string;
  observedAt: string | null;
}

export interface PortalResultsOmission {
  key: string;
  reason: string;
}

/**
 * Business outcomes stay explicitly unmeasured until a CRM/conversion linkage
 * exists — and in the client projection Cailyx's own lead pipeline is replaced
 * by a `count: 0` row whose text says it is not included at all. It is never
 * summed into ROI.
 */
export interface PortalBusinessOutcomes {
  state: 'not-measured';
  reason: string;
  prerequisite: string;
  presentRows: {
    cailyxLeadPipeline: { count: number; whatItIs: string; whatItIsNot: string };
    aiAttributedResponses: { count: number; whatItIs: string; whatItIsNot: string };
  };
}

export interface PortalDisclosureBlock {
  pending: PortalObservationDisclosure[];
  failed: PortalObservationDisclosure[];
  caveats: string[];
  /** Everything deliberately removed from this projection, with its reason. */
  omitted: PortalResultsOmission[];
  audience: 'operator' | 'client' | 'public';
}

export interface PortalResultsView {
  projectId: string;
  generatedAt: string;
  audience: 'operator' | 'client' | 'public';
  window: PortalResultsWindow;
  cohort: PortalCohortSummary | null;
  metrics: PortalMetric[];
  comparability: PortalComparability;
  evidence: PortalEvidenceBundle;
  businessOutcomes: PortalBusinessOutcomes;
  disclosure: PortalDisclosureBlock;
  notes: string[];
}

export interface PortalResultsQuery {
  /** A stored ReportPeriod id — the reproducible form. Replaces `from`/`to`. */
  periodId?: string;
  from?: string;
  to?: string;
  /** A period or cohort id to compare against. Omit for no comparison. */
  baselineId?: string;
  cohortId?: string;
  /** IANA zone the bounds resolve in. Defaults to the project's own. */
  timezone?: string;
}

export async function getPortalResults(
  projectId: string,
  query: PortalResultsQuery = {},
  options?: { signal?: AbortSignal },
) {
  return api.get<PortalResultsView>(`/portal/projects/${encodeURIComponent(projectId)}/results`, {
    ...options,
    query: {
      periodId: query.periodId,
      from: query.from,
      to: query.to,
      baselineId: query.baselineId,
      cohortId: query.cohortId,
      timezone: query.timezone,
    },
  });
}

/** Human names for the evidence source types a coverage panel has to name. */
export const EVIDENCE_SOURCE_LABEL: Record<PortalEvidenceSourceType, string> = {
  'measurement-run': 'Measurement runs',
  observation: 'Model observations',
  'score-run': 'Score runs',
  'aeo-audit': 'AI-visibility audit',
  'aeo-surface-run': 'AI-surface runs',
  'technical-audit': 'Technical audit',
  'seo-audit': 'SEO audit',
  'presence-discovery': 'Digital-presence discovery',
  'authority-scan': 'Authority scan',
  'backlinks-summary': 'Backlinks summary',
  'crawler-hit': 'Crawler activity',
  competitor: 'Competitors',
  'content-brief': 'Content briefs',
  report: 'Reports',
  'work-item': 'Work items',
  attachment: 'Attachments',
};

/**
 * Aggregates the per-source coverage triple into the `CoverageSummary` the
 * `CoveragePanel`/`MetricTile` patterns render.
 *
 * Failed and pending sources stay **separate lists** rather than collapsing
 * into one "unavailable" count: a failed source is a failure, a pending one is
 * accepted and not yet reported (§3.5 "partial audit" forbids merging them).
 * When a source carries no `failedReason`, the reason says so instead of
 * leaving the list entry bare.
 *
 * Returns `null` when the bundle has no coverage at all, so the caller renders
 * "not measured" rather than a 0-of-0 panel.
 */
export function coverageSummaryFromEvidence(
  evidence: PortalEvidenceBundle,
): CoverageSummary | null {
  const entries = Object.entries(evidence.coverage) as Array<
    [PortalEvidenceSourceType, PortalEvidenceCoverage]
  >;
  if (entries.length === 0) return null;

  let expectedCount = 0;
  let successfulCount = 0;
  const failed: CoverageIssue[] = [];
  const deferred: CoverageIssue[] = [];

  for (const [sourceType, coverage] of entries) {
    const name = EVIDENCE_SOURCE_LABEL[sourceType] ?? sourceType;
    expectedCount += coverage.expected;
    successfulCount += coverage.succeeded;
    if (coverage.failed > 0) {
      failed.push({
        name,
        reason:
          coverage.failedReason ??
          `${coverage.failed} check(s) failed. The source did not report a reason, so the cause is not known from here.`,
      });
    }
    if (coverage.pending > 0) {
      deferred.push({
        name,
        reason: `${coverage.pending} check(s) started and have not reported yet. They are not counted as successful.`,
      });
    }
  }

  return { expectedCount, successfulCount, failed, deferred };
}
