'use client';

/**
 * Analytics pane — SEO / Links / Technical / GEO tabs, the Google connector
 * cards (Analytics + Search Console), a signal table, and the on-page issues
 * list. Reads the latest technical audit, link graph, and measurement summary
 * for the active project.
 *
 * @module components/terminal/AnalyticsPane
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { cleanFindingText } from '@/lib/text';
import { getAudit, getMeasurementSummary, listAudits, listLinkGraphs, runAudit } from '@/lib/terminal-api';
import type { Integration, LinkGraph, TechnicalAudit } from '@/types/terminal';

type Tab = 'seo' | 'links' | 'technical' | 'geo';

const SEV_COLOR: Record<string, string> = {
  critical: 'text-red',
  high: 'text-red',
  medium: 'text-amber',
  low: 'text-amber',
  info: 'text-blue',
};

interface Summary {
  runs: number;
  observations: number;
  mentionRate: number;
  citationRate: number;
  shareOfVoice: Array<{ name: string; share: number }>;
}

export const analyticsMeta = { key: 'analytics' as const, title: 'Analytics', icon: '▤' };

export function AnalyticsPane({
  projectId,
  domain,
  integrations,
}: {
  projectId: string | null;
  domain: string | null;
  integrations: Integration[];
}) {
  const [tab, setTab] = useState<Tab>('seo');
  const [audit, setAudit] = useState<TechnicalAudit | null>(null);
  const [graphs, setGraphs] = useState<LinkGraph[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setNote(null);
    try {
      const audits = await listAudits(projectId);
      if (audits[0]) setAudit(await getAudit(projectId, audits[0].id));
      else setAudit(null);
    } catch {
      setAudit(null);
    }
    try {
      setGraphs(await listLinkGraphs(projectId));
    } catch {
      setGraphs([]);
    }
    try {
      setSummary(await getMeasurementSummary(projectId));
    } catch (err) {
      setSummary(null);
      if (err instanceof ApiError && err.status !== 404) setNote(err.message);
    }
  }, [projectId]);

  useEffect(() => {
    setAudit(null);
    setGraphs(null);
    setSummary(null);
    void load();
  }, [load]);

  const doRunAudit = async () => {
    if (!projectId || !domain) return;
    setBusy(true);
    setNote(null);
    try {
      const a = await runAudit(projectId, `https://${domain}`);
      setAudit(a);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'audit failed');
    } finally {
      setBusy(false);
    }
  };

  const ga = integrations.find((i) => i.key === 'google-analytics');
  const gsc = integrations.find((i) => i.key === 'google-search-console');
  const h1s = countH1(audit?.pageMetadata?.headings ?? null);

  return (
    <>
      {/* tabs */}
      <div className="flex border-b border-border text-[11px]">
        {(['seo', 'links', 'technical', 'geo'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-2 uppercase tracking-wide ${
              tab === t ? 'border-b-2 border-accent text-accent' : 'text-faint hover:text-dim'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Google connectors */}
      <div className="grid grid-cols-2 gap-2 border-b border-border p-2">
        <ConnectorCard name="Google Analytics" sub="Traffic & behavior" integ={ga} />
        <ConnectorCard name="Search Console" sub="Search rankings" integ={gsc} />
      </div>

      {!projectId ? (
        <p className="p-3 text-faint">select a project</p>
      ) : (
        <div className="p-3">
          {tab === 'seo' && (
            <>
              <SignalTable
                rows={[
                  metaTitleRow(audit?.pageMetadata?.title ?? null),
                  metaDescRow(audit?.pageMetadata?.metaDescription ?? null),
                  { label: 'H1 tags', value: h1s === null ? '—' : String(h1s), warn: (h1s ?? 0) > 1 },
                  {
                    label: 'On-page checks',
                    value: audit ? `${countStatus(audit, 'fail')} fail · ${countStatus(audit, 'warn')} warn` : '—',
                    warn: audit ? countStatus(audit, 'fail') + countStatus(audit, 'warn') > 0 : false,
                  },
                ]}
              />
              <Issues audit={audit} onRun={doRunAudit} busy={busy} />
            </>
          )}

          {tab === 'links' && <LinksTab graph={graphs?.find((g) => g.status === 'complete') ?? null} loading={graphs === null} />}

          {tab === 'technical' && (
            <>
              <SignalTable
                rows={[
                  { label: 'Audit runs', value: audit ? '1+' : '0', warn: !audit },
                  { label: 'Access blockers', value: audit ? String(countType(audit, ['robots', 'cdn'])) : '—', warn: audit ? countType(audit, ['robots', 'cdn']) > 0 : false },
                  { label: 'JS render risk', value: audit ? String(countType(audit, ['js'])) : '—', warn: audit ? countType(audit, ['js']) > 0 : false },
                  { label: 'CWV', value: audit ? String(countType(audit, ['cwv', 'lcp', 'cls', 'inp'])) : '—' },
                ]}
              />
              <Issues audit={audit} onRun={doRunAudit} busy={busy} filter={(f) => /robots|cdn|js|cwv|render|lcp|cls|inp/i.test(f.type)} />
            </>
          )}

          {tab === 'geo' && <GeoTab summary={summary} />}

          {note && <p className="mt-2 text-[11px] text-amber">{note}</p>}
        </div>
      )}
    </>
  );
}

/* ── connector card ──────────────────────────────────────────── */
function ConnectorCard({ name, sub, integ }: { name: string; sub: string; integ?: Integration }) {
  const connected = integ?.connected ?? false;
  return (
    <div className="rounded-md border border-border bg-bg-inset p-2">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-accent' : 'bg-faint'}`} />
        <span className="text-[11px] font-semibold text-dim">{name}</span>
      </div>
      <p className="mt-0.5 text-[10px] text-faint">{sub}</p>
      <div className="mt-1.5 h-8 rounded bg-bg-raised" aria-hidden />
      <button
        disabled={connected}
        title={integ?.detail ?? ''}
        className={`mt-1.5 w-full rounded border px-2 py-1 text-[10px] ${
          connected
            ? 'border-accent-dim text-accent'
            : 'border-border text-dim hover:border-border-strong'
        }`}
      >
        {connected ? 'Connected' : 'Connect'}
      </button>
      {!connected && <p className="mt-1 text-[9px] leading-tight text-faint">{integ?.configHint}</p>}
    </div>
  );
}

/* ── signal table ───────────────────────────────────────────── */
function SignalTable({ rows }: { rows: Array<{ label: string; value: string; warn?: boolean }> }) {
  return (
    <table className="mb-3 w-full text-[12px]">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-b border-border/50">
            <td className="py-1.5 text-faint">
              {r.warn && <span className="mr-1 text-amber">⚠</span>}
              {r.label}
            </td>
            <td className={`py-1.5 text-right ${r.warn ? 'text-amber' : 'text-dim'}`}>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── issues list ────────────────────────────────────────────── */
function Issues({
  audit,
  onRun,
  busy,
  filter,
}: {
  audit: TechnicalAudit | null;
  onRun: () => void;
  busy: boolean;
  filter?: (f: TechnicalAudit['findings'][number]) => boolean;
}) {
  const all = (audit?.findings ?? []).filter((f) => f.status !== 'pass').filter((f) => (filter ? filter(f) : true));
  const findings = all.filter((f) => f.status !== 'error');
  const errored = all.filter((f) => f.status === 'error');
  const crit = findings.filter((f) => f.status === 'fail').length;
  const warn = findings.filter((f) => f.status === 'warn').length;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-faint">Issues</span>
        <span className="text-[11px] text-faint">
          {audit ? (
            <>
              <span className="text-red">✕{crit}</span> <span className="text-amber">⚠{warn}</span>
            </>
          ) : (
            <button onClick={onRun} disabled={busy} className="rounded border border-border px-1.5 py-0.5 text-dim hover:border-border-strong disabled:opacity-50">
              {busy ? 'running…' : 'run audit'}
            </button>
          )}
        </span>
      </div>
      {audit && all.length === 0 && <p className="text-[12px] text-faint">no issues on this tab.</p>}
      <ul className="space-y-1">
        {findings.slice(0, 12).map((f) => (
          <li key={f.id} className="rounded border border-border/60 bg-bg-inset px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] text-dim">{cleanFindingText(f.detail) || f.type}</span>
              <span className={`shrink-0 text-[10px] uppercase ${f.status === 'fail' ? 'text-red' : SEV_COLOR[f.severity] ?? 'text-amber'}`}>
                {f.status === 'fail' ? 'critical' : f.severity}
              </span>
            </div>
            {f.recommendedFix && <p className="mt-0.5 text-[11px] text-faint">fix: {cleanFindingText(f.recommendedFix)}</p>}
          </li>
        ))}
        {errored.slice(0, 6).map((f) => (
          <li key={f.id} className="rounded border border-border/60 bg-bg-inset px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] text-faint">{f.type} check couldn’t run</span>
              <span className="shrink-0 text-[10px] uppercase text-faint">no result</span>
            </div>
            <p className="mt-0.5 text-[11px] text-faint">{cleanFindingText(f.detail, 140)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── links tab ──────────────────────────────────────────────── */
function LinksTab({ graph, loading }: { graph: LinkGraph | null; loading: boolean }) {
  if (loading) return <p className="text-faint">loading…</p>;
  if (!graph)
    return <p className="text-[12px] text-faint">No internal-link analysis yet. The SEO Agent can build the graph from this project&apos;s domain.</p>;
  return (
    <SignalTable
      rows={[
        { label: 'Pages crawled', value: String(graph.pagesCrawled) },
        { label: 'Internal links', value: String(graph.edgeCount) },
        { label: 'Orphan pages', value: String(graph.orphanCount), warn: graph.orphanCount > 0 },
        { label: 'Link recommendations', value: String(graph.recommendationCount), warn: graph.recommendationCount > 0 },
      ]}
    />
  );
}

/* ── geo tab ────────────────────────────────────────────────── */
function GeoTab({ summary }: { summary: Summary | null }) {
  if (!summary || summary.observations === 0)
    return <p className="text-[12px] text-faint">No AI-visibility measurement yet. The GEO Agent measures mention &amp; citation rates across AI answers.</p>;
  return (
    <>
      <SignalTable
        rows={[
          { label: 'Observations', value: String(summary.observations) },
          { label: 'Mention rate', value: `${Math.round(summary.mentionRate * 100)}%`, warn: summary.mentionRate < 0.5 },
          { label: 'Citation rate', value: `${Math.round(summary.citationRate * 100)}%`, warn: summary.citationRate < 0.35 },
        ]}
      />
      <p className="mb-1 text-[11px] uppercase tracking-widest text-faint">Share of voice</p>
      <ul className="space-y-1">
        {summary.shareOfVoice.slice(0, 6).map((s) => (
          <li key={s.name} className="flex items-center gap-2 text-[12px]">
            <span className="w-28 shrink-0 truncate text-dim">{s.name}</span>
            <span className="h-2 flex-1 overflow-hidden rounded bg-bg-inset">
              <span className="block h-full bg-accent-dim" style={{ width: `${Math.round(s.share * 100)}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right text-faint">{Math.round(s.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/* ── helpers ────────────────────────────────────────────────── */
function metaTitleRow(title: string | null) {
  const n = title?.length ?? 0;
  return { label: 'Meta title', value: title ? `${n} chars` : '—', warn: n > 60 || n === 0 };
}
function metaDescRow(desc: string | null) {
  const n = desc?.length ?? 0;
  return { label: 'Meta description', value: desc ? `${n} chars` : '—', warn: n > 160 || n === 0 };
}
function countH1(headingsJson: string | null): number | null {
  if (!headingsJson) return null;
  try {
    const h = JSON.parse(headingsJson) as Array<{ level?: number; tag?: string }>;
    return h.filter((x) => x.level === 1 || x.tag === 'h1').length;
  } catch {
    return null;
  }
}
function countStatus(audit: TechnicalAudit, status: string): number {
  return audit.findings.filter((f) => f.status === status).length;
}
function countType(audit: TechnicalAudit, needles: string[]): number {
  return audit.findings.filter((f) => f.status !== 'pass' && needles.some((n) => f.type.toLowerCase().includes(n))).length;
}
