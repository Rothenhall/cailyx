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

/* ── SEO audit (Search Console data + fixes) ────────────────────────────── */

export interface SeoAuditSummary {
  id: string;
  createdAt: string;
  score: number | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  page1Queries: number;
  top3Queries: number;
  windowDays: number;
  previousAuditId: string | null;
  triggeredBy: string;
}

export interface SeoQueryRow {
  id: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  positionDelta: number | null;
  impressionsDelta: number | null;
  clicksDelta: number | null;
  topPage: string | null;
  /** JSON string[] of opportunity codes */
  opportunities: string;
}

export interface SeoPageRow {
  id: string;
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  coverageState: string | null;
  indexVerdict: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  /** JSON: [{ code, severity, detail, fix, fixArtifact? }] */
  issues: string | null;
  /** JSON string[] */
  richResults: string | null;
  /** JSON: [{ type, issues: [{ severity, message }] }] */
  richIssues: string | null;
}

export interface SeoFinding {
  id: string;
  type: string;
  status: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  recommendedFix: string;
  /** JSON string[] of affected URLs / queries */
  affected: string | null;
  count: number;
  fixArtifact: string | null;
  /** e.g. "submit-sitemap" — an action Cailyx can take from the report */
  action: string | null;
}

export interface SeoAudit extends SeoAuditSummary {
  siteUrl: string;
  deltas?: string | AuditDelta[] | null;
  /** JSON: { prev, timeseries: [{date,clicks,impressions,ctr,position}] } */
  metrics: string | null;
  pagesInspected: number;
  observability: string | null;
  narrative: string | null;
  narrativeModel: string | null;
  findings: SeoFinding[];
  queries: SeoQueryRow[];
  pages: SeoPageRow[];
}

export interface SeoPageChanges {
  improved: Array<{ url: string; from: number; to: number }>;
  regressed: Array<{ url: string; from: number; to: number }>;
  nowIndexed: string[];
  lostIndex: string[];
  nowClean: string[];
  added: string[];
  dropped: string[];
}

export interface SeoQueryChanges {
  enteredPage1: Array<{ query: string; from: number | null; to: number }>;
  leftPage1: Array<{ query: string; from: number; to: number | null }>;
}

