'use client';

/**
 * Analytics — /v2. A chrome-less card between the Flywheel and the Agents Feed:
 * SEO / Links / Technical / GEO tabs, the two Google connector cards, a signal
 * table and the issues list. Pinned header + tabs with a sliding indicator; the
 * body flexes to the canvas and scrolls invisibly when a tab runs long.
 *
 * Live data: the newest technical audit, the newest complete link graph, and
 * the measurement summary for the active project. "Re-run" runs a fresh audit.
 *
 * @module app/v2/_components/Analytics
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { cleanFindingText } from '@/lib/text';
import { getAudit, getMeasurementSummary, listAudits, listLinkGraphs, runAudit } from '@/lib/terminal-api';
import type { AuditFinding, Integration, LinkGraph, TechnicalAudit } from '@/types/terminal';
import { BarIcon, SyncIcon } from './icons';

type Tab = 'seo' | 'links' | 'technical' | 'geo';
type Row = { label: string; value: string; warn?: boolean };

const TABS: Tab[] = ['seo', 'links', 'technical', 'geo'];

interface Summary {
  runs: number;
  observations: number;
  mentionRate: number;
  citationRate: number;
  shareOfVoice: Array<{ name: string; share: number }>;
}

/* the technical tab only shows findings about crawl access / render / vitals */
const TECH_RE = /robots|cdn|js|cwv|render|lcp|cls|inp/i;

/* muted dashed line — "no data yet" stand-in for the connector chart */
function GhostSpark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 20" className={className} preserveAspectRatio="none" fill="none" aria-hidden>
      <polyline
        points="0,14 12,9 24,12 36,5 48,11 60,7 72,13 80,10"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2 3"
      />
    </svg>
  );
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between">
      <span className="text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">{children}</span>
      {right}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-4 text-body leading-relaxed text-faint">{children}</p>;
}

