'use client';

/**
 * AEO audit workspace — the answer-engine tile, expanded to the whole canvas.
 *
 * Sibling of the SEO and Technical audit workspaces. Those measure Google; this
 * measures ChatGPT, Perplexity and Gemini — the places buyers now ask instead of
 * searching. Tabbed, no long scroll: Overview · Engines · Categories · Rivals ·
 * Prompts.
 *
 * ## Why the run controls look like this
 *
 * An AEO run is not a fetch, it is a job: a 100-prompt matrix at n=5 is 500
 * questions *per engine*, each typed into a real browser session with a
 * deliberate gap between them. So the UI lets the operator choose engines and
 * size up front, warns what that costs in time, and then polls — rather than
 * pretending a button press returns a result.
 *
 * @module app/v3/_components/AeoAuditWorkspace
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildAeoContext,
  getAeoBudget,
  getAeoContext,
  getAeoMatrix,
  getAeoVerdict,
  listAeoAudits,
  runFullAeoAudit,
  judgeAeoStance,
} from '@/lib/terminal-api';
import type { AeoAuditSummary, AeoBudget, AeoContext, AeoMatrix, AeoSurface, AeoVerdict } from '@/types/terminal';
import { rel } from '@/app/v3/_lib/audit';
import { AeoCategories, AeoEngines, AeoMarkets, AeoOverview, AeoPrompts, AeoRivals } from './AeoAuditReport';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

type Tab = 'overview' | 'engines' | 'categories' | 'rivals' | 'prompts' | 'markets';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'engines', label: 'Engines' },
  { id: 'categories', label: 'Categories' },
  { id: 'rivals', label: 'Rivals' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'markets', label: 'Markets' },
];

/** Markets cap — matches the backend DTO's `@ArrayMaxSize(5)`. */
const MAX_MARKETS = 5;

/**
 * Engines the operator can pick. `mock` is deliberately not offered here.
 *
 * Cloro surfaces are the default path (wave-6 D1) — they query the consumer
 * product via API, no session file, no ToS exposure — and are offered first.
 * The `-browser` surfaces remain for operators who've set up a session
 * (`AEO_ALLOW_BROWSER_SURFACE=1`) and are also Cloro's automatic fallback.
 */
const ENGINES: { id: AeoSurface; label: string }[] = [
  { id: 'cloro-chatgpt', label: 'ChatGPT' },
  { id: 'cloro-perplexity', label: 'Perplexity' },
  { id: 'cloro-gemini', label: 'Gemini' },
  { id: 'cloro-ai-overview', label: 'Google AI Overview' },
  { id: 'cloro-ai-mode', label: 'Google AI Mode' },
  { id: 'chatgpt-browser', label: 'ChatGPT (browser)' },
  { id: 'perplexity-browser', label: 'Perplexity (browser)' },
  { id: 'gemini-browser', label: 'Gemini (browser)' },
];

const TIERS: { id: string; label: string; prompts: number; note: string }[] = [
  { id: 'trial', label: 'Trial', prompts: 5, note: 'five heaviest angles, all engines' },
  { id: 'trial-wide', label: 'Trial (wide)', prompts: 10, note: 'one prompt per angle' },
  { id: 'scorecard', label: 'Scorecard', prompts: 25, note: '' },
  { id: 'standard', label: 'Standard', prompts: 100, note: '' },
  { id: 'full', label: 'Full', prompts: 300, note: '' },
];

/** Below this, the matrix cannot cover all ten angles — say so before the run. */
const DIMENSION_COUNT = 10;

