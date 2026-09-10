/**
 * Types for the Cailyx dashboard — mirrors the backend `agents` and
 * `integrations` aggregation modules plus the bits of other modules the panes
 * read.
 *
 * @module types/terminal
 */

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

export type AgentStatus = 'ready' | 'attention' | 'idle' | 'running' | 'blocked';

export interface AgentCard {
  key: string;
  name: string;
  category: string;
  status: AgentStatus;
  headline: string;
  count: number;
  metric: string | null;
  activity: string[];
  lastActivityAt: string | null;
  href: string;
  cta: string;
}

export interface AgentsResponse {
  projectId: string;
  agents: AgentCard[];
  summary: { total: number; needAttention: number; ready: number; idle: number };
}

export type IntegrationCategory =
  | 'analytics'
  | 'ai-surface'
  | 'serp'
  | 'performance'
  | 'infrastructure'
  | 'monetization'
  | 'email'
  | 'mode';

export interface Integration {
  key: string;
  name: string;
  category: IntegrationCategory;
  connected: boolean;
  status: 'connected' | 'not-connected' | 'unavailable' | 'enabled' | 'disabled';
  detail: string;
  configHint: string;
  connectUrl: string | null;
  docsPath: string | null;
}

export interface IntegrationsResponse {
  integrations: Integration[];
  summary: { total: number; connected: number };
}

/* ── Google (Search Console + Analytics) OAuth ──────────────────────────── */

export type GoogleService = 'search-console' | 'analytics';

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

export interface GoogleResourceOption {
  id: string;
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

export interface SearchConsoleSummary {
  range: { startDate: string; endDate: string; days: number };
  site: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
  topPages: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
}

export interface AnalyticsSummary {
  range: { startDate: string; endDate: string; days: number };
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

/** technical-audit finding (subset the Analytics pane renders). */
export interface AuditFinding {
  id: string;
  type: string;
  status: string; // pass | warn | fail
  severity: string; // info | low | medium | high | critical
  confidence: string;
  detail: string;
  recommendedFix: string;
}

export interface PageMetadata {
  title: string | null;
  metaDescription: string | null;
  headings: string | null; // JSON
  positioningCopy: string | null;
}

/**
 * One sitemap URL as the audit scored it. `jsonLdTypes` and `issues` arrive as
 * JSON strings because the backend stores them in SQLite text columns — parse
 * with `parseJsonArray` in lib/text.ts rather than trusting the shape.
 */
export interface AuditPage {
  id: string;
  url: string;
  status: number;
  lastmod: string | null;
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescLength: number | null;
  h1Count: number | null;
  canonical: string | null;
  wordCount: number | null;
  jsonLdTypes: string | null;
  jsonLdValid: boolean;
  jsonLdCount: number;
  issues: string | null;
  score: number | null;
}

/** One metric's movement between two runs. */
export interface AuditDelta {
  metric: string;
  label: string;
  previous: number | null;
  current: number | null;
  change: number | null;
  direction: 'improved' | 'regressed' | 'unchanged' | 'new';
  /** Needed to colour the arrow — a falling LCP is good, a falling score is not. */
  higherIsBetter: boolean;
}

export interface AuditComparison {
  currentAuditId: string;
  previousAuditId: string | null;
  currentAt: string;
  previousAt: string | null;
  deltas: AuditDelta[];
  pageChanges: {
    added: string[];
    removed: string[];
    improved: Array<{ url: string; from: number; to: number }>;
    regressed: Array<{ url: string; from: number; to: number }>;
  };
}

/** One point on the score history. */
export interface AuditTrendPoint {
  auditId: string;
  at: string;
  score: number | null;
  targetUrl: string;
  pagesCrawled: number;
  triggeredBy: string;
  failures: number;
}

export interface TechnicalAudit {
  id: string;
  projectId: string;
  targetUrl: string;
  createdAt: string;
  findings: AuditFinding[];
  pageMetadata: PageMetadata | null;
  /** 0-100 composite. Null when no check produced a score. */
  score: number | null;
  previousAuditId: string | null;
  /** JSON AuditDelta[] on the list endpoint; already parsed on the detail one. */
  deltas?: AuditDelta[] | string | null;
  sitemapUrl: string | null;
  pagesCrawled: number;
  pages?: AuditPage[];
  /** Model-written commentary comparing this run to the previous. */
  narrative: string | null;
  narrativeModel: string | null;
  /** JSON: { totalCostUsd, totalLatencyMs, checksRun, probesRun, fetcherLogCount, cacheHitRate } */
  observability?: string | null;
}

export interface LinkGraph {
  id: string;
  status: string;
  rootUrl: string;
  pagesCrawled: number;
  edgeCount: number;
  orphanCount: number;
  recommendationCount: number;
  createdAt: string;
}

export interface ProjectStats {
  technicalAudits: number;
  reports: number;
  entities: number;
  gaps: number;
  scheduleActive: boolean;
}

export interface ProjectDetail {
  id: string;
  name: string;
  domain: string;
  category?: string | null;
  clientName?: string | null;
  status?: string | null;
  notes?: string | null;
  competitors?: string | null; // JSON [{name, domain}]
  createdAt?: string;
  updatedAt?: string;
  stats?: ProjectStats;
}
