'use client';

/**
 * AgentsFeed — /v3. The right-hand region: a chrome-less panel whose grid view
 * stacks the glyph grid of the agent roster over the Cailyx Assistant. Tapping
 * a tile slides the whole grid panel (chat included) away to that agent's
 * detail; coming back brings the grid + chat back together.
 *
 * Live data: `GET /projects/:id/agents`, polled by the console. The chat is
 * injected by the page so this component stays a pure layout shell for it.
 *
 * @module app/v3/_components/AgentsFeed
 */

import { useEffect, useState } from 'react';
import type { AgentCard, AgentsResponse, AgentStatus } from '@/types/terminal';
import { AgentIcon, ChevronLeft, GridIcon, SyncIcon } from './icons';
import { Button } from './Button';
import { AttributionPanel } from './AttributionPanel';
import { RivalsPanel } from './RivalsPanel';
import {
  isRunnable,
  runFor,
  type RunContext,
  type RunField,
  type RunValues,
} from '../_lib/agentRuns';

/* Status is carried by colour AND form, because the brand palette is entirely
   warm — three of these used to be the same orange at 7px. See v3.css.
     ready     solid brass          attention  cognac-soft + ring
     running   brass + pulsing halo blocked    cognac-deep + notch
     idle      hollow */
const DOT: Record<AgentStatus, string> = {
  ready: 'v3-dot-ready',
  attention: 'v3-dot-attention',
  running: 'v3-dot-running',
  blocked: 'v3-dot-blocked',
  idle: 'v3-dot-idle',
};

/* ── the write path ───────────────────────────────────────────────────────
   Where an agent has a real endpoint, this renders its parameters and fires
   the call. Where it doesn't, it says precisely what is missing rather than
   offering a button that would fail. */
