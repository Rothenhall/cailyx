import { api } from '@/lib/api';

/**
 * Priorities and roadmap adapter — design_plan.md screens PJ05, PJ06 and PJ07.
 *
 * Two separate backend reads feed these three screens, and keeping them apart
 * is the point:
 *
 *  - **Gap analysis** (`/projects/:id/gap-analysis`) is the evidence layer.
 *    A gap is a classified observation with a source (`sourceType` +
 *    `sourceId`), an auto-assigned dimension/action/category, and the
 *    `*AutoAssigned` flags that record whether an operator has overridden
 *    them. That last part is what stops a re-sync from silently reverting a
 *    deliberate decision, so the flags are carried through here verbatim and
 *    the screens render them rather than guessing.
 *  - **Strategy** (`/projects/:id/strategy`) is the plan layer. A
 *    recommendation bundles Gap ids and never copies their text, so a
 *    re-sync's updated evidence is never stale in the roadmap. The screen must
 *    therefore resolve the ids against the gap list instead of trusting any
 *    cached prose.
 *
 * `notCovered` is not an error: it names the recommendation categories with no
 * qualifying gap behind them yet. §3.5's "not measured yet" rule applies — the
 * screen shows the category as having no evidence to act on, never as a
 * category with zero work in it.
 */

// ── Vocabularies (mirroring gap-analysis.types.ts exactly) ──────────────

export type GapDimension =
  | 'visibility'
  | 'narrative'
  | 'topic'
  | 'format'
  | 'web-mentions'
  | 'demand';

export const GAP_DIMENSIONS: readonly GapDimension[] = [
  'visibility',
  'narrative',
  'topic',
  'format',
  'web-mentions',
  'demand',
];

export const GAP_DIMENSION_LABEL: Record<GapDimension, string> = {
  visibility: 'Visibility',
  narrative: 'Narrative',
  topic: 'Topic',
  format: 'Format',
  'web-mentions': 'Web mentions',
  demand: 'Demand',
};

export type GapAction = 'fix' | 'build' | 'influence';
export const GAP_ACTIONS: readonly GapAction[] = ['fix', 'build', 'influence'];

export const GAP_ACTION_LABEL: Record<GapAction, string> = {
  fix: 'Fix',
  build: 'Build',
  influence: 'Influence',
};

export type GapCategory = 'issue' | 'gap' | 'opportunity' | 'strength' | 'risk';
export const GAP_CATEGORIES: readonly GapCategory[] = [
  'issue',
  'gap',
  'opportunity',
  'strength',
  'risk',
];

export const GAP_CATEGORY_LABEL: Record<GapCategory, string> = {
  issue: 'Issue',
  gap: 'Gap',
  opportunity: 'Opportunity',
  strength: 'Strength',
  risk: 'Risk',
};

export type GapStatus = 'open' | 'in-progress' | 'resolved';
export const GAP_STATUSES: readonly GapStatus[] = ['open', 'in-progress', 'resolved'];

export const GAP_STATUS_LABEL: Record<GapStatus, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  resolved: 'Resolved',
};

/** impactScore × effortScore, computed server-side and never stored independently. */
export type ImpactEffortQuadrant =
  | 'quick-win'
  | 'major-project'
  | 'fill-in'
  | 'thankless-task';

export const QUADRANT_LABELS: Record<ImpactEffortQuadrant, string> = {
  'quick-win': 'Quick win',
  'major-project': 'Major project',
  'fill-in': 'Fill-in',
  'thankless-task': 'Thankless task',
};

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
  'seo-improvements': 'SEO improvements',
  'content-strategy': 'Content strategy',
  'social-strategy': 'Social strategy',
  'reputation-strategy': 'Reputation / review strategy',
  'search-aeo-strategy': 'Search / AEO strategy',
  'conversion-optimization': 'Conversion optimization',
  'technology-improvements': 'Technology improvements',
  'advertising-opportunities': 'Advertising opportunities',
  'market-expansion': 'Market expansion',
};

// ── Records ─────────────────────────────────────────────────────────────

