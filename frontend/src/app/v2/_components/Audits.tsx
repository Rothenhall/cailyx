'use client';

/**
 * Audits — /v2. A chrome-less card between the Flywheel and the Agents Feed.
 *
 * The four disciplines the market actually names — SEO, AEO, Technical, GEO —
 * open as a 2×2 grid of tiles rather than a tab strip. At 320px a four-up strip
 * had no room for a name, a count and a state at once, so the counts read as
 * noise; a tile carries all three. Tapping one shows that discipline's stats,
 * which is the same grid→detail move the agent roster makes.
 *
 * Internal links fold under Technical, where crawl concerns belong, rather
 * than holding a discipline slot of their own.
 *
 * Live data: the newest technical audit, the newest complete link graph, and
 * the measurement summary for the active project. "Re-run" runs a fresh audit.
 *
 * @module app/v2/_components/Audits
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { cleanFindingText } from '@/lib/text';
import { getAudit, getMeasurementSummary, listAudits, listLinkGraphs, runAudit } from '@/lib/terminal-api';
import type { AuditFinding, LinkGraph, TechnicalAudit } from '@/types/terminal';
import { band, tone as toneOf, type ToneKind } from '@/app/v2/_lib/audit';
import { Gauge, Pill } from './TechnicalAuditReport';
import { BarIcon, ChevronLeft, SyncIcon } from './icons';
import { Button } from './Button';

type Tab = 'seo' | 'aeo' | 'technical' | 'geo';
type Row = { label: string; value: string; warn?: boolean };

/* Technical leads deliberately: it is the audit that actually runs, and the
   findings it produces are what SEO and AEO then read. Ordering it first makes
   the card's entry point the thing you press. */
const TABS: Tab[] = ['technical', 'seo', 'aeo', 'geo'];

interface Summary {
  runs: number;
  observations: number;
  mentionRate: number;
  citationRate: number;
  shareOfVoice: Array<{ name: string; share: number }>;
}

/* Findings are routed to a discipline by type. These are the types the audit
   actually emits (robots · cdn-inferred · js-render · cwv · schema), plus the
   ones the finding-title map knows about (entity-clarity · sitemap · canonical).
   Anything unmatched falls to SEO, which is the on-page catch-all. */
const TECH_RE = /robots|cdn|js|cwv|render|lcp|cls|inp/i;
const AEO_RE = /schema|entity|faq|answer|structured|markup/i;

/** the four disciplines, as the market names them */
const TAB_META: Record<Tab, { label: string; blurb: string }> = {
  seo: { label: 'SEO', blurb: 'On-page' },
  aeo: { label: 'AEO', blurb: 'Answer-ready' },
  technical: { label: 'Technical', blurb: 'Site audit' },
  geo: { label: 'GEO', blurb: 'AI visibility' },
};

