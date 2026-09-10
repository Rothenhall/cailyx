'use client';

/**
 * RivalsPanel — /v2. The competitive surface.
 *
 * Competitor data used to be scattered across three places and visible in
 * none of them: the list was buried in the context drawer, share of voice was
 * a small bar chart inside one tab of another card, and the observation-level
 * record of who actually beat you was never surfaced at all.
 *
 * This is one place to both read it and act on it. When nothing has been
 * measured yet — the common case — it shows the three steps that produce a
 * benchmark and which one you are on, because a blank chart teaches nothing.
 *
 * @module app/v2/_components/RivalsPanel
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getCompetitors,
  setCompetitors,
  type Competitor,
  type CompetitorsResponse,
} from '@/lib/terminal-api';
import { ArrowRight } from './icons';
import { PanelSkeleton, SectionLabel, StatHeadline } from './panel';
import { Button } from './Button';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** one step of the readiness ladder */
function Step({
  n,
  title,
  detail,
  state,
  action,
}: {
  n: number;
  title: string;
  detail: string;
  state: 'done' | 'now' | 'later';
  action?: React.ReactNode;
}) {
  return (
    <li
      className={`flex gap-2.5 rounded-r3 border p-3 transition-colors duration-micro ${
        state === 'now'
          ? 'border-accent-dim bg-accent-dim/14'
          : 'border-border/60 bg-bg-raised'
      }`}
    >
      <span
        className={`num grid h-5 w-5 shrink-0 place-items-center rounded-full font-display text-eyebrow ${
          state === 'done'
            ? 'bg-accent text-bg-raised'
            : state === 'now'
              ? 'bg-accent text-bg-raised'
              : 'border border-border text-faint'
        }`}
      >
        {state === 'done' ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-body font-semibold ${state === 'later' ? 'text-faint' : 'text-text'}`}>
          {title}
        </p>
        <p className="mt-0.5 text-caption leading-relaxed text-faint">{detail}</p>
        {state === 'now' && action ? <div className="mt-2">{action}</div> : null}
      </div>
    </li>
  );
}

export function RivalsPanel({
  projectId,
  onAsk,
}: {
  projectId: string;
  /** hand the competitive question to the assistant */
  onAsk: () => void;
}) {
  const [data, setData] = useState<CompetitorsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    getCompetitors(projectId).then(setData).catch(() => setFailed(true));
  }, [projectId]);

  useEffect(load, [load]);

  const commit = async (next: Competitor[]) => {
    setBusy(true);
    try {
      setData(await setCompetitors(projectId, next));
    } catch {
      /* keep what is on screen; the list is re-read on the next open */
    } finally {
      setBusy(false);
    }
  };

  const add = (c: Competitor) => {
    const list = data?.tracked ?? [];
    if (list.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) return;
    void commit([...list, c]);
  };
  const remove = (c: Competitor) => void commit((data?.tracked ?? []).filter((x) => x !== c));

  if (failed) return <p className="text-body text-faint">Could not load the benchmark.</p>;
  if (!data) return <PanelSkeleton />;

  const { tracked, discovered, readiness, you, rivals, losing } = data;
  const measured = readiness.observations > 0;
  const hasRivals = tracked.length > 0;

  const addForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        add({ name: name.trim(), domain: domain.trim() || null, source: 'manual' });
        setName('');
        setDomain('');
      }}
      className="flex gap-1.5"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        disabled={busy}
        className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body outline-none transition-colors duration-micro focus:border-border-strong"
      />
      <input
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        placeholder="domain"
        disabled={busy}
        className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-body outline-none transition-colors duration-micro focus:border-border-strong"
      />
      <Button variant="primary" size="sm" disabled={!name.trim() || busy} className="h-auto shrink-0 px-3">
        add
      </Button>
    </form>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── the scoreboard, once there is something to score ─────────── */}
      {measured && (
        <StatHeadline
          value={pct(you.total ? you.mentioned / you.total : 0)}
          label={`of ${you.total} answers mention you`}
          note={`${you.cited} cited with a link · ${losing.length} lost to a named rival`}
          tone={losing.length > 0 ? 'warn' : 'accent'}
        />
      )}

      {/* ── head to head ─────────────────────────────────────────────── */}
      {measured && rivals.length > 0 && (
        <div>
          <SectionLabel>Head to head</SectionLabel>
          <ul className="space-y-1.5">
            {rivals.slice(0, 6).map((r, i) => (
              <li key={r.name} className="flex items-center gap-2 text-body">
                <span className="v2-rank w-4 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                <span className="w-20 shrink-0 truncate text-dim">{r.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                  <span
                    className="block h-full rounded-full bg-accent-dim/65 transition-[width] duration-morph ease-brand"
                    style={{ width: pct(r.share) }}
                  />
                </span>
                <span className="num w-14 shrink-0 text-right text-caption text-faint">
                  {r.beatYou > 0 ? `${r.beatYou} beat` : `${r.appearances}×`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── the actionable list: prompts a rival won and you didn't ──── */}
      {measured && losing.length > 0 && (
        <div>
<SectionLabel>Prompts you&rsquo;re losing</SectionLabel>
          <ul className="space-y-1.5">
            {losing.slice(0, 6).map((l, i) => (
              <li
                key={i}
                className="rounded-r2 border border-border/60 px-2.5 py-2 transition-colors duration-micro hover:border-border-strong"
              >
                <p className="text-body font-medium leading-snug text-text">&ldquo;{l.prompt}&rdquo;</p>
                <p className="mt-1 text-eyebrow uppercase text-faint">
                  {l.surface} · won by {l.rivals.slice(0, 3).join(', ')}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── readiness — the common case, and the whole point of the panel ── */}
      {!measured && (
        <ol className="flex flex-col gap-2">
          <Step
            n={1}
            title="Name your rivals"
            detail={
              hasRivals
                ? `${tracked.length} on the benchmark list.`
                : 'Share of voice only scores names on this list. Empty means no comparison is produced anywhere.'
            }
            state={hasRivals ? 'done' : 'now'}
            action={addForm}
          />
          <Step
            n={2}
            title="Measure the answers"
            detail={
              readiness.runs > 0
                ? `${readiness.runs} run so far, no observations stored yet.`
                : 'Run the GEO agent against a query set to record who appears in each answer.'
            }
            state={!hasRivals ? 'later' : 'now'}
          />
          <Step
            n={3}
            title="See who wins each prompt"
            detail="Every answer records which rivals appeared, so you get the exact questions you lose and to whom."
            state="later"
          />
        </ol>
      )}

      {/* ── manage the list, once it exists ──────────────────────────── */}
      {(measured || hasRivals) && (
        <div>
<SectionLabel>Benchmark list · {tracked.length}</SectionLabel>
          {tracked.length > 0 && (
            <ul className="mb-2 space-y-1">
              {tracked.map((c) => (
                <li
                  key={`${c.name}-${c.domain ?? ''}`}
                  className="group flex items-center gap-2 rounded-r2 px-1.5 py-1 text-body transition-colors duration-micro hover:bg-bg-inset"
                >
                  <span className="h-1 w-1 shrink-0 rounded-full bg-accent-dim" />
                  <span className="shrink-0 text-dim">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-faint">{c.domain ?? ''}</span>
                  <button
                    type="button"
                    onClick={() => remove(c)}
                    disabled={busy}
                    aria-label={`Remove ${c.name}`}
                    className="shrink-0 rounded-r1 px-1 text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {addForm}
        </div>
      )}

      {/* ── discovery ────────────────────────────────────────────────── */}
      {discovered.length > 0 && (
        <div>
          <SectionLabel>Out-ranking you in search</SectionLabel>
          <ul className="space-y-1">
            {discovered.slice(0, 6).map((d) => (
              <li key={d.domain} className="flex items-center gap-2 text-body">
                <span className="min-w-0 flex-1 truncate text-dim">{d.domain}</span>
                <span className="num shrink-0 text-caption text-faint">
                  {d.bestRank !== null ? `#${d.bestRank}` : ''} · {d.appearances}&times;
                </span>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={busy}
                  onClick={() => add({ name: d.domain, domain: d.domain, source: 'serp' })}
                  className="h-auto shrink-0 rounded-r1 px-1.5 py-0.5 text-eyebrow uppercase"
                >
                  track
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button type="button" variant="outline" size="lg" onClick={onAsk}>
        Ask the assistant
        <ArrowRight className="h-3 w-3" />
      </Button>
    </div>
  );
}
