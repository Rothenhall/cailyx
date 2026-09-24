/**
 * `WorkItem.targets` — read and write, in one place.
 *
 * Pure so the delivery-plan module (which writes the field) and the progress
 * module (which reads it) share the shape without importing each other.
 *
 * @module progress-targets
 */

import { PROGRESS_TARGET_KINDS, type ProgressTarget } from './progress.types';

const KINDS: ReadonlySet<string> = new Set(PROGRESS_TARGET_KINDS);

/** Parse the stored JSON, dropping anything malformed rather than failing a read. */
export function parseTargets(raw: string | null | undefined): ProgressTarget[] {
  if (!raw) return [];
  try {
    return normalizeTargets(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Keep well-formed entries, trim, normalise market codes, drop duplicates. */
export function normalizeTargets(value: unknown): ProgressTarget[] {
  if (!Array.isArray(value)) return [];
  const out: ProgressTarget[] = [];
  for (const entry of value) {
    const e = entry as { kind?: unknown; value?: unknown };
    if (typeof e?.kind !== 'string' || !KINDS.has(e.kind) || typeof e.value !== 'string') continue;
    const kind = e.kind as ProgressTarget['kind'];
    const v = kind === 'market' ? e.value.trim().toUpperCase() : e.value.trim();
    if (!v) continue;
    if (out.some((t) => t.kind === kind && t.value.toLowerCase() === v.toLowerCase())) continue;
    out.push({ kind, value: v });
  }
  return out;
}

/** Serialise for storage; an empty list is stored as null so "never tagged" stays distinguishable. */
export function serializeTargets(targets: ProgressTarget[] | undefined): string | null | undefined {
  if (targets === undefined) return undefined;
  const clean = normalizeTargets(targets);
  return clean.length ? JSON.stringify(clean) : null;
}
