'use client';

/**
 * SEO audit report — the panel widgets.
 *
 * Search Console shows the numbers; this shows the numbers AND what to do
 * about them. Every query opportunity and every page issue carries a fix, and
 * where Cailyx can act (re-submit the sitemap) or hand over a paste-ready
 * artifact (canonical tag, BreadcrumbList JSON-LD, meta text) it does.
 *
 *   Overview   score · clicks / impressions / CTR / position · trend · top fixes
 *   Queries    every query, its movement, and the striking-distance / CTR-gap /
 *              mover flags — each with the concrete on-page fix
 *   Pages      every ranking URL with its Google index status, chosen
 *              canonical, and classified issues
 *   Fixes      the whole "do this" list, most severe first, with copy blocks
 *              and the one live action (re-submit sitemap)
 *
 * @module app/v2/_components/SeoAuditReport
 */

import { useMemo, useState } from 'react';
import type { AuditDelta, SeoAudit, SeoFinding, SeoPageRow, SeoTrendPoint } from '@/types/terminal';
import { band, fmtChange, rel, scoreKind, tone as toneOf, type ToneKind } from '@/app/v2/_lib/audit';
import { Gauge, Pill } from './TechnicalAuditReport';
import { SectionLabel } from './panel';
import { ChevronDown } from './icons';

/* ════════════════════════════════════════════════════════════════════════
   primitives
   ════════════════════════════════════════════════════════════════════════ */

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="no-scrollbar h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-4 p-5">{children}</div>
    </div>
  );
}

function Card({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-r4 border border-border/70 bg-bg-raised p-4">
      {title && <SectionLabel right={right}>{title}</SectionLabel>}
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-faint">{children}</p>;
}

const nf = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pathOf = (u: string) => {
  try {
    return new URL(u).pathname || u;
  } catch {
    return u;
  }
};
const parse = <T,>(raw: string | null | undefined, fb: T): T => {
  if (!raw) return fb;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fb;
  }
};

