/**
 * Self-report attribution types.
 *
 * @module attribution.types
 */

/** Where the buyer says they came from. Closed set — the form is a picker. */
export const ATTRIBUTION_SOURCES = [
  'chatgpt',
  'claude',
  'perplexity',
  'gemini',
  'copilot',
  'other-ai',
  'search',
  'social',
  'referral',
  'other',
] as const;

export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

/** the AI sources, as opposed to the classic channels */
export const AI_SOURCES: readonly string[] = [
  'chatgpt',
  'claude',
  'perplexity',
  'gemini',
  'copilot',
  'other-ai',
];

export interface AttributionResponseDto {
  id: string;
  source: string;
  prompt: string | null;
  note: string | null;
  contactEmail: string | null;
  page: string | null;
  createdAt: string;
}

export interface AttributionSummary {
  total: number;
  /** responses naming an AI assistant */
  aiTotal: number;
  /** aiTotal / total, 0..1 — the number CRM attribution systematically misses */
  aiShare: number;
  bySource: Array<{ source: string; count: number; share: number }>;
  /** the prompts buyers actually reported, newest first */
  prompts: Array<{ prompt: string; source: string; createdAt: string }>;
  recent: AttributionResponseDto[];
  firstAt: string | null;
  lastAt: string | null;
}
