import { api } from '@/lib/api';

/**
 * Overview adapter — the composed project Overview (P15, platform_improvement_
 * plan.md §5.1, §5.5–§5.7) and the four client Results tabs (§3.3).
 *
 * Routes, all served from `backend/src/modules/results/`:
 *
 *   Client   GET /api/portal/projects/:projectId/overview
 *   Client   GET /api/portal/projects/:projectId/results/{website|ai|presence|competitors}
 *   Staff    GET /api/projects/:projectId/overview
 *   Staff    GET /api/projects/:projectId/scores/:runId   (the full calculation)
 *
 * ## One composed read, not a page that fetches five things
 *
 * §5.7 puts the composition on the server: the Overview arrives as one payload
 * whose panels were already assembled, each in its own section envelope. The
 * web therefore cannot invent a sixth way to read the same fact, and a screen
 * cannot accidentally trigger work — every one of these routes is a pure
 * storage read. Loading the Overview never starts an audit, refreshes a paid
 * provider, builds a score or creates a job.
 *
 * ## The section envelope is the §4.5 contract
 *
 * `OverviewSection<T>` always exists and always has the same keys. `status`
 * says whether the source answered (`ok`), answered with nothing (`empty`) or
 * failed (`unavailable`); `reason` is a safe sentence and `reasonCode` a stable
 * code, so a screen chooses its own copy and never parses a message. A failed
 * panel renders as a degraded panel — never as a blank page, and never as the
 * provider exception that caused it (§4.4).
 *
 * ## What is deliberately absent from these types
 *
 * The client payload has no `teamAttention` key at all (not "null when the
 * caller is a client": the key does not exist), so a client screen cannot
 * render staff information by accident — reading `sections.teamAttention` on a
 * client view does not compile. Bucket cards carry `sourceCount`-style counts
 * rather than source ids, run ids appear only where staff already see them, and
 * no field here is a completion target for an action item: opening a card is a
 * navigation, and resolving the underlying approval or request happens on the
 * screen that owns it (§5.6).
 *
 * @module services/overview
 */

// ─── The section envelope (§4.5) ─────────────────────────────────────────────

export type OverviewSectionStatus = 'ok' | 'empty' | 'unavailable';

export type OverviewSectionReasonCode = 'no-data-yet' | 'not-connected' | 'not-shared' | 'read-failed' | null;

export interface OverviewSection<T> {
  status: OverviewSectionStatus;
  /** Non-null whenever the source answered — including for `empty`. */
  data: T | null;
  /** A safe, action-oriented sentence. Present whenever `status !== 'ok'`. */
  reason: string | null;
  reasonCode: OverviewSectionReasonCode;
}

// ─── Header (§4.2) ───────────────────────────────────────────────────────────

export interface OverviewHeader {
  projectId: string;
  projectName: string;
  domain: string | null;
  contextLine: string;
  explanation: string;
}

// ─── Score (§5.1, §5.3, §5.5) ────────────────────────────────────────────────

export interface OverviewBucketCard {
  key: string;
  label: string;
  weight: number;
  state: string;
  stateLabel: string;
  /** null unless measured — the card renders the state, never a substituted 0. */
  value: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  missingReasons: string[];
  /** The stored detail target, relative to the project. null when unrecorded. */
  detailPath: string | null;
  detailQuery: string | null;
  period: { start: string | null; end: string | null };
}