function RunPanel({
  agentKey,
  cta,
  projectId,
  runCtx,
  onRan,
  onAsk,
}: {
  agentKey: string;
  cta: string;
  projectId: string | null;
  runCtx: RunContext;
  onRan: (agentKey: string, error?: string) => void;
  onAsk: () => void;
}) {
  const spec = runFor(agentKey, runCtx);
  const runnable = isRunnable(spec);

  const [values, setValues] = useState<RunValues>(() =>
    runnable ? Object.fromEntries(spec.fields.map((f) => [f.name, f.def ?? ''])) : {},
  );
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!runnable || !projectId || busy) return;
    setBusy(true);
    try {
      await spec.run(projectId, values);
      onRan(agentKey);
    } catch (err) {
      onRan(agentKey, err instanceof Error ? err.message : 'run failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 space-y-2.5">
      {runnable && spec.fields.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {spec.fields.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={values[f.name]}
              onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
              disabled={busy}
            />
          ))}
        </div>
      )}

      {runnable ? (
        <>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="primary"
              onClick={submit}
              disabled={busy || !projectId}
              className="h-9 flex-1"
            >
              {busy ? 'running…' : spec.label}
            </Button>
            <Button type="button" variant="outline" onClick={onAsk} disabled={busy} className="shrink-0">
              Ask
            </Button>
          </div>
          <p className="text-caption leading-relaxed text-faint">{spec.note}</p>
        </>
      ) : (
        <>
          <Button type="button" variant="primary" size="lg" onClick={onAsk}>
            Ask the assistant →
          </Button>
          <p className="text-caption leading-relaxed text-faint">
            {spec ? spec.blocked : `Next: ${cta}.`}
          </p>
        </>
      )}
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
  disabled,
}: {
  field: RunField;
  value: string | number | undefined;
  onChange: (v: string | number) => void;
  disabled: boolean;
}) {
  const base =
    'w-full rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body text-text outline-none transition-colors duration-micro focus:border-border-strong disabled:opacity-50';
  return (
    <label className={field.kind === 'text' ? 'col-span-2 block' : 'block'}>
      <span className="mb-1 block text-eyebrow uppercase text-faint">{field.label}</span>
      {field.kind === 'select' ? (
        <select
          value={String(value ?? field.def)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={base}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          disabled={disabled}
          min={field.kind === 'number' ? field.min : undefined}
          max={field.kind === 'number' ? field.max : undefined}
          placeholder={field.kind === 'text' ? field.placeholder : undefined}
          onChange={(e) => onChange(field.kind === 'number' ? Number(e.target.value) : e.target.value)}
          className={base}
        />
      )}
    </label>
  );
}

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
  projectId,
  runCtx,
  selectedKey,
  onSelect,
  onRefresh,
  onAsk,
  onRan,
  chat,
  onOpenGap,
}: {
  data: AgentsResponse | null;
  loading: boolean;
  projectId: string | null;
  /** controlled by the page so the command palette can jump straight to an agent */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** what the run resolver needs to decide availability */
  runCtx: RunContext;
  onRefresh: () => void;
  /** hand an agent to the Cailyx Assistant */
  onAsk: (agentKey: string) => void;
  /** a run finished — the page refreshes the roster and reports the outcome */
  onRan: (agentKey: string, error?: string) => void;
  /** the Cailyx Assistant, slotted under the grid — omit to render it elsewhere on the page */
  chat?: React.ReactNode;
  /** Open the competitor gap workspace from the rivals panel. */
  onOpenGap?: () => void;
}) {
  const selKey = selectedKey;
  const setSelKey = onSelect;
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
        <span className="flex min-w-0 items-center gap-1.5 font-display text-body font-semibold text-text">
          {sel && <AgentIcon agentKey={sel.key} size={15} className="shrink-0 text-accent" animateOnHover />}
          <span className="truncate">{sel ? sel.name : 'Agents Feed'}</span>
        </span>
        {sel ? (
          <span className="ml-auto flex items-center gap-1.5 text-caption capitalize text-faint">
            <span className={`v3-dot ${DOT[sel.status]}`} />
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
              className={`grid h-5 w-5 place-items-center rounded-r1 transition-colors hover:bg-bg-inset hover:text-accent ${
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
            {/* v3-stagger: the roster assembles at 30ms/tile instead of
                appearing in one frame. Keyed on the project so a switch
                replays it. */}
            <div
              key={data?.projectId ?? 'boot'}
              className="v3-stagger grid shrink-0 gap-1.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(46px, 58px))' }}
            >
              {booting
                ? Array.from({ length: 10 }, (_, i) => (
                    <div key={i} className="v3skel aspect-square rounded-r2" />
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
                      <AgentIcon agentKey={a.key} size={18} animateOnHover />
                      <span className="w-full truncate text-center text-eyebrow font-medium normal-case leading-none tracking-normal text-faint">
                        {shortName(a.name)}
                      </span>
                      {/* Idle is the resting state of most of the roster, so it
                          carries no marker — a dot on all ten tiles tells you
                          nothing. Only states that want a decision are marked.
                          The wrapper does the positioning because .v3-dot owns
                          `position: relative` for its halo pseudo-element. */}
                      {a.status !== 'idle' && (
                        <span className="absolute right-1 top-1">
                          <span className={`v3-dot ${DOT[a.status]}`} />
                        </span>
                      )}
                    </button>
                  ))}
            </div>

            {!booting && agents.length === 0 && (
              <p className="text-body text-faint">No agents for this project yet.</p>
            )}

            {/* Cailyx Assistant — fills the space beneath the grid */}
            {chat && <div className="min-h-0 flex-1 border-t border-border pt-2">{chat}</div>}
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
                    <ul key={sel.key} className="v3-stagger space-y-1.5">
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

                {/* attribution has its own surface — a capture form to install
                    and a report to read, not a job to run */}
                {sel.key === 'attribution' && projectId ? (
                  <AttributionPanel projectId={projectId} />
                ) : sel.key === 'rivals' && projectId ? (
                  <RivalsPanel
                    projectId={projectId}
                    onAsk={() => {
                      onAsk(sel.key);
                      setSelKey(null);
                    }}
                    onOpenGap={onOpenGap}
                  />
                ) : (
                <RunPanel
                  key={sel.key}
                  agentKey={sel.key}
                  cta={sel.cta}
                  projectId={projectId}
                  runCtx={runCtx}
                  onRan={onRan}
                  onAsk={() => {
                    onAsk(sel.key);
                    setSelKey(null);
                  }}
                />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
