'use client';

/**
 * Project workspace: the module map (PLAN.md §3.2). The shell level —
 * overview data + the module nav that each feature UI lands on, module by
 * module. Uses the scorecard endpoint as the live overview signal.
 *
 * @module app/projects/[projectId]/page
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch, ApiError, getToken } from '@/lib/api';
import { Project, ScorecardProblem } from '@/types/api';

interface ScorecardSummary {
  id: string;
  score: number;
  band: string;
  problems: ScorecardProblem[];
  nonObvious: boolean;
  publicToken: string;
}

const MODULES: { label: string; detail: string; done: boolean }[] = [
  { label: 'Query sets', detail: 'builder + activation (draft → active → fork)', done: true },
  { label: 'Measurement', detail: 'runs, observations, share of voice', done: true },
  { label: 'Technical audit', detail: 'robots / CDN / JS render / CWV / schema probes', done: true },
  { label: 'Entity audit', detail: 'descriptors, model diff, platform consistency', done: true },
  { label: 'Gap analysis & findings', detail: '6-dimension classification, ranked copy', done: true },
  { label: 'Pages', detail: 'extractability scoring (BLUF / question H2s / format / claims)', done: true },
  { label: 'Mentions', detail: 'campaigns, targets, decay view', done: true },
  { label: 'Sleeper refresh', detail: 'declining pages, refresh SLA', done: true },
  { label: 'Data assets', detail: 'original-data lifecycle', done: true },
  { label: 'Reports', detail: 'branded web + PDF delivery', done: true },
  { label: 'Delivery & CRM', detail: 'leads, CTA log, email, upgrades', done: true },
  { label: 'Monitoring', detail: 'scheduled re-runs, deltas, alerts', done: true },
  { label: 'Pipeline math', detail: 'qualification arithmetic', done: true },
  { label: 'Scorecard', detail: 'Rung-0 free diagnostic', done: true },
];

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params?.projectId;

  const [project, setProject] = useState<Project | null>(null);
  const [card, setCard] = useState<ScorecardSummary | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && getToken() === null) router.push('/login');
  }, [router]);

  useEffect(() => {
    if (!projectId || getToken() === null) return;
    void (async () => {
      try {
        setProject(await apiFetch<Project>(`/projects/${projectId}`));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setProject(null);
        setError(err instanceof Error ? err.message : 'Failed to load project');
      }
    })();
  }, [projectId]);

  const runScorecard = async () => {
    setStatus('running');
    setError(null);
    try {
      setCard(await apiFetch<ScorecardSummary>(`/projects/${projectId}/scorecard`, { method: 'POST', json: {} }));
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Scorecard run failed');
    }
  };

  if (project === null) {
    return <p className="text-sm text-slate-500">{error ? error : 'Loading project…'}</p>;
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <p className="text-sm text-slate-600">{project.domain}{project.status ? ` · ${project.status}` : ''}</p>
      </div>

      {/* Rung-0 quick scorecard — the module that works end-to-end from the shell */}
      <section className="mb-8 rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Free diagnostic (Rung 0)</h2>
            <p className="text-sm text-slate-500">Fresh technical audit + rubric score + the 3 named problems.</p>
          </div>
          <button onClick={runScorecard} disabled={status === 'running'}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
            {status === 'running' ? 'Running…' : card === null ? 'Run scorecard' : 'Re-run'}
          </button>
        </div>

        {card && (
          <div className="mt-4">
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-semibold">{card.score}</span>
              <span className="text-sm uppercase tracking-wide text-slate-500">/100 · {card.band}</span>
              {card.nonObvious && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">non-obvious finding ✓</span>
              )}
            </div>
            <ol className="mt-4 space-y-2">
              {card.problems.map((p, i) => (
                <li key={i} className="rounded-md border border-slate-100 bg-slate-50 p-3 text-sm">
                  <p className="font-medium">{i + 1}. {p.dimension}{p.value !== null ? ` — ${p.value}/100` : ''}</p>
                  <p className="mt-1 text-slate-600">{p.why}</p>
                  <p className="mt-1 text-slate-500">Fix: {p.fix}</p>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-slate-400">Share token: /scorecard/public/{card.publicToken} (live once SCORECARD_PUBLIC=1) — findings are never gated behind a call.</p>
          </div>
        )}
        {status === 'error' && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </section>

      {/* Module map — feature UIs land here one by one */}
      <section>
        <h2 className="mb-3 text-lg font-medium">Modules</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <li key={m.label} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{m.label}</p>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">backend ready</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{m.detail}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}