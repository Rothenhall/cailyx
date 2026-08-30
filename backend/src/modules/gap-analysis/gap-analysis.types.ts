/**
 * Gap Analysis Types — 6-dimension / fix|build|influence roadmap.
 *
 * Consumes findings from technical-audit (AuditFinding) and entity-audit
 * (SchemaCheck, PlatformRecord, ModelDiff) via a mapping table.
 *
 * @module gap-analysis.types
 */

export type GapDimension = 'visibility' | 'narrative' | 'topic' | 'format' | 'web-mentions' | 'demand';
export type GapAction = 'fix' | 'build' | 'influence';
export type GapStatus = 'open' | 'in-progress' | 'resolved';
export type GapSourceType = 'technical-finding' | 'schema-check' | 'platform-record' | 'model-diff';

/**
 * Classification mapping row — exported for review/tuning.
 * SPEC §4.4: this table should be reviewable and eventually DB-backed.
 */
export interface ClassificationRule {
  sourceType: GapSourceType;
  /** For technical findings: finding.type (robots|cdn-inferred|js-render|cwv|schema). For entity: inferred subtype key. */
  sourceKey: string;
  /** Pattern match: exact or prefix* */
  match: string;
  dimension: GapDimension;
  action: GapAction;
  /** Human-readable title template, {{entityName}} etc. may be interpolated */
  title: string;
  /** Severity-derived priority hint, not persisted */
  severityHint?: string;
}

export interface GapDto {
  id: string;
  gapAnalysisId: string;
  sourceType: GapSourceType;
  sourceId: string;
  dimension: GapDimension;
  dimensionAutoAssigned: boolean;
  action: GapAction;
  actionAutoAssigned: boolean;
  demandPotential: number | null;
  credibilityImpact: number | null;
  citationLikelihood: number | null;
  priorityScore: number | null;
  status: GapStatus;
  title: string;
  description: string;
  severity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapGroup {
  action: GapAction;
  gaps: GapDto[];
  count: number;
}
