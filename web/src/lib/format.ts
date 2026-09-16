/**
 * Formatting helpers used by every pattern component.
 *
 * design_plan.md §3.4/§3.5 rules this file exists to enforce in one place:
 *  - percentage points are not relative percentages, and must never share a
 *    formatter that could blur the two;
 *  - credits are not currency;
 *  - every date/time carries its timezone;
 *  - "not measured" renders as text, never as `0` or a blank cell.
 */

const NOT_MEASURED = 'Not measured yet';

/** A relative change, e.g. traffic up 12% relative to its prior value. */
export function formatRelativePercent(value: number, opts: { signed?: boolean } = {}): string {
  const { signed = true } = opts;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${trimNumber(value)}%`;
}

/**
 * A change measured in percentage points, e.g. a score moving from 42% to
 * 47% is "+5 pp", never "+5%" and never "+11.9%" (which would be the
 * relative change of the same move). Callers must pick this explicitly
 * instead of reusing the relative-percent formatter.
 */
export function formatPercentagePoints(value: number, opts: { signed?: boolean } = {}): string {
  const { signed = true } = opts;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${trimNumber(value)} pp`;
}

/** A plain percentage value (not a change), e.g. "62%" coverage. */
export function formatPercent(value: number): string {
  return `${trimNumber(value)}%`;
}

/** Cailyx run/service credits. Never label these with a currency symbol. */
export function formatCredits(value: number): string {
  return `${trimNumber(value)} credit${value === 1 ? '' : 's'}`;
}

/** Real money. Requires an explicit ISO 4217 currency code — no default,
 *  so a screen cannot silently assume USD for another client's currency. */
export function formatCurrency(value: number, currencyCode: string, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Tabular, locale-formatted count/number with no implied unit. */
export function formatNumber(value: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * The one string to use whenever a metric has no value because it has never
 * been measured. This is deliberately not `0`, not `"--"`, and not blank:
 * §3.5 "Source never measured" requires the reader to know a prerequisite
 * is outstanding, not that the value rounded to zero.
 */
export function notMeasuredLabel(): string {
  return NOT_MEASURED;
}

/**
 * Renders a timestamp with its timezone always visible, per §3.4. Pass an
 * IANA zone to pin it (e.g. for a client's configured reporting timezone);
 * otherwise the viewer's local zone is used and shown.
 */
export function formatTimestamp(
  iso: string,
  opts: { timeZone?: string; locale?: string; includeTime?: boolean } = {},
): string {
  const { timeZone, locale = 'en-US', includeTime = true } = opts;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_MEASURED;

  const dtf = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    timeZoneName: includeTime ? 'short' : undefined,
    timeZone,
  });
  return dtf.format(date);
}

/** Just the date portion, still explicit about which calendar day it falls
 *  on in the given (or local) timezone — used for source/report dates. */
export function formatDate(iso: string, opts: { timeZone?: string; locale?: string } = {}): string {
  const { timeZone, locale = 'en-US' } = opts;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_MEASURED;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(date);
}

/** The IANA zone identifier alone, e.g. "America/New_York", for a caller
 *  that wants to render its own "(zone)" suffix. */
export function resolveTimeZone(timeZone?: string): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Trims trailing zeros but keeps up to one decimal place for readability
 *  in dense tables (tabular-nums is applied globally in globals.css). */
function trimNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