/** area chart of a numeric series */
function TrendArea({
  points,
  pick,
  width = 260,
  height = 60,
  invert = false,
}: {
  points: Array<Record<string, number>>;
  pick: (p: Record<string, number>) => number;
  width?: number;
  height?: number;
  invert?: boolean;
}) {
  const vals = points.map(pick).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const pad = 4;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (vals.length - 1)) * (width - pad * 2);
  const y = (v: number) => {
    const t = (v - min) / span;
    return height - pad - (invert ? 1 - t : t) * (height - pad * 2);
  };
  const line = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(vals.length - 1).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${height - pad} Z`;
  const rising = invert ? vals[vals.length - 1] <= vals[0] : vals[vals.length - 1] >= vals[0];
  const col = rising ? 'var(--a-ok)' : 'var(--a-bad)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <defs>
        <linearGradient id="seo-tr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={0.22} />
          <stop offset="100%" stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#seo-tr)" />
      <path d={line} fill="none" stroke={col} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-eyebrow font-bold uppercase tracking-eyebrow text-faint">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1400);
            });
          }}
          className="text-eyebrow font-bold uppercase tracking-wide2 text-cognac hover:underline"
        >
          {done ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="audit-code">{text}</pre>
    </div>
  );
}

/* ── delta chip ────────────────────────────────────────────────────────── */
function Delta({ d, unit = '' }: { d: AuditDelta | undefined; unit?: string }) {
  if (!d || d.direction === 'unchanged' || d.change === null) return null;
  const good = d.direction === 'improved';
  return (
    <span className={`text-caption font-semibold tabular-nums ${good ? 'text-a-ok' : 'text-a-bad'}`}>
      {good ? '▲' : '▼'} {fmtChange(d)}
      {unit}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Overview
   ════════════════════════════════════════════════════════════════════════ */

const OPP_LABEL: Record<string, { label: string; tone: ToneKind }> = {
  'striking-distance': { label: 'striking distance', tone: 'warn' },
  'ctr-gap': { label: 'under-clicked', tone: 'warn' },
  'ranking-gain': { label: 'rising', tone: 'ok' },
  'ranking-drop': { label: 'dropped', tone: 'bad' },
  cannibalization: { label: 'cannibalised', tone: 'warn' },
};

export function SeoOverview({
  audit,
  deltas,
}: {
  audit: SeoAudit;
  deltas: AuditDelta[];
  trend?: SeoTrendPoint[];
}) {
  const b = band(audit.score);
  const dByKey = new Map(deltas.map((d) => [d.metric, d]));
  const metrics = parse<{ timeseries: Array<Record<string, number>> }>(audit.metrics, { timeseries: [] });
  const ts = metrics.timeseries ?? [];

  const notIndexed = audit.pages.filter((p) => {
    const iss = parse<Array<{ code: string }>>(p.issues, []);
    return iss.some((i) => i.code.startsWith('not-indexed') || i.code === 'noindex' || i.code === 'blocked-robots');
  });
  const topFixes = [...audit.findings].slice(0, 4);

  const stat = (label: string, value: string, dk: string, unit = '') => (
    <div className="rounded-r3 border border-border/60 bg-bg-inset/40 px-3 py-2.5">
      <p className="text-eyebrow uppercase tracking-eyebrow text-faint">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-2">
        <span className="num font-display text-display font-semibold tabular-nums text-text">{value}</span>
        <Delta d={dByKey.get(dk)} unit={unit} />
      </p>
    </div>
  );

  return (
    <Panel>
      <div className={`rounded-r4 border bg-bg-raised p-5 ${b.tone.line}`}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Gauge value={audit.score} size={120} sub="SEO" />
          <div className="min-w-[180px] flex-1">
            <p className={`font-display text-display font-semibold ${b.tone.text}`}>{b.word}</p>
            <p className="mt-1 text-caption text-faint">
              {audit.siteUrl} · last {audit.windowDays} days · {audit.pagesInspected} URLs inspected
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {notIndexed.length > 0 && <Pill t={toneOf('bad')}>{notIndexed.length} not indexed</Pill>}
              {audit.findings.filter((f) => f.severity === 'critical').length > 0 && (
                <Pill t={toneOf('bad')}>{audit.findings.filter((f) => f.severity === 'critical').length} critical</Pill>
              )}
              {audit.queries.filter((q) => parse<string[]>(q.opportunities, []).includes('striking-distance')).length >
                0 && (
                <Pill t={toneOf('warn')}>
                  {
                    audit.queries.filter((q) =>
                      parse<string[]>(q.opportunities, []).includes('striking-distance'),
                    ).length
                  }{' '}
                  quick wins
                </Pill>
              )}
            </div>
          </div>
          {ts.length >= 2 && (
            <div className="shrink-0">
              <TrendArea points={ts} pick={(p) => p.clicks} />
              <p className="mt-1 text-right text-eyebrow uppercase tracking-eyebrow text-faint">clicks · {ts.length}d</p>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat('Clicks', nf(audit.clicks), 'clicks')}
        {stat('Impressions', nf(audit.impressions), 'impressions')}
        {stat('CTR', pct(audit.ctr), 'ctr', 'pp')}
        {stat('Avg position', audit.position.toFixed(1), 'position')}
      </div>

      <Card title="Fix these first" right={<span className="text-eyebrow tabular-nums text-faint">{audit.findings.length} total</span>}>
        {topFixes.length === 0 ? (
          <Empty>No issues or opportunities flagged this run — Search Console is clean.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {topFixes.map((f) => (
              <li key={f.id} className={`rounded-r3 border px-3 py-2 ${toneOf(sevKind(f.severity)).line} ${toneOf(sevKind(f.severity)).soft}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-body font-semibold text-text">{f.title}</span>
                  <span className={`shrink-0 text-eyebrow font-bold uppercase tracking-wide2 ${toneOf(sevKind(f.severity)).text}`}>
                    {f.severity}
                  </span>
                </div>
                <p className="mt-0.5 text-caption leading-snug text-faint">{f.recommendedFix}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Panel>
  );
}

function sevKind(s: SeoFinding['severity']): ToneKind {
  return s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'neutral';
}

/* ════════════════════════════════════════════════════════════════════════
   Queries
   ════════════════════════════════════════════════════════════════════════ */

type QSort = 'impressions' | 'clicks' | 'position' | 'ctr' | 'move';