export interface OverviewScorePanel {
  family: string;
  scoreName: string;
  methodologyVersion: number;
  /**
   * §22 D01 is open: the weighting has not been signed off. The panel reports
   * that rather than presenting the weights as the agreed rule.
   */
  weightsApproved: boolean;
  approvalNote: string;
  status: 'complete' | 'incomplete' | 'none';
  statusLabel: string;
  /** §5.1's one prominent number. null whenever the run is incomplete. */
  total: number | null;
  runId: string | null;
  runAt: string | null;
  evidenceCoverage: number | null;
  coverageMeaning: string;
  /** §5.3 rule 7's separate object: "Last complete score — [date]". */
  lastComplete: { id: string; createdAt: string; total: number | null; evidenceCoverage: number } | null;
  lastCompleteIsLatest: boolean;
  missingAreas: string[];
  /** Recorded not-applicable decisions — decisions, not missing data. */
  excludedFromScore: Array<{ key: string; label: string; reason: string | null }>;
  changeInTotal: number | null;
  comparisonNote: string | null;
  /** The applicable bucket cards, in canonical order. */
  buckets: OverviewBucketCard[];
  howThisScoreWorks: {
    headline: string;
    missingDataRule: string;
    totalRule: string;
    coverageRule: string;
    comparisonRule: string;
    methodologyVersion: number;
    buckets: Array<{ key: string; label: string; weight: number; covers: string[]; excludes: string[] }>;
  };
  /** §14.6 — "Live score, updated 2026-09-14". Never a released figure. */
  liveLabel: string;
  resultsHref: string;
}

// ─── Needs your action (§5.6) ────────────────────────────────────────────────

export interface OverviewActionItem {
  sourceType: string;
  sourceId: string;
  title: string;
  reason: string;
  deadline: string | null;
  /** `overdue` | `blocking` | `normal` — the order §5.6 requires, already applied. */
  severity: string;
  /** Where opening the item goes. Never a route that completes it. */
  destination: string;
  currentVersion: string;
  completionCondition: string;
}

export interface OverviewActionPanel {
  items: OverviewActionItem[];
  /** The TRUE total, which may exceed `items.length`. */
  total: number;
  limit: number;
  order: string;
  viewAllHref: string;
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
  href: string;
}

export interface OverviewUpcomingPanel {
  items: OverviewUpcomingItem[];
  totalInWindow: number;
  window: { from: string; to: string; timezone: string };
  calendarHref: string;
  truncated: boolean;
}

// ─── Footer: plan + latest report (§5.1) ─────────────────────────────────────

export interface OverviewPlanPanel {
  totalCount: number;
  completedCount: number;
  /** Rendered verbatim: "3 of 5 commitments completed". */
  label: string;
  /** Says what the count covers, so "5" is not read as "everything we do". */
  scopeNote: string;
  planHref: string;
}

export interface OverviewReportPanel {
  slug: string;
  title: string;
  revision: number;
  releasedAt: string;
  /** §14.6 — "As released in the September report". */
  releasedLabel: string;
  /**
   * Read from the frozen `ReportRevision.snapshot`. A different number from the
   * live score on purpose, and labelled as such.
   */
  releasedScoreTotal: number | null;
  releasedScoreBand: string | null;
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
  releasedPlanProgress: { totalCount: number; completedCount: number; label: string } | null;
  href: string;
}

/** Staff-only shortcut, below the client-equivalent information (§5.1). */
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
}

/** The client body has no `teamAttention` key — not a null one. */
export interface PortalOverviewView {
  projectId: string;
  audience: 'client';
  generatedAt: string;
  header: OverviewHeader;
  sections: OverviewSections;
}

export interface StaffOverviewView {
  projectId: string;
  audience: 'operator';
  generatedAt: string;
  header: OverviewHeader;
  sections: OverviewSections & { teamAttention: OverviewSection<OverviewTeamAttentionPanel> };
}

/** §5.1's caps, mirrored so a screen can state them without inventing a number. */
export const OVERVIEW_ACTION_LIMIT = 3;
export const OVERVIEW_UPCOMING_LIMIT = 5;

// ─── The four client Results tabs (§3.3) ─────────────────────────────────────

export type PortalResultsTab = 'website' | 'ai' | 'presence' | 'competitors';

