/**
 * Entity-name consistency — the shared rules for "is this platform describing
 * the same company?"
 *
 * Extracted from `entity-audit.service.ts` so `digital-presence` can apply the
 * same rules rather than growing a second, subtly different copy (wave-6 step 5
 * says reuse this, not repeat it). Two modules disagreeing about what counts as
 * a name match would be worse than either rule alone: the same client would be
 * "consistent" on one screen and "inconsistent" on the next.
 *
 * Pure functions, no Nest, no Prisma — importable from anywhere.
 *
 * @module entity-audit.consistency
 */

/** `match` — same entity. `mismatch` — a different one. `not-checked` — nobody looked. */
export type ConsistencyStatus = 'match' | 'mismatch' | 'not-checked';

/** Lowercase and trim. Deliberately conservative — see {@link namesMatchExactly}. */
export function normalizeEntityName(raw: string): string {
  return raw.toLowerCase().trim();
}

/**
 * Strict comparison, for a name a human **recorded** on a platform.
 *
 * Exact after normalisation, on purpose. An operator typing a platform's
 * recorded name is asserting precisely what it says, so "Acme" vs "Acme Ltd" is
 * a real inconsistency worth surfacing — fuzzy-matching it away would hide the
 * exact class of problem this check exists to find.
 */
export function namesMatchExactly(recorded: string, expected: string): boolean {
  const a = normalizeEntityName(recorded);
  const b = normalizeEntityName(expected);
  return a.length > 0 && a === b;
}

/**
 * Loose comparison, for a **fetched page title**.
 *
 * A title is not a recorded name: it is whatever the platform chose to render,
 * routinely padded ("Acme Ltd | LinkedIn", "Acme (@acme) • Instagram photos").
 * Requiring equality there would mark every real profile a mismatch, so the
 * rule is containment — the same rule `fetcher.verifyUrl` already applies when
 * it computes `identityMatch`, kept identical here so the two cannot drift.
 */
export function titleIdentifies(title: string, expected: string): boolean {
  const t = normalizeEntityName(title);
  const e = normalizeEntityName(expected);
  return e.length > 0 && t.includes(e);
}

/**
 * Resolve a stored verdict against a computed one.
 *
 * A stored `match`/`mismatch` always wins: it came from a human or from a real
 * fetch, and recomputing over it would silently overwrite evidence with a guess.
 * Only `not-checked` falls through to the name comparison, and with nothing to
 * compare the answer stays `not-checked` rather than defaulting to a verdict.
 *
 * @param recordedName The name as the platform has it, when known.
 * @param expectedName The entity's own name.
 * @param stored A previously stored status, if any.
 */
export function resolveConsistency(
  recordedName: string | null | undefined,
  expectedName: string,
  stored?: string | null,
): ConsistencyStatus {
  if (stored === 'mismatch') return 'mismatch';
  if (stored === 'match') return 'match';
  if (!recordedName) return 'not-checked';
  return namesMatchExactly(recordedName, expectedName) ? 'match' : 'mismatch';
}
