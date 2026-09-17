/**
 * Client-safe read models for the four Results tabs (platform_improvement_plan.md
 * §3.3's "Website / AI visibility / Online presence / Competitors", phase P15).
 *
 * Each tab is a **projection of the module that already owns the domain read**,
 * not a second read path: `ResultsTabsService` injects the exported services
 * (`WebsiteService.overview`, `AeoVisibilityService.summary`,
 * `CompetitorsService.gap`) and narrows their output for a client. Nothing in
 * here recalculates a number, and nothing here re-queries a table the owning
 * module already reads.
 *
 * The narrowing is the §4.6 boundary, applied per field:
 *
 *  - **Kept**: dates, counts checked, what was missing, why a comparison is
 *    unavailable, and every plain-English disclosure the owning module wrote.
 *  - **Dropped**: record handles (`pageIdentityId`, `auditId`, `snapshotId`,
 *    `techScanId`), provenance/version vectors, rule ids, and provider
 *    exception text (§4.4 — an error becomes a stable status, never a message).
 *  - **Rewritten**: storage state strings become labels, so no screen prints
 *    `needs-attention` or `skipped` at a reader (§4.3).
 *
 * @module results/results-tabs.types
 */

/** §4.3's vocabulary: a storage state never reaches a screen as itself. */
export const HEALTH_STATE_LABEL: Record<string, string> = {
  healthy: 'Looking good',
  'needs-attention': 'Needs attention',
  inaccessible: 'We could not check it',
  unknown: 'Not checked yet',
};

export const SURFACE_STATUS_LABEL: Record<string, string> = {
  completed: 'Checked',
  failed: 'Could not be checked',
  gated: 'Not available to us',
  skipped: 'Not checked',
  running: 'Being checked',
  pending: 'Waiting to be checked',
};

export const PRESENCE_STATUS_LABEL: Record<string, string> = {
  present: 'Found in our checks',
  absent: 'Not found in our checks',
  unknown: 'Not checked yet',
};

export function stateLabel(map: Record<string, string>, value: string): string {
  return map[value] ?? 'Not checked yet';
}

// ─── Website ──────────────────────────────────────────────────────────────────

export interface WebsiteTabInsight {
  severity: 'low' | 'medium' | 'high';
  message: string;
  /** What this finding does not prove — the owning module's own limitation text. */
  limitations: string;
  /** Where to look, in the owning module's own words. */
  actionTarget: string;
  /** How many sources back it — a count, not the source ids. */
  sourceCount: number;
  /** Cross-source findings are surfaced first (§7.1). */
  crossSource: boolean;
}

export interface WebsiteTabPage {
  title: string | null;
  canonicalUrl: string;
  health: string;
  healthLabel: string;
  clicks: number | null;
  organicSessions: number | null;
  nextAction: string;
}

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
  /** §7.4 — how the two windows relate. Passed through: it is already a disclosure. */
  windows: {
    aligned: boolean;
    note: string;
    coarserComparison: boolean;
    gsc: { startDate: string; endDate: string; timezoneNote: string } | null;
    ga: { startDate: string; endDate: string; timezoneNote: string } | null;
  };
  insights: WebsiteTabInsight[];
  importantPages: WebsiteTabPage[];
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
  /** §7.4's no-fabrication statement, stated once for the screen. */
  joinLimitation: { querySideLabel: string; sessionSideLabel: string; statement: string };
  /** §7.6 — what connecting a missing Google source would add. */
  connectGuidance: string[];
  /** True when there is nothing to show yet (no check has run). */
  hasCheck: boolean;
}

// ─── AI visibility ────────────────────────────────────────────────────────────

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
  /** Facts-only plain-language lines, reused verbatim from the verdict. */
  headlines: string[];
  /** Named surfaces/markets that failed or were gated — never silently dropped. */
  disclosedFailures: Array<{ label: string; market: string | null; reason: string }>;
  surfaces: Array<{ label: string; status: string; statusLabel: string; market: string | null }>;
  /** The question set version and sampling tier belong in the details, not a headline (§4.3). */
  details: { questionSetVersion: number; tier: string; runCount: number };
  hasAudit: boolean;
}

// ─── Online presence ──────────────────────────────────────────────────────────

/**
 * §3.3's third tab. This one adds **no** projection of its own: P05 already
 * built the client-safe one (`PresenceService.portalInventory`, served by
 * `GET /portal/projects/:id/presence`), and re-deriving it here would be the
 * second read path this phase forbids. The tab wraps that projection in the
 * section envelope so all four tabs behave the same way when a read fails.
 */
export interface OnlinePresenceTabData {
  domain: string;
  accounts: Array<{
    platform: string;
    label: string;
    group: string;
    url: string;
    /** `confirmed` | `needs-confirmation` | `unverified` — a state, never a confidence score (§11.4). */
    state: string;
    statusLabel: string;
  }>;
  /** Platforms that apply to this business and where we found nothing yet. */
  relevantNotFound: Array<{ platform: string; label: string; group: string }>;
  counts: { total: number; needsConfirmation: number };
  /** True when there is at least one account row — drives ok vs empty, not the account count alone. */
  hasAccounts: boolean;
}

// ─── Competitors ──────────────────────────────────────────────────────────────

export interface CompetitorsTabDiffLine {
  key: string;
  /** The competitors that have this and our client does not. */
  competitors: string[];
  /** Our client has it. */
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
    /** Occurrences/best rank in the SERP sample, when one exists. */
    serp: { occurrences: number; bestRank: number | null; sampleKeyword: string | null; capturedAt: string | null } | null;
    presencePlatforms: string[];
    seoScore: number | null;
    seoIssues: string[];
    reviews: Array<{ label: string; url: string; found: boolean; rating: number | null; ratingCount: number | null; scale: number | null }>;
  }>;
  diffs: {
    presence: { client: string[]; clientOnly: CompetitorsTabDiffLine[]; competitorsOnly: CompetitorsTabDiffLine[]; shared: CompetitorsTabDiffLine[] };
    tech: { client: string[]; clientOnly: CompetitorsTabDiffLine[]; competitorsOnly: CompetitorsTabDiffLine[]; shared: CompetitorsTabDiffLine[] };
    schema: { client: string[]; clientOnly: CompetitorsTabDiffLine[]; competitorsOnly: CompetitorsTabDiffLine[]; shared: CompetitorsTabDiffLine[] };
  };
  reviews: { client: Array<{ label: string; url: string; found: boolean; rating: number | null; ratingCount: number | null; scale: number | null }>; note: string };
  hasCompetitors: boolean;
}
