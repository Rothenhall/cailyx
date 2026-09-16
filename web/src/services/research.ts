import { api, ApiError } from '@/lib/api';

/**
 * Research-run adapters — technical, SEO, traffic and AI-visibility audits.
 *
 * design_plan.md §4.3's audit-hub family states the shared contract for all of
 * these: *"Source/readiness strip, selected run and freshness, limited headline
 * metrics, chart/table tabs, prioritized evidence; **run configuration is a
 * deliberate drawer/page, never triggered on tab load**."*
 *
 * That last clause is the one this module is shaped around. Every function
 * here is either a **read** of existing runs or an **explicit** run. Nothing
 * queues work as a side effect of being called, and none of them is invoked by
 * a page's initial render.
 *
 * design_plan §10.3 adds the async contract: technical and SEO starts return a
 * `jobId` to poll, while a full AEO run returns an `auditId`. Those are
 * different shapes and are typed as such rather than unified into a guess.
 *
 * §10.2 — "Normalize `{projects}`, `{findings, thinRun}`, `{assets}` and other
 * wrappers explicitly rather than interpreting unexpected shapes as no data."
 * The Prisma-backed detail endpoints return JSON columns as **strings** (SQLite
 * has no JSON column type), so the detail adapters below parse those fields and
 * expose arrays/objects. A field that fails to parse degrades to its empty
 * value here — never to a fabricated number, and never to "no data" for the
 * whole record.
 */

export interface AuditRunSummary {
  id: string;
  status: string;
  /** ISO 8601. Null while a run is still in flight. */
  createdAt?: string;
  completedAt?: string | null;
  score?: number | null;
  band?: string | null;
  error?: string | null;
  /**
   * What the run actually audited. Present on the technical list, absent from
   * the SEO and AEO lists — and load-bearing for TA03/SE02, where two runs are
   * only comparable when this matches.
   */
  targetUrl?: string;
  /**
   * The rolling window the SEO run read, in days. It is the comparison key for
   * an SEO run pair, and it only exists on the SEO list rows.
   */
  windowDays?: number;
}

/** A queued job handle. The id must be stored before navigating (§10.3). */
export interface QueuedJob {
  jobId: string;
  status?: string;
}

/** `GET .../run/jobs/:jobId` — the pipeline queue's own status vocabulary. */
export interface PipelineJobStatus {
  status: 'not_found' | 'completed' | 'failed' | 'active' | 'waiting' | 'delayed';
  result?: unknown;
  error?: string;
  attemptsMade?: number;
  projectId?: string;
}

