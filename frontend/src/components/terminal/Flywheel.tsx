'use client';

/**
 * Flywheel — an answerthepublic-style LAYERED radial of buyer search queries:
 * hub → awareness stage → theme → query. Each query carries the buyer pain
 * point it maps to and the suggestion Cailyx would make; those show, in full
 * readable text, in the detail panel below the wheel. Click a query to drop it
 * into the Chat card.
 *
 * Data: GET /api/projects/:id/journeys/suggestions (deterministic, no LLM).
 *
 * @module components/terminal/Flywheel
 */

import { useEffect, useMemo, useState } from 'react';

export const flywheelMeta = { key: 'flywheel' as const, title: 'Flywheel', icon: '❋' };

export type SuggestionSource = 'template' | 'persona' | 'journey';

export interface SuggestionWheel {
  hub: { label: string; domain: string; category: string };
  stages: Array<{
    key: string;
    label: string;
    themes: Array<{
      label: string;
      queries: Array<{ text: string; source: SuggestionSource; painPoint: string; suggestion: string }>;
    }>;
  }>;
  total: number;
}

/* warm ramp per stage: cream → brass → cognac (BRANDING) */
const RAMP = [
  { fill: '#efe6d3', stroke: '#dcccae', text: '#5c5648' },
  { fill: '#e3caa2', stroke: '#cbab77', text: '#4a4436' },
  { fill: '#cf9560', stroke: '#b87c46', text: '#3a2b1c' },
  { fill: '#a85c30', stroke: '#8a4a26', text: '#fbf3ea' },
];
const SRC_DOT: Record<SuggestionSource, string> = {
  template: 'var(--accent)',
  journey: 'var(--cognac)',
  persona: 'var(--amber)',
};

const SIZE = 360;
const C = SIZE / 2;
const R_HUB = 46;
const R_STAGE = 98;
const R_THEME = 152;
const R_TICK_IN = 156;
const R_TICK_OUT = 168;

const rad = (d: number) => (d * Math.PI) / 180;
const pt = (r: number, d: number) => [C + r * Math.cos(rad(d)), C + r * Math.sin(rad(d))] as const;

