'use client';

/**
 * Technical audit workspace - the Technical tile, expanded to the whole canvas.
 *
 * The report is not one long scroll. The shell is a tabbed workspace: a fixed
 * header (verdict + run cost, always visible), a rail carrying only the metric
 * ledger, and a row of tabs that switch between panels. Each panel fills the
 * height and scrolls only inside itself, so the analysis and the run cost are
 * one click away, never a scroll away.
 *
 *   +--------------+---------------------------------------------------------+
 *   |  Back  Technical audit  domain  [92 Healthy]   $0.04 . 106s   Re-run   |
 *   +--------------+---------------------------------------------------------+
 *   | METRIC       | [Overview][Access][Performance][Structure][Pages][AI]…  |
 *   |  LEDGER      | +-----------------------------------------------------+ |
 *   |  every       | |  ACTIVE PANEL                                        | |
 *   |  tracked     | |  verdict  |  evidence - what was actually fetched    | |
 *   |  metric      | +-----------------------------------------------------+ |
 *   +--------------+---------------------------------------------------------+
 *
 * @module app/v2/_components/TechnicalAuditWorkspace
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getAudit,
  getAuditComparison,
  getAuditJob,
  getAuditSchedule,
  getAuditTrend,
  listAudits,
  runAudit,
  setAuditSchedule,
  type AuditCadence,
  type AuditSchedule,
} from '@/lib/terminal-api';
import { pollUntilDone } from '@/lib/poll-job';
import type { AuditComparison, AuditTrendPoint, TechnicalAudit } from '@/types/terminal';
import { band, fmtMs, rel, REPORT_SECTIONS, statusOf, type SectionId } from '@/app/v2/_lib/audit';
import {
  MetricLedger,
  ReportAccess,
  ReportAgent,
  ReportStack,
  ReportAnalysis,
  ReportOverview,
  ReportPages,
  ReportPerformance,
  ReportStructure,
} from './TechnicalAuditReport';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

/** which finding backs each tab's count badge */
const TAB_CHECK: Partial<Record<SectionId, string[]>> = {
  access: ['robots', 'cdn-inferred'],
  performance: ['cwv'],
  structure: ['schema', 'sitemap', 'js-render'],
  pages: ['page-inventory'],
  agent: ['agent-readiness'],
};

