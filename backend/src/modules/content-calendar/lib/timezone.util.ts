/**
 * Placement-time resolution for the content calendar — §6.7's rule:
 *
 * > "Store UTC instant plus intended local date/time and IANA timezone; reject
 * > nonexistent times and ask users to disambiguate repeated DST times."
 *
 * The three sibling resolvers already in this repo (`publishing/lib`,
 * `delivery-plan/lib`, `jobs/lib/cadence-schedule.util`) each answer a
 * *different* question — a publish instant, an end-of-day due date, a cadence
 * anchor — and each deliberately duplicates the offset lookup rather than
 * sharing it. This one answers a fourth question, and it is the only one that
 * must additionally decide *whether the caller's reading names an instant at
 * all*:
 *
 * - a **bare date** means 09:00 local, matching `publishing/lib`'s rule for a
 *   planned publication rather than `delivery-plan/lib`'s end-of-day rule for
 *   a due date;
 * - a **wall-clock reading** (`YYYY-MM-DDTHH:mm`) is resolved in the placement's
 *   zone, and is **rejected** when no such local time exists (the spring-forward
 *   gap) and **refused without a choice** when the reading names two instants
 *   (the fall-back repeat). Guessing either way would silently store a time the
 *   person did not pick;
 * - a **full ISO timestamp** is already an instant, so it is taken as given and
 *   the local reading is derived from it.
 *
 * The offset technique is the repo's established one: `Intl` offset lookup
 * evaluated at the specific instant, so it is correct across a DST boundary.
 *
 * @module content-calendar/lib/timezone.util
 */

import { BadRequestException } from '@nestjs/common';

/** Which of two candidate instants a repeated local time means. */
export type DstDisambiguation = 'earlier' | 'later';

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** The hour a bare date resolves to — the same convention `publishing/lib` uses. */
const BARE_DATE_HOUR = '09:00:00';

