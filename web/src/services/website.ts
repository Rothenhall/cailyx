/**
 * Website (P12) — client for the unified overview/pages/page-detail/sync
 * routes. Every read here is a GET over stored data; `syncGoogleData` is the
 * only call that reaches Google, and it is never invoked on page load.
 *
 * @module services/website
 */

import { api } from '@/lib/api';

export type HealthState = 'healthy' | 'needs-attention' | 'inaccessible' | 'unknown';

export interface FactWindow {
  startDate: string;
  endDate: string;
  timezoneNote: string;
}

/** §7.3/§7.4: what a fact extract actually covers, plus its own completeness. */
export interface FactScope {
  countries: string[];
  devices: string[];
  /** false when the source hit its own row limit — the extract is not a total. */
  complete: boolean;
}

export interface VisitorScope {
  complete: boolean;
}

/** §7.4: how the two windows relate. Disclosed, never relabeled as equal. */
export interface WindowAlignment {
  aligned: boolean;
  note: string;
  coarserComparison: boolean;
  gsc: FactWindow | null;
  ga: FactWindow | null;
}

/** §7.4's no-fabrication statement, carried in the payload. */
export interface JoinLimitation {
  querySideLabel: string;
  sessionSideLabel: string;
  statement: string;
}

export interface SourceAvailabilityEntry {
  connected: boolean;
  lastSyncAt: string | null;
  expired: boolean;
  label: string;
  /** §7.6: the last authorized snapshot retained on expiry, labeled with its own date. */
  retainedSnapshot: { windowStart: string; windowEnd: string; fetchedAt: string } | null;
  addsWhat: string;
}

export interface SourceAvailability {
  technicalCheck: { available: boolean; lastCheckedAt: string | null; label: string };
  searchConsole: SourceAvailabilityEntry;
  analytics: SourceAvailabilityEntry;
}

export interface WebsiteInsight {
  ruleId: string;
  ruleVersion: number;
  severity: 'low' | 'medium' | 'high';
  message: string;
  limitations: string;
  actionTarget: string;
  sourceIds: string[];
  pageIdentityId: string | null;
  /** Evidence spans more than one source extract — surfaced first (§7.1). */
  crossSource: boolean;
  facts: Record<string, unknown>;
}

export interface WebsiteOverview {
  projectId: string;
  health: { state: HealthState; issueCount: number };
  google: {
    clicks: number | null;
    impressions: number | null;
    position: number | null;
    clicksWindow: FactWindow | null;
    sessions: number | null;
    sessionsWindow: FactWindow | null;
  };
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
  joinLimitation: JoinLimitation;
  connectGuidance: string[];
  staffPanels: { latestCheckId: string | null; checkHistoryHref: string; technicalDetailsHref: string };
}

export interface JoinedPageFacts {
  pageIdentityId: string;
  canonicalUrl: string;
  title: string | null;
  health: HealthState;
  issueCount: number;
  search: {
    available: boolean;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    window: FactWindow | null;
    scope: FactScope | null;
    topQueries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  };
  visitors: {
    available: boolean;
    sessions: number;
    totalUsers: number;
    engagedSessions: number;
    engagementRate: number | null;
    window: FactWindow | null;
    scope: VisitorScope | null;
    bySource: Array<{ source: string; sessions: number }>;
  };
  contentUpdatedAt: string | null;
  contentStructureScore: number | null;
  nextAction: string;
}

/** One dated, observed change on a page — evidence, never a causal claim (§7.2 "Changes"). */
export interface WebsitePageChange {
  date: string;
  kind: 'technical-check' | 'technical-fix' | 'content-analysis' | 'content-revision' | 'refresh-shipped';
  description: string;
  sourceId: string;
  /** Always false — nothing here asserts the change caused a later traffic change. */
  causal: false;
}

export interface PageAnalysisRow {
  id: string;
  /** The exact source URL this run was taken from — provenance survives the move (R33). */
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

export interface WebsitePageDetail {
  identity: { id: string; canonicalUrl: string; sourceUrls: string[] };
  facts: JoinedPageFacts | null;
  content: PageAnalysisRow[];
  refreshRecommendation: { recommended: boolean; reason: string | null; evidence: Record<string, unknown> };
  linkedRefresh: {
    id: string;
    url: string;
    status: string;
    trafficDeclinePct: number | null;
    refreshedAt: string | null;
    createdAt: string;
  } | null;
  linkedContent: Array<{ id: string; title: string; assetType: string; status: string; url: string | null }>;
  changes: WebsitePageChange[];
  joinLimitation: JoinLimitation;
}

export async function getWebsiteOverview(projectId: string, options?: { signal?: AbortSignal }): Promise<WebsiteOverview> {
  return api.get<WebsiteOverview>(`/projects/${projectId}/website/overview`, options);
}

export async function getWebsitePages(projectId: string, options?: { signal?: AbortSignal }): Promise<JoinedPageFacts[]> {
  return api.get<JoinedPageFacts[]>(`/projects/${projectId}/website/pages`, options);
}

export async function getWebsitePageDetail(
  projectId: string,
  pageId: string,
  options?: { signal?: AbortSignal },
): Promise<WebsitePageDetail> {
  return api.get<WebsitePageDetail>(`/projects/${projectId}/website/pages/${pageId}`, options);
}

/**
 * §7.2 "Update this page" — starts or opens the real refresh workflow
 * (sleeper-refresh / SOP-10) for this page and returns the page-detail route
 * so the caller lands back in the same page context. Idempotent server-side.
 */
export interface PageRefreshStart {
  created: boolean;
  refresh: { id: string; url: string; status: string; createdAt: string; refreshedAt: string | null };
  refreshWorkflowHref: string;
  pageDetailHref: string;
}

export async function startWebsitePageRefresh(projectId: string, pageId: string): Promise<PageRefreshStart> {
  return api.post<PageRefreshStart>(`/projects/${projectId}/website/pages/${pageId}/refresh`);
}

/** The one call that reaches Google. Never invoked from a page-load effect. */
export async function syncWebsiteGoogleData(projectId: string, days = 28): Promise<{ gsc: boolean; ga: boolean }> {
  return api.post<{ gsc: boolean; ga: boolean }>(`/projects/${projectId}/website/sync-google`, undefined, { query: { days } });
}
