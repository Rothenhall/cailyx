'use client';

/**
 * SEO audit workspace — the SEO tile, expanded to the whole canvas.
 *
 * Sibling of the Technical audit workspace, but sourced from Google Search
 * Console. Tabbed, no long scroll: Overview · Queries · Pages · Fixes. The
 * point of the last tab is the point of the whole feature — Search Console
 * shows the data, this turns it into a to-do list Cailyx can partly action.
 *
 * @module app/v2/_components/SeoAuditWorkspace
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  getSeoAudit,
  getSeoAuditJob,
  getSeoComparison,
  getSeoSchedule,
  getSeoTrend,
  listSeoAudits,
  runSeoAudit,
  setSeoSchedule,
  submitSeoSitemaps,
  type AuditCadence,
  type AuditSchedule,
} from '@/lib/terminal-api';
import { pollUntilDone } from '@/lib/poll-job';
import type { AuditDelta, SeoAudit, SeoComparison, SeoTrendPoint } from '@/types/terminal';
import { band, rel } from '@/app/v2/_lib/audit';
import { SeoFixes, SeoOverview, SeoPages, SeoQueries } from './SeoAuditReport';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

type Tab = 'overview' | 'queries' | 'pages' | 'fixes';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'queries', label: 'Queries' },
  { id: 'pages', label: 'Pages' },
  { id: 'fixes', label: 'Fixes' },
];

const nf = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));

export function SeoAuditWorkspace({
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
  const [audit, setAudit] = useState<SeoAudit | null>(null);
  const [comparison, setComparison] = useState<SeoComparison | null>(null);
  const [trend, setTrend] = useState<SeoTrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  /** null = still loading; 'ok' = have data or can run; string = a blocking reason */
  const [gate, setGate] = useState<string | null | 'ok'>(null);
  const [schedule, setSchedule] = useState<AuditSchedule | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getSeoSchedule(projectId).then(setSchedule).catch(() => setSchedule(null));
    getSeoTrend(projectId).then(setTrend).catch(() => setTrend([]));
    try {
      const list = await listSeoAudits(projectId);
      if (list[0]) {
        const full = await getSeoAudit(projectId, list[0].id);
        setAudit(full);
        setGate('ok');
        const cmp = await getSeoComparison(projectId, list[0].id).catch(() => null);
        setComparison(cmp);
      } else {
        setAudit(null);
        setGate('ok'); // no runs yet, but nothing blocking — show the run prompt
      }
    } catch (err) {
      setAudit(null);
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        setGate(err.message);
      } else {
        setGate(err instanceof Error ? err.message : 'could not load the SEO audit');
      }
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    setAudit(null);
    setComparison(null);
    setTrend([]);
    setTab('overview');
    setGate(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changeCadence = async (cadence: AuditCadence) => {
    if (!projectId || savingSchedule) return;
    setSavingSchedule(true);
    try {
      setSchedule(await setSeoSchedule(projectId, cadence));
      onNotify(cadence === 'manual-only' ? 'SEO monitoring off' : `SEO monitoring: ${cadence}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'could not update the schedule', 'warn');
    } finally {
      setSavingSchedule(false);
    }
  };

  const until = (iso: string | null): string => {
    if (!iso) return 'soon';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'due now';
    const h = Math.round(ms / 3_600_000);
    return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
  };

  const doRun = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    onNotify('SEO audit queued — reading Search Console, ~1 min');
    try {
      const { jobId } = await runSeoAudit(projectId);
      const job = await pollUntilDone(() => getSeoAuditJob(projectId, jobId));
      if (job.status === 'failed') throw new Error(job.error || 'SEO audit failed');
      if (job.result) setAudit(job.result);
      setGate('ok');
      onNotify('SEO audit complete');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SEO audit failed';
      onNotify(msg, 'warn');
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) setGate(msg);
    } finally {
      setBusy(false);
    }
  };

  const submitSitemaps = async () => {
    if (!projectId) return;
    try {
      const r = await submitSeoSitemaps(projectId);
      onNotify(r.submitted.length ? `Re-submitted ${r.submitted.length} sitemap(s) to Google` : 'No sitemap to submit', r.submitted.length ? 'ok' : 'warn');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'sitemap submit failed', 'warn');
    }
  };

  const deltas: AuditDelta[] = useMemo(() => {
    if (comparison?.deltas?.length) return comparison.deltas;
    const raw = audit?.deltas;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  }, [comparison, audit]);

  const b = band(audit?.score ?? null);

  return (
    <div className="v2-audit-ws pointer-events-auto absolute inset-0 z-40 flex flex-col bg-bg">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Back" className="rounded-full bg-bg-inset text-dim">
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">SEO audit</span>
        <span className="truncate text-caption text-faint">{audit?.siteUrl ?? domain ?? '-'}</span>
        {audit?.score !== null && audit?.score !== undefined && (
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 ${b.tone.soft} ${b.tone.line} ${b.tone.text}`}>
            {audit.score} - {b.word}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-caption text-faint">
          {audit && (
            <>
              <span className="tabular-nums">{nf(audit.clicks)} clicks</span>
              <span className="tabular-nums">{nf(audit.impressions)} impr</span>
            </>
          )}
          <span>{audit ? `audited ${rel(audit.createdAt)}` : 'never audited'}</span>
        </span>

        <label
          className="flex shrink-0 items-center gap-1.5"
          title={
            !schedule
              ? 'Recurring SEO audits'
              : schedule.lastError
                ? `Last scheduled run failed: ${schedule.lastError}`
                : schedule.active
                  ? `Next run ${until(schedule.nextRunAt)}${schedule.lastRunAt ? ` · last ran ${rel(schedule.lastRunAt)}` : ''}`
                  : 'Monitoring off — runs only when you press Re-run'
          }
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              schedule?.lastError ? 'bg-a-bad' : schedule?.active ? 'bg-a-ok' : 'bg-faint/40'
            }`}
          />
          <span className="text-eyebrow uppercase tracking-eyebrow text-faint">Auto</span>
          <select
            value={schedule?.cadence ?? 'manual-only'}
            disabled={savingSchedule || !projectId || gate !== 'ok'}
            onChange={(e) => void changeCadence(e.target.value as AuditCadence)}
            className="rounded-r2 border border-border bg-bg-raised px-1.5 py-1 text-caption text-dim outline-none focus:border-border-strong disabled:opacity-50"
          >
            <option value="manual-only">off</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
          </select>
        </label>

        <Button type="button" variant="soft" size="sm" onClick={doRun} disabled={busy || !projectId || gate !== 'ok'} className="shrink-0">
          <SyncIcon className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'running...' : 'Re-run'}
        </Button>
      </div>

      {/* body */}
      {loading || gate === null ? (
        <div className="space-y-3 p-5">
          <div className="v2skel h-9 w-2/3 rounded-r2" />
          <div className="v2skel h-28 rounded-r4" />
          <div className="v2skel h-44 rounded-r4" />
        </div>
      ) : !projectId ? (
        <div className="grid flex-1 place-items-center p-6">
          <p className="text-body text-faint">Select a project to run its SEO audit.</p>
        </div>
      ) : gate !== 'ok' ? (
        <div className="grid flex-1 place-items-center p-6">
          <div className="max-w-[360px] rounded-r4 border border-border bg-bg-raised p-5 text-center">
            <p className="text-ui font-semibold text-text">Search Console needed</p>
            <p className="mt-1 text-caption leading-relaxed text-faint">{gate}</p>
            <p className="mt-2 text-caption leading-relaxed text-faint">
              Open the connections panel in the top bar, connect Google Search Console, and map this project&rsquo;s
              property. Then re-open this.
            </p>
          </div>
        </div>
      ) : !audit ? (
        <div className="grid flex-1 place-items-center p-6">
          <div className="max-w-[340px] rounded-r4 border border-border bg-bg-raised p-5 text-center">
            <p className="text-ui font-semibold text-text">No SEO audit yet</p>
            <p className="mt-1 text-caption leading-relaxed text-faint">
              Pull the last 28 days from Search Console and turn it into a fix list.
            </p>
            <Button type="button" variant="primary" size="md" onClick={doRun} disabled={busy} className="mt-3">
              {busy ? 'running...' : 'Run the first SEO audit'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="audit-tabs shrink-0 border-b border-border px-3">
            {TABS.map((s) => {
              const n =
                s.id === 'fixes'
                  ? audit.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
                  : 0;
              return (
                <button key={s.id} type="button" onClick={() => setTab(s.id)} className={`audit-tab ${tab === s.id ? 'is-on' : ''}`}>
                  {s.label}
                  {n > 0 && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-a-bad align-middle" />}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1">
            {tab === 'overview' && <SeoOverview audit={audit} deltas={deltas} trend={trend} />}
            {tab === 'queries' && <SeoQueries audit={audit} />}
            {tab === 'pages' && <SeoPages audit={audit} comparison={comparison} />}
            {tab === 'fixes' && <SeoFixes audit={audit} onSubmitSitemaps={submitSitemaps} />}
          </div>
        </div>
      )}
    </div>
  );
}
