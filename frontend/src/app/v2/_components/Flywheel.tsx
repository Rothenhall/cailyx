'use client';

/**
 * Flywheel — /v2. The v1 sunburst (hub → awareness stage → theme ring, warm
 * ramp, ambient spin) rendered at native pixel scale so text stays crisp.
 * Labels follow the ring on a curved textPath and auto-flip so they're never
 * upside down. Welded to the LEFT edge (right half shows); drag or scroll to
 * spin, snaps to the nearest quarter on release.
 *
 * Tap the wheel to enter focus mode — the page behind blurs and the wheel grows.
 * Tap any theme wedge in focus mode for a centred pop-up with the buyer queries
 * that theme maps to, each with its pain point + the fix Cailyx would make.
 *
 * Live data: `GET /projects/:id/journeys/suggestions` (the same deterministic
 * wheel the v1 card reads). Sending a query hands it to the Cailyx Assistant.
 *
 * @module app/v2/_components/Flywheel
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { SuggestionBoost, SuggestionWheel } from '@/components/terminal/Flywheel';
import { Scrim } from './Scrim';
import { ArrowRight, ChevronLeft, CloseIcon } from './icons';

/* useLayoutEffect warns during SSR; the console is client-only in practice but
   the component body still renders on the server. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/* ── native-scale geometry (~2/3 of the v1 560px render) ─────────────── */
/** the wheel's full box; welded at left:0 with translate(-50%), so exactly
 *  half of it protrudes onto the canvas. The page derives its left gutter
 *  from this rather than hardcoding the number. */
export const FLYWHEEL_VB = 372;
const VB = FLYWHEEL_VB;
const C = VB / 2;
const R_HUB = 56;
const R_STAGE = 96;
const R_THEME = 136;
const STAGE_LABEL_R = (R_HUB + R_STAGE) / 2; // curved stage label radius
const THEME_LABEL_R = R_THEME + 13; // curved theme label radius
const MAX_THEMES = 5;

const rad = (d: number) => (d * Math.PI) / 180;
const norm = (d: number) => ((d % 360) + 360) % 360;
/* Round to 3dp before the number reaches a path string. Node and the browser
   round the last float digit differently (…4887597 vs …4887598), which React
   reports as a hydration mismatch on every wedge. */
const q = (n: number) => Math.round(n * 1000) / 1000;
const pt = (r: number, d: number) =>
  [q(C + r * Math.cos(rad(d))), q(C + r * Math.sin(rad(d)))] as const;

