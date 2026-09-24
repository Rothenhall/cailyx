/**
 * Chart and KPI primitives for the PDF report — the pieces that let a reader
 * see what is good, what is not, and where the problem is, before reading a
 * sentence.
 *
 * Rules these follow (the dataviz method, applied to print):
 *   - Status (good / warning / critical) is a reserved, validated scale and is
 *     always drawn as shape + colour + a text label — never colour alone.
 *   - Data marks use the brand accent for the one thing the reader should look
 *     at and a de-emphasis stone for context; text always wears ink tokens.
 *   - Thin marks: bars ≤ 22pt, 4pt rounded data-end, square baseline, hairline
 *     tracks and baselines; values labelled at the bar tip, never inside.
 *   - Fixed point widths throughout — react-pdf's percentage maths is not
 *     reliable inside wrapped rows (see the tile note in report-pdf.ts).
 *
 * Status steps were run through the dataviz palette validator against the
 * report paper (#F7F3EA) together with the accent: lightness, chroma, CVD and
 * normal-vision separation all pass; warning is below 3:1 contrast by design,
 * which is why every status mark carries its label.
 *
 * @module report-pdf-visuals
 */

import * as React from 'react';
import { Circle, Line, Polygon, Rect, Svg, Text, View } from '@react-pdf/renderer';
import type { StatusLevel, StatusView } from './report-document';

const h = React.createElement;

/** Mirrors the report palette in report-pdf.ts / report-html.hbs, plus the status scale. */
export const vc = {
  ink: '#14120D',
  ink60: 'rgba(20,18,13,0.62)',
  line: 'rgba(20,18,13,0.15)',
  paper: '#F7F3EA',
  track: '#E7E0D1',
  stone: '#C4BBA8',
  accent: '#B8703F',
  good: '#00907A',
  warning: '#D1A52A',
  critical: '#8A2A1C',
} as const;

export const statusColor: Record<StatusLevel, string> = {
  good: vc.good,
  warning: vc.warning,
  critical: vc.critical,
  neutral: vc.stone,
};

// ─── Status ─────────────────────────────────────────────────────

/** Distinct shape per level, so the state survives greyscale print and colour-blindness. */
export function statusIcon(level: StatusLevel, size = 7): React.ReactElement {
  const c = statusColor[level];
  const r = size / 2;
  let shape: React.ReactElement;
  if (level === 'good') shape = h(Circle, { cx: r, cy: r, r, fill: c });
  else if (level === 'warning') shape = h(Polygon, { points: `${r},0 ${size},${size} 0,${size}`, fill: c });
  else if (level === 'critical') shape = h(Rect, { x: 0.5, y: 0.5, width: size - 1, height: size - 1, fill: c });
  else shape = h(Circle, { cx: r, cy: r, r: r - 0.75, fill: 'none', stroke: c, strokeWidth: 1.5 });
  return h(Svg, { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, shape);
}

/** Icon + label. Nothing at all for a neutral status with no label ("no judgement"). */
export function statusBadge(status: StatusView, key?: string): React.ReactElement | null {
  if (!status.label) return null;
  return h(
    View,
    { key, style: { flexDirection: 'row', alignItems: 'center', marginRight: 8 } },
    statusIcon(status.level),
    h(Text, { style: { fontSize: 7.5, lineHeight: 1.3, marginLeft: 3, color: vc.ink } }, status.label),
  );
}

/** ▲/▼ drawn as vectors, coloured by whether the move is good for the client — not by its direction. */
export function deltaChip(text: string, rising: boolean, good: boolean): React.ReactElement {
  const c = good ? vc.good : vc.critical;
  const pts = rising ? '4,0 8,7 0,7' : '0,0 8,0 4,7';
  return h(
    View,
    { style: { flexDirection: 'row', alignItems: 'center' } },
    h(Svg, { width: 8, height: 7, viewBox: '0 0 8 7' }, h(Polygon, { points: pts, fill: c })),
    h(Text, { style: { fontSize: 8.5, lineHeight: 1.3, marginLeft: 3, color: vc.ink, fontWeight: 'bold' } }, text),
  );
}

/**
 * Before → after on one scale: a stone dot where it was, an accent dot where
 * it is, joined by a bar in the status colour of the move.
 */
export function dumbbell(from: number, to: number, max: number, good: boolean, width: number): React.ReactElement {
  const pad = 5;
  const x = (v: number) => pad + (Math.max(0, Math.min(v, max)) / (max || 1)) * (width - pad * 2);
  const y = 6;
  return h(
    Svg,
    { width, height: 12, viewBox: `0 0 ${width} 12` },
    h(Line, { x1: pad, y1: y, x2: width - pad, y2: y, stroke: vc.track, strokeWidth: 2 }),
    h(Line, { x1: x(from), y1: y, x2: x(to), y2: y, stroke: good ? vc.good : vc.critical, strokeWidth: 3 }),
    h(Circle, { cx: x(from), cy: y, r: 4, fill: vc.stone, stroke: vc.paper, strokeWidth: 2 }),
    h(Circle, { cx: x(to), cy: y, r: 4.5, fill: vc.accent, stroke: vc.paper, strokeWidth: 2 }),
  );
}

// ─── Bars ───────────────────────────────────────────────────────

export interface HBar {
  label: string;
  /** Null draws "Not measured" instead of a bar — never a zero-length bar. */
  value: number | null;
  valueText: string;
  emphasis?: boolean;
  status?: StatusView;
}

/**
 * Horizontal bars on one shared 0..max scale, value at the tip, optional
 * status badge in a fixed right-hand column so badges line up.
 */
export function hbarChart(rows: HBar[], opts: { width: number; max: number; labelWidth?: number; badgeWidth?: number }): React.ReactElement {
  const labelWidth = opts.labelWidth ?? 120;
  const badgeWidth = opts.badgeWidth ?? 0;
  const valueWidth = 34;
  const trackWidth = opts.width - labelWidth - valueWidth - badgeWidth - 8;
  return h(
    View,
    { style: { marginBottom: 6 } },
    ...rows.map((r, i) => {
      const w = r.value === null ? 0 : Math.max(2, (Math.min(r.value, opts.max) / (opts.max || 1)) * trackWidth);
      return h(
        View,
        { key: `hb${i}`, style: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 } },
        h(Text, { style: { width: labelWidth, fontSize: 8.5, lineHeight: 1.3, color: vc.ink, fontWeight: r.emphasis ? 'bold' : 'normal' } }, r.label),
        r.value === null
          ? h(Text, { style: { width: trackWidth + valueWidth, fontSize: 8, lineHeight: 1.3, color: vc.ink60 } }, r.valueText)
          : h(
              View,
              { style: { flexDirection: 'row', alignItems: 'center', width: trackWidth + valueWidth } },
              h(View, {
                style: {
                  width: w,
                  height: 9,
                  backgroundColor: r.emphasis ? vc.accent : vc.stone,
                  borderTopRightRadius: 4,
                  borderBottomRightRadius: 4,
                },
              }),
              h(Text, { style: { fontSize: 8.5, lineHeight: 1.3, marginLeft: 4, color: vc.ink, fontWeight: r.emphasis ? 'bold' : 'normal' } }, r.valueText),
            ),
        badgeWidth > 0 ? h(View, { style: { width: badgeWidth, paddingLeft: 8 } }, r.status ? statusBadge(r.status) : null) : null,
      );
    }),
  );
}

