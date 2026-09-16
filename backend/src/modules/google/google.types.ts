/**
 * Google integration — shared types.
 *
 * @module google/google.types
 */

export type GoogleService = 'search-console' | 'analytics';

export const GOOGLE_SERVICES: GoogleService[] = ['search-console', 'analytics'];

/**
 * Search Console write scope — the only scope that can call
 * `sitemaps.submit` (`PUT /sites/{site}/sitemaps/{feedpath}`).
 *
 * G19/D17: Cailyx *does* write Search Console — `SeoAuditService.submitSitemaps`
 * re-submits the property's sitemaps, which is the one live action the SEO
 * audit takes. `webmasters.readonly` cannot perform that PUT, so requesting
 * only the read scope made the endpoint a guaranteed failure. `webmasters` is
 * a superset of `webmasters.readonly` and covers the reads this module already
 * does, so one scope covers both jobs — no incremental-authorization dance.
 */
export const GSC_SCOPE_READWRITE = 'https://www.googleapis.com/auth/webmasters';

/**
 * Analytics read scope. Read-only is sufficient for everything this module
 * calls: `accountSummaries.list` (the property picker) accepts either
 * `analytics.readonly` or `analytics.edit`, and the Data API `runReport` is a
 * read. Nothing here writes to Google Analytics, so `analytics.edit` — which
 * the consent screen renders as "see and download your Analytics data" plus
 * edit rights, and which also unlocks the whole Admin API write surface — is
 * not requested. G19/D17: asking for a write scope we never use overstates
 * what the operator is consenting to.
 */
export const GA_SCOPE_READONLY = 'https://www.googleapis.com/auth/analytics.readonly';

/**
 * OAuth scopes requested per service (plus `openid email` always).
 *
 * These are the exact strings put on the consent screen — the connection view
 * returns whatever Google granted, so this table is the contract for "what is
 * the operator agreeing to".
 */
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  'search-console': [GSC_SCOPE_READWRITE],
  analytics: [GA_SCOPE_READONLY],
};

/** Token endpoint response (the fields we keep). */
export interface GoogleTokenSet {
  accessToken: string;
  /** Absent on a refresh unless Google decides to rotate it. */
  refreshToken?: string;
  expiresInSec: number;
  scope: string;
  /** id_token email, when `openid email` was granted. */
  email?: string;
}

/** What `GET /integrations/google/connections` returns — never any token. */
export interface GoogleConnectionView {
  service: GoogleService;
  connected: boolean;
  googleEmail: string | null;
  scope: string;
  connectedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  lastError: string | null;
}

/** A GSC site or GA4 property the connected account can read. */
export interface GoogleResourceOption {
  id: string; // GSC siteUrl, or "properties/123456789"
  label: string;
  detail?: string;
}

export interface GoogleResourcesView {
  service: GoogleService;
  projectId: string;
  connected: boolean;
  options: GoogleResourceOption[];
  selected: { resourceId: string; resourceLabel: string | null } | null;
}

/* ── data summaries ─────────────────────────────────────────────────────── */

export interface DateWindow {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  days: number;
}

export interface SearchConsoleSummary {
  range: DateWindow;
  site: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
  topPages: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
}

export interface AnalyticsSummary {
  range: DateWindow;
  property: string;
  totals: {
    sessions: number;
    totalUsers: number;
    screenPageViews: number;
    engagementRate: number;
    averageSessionDuration: number;
  };
  channels: Array<{ key: string; sessions: number; totalUsers: number }>;
  topPages: Array<{ key: string; screenPageViews: number; sessions: number }>;
}
