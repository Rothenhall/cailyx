'use client';

/**
 * Flywheel — an answerthepublic-style radial of buyer search-query suggestions
 * for the project, grouped by awareness stage. Hub = the brand; four wedges
 * (problem → solution → product → most aware) in a warm cream → cognac ramp;
 * each wedge fans out its suggested queries as labelled spokes.
 *
 * Data: GET /api/projects/:id/journeys/suggestions (deterministic, no LLM).
 * Click a query to drop it into the Chat card.
 *
 * @module components/terminal/Flywheel
 */

import { useState } from 'react';

export const flywheelMeta = { key: 'flywheel' as const, title: 'Flywheel', icon: '❋' };

export interface SuggestionWheel {
  hub: { label: string; domain: string; category: string };
  spokes: Array<{
    key: string;
    label: string;
    queries: Array<{ text: string; source: 'template' | 'persona' | 'journey' }>;
  }>;
  total: number;
}

/** warm ramp: canvas → brass → cognac (BRANDING) */
const WEDGE = [
  { fill: '#efe9dc', line: '#d8cdb4', text: '#5c5648' },
  { fill: '#e2c9a1', line: '#c9ab77', text: '#4a4436' },
  { fill: '#cf9560', line: '#b87c46', text: '#3a2b1c' },
  { fill: '#a85c30', line: '#8a4a26', text: '#fbf3ea' },
];

const CX = 400;
const CY = 400;
const R_HUB = 66;
const R_WEDGE = 150;
const R_SPOKE_IN = 156;
const R_SPOKE_OUT = 196;
const R_LABEL = 206;

const rad = (deg: number) => (deg * Math.PI) / 180;
const pt = (r: number, deg: number) => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))] as const;

function wedgePath(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = pt(r0, a0);
  const [x1, y1] = pt(r1, a0);
  const [x2, y2] = pt(r1, a1);
  const [x3, y3] = pt(r0, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 ${large} 0 ${x0},${y0} Z`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function Flywheel({
  wheel,
  loading,
  onPick,
}: {
  wheel: SuggestionWheel | null;
  loading: boolean;
  onPick?: (q: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  if (loading && !wheel) return <p className="p-4 text-faint">building suggestions…</p>;
  if (!wheel) return <p className="p-4 text-faint">select a project</p>;
  if (wheel.total === 0)
    return (
      <p className="p-4 text-[12px] text-faint">
        No suggestions yet. Add a category + personas, or plan a journey — the Flywheel builds from those.
      </p>
    );

  const n = wheel.spokes.length || 1;
  const span = 360 / n;

  return (
    <div className="h-full w-full overflow-auto p-2">
      <svg viewBox="0 0 800 800" className="mx-auto block h-auto w-full max-w-[560px]" style={{ userSelect: 'none' }}>
        {/* faint concentric rings behind the hub */}
        {[24, 40, 56].map((r) => (
          <circle key={r} cx={CX} cy={CY} r={R_HUB + r} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.5} />
        ))}

        {wheel.spokes.map((sp, i) => {
          const a0 = -90 + i * span + 2;
          const a1 = -90 + (i + 1) * span - 2;
          const mid = (a0 + a1) / 2;
          const c = WEDGE[i % WEDGE.length];
          const [lx, ly] = pt((R_HUB + R_WEDGE) / 2, mid);
          const flipLabel = mid > 90 && mid < 270;

          return (
            <g key={sp.key}>
              {/* stage wedge */}
              <path d={wedgePath(R_HUB + 4, R_WEDGE, a0, a1)} fill={c.fill} stroke="#fbf9f3" strokeWidth={2} />
              <text
                x={lx}
                y={ly}
                fill={c.text}
                fontSize={13}
                fontWeight={600}
                textAnchor="middle"
                dominantBaseline="middle"
                transform={`rotate(${flipLabel ? mid + 180 : mid}, ${lx}, ${ly})`}
                style={{ letterSpacing: '0.06em' }}
              >
                {sp.label.toUpperCase()}
              </text>

              {/* query spokes */}
              {sp.queries.map((q, j) => {
                const t = sp.queries.length > 1 ? j / (sp.queries.length - 1) : 0.5;
                const qa = a0 + 6 + t * (a1 - a0 - 12);
                const [sx, sy] = pt(R_SPOKE_IN, qa);
                const [ex, ey] = pt(R_SPOKE_OUT, qa);
                const [tx, ty] = pt(R_LABEL, qa);
                const flip = qa > 90 && qa < 270;
                const active = hover === `${i}:${j}`;
                return (
                  <g
                    key={j}
                    onMouseEnter={() => setHover(`${i}:${j}`)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onPick?.(q.text)}
                    style={{ cursor: onPick ? 'pointer' : 'default' }}
                  >
                    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={active ? 'var(--cognac)' : c.line} strokeWidth={active ? 2 : 1} />
                    <circle cx={ex} cy={ey} r={active ? 3 : 2} fill={active ? 'var(--cognac)' : c.line} />
                    <text
                      x={tx}
                      y={ty}
                      fill={active ? 'var(--cognac)' : 'var(--text-dim)'}
                      fontSize={11}
                      fontWeight={active ? 600 : 400}
                      textAnchor={flip ? 'end' : 'start'}
                      dominantBaseline="middle"
                      transform={`rotate(${flip ? qa + 180 : qa}, ${tx}, ${ty})`}
                    >
                      {truncate(q.text, 34)}
                      {q.source === 'journey' && <tspan fill="var(--accent)"> ●</tspan>}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* hub */}
        <circle cx={CX} cy={CY} r={R_HUB} fill="#fbf9f3" stroke="var(--border-strong)" strokeWidth={1.5} />
        <text x={CX} y={CY - 6} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--text)">
          {truncate(wheel.hub.label, 14)}
        </text>
        <text x={CX} y={CY + 12} textAnchor="middle" fontSize={9} fill="var(--text-faint)">
          {truncate(wheel.hub.category, 22)}
        </text>
      </svg>

      <div className="mt-1 flex items-center justify-between px-2 text-[10px] text-faint">
        <span>{wheel.total} suggestions · click a spoke to send it to Chat</span>
        <span><span className="text-accent">●</span> from a real journey</span>
      </div>
    </div>
  );
}
