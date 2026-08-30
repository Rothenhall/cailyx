/**
 * Deterministic PRNG helpers — shared by the swarm-layer generators/planners
 * so that "same input → same output" holds across `persona`, `journey`, and
 * `council`. Reproducibility is what lets the smoke harness assert exact output
 * and lets a regenerated slot be byte-identical to its first run.
 *
 * @module common/utils/prng
 */

/** mulberry32 — tiny, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** djb2 string hash → unsigned 32-bit int. Seeds {@link mulberry32} from text. */
export function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** A seeded RNG built straight from a string seed. */
export function rngFromSeed(seed: string): () => number {
  return mulberry32(hashString(seed));
}

/** Pick one item from a non-empty array using the RNG. */
export function seededPick<T>(pool: readonly T[], rng: () => number): T {
  return pool[Math.floor(rng() * pool.length)];
}

/** Pick `n` distinct items from `pool` using the RNG (stable for a given seed). */
export function seededSample<T>(pool: readonly T[], n: number, rng: () => number): T[] {
  const copy = [...pool];
  const out: T[] = [];
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}
