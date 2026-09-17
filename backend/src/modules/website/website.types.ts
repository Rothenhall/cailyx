/**
 * Website (P12) — unified types: page identity, joined page facts, insights.
 *
 * @module website/website.types
 */

export type HealthState = 'healthy' | 'needs-attention' | 'inaccessible' | 'unknown';

export interface SourceAvailabilityEntry {
  connected: boolean;
  lastSyncAt: string | null;
  expired: boolean;
  /** Plain-English state. When expired/reconnecting this names the date of the retained snapshot (§7.6). */
  label: string;
  /**
   * §7.6: on expiry the last *authorized* snapshot is retained and served,
   * labeled with its own date. Null when nothing is retained.
   */
  retainedSnapshot: { windowStart: string; windowEnd: string; fetchedAt: string } | null;
  /** What connecting this source would add — shown when it is not connected (§7.6). */
  addsWhat: string;
}

export interface SourceAvailability {
  /** Public/technical checks are always available, even with no Google connected (§7.6). */
  technicalCheck: { available: boolean; lastCheckedAt: string | null; label: string };
  searchConsole: SourceAvailabilityEntry;
  analytics: SourceAvailabilityEntry;
}

/**
 * §7.4: GSC daily data uses Pacific dates, GA data uses the property
 * timezone. When the two windows cannot be aligned exactly, the difference is
 * disclosed here and a coarser comparison is used — the dates are never
 * relabeled as equal.
 */
export interface WindowAlignment {
  /** true only when both extracts cover the identical ISO range. */
  aligned: boolean;
  /** Human-readable disclosure of both clocks and the resulting comparison scope. */
  note: string;
  /** true when the comparison deliberately falls back to a coarser (whole-window) scope. */
  coarserComparison: boolean;
  gsc: { startDate: string; endDate: string; timezoneNote: string } | null;
  ga: { startDate: string; endDate: string; timezoneNote: string } | null;
}

/**
 * §7.3/§7.4: the scope a GSC fact extract actually covers, plus its own
 * completeness. `complete === false` means the API's own pagination indicates
 * more rows exist than were fetched — the extract is not a total.
 */
export interface FactScope {
  countries: string[];
  devices: string[];
  /** false when the source extract hit its own row limit — more rows may exist. */
  complete: boolean;
}

/** Where a page's visitor figures stand relative to the session grain. */
export interface VisitorScope {
  /** false when the GA report hit its own row limit. */
  complete: boolean;
}

/**
 * §7.4's no-fabrication statement, carried in the payload rather than left to
 * the UI to remember: the two tables are related aggregate evidence, not a
 * per-query-to-per-session link.
 */
export interface JoinLimitation {
  /** "Queries leading to this page" — GSC aggregate, at page grain. */
  querySideLabel: string;
  /** "Visitors landing on this page" — GA aggregate, at page grain. */
  sessionSideLabel: string;
  /** The limitation, stated in full. */
  statement: string;
}

export interface JoinedPageFacts {
  pageIdentityId: string;
  canonicalUrl: string;
  title: string | null;
  health: HealthState;
  issueCount: number;
  /**
   * GSC facts aggregated to page grain only — never multiplied by query-row
   * count. `available: false` means the whole block is absent, not zero.
   */
  search: {
    available: boolean;
    clicks: number;
    impressions: number;
    ctr: number;
    /** Impression-weighted average position across this page's own query rows. */
    position: number;
    window: { startDate: string; endDate: string; timezoneNote: string } | null;
    scope: FactScope | null;
    topQueries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  };
  /**
   * GA facts aggregated to page grain only — a separate source and a separate
   * unit from `search`, never combined arithmetically. These are *landing*
   * sessions: the session entered on this page.
   */
  visitors: {
    available: boolean;
    sessions: number;
    totalUsers: number;
    engagedSessions: number;
    /** Share of this page's landing sessions that were engaged, 0-1. Null when no sessions. */
    engagementRate: number | null;
    window: { startDate: string; endDate: string; timezoneNote: string } | null;
    scope: VisitorScope | null;
    bySource: Array<{ source: string; sessions: number }>;
  };
  contentUpdatedAt: string | null;
  /** Latest page-analysis structure score for this page, if one has run. Null is "not analysed", never 0. */
  contentStructureScore: number | null;
  nextAction: string;
}

