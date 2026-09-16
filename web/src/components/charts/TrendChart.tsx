'use client';

import { useMemo, type ReactNode } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipPayload,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { ChartTable, type ChartTableColumn } from './ChartTable';
import { useChartTokens } from './tokens';

/**
 * A single measured series over time, with its accessible table.
 *
 * The three rules this component exists to enforce, all from design_plan.md:
 *
 * 1. **§3.4 — the table is not optional.** Every render includes a `ChartTable`
 *    carrying the same rows the line drew. Nothing here is readable only by
 *    hovering a point or by telling two hues apart.
 * 2. **§3.5 / §6.3 — "empty is not zero".** A point whose value is `null` was
 *    never measured. It is passed through as `null` with
 *    `connectNulls={false}`, so the line breaks rather than dropping to the
 *    axis, and the gap is named in text. Drawing it as `0` would be the single
 *    most damaging thing this file could do.
 * 3. **§6.4 — a changed comparison key is a methodology break.** Points carry
 *    the index of the comparability segment they belong to, and a new segment
 *    starts a new line. One continuous stroke across two differently-measured
 *    runs would assert a comparability the data does not have, which is exactly
 *    what `patterns/ChangeComparison` refuses to do for a pair of runs.
 *
 * @module components/charts/TrendChart
 */

/** One measured point. `value: null` means "not measured", never zero. */
export interface TrendDatum {
  /** Stable id for React keys and table rows. */
  readonly id: string;
  /** The instant the measurement belongs to, in epoch milliseconds. */
  readonly at: number;
  /** The measured value, or `null` when nothing was measured. */
  readonly value: number | null;
  /**
   * The point's label **exactly as the source reported it**, when the source
   * reports a calendar day rather than an instant.
   *
   * A Search Console row is a day in the property's own reporting timezone.
   * Running that through a viewer's zone shifts it by one for anyone west of
   * UTC, which would print a different day than the one Google reported. When
   * this is set it is used verbatim in the table and the tooltip, and `at`
   * carries the UTC-midnight instant only so the x-axis can place the point.
   */
  readonly label?: string;
  /**
   * Index of the comparability segment. Points sharing an index were measured
   * the same way and are joined; a change in this number breaks the line.
   */
  readonly segment: number;
}

export interface TrendChartProps<D extends TrendDatum> {
  /** The measure being plotted, e.g. "Technical score". Used in the chart's name. */
  seriesLabel: string;
  points: ReadonlyArray<D>;
  /** Renders a measured value identically in the tooltip and the table. */
  formatValue: (value: number) => string;
  /**
   * Renders a y-axis tick. Defaults to `formatValue`, which is right when the
   * whole value fits in a tick — pass this when the value carries a unit that
   * would crowd the axis (`"78 / 100"` belongs in the table, `"78"` on the tick).
   */
  formatAxisTick?: (value: number) => string;
  /**
   * Fixes the y-axis. Pass it whenever the metric has a natural floor and
   * ceiling (a 0–100 score) so the axis cannot stretch the movement: a line
   * from 78 to 81 over a 0–100 domain reads as a small movement, and over a
   * 77–82 domain reads as a recovery.
   */
  yDomain?: [number, number];
  /** The reporting zone for every timestamp this component renders (§3.4). */
  timeZone?: string;
  /** Shown above the plot. The place to state the unit and the cadence. */
  description?: ReactNode;
  /** Extra columns appended to the table after the value and the date. */
  extraColumns?: ReadonlyArray<ChartTableColumn<D>>;
  /**
   * What changed to break the series. Required reading whenever more than one
   * segment is present — a dot count alone does not tell the reader that two
   * differently-measured runs are being drawn.
   */
  breakNote?: ReactNode;
  /**
   * Extra copy under the plot: provenance, what the window covers, what the
   * chart does not start. Rendered after the gap and break notes, which are
   * generated here because only this component knows where the holes are.
   */
  note?: ReactNode;
  /** Plot height in pixels, including the axis band. */
  height?: number;
  /** Overrides the generated accessible name for the plot. */
  chartLabel?: string;
  /**
   * Rendered instead of the plot when there is nothing to draw — a not-measured
   * `EmptyState`, so the screen names the prerequisite rather than showing an
   * empty axis.
   */
  emptyState: ReactNode;
}

/** A row as Recharts sees it: one key per segment, plus the x value. */
interface TrendRow {
  at: number;
  [segmentKey: string]: number | string | null;
}

const SEGMENT_KEY_PREFIX = 'value_';

const DAY_MS = 24 * 60 * 60 * 1000;

