/**
 * Read models for the project Overview (platform_improvement_plan.md §5.1,
 * §5.5–§5.7, phase P15).
 *
 * §5.1 fixes the page's shape as hard limits, and this file encodes them as
 * types rather than as a comment the UI may drift from:
 *
 *  - **one** overall score (`OverviewScorePanel.total` is the only total here),
 *  - the **applicable** bucket cards (`buckets` excludes a bucket recorded
 *    `not-applicable`; that decision is reported separately in
 *    `excludedFromScore` and only ever inside the "How this score works" sheet),
 *  - **at most three** action cards (`OverviewActionPanel.items` is capped and
 *    the cap is published as `limit`, while `total` is the true count),
 *  - **at most five** upcoming items (`OVERVIEW_UPCOMING_LIMIT`),
 *  - compact plan and report links, not a second page of plan detail.
 *
 * §4.5's partial-failure rule is structural here: **every panel is its own
 * section envelope**. `OverviewView.sections` always carries the same keys, and
 * a section whose source read failed carries `status: 'unavailable'` with a safe
 * sentence — never a thrown error that would blank the other four panels, and
 * never provider exception text (§4.4: "Convert errors to stable reason codes
 * and safe messages at the backend projection boundary").
 *
 * @module results/overview.types
 */

/** §5.1's cap on the action panel, and the hard maximum the endpoint accepts. */
export const OVERVIEW_ACTION_LIMIT = 3;

/** §5.1's cap on the upcoming-content panel. */
export const OVERVIEW_UPCOMING_LIMIT = 5;

export type OverviewAudience = 'client' | 'operator';

/**
 * `ok` — the source answered and had something to show.
 * `empty` — the source answered and there is genuinely nothing yet. This is a
 *           fact about the project, not a failure, and the copy differs.
 * `unavailable` — the source read failed. §4.5: this panel degrades; the page
 *           does not.
 */
export type OverviewSectionStatus = 'ok' | 'empty' | 'unavailable';

/**
 * A stable code so the UI chooses its own copy without parsing a message.
 * Only safe codes are listed: a provider's exception text never crosses this
 * boundary (§4.4).
 */
export type OverviewSectionReasonCode =
  | 'no-data-yet'
  | 'not-connected'
  | 'not-shared'
  | 'read-failed'
  | null;

/** One panel of the overview. A section is always present; its data may not be. */
export interface OverviewSection<T> {
  status: OverviewSectionStatus;
  /**
   * Non-null whenever the source answered — so for `ok` *and* for `empty`.
   * An empty panel still needs its own copy, links and disclosures ("nothing
   * is scheduled yet" plus the calendar link); only `unavailable` has nothing
   * to say beyond its reason.
   */
  data: T | null;
  /** Safe, action-oriented sentence. Non-null when the section is not `ok`. */
  reason: string | null;
  reasonCode: OverviewSectionReasonCode;
}

// ─── Header (§4.2: title, one-sentence explanation, context) ──────────────────

export interface OverviewHeader {
  projectId: string;
  projectName: string;
  domain: string | null;
  /** The one context line: business, and the newest update we actually hold. */
  contextLine: string;
  /** The sentence under the title (§4.2's "one-sentence explanation"). */
  explanation: string;
}

// ─── Score (§5.1's prominent score + applicable bucket cards) ─────────────────

/**
 * One applicable bucket card (§5.1). This is the same stored bucket the client
 * Results read serves — the overview does not recompute anything, so the card
 * and the drilldown cannot disagree.
 */
export interface OverviewBucketCard {
  key: string;
  label: string;
  weight: number;
  state: string;
  stateLabel: string;
  /** null unless measured. The card renders the state, never a substituted 0. */
  value: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  missingReasons: string[];
  /** §5.5 — opens the corresponding Results tab with this period preserved. */
  detailPath: string | null;
  detailQuery: string | null;
  period: { start: string | null; end: string | null };
}

export interface OverviewScorePanel {
  family: string;
  scoreName: string;
  methodologyVersion: number;
  /**
   * §22 D01 is still open, so this is reported on every read rather than
   * presented as settled. A reader must never see an unapproved weighting
   * described as the agreed rule.
   */
  weightsApproved: boolean;
  approvalNote: string;
  /** `complete` | `incomplete` | `none` (no run has been built yet). */
  status: 'complete' | 'incomplete' | 'none';
  statusLabel: string;
  /** §5.1's one prominent number. null whenever the run is incomplete — never a partial sum. */
  total: number | null;
  runId: string | null;
  runAt: string | null;
  evidenceCoverage: number | null;
  coverageMeaning: string;
  /** §5.3 rule 7: a separate object with its own id, shown as "Last complete score — [date]". */
  lastComplete: { id: string; createdAt: string; total: number | null; evidenceCoverage: number } | null;
  lastCompleteIsLatest: boolean;
  /** Plain-English reasons the overall number is missing. */
  missingAreas: string[];
  /** Recorded not-applicable decisions — decisions, not missing data. */
  excludedFromScore: Array<{ key: string; label: string; reason: string | null }>;
  /** §5.5's compatible comparison only: null when a change would mislead. */
  changeInTotal: number | null;
  comparisonNote: string | null;
  /** The applicable bucket cards, in canonical order. */
  buckets: OverviewBucketCard[];
  /** §5.5 — the sheet that explains the buckets and the missing-data rule. */
  howThisScoreWorks: {
    headline: string;
    missingDataRule: string;
    totalRule: string;
    coverageRule: string;
    comparisonRule: string;
    methodologyVersion: number;
    buckets: Array<{ key: string; label: string; weight: number; covers: string[]; excludes: string[] }>;
  };
  /** The live/report distinction (§14.6). */
  liveLabel: string;
  resultsHref: string;
}

