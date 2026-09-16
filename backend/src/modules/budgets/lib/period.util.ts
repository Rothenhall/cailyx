/**
 * Budget period windows — G12.
 *
 * A budget ceiling is meaningless without the window it applies to, so the
 * window is resolved explicitly and reported back with every evaluation
 * (`PolicyWindow`). Two rules from the repo brief shape what is here:
 *
 * 1. **Calendar windows resolve in the project's timezone, never the server's.**
 *    "This month's spend" has to mean the month the operator means. The zone
 *    comes from `Project.timezone` (G06), falling back to UTC.
 *
 * 2. **An unresolvable window is not guessed.** A `cycle`-period policy with no
 *    live cycle reports `resolved: 'unresolved'` and the reason; callers fail
 *    closed on it rather than charging against a window nobody agreed to.
 *
 * Uses only `Intl` — no date library is available to this build (matching
 * `delivery-plan/lib/timezone.util.ts`, which solves the same problem for due
 * dates with the same technique).
 *
 * @module budgets/lib/period.util
 */

import type { BudgetPeriod, PolicyWindow } from '../budgets.types';

/** Wall-clock parts of an instant, as read in a specific IANA zone. */
interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday ... 7 = Sunday (ISO-8601). */
  isoWeekday: number;
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

function partsIn(timeZone: string, at: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const weekdayLabel = get('weekday');
  const isoWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayLabel) + 1;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    isoWeekday: isoWeekday === 0 ? 7 : isoWeekday,
  };
}

/**
 * Offset in minutes (UTC - local) of `timeZone` at the instant `atUtc`
 * represents, evaluated at that specific instant so DST transitions are
 * handled without an offset table.
 */
function offsetMinutesAt(timeZone: string, atUtc: Date): number {
  const p = partsIn(timeZone, atUtc);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asIfUtc - atUtc.getTime()) / 60_000;
}

/**
 * Convert a wall-clock reading in `timeZone` to the UTC instant it denotes.
 *
 * Solved by iteration rather than a table: guess the instant, measure the
 * zone's offset at the guess, correct, then re-measure. The second pass is
 * what makes a wall-clock time inside a DST transition land on the right side.
 */
function zonedWallClockToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = new Date(naiveUtc);
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = offsetMinutesAt(timeZone, guess);
    guess = new Date(naiveUtc - offset * 60_000);
  }
  return guess;
}

/** The UTC instant of local midnight, `deltaDays` days after the given local date. */
function localMidnightPlusDays(
  timeZone: string,
  local: ZonedParts,
  deltaDays: number,
): Date {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return zonedWallClockToUtc(timeZone, shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** The live G06 cycle a `cycle`-period policy measures against, if any. */
export interface CycleBoundary {
  id: string;
  startsOn: Date;
  endsOn: Date;
}

export interface PeriodWindowResolution {
  startsAt: Date | null;
  endsAt: Date | null;
  resolved: PolicyWindow['resolved'];
  unresolvedReason?: string;
}

/**
 * Resolve a policy period to a concrete half-open window `[startsAt, endsAt)`.
 *
 * @param period  The policy's period.
 * @param timezone IANA zone the calendar windows resolve in (the project's).
 * @param cycle   The project's live G06 cycle, required for `cycle` policies.
 * @param now     Injectable clock, so the resolution is testable.
 */
export function resolvePeriodWindow(
  period: BudgetPeriod,
  timezone: string,
  cycle: CycleBoundary | null,
  now: Date = new Date(),
): PeriodWindowResolution {
  if (period === 'total') {
    return { startsAt: null, endsAt: null, resolved: 'all-time' };
  }

  if (period === 'cycle') {
    if (!cycle) {
      return {
        startsAt: null,
        endsAt: null,
        resolved: 'unresolved',
        unresolvedReason:
          'This policy is scoped to a delivery cycle, but the project has no live cycle. ' +
          'Create or activate one, or set the policy period to month.',
      };
    }
    return { startsAt: cycle.startsOn, endsAt: cycle.endsOn, resolved: 'project-cycle' };
  }

  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  const local = partsIn(zone, now);

  if (period === 'day') {
    return {
      startsAt: localMidnightPlusDays(zone, local, 0),
      endsAt: localMidnightPlusDays(zone, local, 1),
      resolved: 'calendar',
    };
  }

  if (period === 'week') {
    // Monday-start, matching the ISO week the rest of the operator UI labels weeks by.
    const backToMonday = local.isoWeekday - 1;
    return {
      startsAt: localMidnightPlusDays(zone, local, -backToMonday),
      endsAt: localMidnightPlusDays(zone, local, 7 - backToMonday),
      resolved: 'calendar',
    };
  }

  // month
  const monthStart = zonedWallClockToUtc(zone, local.year, local.month, 1);
  const nextMonth = local.month === 12
    ? zonedWallClockToUtc(zone, local.year + 1, 1, 1)
    : zonedWallClockToUtc(zone, local.year, local.month + 1, 1);
  return { startsAt: monthStart, endsAt: nextMonth, resolved: 'calendar' };
}

/** Serialize a resolved window for the response, timestamps as ISO strings. */
export function describeWindow(
  period: BudgetPeriod,
  timezone: string,
  resolution: PeriodWindowResolution,
): PolicyWindow {
  return {
    period,
    startsAt: resolution.startsAt ? resolution.startsAt.toISOString() : null,
    endsAt: resolution.endsAt ? resolution.endsAt.toISOString() : null,
    timezone,
    resolved: resolution.resolved,
    ...(resolution.unresolvedReason ? { unresolvedReason: resolution.unresolvedReason } : {}),
  };
}