export interface WebsiteTabData {
  health: { state: string; label: string; issueCount: number };
  google: {
    clicks: number | null;
    impressions: number | null;
    position: number | null;
    sessions: number | null;
    clicksWindow: { startDate: string; endDate: string; timezoneNote: string } | null;
    sessionsWindow: { startDate: string; endDate: string; timezoneNote: string } | null;
  };
  windows: {
    aligned: boolean;
    note: string;
    coarserComparison: boolean;
    gsc: { startDate: string; endDate: string; timezoneNote: string } | null;
    ga: { startDate: string; endDate: string; timezoneNote: string } | null;
  };
  insights: Array<{
    severity: 'low' | 'medium' | 'high';
    message: string;
    limitations: string;
    actionTarget: string;
    /** How many sources back it — a count, not the source ids. */
    sourceCount: number;
    crossSource: boolean;
  }>;
  importantPages: Array<{
    title: string | null;
    canonicalUrl: string;
    health: string;
    healthLabel: string;
    clicks: number | null;
    organicSessions: number | null;
    nextAction: string;
  }>;
  sourceAvailability: {
    technicalCheck: { available: boolean; lastCheckedAt: string | null; label: string };
    searchConsole: {
      connected: boolean;
      lastSyncAt: string | null;
      expired: boolean;
      label: string;
      retainedSnapshot: { windowStart: string; windowEnd: string; fetchedAt: string } | null;
      addsWhat: string;
    };
    analytics: {
      connected: boolean;
      lastSyncAt: string | null;
      expired: boolean;
      label: string;
      retainedSnapshot: { windowStart: string; windowEnd: string; fetchedAt: string } | null;
      addsWhat: string;
    };
  };
  joinLimitation: { querySideLabel: string; sessionSideLabel: string; statement: string };
  connectGuidance: string[];
  hasCheck: boolean;
}

export interface AiVisibilityTabData {
  headline: string;
  status: string;
  statusLabel: string;
  generatedAt: string | null;
  period: { startedAt: string | null; finishedAt: string | null };
  markets: string[];
  /** Appeared and recommended stay separate counts — never conflated (§8.2). */
  appeared: { count: number; of: number; rateValid: boolean };
  recommended: { count: number; of: number; rateValid: boolean } | null;
  questionsChecked: number;
  totalQuestions: number;
  headlines: string[];
  /** Named surfaces/markets that failed or were gated — never silently dropped. */
  disclosedFailures: Array<{ label: string; market: string | null; reason: string }>;
  surfaces: Array<{ label: string; status: string; statusLabel: string; market: string | null }>;
  details: { questionSetVersion: number; tier: string; runCount: number };
  hasAudit: boolean;
}

export interface OnlinePresenceTabData {
  domain: string;
  accounts: Array<{
    platform: string;
    label: string;
    group: string;
    url: string;
    state: string;
    statusLabel: string;
  }>;
  relevantNotFound: Array<{ platform: string; label: string; group: string }>;
  counts: { total: number; needsConfirmation: number };
  hasAccounts: boolean;
}

export interface CompetitorsTabDiffLine {
  key: string;
  /** The competitors that have this and the client does not. */
  competitors: string[];
  client: boolean;
}

export interface CompetitorsTabData {
  domain: string;
  generatedAt: string;
  note: string;
  competitors: Array<{
    name: string;
    domain: string | null;
    aeoStatus: string;
    aeoStatusLabel: string;
    serpStatus: string;
    serpStatusLabel: string;
    serp: { occurrences: number; bestRank: number | null; sampleKeyword: string | null; capturedAt: string | null } | null;
    presencePlatforms: string[];
    seoScore: number | null;
    seoIssues: string[];
    reviews: Array<{ label: string; url: string; found: boolean; rating: number | null; ratingCount: number | null; scale: number | null }>;
  }>;
  diffs: {
    presence: CompetitorsTabDiff;
    tech: CompetitorsTabDiff;
    schema: CompetitorsTabDiff;
  };
  reviews: { client: Array<{ label: string; url: string; found: boolean; rating: number | null; ratingCount: number | null; scale: number | null }>; note: string };
  hasCompetitors: boolean;
}

