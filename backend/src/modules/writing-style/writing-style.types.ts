/**
 * Types for the Writing Style module — P09 (platform_improvement_plan.md
 * §13.8). Owned by Content, versioned draft/confirm exactly like
 * BusinessProfile — a new social scrape (PresenceBrandVoice) never
 * overwrites the active confirmed profile.
 *
 * @module writing-style.types
 */

export interface WritingStyleFields {
  name: string;
  summary: string | null;
  tone: string | null;
  preferredWords: string[];
  avoidWords: string[];
  exampleSentences: string[];
  ctaPreferences: string | null;
  formality: string;
  audience: string | null;
  channelDifferences: Record<string, { tone?: string; notes?: string }>;
}

export interface WritingStyleProfileDto extends WritingStyleFields {
  id: string;
  projectId: string;
  version: number;
  sourceType: 'manual' | 'suggested-accepted';
  suggestionSourceId: string | null;
  fingerprint: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  isLatest: boolean;
  createdAt: string;
}

/** §13.8 "suggestions from observed content, shown separately". */
export interface WritingStyleSuggestionDto {
  presenceBrandVoiceId: string;
  tone: string[];
  vocabulary: string[];
  callToActions: string[];
  summary: string | null;
  sampleSize: number;
  extraction: string;
  createdAt: string;
  /** False when postSample is too small to responsibly summarize as "the" style. */
  sufficientData: boolean;
}
