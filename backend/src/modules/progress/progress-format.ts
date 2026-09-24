/**
 * One formatting of every progress number, shared by the page builder, the
 * template writer, the LLM facts and the LLM output check — so the number a
 * reader sees, the number the writer was given and the number the check
 * accepts can never differ by a rounding step.
 *
 * @module progress-format
 */

import type { MetricMovement, ProgressLayout, ProgressLedger } from './progress.types';

/** Whole-number percentage of a 0-1 rate. */
export function pctInt(rate: number): number {
  return Math.round(rate * 100);
}

export function pct(rate: number): string {
  return `${pctInt(rate)}%`;
}

/**
 * Percentage-point change between two rates, taken from the *displayed*
 * whole percentages so "9% → 34%" never reads as "+24 pts".
 */
export function ptsInt(from: number, to: number): number {
  return pctInt(to) - pctInt(from);
}

export function signed(n: number, suffix = ''): string {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n)}${suffix}`;
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface MovementText {
  from: string;
  to: string;
  change: string;
}

export function movementText(m: MetricMovement): MovementText {
  if (m.unit === 'count') {
    return { from: `${m.from} of ${m.fromN}`, to: `${m.to} of ${m.toN}`, change: signed(m.to - m.from) };
  }
  return { from: pct(m.from), to: pct(m.to), change: signed(ptsInt(m.from, m.to), ' pts') };
}

/** Tile-sized reference point: "baseline, 12 Mar 2026" / "last audit, 15 Apr 2026". */
export function windowShort(m: MetricMovement, ledger: ProgressLedger): string {
  const at = ledger.checkpoints.find((c) => c.auditId === m.fromAuditId)?.finishedAt;
  const which = m.window === 'since-baseline' ? 'baseline' : 'last audit';
  return at ? `${which}, ${shortDate(at)}` : which;
}

export function windowText(m: MetricMovement, ledger: ProgressLedger): string {
  const at = ledger.checkpoints.find((c) => c.auditId === m.fromAuditId)?.finishedAt;
  const when = at ? ` on ${shortDate(at)}` : '';
  return m.window === 'since-baseline' ? `since your baseline audit${when}` : `since the last audit${when}`;
}

/** Page budget per layout. Compact is one report page; extended is at most two. */
export const PAGE_CAPS: Record<ProgressLayout, {
  tiles: number;
  drivers: number;
  checkpoints: number;
  delivered: number;
  nextFocus: number;
  evidencePerDriver: number;
}> = {
  compact: { tiles: 3, drivers: 3, checkpoints: 4, delivered: 3, nextFocus: 1, evidencePerDriver: 1 },
  // Three tiles in both layouts: a fourth leaves a tile too narrow for its
  // label (react-pdf hyphenates it mid-word). The extended page spends its
  // room on history and drivers instead.
  extended: { tiles: 3, drivers: 5, checkpoints: 8, delivered: 10, nextFocus: 2, evidencePerDriver: 2 },
};

/**
 * Measured, not guessed: at these caps the compact page, with every field at
 * its maximum, renders on exactly one A4 page (verified by rendering the real
 * PDF with worst-case content).
 */
export const TEXT_CAPS = {
  headline: 200,
  driver: 230,
  nextFocus: 220,
  workTitle: 90,
} as const;

/**
 * A round top for a 0-based percent chart, a little above the tallest value
 * (at most five gridsteps, never above 100) — so low values stay readable
 * without the baseline ever moving off zero.
 */
export function niceMax(v: number): number {
  const target = Math.max(v, 1) * 1.15;
  for (const step of [10, 20, 25, 50, 100]) {
    const m = Math.ceil(target / step) * step;
    if (m / step <= 5) return Math.min(m, 100);
  }
  return 100;
}

/** A round top for a count meter, a little above the larger count. */
export function niceCountMax(v: number): number {
  const target = Math.max(v, 1) * 1.2;
  const step = target <= 10 ? 2 : target <= 50 ? 5 : target <= 200 ? 20 : 50;
  return Math.ceil(target / step) * step;
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}
