/**
 * Cadence scheduling maths — "what is the next occurrence of this rule, in
 * the rule's own timezone?" (G07 requirement 6).
 *
 * Two rules this file exists to enforce:
 *
 * 1. `nextRunAt` is computed in `CadenceRule.timezone`, never in the server
 *    process's local zone and never in the caller's browser zone. A 03:00
 *    daily rule on a `Europe/London` project fires at 03:00 London in both
 *    GMT and BST, which means the UTC instant moves twice a year.
 * 2. The computation is *derived* from the rule every tick rather than
 *    incremented from `lastRunAt`. An increment drifts: a tick that is late
 *    (worker restart, Redis down) would push every later tick late by the
 *    same amount, and a DST change would shift the whole schedule.
 *
 * No date library is available to this build (AGENT-BRIEF rule 5), so the
 * zone maths is done with `Intl` — the same approach `delivery-plan`'s
 * `resolveDueAt` takes. It is deliberately re-implemented here rather than
 * imported: a module owns its own lib, and the *question* is different
 * (next wall-clock occurrence vs. end-of-day resolution).
 *
 * @module jobs/lib/cadence-schedule.util
 */

import { CadenceFrequency, MONTHLY_FREQUENCIES, WEEKLY_FREQUENCIES } from '../jobs.types';

/** The subset of a CadenceRule this module needs to schedule. */
export interface ScheduleRule {
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  timezone: string;
  /**
   * Anchors `biweekly` (and is ignored by every other frequency). A biweekly
   * rule with no anchor would be ambiguous — "every two weeks" from when?
   * `CadenceRule.createdAt` is the deterministic answer.
   */
  anchor?: Date | null;
}

/** A local calendar date — no zone, no time. */
interface LocalDate {
  y: number;
  m: number;
  d: number;
}

/**
 * Longest horizon any frequency can need before its next occurrence, plus
 * slack for a clamped month day. Used to bound the search loop.
 */
const MAX_SEARCH_DAYS = 400;

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
 * Offset (minutes, UTC − local) of `timeZone` at the instant `atUtc`
 * represents. Evaluated at a specific instant, so it is correct across DST.
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
  return (asIfUtc - atUtc.getTime()) / 60_000;
}

/** The local calendar date of `at` in `timeZone`. */
export function localDateIn(timeZone: string, at: Date): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Local wall-clock time of `at` in `timeZone`, as `HH:mm` numbers. */
export function localTimeIn(timeZone: string, at: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { hour: get('hour'), minute: get('minute') };
}

