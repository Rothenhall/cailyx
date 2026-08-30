/**
 * Entity Audit Types — Data models for entity consistency checks.
 *
 * @module entity-audit.types
 */

// ─── Entity ────────────────────────────────────────────────────

export type EntityType = 'brand' | 'product' | 'founder' | 'metric';

export interface Entity {
  id: string;
  name: string;
  descriptor?: string;
  type: EntityType;
  createdAt: string;
}

// ─── Schema Check ──────────────────────────────────────────────

export interface SchemaCheckResult {
  entityId: string;
  schemaType: string | null;
  fieldsPresent: string[];
  fieldsMissing: string[];
  sameAsCount: number;
  sameAsUrls: string[];
  sameAsVerification: SameAsVerificationResult[];
  status: 'pass' | 'fail' | 'error';
  checkedAt: string;
  recommendedFix: string;
}

export interface SameAsVerificationResult {
  url: string;
  resolves: boolean;
  identityMatch: boolean | null;
  title: string | null;
  statusCode: number | null;
}

// ─── Platform Record ────────────────────────────────────────────

export type Platform = 'linkedin' | 'g2' | 'crunchbase' | 'other';
export type ConsistencyStatus = 'match' | 'mismatch' | 'not-checked';

export interface PlatformRecord {
  id: string;
  entityId: string;
  platform: Platform;
  recordedName: string | null;
  recordedDescriptor: string | null;
  sourceUrl: string | null;
  consistencyStatus: ConsistencyStatus;
  createdAt: string;
}

// ─── Platform Consistency Result ─────────────────────────────────

export interface PlatformConsistencyCheck {
  platform: string;
  recordedName: string | null;
  entityName: string;
  consistencyStatus: 'match' | 'mismatch';
  sourceUrl: string | null;
  /** When semi-auto verify was used, the fetched title for debugging */
  fetchedTitle?: string | null;
}

// ─── Model Diff (deferred — see LEFT-OUT.md) ─────────────────────

export type ModelDiffStatus = 'not-run' | 'running' | 'completed' | 'error' | 'deferred';
export type AiProvider = 'openai' | 'anthropic' | 'perplexity' | 'google' | 'ollama';

export interface ModelDiffResult {
  id: string;
  entityId: string;
  prompt: string;
  provider: AiProvider;
  model?: string | null;
  rawAnswer?: string | null;
  citations?: string[];
  divergence?: DivergenceResult | null;
  status: ModelDiffStatus;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
  checkedAt: string;
}

export interface DivergenceResult {
  /** Overall divergence score 0..1 (0 = identical, 1 = completely divergent) */
  score: number;
  fieldMismatches: Array<{
    field: string;
    values: Record<string, string>;
    divergent: boolean;
  }>;
  summary: string;
}

// ─── Entity Audit Summary ──────────────────────────────────────

export interface EntityAuditSummary {
  id: string;
  projectId: string;
  createdAt: string;
  entities: EntityAuditEntity[];
}

export interface EntityAuditEntity extends Entity {
  schemaChecks: SchemaCheckResult[];
  platformRecords: PlatformRecord[];
  modelDiffs?: ModelDiffResult[];
}
