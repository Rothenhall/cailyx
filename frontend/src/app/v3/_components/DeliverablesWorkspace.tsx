'use client';

/**
 * DeliverablesWorkspace — /v3. What the client actually receives.
 *
 * `reporting` (branded HTML report, shareable slug) and `scorecard` (scored run
 * behind a public token) both shipped working and had **no UI at all** — the
 * thing the business sells was the one thing the console could not produce.
 *
 * Two rules here, both about the fact that these leave the building:
 *
 * 1. **Visibility is stated on every row, never inferred.** A report is private
 *    or public and the difference is who can read the client's audit. A control
 *    that quietly defaults to public would be a data leak with a nice animation.
 * 2. **A generated report is a snapshot, not a live view.** It freezes findings
 *    and scores at generation time, so the list shows when — otherwise an
 *    operator sends a client a report that silently predates the fix they just
 *    shipped.
 *
 * @module app/v3/_components/DeliverablesWorkspace
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, API_URL } from '@/lib/api';
import { generateReport, listReports, listScorecards, setReportVisibility } from '@/lib/terminal-api';
import type { ReportSummary, ScorecardRun } from '@/types/terminal';
import { rel } from '@/app/v3/_lib/audit';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

type Tab = 'reports' | 'scorecards';

export function DeliverablesWorkspace({
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
  const [tab, setTab] = useState<Tab>('reports');
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [scorecards, setScorecards] = useState<ScorecardRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [r, s] = await Promise.all([
      listReports(projectId).catch(() => []),
      listScorecards(projectId).catch(() => []),
    ]);
    setReports(r);
    setScorecards(s);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    if (!projectId || busy) return;
    const t = title.trim() || `${domain ?? 'Client'} audit`;
    setBusy(true);
    try {
      await generateReport(projectId, {
        targetUrl: domain ? `https://${domain.replace(/^https?:\/\//, '')}` : '',
        title: t,
      });
      setTitle('');
      await load();
      onNotify(`Report "${t}" generated`);
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Could not generate the report', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const toggleVisibility = async (r: ReportSummary) => {
    if (!projectId || busy) return;
    const next = r.visibility === 'public' ? 'private' : 'public';
    setBusy(true);
    try {
      await setReportVisibility(projectId, r.slug, next);
      await load();
      onNotify(
        next === 'public'
          ? 'Report is now readable by anyone with the link'
          : 'Report is private again',
        next === 'public' ? 'warn' : 'ok',
      );
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Could not change visibility', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      onNotify('Link copied');
    } catch {
      // Clipboard is permission-gated and blocked in plenty of contexts; the
      // link is on screen either way, so this is a convenience, not the feature.
      onNotify('Could not copy — the link is shown above', 'warn');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Back"
          className="rounded-full bg-bg-inset text-dim"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">Deliverables</span>
        <span className="truncate text-caption text-faint">{domain ?? '—'}</span>
        <Button type="button" variant="ghost" size="sm" onClick={load} className="ml-auto gap-1.5">
          <SyncIcon className="h-3.5 w-3.5" />
          Reload
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
        {(['reports', 'scorecards'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-r2 px-2.5 py-1 text-caption capitalize transition-colors ${
              tab === t ? 'bg-bg-inset font-semibold text-text' : 'text-faint hover:text-dim'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!projectId ? (
          <p className="text-body text-faint">Select a project first.</p>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="v3skel h-12 rounded-r3" />
            ))}
          </div>
        ) : tab === 'reports' ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void generate();
                }}
                placeholder={`Report title — defaults to "${domain ?? 'Client'} audit"`}
                className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2.5 py-1.5 text-caption text-text outline-none placeholder:text-faint focus:border-accent-dim"
              />
              <Button type="button" variant="soft" size="sm" onClick={generate} disabled={busy}>
                {busy ? 'generating…' : 'Generate report'}
              </Button>
            </div>

            {reports.length === 0 ? (
              <p className="max-w-prose text-body leading-relaxed text-faint">
                No reports yet. A report snapshots the current findings, scores and roadmap into a
                branded page you can share — it does not update afterwards, which is why the date it
                was generated is shown on every row.
              </p>
            ) : (
              <ul className="space-y-2">
                {reports.map((r) => {
                  const url = `${API_URL}/projects/${projectId}/reports/${r.slug}/view`;
                  const isPublic = r.visibility === 'public';
                  return (
                    <li key={r.slug} className="rounded-r3 border border-border bg-bg-raised px-3 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">
                          {r.title}
                        </span>
                        {/* Stated, never inferred — this decides who can read a
                            client's audit. */}
                        <span
                          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wide2 ${
                            isPublic
                              ? 'border-a-warn-line bg-a-warn-soft text-a-warn'
                              : 'border-border text-faint'
                          }`}
                        >
                          {isPublic ? 'public link' : 'private'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-caption text-faint">
                        Score {r.scoreTotal}/100 · {r.scoreBand} · generated {rel(r.createdAt)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="rounded-r2 border border-border px-2 py-1 text-caption text-dim transition-colors hover:border-accent-dim hover:text-accent"
                        >
                          Open
                        </a>
                        {isPublic && (
                          <button
                            type="button"
                            onClick={() => copy(url)}
                            className="rounded-r2 border border-border px-2 py-1 text-caption text-dim transition-colors hover:border-accent-dim hover:text-accent"
                          >
                            Copy link
                          </button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleVisibility(r)}
                          disabled={busy}
                        >
                          {isPublic ? 'Make private' : 'Make public'}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : scorecards.length === 0 ? (
          <p className="max-w-prose text-body leading-relaxed text-faint">
            No scorecard runs. A scorecard is the short, scored version generated for a prospect,
            reachable by a public token.
          </p>
        ) : (
          <ul className="space-y-2">
            {scorecards.map((s) => (
              <li key={s.id} className="rounded-r3 border border-border bg-bg-raised px-3 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="num font-display text-ui font-medium tabular-nums text-text">
                    {Math.round(s.score)}
                  </span>
                  <span className="text-caption text-dim">{s.band}</span>
                  <span className="ml-auto text-caption text-faint">{rel(s.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-caption text-faint">
                  {s.depth} depth{s.nonObvious ? ' · non-obvious findings included' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
