/**
 * Types for the Opportunities module — P07, platform_improvement_plan.md
 * §12.5-§12.7. Canonical content-opportunity ("idea") records.
 *
 * @module opportunities.types
 */

/** §12.5's exact origin list. Only `search-gap` and `editorial-idea` are
 * ever written by this build — see opportunities.service.ts's header for why
 * the other three are left unpopulated rather than faked. */
export const OPPORTUNITY_ORIGINS = [
  'search-gap',
  'ai-question-gap',
  'refresh',
  'client-request',
  'editorial-idea',
] as const;
export type OpportunityOrigin = (typeof OPPORTUNITY_ORIGINS)[number];

export type OpportunityStatus = 'new' | 'in-progress' | 'dismissed' | 'converted';

export type PositionStatus = 'ranked' | 'unknown' | 'not-observed';

/** One backing observation for an Opportunity. Appended to, never replaced,
 * on re-run — §12.6: "Allow multiple evidence records to reinforce one idea." */
export interface OpportunityEvidence {
  /** serp-keyword-gap-absent | serp-keyword-gap-below | keyword-research-topic-suggestion | manual-lookup */
  kind: string;
  capturedAt: string;
  /** Query/location/device this observation was captured with — preserved verbatim (§12.6). */
  query: string | null;
  locationName: string | null;
  languageCode: string | null;
  device: string | null;
  /** How many organic positions were actually checked (first-page snapshot size). Never implies deeper coverage than was captured. */
  checkedDepth: number | null;
  competitorId: string | null;
  competitorName: string | null;
  competitorPosition: number | null;
  clientPosition: number | null;
  sourceId: string | null;
  note: string;
}

export interface OpportunityDto {
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
  opportunities: OpportunityDto[];
  note: string;
}