/** True if `timeZone` is a recognizable IANA zone identifier. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of `atUtc` in `timeZone`, as `YYYY-MM-DDTHH:mm:ss`. */
export function wallClockIn(timeZone: string, atUtc: Date): string {
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
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Offset (minutes, UTC − local) of `timeZone` at the instant `atUtc`. */
function offsetMinutesAt(timeZone: string, atUtc: Date): number {
  const asIfUtc = Date.parse(`${wallClockIn(timeZone, atUtc)}Z`);
  return (asIfUtc - atUtc.getTime()) / 60_000;
}

/** The wall-clock string a caller sent, normalized, or null when it is an instant. */
function parseWallClock(input: string): string | null {
  if (LOCAL_DATE_RE.test(input)) return `${input}T${BARE_DATE_HOUR}`;
  if (LOCAL_DATE_TIME_RE.test(input)) {
    const normalized = input.replace(' ', 'T');
    return normalized.length === 16 ? `${normalized}:00` : normalized;
  }
  return null;
}

export interface ResolvedPlacementTime {
  /** The instant every scope reads. */
  utc: Date;
  /** The intended local date, `YYYY-MM-DD`. */
  localDate: string;
  /** The intended local time, `HH:mm`. */
  localTime: string;
  /** The IANA zone the reading was made in. */
  timezone: string;
  /** `earlier`/`later` only when the reading was genuinely repeated. */
  dstDisambiguation: DstDisambiguation | null;
}

/**
 * Candidate instants a wall-clock reading could name in `zone`.
 *
 * Offsets are probed a day either side of the naive instant, which brackets any
 * transition near it: a wall clock can only be invalid or repeated because the
 * offset changed within a few hours of it.
 */
function candidateInstants(wallClock: string, zone: string): Date[] {
  const naive = Date.parse(`${wallClock}Z`);
  const day = 24 * 60 * 60 * 1000;
  const offsets = new Set<number>([
    offsetMinutesAt(zone, new Date(naive - day)),
    offsetMinutesAt(zone, new Date(naive)),
    offsetMinutesAt(zone, new Date(naive + day)),
  ]);
  const found: Date[] = [];
  for (const offset of offsets) {
    const instant = new Date(naive - offset * 60_000);
    if (wallClockIn(zone, instant) !== wallClock) continue;
    if (!found.some((existing) => existing.getTime() === instant.getTime())) found.push(instant);
  }
  return found.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Resolve a caller's intended placement time to the instant it names.
 *
 * @throws BadRequestException `time-nonexistent` when the reading falls in a
 *   spring-forward gap — no such local time exists, so there is nothing to
 *   schedule and inventing an instant would be storing a time the person never
 *   chose.
 * @throws BadRequestException `time-ambiguous` when the reading names two
 *   instants (a fall-back repeat) and the caller did not say which. The two
 *   candidate instants are returned so the interface can ask a question rather
 *   than pick for them.
 * @throws BadRequestException `invalid-timezone` / `invalid-time` for anything
 *   that is neither a zone nor a time.
 */
export function resolvePlacementLocalTime(
  input: string,
  timeZone: string,
  disambiguation?: DstDisambiguation,
): ResolvedPlacementTime {
  if (!isValidTimeZone(timeZone)) {
    throw new BadRequestException({
      error: 'invalid-timezone',
      message: `"${timeZone}" is not a recognized IANA timezone. Send one such as "Europe/London" or "America/New_York".`,
    });
  }

  const wallClock = parseWallClock(input);

  if (!wallClock) {
    // Not a wall clock: either an explicit instant, or nothing usable.
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException({
        error: 'invalid-time',
        message: `"${input}" is not a time. Send a local date-time (YYYY-MM-DDTHH:mm) to be read in the placement's timezone, or a full ISO timestamp.`,
      });
    }
    return {
      utc: parsed,
      localDate: wallClockIn(timeZone, parsed).slice(0, 10),
      localTime: wallClockIn(timeZone, parsed).slice(11, 16),
      timezone: timeZone,
      dstDisambiguation: null,
    };
  }

  const candidates = candidateInstants(wallClock, timeZone);

  if (candidates.length === 0) {
    // The reading fell in a gap. Offer the first local time that does exist, so
    // the interface can suggest rather than merely refuse.
    const naive = Date.parse(`${wallClock}Z`);
    const offsets = new Set<number>([
      offsetMinutesAt(timeZone, new Date(naive - 86_400_000)),
      offsetMinutesAt(timeZone, new Date(naive + 86_400_000)),
    ]);
    const later = Array.from(offsets)
      .map((offset) => new Date(naive - offset * 60_000))
      .filter((instant) => wallClockIn(timeZone, instant) > wallClock)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    throw new BadRequestException({
      error: 'time-nonexistent',
      message: `${wallClock} does not exist in ${timeZone}: the clocks moved forward across it. Pick a time that exists${
        later ? ` — the next one is ${wallClockIn(timeZone, later).replace('T', ' ')}` : ''
      }.`,
      timezone: timeZone,
      requestedLocal: `${wallClock.slice(0, 10)} ${wallClock.slice(11, 16)}`,
      nextValidLocal: later ? `${wallClockIn(timeZone, later).slice(0, 10)} ${wallClockIn(timeZone, later).slice(11, 16)}` : null,
    });
  }

  if (candidates.length > 1) {
    const earlier = candidates[0];
    const later = candidates[candidates.length - 1];
    if (!disambiguation) {
      throw new BadRequestException({
        error: 'time-ambiguous',
        message: `${wallClock} happens twice in ${timeZone} because the clocks moved back. Say which one you mean.`,
        timezone: timeZone,
        requestedLocal: `${wallClock.slice(0, 10)} ${wallClock.slice(11, 16)}`,
        candidates: [
          { disambiguation: 'earlier', utc: earlier.toISOString() },
          { disambiguation: 'later', utc: later.toISOString() },
        ],
      });
    }
    const chosen = disambiguation === 'earlier' ? earlier : later;
    return {
      utc: chosen,
      localDate: wallClock.slice(0, 10),
      localTime: wallClock.slice(11, 16),
      timezone: timeZone,
      dstDisambiguation: disambiguation,
    };
  }

  return {
    utc: candidates[0],
    localDate: wallClock.slice(0, 10),
    localTime: wallClock.slice(11, 16),
    timezone: timeZone,
    dstDisambiguation: null,
  };
}

/**
 * True when `input` looks like a local reading whose resolution could be
 * ambiguous — used only to decide whether a repeated DST time is even possible
 * before doing the offset work in a hot read path.
 */
export function isWallClockReading(input: string): boolean {
  return WALL_CLOCK_RE.test(parseWallClock(input) ?? '');
}

/**
 * Resolve a *window bound* to an instant, tolerantly.
 *
 * A window bound is not a placement: nobody chose midnight in Santiago or
 * Beirut on the day the clocks moved, so refusing to resolve it would make a
 * whole month unreadable in those zones. Unlike
 * {@link resolvePlacementLocalTime}, a reading that falls in a gap steps
 * forward to the first instant that exists rather than throwing; a reading that
 * repeats takes the earliest instant (a window start should include everything
 * on that local day, and a window end should include everything too).
 *
 * @param edge `start` floors a repeated reading to the earlier instant and
 *   `end` takes the later one, so the window always contains rather than
 *   excludes the local day.
 */
export function resolveWindowBound(input: string, timeZone: string, edge: 'start' | 'end'): Date {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const wallClock = parseWallClock(input);

  if (!wallClock) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    // An unusable bound is the caller's error, not something to paper over.
    throw new BadRequestException({
      error: 'invalid-time',
      message: `"${input}" is not a usable window bound. Send YYYY-MM-DD or a full ISO timestamp.`,
    });
  }

  const candidates = candidateInstants(wallClock, zone);
  if (candidates.length > 0) {
    return edge === 'start' ? candidates[0] : candidates[candidates.length - 1];
  }

  // Inside a gap: step forward a minute at a time (a gap is at most two hours
  // in any zone in the tz database) until the reading exists.
  const naive = Date.parse(`${wallClock}Z`);
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const probe = new Date(naive + minutes * 60_000);
    if (wallClockIn(zone, probe) === wallClock) return probe;
  }
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const probe = new Date(naive + minutes * 60_000);
    const rendered = wallClockIn(zone, probe);
    if (rendered > wallClock) return probe;
  }
  return new Date(naive);
}

