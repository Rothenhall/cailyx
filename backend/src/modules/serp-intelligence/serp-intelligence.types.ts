/**
 * SERP Intelligence Types — ranking / competitor / AI-Overview tracking (Agent #3).
 *
 * Data comes from a **licensed SERP data API (DataForSEO)**. This module never
 * drives a browser against Google and never generates queries, clicks, or
 * impressions as a user — it reads a paid data feed.
 *
 * @module serp-intelligence.types
 */

export type SerpProviderName = 'dataforseo' | 'fixture';
export type SerpSnapshotStatus = 'running' | 'complete' | 'partial' | 'failed';
export type SerpDevice = 'desktop' | 'mobile';

/** One normalized item from a SERP, provider-agnostic. */
export interface SerpItem {
  type: string; // organic | featured_snippet | ai_overview | people_also_ask | ...
  rankAbsolute: number | null;
  domain: string | null;
  url: string | null;
  title: string | null;
  /** For ai_overview: referenced source URLs. */
  references?: string[];
  /** For ai_overview: the answer text (used for subject-mention detection). */
  text?: string;
}

/** Normalized provider response for one keyword. */
export interface SerpResponse {
  keyword: string;
  items: SerpItem[];
  costUsd: number;
}

/** A SERP data provider. */
export interface SerpProvider {
  readonly name: SerpProviderName;
  fetchSerp(
    keyword: string,
    opts: { locationName: string; languageCode: string; device: string },
  ): Promise<SerpResponse>;
}

export interface CreateTrackerInput {
  name: string;
  keywords: string[];
  locationName?: string;
  languageCode?: string;
  device?: string;
  provider?: SerpProviderName;
}

export interface CaptureResult {
  snapshotId: string;
  status: SerpSnapshotStatus;
  queriesRun: number;
  costUsd: number;
  note: string | null;
}

export const SERP_LIMITS = {
  keywordsPerTracker: { min: 1, max: 300 },
  maxKeywordLen: 200,
  /** Default USD cap for one capture across all a tracker's queries. */
  defaultMaxCostPerCapture: 5,
} as const;
