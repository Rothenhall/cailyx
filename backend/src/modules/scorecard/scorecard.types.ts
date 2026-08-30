/**
 * Types for the Scorecard module (PRD §13 Rung 0 — the free trigger generator).
 *
 * @module scorecard.types
 */

/** One named, specific problem on the scorecard (exactly 3 per run). */
export interface ScorecardProblem {
  /** Scoring dimension it comes from (machine-access, entity-clarity, …). */
  dimension: string;
  /** Dimension value 0-100; null when the source evidence is missing. */
  value: number | null;
  /** The specific, named problem — first-class evidence line from the run. */
  why: string;
  /** Deterministic next move for this dimension. */
  fix: string;
  /** Supporting evidence lines (reproduction-grade, FR-8.3). */
  evidence: string[];
}

/** The Rung-0 contract: score, band, 3 named problems, non-obvious guarantee. */
export interface ScorecardResult {
  id: string;
  projectId: string;
  score: number;
  band: string;
  problems: ScorecardProblem[];
  /** SOP guarantee: at least one problem the prospect couldn't know without us. */
  nonObvious: boolean;
  depth: string;
  publicToken: string;
  createdAt: string;
}