function arc(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = pt(r0, a0);
  const [x1, y1] = pt(r1, a0);
  const [x2, y2] = pt(r1, a1);
  const [x3, y3] = pt(r0, a1);
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 ${big} 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 ${big} 0 ${x0},${y0} Z`;
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function Flywheel({
  wheel,
  loading,
  onPick,
}: {
  wheel: SuggestionWheel | null;
  loading: boolean;
  onPick?: (q: string) => void;
}) {
  const [selStage, setSelStage] = useState(0);
  const [selTheme, setSelTheme] = useState<number | null>(0);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    setSelStage(0);
    setSelTheme(0);
  }, [wheel?.hub.domain]);

  const stages = wheel?.stages ?? [];
  const stage = stages[selStage] ?? null;
  const themesToShow = useMemo(() => {
    if (!stage) return [];
    return selTheme === null ? stage.themes : stage.themes[selTheme] ? [stage.themes[selTheme]] : stage.themes;
  }, [stage, selTheme]);

  if (loading && !wheel) return <p className="p-4 text-faint">building suggestions…</p>;
  if (!wheel || !Array.isArray(wheel.stages)) return <p className="p-4 text-faint">select a project</p>;
  if (wheel.total === 0)
    return (
      <p className="p-4 text-[12px] text-faint">
        No suggestions yet. Add a category + personas, or plan a journey — the Flywheel builds from those.
      </p>
    );

  const span = 360 / (wheel.stages.length || 1);

  return (
    <div className="flex h-full flex-col">
      {/* ── sunburst ── */}
      <div className="shrink-0 border-b border-border p-2">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto block h-auto w-full max-w-[420px]" style={{ userSelect: 'none' }}>
          {wheel.stages.map((st, si) => {
            const s0 = -90 + si * span;
            const s1 = -90 + (si + 1) * span;
            const smid = (s0 + s1) / 2;
            const c = RAMP[si % RAMP.length];
            const [slx, sly] = pt((R_HUB + R_STAGE) / 2, smid);
            const sflip = smid > 90 && smid < 270;
            const stageSel = si === selStage;

            // themes subdivide the stage wedge equally
            const tCount = st.themes.length || 1;
            const tSpan = (s1 - s0) / tCount;

            return (
              <g key={st.key}>
                {/* stage wedge */}
                <path
                  d={arc(R_HUB + 3, R_STAGE, s0 + 1, s1 - 1)}
                  fill={c.fill}
                  stroke={stageSel ? 'var(--cognac)' : '#fbf9f3'}
                  strokeWidth={stageSel ? 2.5 : 1.5}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setSelStage(si); setSelTheme(null); }}
                />
                <text
                  x={slx}
                  y={sly}
                  fill={c.text}
                  fontSize={11}
                  fontWeight={700}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${sflip ? smid + 180 : smid}, ${slx}, ${sly})`}
                  style={{ letterSpacing: '0.05em', pointerEvents: 'none' }}
                >
                  {st.label.toUpperCase()}
                </text>

                {/* theme wedges + query ticks */}
                {st.themes.map((th, ti) => {
                  const t0 = s0 + ti * tSpan + 0.6;
                  const t1 = s0 + (ti + 1) * tSpan - 0.6;
                  const tmid = (t0 + t1) / 2;
                  const themeSel = stageSel && selTheme === ti;
                  const [tlx, tly] = pt((R_STAGE + R_THEME) / 2, tmid);
                  const tflip = tmid > 90 && tmid < 270;
                  const wide = t1 - t0 > 16;
                  return (
                    <g key={ti}>
                      <path
                        d={arc(R_STAGE, R_THEME, t0, t1)}
                        fill={c.fill}
                        fillOpacity={themeSel ? 1 : 0.55}
                        stroke={themeSel || hover === `${si}:${ti}` ? 'var(--cognac)' : c.stroke}
                        strokeWidth={themeSel ? 2 : 1}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHover(`${si}:${ti}`)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => { setSelStage(si); setSelTheme(ti); }}
                      />
                      {wide && (
                        <text
                          x={tlx}
                          y={tly}
                          fill={c.text}
                          fontSize={8.5}
                          fontWeight={themeSel ? 700 : 500}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          transform={`rotate(${tflip ? tmid + 180 : tmid}, ${tlx}, ${tly})`}
                          style={{ pointerEvents: 'none' }}
                        >
                          {clip(th.label, 16)}
                        </text>
                      )}
                      {/* one tick per query */}
                      {th.queries.map((q, qi) => {
                        const qa = t0 + 2 + (th.queries.length > 1 ? (qi / (th.queries.length - 1)) * (t1 - t0 - 4) : (t1 - t0) / 2);
                        const [a0x, a0y] = pt(R_TICK_IN, qa);
                        const [a1x, a1y] = pt(R_TICK_OUT, qa);
                        return <line key={qi} x1={a0x} y1={a0y} x2={a1x} y2={a1y} stroke={SRC_DOT[q.source]} strokeWidth={1.5} />;
                      })}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* hub */}
          <circle cx={C} cy={C} r={R_HUB} fill="#fbf9f3" stroke="var(--border-strong)" strokeWidth={1.5} />
          <text x={C} y={C - 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--text)">
            {clip(wheel.hub.label, 12)}
          </text>
          <text x={C} y={C + 11} textAnchor="middle" fontSize={7.5} fill="var(--text-faint)">
            {clip(wheel.hub.category, 20)}
          </text>
        </svg>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[10px] text-faint">
          <span><span style={{ color: SRC_DOT.template }}>│</span> library</span>
          <span><span style={{ color: SRC_DOT.journey }}>│</span> from a journey</span>
          <span><span style={{ color: SRC_DOT.persona }}>│</span> from a persona</span>
          <span>· {wheel.total} suggestions</span>
        </div>
      </div>

      {/* ── detail panel (fully readable text) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">
          {stage?.label}
          {selTheme !== null && stage?.themes[selTheme] ? ` › ${stage.themes[selTheme].label}` : ' › all themes'}
        </p>
        <ul className="space-y-2.5">
          {themesToShow.flatMap((th, tIdx) =>
            th.queries.map((q, qIdx) => (
              <li
                key={`${tIdx}:${qIdx}`}
                className="rounded-md border border-border bg-bg-inset p-2.5"
              >
                <button
                  onClick={() => onPick?.(q.text)}
                  className="flex w-full items-start gap-2 text-left"
                  title="Send to Chat"
                >
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SRC_DOT[q.source] }} />
                  <span className="text-[12px] font-semibold leading-snug text-text hover:text-cognac">{q.text}</span>
                </button>
                <p className="mt-1 pl-3.5 text-[11px] leading-snug text-dim">
                  <span className="text-faint">pain · </span>
                  {q.painPoint}
                </p>
                <p className="mt-0.5 pl-3.5 text-[11px] leading-snug text-cognac">
                  <span className="text-faint">→ </span>
                  {q.suggestion}
                </p>
              </li>
            )),
          )}
        </ul>
      </div>
    </div>
  );
}