// ─── Needs your action (§5.6) ────────────────────────────────────────────────

export interface OverviewActionItem {
  sourceType: string;
  /** Stable source identity — never a synthetic id minted to show a card. */
  sourceId: string;
  title: string;
  reason: string;
  deadline: string | null;
  /** `overdue` | `blocking` | `normal` — the order §5.6 requires, already applied. */
  severity: string;
  destination: string;
  currentVersion: string;
  completionCondition: string;
}

export interface OverviewActionPanel {
  /** At most `limit` items — §5.1's "at most three action cards". */
  items: OverviewActionItem[];
  /** The TRUE total, which may exceed `items.length`. */
  total: number;
  limit: number;
  /** Spelled out so the UI never has to infer §5.6's order from the array. */
  order: string;
  viewAllHref: string;
  /** The sentence shown when there is nothing to do — §4.4's "You're all caught up…". */
  allClearMessage: string;
}

// ─── Upcoming content (§5.1) ─────────────────────────────────────────────────

export interface OverviewUpcomingItem {
  scheduleId: string;
  assetId: string;
  title: string;
  contentTypeLabel: string;
  channelLabel: string;
  state: string;
  stateLabel: string;
  /** The one scheduling truth, so the same instant reads the same everywhere. */
  scheduledForUtc: string;
  plannedLocalDate: string;
  plannedLocalTime: string;
  timezone: string;
  pastDue: boolean;
  pastDueLabel: string | null;
  /** Where the item opens — the calendar, since that is the one calendar. */
  href: string;
}

export interface OverviewUpcomingPanel {
  /** At most `OVERVIEW_UPCOMING_LIMIT` items. */
  items: OverviewUpcomingItem[];
  /** Every placement in the window, so the panel can say "5 of 9". */
  totalInWindow: number;
  window: { from: string; to: string; timezone: string };
  calendarHref: string;
  /** True when the calendar read itself says its page is a prefix of the window. */
  truncated: boolean;
}

// ─── Plan footer (§5.1's "30-day plan: 3 of 5 commitments completed") ─────────

export interface OverviewPlanPanel {
  /** Commitments in the live agreed set. */
  totalCount: number;
  completedCount: number;
  /** Rendered verbatim: "3 of 5 commitments completed". */
  label: string;
  /** Says what the count covers — "5" must never be mistaken for "everything we do". */
  scopeNote: string;
  planHref: string;
}

// ─── Report footer (§5.1's "Latest report: September update") ────────────────

export interface OverviewReportPanel {
  slug: string;
  title: string;
  revision: number;
  releasedAt: string;
  /** §14.6 — the label makes the frozen release explicit: "As released in the September report". */
  releasedLabel: string;
  /**
   * The released score, read from the frozen `ReportRevision.snapshot` and never
   * from `Report.scoreTotal`. It is a different number from the live score on
   * purpose, and the two are labelled separately.
   */
  releasedScoreTotal: number | null;
  releasedScoreBand: string | null;
  /** The frozen Cailyx score family section, when the release froze one. */
  releasedDigitalPerformance: {
    family: string;
    methodologyVersion: number;
    status: string;
    total: number | null;
    evidenceCoverage: number | null;
    measuredBucketCount: number;
    applicableBucketCount: number;
    frozenAt: string | null;
  } | null;
  /** The frozen 30-day plan section, when the release froze one. */
  releasedPlanProgress: { totalCount: number; completedCount: number; label: string } | null;
  href: string;
}

/** Staff-only shortcut that sits below the client-equivalent information (§5.1). */
export interface OverviewTeamAttentionPanel {
  items: OverviewActionItem[];
  total: number;
  limit: number;
  order: string;
  href: string;
}

export interface OverviewSections {
  score: OverviewSection<OverviewScorePanel>;
  actions: OverviewSection<OverviewActionPanel>;
  upcomingContent: OverviewSection<OverviewUpcomingPanel>;
  plan: OverviewSection<OverviewPlanPanel>;
  report: OverviewSection<OverviewReportPanel>;
  /** Present on the operator read only — the client DTO has no such key at all. */
  teamAttention?: OverviewSection<OverviewTeamAttentionPanel>;
}

/** Exact response body of the client overview route. No staff key exists on it. */
export interface ClientOverviewView {
  projectId: string;
  audience: 'client';
  generatedAt: string;
  header: OverviewHeader;
  sections: OverviewSections;
}

/** Exact response body of the staff overview route. */
export interface StaffOverviewView {
  projectId: string;
  audience: 'operator';
  generatedAt: string;
  header: OverviewHeader;
  sections: OverviewSections & { teamAttention: OverviewSection<OverviewTeamAttentionPanel> };
}

export type OverviewView = ClientOverviewView | StaffOverviewView;