export function TrendChart<D extends TrendDatum>({
  seriesLabel,
  points,
  formatValue,
  formatAxisTick,
  yDomain,
  timeZone,
  description,
  extraColumns,
  breakNote,
  note,
  height = 240,
  chartLabel,
  emptyState,
}: TrendChartProps<D>) {
  const tokens = useChartTokens();

  const segments = useMemo(
    () => [...new Set(points.map((point) => point.segment))].sort((a, b) => a - b),
    [points],
  );

  /**
   * One key per segment rather than one key for the whole series: that is how
   * the line is broken at a methodology change. Every row carries a `null` for
   * the segments it is not part of, and `connectNulls={false}` leaves the hole.
   */
  const rows = useMemo<TrendRow[]>(
    () =>
      points.map((point) => {
        const row: TrendRow = { at: point.at };
        for (const segment of segments) {
          row[`${SEGMENT_KEY_PREFIX}${segment}`] = point.segment === segment ? point.value : null;
        }
        return row;
      }),
    [points, segments],
  );

  const measured = points.filter((point) => point.value !== null);
  const gaps = points.filter((point) => point.value === null);

  const firstAt = points.length > 0 ? points[0].at : 0;
  const lastAt = points.length > 0 ? points[points.length - 1].at : 0;

  /**
   * A numeric time axis, so a run that came three months later is three months
   * further right rather than the next slot along.
   *
   * `[dataMin, dataMax]` collapses to a zero-width domain when every point
   * shares an instant (a project with a single run), which leaves the scale
   * with nothing to divide by — so a degenerate span is widened to a day either
   * side of the point instead.
   */
  const timeDomain: [number, number] =
    lastAt > firstAt ? [firstAt, lastAt] : [firstAt - DAY_MS, lastAt + DAY_MS];

  const columns = useMemo<ReadonlyArray<ChartTableColumn<D>>>(() => {
    const base: ChartTableColumn<D>[] = [
      {
        key: 'point',
        header: 'Measured at',
        render: (row) => {
          // A source that reported a calendar day keeps that day: converting it
          // to an instant would move it across midnight for some viewers.
          if (row.label) return <span className="tabular-nums">{row.label}</span>;
          // A run whose time did not parse is named as unrecorded rather than
          // dropped: the value was still measured, and hiding the row would
          // make the table disagree with the chart.
          const iso = isoOrNull(row.at);
          return iso ? (
            <Timestamp value={iso} timeZone={timeZone} />
          ) : (
            <span className="text-muted-foreground">Time not recorded</span>
          );
        },
      },
      {
        key: 'value',
        header: seriesLabel,
        align: 'right',
        // §3.5: a value that was never measured is named, never shown as 0.
        render: (row) =>
          row.value === null ? (
            <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
          ) : (
            <span className="font-medium">{formatValue(row.value)}</span>
          ),
      },
    ];
    return extraColumns ? [...base, ...extraColumns] : base;
  }, [extraColumns, formatValue, seriesLabel, timeZone]);

  if (points.length === 0) {
    return <>{emptyState}</>;
  }

  const firstDate = isoOrNull(firstAt);
  const lastDate = isoOrNull(lastAt);
  const name =
    chartLabel ??
    `Line chart of ${seriesLabel}: ${formatNumber(measured.length)} measured of ${formatNumber(
      points.length,
    )} points${firstDate && lastDate ? `, ${firstDate.slice(0, 10)} to ${lastDate.slice(0, 10)}` : ''}.${
      segments.length > 1 ? ` Drawn as ${segments.length} separate segments.` : ''
    } The table below carries the same values.`;

  return (
    <div className="space-y-3">
      {description ? <div className="text-table text-muted-foreground">{description}</div> : null}

      {measured.length === 0 ? (
        emptyState
      ) : tokens === null ? (
        // The tokens have not been read yet (one tick after mount). Holding the
        // space avoids the layout jump the anti-pattern list warns about.
        <Skeleton className="w-full rounded-lg" style={{ height }} />
      ) : (
        <div role="img" aria-label={name} className="w-full" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {/*
              `accessibilityLayer` is off because the wrapper above is already a
              `role="img"` with a name; a nested `role="application"` inside a
              presentational subtree would be a focusable element no screen
              reader can reach. The table is the accessible path to the values,
              and it is always present.

              `isAnimationActive={false}` satisfies §3.4's reduced-motion rule
              for every reader rather than only those who ask: a line that
              draws itself in on load is decoration, and the honest minimum is
              not to animate a measurement.
            */}
            <LineChart
              data={rows}
              accessibilityLayer={false}
              margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
            >
              {/* §3.1: gridlines are a hairline one step off the surface, solid,
                  never dashed — dashing reads as a threshold that is not there. */}
              <CartesianGrid stroke={tokens.border} strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="at"
                type="number"
                domain={timeDomain}
                // Keeps the first and last markers off the axis rules.
                padding={{ left: 12, right: 12 }}
                // Tick text wears a text token, never the series color.
                tick={{ fill: tokens['muted-foreground'], fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: tokens.border }}
                tickFormatter={(value: number) => shortDate(value, timeZone)}
                interval="preserveStartEnd"
                minTickGap={32}
              />
              <YAxis
                {...(yDomain ? { domain: yDomain } : {})}
                tick={{ fill: tokens['muted-foreground'], fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(value: number) => (formatAxisTick ?? formatValue)(value)}
              />
              <Tooltip
                cursor={{ stroke: tokens['muted-foreground'], strokeWidth: 1 }}
                content={(props) => (
                  <TrendTooltip
                    {...props}
                    seriesLabel={seriesLabel}
                    formatValue={formatValue}
                    timeZone={timeZone}
                    points={points}
                    tokens={{
                      surface: tokens.surface,
                      border: tokens.border,
                      muted: tokens['muted-foreground'],
                    }}
                  />
                )}
              />
              {segments.map((segment) => (
                <Line
                  key={segment}
                  name={seriesLabel}
                  type="linear"
                  dataKey={`${SEGMENT_KEY_PREFIX}${segment}`}
                  stroke={tokens.primary}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  // A hole in the data stays a hole.
                  connectNulls={false}
                  isAnimationActive={false}
                  // 8px marker with a 2px surface ring, so overlapping points
                  // stay legible where the line crosses itself.
                  dot={{ r: 4, fill: tokens.primary, stroke: tokens.surface, strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: tokens.primary, stroke: tokens.surface, strokeWidth: 2 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {segments.length > 1 ? (
        <p className="text-meta text-muted-foreground">
          {breakNote ?? (
            <>
              These runs were not measured the same way, so the line is broken at{' '}
              {formatNumber(segments.length - 1)} point{segments.length === 2 ? '' : 's'} instead of
              being drawn as one continuous series. A single line across them would assert a
              comparability the runs do not have.
            </>
          )}
        </p>
      ) : null}

      {gaps.length > 0 ? (
        <p className="text-meta text-unmeasured-foreground">
          {formatNumber(gaps.length)} of {formatNumber(points.length)} points were never measured and
          are left as gaps, not drawn as zero. The table names them “{notMeasuredLabel()}”.
        </p>
      ) : null}

      {note ? <p className="text-meta text-muted-foreground">{note}</p> : null}

      <ChartTable
        caption={`${seriesLabel}, every point the chart above draws — the same values without hover or colour`}
        columns={columns}
        rows={points}
        getRowKey={(row) => row.id}
      />
    </div>
  );
}

interface TrendTooltipProps {
  active?: boolean;
  payload?: TooltipPayload;
  label?: string | number;
  seriesLabel: string;
  formatValue: (value: number) => string;
  timeZone?: string;
  /** The plotted points, so the readout names the same instant as the table. */
  points: ReadonlyArray<TrendDatum>;
  tokens: { surface: string; border: string; muted: string };
}

/**
 * The hover readout. It shows the value for the hovered instant — including
 * "not measured" — and is an enhancement only: the table below carries every
 * one of these values without a pointer.
 */
function TrendTooltip({
  active,
  payload,
  label,
  seriesLabel,
  formatValue,
  timeZone,
  points,
  tokens,
}: TrendTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  // Every segment renders a line, so several entries can describe the same
  // instant. They hold one value between them; take it, wherever it sits.
  const entry = payload.find((item) => typeof item.value === 'number');
  const value = typeof entry?.value === 'number' ? entry.value : null;
  const point = typeof label === 'number' ? points.find((item) => item.at === label) : undefined;
  const at = !point?.label && typeof label === 'number' ? isoOrNull(label) : null;

  return (
    <div
      className="rounded-md border px-3 py-2 shadow-overlay"
      style={{ background: tokens.surface, borderColor: tokens.border }}
    >
      {point?.label ? (
        <p className="text-meta text-muted-foreground tabular-nums">{point.label}</p>
      ) : at ? (
        <Timestamp value={at} timeZone={timeZone} />
      ) : null}
      <p className="text-table font-medium text-foreground">
        {seriesLabel}:{' '}
        {value === null ? (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        ) : (
          formatValue(value)
        )}
      </p>
    </div>
  );
}

/** `12 Mar` style ticks — the year is in the table and the chart's name. */
function shortDate(epochMs: number, timeZone?: string): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(date);
}

/**
 * An epoch as an ISO instant, or `null` when it is not a real date.
 *
 * `new Date(NaN).toISOString()` throws, and `Timestamp` labels an unparseable
 * string "Not measured yet" — which would be the wrong claim for a row that was
 * measured but whose time was not recorded. So an unparseable instant is named
 * as an unrecorded time instead.
 */
function isoOrNull(epochMs: number): string | null {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
