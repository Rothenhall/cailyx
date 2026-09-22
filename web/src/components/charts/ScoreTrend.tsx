'use client';

import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { BAND_THRESHOLDS, bandMeta, clampScore } from './score';

export interface ScoreTrendPoint {
  /** ISO 8601. Used for ordering and for the tooltip. */
  date: string;
  score: number;
  band?: string | null;
  label?: string;
}

export interface ScoreTrendProps {
  /** Any order; the chart sorts oldest → newest itself. */
  points: ScoreTrendPoint[];
  className?: string;
}

/* The drawing grid. A fixed viewBox scaled by CSS keeps the layout math simple;
   strokes opt out of that scaling so a 2px line stays 2px at any width. */
const W = 640;
const H = 180;
const PAD = { top: 14, right: 16, bottom: 22, left: 30 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function x(index: number, count: number): number {
  if (count <= 1) return PAD.left + PLOT_W / 2;
  return PAD.left + (index / (count - 1)) * PLOT_W;
}

function y(score: number): number {
  return PAD.top + (1 - clampScore(score) / 100) * PLOT_H;
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Score over time — the one question a run of reports is actually asked:
 * is this going up?
 *
 * One series, so there is no legend and no categorical palette: the title names
 * it. The 40/60/80 band thresholds are drawn as recessive reference lines,
 * which is what makes a raw score readable — a 62 means nothing until you can
 * see it just cleared "present".
 *
 * Every point stays available as text: the accessible summary lists them, and
 * the surrounding page lists each report with its own score.
 */
export function ScoreTrend({ points, className }: ScoreTrendProps) {
  const gradientId = useId();
  const [active, setActive] = useState<number | null>(null);

  const series = [...points]
    .filter((point) => typeof point.score === 'number')
    .sort((a, b) => a.date.localeCompare(b.date));

  // One point is not a trend. The caller shows the score itself in that case.
  if (series.length < 2) return null;

  const coords = series.map((point, index) => ({
    ...point,
    cx: x(index, series.length),
    cy: y(point.score),
  }));

  const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx} ${p.cy}`).join(' ');
  const area =
    `M ${coords[0].cx} ${PAD.top + PLOT_H} ` +
    coords.map((p) => `L ${p.cx} ${p.cy}`).join(' ') +
    ` L ${coords[coords.length - 1].cx} ${PAD.top + PLOT_H} Z`;

  const last = coords[coords.length - 1];
  const first = coords[0];
  const delta = last.score - first.score;
  const shown = active !== null ? coords[active] : null;

  return (
    <figure className={cn('m-0', className)}>
      <figcaption className="sr-only">
        {`Report score over time, ${series.length} reports. ` +
          series.map((p) => `${formatDate(p.date)}: ${p.score}`).join('; ')}
      </figcaption>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`Score trend: ${first.score} to ${last.score} across ${series.length} reports`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.14" />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Band thresholds — recessive, labelled, and the reason a raw score
              can be read at a glance. */}
          {BAND_THRESHOLDS.map((threshold) => (
            <g key={threshold}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT_W}
                y1={y(threshold)}
                y2={y(threshold)}
                stroke="hsl(var(--border))"
                strokeWidth="1"
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={PAD.left - 7}
                y={y(threshold)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {threshold}
              </text>
            </g>
          ))}

          <path d={area} fill={`url(#${gradientId})`} />
          <path
            d={line}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {coords.map((point, index) => (
            <g key={`${point.date}-${index}`}>
              {/* A generous invisible hit target — the visible dot is small. */}
              <circle
                cx={point.cx}
                cy={point.cy}
                r="14"
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              />
              <circle
                cx={point.cx}
                cy={point.cy}
                r={active === index ? 5 : 3.5}
                fill="hsl(var(--surface))"
                stroke="hsl(var(--primary))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                className="transition-[r] duration-fast ease-out"
              />
            </g>
          ))}

          {/* Only the newest point is labelled — a number on every point is
              noise when the list below carries them all. */}
          <text
            x={last.cx}
            y={last.cy - 12}
            textAnchor="end"
            className="fill-foreground text-[13px] font-semibold tabular-nums"
          >
            {last.score}
          </text>
        </svg>

        {shown ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-night px-2.5 py-1.5 text-meta text-night-text shadow-medium"
            style={{
              left: `${(shown.cx / W) * 100}%`,
              top: `${(shown.cy / H) * 100}%`,
            }}
          >
            <div className="font-semibold tabular-nums">{shown.score}</div>
            <div className="opacity-80">
              {formatDate(shown.date)}
              {bandMeta(shown.band) ? ` · ${bandMeta(shown.band)?.label}` : ''}
            </div>
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-meta text-muted-foreground">
        {delta === 0
          ? 'No change since the first report'
          : `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta)} points since the first report`}
      </p>
    </figure>
  );
}