/** Rough wall-clock, from the ~8s politeness gap between prompts. */
function estimate(prompts: number, engines: number, runCount: number): string {
  const calls = prompts * runCount * engines;
  const minutes = Math.round((calls * 10) / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${(minutes / 60).toFixed(1)} h`;
}

/**
 * Credits this run needs, against what is left.
 *
 * Three states, and the third is the point: when the balance cannot be read the
 * line says so rather than showing a reassuring tick. An unknown balance is not
 * a sufficient one, and a budget shown with false confidence is worse than no
 * budget at all.
 *
 * Renders nothing when no metered engine is selected — the browser surfaces are
 * paid for by a subscription, and a "0 credits" badge on them would imply the
 * meter was consulted when it was not.
 */
function BudgetLine({ budget }: { budget: AeoBudget | null }) {
  if (!budget || budget.required === 0) return null;

  if (budget.remaining === null) {
    return (
      <span className="text-caption text-faint" title={budget.unavailableReason ?? undefined}>
        needs {budget.required.toLocaleString()} credits · balance unknown
      </span>
    );
  }

  const short = budget.required - budget.remaining;
  return (
    <span className={`text-caption ${budget.fits ? 'text-faint' : 'text-danger'}`}>
      needs {budget.required.toLocaleString()} of {budget.remaining.toLocaleString()} credits
      {budget.fits ? '' : ` · ${short.toLocaleString()} short`}
    </span>
  );
}

export function AeoAuditWorkspace({
  projectId,
  domain,
  onClose,
  onNotify,
}: {
  projectId: string | null;
  domain: string | null;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const [audit, setAudit] = useState<AeoAuditSummary | null>(null);
  const [verdict, setVerdict] = useState<AeoVerdict | null>(null);
  const [context, setContext] = useState<AeoContext | null>(null);
  const [matrix, setMatrix] = useState<AeoMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [surfaces, setSurfaces] = useState<AeoSurface[]>(['chatgpt-browser']);
  const [tier, setTier] = useState('trial');
  /**
   * What this configuration would cost, refreshed as the operator changes it.
   *
   * Step 0 deferred this until credits had a meaning (step 1). The run-time
   * guard already refuses an unaffordable run, but being told after the click
   * is the wrong place to learn it — so the same arithmetic runs while the tier
   * is still being chosen.
   */
  const [budget, setBudget] = useState<AeoBudget | null>(null);

  /** Additional markets beyond the backend's own top-ranked default (wave-6 D8). */
  const [markets, setMarkets] = useState<string[]>([]);
  /** Set while a run is in flight so the poller knows what to watch. */
  const pollingId = useRef<string | null>(null);

  const loadVerdict = useCallback(
    async (pid: string, a: AeoAuditSummary) => {
      const v = await getAeoVerdict(pid, a.id).catch(() => null);
      setVerdict(v);
      return v;
    },
    [],
  );

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getAeoContext(projectId).then(setContext).catch(() => setContext(null));
    try {
      const list = await listAeoAudits(projectId);
      const latest = list[0] ?? null;
      setAudit(latest);
      if (latest) {
        const v = await loadVerdict(projectId, latest);
        // The matrix is only needed for the Prompts tab, so a failure here must
        // not block the report the operator came for.
        const full = await import('@/lib/terminal-api').then((m) => m.getAeoAudit(projectId, latest.id)).catch(() => null);
        if (full?.querySetId) {
          getAeoMatrix(projectId, full.querySetId).then(setMatrix).catch(() => setMatrix(null));
        }
        if (!v && latest.status !== 'completed' && latest.status !== 'failed') pollingId.current = latest.id;
      }
    } catch {
      setAudit(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, loadVerdict]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Re-price whenever the operator changes engines, tier or markets. A failed
     lookup clears the estimate rather than leaving a stale number on screen —
     a wrong budget is worse than none. */
  useEffect(() => {
    if (!projectId || surfaces.length === 0) {
      setBudget(null);
      return;
    }
    let live = true;
    getAeoBudget(projectId, {
      surfaces,
      tier,
      runCount: 5,
      markets: Math.max(markets.length, 1),
    })
      .then((b) => {
        if (live) setBudget(b);
      })
      .catch(() => {
        if (live) setBudget(null);
      });
    return () => {
      live = false;
    };
  }, [projectId, surfaces, tier, markets]);

  /** Poll a running audit so a long job reports progress instead of hanging. */
  useEffect(() => {
    if (!projectId || !audit) return;
    const inFlight = ['pending', 'context', 'matrix', 'running', 'judging'].includes(audit.status);
    if (!inFlight) return;
    const t = setInterval(() => {
      void listAeoAudits(projectId)
        .then(async (list) => {
          const next = list.find((a) => a.id === audit.id);
          if (!next) return;
          setAudit(next);
          if (next.status === 'completed') {
            await loadVerdict(projectId, next);
            onNotify('AEO audit complete');
          } else if (next.status === 'failed') {
            onNotify(next.error ?? 'AEO audit failed', 'warn');
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [projectId, audit, loadVerdict, onNotify]);

  const toggleEngine = (id: AeoSurface) => {
    setSurfaces((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const toggleMarket = (m: string) => {
    setMarkets((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : prev.length >= MAX_MARKETS ? prev : [...prev, m]));
  };

  const doRun = async () => {
    if (!projectId || surfaces.length === 0) return;
    setBusy(true);
    try {
      if (!context) {
        onNotify('Reading the site first...');
        const built = await buildAeoContext(projectId, { refine: true });
        setContext(built);
      }
      // Queued on the backend's pipeline queue — the resume runs in the
      // background there, so nothing here needs to hold a connection open.
      const started = await runFullAeoAudit(projectId, {
        surfaces,
        tier,
        runCount: 5,
        reuseContext: true,
        markets: markets.length > 0 ? markets : undefined,
      });
      setAudit(started);
      onNotify(`Audit started on ${surfaces.length} engine${surfaces.length === 1 ? '' : 's'} — this runs in the background`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'could not start the audit', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const doJudge = async () => {
    if (!projectId || !audit) return;
    setBusy(true);
    try {
      const r = await judgeAeoStance(projectId, audit.id);
      onNotify(`Judged ${r.judged} answers ($${r.costUsd.toFixed(4)})`);
      await loadVerdict(projectId, audit);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'stance pass failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const running = audit ? ['pending', 'context', 'matrix', 'running', 'judging'].includes(audit.status) : false;
  const tierPrompts = TIERS.find((t) => t.id === tier)?.prompts ?? 25;

  return (
    <div className="v3-audit-ws pointer-events-auto absolute inset-0 z-40 flex flex-col bg-bg">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Back" className="rounded-full bg-bg-inset text-dim">
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">AEO audit</span>
        <span className="truncate text-caption text-faint">{context?.domain ?? domain ?? '-'}</span>
        {verdict && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 text-dim">
            {(verdict.counted.unbranded.mentionRate * 100).toFixed(0)}% unbranded
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-caption text-faint">
          {audit && <span>{running ? `${audit.stage ?? audit.status}...` : `run ${rel(audit.createdAt)}`}</span>}
          {audit && audit.costUsd > 0 && <span className="tabular-nums">${audit.costUsd.toFixed(3)}</span>}
        </span>
        {verdict && !verdict.judged.available && (
          <Button type="button" variant="ghost" size="sm" onClick={doJudge} disabled={busy || running} className="shrink-0">
            Judge positioning
          </Button>
        )}
        <Button type="button" variant="soft" size="sm" onClick={doRun} disabled={busy || running || !projectId || surfaces.length === 0} className="shrink-0">
          <SyncIcon className={`h-3 w-3 ${busy || running ? 'animate-spin' : ''}`} />
          {running ? 'running...' : audit ? 'New run' : 'Run audit'}
        </Button>
      </div>

      {/* run configuration — always visible, because engine choice changes the price */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-inset/30 px-4 py-2">
        <span className="text-eyebrow uppercase tracking-eyebrow text-faint">Engines</span>
        <div className="flex gap-1.5">
          {ENGINES.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => toggleEngine(e.id)}
              disabled={running}
              className={`rounded-r2 border px-2 py-1 text-caption transition-colors ${
                surfaces.includes(e.id)
                  ? 'border-border-strong bg-bg-raised text-text'
                  : 'border-border text-faint hover:text-dim'
              } disabled:opacity-50`}
            >
              {e.label}
            </button>
          ))}
        </div>
        {context?.markets && context.markets.length > 0 ? (
          <>
            <span className="text-eyebrow uppercase tracking-eyebrow text-faint">Markets</span>
            <div className="flex gap-1.5">
              {context.markets.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleMarket(m)}
                  disabled={running}
                  className={`rounded-r2 border px-2 py-1 text-caption transition-colors ${
                    markets.includes(m)
                      ? 'border-border-strong bg-bg-raised text-text'
                      : 'border-border text-faint hover:text-dim'
                  } disabled:opacity-50`}
                >
                  {m}
                </button>
              ))}
            </div>
            {markets.length > 0 && (
              <span className="text-caption text-faint">each additional market multiplies engine calls</span>
            )}
          </>
        ) : null}
        <span className="text-eyebrow uppercase tracking-eyebrow text-faint">Size</span>
        <select
          value={tier}
          disabled={running}
          onChange={(e) => setTier(e.target.value)}
          className="rounded-r2 border border-border bg-bg-raised px-1.5 py-1 text-caption text-dim outline-none focus:border-border-strong disabled:opacity-50"
        >
          {TIERS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} — {t.prompts} prompts{t.note ? ` (${t.note})` : ''}
            </option>
          ))}
        </select>
        <span className="text-caption text-faint">
          {tierPrompts * 5 * Math.max(surfaces.length, 1)} questions · {estimate(tierPrompts, Math.max(surfaces.length, 1), 5)}
        </span>
        {tierPrompts < DIMENSION_COUNT ? (
          <span className="text-caption text-warn">
            probe only — covers {tierPrompts} of {DIMENSION_COUNT} angles
          </span>
        ) : null}
        <BudgetLine budget={budget} />
      </div>

      {/* body */}
      {loading ? (
        <div className="space-y-3 p-5">
          <div className="v3skel h-9 w-2/3 rounded-r2" />
          <div className="v3skel h-28 rounded-r4" />
          <div className="v3skel h-44 rounded-r4" />
        </div>
      ) : !projectId ? (
        <div className="grid flex-1 place-items-center p-6">
          <p className="text-body text-faint">Select a project to run its AEO audit.</p>
        </div>
      ) : running ? (
        <RunningState audit={audit} surfaces={surfaces} />
      ) : !verdict ? (
        <EmptyState hasAudit={Boolean(audit)} error={audit?.error ?? null} busy={busy} onRun={doRun} />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="audit-tabs shrink-0 border-b border-border px-3">
            {TABS.filter((s) => s.id !== 'markets' || (verdict.counted.byMarket?.length ?? 0) > 1).map((s) => {
              const dot =
                (s.id === 'engines' && verdict.surfaceRuns.some((r) => r.status === 'failed')) ||
                (s.id === 'rivals' && verdict.counted.competitors.some((r) => r.wonWhileClientAbsent > 0));
              return (
                <button key={s.id} type="button" onClick={() => setTab(s.id)} className={`audit-tab ${tab === s.id ? 'is-on' : ''}`}>
                  {s.label}
                  {dot && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-a-bad align-middle" />}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1">
            {tab === 'overview' && <AeoOverview verdict={verdict} context={context} />}
            {tab === 'engines' && <AeoEngines verdict={verdict} />}
            {tab === 'categories' && <AeoCategories verdict={verdict} matrix={matrix} />}
            {tab === 'rivals' && <AeoRivals verdict={verdict} />}
            {tab === 'prompts' && <AeoPrompts verdict={verdict} matrix={matrix} />}
            {tab === 'markets' && <AeoMarkets verdict={verdict} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** Progress view. A long job must show where it is, not just spin. */
function RunningState({ audit, surfaces }: { audit: AeoAuditSummary | null; surfaces: AeoSurface[] }) {
  const stages = [
    { id: 'context', label: 'Reading the site' },
    { id: 'matrix', label: 'Building the prompt matrix' },
    { id: 'measurement', label: `Asking ${surfaces.length} engine${surfaces.length === 1 ? '' : 's'}` },
    { id: 'stance', label: 'Judging positioning' },
    { id: 'verdict', label: 'Compiling the report' },
  ];
  const doneIdx = stages.findIndex((s) => s.id === audit?.stage);

  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="w-full max-w-[420px] rounded-r4 border border-border bg-bg-raised p-5">
        <p className="text-ui font-semibold text-text">Audit running</p>
        <p className="mt-1 text-caption leading-relaxed text-faint">
          Each question is typed into a real browser session with a deliberate gap between them, so this takes a
          while. You can close this — it keeps running.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {stages.map((s, i) => {
            const done = doneIdx >= 0 && i <= doneIdx;
            const active = doneIdx >= 0 ? i === doneIdx + 1 : i === 0;
            return (
              <li key={s.id} className="flex items-center gap-2.5 text-[13px]">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    done ? 'bg-a-ok' : active ? 'animate-pulse bg-a-warn' : 'bg-faint/30'
                  }`}
                />
                <span className={done ? 'text-dim' : active ? 'text-text' : 'text-faint'}>{s.label}</span>
              </li>
            );
          })}
        </ul>
        {audit && audit.observations > 0 && (
          <p className="mt-3 text-caption tabular-nums text-faint">{audit.observations} answers recorded so far</p>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  hasAudit,
  error,
  busy,
  onRun,
}: {
  hasAudit: boolean;
  error: string | null;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="max-w-[400px] rounded-r4 border border-border bg-bg-raised p-5 text-center">
        <p className="text-ui font-semibold text-text">{hasAudit ? 'Last run produced no report' : 'No AEO audit yet'}</p>
        <p className="mt-1 text-caption leading-relaxed text-faint">
          {error ??
            'Ask ChatGPT, Perplexity and Gemini the questions your buyers actually ask, and measure whether they name you — or a competitor.'}
        </p>
        {!hasAudit && (
          <p className="mt-2 text-caption leading-relaxed text-faint">
            Each engine needs a saved sign-in on the server before it can be measured.
          </p>
        )}
        <Button type="button" variant="primary" size="md" onClick={onRun} disabled={busy} className="mt-3">
          {busy ? 'starting...' : hasAudit ? 'Try again' : 'Run the first AEO audit'}
        </Button>
      </div>
    </div>
  );
}