export interface Gap {
  id: string;
  gapAnalysisId: string;
  /** Where the observation came from — e.g. "technical-finding", "presence-gap". */
  sourceType: string;
  /** The id of that source row. This is what makes the gap checkable. */
  sourceId: string;
  dimension: string;
  dimensionAutoAssigned: boolean;
  action: string;
  actionAutoAssigned: boolean;
  category: string;
  categoryAutoAssigned: boolean;
  recommendationCategory: string | null;
  /** 1-5. Null on a strength — there is nothing to prioritise fixing. */
  impactScore: number | null;
  /** 1-5. Null on a strength. */
  effortScore: number | null;
  scoreAutoAssigned: boolean;
  quadrant: string | null;
  /** 1-5 manual PR/outreach inputs. */
  demandPotential: number | null;
  credibilityImpact: number | null;
  citationLikelihood: number | null;
  /** Derived from the three inputs above, recomputed server-side. */
  priorityScore: number | null;
  status: string;
  title: string;
  description: string;
  copyAutoAssigned: boolean;
  severity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GapList {
  id: string;
  projectId: string;
  gaps: Gap[];
  count: number;
}

export interface RoadmapGroup {
  action: GapAction;
  gaps: Gap[];
  count: number;
}

export interface Roadmap {
  projectId: string;
  groups: RoadmapGroup[];
  total: number;
}

export interface MatrixQuadrant {
  quadrant: ImpactEffortQuadrant;
  gaps: Gap[];
  count: number;
}

export interface GapMatrix {
  projectId: string;
  quadrants: MatrixQuadrant[];
  total: number;
}

export interface Recommendation {
  id: string;
  category: RecommendationCategory;
  label: string;
  title: string;
  summary: string;
  /** Pointers into gap-analysis's own rows — resolve them, do not cache prose. */
  gapIds: string[];
  quickWinCount: number;
  majorProjectCount: number;
  fillInCount: number;
  thanklessTaskCount: number;
  /** 1 = act on first, ranked across the whole plan, not just within a category. */
  priorityRank: number;
  createdAt: string;
}

export interface ActionPlan {
  id: string;
  projectId: string;
  recommendations: Recommendation[];
  /** Categories with no evidence behind them yet — named, not hidden. */
  notCovered: RecommendationCategory[];
  createdAt: string;
  updatedAt: string;
}

// ── Gaps ────────────────────────────────────────────────────────────────

export async function listGaps(
  projectId: string,
  filter?: { dimension?: string; action?: string; category?: string; status?: string },
  options?: { signal?: AbortSignal },
): Promise<GapList> {
  return api.get<GapList>(`/projects/${projectId}/gap-analysis`, { ...options, query: filter });
}

export async function getGap(
  projectId: string,
  gapId: string,
  options?: { signal?: AbortSignal },
): Promise<Gap> {
  return api.get<Gap>(`/projects/${projectId}/gap-analysis/gaps/${gapId}`, options);
}

/**
 * Overrides a gap's classification and/or its priority inputs.
 *
 * Every field here flips the matching `*AutoAssigned` flag server-side, so the
 * next `syncGaps` will not revert it. That is why the screen shows which axes
 * are still automatic: an overridden axis and an automatic one look the same
 * on the wire otherwise.
 */
export interface PatchGapInput {
  dimension?: GapDimension;
  action?: GapAction;
  category?: GapCategory;
  status?: GapStatus;
  impactScore?: number;
  effortScore?: number;
  demandPotential?: number;
  credibilityImpact?: number;
  citationLikelihood?: number;
  title?: string;
  description?: string;
}

export async function patchGap(projectId: string, gapId: string, input: PatchGapInput) {
  return api.patch<Gap>(`/projects/${projectId}/gap-analysis/gaps/${gapId}`, input);
}

export async function getGapRoadmap(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<Roadmap> {
  return api.get<Roadmap>(`/projects/${projectId}/gap-analysis/roadmap`, options);
}

export async function getGapMatrix(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<GapMatrix> {
  return api.get<GapMatrix>(`/projects/${projectId}/gap-analysis/matrix`, options);
}

/**
 * Re-classifies every gap from the audit modules' latest stored findings.
 *
 * Read-only against the outside world: it never triggers a scan, a crawl or a
 * paid call. Idempotent, and it preserves operator overrides via the
 * `*AutoAssigned` flags.
 */
export async function syncGaps(projectId: string) {
  return api.post<{ created: number; updated: number; pruned: number; count: number }>(
    `/projects/${projectId}/gap-analysis/sync`,
  );
}

// ── Strategy ────────────────────────────────────────────────────────────

/**
 * The stored action plan, or `null` when it has never been built.
 *
 * `null` is a real state — the server answers 404 with that meaning in the
 * body — and the roadmap screen renders it as "not built yet, build it or run
 * gap analysis first" rather than as an empty plan.
 */
export async function getActionPlan(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ActionPlan | null> {
  try {
    return await api.get<ActionPlan>(`/projects/${projectId}/strategy`, options);
  } catch (cause) {
    if (
      cause &&
      typeof cause === 'object' &&
      'kind' in cause &&
      (cause as { kind: string }).kind === 'not-found'
    ) {
      return null;
    }
    throw cause;
  }
}

/** Rebuilds the plan: re-runs gap sync, then re-groups every actionable gap. */
export async function buildActionPlan(projectId: string) {
  return api.post<ActionPlan>(`/projects/${projectId}/strategy/build`);
}

/** Resolves a recommendation's `gapIds` against a gap list the caller loaded. */
export function resolveRecommendationGaps(
  recommendation: Recommendation,
  gaps: readonly Gap[],
): Gap[] {
  const byId = new Map(gaps.map((gap) => [gap.id, gap]));
  return recommendation.gapIds
    .map((id) => byId.get(id))
    .filter((gap): gap is Gap => gap !== undefined);
}

/**
 * A stable key for a gap's evidence. The pair is what the backend upserts on,
 * so two runs of `syncGaps` that observe the same underlying fact produce the
 * same key and therefore the same row.
 */
export function gapEvidenceKey(gap: Gap): string {
  return `${gap.sourceType}:${gap.sourceId}`;
}

/** The 30/60/90 framing PJ07 asks for, as three named horizons. */
export const ROADMAP_HORIZONS = [
  { key: '30', label: 'First 30 days', fromDay: 0, toDay: 30 },
  { key: '60', label: 'Days 31–60', fromDay: 30, toDay: 60 },
  { key: '90', label: 'Days 61–90', fromDay: 60, toDay: 90 },
] as const;
