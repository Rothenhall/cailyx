/**
 * Types for the Monitoring module (PRD 6.12, FR-12.1–12.4).
 *
 * @module monitoring.types
 */

/** Monitoring snapshot: one point-in-time health read. */
export interface MonitorSnapshot {
  projectId: string;
  scoreTotal: number | null;
  scoreBand: string | null;
  scoreRunId: string | null;
  mentionRate: number | null;
  citationRate: number | null;
  observations: number;
  crawlerHits: number;
  takenAt: string;
}

/** Delta between the two latest score runs (and measurement trend). */
export interface MonitorDelta {
  projectId: string;
  score: { before: number | null; after: number | null; change: number | null } | null;
  measurement: { observationsBefore: number | null; observationsAfter: number | null } | null;
  checkedAt: string;
}

/** Alert kinds raised by monitors. */
export type AlertKind = 'score-drop' | 'mention-drop' | 'scheduled-run-failed';