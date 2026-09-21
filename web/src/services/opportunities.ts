import { api } from '@/lib/api';
import type { ContentAssetType, GrowthAsset } from './content';

/**
 * Opportunities service adapter — P07 (platform_improvement_plan.md
 * §12.5-§12.7). The canonical `Opportunity` ("idea") record read/write
 * surface. `/content/opportunities` (CT01) is this model's canonical home
 * per §12.5 — other screens (Competitors, Website, Reports) should link into
 * a filtered view of these rows rather than keeping a separate copy.
 */

export const OPPORTUNITY_ORIGINS = [
  'search-gap',
  'ai-question-gap',
  'refresh',
  'client-request',
  'editorial-idea',
] as const;
export type OpportunityOrigin = (typeof OPPORTUNITY_ORIGINS)[number];

export const OPPORTUNITY_ORIGIN_LABELS: Record<OpportunityOrigin, string> = {
  'search-gap': 'Search gap',
  'ai-question-gap': 'AI question gap',
  refresh: 'Refresh',
  'client-request': 'Client request',
  'editorial-idea': 'Editorial idea',
};

export type OpportunityStatus = 'new' | 'in-progress' | 'dismissed' | 'converted';
export type PositionStatus = 'ranked' | 'unknown' | 'not-observed';

export interface OpportunityEvidence {
  kind: string;
  capturedAt: string;
  query: string | null;
  locationName: string | null;
  languageCode: string | null;
  device: string | null;
  checkedDepth: number | null;
  competitorId: string | null;
  competitorName: string | null;
  competitorPosition: number | null;
  clientPosition: number | null;
  sourceId: string | null;
  note: string;
}

export interface Opportunity {
  id: string;
  projectId: string;
  origin: OpportunityOrigin;
  topic: string;
  topicDisplay: string;
  market: string | null;
  language: string | null;
  intent: string;
  evidenceSourceFamily: string;
  reason: string;
  evidence: OpportunityEvidence[];
  measuredAt: string;
  clientPositionStatus: PositionStatus;
  clientPosition: number | null;
  rivalPositionStatus: PositionStatus;
  rivalPosition: number | null;
  rivalName: string | null;
  rivalCompetitorId: string | null;
  relevance: number;
  demandVolume: number | null;
  demandCpc: number | null;
  demandCompetition: string | null;
  suggestedContentType: string | null;
  existingContentMatchId: string | null;
  status: OpportunityStatus;
  dismissedReason: string | null;
  dismissedAt: string | null;
  linkedGrowthAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyzeOpportunitiesResult {
  projectId: string;
  analyzedAt: string;
  serpQueriesConsidered: number;
  confirmedCompetitorsConsidered: number;
  created: number;
  updated: number;
  unchanged: number;
  opportunities: Opportunity[];
  note: string;
}

/** Runs the observed-corpus keyword-gap analysis (§12.6) and upserts canonical rows. Never duplicates on re-run. */
export async function analyzeOpportunities(
  projectId: string,
  input: { keywordSetId?: string; marginThreshold?: number } = {},
): Promise<AnalyzeOpportunitiesResult> {
  return api.post<AnalyzeOpportunitiesResult>(`/projects/${projectId}/opportunities/analyze`, input);
}

export interface ListOpportunitiesQuery {
  status?: OpportunityStatus;
  origin?: OpportunityOrigin;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listOpportunities(
  projectId: string,
  query: ListOpportunitiesQuery = {},
  options?: { signal?: AbortSignal },
): Promise<{ total: number; page: number; pageSize: number; opportunities: Opportunity[] }> {
  return api.get(`/projects/${projectId}/opportunities`, {
    ...options,
    query: { status: query.status, origin: query.origin, search: query.search, page: query.page, pageSize: query.pageSize },
  });
}

/**
 * Client-portal read of the same queue — "Digital Marketing → Ideation"
 * (2026-09-21 client-nav restructure). Read-only: the client-portal backend
 * route (`OpportunitiesPortalController`) exposes only `GET`, so there is no
 * dismiss/reopen/convert here. `clientId` scoping happens server-side from the
 * JWT, same as every other `portal/projects/:projectId/...` read.
 */
export async function listPortalOpportunities(
  projectId: string,
  query: ListOpportunitiesQuery = {},
  options?: { signal?: AbortSignal },
): Promise<{ total: number; page: number; pageSize: number; opportunities: Opportunity[] }> {
  return api.get(`/portal/projects/${projectId}/opportunities`, {
    ...options,
    query: { status: query.status, origin: query.origin, search: query.search, page: query.page, pageSize: query.pageSize },
  });
}

export async function dismissOpportunity(projectId: string, opportunityId: string, reason: string): Promise<Opportunity> {
  return api.patch<Opportunity>(`/projects/${projectId}/opportunities/${opportunityId}/dismiss`, { reason });
}

export async function reopenOpportunity(projectId: string, opportunityId: string, reason: string): Promise<Opportunity> {
  return api.patch<Opportunity>(`/projects/${projectId}/opportunities/${opportunityId}/reopen`, { reason });
}

/** Generates a fresh idempotency key per confirmed click — the caller must not reuse one across distinct user intents. */
export function newIdempotencyKey(): string {
  return `opp-convert-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ConvertOpportunityResult {
  opportunity: Opportunity;
  asset: GrowthAsset;
  created: boolean;
}

/** §12.7 "Create content" — idempotent. A retried call with the same key (or a second call once already linked) returns the existing draft, never a duplicate. */
export async function convertOpportunityToContent(
  projectId: string,
  opportunityId: string,
  input: { idempotencyKey: string; assetType?: ContentAssetType },
): Promise<ConvertOpportunityResult> {
  return api.post<ConvertOpportunityResult>(`/projects/${projectId}/opportunities/${opportunityId}/convert`, input);
}

/** "Research a search term" (§12.6 R29 / §12.7) — reuses keyword-research's existing vendor call and cost gates unchanged. */
export async function researchSearchTerm(
  projectId: string,
  input: { keyword: string; locationName?: string; languageCode?: string },
): Promise<unknown> {
  return api.post(`/projects/${projectId}/opportunities/research-term`, input);
}
