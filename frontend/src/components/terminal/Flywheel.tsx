'use client';

/**
 * Flywheel — an answerthepublic-style LAYERED radial of buyer search queries:
 * hub → awareness stage → theme. Each theme's queries (with the buyer pain
 * point they map to and the suggestion Cailyx would make) show in full,
 * readable text in the detail panel below. Click a wedge to filter it; click a
 * query row to send it to Chat.
 *
 * Data: GET /api/projects/:id/journeys/suggestions (deterministic, no LLM).
 *
 * @module components/terminal/Flywheel
 */

import { useEffect, useMemo, useState } from 'react';

export const flywheelMeta = { key: 'flywheel' as const, title: 'Flywheel', icon: '❋' };

export type SuggestionSource = 'template' | 'persona' | 'journey';
export type BoostLane = 'AEO' | 'GEO' | 'Content' | 'Technical' | 'Authority' | 'Measurement';

export interface SuggestionBoost {
  id: string;
  lane: BoostLane;
  title: string;
  why: string;
  action: string;
  evidence: string;
  effort: 'quick' | 'project';
}

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
  boosts?: SuggestionBoost[];
  total: number;
  boostCount?: number;
}

const LANE_COLOR: Record<BoostLane, string> = {
  AEO: 'var(--accent)',
  GEO: 'var(--cognac)',
  Content: 'var(--amber)',
  Technical: 'var(--red)',
  Authority: 'var(--blue)',
  Measurement: 'var(--accent-dim)',
};

/* warm ramp per stage: cream → brass → cognac (BRANDING) */
const RAMP = [
  { fill: '#f0e7d6', on: '#5c5648' },
  { fill: '#e4cba4', on: '#4a4436' },
  { fill: '#d19a68', on: '#31241a' },
  { fill: '#a85c30', on: '#fbf3ea' },
];
const SRC_DOT: Record<SuggestionSource, string> = {
  template: 'var(--accent)',
  journey: 'var(--cognac)',
  persona: 'var(--amber)',
};

const VB = 560;
const C = VB / 2;
const R_HUB = 60;
const R_STAGE = 120; // stage ring: hub → 120
const R_THEME = 176; // theme ring: 120 → 176
const R_LABEL = 184; // theme labels start here, radiating out
const MAX_THEMES = 5;

const rad = (d: number) => (d * Math.PI) / 180;
const pt = (r: number, d: number) => [C + r * Math.cos(rad(d)), C + r * Math.sin(rad(d))] as const;

