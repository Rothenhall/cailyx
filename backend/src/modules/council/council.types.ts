/**
 * Council Types — multi-agent intervention debate (Agent #10, Swarm layer).
 *
 * Several role-agents argue over which interventions will most improve AI
 * visibility; a synthesizer ranks them. The council reads ONLY artefacts other
 * modules already produced (gap-analysis, measurement, journeys, link graph,
 * technical/entity audits) — it never proposes new measurement.
 *
 * @module council.types
 */

export type CouncilStatus = 'running' | 'complete' | 'failed';
export type CouncilSource = 'deterministic' | 'llm';

/** Debating roles. `synthesizer` doesn't vote — it aggregates. */
export type AgentRole =
  | 'technical'
  | 'content'
  | 'authority'
  | 'measurement'
  | 'narrative'
  | 'skeptic';

export const AGENT_ROLES: readonly AgentRole[] = [
  'technical',
  'content',
  'authority',
  'measurement',
  'narrative',
  'skeptic',
];

export type Vote = 'for' | 'against' | 'conditional';

/** A visibility lever, derived from existing artefacts. */
export interface Candidate {
  key: string;
  title: string;
  /** visibility dimension — aligns with gap-analysis dimensions. */
  dimension: 'machine-access' | 'extractability' | 'authority' | 'entity-clarity' | 'narrative' | 'architecture';
  /** artefact references that motivated this candidate. */
  sourceRefs: string[];
  /** rough evidence strength = distinct artefact types backing it (1..n). */
  evidenceBreadth: number;
  /** baseline effort guess from the dimension. */
  effort: 'low' | 'medium' | 'high';
}

export interface AgentPosition {
  interventionKey: string;
  vote: Vote;
  weight: number; // 0..1
  rationale: string;
}

export interface AgentContribution {
  round: number;
  agentRole: AgentRole;
  summary: string;
  positions: AgentPosition[];
}

export interface RankedIntervention {
  rank: number;
  interventionKey: string;
  title: string;
  rationale: string;
  consensus: number; // 0..1
  expectedImpact: number; // 0..100
  effort: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  sourceRefs: string[];
  dissent: string | null;
}

export interface RunCouncilInput {
  question?: string;
  rounds?: number;
  agentRoles?: AgentRole[];
  useLlm?: boolean;
}

export const COUNCIL_LIMITS = {
  rounds: { min: 1, max: 3, default: 1 },
  maxCandidates: 40,
} as const;