/** Parse a JSON array column, falling back to `[]` rather than throwing. */
function parseArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Parse a JSON object column, falling back to `null`. */
function parseObject<T>(raw: unknown): T | null {
  if (raw && typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// ── Technical audit (TA01–TA03) ─────────────────────────────────────────

/**
 * One check result. `status` is the check's own outcome — `not-run` and
 * `error` are distinct from `fail` and must not be reported as a finding
 * against the site (§3.5 "Source never measured").
 */
export interface TechnicalFinding {
  id: string;
  type: string;
  status: 'pass' | 'fail' | 'error' | 'not-run' | string;
  severity: 'low' | 'medium' | 'high' | string;
  /** `confirmed` was measured directly; `inferred` was deduced (§6.4). */
  confidence: 'confirmed' | 'inferred' | string;
  /**
   * The check's own structured output. The backend stores this column as
   * `JSON.stringify(...)`, so it arrives as a string and is parsed here —
   * parsed, never coerced to prose, because a check's raw output must reach
   * the reader as data (§10.5) rather than as an application string.
   */
  detail: Record<string, unknown>;
  recommendedFix: string;
  reproductionCommands: string | null;
}

/** Human labels for the backend's stable check-type keys. */
export const TECHNICAL_CHECK_LABELS: Record<string, string> = {
  robots: 'robots.txt',
  'cdn-inferred': 'CDN and bot access',
  'js-render': 'JavaScript rendering',
  cwv: 'Core Web Vitals',
  schema: 'Structured data',
  sitemap: 'Sitemap',
  'agent-readiness': 'Agent readiness',
  'page-inventory': 'Page inventory',
  '404-hallucinated': '404 handling',
};

export function technicalCheckLabel(type: string): string {
  return TECHNICAL_CHECK_LABELS[type] ?? type;
}

/**
 * Why a check produced no result, in the backend's own words.
 *
 * `error` findings carry `{ error }` and `not-run` findings carry `{ reason }`
 * (see the technical-audit service). Neither is invented here: when the check
 * reported neither, the caller is told that rather than handed a plausible
 * sentence.
 */
export function findingReason(finding: TechnicalFinding): string {
  const reason = finding.detail?.reason;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  const error = finding.detail?.error;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'The check reported no reason. Its raw output is in the evidence drawer.';
}

/** The raw check output as text for the evidence drawer (escaped on render). */
export function findingRawText(finding: TechnicalFinding): string {
  try {
    return JSON.stringify(finding.detail ?? {}, null, 2);
  } catch {
    return String(finding.detail);
  }
}

/** One audited page. `issues` and `jsonLdTypes` are JSON string[] columns. */
export interface TechnicalPageRow {
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
  imageCount: number | null;
  imagesMissingAlt: number | null;
  jsonLdTypes: string[];
  jsonLdValid: boolean;
  jsonLdCount: number;
  issues: string[];
  score: number | null;
  /** When this page was fetched — the evidence drawer's capture time. */
  checkedAt?: string;
}

export interface TechnicalAuditDetail {
  id: string;
  projectId: string;
  /** The URL this run actually audited — the baseline-comparison key. */
  targetUrl: string;
  triggeredBy: string;
  createdAt: string;
  score: number | null;
  previousAuditId: string | null;
  sitemapUrl: string | null;
  pagesCrawled: number;
  /** Model commentary on the run. Never fed back into `score`. */
  narrative: string | null;
  narrativeModel: string | null;
  narrativeAt: string | null;
  findings: TechnicalFinding[];
  pages: TechnicalPageRow[];
}

/** One metric that moved between two runs. `higherIsBetter` rides with it. */
export interface AuditDelta {
  metric: string;
  label: string;
  previous: number | null;
  current: number | null;
  change: number | null;
  direction: 'improved' | 'regressed' | 'unchanged' | 'new';
  higherIsBetter: boolean;
}

export interface AuditPageChanges {
  added: string[];
  removed: string[];
  improved: Array<{ url: string; from: number; to: number }>;
  regressed: Array<{ url: string; from: number; to: number }>;
}

export interface TechnicalComparison {
  currentAuditId: string;
  previousAuditId: string | null;
  currentAt: string;
  previousAt: string | null;
  deltas: AuditDelta[];
  pageChanges: AuditPageChanges;
}

export interface TechnicalTrendPoint {
  auditId: string;
  at: string;
  score: number | null;
  /** Present so a comparison can check both runs audited the same target. */
  targetUrl: string;
  pagesCrawled: number;
  triggeredBy: string;
  failures: number;
}

export async function listTechnicalAudits(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<{ audits: AuditRunSummary[] }>(`/projects/${projectId}/technical-audit`, options);
}

/** One run with every finding, page row and reproduction command. */
export async function getTechnicalAudit(
  projectId: string,
  auditId: string,
  options?: { signal?: AbortSignal },
): Promise<TechnicalAuditDetail> {
  const raw = await api.get<
    Omit<TechnicalAuditDetail, 'findings' | 'pages'> & {
      findings: Array<TechnicalFinding & { detail: unknown }>;
      pages: Array<TechnicalPageRow & { issues: unknown; jsonLdTypes: unknown }>;
    }
  >(`/projects/${projectId}/technical-audit/${auditId}`, options);
  return {
    ...raw,
    findings: (raw.findings ?? []).map((finding) => ({
      ...finding,
      // Parse, do not coerce: a check that reported no structured output is
      // `{}` and reads as "no detail", never as a sentence we invented.
      detail: parseObject<Record<string, unknown>>(finding.detail) ?? {},
    })),
    pages: (raw.pages ?? []).map((page) => ({
      ...page,
      issues: parseArray<string>(page.issues),
      jsonLdTypes: parseArray<string>(page.jsonLdTypes),
    })),
  };
}

export async function getTechnicalComparison(
  projectId: string,
  auditId: string,
  options?: { signal?: AbortSignal },
): Promise<TechnicalComparison> {
  return api.get<TechnicalComparison>(
    `/projects/${projectId}/technical-audit/${auditId}/comparison`,
    options,
  );
}

/**
 * Explicitly queues a technical audit. Never called on page load.
 *
 * `targetUrl` is omitted by the console: the backend resolves the project's own
 * domain, so an operator never retypes their URL.
 *
 * `pageBudget` is accepted by the request DTO (1–1000) but the handler does not
 * forward it to the queued job — design_plan G19 lists "page budget forwarding"
 * as an open gap. It is typed here so the screen can state that limitation
 * rather than offer a control that silently does nothing.
 */
export async function runTechnicalAudit(
  projectId: string,
  input?: { targetUrl?: string; pageBudget?: number },
): Promise<QueuedJob & { targetUrl?: string }> {
  return api.post<QueuedJob & { targetUrl?: string }>(
    `/projects/${projectId}/technical-audit/run`,
    input,
  );
}

export async function getTechnicalAuditJob(projectId: string, jobId: string) {
  return api.get<PipelineJobStatus>(
    `/projects/${projectId}/technical-audit/run/jobs/${jobId}`,
  );
}

export async function getTechnicalTrend(
  projectId: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<{ history: TechnicalTrendPoint[] }> {
  const result = await api.get<{ history: TechnicalTrendPoint[] }>(
    `/projects/${projectId}/technical-audit/trend/history`,
    { ...options, query: { limit: options?.limit } },
  );
  return { history: result.history ?? [] };
}

// ── SEO audit (SE01–SE02) ───────────────────────────────────────────────

export interface SeoQueryRow {
  id?: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  positionDelta: number | null;
  impressionsDelta: number | null;
  clicksDelta: number | null;
  topPage: string | null;
  opportunities: string[];
}

export interface SeoPageRow {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** Null when this URL was outside the run's inspection budget — which is
   *  not the same as "not indexed" and must never be read as one. */
  coverageState: string | null;
  indexVerdict: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  /** What Google considers canonical, and what the page declares. They differ
   *  when the page's own canonical is being ignored — a real finding. */
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  issues: Array<{ code: string; severity: string; detail: string; fix: string; fixArtifact?: string }>;
  richResults: string[];
}

export interface SeoFinding {
  id: string;
  type: string;
  status: 'fail' | 'warn' | 'pass' | string;
  severity: 'critical' | 'high' | 'medium' | 'low' | string;
  title: string;
  detail: string;
  recommendedFix: string;
  /** JSON string[] column, parsed here. */
  affected: string[];
  count: number;
  fixArtifact: string | null;
  action: string | null;
}

export interface SeoAuditDetail {
  id: string;
  projectId: string;
  siteUrl: string;
  triggeredBy: string;
  createdAt: string;
  /** The rolling window this run read, 7–90 days. */
  windowDays: number;
  score: number | null;
  previousAuditId: string | null;
  deltas: AuditDelta[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  page1Queries: number;
  top3Queries: number;
  /** How many URLs were actually URL-inspected — the coverage numerator. */
  pagesInspected: number;
  metrics: {
    prev: { clicks: number; impressions: number; ctr: number; position: number } | null;
    timeseries: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  } | null;
  findings: SeoFinding[];
  queries: SeoQueryRow[];
  pages: SeoPageRow[];
}

export interface SeoComparison {
  currentAuditId: string;
  previousAuditId: string | null;
  currentAt: string;
  previousAt: string | null;
  deltas: AuditDelta[];
  pageChanges: {
    improved: Array<{ url: string; from: number; to: number }>;
    regressed: Array<{ url: string; from: number; to: number }>;
    nowIndexed: string[];
    lostIndex: string[];
    nowClean: string[];
    added: string[];
    dropped: string[];
  };
  queryChanges: {
    enteredPage1: Array<{ query: string; from: number | null; to: number }>;
    leftPage1: Array<{ query: string; from: number; to: number | null }>;
  };
}

export interface SeoTrendPoint {
  auditId: string;
  at: string;
  score: number | null;
  clicks: number;
  impressions: number;
  position: number;
  page1Queries: number;
  triggeredBy: string;
}

export async function listSeoAudits(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<{ audits: AuditRunSummary[] }>(`/projects/${projectId}/seo-audit`, options);
}

export async function getSeoAudit(
  projectId: string,
  auditId: string,
  options?: { signal?: AbortSignal },
): Promise<SeoAuditDetail> {
  const raw = await api.get<
    Omit<SeoAuditDetail, 'findings' | 'queries' | 'pages' | 'deltas' | 'metrics'> & {
      findings: Array<SeoFinding & { affected: unknown }>;
      queries: Array<SeoQueryRow & { opportunities: unknown }>;
      pages: Array<SeoPageRow & { issues: unknown; richResults: unknown }>;
      deltas: unknown;
      metrics: unknown;
    }
  >(`/projects/${projectId}/seo-audit/${auditId}`, options);
  return {
    ...raw,
    findings: (raw.findings ?? []).map((f) => ({ ...f, affected: parseArray<string>(f.affected) })),
    queries: (raw.queries ?? []).map((q) => ({ ...q, opportunities: parseArray<string>(q.opportunities) })),
    pages: (raw.pages ?? []).map((p) => ({
      ...p,
      issues: parseArray<SeoPageRow['issues'][number]>(p.issues),
      richResults: parseArray<string>(p.richResults),
    })),
    deltas: parseArray<AuditDelta>(raw.deltas),
    metrics: parseObject<SeoAuditDetail['metrics']>(raw.metrics),
  };
}

/**
 * Compares one run against its predecessor.
 *
 * §4's run/evidence detail family calls this a "status or comparison pair", and
 * §3.3's `ChangeComparison` is the component for it — which means the caller
 * must decide whether the two runs are methodologically comparable before
 * showing a delta.
 */
export async function compareSeoAudit(
  projectId: string,
  auditId: string,
  options?: { signal?: AbortSignal },
): Promise<SeoComparison> {
  return api.get<SeoComparison>(
    `/projects/${projectId}/seo-audit/${auditId}/comparison`,
    options,
  );
}

export async function getSeoTrend(
  projectId: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<{ history: SeoTrendPoint[] }> {
  const result = await api.get<{ history: SeoTrendPoint[] }>(
    `/projects/${projectId}/seo-audit/trend/history`,
    { ...options, query: { limit: options?.limit } },
  );
  return { history: result.history ?? [] };
}

export async function runSeoAudit(projectId: string, input?: { windowDays?: number }): Promise<QueuedJob> {
  return api.post<QueuedJob>(`/projects/${projectId}/seo-audit/run`, input);
}

export async function getSeoAuditJob(projectId: string, jobId: string) {
  return api.get<PipelineJobStatus>(`/projects/${projectId}/seo-audit/run/jobs/${jobId}`);
}

/**
 * Re-submits the property's sitemap(s) to Google.
 *
 * §10.4's "email/sitemap/publication" row: preview the target and effect, take
 * an explicit action, and report the attempt separately from the outcome — a
 * 200 means Google accepted the submission, not that it re-crawled anything.
 */
export async function submitSeoSitemaps(projectId: string): Promise<{ submitted: string[] }> {
  const result = await api.post<{ submitted: string[] }>(
    `/projects/${projectId}/seo-audit/submit-sitemaps`,
  );
  return { submitted: result.submitted ?? [] };
}

// ── Google reads (SE01, SE03) ───────────────────────────────────────────

export interface GoogleDateWindow {
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  days: number;
}

export interface SearchConsoleSummary {
  range: GoogleDateWindow;
  site: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
  topPages: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>;
}

export interface AnalyticsSummary {
  range: GoogleDateWindow;
  property: string;
  totals: {
    sessions: number;
    totalUsers: number;
    screenPageViews: number;
    /** Fraction (0–1) as GA4 returns it — not a percentage. */
    engagementRate: number;
    averageSessionDuration: number;
  };
  channels: Array<{ key: string; sessions: number; totalUsers: number }>;
  topPages: Array<{ key: string; screenPageViews: number; sessions: number }>;
}

/**
 * Whether a Google service is connected *and* mapped to this project.
 *
 * §4's connections family requires these to stay three separate facts. The
 * resource endpoint returns exactly that split, so it is read here rather than
 * inferred from whether a data call happened to succeed.
 */
export interface GoogleReadiness {
  service: 'search-console' | 'analytics';
  connected: boolean;
  /** The mapped resource, when one is chosen. */
  selected: { resourceId: string; resourceLabel: string | null } | null;
  options: Array<{ id: string; label: string; detail?: string }>;
}

export async function getGoogleReadiness(
  projectId: string,
  service: 'search-console' | 'analytics',
  options?: { signal?: AbortSignal },
): Promise<GoogleReadiness> {
  return api.get<GoogleReadiness>('/integrations/google/resources', {
    ...options,
    query: { projectId, service },
  });
}

/** Rolling 1–90 day window; the backend rejects anything outside it. */
export async function getSearchConsoleSummary(
  projectId: string,
  days: number,
  options?: { signal?: AbortSignal },
): Promise<SearchConsoleSummary> {
  return api.get<SearchConsoleSummary>('/integrations/google/search-console/summary', {
    ...options,
    query: { projectId, days },
  });
}

export async function getAnalyticsSummary(
  projectId: string,
  days: number,
  options?: { signal?: AbortSignal },
): Promise<AnalyticsSummary> {
  return api.get<AnalyticsSummary>('/integrations/google/analytics/summary', {
    ...options,
    query: { projectId, days },
  });
}

// ── Self-reported attribution (SE03, second tab) ────────────────────────

export interface AttributionResponse {
  id: string;
  source: string;
  prompt: string | null;
  note: string | null;
  contactEmail: string | null;
  page: string | null;
  createdAt: string;
}

export interface AttributionSummary {
  total: number;
  aiTotal: number;
  /** Fraction (0–1). */
  aiShare: number;
  bySource: Array<{ source: string; count: number; share: number }>;
  prompts: Array<{ prompt: string; source: string; createdAt: string }>;
  recent: AttributionResponse[];
  firstAt: string | null;
  lastAt: string | null;
}

export async function getAttributionSummary(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<AttributionSummary> {
  return api.get<AttributionSummary>(`/projects/${projectId}/attribution/summary`, options);
}

export async function listAttribution(
  projectId: string,
  options?: { signal?: AbortSignal; take?: number },
): Promise<AttributionResponse[]> {
  const rows = await api.get<AttributionResponse[]>(`/projects/${projectId}/attribution`, {
    ...options,
    query: { take: options?.take },
  });
  return Array.isArray(rows) ? rows : [];
}

// ── AEO / AI visibility (AE01–AE05) ─────────────────────────────────────

/** Answer engines the backend accepts. Kept identical to `AEO_SURFACES`. */
export const AEO_SURFACES = [
  'chatgpt-browser',
  'perplexity-browser',
  'gemini-browser',
  'cloro-chatgpt',
  'cloro-perplexity',
  'cloro-gemini',
  'cloro-ai-overview',
  'cloro-ai-mode',
  'mock',
] as const;

export type AeoSurface = (typeof AEO_SURFACES)[number];

/** What each surface is called in a report. Mirrors the backend's labels. */
export const AEO_SURFACE_LABELS: Record<string, string> = {
  'chatgpt-browser': 'ChatGPT (browser)',
  'perplexity-browser': 'Perplexity (browser)',
  'gemini-browser': 'Gemini (browser)',
  'cloro-chatgpt': 'ChatGPT',
  'cloro-perplexity': 'Perplexity',
  'cloro-gemini': 'Gemini',
  'cloro-ai-overview': 'Google AI Overview',
  'cloro-ai-mode': 'Google AI Mode',
  mock: 'Mock (test)',
};

/**
 * Prompt-matrix size tiers and the prompt count each one buys.
 *
 * Duplicated from `TIER_SIZES` on purpose: the configurator must show the
 * operator the prompt count *before* the estimate request comes back, and
 * `GET /aeo/budget` reports the count it used rather than the tier's size.
 */
export const AEO_MATRIX_TIERS: ReadonlyArray<{ tier: string; prompts: number; label: string }> = [
  { tier: 'trial', prompts: 5, label: 'Trial — 5 prompts' },
  { tier: 'trial-wide', prompts: 10, label: 'Trial wide — 10 prompts' },
  { tier: 'scorecard', prompts: 25, label: 'Scorecard — 25 prompts' },
  { tier: 'standard', prompts: 100, label: 'Standard — 100 prompts' },
  { tier: 'full', prompts: 300, label: 'Full — 300 prompts' },
];

/** Per-prompt repeat floor and ceiling, enforced by the backend. */
export const AEO_MIN_RUN_COUNT = 5;
export const AEO_MAX_RUN_COUNT = 25;

/**
 * What a proposed run would cost, answered **before** the operator starts it.
 *
 * `required` is **Cloro credits**, never dollars — there is no currency in this
 * shape at all, which is the point (§6.3). `remaining` and `fits` are both
 * `null` when the balance could not be read: an unknown balance is neither
 * sufficient nor insufficient.
 */
export interface AeoBudgetEstimate {
  required: number;
  remaining: number | null;
  fits: boolean | null;
  unavailableReason: string | null;
  perSurface: Array<{ surface: string; label: string; credits: number; metered: boolean }>;
  /** prompts × runCount × surfaces × markets — the wall-clock driver. */
  calls: number;
  prompts: number;
  runCount: number;
  markets: number;
}

export interface AeoBudgetQuery {
  surfaces: string[];
  tier: string;
  runCount: number;
  markets: number;
}

/**
 * Pre-flight credit estimate for a proposed run configuration.
 *
 * design_plan G12 (line 1669) is explicit that this is a **Cloro credit
 * estimate** — not all-provider USD spend and not a team budget ledger. The
 * return type keeps the unit in the field name so a caller cannot quietly
 * render it with a currency symbol.
 */
export async function estimateAeoBudget(
  projectId: string,
  input: AeoBudgetQuery,
  options?: { signal?: AbortSignal },
): Promise<AeoBudgetEstimate> {
  return api.get<AeoBudgetEstimate>(`/projects/${projectId}/aeo/budget`, {
    ...options,
    query: {
      surfaces: input.surfaces.join(','),
      tier: input.tier,
      runCount: input.runCount,
      markets: input.markets,
    },
  });
}

/** One measured engine (or engine × market) inside an audit. */
export interface AeoSurfaceRun {
  surface: string;
  market: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | string;
  runId: string | null;
  observations: number;
  stanceJudged: number;
  costUsd: number;
  /** Typed adapter reason — `blocked`, `rate-limited`, `selector-drift`, … */
  failureKind: string | null;
  error: string | null;
  /**
   * The surface that ACTUALLY answered when it differs from `surface` — set
   * when a failed `cloro-*` surface fell back to its browser equivalent.
   */
  attemptedVia: string | null;
}

/** Counted metrics for one slice. These are the only numbers quotable as rates. */
export interface AeoSliceMetrics {
  prompts: number;
  observations: number;
  mentionRate: number;
  citationRate: number;
}

export interface AeoSurfaceComparison extends AeoSliceMetrics {
  surface: string;
  label: string;
  status: string;
  unbrandedMentionRate: number;
  stanceCounts: Record<string, number>;
  rivalsAheadCount: number;
}

export interface AeoCompetitorStanding {
  name: string;
  observations: number;
  mentionRate: number;
  clientAheadCount: number;
  clientBehindCount: number;
  wonWhileClientAbsent: number;
}

export interface AeoVerdict {
  surface: string;
  surfaceRuns: Array<AeoSurfaceRun & { label?: string }>;
  runCount: number;
  generatedAt: string;
  /** COUNTED — deterministic extraction over n>=5 repeats. */
  counted: {
    overall: AeoSliceMetrics;
    unbranded: AeoSliceMetrics;
    branded: AeoSliceMetrics;
    byDimension: Array<AeoSliceMetrics & { dimension: string; label: string; stanceCounts: Record<string, number> }>;
    byFunnelStage: Array<AeoSliceMetrics & { funnelStage: string }>;
    shareOfVoice: Array<{ name: string; share: number }>;
    competitors: AeoCompetitorStanding[];
    bySurface: AeoSurfaceComparison[];
    byMarket: Array<AeoSliceMetrics & { market: string }>;
    byMarketSurface: Array<AeoSliceMetrics & { market: string; surface: string; label: string; status: string; unbrandedMentionRate: number }>;
  };
  /** JUDGED — LLM opinion over the same answers. Never a rate. */
  judged: {
    available: boolean;
    unavailableReason?: string;
    judgeModel?: string;
    observationsJudged: number;
    stanceCounts: Record<string, number>;
    losingPrompts: Array<{ prompt: string; dimension: string | null; losesTo: string[]; evidenceQuote: string | null }>;
    winningPrompts: Array<{ prompt: string; dimension: string | null; recommendedOver: string[]; evidenceQuote: string | null }>;
  };
  headlines: string[];
}

export interface AeoAuditDetail extends AuditRunSummary {
  projectId: string;
  contextId: string | null;
  querySetId: string | null;
  runId: string | null;
  /** JSON string[] columns, parsed here. */
  surfaces: string[];
  markets: string[];
  tier: string;
  runCount: number;
  promptCount: number;
  observations: number;
  stanceJudged: number;
  costUsd: number;
  /** Last completed stage. */
  stage: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  verdict: AeoVerdict | null;
  surfaceRuns: AeoSurfaceRun[];
}

/** Lifecycle statuses an AEO run can be in, terminal ones included. */
export const AEO_AUDIT_STATUSES = [
  'pending',
  'context',
  'matrix',
  'running',
  'judging',
  'completed',
  'failed',
] as const;

/** Statuses where the backend is still working on the audit (§10.3). */
export const AEO_ACTIVE_STATUSES: readonly string[] = ['pending', 'context', 'matrix', 'running', 'judging'];

export async function listAeoAudits(projectId: string, options?: { signal?: AbortSignal }) {
  const raw = await api.get<{ audits: Array<AuditRunSummary & { finishedAt?: string | null }> }>(
    `/projects/${projectId}/aeo/audits`,
    options,
  );
  // The AEO list reports `finishedAt`; `AuditRunSummary` calls it `completedAt`.
  // Normalizing here is what §10.2 asks for — not a caller guessing per screen.
  return {
    audits: (raw.audits ?? []).map((row) => ({
      ...row,
      completedAt: row.completedAt ?? row.finishedAt ?? null,
    })),
  };
}

export async function getAeoAudit(
  projectId: string,
  auditId: string,
  options?: { signal?: AbortSignal },
): Promise<AeoAuditDetail> {
  const raw = await api.get<Omit<AeoAuditDetail, 'surfaces' | 'markets' | 'verdict'> & {
    surfaces: unknown;
    markets: unknown;
    verdict: unknown;
  }>(`/projects/${projectId}/aeo/audits/${auditId}`, options);
  return {
    ...raw,
    surfaces: parseArray<string>(raw.surfaces),
    markets: parseArray<string>(raw.markets),
    verdict: parseObject<AeoVerdict>(raw.verdict),
    surfaceRuns: raw.surfaceRuns ?? [],
  };
}

/** Recompute the stored verdict from stored observations and stances. */
export async function getAeoVerdict(projectId: string, auditId: string): Promise<AeoVerdict> {
  return api.get<AeoVerdict>(`/projects/${projectId}/aeo/audits/${auditId}/verdict`);
}

/**
 * Starts the full AEO pipeline (context → matrix → measurement → stance →
 * verdict) and returns the **auditId**, not a jobId — §10.3 warns that these
 * starts are not uniform. Persist the id before navigating: the run continues
 * server-side whether or not the page stays open.
 */
export async function runFullAeoAudit(
  projectId: string,
  input: {
    surfaces: string[];
    tier?: string;
    runCount?: number;
    markets?: string[];
    reuseContext?: boolean;
    skipStance?: boolean;
    skipRefine?: boolean;
  },
): Promise<{ auditId: string; status: string }> {
  const row = await api.post<{ id: string; status?: string }>(
    `/projects/${projectId}/aeo/audits/full`,
    input,
  );
  return { auditId: row.id, status: row.status ?? 'pending' };
}

/**
 * Creates the audit row only — no scraping, no spend. Drive it with `resume`.
 *
 * This is the "draft" half of AE02's "start or draft": it records the intended
 * configuration and costs nothing until someone explicitly resumes it.
 */
export async function createAeoAuditDraft(
  projectId: string,
  input: {
    surfaces: string[];
    tier?: string;
    runCount?: number;
    markets?: string[];
    reuseContext?: boolean;
    skipStance?: boolean;
    skipRefine?: boolean;
  },
): Promise<{ auditId: string; status: string }> {
  const row = await api.post<{ id: string; status?: string }>(
    `/projects/${projectId}/aeo/audits`,
    input,
  );
  return { auditId: row.id, status: row.status ?? 'pending' };
}

/**
 * Resumes a stopped or failed AEO audit.
 *
 * §10.3 notes this may hold the request open — it is not a fire-and-forget
 * queue call. The caller must reconcile the run's stored history rather than
 * assume the response means completion.
 */
export async function resumeAeoAudit(projectId: string, auditId: string) {
  return api.post<Record<string, unknown>>(
    `/projects/${projectId}/aeo/audits/${auditId}/resume`,
  );
}

/** Runs (or finishes) the LLM stance pass, then refreshes the stored verdict. */
export async function judgeAeoStance(projectId: string, auditId: string) {
  return api.post<{ judged: number; skipped: number; failed: number; costUsd: number; judgeModel: string }>(
    `/projects/${projectId}/aeo/audits/${auditId}/stance`,
  );
}

/** The project's extracted site context, or `null` when none has been built. */
export interface SiteContext {
  id: string;
  projectId: string;
  domain: string;
  brand: string;
  category: string | null;
  vertical: string | null;
  description: string | null;
  geo: string | null;
  markets: string[];
  services: string[];
  icp: string[];
  valueProps: string[];
  painPoints: string[];
  outcomes: string[];
  competitors: Array<{ name: string; domain: string | null }>;
  pagesFetched: number;
  /** Exactly which pages were read — the evidence behind every extracted line. */
  pageUrls: string[];
  extraction: 'deterministic' | 'llm-synthesized' | string;
  llmModel: string | null;
  costUsd: number;
  createdAt: string;
}

/**
 * The site context, distinguishing "never built" from "the read failed".
 *
 * `GET /aeo/context` answers 404 when no context exists, which §3.5 treats as
 * an unmet prerequisite rather than an error — so the 404 is resolved into
 * `null` here and every other failure still throws.
 */
export async function getSiteContext(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<SiteContext | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await api.get<Record<string, unknown>>(`/projects/${projectId}/aeo/context`, options);
  } catch (caught) {
    if (caught instanceof ApiError && caught.kind === 'not-found') return null;
    throw caught;
  }
  return {
    ...(raw as unknown as SiteContext),
    markets: parseArray<string>(raw.markets),
    services: parseArray<string>(raw.services),
    icp: parseArray<string>(raw.icp),
    valueProps: parseArray<string>(raw.valueProps),
    painPoints: parseArray<string>(raw.painPoints),
    outcomes: parseArray<string>(raw.outcomes),
    competitors: parseArray<{ name: string; domain: string | null }>(raw.competitors),
    pageUrls: parseArray<string>(raw.pageUrls),
  };
}

/** Explicitly re-crawls the site. Costs a crawl and, with a key set, one LLM pass. */
export async function buildSiteContext(projectId: string, input?: { maxPages?: number; refine?: boolean }) {
  return api.post<Record<string, unknown>>(`/projects/${projectId}/aeo/context`, input);
}

// ── Measurement runs (AE04) ─────────────────────────────────────────────

/** One measured answer. `rawAnswer` is escaped text, never markup (§10.5). */
export interface MeasurementObservation {
  id: string;
  runId: string;
  itemId: string;
  /** 1..n of the repeat this observation is. */
  runNumber: number;
  prompt: string;
  mentioned: boolean;
  cited: boolean;
  citedUrl: string | null;
  position: number | null;
  /** JSON string[] column, parsed here. */
  competitors: string[];
  characterization: string | null;
  rawAnswer: string;
  costUsd: number;
  latencyMs: number | null;
  model: string | null;
  createdAt: string;
}

export interface MeasurementRunDetail {
  id: string;
  projectId: string;
  querySetId: string;
  surface: string;
  geo: string;
  runCount: number;
  status: string;
  /** What the run was asked for, versus what came back — the coverage pair. */
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  costTotal: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  observations: MeasurementObservation[];
}

/**
 * One measurement run with its raw observations.
 *
 * §10.5: "Load compact summaries first and raw observations/pages only on
 * demand." This is the on-demand call — it is fetched only by AE04, never by a
 * hub screen.
 */
export async function getMeasurementRun(
  projectId: string,
  runId: string,
  options?: { signal?: AbortSignal },
): Promise<MeasurementRunDetail> {
  const raw = await api.get<MeasurementRunDetail & { observations: Array<MeasurementObservation & { competitors: unknown }> }>(
    `/projects/${projectId}/measurement/runs/${runId}`,
    options,
  );
  return {
    ...raw,
    observations: (raw.observations ?? []).map((o) => ({
      ...o,
      competitors: parseArray<string>(o.competitors),
    })),
  };
}
