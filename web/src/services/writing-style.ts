import { api, unwrap } from '@/lib/api';

/**
 * Writing style adapters — P09 (platform_improvement_plan.md §13.8).
 *
 * The shape of this file follows §13.8's one load-bearing rule: **the active
 * profile is a confirmed, versioned record, not the latest thing we observed.**
 * So:
 *
 *  - `getActiveWritingStyle` returns the confirmed row or `null`. It never
 *    falls back to a draft and never invents a profile from social posts — a
 *    screen that showed a draft as "your style" would be claiming a decision
 *    the business has not made.
 *  - `listWritingStyleVersions` returns every version *plus* which one is
 *    active, because confirming inserts a new row rather than mutating one:
 *    a restore is "confirm this old version's content as a new version", and
 *    the history must stay readable for that to be possible.
 *  - `getWritingStyleSuggestions` is a **separate read** from a separate
 *    source (`PresenceBrandVoice`). §13.8 is explicit that observed style is
 *    shown apart from the confirmed profile, and `sufficientData: false` means
 *    there is not enough source material to summarize responsibly — the UI
 *    must offer manual setup instead of fabricating an analysis.
 */

export const FORMALITY_VALUES = ['casual', 'conversational', 'neutral', 'formal'] as const;
export type Formality = (typeof FORMALITY_VALUES)[number];

export const FORMALITY_LABELS: Record<Formality, string> = {
  casual: 'Casual',
  conversational: 'Conversational',
  neutral: 'Neutral',
  formal: 'Formal',
};

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

export interface WritingStyleProfile extends WritingStyleFields {
  id: string;
  projectId: string;
  version: number;
  sourceType: 'manual' | 'suggested-accepted';
  suggestionSourceId: string | null;
  /** Content fingerprint of this version — what a generation job pins, so an edit cannot silently change a queued job's style. */
  fingerprint: string;
  confirmedBy: string | null;
  /** Null means this row is a draft, not the active style. */
  confirmedAt: string | null;
  isLatest: boolean;
  createdAt: string;
}

export interface WritingStyleSuggestion {
  presenceBrandVoiceId: string;
  tone: string[];
  vocabulary: string[];
  callToActions: string[];
  summary: string | null;
  sampleSize: number;
  extraction: string;
  createdAt: string;
  /** False when the source sample is too small to summarize as "the" style. */
  sufficientData: boolean;
}

export interface WritingStyleDraftInput {
  name?: string;
  summary?: string;
  tone?: string;
  preferredWords?: string[];
  avoidWords?: string[];
  exampleSentences?: string[];
  ctaPreferences?: string;
  formality?: Formality;
  audience?: string;
  channelDifferences?: Record<string, { tone?: string; notes?: string }>;
  /** Set when this draft starts from an accepted suggestion. */
  suggestionSourceId?: string;
}

/**
 * The active confirmed style, or `null` when none has been confirmed.
 *
 * `null` is a real answer here, not an error: it is what the generation dialog
 * checks before offering to pin a style, and §13.8 requires that state be
 * presented as "set up your style", not as a missing value.
 */
export async function getActiveWritingStyle(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<WritingStyleProfile | null> {
  const payload = await api.get<WritingStyleProfile | null>(
    `/projects/${projectId}/writing-style`,
    options,
  );
  return payload ?? null;
}

export async function listWritingStyleVersions(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<{ versions: WritingStyleProfile[]; activeVersion: number | null }> {
  const payload = await api.get<{ versions: WritingStyleProfile[]; activeVersion: number | null }>(
    `/projects/${projectId}/writing-style/versions`,
    options,
  );
  return {
    versions: unwrap<WritingStyleProfile[]>(payload, 'versions'),
    activeVersion: payload.activeVersion ?? null,
  };
}

export async function getWritingStyleSuggestions(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<WritingStyleSuggestion[]> {
  const payload = await api.get<{ suggestions: WritingStyleSuggestion[] }>(
    `/projects/${projectId}/writing-style/suggestions`,
    options,
  );
  return unwrap<WritingStyleSuggestion[]>(payload, 'suggestions');
}

/** Save a new draft version. A draft is a candidate — it changes nothing until confirmed. */
export async function saveWritingStyleDraft(
  projectId: string,
  input: WritingStyleDraftInput,
): Promise<WritingStyleProfile> {
  return api.post<WritingStyleProfile>(`/projects/${projectId}/writing-style/draft`, input);
}

/**
 * Confirm a draft, which **inserts a new confirmed version** carrying that
 * draft's content; the draft row itself is never mutated.
 *
 * Two server behaviours a caller must respect:
 *
 *  - With no `version`, the newest *unconfirmed* row is confirmed. With no
 *    draft saved, that is a 409 — the server refuses to confirm nothing.
 *  - With a `version`, that exact row is confirmed — and if it is **already
 *    confirmed** the server answers 409. So "restore an older version" is not
 *    this call on the old row: it is {@link saveWritingStyleDraft} with that
 *    version's content, then this call with no version. The old confirmed row
 *    stays in history untouched, which is what keeps history readable.
 */
export async function confirmWritingStyle(
  projectId: string,
  version?: number,
): Promise<WritingStyleProfile> {
  return api.post<WritingStyleProfile>(`/projects/${projectId}/writing-style/confirm`, {
    version,
  });
}

/** The client-portal read (§13.8 read-only for clients) — used by the client shell where a style is shown. */
export async function getPortalWritingStyle(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<WritingStyleProfile | null> {
  const payload = await api.get<WritingStyleProfile | null>(
    `/portal/projects/${projectId}/writing-style`,
    options,
  );
  return payload ?? null;
}

/**
 * A one-line summary of a profile for places that must show *which* style is in
 * effect without reprinting it — the generation dialog's step 4, and the
 * content detail's plan panel.
 */
export function summarizeWritingStyle(profile: WritingStyleProfile): string {
  const parts = [profile.summary];
  if (!profile.summary && profile.tone) parts.push(`Tone: ${profile.tone}`);
  if (profile.formality) parts.push(FORMALITY_LABELS[profile.formality as Formality] ?? profile.formality);
  const avoid = profile.avoidWords?.length ? `Avoids ${profile.avoidWords.slice(0, 3).join(', ')}` : null;
  if (avoid) parts.push(avoid);
  return parts.filter(Boolean).join(' · ') || `Version ${profile.version}`;
}
