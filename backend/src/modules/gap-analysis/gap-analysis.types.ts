/**
 * Gap Analysis Types — the flowchart's stage 8 ("Findings & Opportunity
 * Analysis"): consolidate everything every audit module has found, sort it
 * into issue/gap/opportunity/strength/risk, and prioritise by impact × effort.
 *
 * Two axes existed before this pass (`dimension`, `action`) and stay —
 * they're a topic/response classification, orthogonal to what's new here.
 * `category` is the SWOT-style read the flowchart actually asks for, and
 * `impact`/`effort`/`quadrant` are the classic prioritisation matrix
 * ("Prioritize by Impact & Effort") that `priorityScore` (demand × credibility
 * × citation) never was — that formula is PR/outreach-specific and stays for
 * the `influence` gaps it was built for, untouched.
 *
 * @module gap-analysis.types
 */

export type GapDimension = 'visibility' | 'narrative' | 'topic' | 'format' | 'web-mentions' | 'demand';
export type GapAction = 'fix' | 'build' | 'influence';
export type GapStatus = 'open' | 'in-progress' | 'resolved';

/**
 * The SWOT-style read: what KIND of finding this is, independent of what
 * area it's in (`dimension`) or what response it calls for (`action`).
 *
 * `strength` is the one category nothing in this codebase produced before
 * this pass — every check elsewhere is deficit-framed. A strength is never
 * scored by impact/effort (there's nothing to prioritise fixing), so
 * `impactScore`/`effortScore`/`quadrant` stay null on a strength row by
 * construction — see {@link computeQuadrant}.
 */
export type GapCategory = 'issue' | 'gap' | 'opportunity' | 'strength' | 'risk';

export const GAP_CATEGORIES: readonly GapCategory[] = ['issue', 'gap', 'opportunity', 'strength', 'risk'];

export const GAP_CATEGORY_LABELS: Record<GapCategory, string> = {
  issue: 'Issue',
  gap: 'Gap',
  opportunity: 'Opportunity',
  strength: 'Strength',
  risk: 'Risk',
};

/**
 * The classic impact/effort prioritisation matrix. Computed, never stored as
 * a raw guess — see {@link computeQuadrant}.
 */
export type ImpactEffortQuadrant = 'quick-win' | 'major-project' | 'fill-in' | 'thankless-task';

export const QUADRANT_LABELS: Record<ImpactEffortQuadrant, string> = {
  'quick-win': 'Quick win',
  'major-project': 'Major project',
  'fill-in': 'Fill-in',
  'thankless-task': 'Thankless task',
};

/**
 * Every source `sync()` now consolidates. The original four (technical
 * findings + three entity-audit tables) stay; everything below `model-diff`
 * is new — the whole point of "consolidate ALL findings" is that a client's
 * digital-presence gaps, competitor deficits, unranked keywords and AEO
 * standing are gap-analysis inputs too, not just technical/entity findings.
 */
export type GapSourceType =
  | 'technical-finding'
  | 'page-inventory-issue'
  | 'technical-strength'
  | 'schema-check'
  | 'platform-record'
  | 'model-diff'
  | 'presence-gap'
  | 'presence-review'
  | 'presence-strength'
  | 'tech-stack-gap'
  | 'tech-stack-strength'
  | 'competitor-gap'
  | 'competitor-strength'
  | 'serp-gap'
  | 'serp-strength'
  | 'aeo-gap'
  | 'aeo-risk'
  | 'aeo-strength';

/**
 * The nine buckets stage 9 ("Strategy & Recommendations") groups an action
 * plan into — literally the flowchart's own leaves, not a paraphrase, so the
 * UI can render exactly what was drawn.
 */
export type RecommendationCategory =
  | 'seo-improvements'
  | 'content-strategy'
  | 'social-strategy'
  | 'reputation-strategy'
  | 'search-aeo-strategy'
  | 'conversion-optimization'
  | 'technology-improvements'
  | 'advertising-opportunities'
  | 'market-expansion';

export const RECOMMENDATION_CATEGORIES: readonly RecommendationCategory[] = [
  'seo-improvements',
  'content-strategy',
  'social-strategy',
  'reputation-strategy',
  'search-aeo-strategy',
  'conversion-optimization',
  'technology-improvements',
  'advertising-opportunities',
  'market-expansion',
];

export const RECOMMENDATION_LABELS: Record<RecommendationCategory, string> = {
  'seo-improvements': 'SEO Improvements',
  'content-strategy': 'Content Strategy',
  'social-strategy': 'Social Strategy',
  'reputation-strategy': 'Reputation / Review Strategy',
  'search-aeo-strategy': 'Search / AEO Strategy',
  'conversion-optimization': 'Conversion Optimization',
  'technology-improvements': 'Technology Improvements',
  'advertising-opportunities': 'Advertising Opportunities',
  'market-expansion': 'Market Expansion Opportunities',
};

/**
 * Classification mapping row — exported for review/tuning (SPEC §4.4: should
 * become DB-backed/tunable when engagement tuning demand emerges).
 *
 * `impact`/`effort` are disclosed 1-5 bands, same discipline as
 * `seo-rubric.ts`'s `SEO_DEDUCTIONS` — a defensible, tunable table rather
 * than a formula this module would have to invent and justify per-row. Both
 * are `null` on every `strength` rule: a strength has nothing to prioritise
 * fixing, so scoring it on a fix-effort scale would be a category error, not
 * a real answer.
 */
export interface ClassificationRule {
  sourceType: GapSourceType;
  /** For technical findings: finding.type. For entity: inferred subtype key. For the new sources: a stable key this module defines. */
  sourceKey: string;
  /** Pattern match: exact, or substring fallback (see `classify()`). */
  match: string;
  dimension: GapDimension;
  action: GapAction;
  category: GapCategory;
  recommendationCategory: RecommendationCategory | null;
  impact: 1 | 2 | 3 | 4 | 5 | null;
  effort: 1 | 2 | 3 | 4 | 5 | null;
  /** Human-readable title template — `{{...}}` markers are interpolated at sync time. */
  title: string;
}

export interface GapDto {
  id: string;
  gapAnalysisId: string;
  sourceType: string;
  sourceId: string;
  dimension: GapDimension;
  dimensionAutoAssigned: boolean;
  action: GapAction;
  actionAutoAssigned: boolean;
  category: GapCategory;
  categoryAutoAssigned: boolean;
  recommendationCategory: RecommendationCategory | null;
  impactScore: number | null;
  effortScore: number | null;
  quadrant: ImpactEffortQuadrant | null;
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

/**
 * High impact, low effort → do it now. High impact, high effort → plan it.
 * Low impact either way is background work. The 1-5 scale splits at its
 * midpoint (3) for "high", giving four evenly-defined quadrants rather than a
 * threshold this module would have to justify per band.
 *
 * @returns `null` for a `strength` (nothing to prioritise) or when either
 *   score is missing.
 */
export function computeQuadrant(
  impact: number | null,
  effort: number | null,
): ImpactEffortQuadrant | null {
  if (impact == null || effort == null) return null;
  const highImpact = impact >= 3;
  const lowEffort = effort <= 2;
  if (highImpact && lowEffort) return 'quick-win';
  if (highImpact && !lowEffort) return 'major-project';
  if (!highImpact && lowEffort) return 'fill-in';
  return 'thankless-task';
}
