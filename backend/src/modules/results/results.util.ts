/**
 * Small, dependency-free helpers G13 needs: JSON column parsing, timezone
 * arithmetic and hashing.
 *
 * Timezone handling is hand-rolled on `Intl` rather than pulling in a date
 * library (AGENT-BRIEF rule 5: no new dependencies). The requirement is
 * narrow — turn a window bound expressed in an IANA zone into an exact UTC
 * instant, and never resolve a stored period against the viewer's clock — and
 * `Intl.DateTimeFormat` answers it exactly.
 *
 * @module results.util
 */

import { createHash } from 'node:crypto';

/**
 * Parse a Prisma JSON-string column.
 *
 * A malformed column returns `fallback` rather than throwing: one corrupt row
 * must not take down a read of the whole period, and the caller reports the
 * parsed result honestly (an unparseable `engines` column reads as "no engines
 * pinned", which the comparability check then reports as a break rather than
 * silently assuming equality).
 */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Parse a JSON column that is documented to hold an array of strings. */
export function parseStringArray(raw: string | null | undefined): string[] {
  const value = parseJson<unknown>(raw, []);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Parse a JSON column documented to hold an object. */
export function parseRecord(raw: string | null | undefined): Record<string, unknown> {
  const value = parseJson<unknown>(raw, {});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** `true` when `timeZone` is a valid IANA zone this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone's offset from UTC, in milliseconds, at a given instant.
 * Positive east of Greenwich.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  // `hour12: false` can render midnight as 24 in some ICU versions.
  const hour = at('hour') === 24 ? 0 : at('hour');
  const asIfUtc = Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second'));
  return asIfUtc - instant.getTime();
}

/**
 * Turn a wall-clock date/time **in `timeZone`** into the exact UTC instant.
 *
 * Two passes: the first uses the offset at the naive guess, the second
 * re-reads the offset at the corrected instant. That is enough for every real
 * zone including DST transitions, where the offset at the two candidate
 * instants can differ by an hour.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let timestamp = naive;
  for (let pass = 0; pass < 3; pass += 1) {
    const corrected = naive - zoneOffsetMs(new Date(timestamp), timeZone);
    if (corrected === timestamp) break;
    timestamp = corrected;
  }
  return new Date(timestamp);
}

/** `YYYY-MM-DD` (a bare date) or a full ISO 8601 timestamp. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isBareDate(value: string): boolean {
  return BARE_DATE.test(value);
}

/**
 * Resolve a window bound to an exact UTC instant.
 *
 * A bare date resolves against `timeZone`, not against the server's clock:
 * `from=2026-03-01` means the first instant of 1 March *in that zone*, and
 * `to=2026-03-31` means the last instant of 31 March. That is the whole point
 * of storing a timezone with a period — a "March" report must mean the same
 * thing in March and in September, on any host.
 *
 * @param bound 'from' resolves to the start of the day, 'to' to the end of it.
 * @throws Error when `value` is neither a bare date nor a parseable ISO timestamp.
 */
export function resolveBound(value: string, bound: 'from' | 'to', timeZone: string): Date {
  if (isBareDate(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return bound === 'from'
      ? zonedWallClockToUtc(year, month, day, 0, 0, 0, 0, timeZone)
      : zonedWallClockToUtc(year, month, day, 23, 59, 59, 999, timeZone);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`"${value}" is neither a YYYY-MM-DD date nor an ISO 8601 timestamp`);
  }
  return parsed;
}

/**
 * Canonical fingerprint of a comparison key.
 *
 * Covers exactly what §6.4 names as the basis of comparability: the query set
 * and its version, the engines, the markets and the transport. Array order is
 * normalised away — the same engines in a different order are the same
 * methodology — while a genuine membership change is not.
 *
 * A null is encoded as the literal `~` so it can never collide with the real
 * string value `"null"` or with an empty array.
 */
export function methodologyHashOf(parts: {
  querySetId: string | null;
  querySetVersion: number | null;
  engines: string[];
  markets: string[];
  transport: string | null;
}): string {
  const canonical = [
    `querySetId=${parts.querySetId ?? '~'}`,
    `querySetVersion=${parts.querySetVersion === null ? '~' : String(parts.querySetVersion)}`,
    `engines=${[...parts.engines].map((e) => e.trim().toLowerCase()).sort().join(',') || '~'}`,
    `markets=${[...parts.markets].map((m) => m.trim().toUpperCase()).sort().join(',') || '~'}`,
    `transport=${parts.transport ?? '~'}`,
  ].join('\n');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** ISO string or null — never `undefined`, so JSON columns stay well-formed. */
export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Whole days between two instants, rounded up so a partial day counts as one. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Strip anything that looks like a credential from a source's own error text
 * before it is disclosed.
 *
 * Failure reasons are *required* disclosures (a failed observation is never
 * silently dropped), so the text is kept — minus any secret a provider echoed
 * back into its error message, which would otherwise be republished to a
 * client surface by the very rule that makes failures visible.
 */
export function sanitizeReason(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const scrubbed = trimmed.replace(
    /((?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*)\S+/gi,
    '$1[redacted]',
  );
  return scrubbed.length > 500 ? `${scrubbed.slice(0, 497)}...` : scrubbed;
}

/** Round to 4 decimals — the precision the existing monitoring summary uses for rates. */
export function round4(value: number): number {
  return Number(value.toFixed(4));
}