export interface CompetitorsTabDiff {
  client: string[];
  /** Kept, not hidden: the same comparison read in the client's favour. */
  clientOnly: CompetitorsTabDiffLine[];
  competitorsOnly: CompetitorsTabDiffLine[];
  shared: CompetitorsTabDiffLine[];
}

export interface PortalTabData {
  website: WebsiteTabData;
  ai: AiVisibilityTabData;
  presence: OnlinePresenceTabData;
  competitors: CompetitorsTabData;
}

/**
 * §3.3's tab list, with the staff equivalent each one mirrors (§5.5's
 * "staff can inspect the full calculation separately" — here, the staff
 * screen that shows the same domain read with its staff-only halves).
 */
export const RESULTS_TABS: Array<{
  key: PortalResultsTab;
  label: string;
  /** One line saying what the tab answers, shown under the tab strip. */
  question: string;
  staffHref: (projectId: string) => string;
}> = [
  {
    key: 'website',
    label: 'Website',
    question: 'Is your site healthy, and what is it bringing in from search?',
    staffHref: (projectId) => `/projects/${projectId}/research/website`,
  },
  {
    key: 'ai',
    label: 'AI visibility',
    question: 'Where do AI answer engines mention you, and where do they not?',
    staffHref: (projectId) => `/projects/${projectId}/research/ai`,
  },
  {
    key: 'presence',
    label: 'Online presence',
    question: 'Which profiles and listings do we know are yours?',
    staffHref: (projectId) => `/projects/${projectId}/research/presence`,
  },
  {
    key: 'competitors',
    label: 'Competitors',
    question: 'How do you compare with the businesses we track alongside you?',
    staffHref: (projectId) => `/projects/${projectId}/research/competitors`,
  },
];

