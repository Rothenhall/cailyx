/**
 * Google integration — shared types.
 *
 * @module google/google.types
 */

export type GoogleService = 'search-console' | 'analytics';

export const GOOGLE_SERVICES: GoogleService[] = ['search-console', 'analytics'];

/** OAuth scopes requested per service (plus `openid email` always). */
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  'search-console': ['https://www.googleapis.com/auth/webmasters.readonly'],
  analytics: [
    'https://www.googleapis.com/auth/analytics.readonly',
    // account/property listing for the resource picker
    'https://www.googleapis.com/auth/analytics.edit',
  ],
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
