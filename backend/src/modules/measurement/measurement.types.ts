/**
 * Measurement Types — AI surface observation runs (PRD §6.6-6.7, SOP-2).
 *
 * Rates, never positions: everything downstream reports normalized rates
 * ("cited in 3 of 5 runs"), structured Observations are what compute them.
 *
 * @module measurement.types
 */

/** Surfaces measureable in v1 + the test-only mock. */
export type Surface = 'claude' | 'perplexity' | 'mock';

export const SURFACES: readonly Surface[] = ['claude', 'perplexity', 'mock'];

/** Run lifecycle. */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

/** PRD FR-6.4: structured per-observation record. */
export interface SurfaceAnswer {
  /** The natural-language answer text as shown to a user of the surface. */
  text: string;
  /** URLs the surface cited (order = result order on the surface). */
  citations: string[];
  costUsd: number;
  latencyMs: number;
  model: string;
}

/** One `Surface` adapter — add ChatGPT / Google AIO later without touching the service. */
export interface SurfaceAdapter {
  readonly name: Surface;
  /** Ask one question, fresh session, return the answer + citations. */
  runPrompt(prompt: string, geo: string): Promise<SurfaceAnswer>;
}

/** Request body for creating a run. */
export interface CreateRunInput {
  querySetId: string;
  surface: Surface;
  geo?: string; // country code, e.g. "US", "GB" — >=2 geos per PRD baseline
  runCount?: number;
}

/** Aggregated metric block (share-of-voice + rates, PRD FR-6.x / FR-7). */
export interface MeasurementSummary {
  runs: number;
  observations: number;
  mentionRate: number; // 0..1
  citationRate: number; // 0..1
  bySurface: Array<{ surface: string; observations: number; mentionRate: number; citationRate: number }>;
  byFunnelStage: Array<{ funnelStage: string; observations: number; mentionRate: number; citationRate: number }>;
  shareOfVoice: Array<{ name: string; share: number }>; // subject first, competitors after
}