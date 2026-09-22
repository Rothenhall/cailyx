import type { StatusTone } from '@/components/patterns/StatusPill';

/**
 * The scoring bands the backend actually emits.
 *
 * Source of truth is `backend/src/modules/scoring/scoring.types.ts`:
 * invisible ≤40, faint ≤60, present ≤80, recommended ≤100. Nothing here
 * invents a band or a threshold — a score outside a released report simply has
 * no band, and is rendered as unmeasured rather than as a zero.
 */
export const BAND_THRESHOLDS = [40, 60, 80] as const;

export interface BandMeta {
  /** Sentence-case label for display. */
  label: string;
  /** Background utility for a meter fill. */
  fill: string;
  /** The reserved status tone, for pills. */
  tone: StatusTone;
}

const BANDS: Record<string, BandMeta> = {
  recommended: { label: 'Recommended', fill: 'bg-success', tone: 'success' },
  present: { label: 'Present', fill: 'bg-info', tone: 'info' },
  faint: { label: 'Faint', fill: 'bg-warning', tone: 'warning' },
  invisible: { label: 'Invisible', fill: 'bg-danger', tone: 'danger' },
};

/** The band's presentation, or null when the band is absent or unrecognised. */
export function bandMeta(band: string | null | undefined): BandMeta | null {
  if (!band) return null;
  return BANDS[band.trim().toLowerCase()] ?? null;
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}
