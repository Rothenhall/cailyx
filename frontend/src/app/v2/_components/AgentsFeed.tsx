'use client';

/**
 * AgentsFeed — /v2. The right-hand region: a chrome-less panel whose grid view
 * stacks the glyph grid of the agent roster over the Cailyx Assistant. Tapping
 * a tile slides the whole grid panel (chat included) away to that agent's
 * detail; coming back brings the grid + chat back together.
 *
 * Live data: `GET /projects/:id/agents`, polled by the console. The chat is
 * injected by the page so this component stays a pure layout shell for it.
 *
 * @module app/v2/_components/AgentsFeed
 */

import { useEffect, useState } from 'react';
import type { AgentCard, AgentsResponse, AgentStatus } from '@/types/terminal';
import { AgentIcon, ChevronLeft, GridIcon, SyncIcon } from './icons';

/* Status is carried by colour AND form, because the brand palette is entirely
   warm — three of these used to be the same orange at 7px. See v2.css.
     ready     solid brass          attention  cognac-soft + ring
     running   brass + pulsing halo blocked    cognac-deep + notch
     idle      hollow */
const DOT: Record<AgentStatus, string> = {
  ready: 'v2-dot-ready',
  attention: 'v2-dot-attention',
  running: 'v2-dot-running',
  blocked: 'v2-dot-blocked',
  idle: 'v2-dot-idle',
};

/** tiles are ~50px wide — "SEO Agent" never fit, and the word adds nothing */
const shortName = (name: string) => name.replace(/\s*agents?$/i, '');