export function isPortalResultsTab(value: string): value is PortalResultsTab {
  return RESULTS_TABS.some((tab) => tab.key === value);
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

/** The client's own composed Overview (§5.1). */
export async function getPortalOverview(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<PortalOverviewView>(`/portal/projects/${encodeURIComponent(projectId)}/overview`, options);
}

/** The staff read of the same page, plus the "Team attention" shortcut. */
export async function getStaffOverview(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<StaffOverviewView>(`/projects/${encodeURIComponent(projectId)}/overview`, options);
}

/**
 * One §3.3 Results tab. The tab is the section: a failed domain read degrades
 * that tab and leaves the other three intact (§4.5).
 */
export async function getPortalResultsTab<T extends PortalResultsTab>(
  projectId: string,
  tab: T,
  options?: { signal?: AbortSignal },
): Promise<OverviewSection<PortalTabData[T]>> {
  return api.get<OverviewSection<PortalTabData[T]>>(
    `/portal/projects/${encodeURIComponent(projectId)}/results/${tab}`,
    options,
  );
}

/**
 * Staff-only: the full stored calculation behind one score run — every bucket
 * with its weight, contribution, threshold, samples and sources.
 *
 * This is the "separately" half of §5.5: the client gets the plain-English
 * sheet, staff get the arithmetic, and neither is derived from the other.
 * Reading it computes nothing; it is the stored run.
 */
export async function getStaffScoreRun(projectId: string, runId: string, options?: { signal?: AbortSignal }) {
  return api.get<StaffScoreRunView>(
    `/projects/${encodeURIComponent(projectId)}/scores/${encodeURIComponent(runId)}`,
    options,
  );
}

export interface StaffScoreRunBucket {
  key: string;
  label: string;
  weight: number;
  applicability: string;
  applicabilityReason?: string | null;
  state: string;
  value: number | null;
  weightedPoints: number;
  effectiveWeight: number;
  contribution: number;
  windowStart: string | null;
  windowEnd: string | null;
  metricVersion: string;
  missingReasons: string[];
  notes: string[];
  sources?: Array<{ type?: string; id?: string; label?: string; observedAt?: string | null }>;
}

export interface StaffScoreRunView {
  id: string;
  projectId: string;
  family: string;
  status: string;
  methodology: { version: number; label?: string; weightsApproved?: boolean; approvalNote?: string | null };
  total: number | null;
  evidenceCoverage: number;
  createdAt: string;
  buckets: StaffScoreRunBucket[];
}

// ─── §5.5 drilldown ──────────────────────────────────────────────────────────

/**
 * Where a bucket card sends a reader.
 *
 * The stored target (`OverviewBucketCard.detailPath`) is a P14 methodology
 * value, relative to the project, recorded per bucket: `/results/website`,
 * `/results/ai-visibility`, `/results/online-presence`, `/results/content`.
 * The client's Results screen has four tabs, so the mapping to a tab lives
 * here, in one table, rather than being inferred from the string at each
 * call site.
 *
 * Two behaviours are deliberate:
 *
 *  - **The period travels with the link.** The card describes a specific
 *    measured window, so the reader lands on that window, not on today's
 *    default. §5.5's drilldown is only honest if the two describe the same
 *    thing.
 *  - **An unrecognised target produces no link.** A bucket whose area has no
 *    page yet renders "no detail page is recorded for this area" instead of a
 *    link to a page that is about something else. The same rule the backend
 *    applies to a null `detailPath`, applied to an unknown one.
 */
export function bucketDetailHref(
  projectId: string,
  bucket: Pick<OverviewBucketCard, 'detailPath' | 'detailQuery' | 'period'>,
  audience: 'client' | 'operator',
): string | null {
  const destination = bucket.detailPath ? BUCKET_DETAIL_DESTINATIONS[bucket.detailPath] : undefined;
  if (!destination) return null;

  const params = new URLSearchParams();
  // `from`/`to` are the period the card was measured over.
  if (bucket.period.start) params.set('from', bucket.period.start.slice(0, 10));
  if (bucket.period.end) params.set('to', bucket.period.end.slice(0, 10));
  // The bucket's own stored sub-view (`tab=google`, `tab=social`) becomes the
  // fragment, so the reader lands on the block the bucket is about rather than
  // on the top of the tab. A sub-view with no matching block is harmless: the
  // tab still opens on the right period.
  const subView = subViewFromQuery(bucket.detailQuery);

  const base =
    destination.kind === 'tab'
      ? audience === 'client'
        ? `/client/projects/${projectId}/results`
        : staffTabHref(projectId, destination.tab)
      : audience === 'client'
        ? `/client/projects/${projectId}/${destination.area}`
        : `/projects/${projectId}/${destination.area}`;

  if (destination.kind === 'tab' && audience === 'client') {
    params.set('view', destination.tab);
  }

  const query = params.toString();
  const hash = subView ? `#${subView}` : '';
  return query ? `${base}?${query}${hash}` : `${base}${hash}`;
}

type BucketDestination =
  | { kind: 'tab'; tab: PortalResultsTab }
  /** Areas the Results tabs do not cover, and which live on their own screen. */
  | { kind: 'area'; area: 'calendar' };

const BUCKET_DETAIL_DESTINATIONS: Record<string, BucketDestination> = {
  '/results/website': { kind: 'tab', tab: 'website' },
  '/results/ai-visibility': { kind: 'tab', tab: 'ai' },
  '/results/online-presence': { kind: 'tab', tab: 'presence' },
  '/results/competitors': { kind: 'tab', tab: 'competitors' },
  // The content bucket has no Results tab: content lives on the calendar, and
  // sending a reader to a rival number for it would be the second read path
  // this phase forbids.
  '/results/content': { kind: 'area', area: 'calendar' },
};

/** The staff equivalent of a client Results tab (§5.5). */
export function staffTabHref(projectId: string, tab: PortalResultsTab): string {
  return RESULTS_TABS.find((entry) => entry.key === tab)?.staffHref(projectId) ?? `/projects/${projectId}/research`;
}

function subViewFromQuery(query: string | null): string | null {
  if (!query) return null;
  const value = new URLSearchParams(query).get('tab');
  return value && value.length > 0 ? value : null;
}
