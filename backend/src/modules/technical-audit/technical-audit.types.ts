/**
 * Technical Audit Types — Data models for audit findings.
 *
 * @module technical-audit.types
 */

// ─── Findings ───────────────────────────────────────────────────

export type AuditCheckType =
  | 'robots'
  | 'cdn-inferred'
  | 'js-render'
  | 'cwv'
  | 'schema'
  | 'sitemap'
  | 'agent-readiness'
  | 'page-inventory'
  | '404-hallucinated';
export type AuditStatus = 'pass' | 'fail' | 'error' | 'not-run';
export type Severity = 'low' | 'medium' | 'high';
export type Confidence = 'confirmed' | 'inferred';

/** Which layer a block was detected at (PRD data model: `layer`) */
export type BlockLayer = 'robots.txt' | 'cdn-waf' | 'none';

export interface ReproductionCommand {
  /** The bot or user-agent being tested */
  bot: string;
  /** The exact curl command to reproduce the probe */
  command: string;
  /** Expected result when run */
  expectedResult: string;
}

export interface AuditFinding {
  type: AuditCheckType;
  status: AuditStatus;
  detail: Record<string, unknown>;
  severity: Severity;
  confidence: Confidence;
  recommendedFix: string;
  /** PRD FR-2.6: Exact reproduction commands for the report appendix */
  reproductionCommands?: ReproductionCommand[];
}

// ─── Audit Run ──────────────────────────────────────────────────

export interface TechnicalAudit {
  id: string;
  projectId: string;
  triggeredBy: 'manual' | 'scheduled';
  createdAt: string;
  findings: AuditFinding[];
  targetUrl: string;
  /** 0-100 composite across the checks that produced a score. */
  score?: number | null;
  /** The run this one is measured against — null on a project's first audit. */
  previousAuditId?: string | null;
  /** What moved since `previousAuditId`. Empty on a first run. */
  deltas?: AuditDelta[];
  /** Where the sitemap was actually found. */
  sitemapUrl?: string | null;
  pagesCrawled?: number;
  /** Per-page results for every sitemap URL fetched this run. */
  pages?: AuditPageResult[];
  /** LLM commentary on this run vs the previous. Null when unavailable. */
  narrative?: string | null;
  narrativeModel?: string | null;
  /** PRD FR-3.5: Captured page metadata for downstream entity/findings stages */
  pageMetadata?: PageMetadata;
  observability?: AuditObservability;
}

/** PRD FR-3.5: Title, meta description, headings, positioning copy */
export interface PageMetadata {
  title: string;
  metaDescription: string;
  headings: HeadingInfo[];
  positioningCopy: string;
  capturedAt: string;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

// ─── Schedule Config ────────────────────────────────────────────

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'manual-only';

export interface ScheduleConfig {
  cadence: Cadence;
  nextRunAt: string | null;
  active: boolean;
}

// ─── Robots.txt Analysis ────────────────────────────────────────

export interface RobotsRule {
  botName: string;
  disallowed: boolean;
  paths: string[];
  /** PRD data model: which layer this rule applies to */
  layer: BlockLayer;
}

export interface RobotsAnalysis {
  robotsTxtFound: boolean;
  statusCode: number;
  rules: RobotsRule[];
  missingRobotsTxt: boolean;
  rawContent: string;
}

// ─── CDN Probe Analysis ─────────────────────────────────────────

export interface CdnProbeResult {
  botName: string;
  category: string;
  status: number;
  blocked: boolean;
  latencyMs: number;
  inconsistent: boolean;
  /** PRD data model: which layer the block was detected at */
  layer: BlockLayer;
}

export interface CdnAnalysis {
  cdnVendor: string | null;
  detectedFromHeaders: string[];
  probes: CdnProbeResult[];
  browserControlStatus: number;
  silentBlockDetected: boolean;
  blockedBots: string[];
}

// ─── JS Render Analysis ─────────────────────────────────────────

export interface JsRenderAnalysis {
  serverRenderedText: string;
  jsRenderedText: string;
  textLengthWithoutJs: number;
  textLengthWithJs: number;
  isJsDependent: boolean;
  contentLossPercent: number;
  titleWithoutJs: string;
  titleWithJs: string;
}

// ─── CWV Analysis ───────────────────────────────────────────────

export interface CwvAnalysis {
  lcp: number;
  cls: number;
  inp: number;
  performanceScore: number;
  lcpStatus: 'good' | 'needs-improvement' | 'poor';
  clsStatus: 'good' | 'needs-improvement' | 'poor';
  inpStatus: 'good' | 'needs-improvement' | 'poor';

  /* ── the rest of the Lighthouse run ──────────────────────────────────
     PSI does one Lighthouse pass and returns ~150 audits; keeping only the
     three CWV numbers threw away the SEO, accessibility and best-practices
     verdicts that were already paid for. */