export function TechnicalAuditWorkspace({
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
  const [audit, setAudit] = useState<TechnicalAudit | null>(null);
  const [comparison, setComparison] = useState<AuditComparison | null>(null);
  const [trend, setTrend] = useState<AuditTrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SectionId>('overview');
  const [schedule, setSchedule] = useState<AuditSchedule | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await listAudits(projectId);
      const full = list[0] ? await getAudit(projectId, list[0].id) : null;
      setAudit(full);
      if (full) {
        const [cmp, tr, sch] = await Promise.allSettled([
          getAuditComparison(projectId, full.id),
          getAuditTrend(projectId),
          getAuditSchedule(projectId),
        ]);
        setComparison(cmp.status === 'fulfilled' ? cmp.value : null);
        setTrend(tr.status === 'fulfilled' ? tr.value : []);
        setSchedule(sch.status === 'fulfilled' ? sch.value : null);
      } else {
        setComparison(null);
        setTrend([]);
        try {
          setSchedule(await getAuditSchedule(projectId));
        } catch {
          setSchedule(null);
        }
      }
    } catch {
      setAudit(null);
      setComparison(null);
      setTrend([]);
    }
    setLoading(false);
  }, [projectId]);

  const changeCadence = async (cadence: AuditCadence) => {
    if (!projectId || savingSchedule) return;
    setSavingSchedule(true);
    try {
      const next = await setAuditSchedule(projectId, cadence);
      setSchedule(next);
      onNotify(cadence === 'manual-only' ? 'monitoring off' : `monitoring: ${cadence}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'could not update schedule', 'warn');
    } finally {
      setSavingSchedule(false);
    }
  };

  useEffect(() => {
    setAudit(null);
    setComparison(null);
    setTrend([]);
    setTab('overview');
    void load();
  }, [load]);

  /* Esc closes - this is a takeover surface, so it behaves like one. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doRun = async () => {
    if (!projectId || !domain || busy) return;
    setBusy(true);
    onNotify('audit queued — runs the full 8 checks, about 40s');
    try {
      const { jobId } = await runAudit(projectId);
      const job = await pollUntilDone(() => getAuditJob(projectId, jobId));
      if (job.status === 'failed') throw new Error(job.error || 'audit failed');
      onNotify('audit complete');
      await load();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'audit failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  /* run cost / timing - surfaced in the header so it is never a scroll away */
  const obs = useMemo(() => {
    const raw = audit?.observability;
    if (!raw) return null;
    try {
      return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    } catch {
      return null;
    }
  }, [audit]);

  const b = band(audit?.score ?? null);

  const until = (iso: string | null): string => {
    if (!iso) return 'soon';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'due now';
    const h = Math.round(ms / 3_600_000);
    return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
  };
  const scheduleTitle = !schedule
    ? 'Recurring technical audits'
    : schedule.lastError
      ? `Last scheduled run failed: ${schedule.lastError}`
      : schedule.active
        ? `Next run ${until(schedule.nextRunAt)}${schedule.lastRunAt ? ` · last ran ${rel(schedule.lastRunAt)}` : ''}`
        : 'Monitoring off — runs only when you press Re-run';

  /* mark a tab by the worst status among the checks it owns, so a failing
     area reads at a glance and not just as a small number */
  const tabTone = (id: SectionId): 'bad' | 'warn' | null => {
    const types = TAB_CHECK[id];
    if (!types || !audit) return null;
    const states = types.map((t) => statusOf(audit, t));
    if (states.includes('fail')) return 'bad';
    if (states.includes('warn')) return 'warn';
    return null;
  };

  return (
    <div className="v2-audit-ws pointer-events-auto absolute inset-0 z-40 flex flex-col bg-bg">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Back to the console"
          className="rounded-full bg-bg-inset text-dim"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">Technical audit</span>
        <span className="truncate text-caption text-faint">{domain ?? '-'}</span>
        {audit?.score !== null && audit?.score !== undefined && (
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 ${b.tone.soft} ${b.tone.line} ${b.tone.text}`}
          >
            {audit.score} - {b.word}
          </span>
        )}

        {/* recurring monitoring — the schedule that produces the trend series */}
        <label className="ml-auto flex shrink-0 items-center gap-1.5" title={scheduleTitle}>
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              schedule?.lastError ? 'bg-a-bad' : schedule?.active ? 'bg-a-ok' : 'bg-faint/40'
            }`}
          />
          <span className="text-eyebrow uppercase tracking-eyebrow text-faint">Auto</span>
          <select
            value={schedule?.cadence ?? 'manual-only'}
            disabled={savingSchedule || !projectId}
            onChange={(e) => void changeCadence(e.target.value as AuditCadence)}
            className="rounded-r2 border border-border bg-bg-raised px-1.5 py-1 text-caption text-dim outline-none focus:border-border-strong disabled:opacity-50"
          >
            <option value="manual-only">off</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
          </select>
        </label>

        <Button type="button" variant="soft" size="sm" onClick={doRun} disabled={busy || !projectId || !domain} className="shrink-0">
          <SyncIcon className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'running...' : 'Re-run'}
        </Button>
      </div>

      {/* body */}
      {loading ? (
        <div className="flex min-h-0 flex-1">
          <div className="w-[288px] shrink-0 space-y-2 border-r border-border p-4">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="v2skel h-8 rounded-r2" />
            ))}
          </div>
          <div className="flex-1 space-y-3 p-5">
            <div className="v2skel h-9 w-2/3 rounded-r2" />
            <div className="v2skel h-28 rounded-r4" />
            <div className="v2skel h-44 rounded-r4" />
          </div>
        </div>
      ) : !projectId ? (
        <div className="grid flex-1 place-items-center p-6">
          <p className="text-body text-faint">Select a project to run its technical audit.</p>
        </div>
      ) : !audit ? (
        <div className="grid flex-1 place-items-center p-6">
          <div className="max-w-[320px] rounded-r4 border border-border bg-bg-raised p-5 text-center">
            <p className="text-ui font-semibold text-text">No technical audit yet</p>
            <p className="mt-1 text-caption leading-relaxed text-faint">
              {domain ? `Nothing has been measured for ${domain}.` : 'This project has no domain set.'}
            </p>
            <Button type="button" variant="primary" size="md" onClick={doRun} disabled={busy || !domain} className="mt-3">
              {busy ? 'running...' : 'Run the first audit'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* rail: the metric ledger, nothing else */}
          <aside className="flex w-[288px] shrink-0 flex-col border-r border-border bg-bg-raised/30">
            <MetricLedger comparison={comparison} />
          </aside>

          {/* tabbed panels */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="audit-tabs shrink-0 border-b border-border px-3">
              {REPORT_SECTIONS.map((s) => {
                const t = tabTone(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setTab(s.id)}
                    className={`audit-tab ${tab === s.id ? 'is-on' : ''}`}
                  >
                    {s.label}
                    {t && (
                      <span
                        className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                          t === 'bad' ? 'bg-a-bad' : 'bg-a-warn'
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* run context — always visible from every tab, so cost / timing /
                freshness / the next scheduled run are never a scroll away */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 bg-bg-raised/40 px-4 py-1.5 text-caption text-faint">
              <span>{audit ? `audited ${rel(audit.createdAt)}` : 'never audited'}</span>
              {obs && typeof obs.totalLatencyMs === 'number' && (
                <span className="tabular-nums">ran in {fmtMs(obs.totalLatencyMs as number)}</span>
              )}
              {obs && typeof obs.totalCostUsd === 'number' && (
                <span className="tabular-nums">cost ${(obs.totalCostUsd as number).toFixed(4)}</span>
              )}
              {audit?.sitemapUrl && <span className="min-w-0 truncate">sitemap {audit.sitemapUrl}</span>}
              {schedule?.active && (
                <span className="ml-auto whitespace-nowrap tabular-nums text-a-ok">
                  next {schedule.cadence} run {until(schedule.nextRunAt)}
                </span>
              )}
              {schedule?.lastError && (
                <span className="ml-auto whitespace-nowrap text-a-bad">last scheduled run failed</span>
              )}
            </div>

            <div className="min-h-0 flex-1">
              {tab === 'overview' && <ReportOverview audit={audit} comparison={comparison} trend={trend} onTab={setTab} />}
              {tab === 'access' && <ReportAccess audit={audit} />}
              {tab === 'performance' && <ReportPerformance audit={audit} comparison={comparison} />}
              {tab === 'structure' && <ReportStructure audit={audit} />}
              {tab === 'pages' && <ReportPages audit={audit} comparison={comparison} />}
              {tab === 'agent' && <ReportAgent audit={audit} />}
              {tab === 'stack' && projectId && (
                <ReportStack projectId={projectId} domain={audit.targetUrl ?? domain} />
              )}
              {tab === 'analysis' && <ReportAnalysis audit={audit} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