/* muted dashed line — "no data yet" stand-in for the connector chart */
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
    <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center justify-between gap-2 px-2.5 py-2">
          <span className="flex items-center gap-2 text-body text-dim">
            <span className={`h-1.5 w-1.5 rounded-full ${r.warn ? 'bg-a-warn' : 'bg-a-ok'}`} />
            {r.label}
          </span>
          <span className={`text-body font-semibold tabular-nums ${r.warn ? 'text-a-warn' : 'text-text'}`}>
            {r.value}
          </span>
        </li>
      ))}
    </ul>
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
          className="mt-2 rounded-r2 border border-accent-dim px-2 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent-dim/14 disabled:opacity-50"
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
            <span className="text-a-bad">✕ {crit}</span>
            <span className="text-a-warn">⚠ {warn}</span>
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
              <span className={`w-[3px] shrink-0 rounded-full ${critical ? 'bg-a-bad' : 'bg-a-warn'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-body font-medium text-dim">
                    {cleanFindingText(f.detail) || f.type}
                  </span>
                  <span
                    className={`shrink-0 text-eyebrow font-semibold uppercase tracking-wide2 ${critical ? 'text-a-bad' : 'text-a-warn'}`}
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
          <div key={t.label} className="rounded-r3 border border-border/60 px-1 py-2.5 text-center">
            <div className={`num font-display text-display font-medium ${t.warn ? 'text-a-warn' : 'text-text'}`}>
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
                <span className={`num text-eyebrow ${ownedIdx === 0 ? 'text-a-ok' : 'text-a-warn'}`}>
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
                      className={`block h-full rounded-full transition-[width] duration-morph ease-brand ${owned ? 'bg-accent' : 'bg-accent-dim/65'}`}
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
export function Audits({
  projectId,
  domain,
  booting,
  onNotify,
  onExpand,
}: {
  projectId: string | null;
  domain: string | null;
  /** the console's first fan-out has not settled — show skeletons, not "no data" */
  booting: boolean;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
  /**
   * Open a discipline in the full-canvas workspace instead of in-card. Only
   * Technical uses it — it is the one view that does not fit 320px. When it is
   * not supplied (or the tile is not Technical) the tile opens in place.
   */
  onExpand?: (tab: Tab) => void;
}) {
  /* null = the four tiles; a value = that discipline's stats */
  const [tab, setTab] = useState<Tab | null>(null);
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
      // No target URL — the backend audits the project's own domain, so the
      // operator never retypes it and a project rename cannot desync them.
      setAudit(await runAudit(projectId));
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
  const aeoIssues = open.filter((f) => AEO_RE.test(f.type));
  const techIssues = open.filter((f) => TECH_RE.test(f.type) && !AEO_RE.test(f.type));
  const seoIssues = open.filter((f) => !TECH_RE.test(f.type) && !AEO_RE.test(f.type));
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
  /* AEO reads answer-extractability: is there structured data, and is the
     entity described clearly enough to be quoted? Both come from audit
     findings the crawler already emits (`schema`, `entity-clarity`). */
  const schemaFindings = open.filter((f) => /schema|structured|markup/i.test(f.type));
  const entityFindings = open.filter((f) => /entity/i.test(f.type));
  const aeoRows: Row[] = [
    {
      label: 'Structured data',
      value: audit ? (schemaFindings.length ? `${schemaFindings.length} to fix` : 'ok') : '—',
      warn: schemaFindings.length > 0,
    },
    {
      label: 'Entity clarity',
      value: audit ? (entityFindings.length ? `${entityFindings.length} to fix` : 'ok') : '—',
      warn: entityFindings.length > 0,
    },
    {
      label: 'Answer-ready checks',
      value: audit ? `${aeoIssues.length} open` : '—',
      warn: aeoIssues.length > 0,
    },
  ];

  const tabCount: Record<Tab, number> = {
    seo: seoIssues.length,
    aeo: aeoIssues.length,
    technical: techIssues.length + (graph ? graph.orphanCount + graph.recommendationCount : 0),
    geo: summary && summary.observations === 0 ? 1 : 0,
  };

  const health: { label: string; kind: ToneKind; note: string } = !audit
    ? { label: 'Not measured', kind: 'neutral', note: 'run an audit to populate this card' }
    : fails > 0
      ? {
          label: 'Needs work',
          kind: 'bad',
          note: `${open.length} open issue${open.length === 1 ? '' : 's'} · SEO & technical`,
        }
      : warns > 0
        ? { label: 'Minor issues', kind: 'warn', note: `${warns} warning${warns === 1 ? '' : 's'}` }
        : { label: 'Healthy', kind: 'ok', note: 'no open findings' };

  const skeleton = booting || (loading && !audit && !graphs && !summary);

  return (
    <div className="pointer-events-auto flex max-h-full w-full max-w-[320px] flex-col overflow-hidden rounded-r4 bg-bg-raised/25 backdrop-blur-[1.5px]">
      {/* header — pinned */}
      <div className="shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-r2 bg-accent text-bg-raised">
            <BarIcon className="h-4 w-4" />
          </span>
          <span className="font-display text-ui font-semibold tracking-tight2 text-text">Audits</span>
          <span className="ml-auto truncate font-display text-caption text-faint">{domain ?? '—'}</span>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <span className="shrink-0">
            <Pill t={toneOf(health.kind)}>{health.label}</Pill>
          </span>
          <span className="truncate text-caption text-faint">{health.note}</span>
        </div>
      </div>

      {/* discipline strip — a back control once a tile is open */}
      {tab && (
        <div className="flex shrink-0 items-center gap-2 border-y border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setTab(null)}
            aria-label="Back to disciplines"
            className="rounded-full bg-bg-inset text-dim"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="font-display text-body font-semibold text-text">{TAB_META[tab].label}</span>
          <span className="truncate text-caption text-faint">{TAB_META[tab].blurb}</span>
          {tabCount[tab] > 0 && (
            <span className="num ml-auto shrink-0 rounded-full border border-a-warn-line bg-a-warn-soft px-1.5 text-eyebrow text-a-warn">
              {tabCount[tab]}
            </span>
          )}
        </div>
      )}

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
        ) : tab === null ? (
          /* ── the four audits, stacked ────────────────────────────────
             One column, not a 2x2 grid. Reading order and severity order are
             the same thing here — Technical first, because it is the audit
             that actually runs and the findings it produces are what the
             other three read — and a single column makes that order
             unambiguous. It also gives each row the full 320px, so the name,
             the discipline and the count all fit on one line instead of
             being squeezed into a square. */
          <div className="v2-stagger flex flex-col gap-2 p-3">
            {TABS.map((t, i) => {
              const n = tabCount[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => (t === 'technical' && onExpand ? onExpand(t) : setTab(t))}
                  style={{ ['--i' as string]: i }}
                  className={`relative flex w-full items-center gap-3 rounded-r3 border bg-bg-raised px-3 py-2.5 text-left transition-colors duration-micro hover:border-accent-dim ${
                    n > 0 ? 'border-border-strong' : 'border-border'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-display text-title font-semibold text-text">
                        {TAB_META[t].label}
                      </span>
                      {n > 0 && <span className="v2-dot v2-dot-attention shrink-0" />}
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-faint">
                      {TAB_META[t].blurb}
                    </span>
                  </span>
                  <span
                    className={`num shrink-0 text-body font-medium tabular-nums ${
                      n > 0 ? 'text-a-warn' : 'text-faint'
                    }`}
                  >
                    {n > 0 ? `${n} to review` : 'clear'}
                  </span>
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0 rotate-180 text-faint" />
                </button>
              );
            })}
          </div>
        ) : (
          <div key={tab} className="v2tab-in p-3">
            {tab === 'seo' && (
              <>
                <SignalTable rows={seoRows} />
                <Issues findings={seoIssues} audit={audit} onRun={doRunAudit} busy={busy} />
              </>
            )}
            {tab === 'aeo' && (
              <>
                <SignalTable rows={aeoRows} />
                <Issues findings={aeoIssues} audit={audit} onRun={doRunAudit} busy={busy} />
              </>
            )}
            {tab === 'technical' &&
              (!audit ? (
                <Issues findings={[]} audit={null} onRun={doRunAudit} busy={busy} />
              ) : (
                /* A teaser only — the full run lives in the takeover report
                   (tapping the Technical tile opens it). This keeps the card
                   in sync with that report's visual language without trying
                   to reproduce it at 320px. */
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3 rounded-r3 border border-border/60 bg-bg-raised p-3">
                    {audit.score !== null && audit.score !== undefined && (
                      <Gauge value={audit.score} size={62} stroke={5} />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`text-body font-semibold ${band(audit.score ?? null).tone.text}`}>
                        {band(audit.score ?? null).word}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {fails > 0 && <Pill t={toneOf('bad')}>{fails} failing</Pill>}
                        {warns > 0 && <Pill t={toneOf('warn')}>{warns} warnings</Pill>}
                        {fails === 0 && warns === 0 && <Pill t={toneOf('ok')}>all clear</Pill>}
                      </div>
                    </div>
                  </div>
                  <Issues findings={techIssues} audit={audit} onRun={doRunAudit} busy={busy} />
                  {onExpand && (
                    <button
                      type="button"
                      onClick={() => onExpand('technical')}
                      className="inline-flex items-center justify-center gap-1.5 rounded-r2 border border-accent-dim bg-accent-dim/14 px-3 py-2 text-caption font-semibold text-accent transition-colors hover:bg-accent-dim/24"
                    >
                      Open full report
                      <ChevronLeft className="h-3 w-3 rotate-180" />
                    </button>
                  )}
                </div>
              ))}
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
          className="inline-flex shrink-0 items-center gap-1 rounded-r2 px-1.5 py-1 font-medium text-dim transition-colors hover:bg-bg-inset hover:text-accent disabled:opacity-40"
        >
          <SyncIcon className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'running…' : 'Re-run'}
        </button>
      </div>
    </div>
  );
}