/** Start of the local day `wallClock`'s date falls on, in `zone`. */
export function startOfLocalDay(zone: string, at: Date): Date {
  const localDate = wallClockIn(isValidTimeZone(zone) ? zone : 'UTC', at).slice(0, 10);
  return resolveWindowBound(`${localDate}T00:00:00`, zone, 'start');
}

/** Inclusive end of the local day `wallClock`'s date falls on, in `zone`. */
export function endOfLocalDay(zone: string, at: Date): Date {
  const localDate = wallClockIn(isValidTimeZone(zone) ? zone : 'UTC', at).slice(0, 10);
  return resolveWindowBound(`${localDate}T23:59:59`, zone, 'end');
}

/** First instant of the local month `at` falls in, in `zone`. */
export function startOfLocalMonth(zone: string, at: Date): Date {
  const localDate = wallClockIn(isValidTimeZone(zone) ? zone : 'UTC', at).slice(0, 10);
  return resolveWindowBound(`${localDate.slice(0, 7)}-01T00:00:00`, zone, 'start');
}

/** Inclusive last instant of the local month `at` falls in, in `zone`. */
export function endOfLocalMonth(zone: string, at: Date): Date {
  const localDate = wallClockIn(isValidTimeZone(zone) ? zone : 'UTC', at).slice(0, 10);
  const [year, month] = localDate.split('-').map(Number);
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const firstOfNext = `${nextMonth.year}-${String(nextMonth.month).padStart(2, '0')}-01T00:00:00`;
  return new Date(resolveWindowBound(firstOfNext, zone, 'start').getTime() - 1);
}

/** `YYYY-MM-DD` of the local date `at` falls on in `zone`. */
export function localDateIn(zone: string, at: Date): string {
  return wallClockIn(isValidTimeZone(zone) ? zone : 'UTC', at).slice(0, 10);
}

/** Whole days spanned by two instants, used to keep a read bounded. */
export function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}
