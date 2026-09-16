'use client';

import { formatTimestamp, resolveTimeZone } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface TimestampProps {
  /** ISO 8601 instant. */
  value: string;
  /** Pin to a specific IANA zone (e.g. the client's reporting timezone).
   *  Defaults to the viewer's local zone. */
  timeZone?: string;
  /** Date only, no time-of-day. Still shows the zone the date is anchored to
   *  when `timeZone` is explicit. */
  dateOnly?: boolean;
  className?: string;
}

/**
 * §3.4: "Date/time displays identify the timezone." This is the only place
 * a timestamp should be rendered — it always appends the zone, so no screen
 * can accidentally show a bare time that reads differently for the operator
 * and the client.
 */
export function Timestamp({ value, timeZone, dateOnly = false, className }: TimestampProps) {
  const zone = resolveTimeZone(timeZone);
  const formatted = formatTimestamp(value, { timeZone: zone, includeTime: !dateOnly });
  return (
    <time dateTime={value} className={cn('text-meta text-muted-foreground', className)}>
      {formatted}
    </time>
  );
}