/** One dated, observed change on a page — evidence, never a causal claim (§7.2 "Changes"). */
export interface WebsitePageChange {
  /** ISO instant of the observation. */
  date: string;
  kind: 'technical-check' | 'technical-fix' | 'content-analysis' | 'content-revision' | 'refresh-shipped';
  description: string;
  sourceId: string;
  /**
   * Always false. §7.2/§7.5: the presence of a change and a later change in
   * traffic is correlational; nothing here asserts the change caused it.
   */
  causal: false;
}

export interface RefreshRecommendation {
  recommended: boolean;
  /** Why, in plain English. Null when nothing indicates a refresh is due. */
  reason: string | null;
  /** The score/age inputs the recommendation rests on, for after-the-fact audit. */
  evidence: Record<string, unknown>;
}

export interface WebsitePageDetail {
  identity: { id: string; canonicalUrl: string; sourceUrls: string[] };
  facts: JoinedPageFacts | null;
  /** Existing page-analysis capability, preserved: newest first, every run, with its source URL. */
  content: PageAnalysisRowLike[];
  refreshRecommendation: RefreshRecommendation;
  /** The SleeperPage refresh record for this URL, if one has been started. */
  linkedRefresh: {
    id: string;
    url: string;
    status: string;
    trafficDeclinePct: number | null;
    refreshedAt: string | null;
    createdAt: string;
  } | null;
  /** Cailyx content whose published address is this page. */
  linkedContent: Array<{ id: string; title: string; assetType: string; status: string; url: string | null }>;
  changes: WebsitePageChange[];
  joinLimitation: JoinLimitation;
}

/**
 * One stored page-analysis run, as returned to the page detail. Mirrors the
 * `PageAnalysis` columns the standalone screen showed — the capability and its
 * run history move with it (R33), nothing is dropped in the move.
 */
export interface PageAnalysisRowLike {
  id: string;
  /** The exact source URL this run was taken from. */
  url: string;
  title: string | null;
  wordCount: number;
  blufScore: number;
  questionH2Score: number;
  formatScore: number;
  claimsScore: number;
  structureScore: number;
  status: string;
  fetchedAt: string | null;
  createdAt: string;
}

/** One versioned, deterministic insight instance (§7.5). */
export interface WebsiteInsight {
  ruleId: string;
  ruleVersion: number;
  severity: 'low' | 'medium' | 'high';
  message: string;
  limitations: string;
  actionTarget: string;
  sourceIds: string[];
  pageIdentityId: string | null;
  /**
   * True when the rule's evidence spans more than one source extract (§7.1's
   * "cross-source insights" are surfaced first; single-source observations
   * still appear, they just sort below the cross-source ones).
   */
  crossSource: boolean;
  facts: Record<string, unknown>;
}

export interface WebsiteOverview {
  projectId: string;
  health: { state: HealthState; issueCount: number };
  google: {
    clicks: number | null;
    impressions: number | null;
    /** Average position across the pages with search data, weighted by impressions. Null when no search data. */
    position: number | null;
    clicksWindow: { startDate: string; endDate: string; timezoneNote: string } | null;
    sessions: number | null;
    sessionsWindow: { startDate: string; endDate: string; timezoneNote: string } | null;
  };
  /** §7.4: how the two windows relate, and the coarser comparison used when they cannot align. */
  windows: WindowAlignment;
  insights: WebsiteInsight[];
  importantPages: Array<{
    pageIdentityId: string;
    title: string | null;
    canonicalUrl: string;
    health: HealthState;
    clicks: number | null;
    organicSessions: number | null;
    nextAction: string;
  }>;
  sourceAvailability: SourceAvailability;
  /** §7.4's no-fabrication statement — the aggregate-evidence limitation, stated once for the screen. */
  joinLimitation: JoinLimitation;
  /** §7.6: what connecting a missing Google source would add, in plain English. */
  connectGuidance: string[];
  /** Staff-only: where Check history and Technical details live. Never first-level client navigation (§7.1). */
  staffPanels: { latestCheckId: string | null; checkHistoryHref: string; technicalDetailsHref: string };
}
