/**
 * Schedule resolution for `Publication.scheduledFor` — G11's "schedule timezone"
 * rule: a planned publication time resolves against the **project's** timezone
 * (inherited from the engagement), never the server's clock and never the
 * browser's.
 *
 * The technique is the one already used for delivery-plan due dates (`Intl`
 * offset lookup evaluated at the specific instant, so it is correct across DST),
 * duplicated here deliberately rather than imported across module lanes: the two
 * modules own their own scheduling semantics, and a shared helper would make one
 * agent's refactor break the other's behaviour silently.
 *
 * @module publishing/lib/timezone.util
 */

import { BadRequestException } from '@nestjs/common';

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** Offset (minutes, UTC - local) of `timeZone` at the instant `atUtc`. */
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
  return (asIfUtc - atUtc.getTime()) / 60_000;
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
 * Resolve a scheduling input to a concrete UTC instant in `timeZone`.
 *
 * - a full ISO timestamp (with `Z` or an offset) → used as-is: already
 *   unambiguous, so no zone is applied to it;
 * - `YYYY-MM-DD` → 09:00 local to `timeZone` on that date (a date without a
 *   time means "that morning", not "the last instant of the day" — a
 *   publication scheduled for the 3rd should not go out at 23:59);
 * - `YYYY-MM-DDTHH:mm[:ss]` (no offset) → that wall-clock time in `timeZone`.
 *
 * @throws BadRequestException on an unparseable input.
 */
export function resolveScheduledFor(input: string, timeZone: string): Date {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';

  if (BARE_DATE_RE.test(input)) {
    return localWallClockToUtc(`${input}T09:00:00`, zone);
  }
  if (LOCAL_DATE_TIME_RE.test(input)) {
    const normalized = input.replace(' ', 'T');
    return localWallClockToUtc(normalized.length === 16 ? `${normalized}:00` : normalized, zone);
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      `Invalid scheduledFor: "${input}". Send an ISO timestamp with an offset, a bare date (YYYY-MM-DD), or a local date-time (YYYY-MM-DDTHH:mm) resolved in the project's timezone.`,
    );
  }
  return parsed;
}

/**
 * Convert a wall-clock reading in `zone` to the UTC instant it names.
 *
 * Two passes: treat the reading as if it were UTC to get a first guess, measure
 * the zone's offset at that instant, apply it, then re-measure at the corrected
 * instant — which lands on the right side of a DST boundary.
 */
function localWallClockToUtc(wallClock: string, zone: string): Date {
  const naive = new Date(`${wallClock}Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new BadRequestException(`Invalid date/time: ${wallClock}`);
  }
  const firstOffset = offsetMinutesAt(zone, naive);
  const corrected = new Date(naive.getTime() - firstOffset * 60_000);
  const secondOffset = offsetMinutesAt(zone, corrected);
  return secondOffset === firstOffset ? corrected : new Date(naive.getTime() - secondOffset * 60_000);
}