/* ── tab content ─────────────────────────────────────────────────────── */
function SignalTable({ rows }: { rows: Row[] }) {
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center justify-between rounded-r2 px-2.5 py-2">
          <span className="flex items-center gap-2 text-body text-dim">
            <span className={`h-1.5 w-1.5 rounded-full ${r.warn ? 'bg-warn' : 'bg-accent'}`} />
            {r.label}
          </span>
          <span className={`text-body font-semibold tabular-nums ${r.warn ? 'text-warn' : 'text-text'}`}>{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

function ConnectorCard({
  name,
  sub,
  integ,
  onConnect,
}: {
  name: string;
  sub: string;
  integ: Integration | undefined;
  onConnect: () => void;
}) {
  const connected = integ?.connected ?? false;
  return (
    <div className="rounded-r3 border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-accent' : 'bg-faint'}`} />
        <span className="truncate text-caption font-semibold text-dim">{name}</span>
      </div>
      <p className="mt-0.5 text-eyebrow text-faint">{sub}</p>
      <div className="mt-1.5 h-6 overflow-hidden rounded-md px-1">
        <GhostSpark className="h-full w-full" />
      </div>
      <button
        disabled={connected}
        onClick={onConnect}
        title={integ?.detail ?? ''}
        className={`mt-1.5 w-full truncate rounded-md border px-2 py-1 text-eyebrow font-medium transition-colors ${
          connected ? 'border-accent-dim text-accent' : 'border-border text-dim hover:border-border-strong hover:text-text'
        }`}
      >
        {connected ? 'Connected' : `Connect · ${integ?.configHint ?? 'OAuth'}`}
      </button>
    </div>
  );
}

function Issues({
  findings,
  audit,
  onRun,
  busy,
}: {
  findings: AuditFinding[];
  audit: TechnicalAudit | null;
  onRun: () => void;
  busy: boolean;
}) {
  const live = findings.filter((f) => f.status !== 'error');
  const errored = findings.filter((f) => f.status === 'error');
  const crit = live.filter((f) => f.status === 'fail').length;
  const warn = live.filter((f) => f.status === 'warn').length;

  if (!audit) {
    return (
      <div className="mt-3">
        <SectionLabel>Issues</SectionLabel>
        <p className="text-body leading-relaxed text-faint">
          No audit has been run for this project yet.
        </p>
        <button
          onClick={onRun}
          disabled={busy}
          className="mt-2 rounded-md border border-accent-dim px-2 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent-dim/15 disabled:opacity-50"
        >
          {busy ? 'running…' : 'Run the first audit'}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <SectionLabel
        right={
          <span className="flex items-center gap-1.5 text-eyebrow font-semibold tabular-nums">
            <span className="text-danger">✕ {crit}</span>
            <span className="text-warn">⚠ {warn}</span>
          </span>
        }
      >
        Issues
      </SectionLabel>

      {live.length === 0 && errored.length === 0 && (
        <p className="text-body text-faint">Clean on this tab.</p>
      )}

      <ul className="space-y-1">
        {live.slice(0, 12).map((f) => {
          const critical = f.status === 'fail';
          return (
            <li
              key={f.id}
              className="flex gap-2 overflow-hidden rounded-r2 border border-border/60 py-1.5 pr-2 transition-colors hover:border-border-strong"
            >
              <span className={`w-[3px] shrink-0 rounded-full ${critical ? 'bg-danger' : 'bg-warn'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-body font-medium text-dim">
                    {cleanFindingText(f.detail) || f.type}
                  </span>
                  <span
                    className={`shrink-0 text-eyebrow font-semibold uppercase tracking-wide2 ${critical ? 'text-danger' : 'text-warn'}`}
                  >
                    {critical ? 'critical' : f.severity}
                  </span>
                </div>
                {f.recommendedFix && (
                  <p className="mt-0.5 text-caption leading-tight text-faint">fix: {cleanFindingText(f.recommendedFix)}</p>
                )}
              </div>
            </li>
          );
        })}
        {errored.slice(0, 4).map((f) => (
          <li key={f.id} className="flex gap-2 overflow-hidden rounded-r2 border border-border/60 py-1.5 pr-2">
            <span className="w-[3px] shrink-0 rounded-full bg-faint" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-body font-medium text-faint">{f.type} check couldn&rsquo;t run</span>
                <span className="shrink-0 text-eyebrow font-semibold uppercase tracking-wide2 text-faint">no result</span>
              </div>
              <p className="mt-0.5 text-caption leading-tight text-faint">{cleanFindingText(f.detail, 120)}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GeoTab({ summary, domain }: { summary: Summary | null; domain: string | null }) {
  if (!summary || summary.observations === 0) {
    return (
      <Hint>
        No AI-visibility measurement yet. The GEO agent measures mention &amp; citation rates across AI answers —
        run it to populate this tab.
      </Hint>
    );
  }

  const sov = summary.shareOfVoice.slice(0, 6);
  const max = Math.max(...sov.map((s) => s.share), 0.0001);
  const ownedIdx = sov.findIndex((s) => domain !== null && s.name.toLowerCase().includes(domain.split('.')[0].toLowerCase()));

  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          { label: 'Obs', value: String(summary.observations), warn: false },
          { label: 'Mention', value: `${Math.round(summary.mentionRate * 100)}%`, warn: summary.mentionRate < 0.5 },
          { label: 'Citation', value: `${Math.round(summary.citationRate * 100)}%`, warn: summary.citationRate < 0.35 },
        ].map((t) => (
          <div key={t.label} className="rounded-r3 border border-border/70 px-1 py-2.5 text-center">
            <div className={`num font-display text-display font-medium ${t.warn ? 'text-warn' : 'text-text'}`}>
              {t.value}
            </div>
            <div className="mt-1 text-eyebrow uppercase text-faint">{t.label}</div>
          </div>
        ))}
      </div>

      {sov.length > 0 && (
        <div className="mt-3">
          <SectionLabel
            right={
              ownedIdx >= 0 ? (
                <span className={`num text-eyebrow ${ownedIdx === 0 ? 'text-ok' : 'text-warn'}`}>
                  rank {String(ownedIdx + 1).padStart(2, '0')} / {String(sov.length).padStart(2, '0')}
                </span>
              ) : undefined
            }
          >
            Share of voice
          </SectionLabel>
          {/* ranked, and marked the way rothenhall.com numbers its disciplines
              — rank is a genuine sequence, so the numeral carries information */}
          <ul className="v2-stagger space-y-1.5">
            {sov.map((s, i) => {
              const owned = i === ownedIdx;
              return (
                <li
                  key={s.name}
                  style={{ ['--i' as string]: i }}
                  className="flex items-center gap-2 text-body"
                >
                  <span className={`v2-rank w-4 shrink-0 ${owned ? 'v2-rank-lead' : ''}`}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className={`w-14 shrink-0 truncate ${owned ? 'font-semibold text-accent' : 'text-dim'}`}>
                    {s.name}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                    <span
                      className={`block h-full rounded-full transition-[width] duration-morph ease-brand ${owned ? 'bg-accent' : 'bg-accent-dim/55'}`}
                      style={{ width: `${Math.round((s.share / max) * 100)}%` }}
                    />
                  </span>
                  <span className="num w-7 shrink-0 text-right text-faint">{Math.round(s.share * 100)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */
function countH1(headingsJson: string | null): number | null {
  if (!headingsJson) return null;
  try {
    const h = JSON.parse(headingsJson) as Array<{ level?: number; tag?: string }>;
    return h.filter((x) => x.level === 1 || x.tag === 'h1').length;
  } catch {
    return null;
  }
}
function rel(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ── card ────────────────────────────────────────────────────────────── */
export function Analytics({
  projectId,
  domain,
  integrations,
  booting,
  onOpenConnections,
  onNotify,
}: {
  projectId: string | null;
  domain: string | null;
  integrations: Integration[];
  /** the console's first fan-out has not settled — show skeletons, not "no data" */
  booting: boolean;
  onOpenConnections: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const [tab, setTab] = useState<Tab>('seo');
  const [audit, setAudit] = useState<TechnicalAudit | null>(null);
  const [graphs, setGraphs] = useState<LinkGraph[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const audits = await listAudits(projectId);
      setAudit(audits[0] ? await getAudit(projectId, audits[0].id) : null);
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
      if (err instanceof ApiError && err.status !== 404) onNotify(err.message, 'warn');
    }
    setLoading(false);
  }, [projectId, onNotify]);

  useEffect(() => {
    setAudit(null);
    setGraphs(null);
    setSummary(null);
    void load();
  }, [load]);

  const doRunAudit = async () => {
    if (!projectId || !domain || busy) return;
    setBusy(true);
    try {
      setAudit(await runAudit(projectId, `https://${domain}`));
      onNotify('audit complete');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'audit failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  /* ── derived ───────────────────────────────────────────────────────── */
  const findings = audit?.findings ?? [];
  const open = findings.filter((f) => f.status !== 'pass');
  const seoIssues = open.filter((f) => !TECH_RE.test(f.type));
  const techIssues = open.filter((f) => TECH_RE.test(f.type));
  const graph = graphs?.find((g) => g.status === 'complete') ?? null;

  const title = audit?.pageMetadata?.title ?? null;
  const desc = audit?.pageMetadata?.metaDescription ?? null;
  const h1s = countH1(audit?.pageMetadata?.headings ?? null);
  const fails = findings.filter((f) => f.status === 'fail').length;
  const warns = findings.filter((f) => f.status === 'warn').length;

  /* count within the tab's own scope — a site-wide total sitting above a
     filtered list read as a contradiction ("1 fail" then "Clean on this tab") */
  const tally = (fs: AuditFinding[]) => ({
    fail: fs.filter((f) => f.status === 'fail').length,
    warn: fs.filter((f) => f.status === 'warn').length,
  });
  const seoTally = tally(seoIssues);
  const techTally = tally(techIssues);

  const seoRows: Row[] = [
    { label: 'Meta title', value: title ? `${title.length} chars` : '—', warn: (title?.length ?? 0) > 60 || !title },
    { label: 'Meta description', value: desc ? `${desc.length} chars` : '—', warn: (desc?.length ?? 0) > 160 || !desc },
    { label: 'H1 tags', value: h1s === null ? '—' : String(h1s), warn: (h1s ?? 0) !== 1 },
    {
      label: 'On-page checks',
      value: audit ? `${seoTally.fail} fail · ${seoTally.warn} warn` : '—',
      warn: seoTally.fail + seoTally.warn > 0,
    },
  ];
  const linkRows: Row[] = graph
    ? [
        { label: 'Pages crawled', value: String(graph.pagesCrawled) },
        { label: 'Internal links', value: String(graph.edgeCount) },
        { label: 'Orphan pages', value: String(graph.orphanCount), warn: graph.orphanCount > 0 },
        { label: 'Link recommendations', value: String(graph.recommendationCount), warn: graph.recommendationCount > 0 },
      ]
    : [];
  const techRows: Row[] = [
    {
      label: 'Technical checks',
      value: audit ? `${techTally.fail} fail · ${techTally.warn} warn` : '—',
      warn: techTally.fail + techTally.warn > 0,
    },
    {
      label: 'Access blockers',
      value: audit ? String(open.filter((f) => /robots|cdn/i.test(f.type)).length) : '—',
      warn: open.some((f) => /robots|cdn/i.test(f.type)),
    },
    {
      label: 'JS render risk',
      value: audit ? String(open.filter((f) => /js|render/i.test(f.type)).length) : '—',
      warn: open.some((f) => /js|render/i.test(f.type)),
    },
    {
      label: 'CWV flags',
      value: audit ? String(open.filter((f) => /cwv|lcp|cls|inp/i.test(f.type)).length) : '—',
      warn: open.some((f) => /cwv|lcp|cls|inp/i.test(f.type)),
    },
  ];

  const tabCount: Record<Tab, number> = {
    seo: seoIssues.length,
    links: graph ? graph.orphanCount + graph.recommendationCount : 0,
    technical: techIssues.length,
    geo: summary && summary.observations === 0 ? 1 : 0,
  };

  const health: { label: string; tone: string; note: string } = !audit
    ? { label: 'Not measured', tone: 'bg-faint/15 text-faint', note: 'run an audit to populate this card' }
    : fails > 0
      ? { label: 'Needs work', tone: 'bg-warn/15 text-warn', note: `${open.length} open issue${open.length === 1 ? '' : 's'} · SEO & technical` }
      : warns > 0
        ? { label: 'Minor issues', tone: 'bg-warn/15 text-warn', note: `${warns} warning${warns === 1 ? '' : 's'}` }
        : { label: 'Healthy', tone: 'bg-accent/15 text-accent', note: 'no open findings' };

  const idx = TABS.indexOf(tab);
  const skeleton = booting || (loading && !audit && !graphs && !summary);

  return (
    <div className="pointer-events-auto flex max-h-full w-full max-w-[320px] flex-col overflow-hidden rounded-r4 bg-bg-raised/25 backdrop-blur-[1.5px]">
      {/* header — pinned */}
      <div className="shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-r2 bg-accent text-bg-raised">
            <BarIcon className="h-4 w-4" />
          </span>
          <span className="text-ui font-semibold tracking-tight2 text-text">Analytics</span>
          <span className="ml-auto truncate text-caption text-faint">{domain ?? '—'}</span>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-eyebrow uppercase ${health.tone}`}>
            {health.label}
          </span>
          <span className="truncate text-caption text-faint">{health.note}</span>
        </div>
      </div>

      {/* tabs — pinned, sliding indicator */}
      <div className="relative flex shrink-0 border-y border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex flex-1 items-center justify-center gap-1 py-2.5 text-caption font-semibold uppercase tracking-wide2 transition-colors ${
              tab === t ? 'text-accent' : 'text-faint hover:text-dim'
            }`}
          >
            {t}
            {tabCount[t] > 0 && (
              <span
                className={`rounded-full px-1 text-caption font-semibold tabular-nums transition-colors ${
                  tab === t ? 'bg-accent text-bg-raised' : 'bg-warn/20 text-warn'
                }`}
              >
                {tabCount[t]}
              </span>
            )}
          </button>
        ))}
        <span
          className="pointer-events-none absolute -bottom-px h-0.5 rounded-full bg-accent transition-[left] duration-state ease-brand"
          style={{ left: `${idx * 25}%`, width: '25%' }}
        />
      </div>

      {/* connectors — pinned */}
      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-border p-3">
        <ConnectorCard
          name="Google Analytics"
          sub="Traffic & behavior"
          integ={integrations.find((i) => i.key === 'google-analytics')}
          onConnect={onOpenConnections}
        />
        <ConnectorCard
          name="Search Console"
          sub="Search rankings"
          integ={integrations.find((i) => i.key === 'google-search-console')}
          onConnect={onOpenConnections}
        />
      </div>

      {/* body — flexes to the canvas height; cross-fades on tab change and
          scrolls (scrollbar hidden) only when a tab is taller than the canvas */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        {skeleton ? (
          <div className="space-y-1.5 p-3">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="v2skel h-7 rounded-r2" />
            ))}
          </div>
        ) : !projectId ? (
          <div className="p-3">
            <Hint>Select a project to see its diagnostics.</Hint>
          </div>
        ) : (
          <div key={tab} className="v2tab-in p-3">
            {tab === 'seo' && (
              <>
                <SignalTable rows={seoRows} />
                <Issues findings={seoIssues} audit={audit} onRun={doRunAudit} busy={busy} />
              </>
            )}
            {tab === 'links' &&
              (graph ? (
                <SignalTable rows={linkRows} />
              ) : (
                <Hint>
                  No internal-link analysis yet. The SEO agent builds the graph from this project&rsquo;s domain.
                </Hint>
              ))}
            {tab === 'technical' && (
              <>
                <SignalTable rows={techRows} />
                <Issues findings={techIssues} audit={audit} onRun={doRunAudit} busy={busy} />
              </>
            )}
            {tab === 'geo' && <GeoTab summary={summary} domain={domain} />}
          </div>
        )}
      </div>

      {/* footer — sync state */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-3.5 py-2 text-caption">
        <span className="truncate text-faint">
          {audit ? `audited ${rel(audit.createdAt)}` : 'never audited'}
        </span>
        <button
          onClick={doRunAudit}
          disabled={busy || !projectId || !domain}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-dim transition-colors hover:bg-bg-inset hover:text-accent disabled:opacity-40"
        >
          <SyncIcon className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'running…' : 'Re-run'}
        </button>
      </div>
    </div>
  );
}
