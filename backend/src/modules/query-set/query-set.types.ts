/**
 * QuerySet Types — Versioned buyer prompt sets (SOP-1, PRD FR-5).
 *
 * A QuerySet is a versioned list of natural-language buyer prompts, tagged by
 * persona (problem/solution/product/most-aware) and funnel stage. Immutable
 * once activated - mutations create a new version. Subject owns + can export.
 * Minimum 100-300 prompts in the full product, smaller on free tier.
 * Seeded from real sources (sales questions, support tickets) in paid tiers.
 *
 * @module query-set.types
 */

export type PromptPersona = 'problem-aware' | 'solution-aware' | 'product-aware' | 'most-aware';
export type QuerySetStatus = 'draft' | 'active' | 'archived';
export type QuerySetSource = 'manual' | 'sales-questions' | 'support-tickets';
export type FunnelStage = 'problem-aware' | 'solution-aware' | 'product-aware' | 'most-aware';

export interface QuerySetDto {
  id: string;
  projectId: string;
  version: number;
  persona: PromptPersona;
  label: string | null;
  status: QuerySetStatus;
  source: QuerySetSource;
  itemCount: number;
  createdAt: string;
  activatedAt: string | null;
}

export interface QuerySetItemDto {
  id: string;
  querySetId: string;
  prompt: string;
  funnelStage: FunnelStage;
  createdAt: string;
}

export interface CreateQuerySetDto {
  projectId: string;
  persona: PromptPersona;
  label?: string;
}

export interface AddPromptDto {
  prompt: string;
  funnelStage: FunnelStage;
}
