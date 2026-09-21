'use client';

import type { ReactNode } from 'react';
import { Timestamp } from './Timestamp';
import { cn } from '@/lib/utils';

export interface AsOfProps {
  /** ISO 8601 instant the data was captured/generated. `null`/`undefined` renders {@link AsOfProps.fallback}. */
  value: string | null | undefined;
  /** Pin to a specific IANA zone (e.g. the client's reporting timezone). Defaults to the viewer's local zone. */
  timeZone?: string;
  /** Include time-of-day. Defaults to date-only — the freshness *date* is what a client reads. */
  includeTime?: boolean;
  /** Leading text before the date. Defaults to "As of". */
  label?: string;
  /** What to render when there is no timestamp. Defaults to `null` (render nothing). */
  fallback?: ReactNode;
  className?: string;
}

/**
 * C6 §28 — the "as of [date]" freshness stamp shown on client-portal
 * score / metric / data panels. A direct extension of the product's
 * claims-discipline principle (PRD §07: never present a claim without its
 * provenance) onto the client-facing surface: every number a client reads
 * carries the date it was measured.
 *
 * Built on {@link Timestamp} so the timezone is always shown and an
 * unparseable date degrades to the shared "Not measured yet" label rather
 * than a broken string. Deliberately date-only by default — the calendar day
 * the data is from is the freshness signal; the exact minute is noise on a
 * client panel.
 *
 * Do **not** put this on a frozen "as released" report figure — that data is
 * intentionally pinned to the report it shipped in, and a live "as of today"
 * would misrepresent it. Use it for live/current panels.
 */
export function AsOf({ value, timeZone, includeTime = false, label = 'As of', fallback = null, className }: AsOfProps) {
  if (!value) return <>{fallback}</>;
  return (
    <span className={cn('inline-flex items-center gap-1 text-meta text-muted-foreground', className)}>
      <span>{label}</span>
      <Timestamp value={value} timeZone={timeZone} dateOnly={!includeTime} className="text-meta text-muted-foreground" />
    </span>
  );
}
