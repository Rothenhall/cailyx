'use client';

import type { ReactNode } from 'react';
import { formatNumber } from '@/lib/format';
import type { TechnicalTrendPoint } from '@/services/research';
import type { ChartTableColumn } from './ChartTable';
import { TrendChart, type TrendDatum } from './TrendChart';

/**
 * The technical-audit score series, shared by TA01 (website health) and PJ01
 * (project overview).
 *
 * It exists as one component rather than two page-local transforms because it
 * carries the comparability rule for this metric set, and that rule must not be
 * re-implemented per screen:
 *
 * **`targetUrl` is the comparison key.** design_plan.md §6.4 — *"a changed key
 * creates a methodology break"* — and the technical audit's own contract says
 * the same thing: the score is comparable only against a run that audited the
 * same URL. A run against a different host, or a staging subdomain, is a
 * *different measurement*, and one continuous line through both would turn a
 * scope change into a performance movement. So the series is split into
 * run-length segments on `targetUrl`, and every change is named in text.
 *
 * The score itself is read from the row — never recomputed, and never zeroed
 * when a run has no score.
 *
 * @module components/charts/TechnicalScoreHistory
 */

/** One run's score, plus the comparability segment it belongs to. */
export interface TechnicalScorePoint extends TrendDatum {
  /** What that run audited. The comparison key for this metric set. */
  readonly targetUrl: string;
  readonly failures: number;
  readonly pagesCrawled: number;
}

/**
 * Runs the response's chronological history into chart points.
 *
 * Segmentation is run-length, not "one segment per distinct target": a history
 * that audited `a.example`, then `b.example`, then `a.example` again is three
 * segments, because the third run is not comparable with the first *as a
 * neighbour* even though it shares a target. Grouping by distinct value would
 * join the first and third runs through the middle one and draw exactly the
 * line §6.4 forbids.
 */
export function toTechnicalScorePoints(
  history: ReadonlyArray<TechnicalTrendPoint>,
): TechnicalScorePoint[] {
  const points: TechnicalScorePoint[] = [];
  let segment = 0;
  let previousTarget: string | null = null;

  for (const run of history) {
    if (previousTarget !== null && run.targetUrl !== previousTarget) segment += 1;
    previousTarget = run.targetUrl;
    points.push({
      id: run.auditId,
      at: Date.parse(run.at),
      value: run.score,
      segment,
      targetUrl: run.targetUrl,
      failures: run.failures,
      pagesCrawled: run.pagesCrawled,
    });
  }

  return points;
}

export interface TechnicalScoreHistoryProps {
  /** Chronological, oldest first, exactly as the trend route returns it. */
  history: ReadonlyArray<TechnicalTrendPoint>;
  /** The engagement's reporting zone, for every timestamp this renders (§3.4). */
  timeZone?: string;
  /** Rendered instead of the plot when no run has been scored yet. */
  emptyState: ReactNode;
  height?: number;
  /** Shown under the plot in addition to the generated gap/break notes. */
  note?: ReactNode;
}

export function TechnicalScoreHistory({
  history,
  timeZone,
  emptyState,
  height,
  note,
}: TechnicalScoreHistoryProps) {

  const points = toTechnicalScorePoints(history);

  const columns: ReadonlyArray<ChartTableColumn<TechnicalScorePoint>> = [
    {
      key: 'target',
      header: 'Target audited',
      render: (row) => (
        <span className="block max-w-[22rem] truncate font-mono text-meta" title={row.targetUrl}>
          {row.targetUrl}
        </span>
      ),
    },
    {
      key: 'failures',
      header: 'Failing checks',
      align: 'right',
      render: (row) => formatNumber(row.failures),
    },
    {
      key: 'pages',
      header: 'Pages crawled',
      align: 'right',
      render: (row) => formatNumber(row.pagesCrawled),
    },
  ];

  return (
    <TrendChart
      seriesLabel="Technical score"
      points={points}
      yDomain={[0, 100]}
      timeZone={timeZone}
      formatValue={(value) => `${formatNumber(value)} / 100`}
      formatAxisTick={(value) => formatNumber(value)}
      extraColumns={columns}
      height={height}
      description={
        <>
          One point per scored technical-audit run, plotted against the time it ran — a run that came
          three months later sits three months further right. The axis is fixed at 0–100, the score&rsquo;s
          own range, so the line cannot stretch a small movement into a large one.
        </>
      }
      breakNote={<TargetBreakNote points={points} />}
      note={note}
      emptyState={emptyState}
    />
  );
}

/**
 * Names every point at which the audited target changed.
 *
 * The line breaks there, and a break with no explanation reads as missing data.
 * The two are different facts and this is the sentence that distinguishes them.
 */
function TargetBreakNote({ points }: { points: ReadonlyArray<TechnicalScorePoint> }) {
  const changes: Array<{ from: string; to: string; at: number }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (current.segment !== previous.segment) {
      changes.push({ from: previous.targetUrl, to: current.targetUrl, at: current.at });
    }
  }
  if (changes.length === 0) return null;

  return (
    <>
      The series is broken because the audit target changed
      {changes.length > 1 ? ` ${formatNumber(changes.length)} times` : ''}:{' '}
      {changes.map((change, index) => (
        <span key={`${change.at}-${index}`}>
          {index > 0 ? '; ' : ''}
          <span className="font-mono">{change.from}</span> → <span className="font-mono">{change.to}</span>
        </span>
      ))}
      . A run against a different target is a different measurement, so the two are not joined by a
      line and no movement is implied between them.
    </>
  );
}