/* wedge (donut segment) */
function seg(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = pt(r0, a0);
  const [x1, y1] = pt(r1, a0);
  const [x2, y2] = pt(r1, a1);
  const [x3, y3] = pt(r0, a1);
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 ${big} 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 ${big} 0 ${x0},${y0} Z`;
}

/* arc for a textPath — reversed when the wedge sits in the lower half so the
   text always reads left-to-right, right way up */
function labelArc(r: number, a0: number, a1: number, rotDeg: number): string {
  const screenMid = norm((a0 + a1) / 2 + rotDeg);
  const lower = screenMid > 0 && screenMid < 180;
  const [sa, ea] = lower ? [a1, a0] : [a0, a1];
  const [x0, y0] = pt(r, sa);
  const [x1, y1] = pt(r, ea);
  const sweep = lower ? 0 : 1;
  return `M${x0},${y0} A${r},${r} 0 0 ${sweep} ${x1},${y1}`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* warm ramp per stage: cream → brass → cognac (v1) */
const RAMP = [
  { fill: '#f0e7d6', on: '#4a4436' },
  { fill: '#e4cba4', on: '#3f3a2c' },
  { fill: '#d19a68', on: '#2a1f15' },
  { fill: '#a85c30', on: '#fbf3ea' },
];

type Query = SuggestionWheel['stages'][number]['themes'][number]['queries'][number];
type Stage = { key: string; label: string; themes: Array<{ label: string; queries: Query[] }> };

/* where a query came from — the backend tags every one */
const SOURCE_LABEL: Record<string, string> = {
  template: 'planner template',
  persona: 'from a persona',
  journey: 'seen in a journey',
};

/* the ring we draw before the wheel arrives (or when a project has none) —
   same geometry, no labels, so the layout never jumps */
const GHOST: Stage[] = Array.from({ length: 4 }, (_, i) => ({
  key: `ghost-${i}`,
  label: '',
  themes: Array.from({ length: 3 }, () => ({ label: '', queries: [] })),
}));

export function Flywheel({
  wheel,
  loading,
  onPick,
}: {
  wheel: SuggestionWheel | null;
  loading: boolean;
  /** hand a buyer query to the Cailyx Assistant */
  onPick: (query: string) => void;
}) {
  const [sel, setSel] = useState<{ s: number; t: number | null }>({ s: 0, t: null });
  const [hover, setHover] = useState<string | null>(null);
  const [rot, setRot] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const [touched, setTouched] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hubHover, setHubHover] = useState(false);
  const [detail, setDetail] = useState<{ s: number; t: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ a: number; r: number; x: number; y: number; moved: boolean } | null>(null);
  const snapTimer = useRef<number | null>(null);

  const ghost = !wheel || wheel.stages.length === 0;
  const stages: Stage[] = useMemo(() => {
    if (!wheel || wheel.stages.length === 0) return GHOST;
    return wheel.stages.map((s) => ({
      key: s.key,
      label: s.label,
      themes: s.themes.slice(0, MAX_THEMES),
    }));
  }, [wheel]);

  const hubLabel = wheel?.hub.label ?? '—';
  const boosts: SuggestionBoost[] = wheel?.boosts ?? [];

  /* a project switch can leave the selection pointing past the new wheel */
  useEffect(() => {
    setSel({ s: 0, t: null });
    setDetail(null);
  }, [wheel]);

  const centre = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  };
  const angleOf = (e: { clientX: number; clientY: number }) => {
    const c = centre();
    return (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI;
  };
  const snap = () => {
    setSnapping(true);
    setRot((r) => Math.round(r / 90) * 90);
  };
  const clearSnap = () => {
    setSnapping(false);
    if (snapTimer.current) window.clearTimeout(snapTimer.current);
  };
  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    clearSnap();
    drag.current = { a: angleOf(e), r: rot, x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      d.moved = true;
      setTouched(true);
    }
    if (d.moved) setRot(d.r + (angleOf(e) - d.a));
  };
  const onUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) snap();
    else if (!focused && !ghost) setFocused(true); // tap anywhere on the wheel → expand
  };
  const onWheel = (e: React.WheelEvent) => {
    clearSnap();
    setTouched(true);
    setRot((r) => r + (e.deltaY || e.deltaX) * 0.25);
    snapTimer.current = window.setTimeout(snap, 170);
  };

  const exit = () => {
    setDetail(null);
    setFocused(false);
  };

  useEffect(() => {
    if (!focused && !detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (detail) setDetail(null);
      else setFocused(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, detail]);

  const span = 360 / stages.length;
  const fwc = { ['--fw-c' as string]: `${C}px` } as CSSProperties;

  const dStage = detail ? stages[detail.s] ?? null : null;
  const dTheme = detail && dStage ? dStage.themes[detail.t] ?? null : null;
  const dColor = detail ? RAMP[detail.s % RAMP.length] : RAMP[0];

  const send = (q: string) => {
    onPick(q);
    exit();
  };

  /* ── shared-element origin ───────────────────────────────────────────
     The popup grows out of the wedge that was tapped rather than out of the
     middle of the screen. We record the pointer position on the wedge, then
     express it as a percentage of the card's own box once it has laid out. */
  const popRef = useRef<HTMLDivElement>(null);
  const tapPoint = useRef<{ x: number; y: number } | null>(null);

  useIsoLayoutEffect(() => {
    const el = popRef.current;
    const p = tapPoint.current;
    if (!el || !p) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const clamp = (v: number) => Math.max(-40, Math.min(140, v));
    el.style.setProperty('--pop-x', `${clamp(((p.x - r.left) / r.width) * 100)}%`);
    el.style.setProperty('--pop-y', `${clamp(((p.y - r.top) / r.height) * 100)}%`);
  }, [detail]);

  const hint = ghost
    ? loading
      ? 'reading buyer queries…'
      : 'no buyer queries yet · add personas or plan a journey'
    : focused
      ? 'tap any wedge for its buyer queries · esc to close'
      : 'tap to open · drag or scroll to spin';

  return (
    <>
      {/* the shared scrim — fixed, so the top bar recedes with the canvas */}
      <Scrim open={focused} onClose={exit} z={30} />

      {/* v2fw-zoom carries the transition in CSS rather than inline, so the
          prefers-reduced-motion guard in v2.css can actually reach it */}
      <div
        ref={wrapRef}
        className="v2fw-zoom pointer-events-none absolute left-0 top-1/2 select-none"
        style={{
          width: VB,
          height: VB,
          transform: focused ? 'translate(-36%, -50%) scale(1.22)' : 'translate(-50%, -50%) scale(1)',
          transformOrigin: 'center',
          zIndex: focused ? 40 : 0,
        }}
      >
        <svg
          viewBox={`0 0 ${VB} ${VB}`}
          className="pointer-events-auto block h-full w-full cursor-grab touch-none active:cursor-grabbing"
          style={{ userSelect: 'none', textRendering: 'geometricPrecision' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
        >
          <defs>
            {stages.map((st, si) => {
              const s0 = -90 + si * span;
              const s1 = s0 + span;
              return <path key={`sp-${si}`} id={`fw-sp-${si}`} d={labelArc(STAGE_LABEL_R, s0 + 4, s1 - 4, rot)} />;
            })}
            {stages.flatMap((st, si) => {
              const s0 = -90 + si * span;
              const tSpan = span / Math.max(st.themes.length, 1);
              return st.themes.map((_, ti) => {
                const t0 = s0 + ti * tSpan;
                return <path key={`tp-${si}-${ti}`} id={`fw-tp-${si}-${ti}`} d={labelArc(THEME_LABEL_R, t0 + 1.5, t0 + tSpan - 1.5, rot)} />;
              });
            })}
          </defs>

          <g
            transform={`rotate(${rot} ${C} ${C})`}
            style={{ transition: snapping ? 'transform 380ms cubic-bezier(0.22,1,0.36,1)' : 'none' }}
          >
            {/* ambient rings + pulse (v1) */}
            <g className="fw-rings" style={fwc}>
              {[12, 24, 36].map((d) => (
                <circle key={d} cx={C} cy={C} r={R_HUB + d} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.4} />
              ))}
            </g>
            <circle className="fw-pulse" style={fwc} cx={C} cy={C} r={R_HUB + 5} fill="none" stroke="var(--cognac)" strokeWidth={1.25} />

            <g className="fw-in" style={fwc} opacity={ghost ? 0.4 : 1}>
             {/* one-shot settle on entering focus — this used to loop forever,
                 which reads as jitter rather than life */}
             <g key={focused ? 'focused' : 'rest'} className={focused ? 'v2fw-settle' : undefined}>
              {stages.map((st, si) => {
                const s0 = -90 + si * span;
                const s1 = s0 + span;
                const c = ghost ? { fill: 'var(--bg-inset)', on: 'var(--text-faint)' } : RAMP[si % RAMP.length];
                // selection chrome only reads while the wheel is expanded
                const stageSel = focused && si === sel.s && sel.t === null;
                const tCount = Math.max(st.themes.length, 1);
                const tSpan = span / tCount;
                // widen the gutters once expanded — both rings ease apart a
                // touch, structure intact, just breathing room
                const tp = focused ? 2.4 : 0.6;
                const tR0 = R_STAGE + (focused ? 3 : 1);
                const sp = focused ? 1.6 : 0;
                const sR0 = R_HUB + 3 + (focused ? 2 : 0);

                return (
                  <g key={st.key} className="fw-stage">
                    {/* stage wedge */}
                    <path
                      d={seg(sR0, R_STAGE, s0 + sp, s1 - sp)}
                      fill={c.fill}
                      stroke="#fbf9f3"
                      strokeWidth={2}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (ghost) return;
                        setSel({ s: si, t: null });
                        if (focused) setDetail(null);
                      }}
                    />
                    {stageSel && (
                      <path className="fw-draw" d={seg(sR0, R_STAGE, s0 + sp, s1 - sp)} fill="none" stroke="var(--cognac)" strokeWidth={2.5} pathLength={100} pointerEvents="none" />
                    )}
                    {/* curved stage label */}
                    <text fill={c.on} fontSize={9} fontWeight={800} letterSpacing="0.08em" style={{ pointerEvents: 'none' }}>
                      <textPath href={`#fw-sp-${si}`} startOffset="50%" textAnchor="middle">
                        {st.label.replace(' aware', '').toUpperCase()}
                      </textPath>
                    </text>

                    {/* theme wedges */}
                    {st.themes.map((th, ti) => {
                      const t0 = s0 + ti * tSpan;
                      const t1 = t0 + tSpan;
                      const themeSel = focused && si === sel.s && sel.t === ti;
                      const isHover = focused && hover === `${si}:${ti}`;
                      const tmid = (t0 + t1) / 2;
                      const k = themeSel ? 6 : isHover ? 3 : 0;
                      return (
                        <g
                          key={ti}
                          className="fw-theme"
                          onMouseEnter={() => setHover(`${si}:${ti}`)}
                          onMouseLeave={() => setHover(null)}
                          onClick={(e) => {
                            if (ghost) return;
                            setSel({ s: si, t: ti });
                            if (!focused) return;
                            tapPoint.current = { x: e.clientX, y: e.clientY };
                            setDetail({ s: si, t: ti });
                          }}
                          style={{ cursor: 'pointer', transform: `translate(${k * Math.cos(rad(tmid))}px, ${k * Math.sin(rad(tmid))}px)` }}
                        >
                          <path
                            d={seg(tR0, R_THEME, t0 + tp, t1 - tp)}
                            fill={c.fill}
                            fillOpacity={themeSel ? 1 : isHover ? 0.85 : 0.5}
                            stroke={themeSel || isHover ? 'var(--cognac)' : '#fbf9f3'}
                            strokeWidth={themeSel ? 2 : 1.5}
                          />
                          {themeSel && (
                            <path className="fw-draw" d={seg(tR0, R_THEME, t0 + tp, t1 - tp)} fill="none" stroke="var(--cognac)" strokeWidth={2} pathLength={100} pointerEvents="none" />
                          )}
                          {/* curved theme label — squeezed to fit its wedge arc */}
                          <text
                            fill={themeSel ? 'var(--cognac)' : 'var(--text-dim)'}
                            fontSize={8.5}
                            fontWeight={themeSel ? 800 : 700}
                            style={{ pointerEvents: 'none' }}
                          >
                            <textPath href={`#fw-tp-${si}-${ti}`} startOffset="50%" textAnchor="middle">
                              {clip(th.label, 20)}
                              {th.queries.length > 0 && (
                                <tspan dx={4} fill="var(--text-faint)" fontSize={7}>
                                  {th.queries.length}
                                </tspan>
                              )}
                            </textPath>
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
             </g>
            </g>
          </g>

          {/* ── fixed overlay (never rotates) ─────────────────────────── */}
          {/* focus ring — a soft dashed halo that says "the wheel is live" */}
          {focused && (
            <circle cx={C} cy={C} r={R_THEME + 7} fill="none" stroke="var(--cognac)" strokeWidth={1.25} strokeDasharray="2 7" strokeLinecap="round" opacity={0.55} />
          )}

          {/* quarter tick marks — the snap targets */}
          {[-90, 0, 90, 180].map((a) => {
            const [x0, y0] = pt(R_THEME + 12, a);
            const [x1, y1] = pt(R_THEME + 22, a);
            return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--border-strong)" strokeWidth={2} strokeLinecap="round" />;
          })}

          {/* hub — tap to enter / leave focus mode */}
          <circle
            cx={C}
            cy={C}
            r={R_HUB}
            fill="#fbf9f3"
            stroke={hubHover || focused ? 'var(--cognac)' : 'var(--border-strong)'}
            strokeWidth={hubHover || focused ? 2.25 : 1.5}
            style={{ cursor: ghost ? 'default' : 'pointer', transition: 'stroke 160ms ease, stroke-width 160ms ease' }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerEnter={() => setHubHover(!ghost)}
            onPointerLeave={() => setHubHover(false)}
            onClick={() => {
              if (ghost) return;
              setDetail(null);
              setFocused((f) => !f);
            }}
          />

          {/* project name — vertical, sitting in the visible right half */}
          <text
            x={C + 24}
            y={C}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={13}
            fontWeight={800}
            letterSpacing="0.02em"
            fill="var(--text)"
            transform={`rotate(-90 ${C + 24} ${C})`}
            style={{ pointerEvents: 'none' }}
          >
            {clip(hubLabel, 16)}
          </text>

          {/* hint — swaps copy with the wheel's state */}
          <text
            x={C + 8}
            y={VB - 12}
            fontSize={8}
            fontWeight={600}
            letterSpacing="0.04em"
            fill="var(--text-faint)"
            style={{
              pointerEvents: 'none',
              opacity: ghost ? 1 : focused ? 0.9 : touched ? 0 : 1,
              transition: 'opacity 300ms ease',
            }}
          >
            {hint}
          </text>
        </svg>
      </div>

      {/* ── side panel — parked clear of the wheel, click-through so you can
             jump straight from one wedge to the next.

             Two states on one surface: with no wedge selected it shows the
             boosts (the supply side — what to ship), and tapping a wedge swaps
             it to that theme's buyer queries (the demand side). Focus mode is
             therefore useful the moment it opens, instead of blank until you
             happen to tap something. ────────────────────────────────────── */}
      {focused && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4 pl-[max(340px,38%)]">
          <div
            ref={popRef}
            key={detail ? `${detail.s}-${detail.t}` : 'boosts'}
            className="v2-pop pointer-events-auto flex max-h-[84vh] w-[min(420px,92vw)] flex-col overflow-hidden rounded-r5 border border-border bg-bg-raised shadow-e3"
          >
            {detail && dTheme && dStage ? (
             <>
            {/* header — washed in the stage's ramp colour */}
            <div
              className="relative px-5 pb-4 pt-5"
              style={{
                background: `linear-gradient(180deg, color-mix(in srgb, ${dColor.fill} 60%, var(--bg-raised)), var(--bg-raised))`,
              }}
            >
              {/* returns to the boosts list rather than closing focus mode */}
              <button
                type="button"
                onClick={() => setDetail(null)}
                aria-label="Back to boosts"
                title="Back to what to ship"
                className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-r2 text-faint transition-colors duration-micro hover:bg-bg-inset hover:text-text"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>

              <div className="flex items-center gap-2">
                <span
                  className="inline-flex h-[18px] items-center rounded-full px-2 text-eyebrow font-semibold uppercase tracking-eyebrow"
                  style={{ background: dColor.fill, color: dColor.on }}
                >
                  {dStage.label.replace(' aware', '')}
                </span>
                <span className="text-caption font-medium text-faint">
                  stage {detail.s + 1} / {stages.length}
                </span>
              </div>

              <h3 className="mt-2 pr-8 text-display font-semibold leading-tight text-text">{dTheme.label}</h3>
              <p className="mt-1 text-body text-dim">
                {dTheme.queries.length} buyer {dTheme.queries.length === 1 ? 'query maps' : 'queries map'} to this theme
              </p>
            </div>

            {/* queries — each with its pain point + the fix Cailyx would make */}
            <div className="no-scrollbar flex-1 space-y-2.5 overflow-y-auto bg-bg-inset px-4 py-4">
              {dTheme.queries.length === 0 && (
                <p className="py-6 text-center text-body text-faint">
                  No queries mapped to this theme yet.
                </p>
              )}
              {dTheme.queries.map((q, i) => (
                <div key={i} className="group rounded-r3 border border-border bg-bg-raised p-3.5 transition-colors hover:border-border-strong">
                  <div className="flex gap-2.5">
                    <span
                      className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full text-caption font-semibold text-accent"
                      style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}
                    >
                      {i + 1}
                    </span>
                    <p className="flex-1 text-ui font-semibold leading-snug text-text">{q.text}</p>
                    <button
                      type="button"
                      onClick={() => send(q.text)}
                      title="Ask the assistant about this query"
                      className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full text-faint opacity-0 transition-all hover:bg-accent hover:text-bg-raised group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  {/* labels sit above their text, not beside it — a pill plus
                      a 30px indent left roughly a 14ch column at this width */}
                  <div className="mt-2.5 space-y-2 pl-[30px]">
                    <div>
                      <span className="inline-flex h-4 items-center rounded-r1 bg-bg-inset px-1.5 text-eyebrow uppercase text-faint">
                        Pain
                      </span>
                      <p className="mt-1 text-body leading-relaxed text-dim">{q.painPoint}</p>
                    </div>
                    <div className="rounded-r2 p-2.5" style={{ background: 'var(--brass-soft-a18)' }}>
                      <span className="inline-flex h-4 items-center rounded-r1 bg-accent px-1.5 text-eyebrow uppercase text-bg-raised">
                        Fix
                      </span>
                      <p className="mt-1 text-body font-medium leading-relaxed text-text">{q.suggestion}</p>
                    </div>
                    {SOURCE_LABEL[q.source] && (
                      <p className="text-eyebrow uppercase text-faint">{SOURCE_LABEL[q.source]}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* footer */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-raised px-4 py-3">
              <span className="min-w-0 truncate text-caption text-faint">
                {wheel ? `${wheel.total} queries` : ''}
              </span>
              <button
                type="button"
                disabled={dTheme.queries.length === 0}
                onClick={() => dTheme.queries[0] && send(dTheme.queries[0].text)}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-r2 bg-accent px-3 py-1.5 text-body font-semibold text-bg-raised transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Send to assistant
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
             </>
            ) : (
              <BoostsPanel
                boosts={boosts}
                hubLabel={hubLabel}
                onSend={send}
                onClose={exit}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ── boosts — the supply side of the wheel ───────────────────────────────
   The suggestions endpoint returns ranked interventions alongside the buyer
   queries: what to ship, why, the action, what evidence produced it, and
   whether it's a quick win or a project. Lanes are labelled rather than
   colour-coded loudly — the brand is entirely warm, so six saturated pills
   would read as confetti. Each lane gets a quiet tint and the short label
   (AEO / GEO / …) carries the meaning. */
const LANE: Record<string, string> = {
  AEO: 'var(--accent)',
  GEO: 'var(--cognac)',
  Content: 'var(--brass-mid)',
  Technical: 'var(--st-danger)',
  Authority: 'var(--accent-dim)',
  Measurement: 'var(--ink-80)',
};

function BoostsPanel({
  boosts,
  hubLabel,
  onSend,
  onClose,
}: {
  boosts: SuggestionBoost[];
  hubLabel: string;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const quick = boosts.filter((b) => b.effort === 'quick').length;

  return (
    <>
      <div
        className="relative px-5 pb-4 pt-5"
        style={{ background: 'linear-gradient(180deg, var(--brass-a08), var(--bg-raised))' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-r2 text-faint transition-colors duration-micro hover:bg-bg-inset hover:text-text"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>

        <span className="inline-flex h-[18px] items-center rounded-full bg-accent px-2 text-eyebrow uppercase text-bg-raised">
          What to ship
        </span>
        <h3 className="mt-2 pr-8 text-display font-semibold leading-tight text-text">
          {clip(hubLabel, 24)} boosts
        </h3>
        <p className="mt-1 text-body text-dim">
          {boosts.length === 0
            ? 'Nothing ranked yet'
            : `${boosts.length} ranked · ${quick} quick win${quick === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="no-scrollbar flex-1 space-y-2.5 overflow-y-auto bg-bg-inset px-4 py-4">
        {boosts.length === 0 ? (
          <p className="py-6 text-center text-body leading-relaxed text-faint">
            No boosts yet. Run a technical audit, a link-graph crawl, or an authority scan and
            they populate here.
          </p>
        ) : (
          boosts.map((b, i) => (
            <div
              key={b.id}
              className="group rounded-r3 border border-border bg-bg-raised p-3.5 transition-colors duration-micro hover:border-border-strong"
            >
              <div className="flex items-center gap-2">
                <span className="v2-rank">{String(i + 1).padStart(2, '0')}</span>
                <span
                  className="inline-flex h-[17px] shrink-0 items-center rounded-r1 px-1.5 text-eyebrow uppercase"
                  style={{
                    background: `color-mix(in srgb, ${LANE[b.lane] ?? 'var(--accent)'} 14%, transparent)`,
                    color: LANE[b.lane] ?? 'var(--accent)',
                  }}
                >
                  {b.lane}
                </span>
                <span
                  className={`ml-auto shrink-0 text-eyebrow uppercase ${
                    b.effort === 'quick' ? 'text-ok' : 'text-faint'
                  }`}
                >
                  {b.effort === 'quick' ? 'quick win' : 'project'}
                </span>
              </div>

              <p className="mt-2 text-ui font-semibold leading-snug text-text">{b.title}</p>
              <p className="mt-1.5 text-body leading-relaxed text-dim">
                <span className="text-faint">why · </span>
                {b.why}
              </p>

              {/* the action can run long, so the label sits above it rather
                  than beside it — a pill plus an arrow left a ~14ch column */}
              <button
                type="button"
                onClick={() => onSend(b.action)}
                title="Ask the assistant about this"
                className="mt-2 w-full rounded-r2 p-2.5 text-left transition-colors duration-micro hover:brightness-[0.97]"
                style={{ background: 'var(--brass-soft-a18)' }}
              >
                <span className="mb-1 flex items-center gap-1.5">
                  <span className="inline-flex h-4 items-center rounded-r1 bg-accent px-1.5 text-eyebrow uppercase text-bg-raised">
                    Do
                  </span>
                  <ArrowRight className="h-3 w-3 text-accent opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                <span className="block text-body font-medium leading-relaxed text-text">{b.action}</span>
              </button>

              <p className="mt-1.5 text-eyebrow uppercase text-faint">from {b.evidence}</p>
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-raised px-4 py-3">
        <span className="text-caption text-faint">tap a wedge for buyer queries</span>
      </div>
    </>
  );
}