// ─── Columns ────────────────────────────────────────────────────

export interface Column {
  value: number;
  valueText: string;
  label: string;
  sub: string;
  emphasis: boolean;
}

/**
 * One series over time as columns from a single baseline: the latest in the
 * accent, earlier ones in stone (the emphasis form — "where it is now" is the
 * point, the rest is context). Scale starts at 0 and tops out at `max`, a
 * round number above the tallest column decided by the data owner, so the
 * PDF and HTML charts share one scale.
 */
export function columnChart(cols: Column[], opts: { width: number; height: number; max: number }): React.ReactElement {
  const top = opts.max || 1;
  const slot = opts.width / Math.max(cols.length, 1);
  const barWidth = Math.min(22, slot * 0.4);
  return h(
    View,
    { style: { marginBottom: 4 } },
    h(
      View,
      { style: { flexDirection: 'row', alignItems: 'flex-end', height: opts.height + 14, borderBottomWidth: 1, borderBottomColor: vc.line } },
      ...cols.map((c, i) =>
        h(
          View,
          { key: `col${i}`, style: { width: slot, alignItems: 'center', justifyContent: 'flex-end' } },
          h(Text, { style: { fontSize: 8.5, lineHeight: 1.3, marginBottom: 2, color: vc.ink, fontWeight: c.emphasis ? 'bold' : 'normal' } }, c.valueText),
          h(View, {
            style: {
              width: barWidth,
              height: Math.max(2, (c.value / top) * opts.height),
              backgroundColor: c.emphasis ? vc.accent : vc.stone,
              borderTopLeftRadius: 4,
              borderTopRightRadius: 4,
            },
          }),
        ),
      ),
    ),
    h(
      View,
      { style: { flexDirection: 'row', marginTop: 3 } },
      ...cols.map((c, i) =>
        h(
          View,
          { key: `cl${i}`, style: { width: slot, alignItems: 'center' } },
          h(Text, { style: { fontSize: 7.5, lineHeight: 1.3, color: vc.ink, fontWeight: c.emphasis ? 'bold' : 'normal' } }, c.label),
          h(Text, { style: { fontSize: 7, lineHeight: 1.3, color: vc.ink60 } }, c.sub),
        ),
      ),
    ),
  );
}
