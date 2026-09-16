'use client';

import { useMemo, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipPayload,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber, formatPercent, notMeasuredLabel } from '@/lib/format';
import { ChartTable, type ChartTableColumn } from './ChartTable';
import { useChartTokens } from './tokens';

/**
 * One counted rate per category, each with the denominator it was computed over.
 *
 * This is the shape design_plan.md §6.3 asks for and §6.4 constrains:
 *
 * - **The denominator travels with the rate.** "38%" over 4 returned answers and
 *   over 500 look identical as a percentage and only one of them means
 *   anything, so every bar is labelled with its own `of N` and the table has a
 *   column for it. The rate itself is read from the row — this component never
 *   divides a numerator by a denominator itself, because a rate the server did
 *   not return is not a rate this screen is entitled to state.
 * - **A rate below its sampling floor is drawn in the de-emphasis gray, not the
 *   accent.** §6.4: the n≥5 floor "is not a significance test", but a row below
 *   it is not a comparable measurement either. It is an *emphasis* chart — the
 *   measurable rows carry the accent hue and the rest recede — so the gray
 *   encodes "not a valid comparison", never "low": it is accompanied by a text
 *   note and a table column, and never carries meaning by color alone.
 * - **A category with no denominator is not drawn at all.** Zero answers is
 *   `0/0`, which has no rate; it is named in the notes instead of being plotted
 *   at zero.
 *
 * @module components/charts/RateBarChart
 */

export interface RateBarDatum {
  /** Stable id, used for React keys and table rows. */
  readonly id: string;
  /** The category as the reader knows it, e.g. "ChatGPT · US". */
  readonly label: string;
  /**
   * The rate **as the server returned it**, as a fraction in 0–1. Never
   * derived here from a numerator and a denominator.
   */
  readonly rate: number;
  /**
   * How many observations the rate was computed over. This is the denominator
   * the screen must show; it is not optional.
   */
  readonly denominator: number;
  /**
   * Whether this row is a comparison the sampling floor supports. `false` rows
   * are de-emphasized and named in the note.
   */
  readonly comparable: boolean;
  /**
   * Why a `comparable: false` row is not comparable, in the words of the screen
   * that knows: a floor that was not met, a run that failed, a transport that
   * changed. Shown beside the rate in the table, because a gray bar says
   * "receded" and the reader is owed the reason.
   */
  readonly notComparableReason?: string;
}

export interface RateBarChartProps {
  /** What the rate is, e.g. "Named in an answer". Used in the chart's name. */
  measureLabel: string;
  rows: ReadonlyArray<RateBarDatum>;
  /** Shown above the plot; the place to state the cohort and the floor. */
  description?: ReactNode;
  /**
   * The sampling floor these rows were judged against, stated in text so the
   * gray bars are explained on the page and not only in a legend.
   */
  samplingFloor?: number;
  /** Extra copy under the plot. */
  notes?: ReactNode;
  height?: number;
  chartLabel?: string;
  emptyState: ReactNode;
}

interface RateRow extends RateBarDatum {
  /** Precomputed direct label, so the mark and the table cannot disagree. */
  labelText: string;
}

/**
 * `0.42` → `"42% of 45"`. One function builds both the bar's label and the
 * table's value, so the plot and the table cannot drift apart.
 */
function rateWithDenominator(row: RateBarDatum): string {
  return `${formatPercent(row.rate * 100)} of ${formatNumber(row.denominator)}`;
}