export function SeoQueries({ audit }: { audit: SeoAudit }) {
  const [sort, setSort] = useState<QSort>('impressions');
  const [filter, setFilter] = useState<string>('all');

  const rows = useMemo(() => {
    let r = audit.queries.map((q) => ({ ...q, opps: parse<string[]>(q.opportunities, []) }));
    if (filter !== 'all') r = r.filter((q) => q.opps.includes(filter));
    r.sort((a, b) => {
      switch (sort) {
        case 'clicks':
          return b.clicks - a.clicks;
        case 'position':
          return a.position - b.position;
        case 'ctr':
          return b.ctr - a.ctr;
        case 'move':
          return (b.positionDelta ?? 0) - (a.positionDelta ?? 0);
        default:
          return b.impressions - a.impressions;
      }
    });
    return r.slice(0, 200);
  }, [audit.queries, sort, filter]);

  const oppCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const q of audit.queries) for (const o of parse<string[]>(q.opportunities, [])) c[o] = (c[o] ?? 0) + 1;
    return c;
  }, [audit.queries]);

  const Th = ({ k, label }: { k?: QSort; label: string }) => (
    <th
      onClick={k ? () => setSort(k) : undefined}
      className={`sticky top-0 z-10 bg-bg-raised px-2 py-1.5 text-right text-eyebrow font-bold uppercase tracking-eyebrow text-faint ${
        k ? 'cursor-pointer select-none hover:text-dim' : ''
      } first:text-left`}
    >
      {label}
      {k === sort ? ' ↓' : ''}
    </th>
  );

  return (
    <Panel>
      <Card
        title="Opportunities"
        right={<span className="text-eyebrow tabular-nums text-faint">{audit.queries.length} queries</span>}
      >
        <div className="flex flex-wrap gap-1.5">
          {[
            ['all', 'all'],
            ['striking-distance', `striking distance ${oppCounts['striking-distance'] ?? 0}`],
            ['ctr-gap', `under-clicked ${oppCounts['ctr-gap'] ?? 0}`],
            ['ranking-drop', `dropped ${oppCounts['ranking-drop'] ?? 0}`],
            ['ranking-gain', `rising ${oppCounts['ranking-gain'] ?? 0}`],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`rounded-full px-2.5 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 transition-colors ${
                filter === k ? 'bg-accent text-bg-raised' : 'bg-bg-inset text-faint hover:text-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Queries">
        <div className="-mx-2 max-h-[560px] overflow-auto rounded-r2">
          <table className="w-full min-w-[620px] border-collapse text-caption">
            <thead>
              <tr>
                <Th label="Query" />
                <Th k="clicks" label="Clicks" />
                <Th k="impressions" label="Impr" />
                <Th k="ctr" label="CTR" />
                <Th k="position" label="Pos" />
                <Th k="move" label="Δ pos" />
                <Th label="Flags" />
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.id} className="border-t border-border/40 odd:bg-bg-inset/20">
                  <td className="max-w-0 truncate px-2 py-1.5 text-dim" title={`${q.query}\n${q.topPage ?? ''}`}>
                    {q.query}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-dim">{q.clicks}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-faint">{nf(q.impressions)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-faint">{pct(q.ctr)}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${toneOf(scoreKind(q.position <= 3 ? 95 : q.position <= 10 ? 70 : 40)).text}`}>
                    {q.position.toFixed(1)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {q.positionDelta === null ? (
                      <span className="text-faint">–</span>
                    ) : q.positionDelta === 0 ? (
                      <span className="text-faint">0</span>
                    ) : (
                      <span className={q.positionDelta > 0 ? 'text-a-ok' : 'text-a-bad'}>
                        {q.positionDelta > 0 ? '▲' : '▼'} {Math.abs(q.positionDelta).toFixed(1)}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pl-2 pr-2 text-right">
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {q.opps.map((o) => (
                        <span
                          key={o}
                          className={`rounded-r1 border px-1 text-eyebrow font-semibold ${toneOf(OPP_LABEL[o]?.tone ?? 'neutral').soft} ${toneOf(OPP_LABEL[o]?.tone ?? 'neutral').line} ${toneOf(OPP_LABEL[o]?.tone ?? 'neutral').text}`}
                        >
                          {OPP_LABEL[o]?.label ?? o}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-eyebrow text-faint">Δ pos: + = moved up since the previous run. Hover a query for its ranking page.</p>
      </Card>
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Pages
   ════════════════════════════════════════════════════════════════════════ */

function indexKind(p: SeoPageRow): ToneKind {
  const c = (p.coverageState ?? '').toLowerCase();
  const v = (p.indexVerdict ?? '').toUpperCase();
  if (v === 'FAIL' || c.includes('not indexed') || c.includes('noindex') || c.includes('error')) return 'bad';
  if (v === 'PARTIAL' || c.includes('duplicate') || c.includes('redirect') || c.includes('excluded')) return 'warn';
  if (v === 'PASS' || c.includes('indexed')) return 'ok';
  return 'neutral';
}

function PageRow({ p }: { p: SeoPageRow }) {
  const [open, setOpen] = useState(false);
  const issues = parse<Array<{ code: string; severity: string; detail: string; fix: string; fixArtifact?: string }>>(
    p.issues,
    [],
  );
  const t = toneOf(indexKind(p));
  const canonMismatch =
    p.userCanonical && p.googleCanonical && !p.userCanonical.replace(/\/$/, '').endsWith(p.googleCanonical.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, ''));

  return (
    <>
      <tr onClick={() => setOpen((v) => !v)} className="cursor-pointer border-t border-border/40 odd:bg-bg-inset/20 hover:bg-bg-inset/50">
        <td className="max-w-0 py-1.5 pl-3 pr-2">
          <span className="flex items-center gap-1.5">
            <ChevronDown className={`h-3 w-3 shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
            <span className="truncate text-caption text-dim" title={p.url}>
              {pathOf(p.url)}
            </span>
          </span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-dim">{p.clicks}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-faint">{nf(p.impressions)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-faint">{p.position.toFixed(1)}</td>
        <td className="px-2 py-1.5 text-right">
          <span className={`rounded-r1 px-1.5 text-eyebrow font-semibold ${t.soft} ${t.text}`}>
            {p.coverageState ?? p.indexVerdict ?? '—'}
          </span>
        </td>
        <td className="py-1.5 pl-2 pr-3 text-right">
          {issues.length > 0 && <span className="num text-eyebrow font-bold tabular-nums text-a-warn">{issues.length}</span>}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-border/30 bg-bg-inset/30">
          <td colSpan={6} className="px-4 py-2.5">
            <p className="truncate text-eyebrow text-faint">{p.url}</p>
            <div className="mt-1 grid grid-cols-1 gap-x-8 text-caption sm:grid-cols-2">
              <KV k="Coverage" v={p.coverageState ?? '—'} />
              <KV k="Verdict" v={p.indexVerdict ?? '—'} />
              <KV k="Your canonical" v={p.userCanonical ? pathOf(p.userCanonical) : '—'} />
              <KV k="Google's canonical" v={p.googleCanonical ? pathOf(p.googleCanonical) : '—'} t={canonMismatch ? toneOf('warn') : undefined} />
              <KV k="Last crawl" v={p.lastCrawlTime ? p.lastCrawlTime.slice(0, 10) : '—'} />
              <KV k="Robots" v={p.robotsTxtState ?? '—'} />
            </div>
            {issues.length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                {issues.map((iss, i) => (
                  <div key={i} className={`rounded-r2 border px-2.5 py-1.5 ${toneOf(sevKind(iss.severity as SeoFinding['severity'])).line}`}>
                    <p className="text-caption text-dim">{iss.detail}</p>
                    <p className="mt-0.5 text-caption text-faint">fix: {iss.fix}</p>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function KV({ k, v, t }: { k: string; v: React.ReactNode; t?: ReturnType<typeof toneOf> }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1 last:border-0">
      <span className="min-w-0 truncate text-faint">{k}</span>
      <span className={`shrink-0 font-medium tabular-nums ${t?.text ?? 'text-dim'}`}>{v}</span>
    </div>
  );
}

export function SeoPages({ audit }: { audit: SeoAudit }) {
  const [onlyIssues, setOnlyIssues] = useState(audit.pages.length > 25);
  const rows = onlyIssues
    ? audit.pages.filter((p) => parse<unknown[]>(p.issues, []).length > 0 || indexKind(p) === 'bad')
    : audit.pages;
  const notIndexed = audit.pages.filter((p) => indexKind(p) === 'bad').length;

  return (
    <Panel>
      <Card
        title="Indexing coverage"
        right={
          <span className="text-eyebrow tabular-nums text-faint">
            {audit.pages.length - notIndexed}/{audit.pages.length} indexed
          </span>
        }
      >
        <Empty>
          {audit.pagesInspected} of your ranking URLs were inspected against Google&rsquo;s index.{' '}
          {notIndexed > 0 ? (
            <span className="text-a-bad">{notIndexed} are not indexed or blocked — see the Fixes tab for how to get each one in.</span>
          ) : (
            <span className="text-a-ok">All inspected URLs are indexed.</span>
          )}
        </Empty>
      </Card>

      <Card
        title="Per-URL"
        right={
          <button
            type="button"
            onClick={() => setOnlyIssues((v) => !v)}
            className="text-eyebrow font-bold uppercase tracking-eyebrow text-faint hover:text-dim"
          >
            {onlyIssues ? `with issues (${rows.length})` : `all ${audit.pages.length}`}
          </button>
        }
      >
        <div className="-mx-2 max-h-[540px] overflow-auto rounded-r2">
          <table className="w-full min-w-[620px] border-collapse text-caption">
            <thead>
              <tr>
                {['Path', 'Clicks', 'Impr', 'Pos', 'Index status', 'Iss'].map((h, i) => (
                  <th
                    key={h}
                    className={`sticky top-0 z-10 bg-bg-raised px-2 py-1.5 text-eyebrow font-bold uppercase tracking-eyebrow text-faint ${
                      i === 0 ? 'text-left' : 'text-right'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <PageRow key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Fixes
   ════════════════════════════════════════════════════════════════════════ */

function FindingCard({
  f,
  onAction,
  acting,
}: {
  f: SeoFinding;
  onAction: (action: string) => void;
  acting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const affected = parse<string[]>(f.affected, []);
  const t = toneOf(sevKind(f.severity));
  return (
    <div className={`rounded-r4 border ${t.line}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left ${t.soft}`}
      >
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 ${t.text}`}>
          {f.severity}
        </span>
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{f.title}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/50 bg-bg-raised px-4 py-3">
          <p className="text-[13px] leading-relaxed text-dim">{f.detail}</p>
          <div>
            <p className="text-eyebrow font-bold uppercase tracking-eyebrow text-accent">The fix</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-dim">{f.recommendedFix}</p>
          </div>

          {f.fixArtifact && <CopyBlock label="paste this" text={f.fixArtifact} />}

          {f.action === 'submit-sitemap' && (
            <button
              type="button"
              onClick={() => onAction('submit-sitemap')}
              disabled={acting}
              className="rounded-r2 border border-accent-dim bg-accent-dim/14 px-3 py-1.5 text-caption font-semibold text-accent transition-colors hover:bg-accent-dim/24 disabled:opacity-50"
            >
              {acting ? 'submitting…' : 'Re-submit sitemap to Google'}
            </button>
          )}

          {affected.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none text-eyebrow font-bold uppercase tracking-eyebrow text-faint hover:text-dim">
                {affected.length} affected
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {affected.slice(0, 40).map((a, i) => (
                  <li key={i} className="truncate text-caption text-faint">
                    {a.startsWith('http') ? pathOf(a) : a}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function SeoFixes({
  audit,
  onSubmitSitemaps,
}: {
  audit: SeoAudit;
  onSubmitSitemaps: () => Promise<void>;
}) {
  const [acting, setActing] = useState(false);
  const act = async (action: string) => {
    if (action !== 'submit-sitemap') return;
    setActing(true);
    try {
      await onSubmitSitemaps();
    } finally {
      setActing(false);
    }
  };

  const obs = parse<{ totalLatencyMs?: number; saCalls?: number; inspectCalls?: number }>(audit.observability, {});

  return (
    <Panel>
      <Card title="What to do">
        <Empty>
          Every item is something Search Console flags but does not fix. Ordered most-severe first. Where Cailyx can act
          (re-submitting the sitemap) or hand you a paste-ready block (canonical tag, breadcrumb JSON-LD), it does.
        </Empty>
      </Card>

      {audit.findings.length === 0 ? (
        <Card title="Findings">
          <Empty>Nothing to fix this run.</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {audit.findings.map((f) => (
            <FindingCard key={f.id} f={f} onAction={act} acting={acting} />
          ))}
        </div>
      )}

      <p className="text-eyebrow text-faint">
        {audit.pagesInspected} URLs inspected · {obs.saCalls ?? 0} Search Analytics + {obs.inspectCalls ?? 0} URL
        Inspection calls · {obs.totalLatencyMs ? `${(obs.totalLatencyMs / 1000).toFixed(0)}s` : ''} · audited {rel(audit.createdAt)}
      </p>
    </Panel>
  );
}
