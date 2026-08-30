/**
 * Types for the Mention Tracking module (SOP-7, FR-4.4).
 *
 * @module mention-tracking.types
 */

/** Target kinds: listicle candidate, community thread, review platform, other. */
export type MentionTargetType = 'listicle' | 'community' | 'review' | 'other';

/** Outreach status pipeline for a target. */
export type MentionTargetStatus = 'new' | 'contacted' | 'replied' | 'placed' | 'rejected';

/** Result of one semi-auto mention check (single fetch, low ToS). */
export interface MentionCheckResult {
  mentioned: boolean;
  evidence: string | null;
  fetchedTitle: string | null;
  httpStatus: number | null;
}

/** Decay view for the latest-check list. */
export interface MentionDecay {
  targetId: string;
  url: string;
  type: MentionTargetType;
  status: MentionTargetStatus;
  everMentioned: boolean;
  lastMentionedAt: string | null;
  lastCheckedAt: string | null;
  daysSinceLastMention: number | null;
  stale: boolean;
}