export function RateBarChart({
  measureLabel,
  rows,
  description,
  samplingFloor,
  notes,
  height,
  chartLabel,
  emptyState,
}: RateBarChartProps) {
  const tokens = useChartTokens();

  // `0/0` is not a rate. Those rows are named in the note below rather than
  // plotted at zero, which would read as "this engine named the client never".
  const drawable = useMemo(() => rows.filter((row) => row.denominator > 0), [rows]);
  const noDenominator = useMemo(() => rows.filter((row) => row.denominator === 0), [rows]);
  const belowFloor = useMemo(() => drawable.filter((row) => !row.comparable), [drawable]);

  const chartRows = useMemo<RateRow[]>(
    () => drawable.map((row) => ({ ...row, labelText: rateWithDenominator(row) })),
    [drawable],
  );

  const axisWidth = useMemo(() => {
    const longest = drawable.reduce((max, row) => Math.max(max, row.label.length), 0);
    return Math.min(200, Math.max(96, longest * 7));
  }, [drawable]);

  const columns = useMemo<ReadonlyArray<ChartTableColumn<RateBarDatum>>>(
    () => [
      { key: 'label', header: 'Engine', render: (row) => row.label },
      {
        key: 'denominator',
        header: 'Answers counted',
        align: 'right',
        render: (row) => formatNumber(row.denominator),
      },
      {
        key: 'rate',
        header: measureLabel,
        align: 'right',
        render: (row) => <span className="font-medium">{rateWithDenominator(row)}</span>,
      },
      {
        key: 'comparable',
        header: 'Comparable',
        render: (row) =>
          row.comparable ? (
            <span className="text-muted-foreground">Compared</span>
          ) : (
            <span className="block max-w-[24rem] text-unmeasured-foreground">
              {row.notComparableReason ?? 'Not comparable'}
            </span>
          ),
      },
    ],
    [measureLabel],
  );

  if (rows.length === 0) {
    return <>{emptyState}</>;
  }

  const plotHeight = height ?? Math.max(180, chartRows.length * 44 + 48);

  const name =
    chartLabel ??
    `Bar chart of ${measureLabel} by engine, each bar labelled with the answers it was counted from. ${formatNumber(
      drawable.length,
    )} of ${formatNumber(rows.length)} engines have a denominator. The table below carries the same values.`;

  return (
    <div className="space-y-3">
      {description ? <div className="text-table text-muted-foreground">{description}</div> : null}

      {drawable.length === 0 ? (
        emptyState
      ) : tokens === null ? (
        <Skeleton className="w-full rounded-lg" style={{ height: plotHeight }} />
      ) : (
        <div role="img" aria-label={name} className="w-full" style={{ height: plotHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={chartRows}
              accessibilityLayer={false}
              margin={{ top: 4, right: 96, bottom: 4, left: 0 }}
            >
              {/* Hairline, solid, and horizontal only — the category axis
                  already carries the vertical rule. */}
              <CartesianGrid stroke={tokens.border} strokeWidth={1} horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 1]}
                tick={{ fill: tokens['muted-foreground'], fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: tokens.border }}
                tickFormatter={(value: number) => formatPercent(value * 100)}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={axisWidth}
                tick={{ fill: tokens['muted-foreground'], fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: tokens['canvas'] }}
                content={(props) => (
                  <RateTooltip
                    {...props}
                    measureLabel={measureLabel}
                    rows={chartRows}
                    tokens={{
                      surface: tokens.surface,
                      border: tokens.border,
                    }}
                  />
                )}
              />
              <Bar
                dataKey="rate"
                name={measureLabel}
                // Bars are capped rather than filling the band, and the data
                // end is rounded while the baseline stays square.
                maxBarSize={24}
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
              >
                {chartRows.map((row) => (
                  <Cell
                    key={row.id}
                    fill={row.comparable ? tokens.primary : tokens.unmeasured}
                  />
                ))}
                <LabelList
                  dataKey="labelText"
                  position="right"
                  offset={8}
                  // Direct labels wear a text token, so identity never has to
                  // come from the mark's color.
                  fill={tokens.foreground}
                  fontSize={12}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {belowFloor.length > 0 ? (
        <p className="text-meta text-unmeasured-foreground">
          Drawn in gray rather than in the accent hue, because they are not comparable measurements:{' '}
          {belowFloor.map((row) => row.label).join(', ')}. The reason for each is in the table below,
          beside its rate. §6.4 treats a sampling floor as a requirement rather than a significance
          test, so no comparison is drawn from these rows — their rates and the answer counts they
          were counted over are still stated in full.
          {samplingFloor !== undefined
            ? ` This run's floor is ${formatNumber(samplingFloor)} answers.`
            : ''}
        </p>
      ) : null}

      {noDenominator.length > 0 ? (
        <p className="text-meta text-muted-foreground">
          Not plotted at all, because a rate over zero answers does not exist:{' '}
          {noDenominator.map((row) => `${row.label} (${notMeasuredLabel()})`).join(', ')}. The
          coverage panel above names why each of them returned nothing.
        </p>
      ) : null}

      {notes ? <div className="text-meta text-muted-foreground">{notes}</div> : null}

      <ChartTable
        caption={`${measureLabel} by engine, with the answers each rate was counted over — the same values as the chart above`}
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
      />
    </div>
  );
}

interface RateTooltipProps {
  active?: boolean;
  payload?: TooltipPayload;
  label?: string | number;
  measureLabel: string;
  /** The drawn rows, so the readout shows the same pair as the table. */
  rows: ReadonlyArray<RateRow>;
  tokens: { surface: string; border: string };
}

function RateTooltip({ active, payload, label, measureLabel, rows, tokens }: RateTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  // The category comes from the axis and the pair comes from the row itself —
  // not from the mark — so a hovered bar and its table row always agree, and
  // the denominator is never reconstructed from a percentage.
  const row = typeof label === 'string' ? rows.find((entry) => entry.label === label) : undefined;

  return (
    <div
      className="rounded-md border px-3 py-2 shadow-overlay"
      style={{ background: tokens.surface, borderColor: tokens.border }}
    >
      <p className="text-meta text-muted-foreground">{row ? row.label : String(label ?? '')}</p>
      <p className="text-table font-medium text-foreground">
        {measureLabel}:{' '}
        {row ? (
          rateWithDenominator(row)
        ) : (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        )}
      </p>
      {row && !row.comparable ? (
        <p className="text-meta text-unmeasured-foreground">
          Below the sampling floor — not compared.
        </p>
      ) : null}
    </div>
  );
}