/** Pure calendar addition — no zone involved, so no DST hazard. */
function addLocalDays(date: LocalDate, days: number): LocalDate {
  const dt = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Days since the Unix epoch for a calendar date (zone-free). */
function dayIndex(date: LocalDate): number {
  return Math.round(Date.UTC(date.y, date.m - 1, date.d) / 86_400_000);
}

/** Last day of a calendar month (28–31). */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `dayOfMonth` clamped into the month's real length (31 in February → 28/29). */
function clampDayOfMonth(y: number, m: number, dayOfMonth: number): number {
  return Math.min(dayOfMonth, daysInMonth(y, m));
}

/** Weekday (0 = Sunday, matching the schema) of a *local* date in `timeZone`. */
function localWeekday(timeZone: string, date: LocalDate): number {
  // Noon is used as the probe instant: a date's weekday cannot be ambiguous
  // at noon, whereas midnight can be skipped or repeated by a DST jump.
  const probe = zonedWallTimeToUtc(timeZone, date.y, date.m, date.d, 12, 0);
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(probe);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * The UTC instant a local wall-clock time in `timeZone` corresponds to.
 *
 * Two passes, because the offset itself depends on the instant being solved
 * for: the first pass uses the offset at the naive UTC reading, the second
 * re-reads the offset at the resulting instant and corrects once. That is
 * exact for every real zone; a wall time that does not exist (the spring-
 * forward gap) resolves forward, and one that happens twice (the autumn
 * fold) resolves to the first occurrence.
 */
export function zonedWallTimeToUtc(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
): Date {
  const asIfUtc = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  const first = offsetMinutesAt(timeZone, new Date(asIfUtc));
  let utc = asIfUtc - first * 60_000;
  const second = offsetMinutesAt(timeZone, new Date(utc));
  if (second !== first) utc = asIfUtc - second * 60_000;
  return new Date(utc);
}

/** Clamp a stored hour into 0–23 so a bad row cannot produce an invalid Date. */
function normalizedHour(hour: number): number {
  if (!Number.isInteger(hour)) return 0;
  return Math.min(23, Math.max(0, hour));
}

/** Does this local date satisfy the rule's calendar pattern? */
function matchesDate(rule: ScheduleRule, frequency: CadenceFrequency, date: LocalDate, anchor: LocalDate | null): boolean {
  const timeZone = rule.timezone;
  switch (frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return localWeekday(timeZone, date) === (rule.dayOfWeek ?? 0);
    case 'biweekly': {
      if (localWeekday(timeZone, date) !== (rule.dayOfWeek ?? 0)) return false;
      // Only every second matching weekday, counted from the anchor date.
      const base = anchor ?? date;
      const delta = dayIndex(date) - dayIndex(base);
      return delta >= 0 && delta % 14 === 0;
    }
    case 'monthly': {
      const wanted = clampDayOfMonth(date.y, date.m, rule.dayOfMonth ?? 1);
      return date.d === wanted;
    }
    case 'quarterly': {
      // Calendar quarters: January, April, July, October.
      if (date.m % 3 !== 1) return false;
      const wanted = clampDayOfMonth(date.y, date.m, rule.dayOfMonth ?? 1);
      return date.d === wanted;
    }
    default:
      return false;
  }
}

/**
 * The next instant this rule should fire, strictly after `from`, in the
 * rule's own timezone. Returns `null` for an `off` rule (or a rule whose
 * pattern has no occurrence at all), which callers must render as
 * "not scheduled" rather than as an error.
 */
export function nextRunAt(rule: ScheduleRule, from: Date): Date | null {
  const frequency = rule.frequency as CadenceFrequency;
  if (frequency === 'off') return null;
  if (!isValidTimeZone(rule.timezone)) return null;

  const hour = normalizedHour(rule.hour);
  const start = localDateIn(rule.timezone, from);

  // The anchor for biweekly needs its weekday to match the rule's, otherwise
  // a 14-day lattice from it would never contain the requested weekday.
  let anchor: LocalDate | null = null;
  if (WEEKLY_FREQUENCIES.includes(frequency) && rule.anchor) {
    const raw = localDateIn(rule.timezone, rule.anchor);
    anchor = raw;
    if (frequency === 'biweekly') {
      const wanted = rule.dayOfWeek ?? 0;
      for (let i = 0; i < 7; i++) {
        const candidate = addLocalDays(raw, i);
        if (localWeekday(rule.timezone, candidate) === wanted) {
          anchor = candidate;
          break;
        }
      }
    }
  }

  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset++) {
    const date = addLocalDays(start, offset);
    if (!matchesDate(rule, frequency, date, anchor)) continue;
    const candidate = zonedWallTimeToUtc(rule.timezone, date.y, date.m, date.d, hour, 0);
    // Strictly in the future: a candidate equal to `from` would re-fire the
    // rule in a loop, since the tick condition is `nextRunAt <= now`.
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/** True when the frequency needs a `dayOfWeek` value to be well-formed. */
export function needsDayOfWeek(frequency: string): boolean {
  return WEEKLY_FREQUENCIES.includes(frequency as CadenceFrequency);
}

/** True when the frequency needs a `dayOfMonth` value to be well-formed. */
export function needsDayOfMonth(frequency: string): boolean {
  return MONTHLY_FREQUENCIES.includes(frequency as CadenceFrequency);
}