export interface SeoComparison {
  currentAuditId: string;
  previousAuditId: string | null;
  currentAt: string;
  previousAt: string | null;
  deltas: AuditDelta[];
  pageChanges: SeoPageChanges;
  queryChanges: SeoQueryChanges;
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

/* ── AEO audit (answer-engine visibility) ───────────────────────────── */

/** The answer engines the audit measures, plus the test-only mock. */
export type AeoSurface =
  | 'chatgpt-browser'
  | 'perplexity-browser'
  | 'gemini-browser'
  | 'cloro-chatgpt'
  | 'cloro-perplexity'
  | 'cloro-gemini'
  | 'cloro-ai-overview'
  | 'cloro-ai-mode'
  | 'mock';

export type AeoSurfaceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** How an engine positioned the client. Judged by an LLM — never a rate. */
export type AeoStance =
  | 'recommended-primary'
  | 'recommended-alternative'
  | 'mentioned-neutral'
  | 'mentioned-negative'
  | 'absent';

export type AeoDimension =
  | 'service-discovery'
  | 'category-best-of'
  | 'competitor-alternatives'
  | 'head-to-head'
  | 'brand-direct'
  | 'problem-framed'
  | 'buying-criteria'
  | 'objection-trust'
  | 'job-to-be-done'
  | 'geo-vertical';

export interface AeoSliceMetrics {
  prompts: number;
  observations: number;
  mentionRate: number;
  citationRate: number;
}

/** One engine inside an audit — including why it produced nothing, if it did. */
export interface AeoSurfaceRun {
  surface: AeoSurface;
  label: string;
  status: AeoSurfaceStatus;
  runId: string | null;
  observations: number;
  stanceJudged: number;
  costUsd: number;
  failureKind: string | null;
  error: string | null;
}

export interface AeoSurfaceComparison extends AeoSliceMetrics {
  surface: AeoSurface;
  label: string;
  status: AeoSurfaceStatus;
  unbrandedMentionRate: number;
  stanceCounts: Record<AeoStance, number>;
  rivalsAheadCount: number;
}

export interface AeoDimensionResult extends AeoSliceMetrics {
  dimension: AeoDimension;
  label: string;
  stanceCounts: Record<AeoStance, number>;
}

/** Per-market roll-up (wave-6 D8) — one entry per market actually measured. */
export interface MarketResult extends AeoSliceMetrics {
  market: string;
}

export interface AeoCompetitorStanding {
  name: string;
  observations: number;
  mentionRate: number;
  clientAheadCount: number;
  clientBehindCount: number;
  wonWhileClientAbsent: number;
}

export interface AeoPromptEvidence {
  prompt: string;
  dimension: AeoDimension | null;
  losesTo?: string[];
  recommendedOver?: string[];
  evidenceQuote: string | null;
}

/**
 * The report. `counted` and `judged` are separate on purpose: counted numbers
 * come from deterministic extraction over n>=5 repeats and may be quoted as
 * rates; judged values are an LLM reading the same answers and never may be.
 */
export interface AeoVerdict {
  surface: string;
  surfaceRuns: AeoSurfaceRun[];
  runCount: number;
  generatedAt: string;
  counted: {
    overall: AeoSliceMetrics;
    unbranded: AeoSliceMetrics;
    branded: AeoSliceMetrics;
    byDimension: AeoDimensionResult[];
    byFunnelStage: Array<AeoSliceMetrics & { funnelStage: string }>;
    shareOfVoice: Array<{ name: string; share: number }>;
    competitors: AeoCompetitorStanding[];
    bySurface: AeoSurfaceComparison[];
    /** One entry per market actually measured — never a duplicate of `overall` for a single-market audit. */
    byMarket: MarketResult[];
  };
  judged: {
    available: boolean;
    unavailableReason?: string;
    judgeModel?: string;
    observationsJudged: number;
    stanceCounts: Record<AeoStance, number>;
    losingPrompts: AeoPromptEvidence[];
    winningPrompts: AeoPromptEvidence[];
  };
  headlines: string[];
}

export interface AeoAuditSummary {
  id: string;
  surface: string;
  tier: string;
  status: string;
  stage: string | null;
  promptCount: number;
  observations: number;
  stanceJudged: number;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AeoAudit extends AeoAuditSummary {
  projectId: string;
  contextId: string | null;
  querySetId: string | null;
  runId: string | null;
  runCount: number;
  verdict: AeoVerdict | null;
}

/** What the client sells, read off their own site — the matrix's raw material. */
/**
 * Pre-flight cost for a run the operator has not started.
 *
 * `remaining` and `fits` are null when the balance could not be read — an
 * unknown balance is neither sufficient nor insufficient, and showing either
 * would be a guess presented as a budget.
 */
export interface AeoBudget {
  required: number;
  remaining: number | null;
  fits: boolean | null;
  unavailableReason: string | null;
  perSurface: Array<{ surface: string; label: string; credits: number; metered: boolean }>;
  calls: number;
  prompts: number;
  runCount: number;
  markets: number;
}

export interface AeoContext {
  id: string;
  domain: string;
  brand: string;
  category: string | null;
  vertical: string | null;
  description: string | null;
  geo: string | null;
  /** Service areas the site names, ranked, ISO-3166 alpha-2 codes (wave-6 D8) — `[]` without LLM synthesis. */
  markets: string[];
  services: string[];
  icp: string[];
  valueProps: string[];
  painPoints: string[];
  outcomes: string[];
  competitors: Array<{ name: string; domain: string | null }>;
  pagesFetched: number;
  pageUrls: string[];
  extraction: 'deterministic' | 'llm-synthesized';
  llmModel: string | null;
  costUsd: number;
  createdAt?: string;
}

export interface AeoMatrixPrompt {
  id: string;
  prompt: string;
  dimension: AeoDimension | null;
  funnelStage: string;
  meta: {
    dimension: AeoDimension;
    register: 'terse' | 'conversational';
    branding: 'branded' | 'unbranded';
    service?: string;
    competitor?: string;
    icp?: string;
    geo?: string;
    template: string;
    refined: boolean;
  } | null;
}

export interface AeoMatrix {
  querySetId: string;
  version: number;
  status: string;
  tier: string;
  promptCount: number;
  refined: boolean;
  byDimension: Array<{
    dimension: AeoDimension;
    label: string;
    count: number;
    branded: number;
    unbranded: number;
    prompts: AeoMatrixPrompt[];
  }>;
  /** Categories that could not be built, each with a stated reason. */
  skipped: Array<{ dimension: string; reason: string }>;
  costUsd?: number;
}

// ─── Digital presence ──────────────────────────────────────────────────────

/** The five categories stage 2 of the delivery flow asks about, plus personal. */
export type PresenceGroup =
  | 'social'
  | 'directory'
  | 'review'
  | 'marketplace'
  | 'publishing'
  | 'personal'
  | 'other';

/**
 * Whose profile this is. The audit is about the company — a founder's personal
 * LinkedIn or Google Scholar page is recorded but never counted as company reach.
 */
export type PresenceEntity = 'company' | 'personal' | 'unknown';

/**
 * Three-valued on purpose. `unverified` means the account was found on the
 * client's own site but the platform refused the check — Instagram and Facebook
 * serve login walls, LinkedIn answers datacentre IPs with 999. It is not a
 * problem to fix, and rendering it as "missing" would report a working account
 * as absent.
 *
 * `candidate` is different again: found by Google search, not by the client's
 * own site, so we do not know it is theirs. It is never counted as an account
 * and never reaches a client report until an operator confirms it.
 */
export type PresenceState = 'confirmed' | 'unverified' | 'missing' | 'candidate';

export type PresenceSource = 'json-ld-sameas' | 'page-link' | 'manual' | 'serp';

export interface PresenceAccount {
  id: string;
  platform: string;
  label: string;
  group: PresenceGroup;
  url: string;
  handle: string | null;
  source: PresenceSource;
  sourceLabel: string;
  entity: PresenceEntity;
  state: PresenceState;
  /** Verbatim reason a check could not be completed. Only when `unverified`. */
  reason: string | null;
  statusCode: number | null;
  title: string | null;
  foundOn: string | null;
  verifiedAt: string | null;
  /** 0-1 name-similarity hint on `candidate` rows. Ordering aid, not a verdict. */
  confidence: number | null;
}

export interface PresenceGap {
  platform: string;
  label: string;
  group: PresenceGroup;
}

/** `not-checked` is not an absence — no module has looked yet. */
export type FootprintState = 'found' | 'none' | 'not-checked';

export interface FootprintItem {
  label: string;
  state: FootprintState;
  detail: string | null;
  /** Module that produced the fact, so a number can be traced home. */
  source: string;
}

export interface FootprintSection {
  key: 'identity' | 'owned' | 'connected' | 'answer-engines' | 'competitors';
  label: string;
  items: FootprintItem[];
}

/** Status of a job queued on the backend's pipeline queue (technical/SEO audit). */
export interface JobStatus<T> {
  status: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'not_found';
  result?: T;
  error?: string;
  attemptsMade?: number;
}

export interface PresenceRun {
  id: string;
  status: 'pending' | 'crawling' | 'verifying' | 'completed' | 'failed';
  pagesFetched: number;
  found: number;
  confirmed: number;
  unverified: number;
  candidates: number;
  serpQueries: number;
  /** Real DataForSEO charge for this run. Never estimated. */
  serpCostUsd: number;
  serpSkipped: string | null;
  sources: Record<string, number>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface PresenceInventory {
  projectId: string;
  domain: string;
  accounts: PresenceAccount[];
  counts: {
    total: number;
    confirmed: number;
    unverified: number;
    social: number;
    listing: number;
    manual: number;
    candidates: number;
    /** A founder's own profiles — reported separately, not company reach. */
    personal: number;
  };
  gaps: PresenceGap[];
  footprint: FootprintSection[];
  assessment: PresenceAssessment;
  lastRun: PresenceRun | null;
}

export type CoverageState = 'covered' | 'partial' | 'absent' | 'not-checked';

export interface CategoryCoverage {
  group: PresenceGroup;
  label: string;
  state: CoverageState;
  held: number;
  missing: string[];
  note: string;
}

/** The read on the company's current state online — facts and absences only. */
export type BusinessProfile =
  | 'b2b-services'
  | 'b2b-saas'
  | 'local-services'
  | 'consumer-brand'
  | 'default';

/** not-built = no code yet · not-configured = built, credentials absent here ·
 *  not-run = built and configured, nobody has pulled it for this project yet. */
export type CapabilityState = 'not-built' | 'not-configured' | 'not-run';

export interface CapabilityNote {
  label: string;
  state: CapabilityState;
  note: string;
}

export interface PresenceAssessment {
  /** Business type the expected platforms were derived from — a heuristic. */
  businessProfile: BusinessProfile;
  businessProfileLabel: string;
  /** The category text the guess came from, so a wrong guess is arguable. */
  inferredFrom: string | null;
  headlines: string[];
  coverage: CategoryCoverage[];
  /** What the module cannot see yet — three-valued, never a bare label, so
   *  "no code for this" is never confused with "built, but not configured
   *  here" or "configured, but not run for this project yet". */
  notMeasured: CapabilityNote[];
}

// ─── Competitors (wave-6 step 6) ───────────────────────────────────────────

/** One tech/schema/platform signature, and who has it. */
export interface GapDiffLine {
  key: string;
  client: boolean;
  /** Competitor names carrying this signature. */
  competitors: string[];
}

export interface GapDiff {
  client: string[];
  /** The client has it, no competitor does. */
  clientOnly: GapDiffLine[];
  /** Competitors have it, the client does not — the actionable half. */
  competitorsOnly: GapDiffLine[];
  shared: GapDiffLine[];
}

export interface AttachedAeoStanding {
  mentionRate: number;
  share: number;
  clientAheadCount: number;
  clientBehindCount: number;
}

export interface AttachedSerpPresence {
  seenInResults: boolean;
  occurrences: number;
  bestRank: number | null;
  sampleKeyword: string | null;
  capturedAt: string | null;
}

export interface GapCompetitorRow {
  competitorId: string;
  name: string;
  domain: string | null;
  /** `unknown` = no completed audit exists to attach, NOT "no presence". */
  aeoStatus: 'present' | 'absent' | 'unknown';
  aeoStanding: AttachedAeoStanding | null;
  serpStatus: 'present' | 'absent' | 'unknown';
  serpPresence: AttachedSerpPresence | null;
  /** Platform keys this rival was found on — company profiles only. */
  presencePlatforms: string[];
}

export interface CompetitorGap {
  projectId: string;
  domain: string;
  generatedAt: string;
  tech: GapDiff;
  schema: GapDiff;
  presence: GapDiff;
  competitors: GapCompetitorRow[];
  /** What this comparison is and is not. Rendered verbatim. */
  note: string;
}

export interface CompetitorPresenceAccount {
  platform: string;
  label: string;
  group: string;
  url: string;
  handle: string | null;
  state: string;
}

export interface CompetitorProfile {
  id: string;
  competitorId: string;
  domain: string | null;
  status: 'completed' | 'failed' | 'skipped';
  error: string | null;
  techScanId: string | null;
  schemaTypes: string[];
  aeoStatus: 'present' | 'absent' | 'unknown';
  aeoStanding: AttachedAeoStanding | null;
  serpStatus: 'present' | 'absent' | 'unknown';
  serpPresence: AttachedSerpPresence | null;
  presenceStatus: 'completed' | 'skipped' | 'failed' | 'unknown';
  presenceAccounts: CompetitorPresenceAccount[];
  presenceError: string | null;
  createdAt: string;
}

export interface CompetitorRow {
  id: string;
  projectId: string;
  name: string;
  domain: string | null;
  source: string;
  createdAt: string;
  latestProfile: CompetitorProfile | null;
}

// ─── Tech stack (wave-6 step 3) ────────────────────────────────────────────

export interface TechFinding {
  category: string;
  name: string;
  /** 0-1. Reported, never used as a gate. */
  confidence: number;
  /** What was actually matched — the evidence, not a guess. */
  evidence: string[];
}

export interface TechStackScan {
  id: string;
  projectId: string;
  domain: string;
  status: string;
  error: string | null;
  findings: TechFinding[];
  createdAt: string;
}

// ─── Keyword research (wave-6 step 4) ──────────────────────────────────────

export interface Keyword {
  id: string;
  keyword: string;
  searchVolume: number | null;
  /**
   * LOW | MEDIUM | HIGH — Google Ads **advertiser** competition, not organic
   * ranking difficulty. DataForSEO's Keywords Data has no such metric, so the
   * UI must never label this "difficulty".
   */
  competition: string | null;
  /** Same metric, 0-100. Same caveat. */
  competitionIndex: number | null;
  cpc: number | null;
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
  isRelated: boolean;
  isLongTail: boolean;
  createdAt: string;
}

export interface KeywordSet {
  id: string;
  projectId: string;
  seedInput: string[];
  locationName: string | null;
  languageCode: string | null;
  /** pending | completed | partial | failed. `partial` = expansion call failed. */
  status: string;
  error: string | null;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
  keywords: Keyword[];
}

// ─── Deliverables (reporting + scorecard) ──────────────────────────────────

export interface ReportSummary {
  slug: string;
  title: string;
  targetUrl: string;
  /** `public` means anyone with the link can read the client's audit. */
  visibility: 'private' | 'public';
  scoreTotal: number;
  scoreBand: string;
  createdAt: string;
}

export interface ScorecardRun {
  id: string;
  score: number;
  band: string;
  nonObvious: boolean;
  depth: string;
  publicToken: string;
  createdAt: string;
}
