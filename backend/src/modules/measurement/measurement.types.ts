/**
 * Measurement Types — AI surface observation runs (PRD §6.6-6.7, SOP-2).
 *
 * Rates, never positions: everything downstream reports normalized rates
 * ("cited in 3 of 5 runs"), structured Observations are what compute them.
 *
 * @module measurement.types
 */

/**
 * Surfaces measureable today + the test-only mock.
 *
 * Two families:
 * - **`*-browser`** — the vendors' consumer products driven in Playwright with
 *   an operator-supplied session (decision D1-B, `docs/analysis/aeo-audit.md`).
 *   This is what a buyer actually sees, and what the AEO audit measures. All
 *   three are gated off by default and carry a ToS caveat — see
 *   `browser-surface.adapter.ts`.
 * - **`claude` / `perplexity`** — first-party API adapters, kept for the
 *   pre-existing measurement flows. Correlated with, but not equal to, the
 *   consumer products above.
 * - **`cloro-*`** — the consumer products queried through Cloro's API instead
 *   of a Playwright session (decision D1, `docs/analysis/wave-6-audit-pipeline.md`).
 *   Same motivation as `*-browser` without the ToS exposure; a failed
 *   `cloro-*` surface automatically falls back to its `*-browser` equivalent
 *   where one exists — see `aeo-audit.service.ts`.
 */
export type Surface =
  | 'chatgpt-browser'
  | 'perplexity-browser'
  | 'gemini-browser'
  | 'claude'
  | 'perplexity'
  | 'cloro-chatgpt'
  | 'cloro-perplexity'
  | 'cloro-gemini'
  | 'cloro-ai-overview'
  | 'cloro-ai-mode'
  | 'mock';

export const SURFACES: readonly Surface[] = [
  'chatgpt-browser',
  'perplexity-browser',
  'gemini-browser',
  'claude',
  'perplexity',
  'cloro-chatgpt',
  'cloro-perplexity',
  'cloro-gemini',
  'cloro-ai-overview',
  'cloro-ai-mode',
  'mock',
];

/** The consumer-product surfaces the AEO audit measures. */
export const BROWSER_SURFACES: readonly Surface[] = [
  'chatgpt-browser',
  'perplexity-browser',
  'gemini-browser',
];

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

/**
 * Aggregated metric block (share-of-voice + rates, PRD FR-6.x / FR-7).
 *
 * **Cohort.** These figures are computed over a selection of observations, and
 * the selection changes what they mean:
 *
 * - no `?runId=` → every observation stored for the project, across every run,
 *   surface and geo. This is the project's cumulative record; it is NOT a
 *   comparable cohort and must not be compared period-over-period, because
 *   between two calls the mix of surfaces and prompts can change underneath it.
 * - `?runId=` → the observations of that one run, which is a comparable cohort
 *   (one query set, one surface, one geo, one point in time).
 *
 * `bySurface` / `byFunnelStage` break the same selection down, so a caller that
 * needs a like-for-like comparison groups by surface rather than reading the
 * pooled headline.
 */
export interface MeasurementSummary {
  /** Every measurement run ever created for the project, any status — not the number of runs this summary aggregated. */
  runs: number;
  /** The size of the cohort the rates below were computed over. */
  observations: number;
  /**
   * Mention rate over the cohort, 0..1 — **null when `observations` is 0**.
   * A project with no observations has not been measured; reporting `0` there
   * would read as "the brand is never mentioned", which is a different and
   * unsupported claim (design_plan §3.3, rule 3: empty is not zero).
   */
  mentionRate: number | null;
  /** Citation rate over the cohort, 0..1 — null when `observations` is 0. */
  citationRate: number | null;
  /** Per-surface breakdown of the same cohort. Empty when there is no cohort. */
  bySurface: Array<{ surface: string; observations: number; mentionRate: number; citationRate: number }>;
  /** Per-funnel-stage breakdown of the same cohort. Empty when there is no cohort. */
  byFunnelStage: Array<{ funnelStage: string; observations: number; mentionRate: number; citationRate: number }>;
  /** Share of voice: subject first, competitors after. Empty when there is no cohort. */
  shareOfVoice: Array<{ name: string; share: number }>;
}