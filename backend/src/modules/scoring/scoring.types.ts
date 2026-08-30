/**
 * Types for the Scoring module (PRD §8, FR-8.1–8.4).
 *
 * @module scoring.types
 */

/** The five §8 dimensions, in canonical order. */
export const DIMENSIONS = [
  'Machine access',
  'Entity clarity',
  'Shortlist presence',
  'On-page extractability',
  'Authority signal',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** PRD §8 default weights (sum to 100). */
export const DEFAULT_WEIGHTS: Record<Dimension, number> = {
  'Machine access': 25,
  'Entity clarity': 25,
  'Shortlist presence': 20,
  'On-page extractability': 20,
  'Authority signal': 10,
};

/** PRD §8 default bands. First matching row wins; the last row is the floor. */
export const DEFAULT_BANDS: Array<{ max: number; band: ScoreBand }> = [
  { max: 40, band: 'invisible' },
  { max: 60, band: 'faint' },
  { max: 80, band: 'present' },
  { max: 100, band: 'recommended' },
];

/** PRD §8 band names. */
export type ScoreBand = 'invisible' | 'faint' | 'present' | 'recommended';

/** How a dimension's evidence source fared this run. */
export type RunStatus = 'complete' | 'partial';

/** One dimension's scored result — everything links to its evidence (FR-8.3). */
export interface SubScore {
  dimension: Dimension;
  weight: number;
  /** 0-100 dimension value. */
  value: number;
  /** value × weight / 100, rounded — its contribution to the total. */
  contribution: number;
  /** Human-readable evidence lines; non-empty even on failure. */
  evidence: string[];
  /** FR-8.4: the evidence source is missing or failed the run. */
  partial: boolean;
  partialReason?: string;
}

export interface ScoringInput {
  machineAccess: DimensionInput;
  entityClarity: DimensionInput;
  shortlistPresence: DimensionInput;
  extractability: DimensionInput;
  authority: DimensionInput;
}

/** What a dimension evaluation produces before weighting. */
export interface DimensionInput {
  value: number | null;
  evidence: string[];
  partial: boolean;
  partialReason?: string;
}

export interface ScoringResult {
  rubricVersion: number;
  total: number;
  band: ScoreBand;
  status: RunStatus;
  subScores: SubScore[];
  createdAt: string;
  id: string;
}