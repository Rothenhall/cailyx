/**
 * Journey Types — branching multi-step search journeys (Agent #2, Swarm layer).
 *
 * A Journey is a tree of natural-language search steps a single persona would
 * realistically run — an opening query, then refinements / branches /
 * comparisons / objection-checks — executed against an AI surface adapter.
 *
 * Boundary: every step is an API call to an AI surface or licensed SERP data.
 * No browser is driven as a fake human; no traffic, clicks, or impressions are
 * generated on a live surface. Execution defaults to the deterministic `mock`
 * adapter and only touches a live surface when `SWARM_ALLOW_LIVE=1` AND the
 * surface's key are both present.
 *
 * @module journey.types
 */

import type { PersonaAwareness } from '../persona/persona.types';

/** Surfaces a journey can run against (mirrors measurement's `Surface`). */
export type JourneySurface = 'mock' | 'claude' | 'perplexity';
export const JOURNEY_SURFACES: readonly JourneySurface[] = ['mock', 'claude', 'perplexity'];

export type JourneyStatus = 'planned' | 'running' | 'completed' | 'partial' | 'failed';
export type JourneyStepKind = 'query' | 'refinement' | 'branch' | 'comparison' | 'objection';
export type JourneyStepStatus = 'pending' | 'done' | 'failed' | 'skipped';
export type JourneyPlanSource = 'deterministic' | 'llm';

/** A node in the planned journey tree, before persistence. */
export interface PlannedStep {
  /** Stable within one plan — used to wire parent/child before we have DB ids. */
  localId: string;
  parentLocalId: string | null;
  depth: number;
  ordinal: number;
  kind: JourneyStepKind;
  awareness: PersonaAwareness;
  query: string;
  rationale: string;
}

export interface JourneyPlan {
  label: string;
  objective: string;
  source: JourneyPlanSource;
  model: string | null;
  steps: PlannedStep[];
}

export interface PlanJourneyInput {
  personaId: string;
  surface?: JourneySurface;
  geo?: string;
  maxDepth?: number;
  maxBranches?: number;
  /** Use an LLM to plan a richer tree. Requires ANTHROPIC_API_KEY (503 otherwise). */
  useLlm?: boolean;
}

export interface ExecuteJourneyResult {
  journeyId: string;
  status: JourneyStatus;
  stepCount: number;
  executedSteps: number;
  mentionedSteps: number;
  citedSteps: number;
  costUsd: number;
  note: string | null;
}

export interface CreateCampaignInput {
  name: string;
  surface?: JourneySurface;
  geo?: string;
  journeyTarget: number;
  maxDepth?: number;
  maxBranches?: number;
  personaRoles?: string[];
  budgetUsd: number;
  useLlm?: boolean;
  /** Plan + execute in the same call. Default true. */
  autoRun?: boolean;
}

/** Bounds — also enforced in the DTO. */
export const JOURNEY_LIMITS = {
  maxDepth: { min: 1, max: 6, default: 4 },
  maxBranches: { min: 1, max: 4, default: 2 },
  /** Hard ceiling on steps in a single journey, whatever depth/branches ask for. */
  maxStepsPerJourney: 60,
  journeyTarget: { min: 1, max: 200, default: 10 },
  budgetUsd: { min: 0.01, max: 100, default: 5 },
} as const;