  /** Every requested category, 0-100: performance, seo, accessibility, best-practices. */
  categories: Record<string, number>;
  /** Non-passing audits across all categories, worst score first. */
  failedAudits: Array<{
    id: string;
    title: string;
    category: string;
    score: number | null;
    description: string;
    displayValue: string;
  }>;
  /** CrUX real-user data. Null for origins below Google's reporting threshold. */
  fieldData: Record<string, { percentile: number; category: string }> | null;
  finalUrl: string | null;
  lighthouseVersion: string | null;
}

// ─── Schema Analysis (PRD FR-3.2) ───────────────────────────────

export interface SchemaAnalysis {
  schemasFound: boolean;
  schemaTypes: string[];
  hasOrganization: boolean;
  hasPerson: boolean;
  sameAsCount: number;
  sameAsUrls: string[];
  missingFields: string[];
  rawSchemas: unknown[];
  /** Results of verifying each sameAs URL (resolves + identity match) */
  sameAsVerification?: Array<{ url: string; resolves: boolean; identityMatch?: boolean }>;
}

// ─── Observability (PRD §12 — cost + timing per run) ─────────────────────────

export interface AuditObservability {
  totalCostUsd: number;
  fetcherLogCount: number;
  totalLatencyMs: number;
  probesRun: number;
  checksRun: number;
  cacheHitRate: number;
}


// ─── Sitemap (transcript req. 1: present, and regularly updated) ─────────────

export interface SitemapEntry {
  url: string;
  /** `<lastmod>` as declared, ISO-normalised. Null when the sitemap omits it. */
  lastmod: string | null;
}

export interface SitemapAnalysis {
  found: boolean;
  /** The URL the sitemap was actually served from. */
  sitemapUrl: string | null;
  /** Every location tried, in order — useful when nothing was found. */
  triedUrls: string[];
  statusCode: number;
  /** True when the document is a <sitemapindex> rather than a <urlset>. */
  isIndex: boolean;
  /** Child sitemaps, when this is an index. */
  childSitemaps: string[];
  urlCount: number;
  /** How many of those URLs carry a <lastmod> at all. */
  withLastmod: number;
  newestLastmod: string | null;
  oldestLastmod: string | null;
  /** Whole days since the most recent <lastmod>. Null when none is declared. */
  staleDays: number | null;
  /** Is the sitemap declared via a `Sitemap:` line in robots.txt? */
  declaredInRobots: boolean;
  /** URLs that appear more than once across the set. */
  duplicateCount: number;
  /** URLs whose origin differs from the audited origin. */
  offOriginCount: number;
  entries: SitemapEntry[];
}

// ─── Agent readiness (transcript req. 4: `npx is-agentic`) ───────────────────

export interface AgentReadinessIssue {
  id: string;
  name: string;
  result: string;
  recommendation: string;
  details?: string;
}

export interface AgentReadinessAnalysis {
  /** 0-100 as scored by is-agentic. Null when the scan could not be obtained. */
  score: number | null;
  scoreLabel: string | null;
  target: string | null;
  reportUrl: string | null;
  scannedAt: string | null;
  eligibleChecks: number | null;
  breakdown: {
    essential?: { earned: number; available: number; passing: number; total: number };
    recommended?: { earned: number; available: number; passing: number; total: number };
    bonus?: { points: number; positive_signals: number };
  } | null;
  issues: AgentReadinessIssue[];
  /** Which path produced this: the CLI (can start a scan) or the read-only API. */
  source: 'cli' | 'api' | 'none';
  /** Why it is empty, when it is. */
  error: string | null;
}

// ─── Per-page inventory (transcript reqs. 5 + 6) ─────────────────────────────

/** Stable issue codes. Deliberately closed — the UI groups on these. */
export type PageIssueCode =
  | 'page-error'
  | 'title-missing'
  | 'title-too-short'
  | 'title-too-long'
  | 'meta-missing'
  | 'meta-too-short'
  | 'meta-too-long'
  | 'h1-missing'
  | 'h1-multiple'
  | 'canonical-missing'
  | 'json-ld-missing'
  | 'json-ld-invalid'
  | 'thin-content'
  | 'noindex';

export interface AuditPageResult {
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
  jsonLdTypes: string[];
  jsonLdValid: boolean;
  jsonLdCount: number;
  issues: PageIssueCode[];
  /** 0-100 from the disclosed rubric in seo-rubric.ts. */
  score: number;
}

export interface PageInventoryAnalysis {
  /** How many sitemap URLs existed before the crawl budget was applied. */
  discovered: number;
  crawled: number;
  /** Budget that produced `crawled`, so a truncated run is self-describing. */
  budget: number;
  ok: number;
  errored: number;
  /** Mean page score across successfully fetched pages. */
  averageScore: number | null;
  /** How many pages carry each issue code. */
  issueCounts: Record<string, number>;
  /** The worst pages by score, for the report's "fix these first" list. */
  worstPages: Array<{ url: string; score: number; issues: PageIssueCode[] }>;
  pagesWithoutJsonLd: number;
  pagesWithBadTitle: number;
  pagesWithBadMeta: number;
}

// ─── Run-over-run comparison ────────────────────────────────────────────────

export type DeltaDirection = 'improved' | 'regressed' | 'unchanged' | 'new';

/**
 * One measured movement between two runs. `metric` is a stable key so the UI
 * can chart a series without knowing which check produced it.
 */
export interface AuditDelta {
  metric: string;
  label: string;
  previous: number | null;
  current: number | null;
  change: number | null;
  direction: DeltaDirection;
  /** True when a higher number is better — the UI needs it to colour the arrow. */
  higherIsBetter: boolean;
}

/** The full previous-vs-current comparison for the trend view. */
export interface AuditComparison {
  currentAuditId: string;
  previousAuditId: string | null;
  currentAt: string;
  previousAt: string | null;
  deltas: AuditDelta[];
  /** Pages that appeared, vanished, or changed score between the two runs. */
  pageChanges: {
    added: string[];
    removed: string[];
    improved: Array<{ url: string; from: number; to: number }>;
    regressed: Array<{ url: string; from: number; to: number }>;
  };
}