/** compact relative time — "2m", "4h", "3d" */
function rel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function AgentsFeed({
  data,
  loading,
  onRefresh,
  onAsk,
  chat,
}: {
  data: AgentsResponse | null;
  loading: boolean;
  onRefresh: () => void;
  /** hand an agent to the Cailyx Assistant */
  onAsk: (agentKey: string) => void;
  /** the Cailyx Assistant, slotted under the grid so it slides with it */
  chat: React.ReactNode;
}) {
  const [selKey, setSelKey] = useState<string | null>(null);
  const agents = data?.agents ?? [];
  const sel: AgentCard | null = agents.find((a) => a.key === selKey) ?? null;
  const view: 'grid' | 'detail' = sel ? 'detail' : 'grid';

  /* a project switch can leave us staring at an agent that is no longer there */
  useEffect(() => {
    if (selKey && data && !data.agents.some((a) => a.key === selKey)) setSelKey(null);
  }, [data, selKey]);

  const s = data?.summary;
  const booting = loading && !data;

  return (
    <div className="flex h-full w-full flex-col">
      {/* title bar */}
      <div className="flex items-center gap-2 pb-3">
        {view === 'detail' ? (
          <button
            type="button"
            onClick={() => setSelKey(null)}
            aria-label="Back to agents"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bg-inset text-dim transition-colors duration-micro hover:text-accent"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-bg-raised">
            <GridIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-body font-semibold text-text">
          {sel && <AgentIcon agentKey={sel.key} className="h-3.5 w-3.5 shrink-0 text-accent" />}
          <span className="truncate">{sel ? sel.name : 'Agents Feed'}</span>
        </span>
        {sel ? (
          <span className="ml-auto flex items-center gap-1.5 text-caption capitalize text-faint">
            <span className={`v2-dot ${DOT[sel.status]}`} />
            {sel.status}
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-2 text-caption text-faint">
            {s && (
              <>
                <span><span className="num font-display font-medium text-ok">{s.ready}</span> ready</span>
                <span><span className="num font-display font-medium text-warn">{s.needAttention}</span> attn</span>
                <span><span className="num font-display font-medium text-idle">{s.idle}</span> idle</span>
              </>
            )}
            <button
              type="button"
              onClick={onRefresh}
              title="Refresh agents"
              aria-label="Refresh agents"
              className={`grid h-5 w-5 place-items-center rounded transition-colors hover:bg-bg-inset hover:text-accent ${
                loading ? 'animate-spin text-accent' : ''
              }`}
            >
              <SyncIcon className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>

      {/* body — fills the region; slides between grid and detail */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="flex h-full w-[200%] transition-transform duration-panel ease-brand"
          style={{ transform: view === 'detail' ? 'translateX(-50%)' : 'translateX(0)' }}
        >
          {/* GRID + the Cailyx Assistant, stacked — slides away/back as one */}
          <div className="flex h-full w-1/2 shrink-0 flex-col gap-3 overflow-hidden pr-px">
            {/* v2-stagger: the roster assembles at 30ms/tile instead of
                appearing in one frame. Keyed on the project so a switch
                replays it. */}
            <div
              key={data?.projectId ?? 'boot'}
              className="v2-stagger grid shrink-0 gap-1.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(46px, 58px))' }}
            >
              {booting
                ? Array.from({ length: 10 }, (_, i) => (
                    <div key={i} className="v2skel aspect-square rounded-r2" />
                  ))
                : agents.map((a, i) => (
                    <button
                      key={a.key}
                      type="button"
                      onClick={() => setSelKey(a.key)}
                      title={`${a.name} — ${a.headline}`}
                      style={{ ['--i' as string]: i }}
                      className={`relative flex aspect-square flex-col items-center justify-center gap-0.5 rounded-r2 border bg-bg-raised px-0.5 transition-colors duration-micro hover:border-accent-dim hover:text-accent ${
                        a.status === 'idle'
                          ? 'border-border text-faint'
                          : 'border-border-strong text-accent'
                      }`}
                    >
                      <AgentIcon agentKey={a.key} className="h-[18px] w-[18px]" />
                      <span className="w-full truncate text-center text-eyebrow font-medium normal-case leading-none tracking-normal text-faint">
                        {shortName(a.name)}
                      </span>
                      {/* Idle is the resting state of most of the roster, so it
                          carries no marker — a dot on all ten tiles tells you
                          nothing. Only states that want a decision are marked.
                          The wrapper does the positioning because .v2-dot owns
                          `position: relative` for its halo pseudo-element. */}
                      {a.status !== 'idle' && (
                        <span className="absolute right-1 top-1">
                          <span className={`v2-dot ${DOT[a.status]}`} />
                        </span>
                      )}
                    </button>
                  ))}
            </div>

            {!booting && agents.length === 0 && (
              <p className="text-body text-faint">No agents for this project yet.</p>
            )}

            {/* Cailyx Assistant — fills the space beneath the grid */}
            <div className="min-h-0 flex-1 border-t border-border pt-2">{chat}</div>
          </div>

          {/* DETAIL */}
          <div className="no-scrollbar h-full w-1/2 shrink-0 overflow-y-auto pl-px">
            {sel && (
              <div className="flex max-w-[440px] flex-col gap-3.5">
                <p className="text-body leading-relaxed text-dim">{sel.headline}</p>

                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: sel.category, value: String(sel.count) },
                    { label: 'Last run', value: rel(sel.lastActivityAt) },
                    { label: 'State', value: sel.status },
                  ].map((t) => (
                    <div key={t.label} className="rounded-r3 border border-border bg-bg-raised px-2 py-2.5 text-center">
                      <div className="num truncate font-display text-title font-medium capitalize text-text">
                        {t.value}
                      </div>
                      <div className="mt-1 truncate text-eyebrow uppercase text-faint">{t.label}</div>
                    </div>
                  ))}
                </div>

                {sel.metric && (
                  <div
                    className="num rounded-r3 px-2.5 py-2 text-body leading-relaxed text-dim"
                    style={{ background: 'var(--brass-soft-a18)' }}
                  >
                    {sel.metric}
                  </div>
                )}

                <div>
                  <p className="mb-1.5 text-eyebrow uppercase text-faint">Activity</p>
                  {sel.activity.length === 0 ? (
                    <p className="text-body text-faint">Nothing recorded yet.</p>
                  ) : (
                    <ul key={sel.key} className="v2-stagger space-y-1.5">
                      {sel.activity.map((line, i) => (
                        <li
                          key={i}
                          style={{ ['--i' as string]: i }}
                          className="flex gap-1.5 text-body text-dim"
                        >
                          <span className="text-accent-dim">└</span>
                          <span className="flex-1">{line}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onAsk(sel.key);
                      setSelKey(null);
                    }}
                    className="flex-1 rounded-r2 bg-accent px-3 py-2.5 text-body font-medium text-bg-raised transition-opacity hover:opacity-90"
                  >
                    Ask the assistant →
                  </button>
                  <span className="shrink-0 rounded-r2 border border-border px-2.5 py-2 text-caption text-faint">
                    next: {sel.cta}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
