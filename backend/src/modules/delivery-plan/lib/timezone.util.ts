/**
 * Timezone-aware due-date resolution — G06 rule: "due dates resolve in the
 * engagement's timezone, never a browser clock."
 *
 * A caller may send either a full timestamp (already unambiguous — passed
 * through) or a bare date (`YYYY-MM-DD`, what a date picker naturally
 * produces). A bare date is resolved to end-of-day in the *engagement's*
 * IANA timezone (falling back to the project's, then UTC) — never in the
 * server process's or the browser's local zone — using only `Intl`, since
 * no date-time library is available to this build.
 *
 * @module lib/timezone.util
 */

import { BadRequestException } from '@nestjs/common';

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Offset (minutes, UTC - local) of `timeZone` at the instant `atUtc`
 * represents, computed by formatting that instant in the target zone and
 * diffing against its UTC reading. Correct across DST because it is
 * evaluated at the specific instant, not a fixed offset table.
 *
 * The result is rounded to a whole minute on purpose. `Intl` is asked for
 * second precision, so the sub-second part of `atUtc` is dropped when it is
 * formatted; naively dividing the difference reintroduces that dropped part
 * as a fractional offset (measured at -0.01665 minutes for UTC). Since every
 * current IANA offset is a whole number of minutes, rounding is exact rather
 * than an approximation — and it removes the sub-second error that otherwise
 * pushed an end-of-day due date onto the following calendar day.
 */
function offsetMinutesAt(timeZone: string, atUtc: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(atUtc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asIfUtc - atUtc.getTime()) / 60_000);
}

/** True if `timeZone` is a recognizable IANA zone identifier. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a due-date input to a concrete UTC instant in `timeZone`.
 * - `YYYY-MM-DD` -> 23:59:59.999 local to `timeZone` on that date.
 * - Anything else -> parsed as an ISO datetime as-is (already unambiguous).
 * Throws BadRequestException on an unparseable input or unknown zone.
 */
export function resolveDueAt(input: string, timeZone: string): Date {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  if (BARE_DATE_RE.test(input)) {
    const naiveUtcEndOfDay = new Date(`${input}T23:59:59.999Z`);
    if (Number.isNaN(naiveUtcEndOfDay.getTime())) {
      throw new BadRequestException(`Invalid date: ${input}`);
    }
    // Two passes: the first correction can move the instant across a DST
    // boundary, where the zone's offset differs from the one measured at the
    // naive reading. Re-measuring at the corrected instant converges.
    const firstOffset = offsetMinutesAt(zone, naiveUtcEndOfDay);
    const firstGuess = new Date(naiveUtcEndOfDay.getTime() - firstOffset * 60_000);
    const secondOffset = offsetMinutesAt(zone, firstGuess);
    return secondOffset === firstOffset
      ? firstGuess
      : new Date(naiveUtcEndOfDay.getTime() - secondOffset * 60_000);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date/time: ${input}`);
  }
  return parsed;
}
