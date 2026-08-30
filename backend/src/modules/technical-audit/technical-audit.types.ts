/**
 * Technical Audit Types — Data models for audit findings.
 *
 * @module technical-audit.types
 */

// ─── Findings ───────────────────────────────────────────────────

export type AuditCheckType = 'robots' | 'cdn-inferred' | 'js-render' | 'cwv' | 'schema' | '404-hallucinated';
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

export type Cadence = 'weekly' | 'monthly' | 'manual-only';

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