function seg(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = pt(r0, a0);
  const [x1, y1] = pt(r1, a0);
  const [x2, y2] = pt(r1, a1);
  const [x3, y3] = pt(r0, a1);
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 ${big} 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 ${big} 0 ${x0},${y0} Z`;
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const shortTheme = (s: string) =>
  s.replace(/^From your /i, 'Your ').replace(/^Is this a real problem$/i, 'Is this real');

export function Flywheel({
  wheel,
  loading,
  onPick,
}: {
  wheel: SuggestionWheel | null;
  loading: boolean;
  onPick?: (q: string) => void;
}) {
  const [sel, setSel] = useState<{ s: number; t: number | null }>({ s: 0, t: null });
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<'queries' | 'boosts'>('queries');

  useEffect(() => setSel({ s: 0, t: null }), [wheel?.hub.domain]);

  const stages = useMemo(
    () =>
      (wheel?.stages ?? []).map((st) => ({
        ...st,
        themes: st.themes.slice(0, MAX_THEMES),
      })),
    [wheel],
  );

  if (!wheel || !Array.isArray(wheel.stages))
    return <p className="p-4 text-faint">{loading ? 'building suggestions…' : 'no suggestions loaded yet'}</p>;
  if (wheel.total === 0)
    return (
      <p className="p-4 text-[12px] text-faint">
        No suggestions yet. Add a category + personas, or plan a journey — the Flywheel builds from those.
      </p>
    );

  const boosts = wheel.boosts ?? [];
  const stage = stages[sel.s] ?? null;
  const rows = !stage
    ? []
    : (sel.t === null ? stage.themes : stage.themes[sel.t] ? [stage.themes[sel.t]] : stage.themes).flatMap((th) =>
        th.queries.map((q) => ({ ...q, theme: th.label })),
      );

  const span = 360 / (stages.length || 1);

  const fwc = { ['--fw-c' as string]: `${C}px` } as React.CSSProperties;

  return (
    <div className="flex h-full flex-col">
      {/* ── sunburst ── */}
      <div className="shrink-0 border-b border-border bg-bg-inset/40 p-3">
        <svg viewBox={`0 0 ${VB} ${VB}`} className="mx-auto block h-auto w-full max-w-[440px]" style={{ userSelect: 'none' }}>
          {/* faint concentric rings — slow ambient spin + one breathing pulse */}
          <g className="fw-rings" style={fwc}>
            {[16, 30, 44].map((d) => (
              <circle key={d} cx={C} cy={C} r={R_HUB + d} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.45} />
            ))}
            <line x1={C} y1={C - R_HUB - 46} x2={C} y2={C - R_HUB - 12} stroke="var(--border)" strokeWidth={1} opacity={0.4} />
          </g>
          <circle className="fw-pulse" style={fwc} cx={C} cy={C} r={R_HUB + 6} fill="none" stroke="var(--cognac)" strokeWidth={1.5} />

          {/* everything that grows in on mount / project change */}
          <g className="fw-in" style={fwc} key={wheel.hub.domain}>
            {stages.map((st, si) => {
              const s0 = -90 + si * span;
              const s1 = -90 + (si + 1) * span;
              const smid = (s0 + s1) / 2;
              const c = RAMP[si % RAMP.length];
              const [slx, sly] = pt((R_HUB + R_STAGE) / 2, smid);
              const sflip = smid > 90 && smid < 270;
              const stageSel = si === sel.s && sel.t === null;

              const tCount = Math.max(st.themes.length, 1);
              const tSpan = (s1 - s0) / tCount;

              return (
                <g key={st.key} className="fw-stage">
                  {/* stage wedge */}
                  <path
                    d={seg(R_HUB + 4, R_STAGE, s0, s1)}
                    fill={c.fill}
                    stroke="#fbf9f3"
                    strokeWidth={2}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSel({ s: si, t: null })}
                  />
                  {stageSel && (
                    <path
                      key={`sd-${si}`}
                      className="fw-draw"
                      d={seg(R_HUB + 4, R_STAGE, s0, s1)}
                      fill="none"
                      stroke="var(--cognac)"
                      strokeWidth={2.5}
                      pathLength={100}
                      pointerEvents="none"
                    />
                  )}
                  <text
                    x={slx}
                    y={sly}
                    fill={c.on}
                    fontSize={11}
                    fontWeight={700}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    transform={`rotate(${sflip ? smid + 180 : smid}, ${slx}, ${sly})`}
                    style={{ letterSpacing: '0.04em', pointerEvents: 'none' }}
                  >
                    {clip(st.label.replace(' aware', '').toUpperCase(), 12)}
                  </text>

                  {/* theme wedges + radiating labels */}
                  {st.themes.map((th, ti) => {
                    const t0 = s0 + ti * tSpan;
                    const t1 = s0 + (ti + 1) * tSpan;
                    const tmid = (t0 + t1) / 2;
                    const themeSel = si === sel.s && sel.t === ti;
                    const isHover = hover === `${si}:${ti}`;
                    const [lx, ly] = pt(R_LABEL, tmid);
                    const flip = tmid > 90 && tmid < 270;
                    const k = themeSel ? 7 : isHover ? 4 : 0; // outward nudge
                    return (
                      <g
                        key={ti}
                        className="fw-theme"
                        onMouseEnter={() => setHover(`${si}:${ti}`)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => setSel({ s: si, t: ti })}
                        style={{ cursor: 'pointer', transform: `translate(${k * Math.cos(rad(tmid))}px, ${k * Math.sin(rad(tmid))}px)` }}
                      >
                        <path
                          d={seg(R_STAGE + 1, R_THEME, t0 + 0.6, t1 - 0.6)}
                          fill={c.fill}
                          fillOpacity={themeSel ? 1 : isHover ? 0.85 : 0.5}
                          stroke={themeSel || isHover ? 'var(--cognac)' : '#fbf9f3'}
                          strokeWidth={themeSel ? 2 : 1.5}
                        />
                        {themeSel && (
                          <path
                            key={`td-${si}-${ti}`}
                            className="fw-draw"
                            d={seg(R_STAGE + 1, R_THEME, t0 + 0.6, t1 - 0.6)}
                            fill="none"
                            stroke="var(--cognac)"
                            strokeWidth={2}
                            pathLength={100}
                            pointerEvents="none"
                          />
                        )}
                        <text
                          x={lx}
                          y={ly}
                          fill={themeSel ? 'var(--cognac)' : 'var(--text-dim)'}
                          fontSize={10}
                          fontWeight={themeSel ? 700 : 500}
                          textAnchor={flip ? 'end' : 'start'}
                          dominantBaseline="middle"
                          transform={`rotate(${flip ? tmid + 180 : tmid}, ${lx}, ${ly})`}
                          style={{ pointerEvents: 'none' }}
                        >
                          {clip(shortTheme(th.label), 20)}
                          <tspan dx={4} fill="var(--text-faint)" fontSize={8}>
                            {th.queries.length}
                          </tspan>
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>

          {/* hub */}
          <circle cx={C} cy={C} r={R_HUB} fill="#fbf9f3" stroke="var(--border-strong)" strokeWidth={1.5} />
          <text x={C} y={C - 5} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--text)">
            {clip(wheel.hub.label, 13)}
          </text>
          <text x={C} y={C + 12} textAnchor="middle" fontSize={8} fill="var(--text-faint)">
            {clip(wheel.hub.category, 22)}
          </text>
        </svg>

        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 text-[10px] text-faint">
          <Dot c={SRC_DOT.template} l="library" />
          <Dot c={SRC_DOT.journey} l="from a journey" />
          <Dot c={SRC_DOT.persona} l="from a persona" />
          <span>· {wheel.total} suggestions · click a wedge</span>
        </div>
      </div>

      {/* ── detail panel (full readable text) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* view switch: buyer queries  ·  AEO/GEO boosts */}
        <div className="mb-2.5 flex items-center gap-1 rounded-md border border-border bg-bg-inset p-0.5 text-[11px]">
          <button
            onClick={() => setView('queries')}
            className={`flex-1 rounded px-2 py-1 transition-colors ${view === 'queries' ? 'bg-bg-raised font-semibold text-text' : 'text-faint hover:text-dim'}`}
          >
            buyer queries
          </button>
          <button
            onClick={() => setView('boosts')}
            className={`flex-1 rounded px-2 py-1 transition-colors ${view === 'boosts' ? 'bg-bg-raised font-semibold text-text' : 'text-faint hover:text-dim'}`}
          >
            AEO / GEO boosts{boosts.length ? ` (${boosts.length})` : ''}
          </button>
        </div>

        {view === 'queries' ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <p className="text-[11px] uppercase tracking-widest text-faint">
                {stage?.label}
                {sel.t !== null && stage?.themes[sel.t] ? ` › ${shortTheme(stage.themes[sel.t].label)}` : ' › all themes'}
              </p>
              {sel.t !== null && (
                <button onClick={() => setSel({ s: sel.s, t: null })} className="text-[10px] text-faint hover:text-dim">
                  (show all)
                </button>
              )}
            </div>
            <ul key={`${sel.s}:${sel.t}`} className="space-y-2">
              {rows.map((q, i) => (
                <li
                  key={i}
                  className="fw-row rounded-md border border-border bg-bg-raised p-2.5 transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-accent-dim"
                  style={{ animationDelay: `${Math.min(i, 12) * 32}ms` }}
                >
                  <button onClick={() => onPick?.(q.text)} className="group flex w-full items-start gap-2 text-left" title="Send to Chat">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full transition-transform duration-200 group-hover:scale-150" style={{ background: SRC_DOT[q.source] }} />
                    <span className="text-[12px] font-semibold leading-snug text-text transition-colors group-hover:text-cognac">{q.text}</span>
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
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">
              what to ship for {clip(wheel.hub.label, 22)}
            </p>
            {boosts.length === 0 ? (
              <p className="text-[12px] text-faint">
                No boosts yet — run a technical audit, a link-graph crawl, or an authority scan and they populate here.
              </p>
            ) : (
              <ul className="space-y-2">
                {boosts.map((b, i) => (
                  <li
                    key={b.id}
                    className="fw-row rounded-md border border-border bg-bg-raised p-2.5 transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-accent-dim"
                    style={{ animationDelay: `${Math.min(i, 12) * 32}ms` }}
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-[3px] inline-flex shrink-0 items-center rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide" style={{ background: LANE_COLOR[b.lane], color: '#fbf9f3' }}>
                        {b.lane}
                      </span>
                      <span className="text-[12px] font-semibold leading-snug text-text">{b.title}</span>
                    </div>
                    <p className="mt-1 pl-1 text-[11px] leading-snug text-dim">
                      <span className="text-faint">why · </span>
                      {b.why}
                    </p>
                    <button
                      onClick={() => onPick?.(b.action)}
                      className="group mt-0.5 flex w-full items-start gap-1 pl-1 text-left text-[11px] leading-snug text-cognac"
                      title="Send to Chat"
                    >
                      <span className="text-faint">→ </span>
                      <span className="transition-colors group-hover:underline">{b.action}</span>
                    </button>
                    <p className="mt-1 pl-1 text-[10px] text-faint">
                      {b.evidence} · {b.effort === 'quick' ? 'quick win' : 'project'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Dot({ c, l }: { c: string; l: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {l}
    </span>
  );
}
