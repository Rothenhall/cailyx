'use client';

/**
 * Technical-audit report - the panel widgets.
 *
 * The report is a set of panels the shell switches between, never one long
 * scroll. Each check panel is a split: the VERDICT on the left (what the
 * check concluded, in the traffic light) and the EVIDENCE on the right (what
 * was actually fetched to reach it - the raw robots.txt, the sitemap entry
 * list, the failed Lighthouse audits, the server-vs-JS render, the raw
 * JSON-LD). Everything here is derived from the one audit payload; no data is
 * fabricated and the evidence panes show the real bytes the crawler saw.
 *
 * @module app/v2/_components/TechnicalAuditReport
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cleanFindingText } from '@/lib/text';
import { getTechStack, runTechStackScan } from '@/lib/terminal-api';
import type { TechStackScan } from '@/types/terminal';
import { Button } from './Button';
import type {
  AuditComparison,
  AuditDelta,
  AuditPage,
  AuditTrendPoint,
  TechnicalAudit,
} from '@/types/terminal';
import {
  band,
  checkVerdict,
  cwvKind,
  detailOf,
  findingOf,
  fmtChange,
  fmtMetric,
  fmtMs,
  LEDGER_GROUPS,
  PAGE_ISSUE_LABELS,
  parseJsonArray,
  pick,
  pickArr,
  pickBool,
  pickStr,
  rel,
  scoreKind,
  SEO_BANDS,
  statusOf,
  tone as toneOf,
  type SectionId,
  type Tone,
  type ToneKind,
} from '@/app/v2/_lib/audit';
import { SectionLabel } from './panel';
import { ChevronDown } from './icons';

/* ════════════════════════════════════════════════════════════════════════
   primitives
   ════════════════════════════════════════════════════════════════════════ */

/** radial 0-100 score ring, with an optional hover tip */
export function Gauge({
  value,
  size = 128,
  stroke = 9,
  label,
  sub,
  tip,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  sub?: string;
  tip?: string;
}) {
  const t = toneOf(scoreKind(value));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  const arc =
    t.kind === 'ok'
      ? 'var(--a-ok)'
      : t.kind === 'warn'
        ? 'var(--a-warn)'
        : t.kind === 'bad'
          ? 'var(--a-bad)'
          : 'var(--text-faint)';

  return (
    <div className="tip-host relative inline-flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-inset)" strokeWidth={stroke} />
          <circle
            className="audit-gauge-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={arc}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(circ * pct).toFixed(2)} ${circ.toFixed(2)}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`num font-display font-semibold tabular-nums ${t.text}`} style={{ fontSize: size * 0.3 }}>
            {value ?? '--'}
          </span>
          {sub && <span className="text-eyebrow uppercase tracking-eyebrow text-faint">{sub}</span>}
        </div>
      </div>
      {label && <span className="mt-1.5 text-caption font-medium text-dim">{label}</span>}
      {tip && <span className="tip">{tip}</span>}
    </div>
  );
}

/** filled area chart of the score history */
function TrendArea({ points, width = 240, height = 64 }: { points: AuditTrendPoint[]; width?: number; height?: number }) {
  const scored = points.filter((p) => p.score !== null) as (AuditTrendPoint & { score: number })[];
  if (scored.length < 2) return null;

  const pad = 4;
  const min = Math.min(...scored.map((p) => p.score), 0);
  const max = Math.max(...scored.map((p) => p.score), 100);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (scored.length - 1)) * (width - pad * 2);
  const y = (s: number) => height - pad - ((s - min) / span) * (height - pad * 2);
  const line = scored.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  const area = `${line} L${x(scored.length - 1).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${height - pad} Z`;
  const last = scored[scored.length - 1];
  const rising = last.score >= scored[0].score;
  const col = rising ? 'var(--a-ok)' : 'var(--a-bad)';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <defs>
        <linearGradient id="audit-trend" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={0.22} />
          <stop offset="100%" stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#audit-trend)" />
      <path d={line} fill="none" stroke={col} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(scored.length - 1)} cy={y(last.score)} r={2.5} fill={col} />
    </svg>
  );
}

export function Sparkline({ points }: { points: AuditTrendPoint[] }) {
  return <TrendArea points={points} width={132} height={34} />;
}

/** model-written analysis, rendered as Markdown */
function Markdown({ text }: { text: string }) {
  return (
    <div className="audit-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/** key / value line */
function KV({ k, v, t }: { k: string; v: React.ReactNode; t?: Tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
      <span className="min-w-0 truncate text-caption text-faint">{k}</span>
      <span className={`shrink-0 text-caption font-semibold tabular-nums ${t?.text ?? 'text-dim'}`}>{v}</span>
    </div>
  );
}

/** labelled 0-100 bar */
function ScoreBar({ label, value, delta }: { label: string; value: number | null; delta?: AuditDelta | null }) {
  const t = toneOf(scoreKind(value));
  const moved = delta && (delta.direction === 'improved' || delta.direction === 'regressed');
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-caption text-dim">{label}</span>
        <span className="flex shrink-0 items-baseline gap-1.5">
          {moved && (
            <span className={`text-eyebrow font-semibold tabular-nums ${delta!.direction === 'improved' ? 'text-a-ok' : 'text-a-bad'}`}>
              {delta!.direction === 'improved' ? '▲' : '▼'}
              {delta!.change !== null ? Math.abs(delta!.change) : ''}
            </span>
          )}
          <span className={`num text-ui font-semibold tabular-nums ${t.text}`}>{value ?? '--'}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-inset">
        <span
          className={`block h-full rounded-full transition-[width] duration-morph ease-brand ${t.fill}`}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/** a verdict card */
function Card({ title, right, children, edge }: { title?: string; right?: React.ReactNode; children: React.ReactNode; edge?: Tone }) {
  return (
    <div className={`rounded-r4 border bg-bg-raised p-4 ${edge ? edge.line : 'border-border/70'}`}>
      {title && <SectionLabel right={right}>{title}</SectionLabel>}
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-faint">{children}</p>;
}

export function Pill({ t, children }: { t: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-eyebrow font-semibold uppercase tracking-wide2 ${t.soft} ${t.line} ${t.text}`}
    >
      {children}
    </span>
  );
}

/** the full-height container every panel sits in - scrolls only inside itself */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="no-scrollbar h-full min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </div>
  );
}

/** verdict | evidence. Side-by-side from `lg` up — the workspace is a
    full-canvas takeover, so the panel column clears 1024px on any laptop and
    the split (not a stacked scroll) is the normal case. */
function Split({ summary, evidence }: { summary: React.ReactNode; evidence: React.ReactNode }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start">
      <div className="flex flex-col gap-4">{summary}</div>
      <div className="flex flex-col gap-4">{evidence}</div>
    </div>
  );
}

/** the "what was fetched" pane - a distinct hatched frame, so it never reads
    as another verdict card */
function Evidence({ source, children }: { source: string; children: React.ReactNode }) {
  return (
    <div className="evidence overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-eyebrow font-bold uppercase tracking-eyebrow text-faint">Fetched</span>
        <span className="min-w-0 truncate text-eyebrow tabular-nums text-faint">{source}</span>
      </div>
      <div className="evidence-body space-y-3 p-3">{children}</div>
    </div>
  );
}

function CodeBlock({ text, empty = 'nothing captured' }: { text: string | null | undefined; empty?: string }) {
  if (!text) return <Empty>{empty}</Empty>;
  return <pre className="audit-code">{text}</pre>;
}

type Col<T> = { key: string; label: string; align?: 'left' | 'right'; render: (row: T) => React.ReactNode; w?: string };

function DataTable<T>({ cols, rows, empty }: { cols: Col<T>[]; rows: T[]; empty: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="max-h-72 overflow-auto rounded-r3 border border-border/60">
      <table className="w-full border-collapse text-caption">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                className={`sticky top-0 z-10 bg-bg-raised px-2.5 py-1.5 text-eyebrow font-bold uppercase tracking-eyebrow text-faint ${
                  c.align === 'right' ? 'text-right' : 'text-left'
                }`}
                style={c.w ? { width: c.w } : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/40 odd:bg-bg-inset/25">
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={`px-2.5 py-1.5 align-top ${c.align === 'right' ? 'text-right tabular-nums' : 'text-left'}`}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** one line stating what a check is FOR - used where the role is not obvious */
function RoleBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-r3 border border-accent-dim/50 bg-accent-dim/10 px-3.5 py-2.5">
      <p className="text-[13px] leading-relaxed text-dim">{children}</p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   metric ledger  (rail)
   ════════════════════════════════════════════════════════════════════════ */

function LedgerRow({ d }: { d: AuditDelta }) {
  const moved = d.direction === 'improved' || d.direction === 'regressed';
  const good = d.direction === 'improved';
  const arrow = good ? '▲' : d.direction === 'regressed' ? '▼' : d.direction === 'new' ? '' : '–';
  const tCol = good ? 'text-a-ok' : d.direction === 'regressed' ? 'text-a-bad' : 'text-faint';
  return (
    <li className="group px-2.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-caption text-dim">{d.label}</span>
        <span className="shrink-0 text-body font-semibold tabular-nums text-text">{fmtMetric(d.current, d.metric)}</span>
        <span className={`w-14 shrink-0 text-right text-caption font-medium tabular-nums ${tCol}`}>
          {d.direction === 'new' ? 'new' : moved ? `${arrow} ${fmtChange(d)}` : arrow}
        </span>
      </div>
      <p className={`mt-0.5 text-eyebrow tabular-nums text-faint ${moved ? '' : 'hidden group-hover:block'}`}>
        {d.previous === null ? 'no prior value' : `${fmtMetric(d.previous, d.metric)} → ${fmtMetric(d.current, d.metric)}`}
      </p>
    </li>
  );
}

export function MetricLedger({ comparison }: { comparison: AuditComparison | null }) {
  const byKey = useMemo(() => {
    const m = new Map<string, AuditDelta>();
    for (const d of comparison?.deltas ?? []) m.set(d.metric, d);
    return m;
  }, [comparison]);

  const measured = comparison?.deltas.length ?? 0;
  const moved = (comparison?.deltas ?? []).filter((d) => d.direction === 'improved' || d.direction === 'regressed').length;
  const hasPrev = Boolean(comparison?.previousAuditId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 pb-3 pt-3">
        <SectionLabel right={<span className="text-eyebrow tabular-nums text-faint">{measured} tracked</span>}>
          Metric ledger
        </SectionLabel>
        <p className="text-eyebrow uppercase tracking-eyebrow text-faint">
          {hasPrev ? `${moved} moved vs ${rel(comparison?.previousAt)}` : 'baseline - no previous run'}
        </p>
      </div>

      {measured === 0 ? (
        <p className="px-4 py-6 text-caption leading-relaxed text-faint">
          Nothing measured yet - run the audit to populate the ledger.
        </p>
      ) : (
        <div className="no-scrollbar v2-stagger flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3">
          {LEDGER_GROUPS.map((g, gi) => {
            const rows = g.keys.map((k) => byKey.get(k)).filter(Boolean) as AuditDelta[];
            if (!rows.length) return null;
            return (
              <div key={g.title} style={{ ['--i' as string]: gi }}>
                <p className="px-2.5 pb-1 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">{g.title}</p>
                <ul className="divide-y divide-border/50 rounded-r3 border border-border/60 bg-bg-raised/50">
                  {rows.map((d) => (
                    <LedgerRow key={d.metric} d={d} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Overview
   ════════════════════════════════════════════════════════════════════════ */

const CHECKS: { type: string; label: string; blurb: string; go: SectionId }[] = [
  { type: 'robots', label: 'robots.txt', blurb: 'Crawler allow rules', go: 'access' },
  { type: 'cdn-inferred', label: 'CDN / edge', blurb: 'WAF & bot-manager blocks', go: 'access' },
  { type: 'js-render', label: 'JS rendering', blurb: 'Content without JavaScript', go: 'structure' },
  { type: 'cwv', label: 'Core Web Vitals', blurb: 'Lighthouse lab & field', go: 'performance' },
  { type: 'schema', label: 'Structured data', blurb: 'JSON-LD on the homepage', go: 'structure' },
  { type: 'sitemap', label: 'Sitemap', blurb: 'Present & maintained', go: 'structure' },
  { type: 'agent-readiness', label: 'Agent readiness', blurb: 'is-agentic scan', go: 'agent' },
  { type: 'page-inventory', label: 'Page inventory', blurb: 'Every sitemap URL', go: 'pages' },
];

function CheckTile({
  audit,
  type,
  label,
  blurb,
  onGo,
}: {
  audit: TechnicalAudit;
  type: string;
  label: string;
  blurb: string;
  onGo: () => void;
}) {
  const v = checkVerdict(statusOf(audit, type));
  const f = findingOf(audit, type);
  const tip = f?.recommendedFix ? cleanFindingText(f.recommendedFix, 150) : blurb;
  return (
    <button
      type="button"
      onClick={onGo}
      className={`tip-host relative flex items-center gap-2.5 rounded-r3 border px-3 py-2.5 text-left transition-colors hover:brightness-[0.99] ${v.tone.line} ${v.tone.soft}`}
    >
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-body font-bold text-bg-raised ${v.tone.fill}`}>
        {v.glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold text-text">{label}</span>
        <span className="block truncate text-caption text-faint">{blurb}</span>
      </span>
      <span className={`shrink-0 text-eyebrow font-bold uppercase tracking-wide2 ${v.tone.text}`}>{v.word}</span>
      <span className="tip max-w-[240px] whitespace-normal">{tip}</span>
    </button>
  );
}

export function ReportOverview({
  audit,
  comparison,
  trend,
  onTab,
}: {
  audit: TechnicalAudit;
  comparison: AuditComparison | null;
  trend: AuditTrendPoint[];
  onTab: (id: SectionId) => void;
}) {
  const b = band(audit.score);
  const composite = comparison?.deltas.find((d) => d.metric === 'composite') ?? null;
  const delta = composite?.change ?? null;
  const scored = trend.filter((p) => p.score !== null);

  const cwv = detailOf(audit, 'cwv');
  const cats = (cwv?.categories as Record<string, number> | undefined) ?? {};
  const gauges: { label: string; value: number | null; tip: string }[] = [
    { label: 'Performance', value: typeof cats.performance === 'number' ? cats.performance : null, tip: 'Lighthouse performance score' },
    { label: 'Accessibility', value: typeof cats.accessibility === 'number' ? cats.accessibility : null, tip: 'Lighthouse accessibility score' },
    { label: 'Best practices', value: typeof cats['best-practices'] === 'number' ? cats['best-practices'] : null, tip: 'Lighthouse best-practices score' },
    { label: 'SEO', value: typeof cats.seo === 'number' ? cats.seo : null, tip: 'Lighthouse SEO score' },
    { label: 'Agent ready', value: pick(detailOf(audit, 'agent-readiness'), 'score'), tip: 'is-agentic third-party score' },
    { label: 'Avg page', value: pick(detailOf(audit, 'page-inventory'), 'averageScore'), tip: 'Mean score across crawled pages' },
  ];

  const fails = audit.findings.filter((f) => f.status === 'fail').length;
  const warns = audit.findings.filter((f) => f.status === 'warn').length;

  return (
    <Panel>
      <div className={`rounded-r4 border bg-bg-raised p-5 ${b.tone.line}`}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Gauge
            value={audit.score}
            size={124}
            sub="/ 100"
            tip={composite && composite.previous !== null ? `was ${composite.previous} last run` : 'composite of 6 weighted check groups'}
          />
          <div className="min-w-[180px] flex-1">
            <p className={`font-display text-display font-semibold ${b.tone.text}`}>{b.word}</p>
            <p className="mt-1 text-caption">
              {delta !== null && delta !== 0 ? (
                <span className={`font-semibold tabular-nums ${delta > 0 ? 'text-a-ok' : 'text-a-bad'}`}>
                  {delta > 0 ? '▲' : '▼'} {Math.abs(delta)} vs last run
                </span>
              ) : (
                <span className="text-faint">{comparison?.previousAuditId ? 'no change vs last run' : 'first run'}</span>
              )}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {fails > 0 && <Pill t={toneOf('bad')}>{fails} failing</Pill>}
              {warns > 0 && <Pill t={toneOf('warn')}>{warns} warnings</Pill>}
              {fails === 0 && warns === 0 && <Pill t={toneOf('ok')}>all checks clear</Pill>}
            </div>
          </div>
          {scored.length >= 2 && (
            <div className="shrink-0">
              <TrendArea points={trend} />
              <p className="mt-1 text-right text-eyebrow uppercase tracking-eyebrow text-faint">
                {scored.length} runs {'·'} {scored[0].score} {'→'} {scored[scored.length - 1].score}
              </p>
            </div>
          )}
        </div>
      </div>

      <Card title="Scores">
        <div className="grid grid-cols-3 gap-y-5 sm:grid-cols-6">
          {gauges.map((g) => (
            <div key={g.label} className="flex justify-center">
              <Gauge value={g.value} size={78} stroke={6} label={g.label} tip={g.tip} />
            </div>
          ))}
        </div>
      </Card>

      <Card title="Checks" right={<span className="text-eyebrow tabular-nums text-faint">{CHECKS.length}</span>}>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {CHECKS.map((c) => (
            <CheckTile key={c.type} audit={audit} type={c.type} label={c.label} blurb={c.blurb} onGo={() => onTab(c.go)} />
          ))}
        </div>
        <p className="mt-2 text-eyebrow text-faint">Select a check to open its panel and the data behind it.</p>
      </Card>
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Access
   ════════════════════════════════════════════════════════════════════════ */

function BotClass({ label, blocked, note }: { label: string; blocked: string[]; note: string }) {
  const t = toneOf(blocked.length === 0 ? 'ok' : 'bad');
  return (
    <div className={`rounded-r3 border p-3 ${t.line} ${t.soft}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-body font-semibold text-text">{label}</span>
        <span className={`text-eyebrow font-bold uppercase tracking-wide2 ${t.text}`}>
          {blocked.length === 0 ? 'allowed' : `${blocked.length} blocked`}
        </span>
      </div>
      <p className="mt-1 text-caption text-faint">{blocked.length === 0 ? note : `Blocked: ${blocked.join(', ')}`}</p>
    </div>
  );
}

export function ReportAccess({ audit }: { audit: TechnicalAudit }) {
  const robots = detailOf(audit, 'robots');
  const cdn = detailOf(audit, 'cdn-inferred');
  const robotsFinding = findingOf(audit, 'robots');

  if (!robots && !cdn)
    return (
      <Panel>
        <Empty>Access checks did not run for this audit.</Empty>
      </Panel>
    );

  const robotsFound = pickBool(robots, 'robotsTxtFound');
  const robotsUrl = pickStr(robots, 'robotsUrl') ?? '/robots.txt';
  const raw = pickStr(robots, 'rawContent');
  const rules = pickArr<Record<string, unknown>>(robots, 'rules');
  const blockedSearch = pickArr<string>(robots, 'blockedSearch');
  const blockedLive = pickArr<string>(robots, 'blockedLiveFetch');
  const blockedTraining = pickArr<string>(robots, 'blockedTraining');
  const googleBlocked = blockedSearch.some((x) => /google/i.test(x));
  const gt = toneOf(googleBlocked ? 'bad' : 'ok');

  const cdnVendor = pickStr(cdn, 'cdnVendor');
  const silentBlock = pickBool(cdn, 'silentBlockDetected');
  const cdnBlocked = pickArr<string>(cdn, 'blockedBots');
  const probes = pickArr<Record<string, unknown>>(cdn, 'probes');
  const headers = pickArr<string>(cdn, 'detectedFromHeaders');

  return (
    <Panel>
      <RoleBanner>
        Access is the first gate: an AI answer engine only cites a page it can fetch. Both layers are checked -
        the site&rsquo;s own <strong>robots.txt</strong>, and the <strong>CDN / WAF</strong> in front of it, which
        can silently block bots the robots file allows.
      </RoleBanner>

      <Split
        summary={
          <>
            <Card
              title="robots.txt"
              edge={toneOf(robotsFound === false || googleBlocked ? 'bad' : 'ok')}
              right={
                <span className="text-eyebrow tabular-nums text-faint">
                  {robotsFound === false ? 'not found' : `HTTP ${pick(robots, 'statusCode') ?? '--'}`}
                </span>
              }
            >
              {robotsFound === false ? (
                <Empty>No robots.txt was served. Crawlers assume everything is allowed, but nothing declares the sitemap or shapes crawl.</Empty>
              ) : (
                <>
                  <div className={`mb-3 flex items-center gap-3 rounded-r3 border p-3 ${gt.line} ${gt.soft}`}>
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-body font-bold text-bg-raised ${gt.fill}`}>
                      {googleBlocked ? '✕' : '✓'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-semibold text-text">Googlebot {googleBlocked ? 'is Disallowed' : 'is allowed'}</span>
                      <span className="block text-caption text-faint">Googlebot rendering feeds Google&rsquo;s AI Overviews</span>
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    <BotClass label="Search & answer" blocked={blockedSearch} note="OAI-SearchBot, PerplexityBot, Googlebot" />
                    <BotClass label="Live-fetch" blocked={blockedLive} note="ChatGPT-User, Claude-User" />
                    <BotClass label="Training" blocked={blockedTraining} note="GPTBot, ClaudeBot, CCBot" />
                  </div>
                </>
              )}
            </Card>

            <Card
              title="CDN / edge"
              edge={toneOf(silentBlock ? 'bad' : 'ok')}
              right={<Pill t={toneOf(silentBlock ? 'bad' : 'ok')}>{silentBlock ? 'silent block' : 'clear'}</Pill>}
            >
              <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                <KV k="Vendor" v={cdnVendor ?? 'none identified'} />
                <KV k="Browser-control fetch" v={`HTTP ${pick(cdn, 'browserControlStatus') ?? '--'}`} />
                <KV k="Blocked at edge" v={cdnBlocked.length} t={toneOf(cdnBlocked.length ? 'bad' : 'ok')} />
                <KV k="Probes run" v={probes.length} />
              </div>
              {cdnBlocked.length > 0 && <p className="mt-2 text-caption text-a-bad">Overriding robots.txt for: {cdnBlocked.join(', ')}</p>}
            </Card>

            {robotsFinding?.recommendedFix && (
              <p className="text-[13px] leading-relaxed text-faint">{cleanFindingText(robotsFinding.recommendedFix, 320)}</p>
            )}
          </>
        }
        evidence={
          <>
            <Evidence source={robotsUrl}>
              <CodeBlock text={raw} empty="robots.txt returned no body" />
              <DataTable
                cols={[
                  { key: 'bot', label: 'User-agent', render: (r: Record<string, unknown>) => <span className="text-dim">{String(r.botName ?? '*')}</span> },
                  {
                    key: 'rule',
                    label: 'Rule',
                    render: (r: Record<string, unknown>) => (
                      <span className={r.disallowed ? 'text-a-bad' : 'text-a-ok'}>{r.disallowed ? 'Disallow' : 'Allow'}</span>
                    ),
                  },
                  {
                    key: 'paths',
                    label: 'Paths',
                    render: (r: Record<string, unknown>) => (
                      <span className="text-faint">{Array.isArray(r.paths) ? (r.paths as string[]).join(' ') || '/' : '/'}</span>
                    ),
                  },
                ]}
                rows={rules}
                empty="no per-bot rules parsed"
              />
            </Evidence>

            <Evidence source={`${probes.length} bot probes`}>
              {headers.length > 0 && <p className="text-eyebrow text-faint">CDN inferred from headers: {headers.join(', ')}</p>}
              <DataTable
                cols={[
                  { key: 'bot', label: 'Bot', render: (p: Record<string, unknown>) => <span className="text-dim">{String(p.botName ?? '')}</span> },
                  { key: 'cat', label: 'Class', render: (p: Record<string, unknown>) => <span className="text-faint">{String(p.category ?? '')}</span> },
                  { key: 'status', label: 'HTTP', align: 'right', render: (p: Record<string, unknown>) => <span className="text-dim">{String(p.status ?? '--')}</span> },
                  {
                    key: 'v',
                    label: '',
                    align: 'right',
                    render: (p: Record<string, unknown>) => <span className={p.blocked ? 'text-a-bad' : 'text-a-ok'}>{p.blocked ? 'blocked' : 'ok'}</span>,
                  },
                ]}
                rows={probes}
                empty="no CDN probes recorded"
              />
            </Evidence>
          </>
        }
      />
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Performance
   ════════════════════════════════════════════════════════════════════════ */

function Vital({ label, value, status, good, poor, delta }: { label: string; value: string; status: string | null; good: string; poor: string; delta?: AuditDelta | null }) {
  const t = toneOf(cwvKind(status));
  const moved = delta && (delta.direction === 'improved' || delta.direction === 'regressed');
  return (
    <div className={`rounded-r3 border p-3 ${t.line} ${t.soft}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-eyebrow font-bold uppercase tracking-eyebrow text-faint">{label}</span>
        {moved && (
          <span className={`text-eyebrow font-semibold tabular-nums ${delta!.direction === 'improved' ? 'text-a-ok' : 'text-a-bad'}`}>
            {delta!.direction === 'improved' ? '▲' : '▼'} {fmtChange(delta!)}
          </span>
        )}
      </div>
      <p className={`num mt-1 font-display text-display font-semibold tabular-nums ${t.text}`}>{value}</p>
      <div className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        <span className={status === 'good' ? 'flex-1 bg-a-ok' : 'flex-1 bg-a-ok/25'} />
        <span className={status === 'needs-improvement' ? 'flex-1 bg-a-warn' : 'flex-1 bg-a-warn/20'} />
        <span className={status === 'poor' ? 'flex-1 bg-a-bad' : 'flex-1 bg-a-bad/20'} />
      </div>
      <p className="mt-1.5 text-eyebrow text-faint">
        good {good} {'·'} poor {poor}
      </p>
    </div>
  );
}

export function ReportPerformance({ audit, comparison }: { audit: TechnicalAudit; comparison: AuditComparison | null }) {
  const cwv = detailOf(audit, 'cwv');
  if (!cwv)
    return (
      <Panel>
        <Empty>PageSpeed Insights did not return data for this run.</Empty>
      </Panel>
    );

  const d = (k: string) => comparison?.deltas.find((x) => x.metric === k) ?? null;
  const cats = (cwv.categories as Record<string, number> | undefined) ?? {};
  const failed = pickArr<Record<string, unknown>>(cwv, 'failedAudits');
  const field = (cwv.fieldData as Record<string, { percentile: number; category: string }> | null) ?? null;
  const finalUrl = pickStr(cwv, 'finalUrl');
  const lhVersion = pickStr(cwv, 'lighthouseVersion');

  const CATS = [
    ['performance', 'Performance', 'lighthousePerformance'],
    ['seo', 'SEO', 'lighthouseSeo'],
    ['accessibility', 'Accessibility', 'lighthouseAccessibility'],
    ['best-practices', 'Best practices', ''],
  ] as const;

  return (
    <Panel>
      <RoleBanner>
        Core Web Vitals are one Lighthouse pass through Google&rsquo;s PageSpeed Insights API - the same lab run
        Search uses for ranking. Field data, when the origin has enough traffic, is what real Chrome users
        actually experienced over the trailing 28 days.
      </RoleBanner>

      <Split
        summary={
          <>
            <Card title="Core Web Vitals" right={field ? <Pill t={toneOf('ok')}>field data</Pill> : <span className="text-eyebrow uppercase tracking-eyebrow text-faint">lab only</span>}>
              <div className="flex flex-col gap-2.5">
                <Vital label="LCP" value={fmtMs(pick(cwv, 'lcp'))} status={pickStr(cwv, 'lcpStatus')} good={'≤ 2.5s'} poor="> 4s" delta={d('lcp')} />
                <Vital label="INP" value={fmtMs(pick(cwv, 'inp'))} status={pickStr(cwv, 'inpStatus')} good={'≤ 200ms'} poor="> 500ms" delta={d('inp')} />
                <Vital label="CLS" value={(pick(cwv, 'cls') ?? 0).toFixed(3)} status={pickStr(cwv, 'clsStatus')} good={'≤ 0.1'} poor="> 0.25" delta={d('cls')} />
              </div>
            </Card>
            <Card title="Lighthouse categories" right={lhVersion ? <span className="text-eyebrow text-faint">v{lhVersion}</span> : null}>
              {CATS.map(([key, label, dk]) => (
                <ScoreBar key={key} label={label} value={typeof cats[key] === 'number' ? cats[key] : null} delta={dk ? d(dk) : null} />
              ))}
            </Card>
          </>
        }
        evidence={
          <>
            {field && (
              <Evidence source="CrUX field data (28-day)">
                <DataTable
                  cols={[
                    { key: 'm', label: 'Metric', render: ([k]: [string, { percentile: number; category: string }]) => <span className="text-dim">{k}</span> },
                    {
                      key: 'p',
                      label: 'p75',
                      align: 'right',
                      render: ([k, v]: [string, { percentile: number; category: string }]) => (
                        <span className="text-dim">
                          {v.percentile}
                          {/cls/i.test(k) ? '' : 'ms'}
                        </span>
                      ),
                    },
                    { key: 'c', label: '', align: 'right', render: ([, v]: [string, { percentile: number; category: string }]) => <span className={toneOf(cwvKind(v.category)).text}>{v.category}</span> },
                  ]}
                  rows={Object.entries(field)}
                  empty="origin below CrUX reporting threshold"
                />
              </Evidence>
            )}
            <Evidence source={`Lighthouse ${lhVersion ? `v${lhVersion}` : ''} · ${failed.length} failing audits`}>
              {finalUrl && <p className="truncate text-eyebrow text-faint">measured URL: {finalUrl}</p>}
              <DataTable
                cols={[
                  { key: 'cat', label: 'Category', render: (a: Record<string, unknown>) => <span className="text-faint">{String(a.category ?? '')}</span>, w: '22%' },
                  { key: 'title', label: 'Audit', render: (a: Record<string, unknown>) => <span className="text-dim">{String(a.title ?? a.id ?? '')}</span> },
                  { key: 'v', label: 'Value', align: 'right', render: (a: Record<string, unknown>) => <span className="text-a-warn">{String(a.displayValue ?? '')}</span> },
                ]}
                rows={failed}
                empty="no failing Lighthouse audits"
              />
            </Evidence>
          </>
        }
      />
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Structure
   ════════════════════════════════════════════════════════════════════════ */

function jsonPretty(items: unknown[]): string {
  if (!items.length) return '';
  try {
    return items.map((x) => JSON.stringify(x, null, 2)).join('\n\n');
  } catch {
    return String(items);
  }
}

export function ReportStructure({ audit }: { audit: TechnicalAudit }) {
  const schema = detailOf(audit, 'schema');
  const sitemap = detailOf(audit, 'sitemap');
  const js = detailOf(audit, 'js-render');

  const schemaTypes = pickArr<string>(schema, 'schemaTypes');
  const missing = pickArr<string>(schema, 'missingFields');
  const sameAsUrls = pickArr<string>(schema, 'sameAsUrls');
  const sameAsVerif = pickArr<Record<string, unknown>>(schema, 'sameAsVerification');
  const rawSchemas = pickArr<unknown>(schema, 'rawSchemas');

  const smFound = pickBool(sitemap, 'found');
  const urlCount = pick(sitemap, 'urlCount');
  const withLastmod = pick(sitemap, 'withLastmod');
  const staleDays = pick(sitemap, 'staleDays');
  const inRobots = pickBool(sitemap, 'declaredInRobots');
  const smUrl = pickStr(sitemap, 'sitemapUrl');
  const smStale = staleDays !== null && staleDays > 90;
  const entries = pickArr<Record<string, unknown>>(sitemap, 'entries');
  const tried = pickArr<string>(sitemap, 'triedUrls');

  const lossPct = pick(js, 'contentLossPercent');
  const jsDependent = pickBool(js, 'isJsDependent');
  const lossKind: ToneKind = (lossPct ?? 0) < 10 ? 'ok' : (lossPct ?? 0) < 40 ? 'warn' : 'bad';
  const srvText = pickStr(js, 'serverRenderedText');
  const jsText = pickStr(js, 'jsRenderedText');

  return (
    <Panel>
      <RoleBanner>
        Structure is what lets an assistant <em>quote</em> the page rather than just reach it: machine-readable
        JSON-LD for the entity, a maintained sitemap so every page is discoverable, and server-rendered HTML so
        the content exists before any JavaScript runs.
      </RoleBanner>

      <Split
        summary={
          <>
            <Card
              title="Structured data (JSON-LD)"
              edge={toneOf(schemaTypes.length ? 'ok' : 'bad')}
              right={<Pill t={toneOf(schemaTypes.length ? 'ok' : 'bad')}>{schemaTypes.length ? `${schemaTypes.length} types` : 'none'}</Pill>}
            >
              {!schema ? (
                <Empty>The schema check did not run.</Empty>
              ) : (
                <>
                  {schemaTypes.length > 0 && (
                    <div className="mb-2.5 flex flex-wrap gap-1.5">
                      {schemaTypes.map((x) => (
                        <span key={x} className="rounded-r2 border border-a-ok-line bg-a-ok-soft px-2 py-0.5 text-eyebrow font-semibold text-a-ok">
                          {x}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                    <KV k="Organization" v={pickBool(schema, 'hasOrganization') ? 'present' : 'missing'} t={toneOf(pickBool(schema, 'hasOrganization') ? 'ok' : 'warn')} />
                    <KV k="Person" v={pickBool(schema, 'hasPerson') ? 'present' : 'missing'} />
                    <KV k="sameAs links" v={sameAsUrls.length} />
                    <KV k="sameAs verified" v={sameAsVerif.length ? `${sameAsVerif.filter((s) => s.resolves === true).length} / ${sameAsVerif.length}` : '--'} />
                  </div>
                  {missing.length > 0 && (
                    <p className="mt-2 text-caption text-a-warn">
                      Missing recommended fields: <span className="text-dim">{missing.join(', ')}</span>
                    </p>
                  )}
                </>
              )}
            </Card>

            <Card
              title="Sitemap"
              edge={toneOf(smFound === false ? 'bad' : smStale ? 'warn' : 'ok')}
              right={<Pill t={toneOf(smFound === false ? 'bad' : smStale ? 'warn' : 'ok')}>{smFound === false ? 'missing' : smStale ? 'stale' : 'healthy'}</Pill>}
            >
              {smFound === false ? (
                <Empty>No sitemap was found at any tried location.</Empty>
              ) : (
                <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                  <KV k="URLs" v={urlCount ?? '--'} />
                  <KV k="With <lastmod>" v={urlCount ? `${withLastmod ?? 0} / ${urlCount}` : '--'} t={toneOf(urlCount && withLastmod === urlCount ? 'ok' : 'warn')} />
                  <KV k="Last change" v={staleDays === null ? 'undated' : `${staleDays}d ago`} t={toneOf(smStale ? 'warn' : 'neutral')} />
                  <KV k="In robots.txt" v={inRobots ? 'yes' : 'no'} t={toneOf(inRobots ? 'ok' : 'warn')} />
                </div>
              )}
            </Card>

            <Card
              title="JavaScript rendering"
              edge={toneOf(jsDependent ? 'bad' : 'ok')}
              right={<Pill t={toneOf(jsDependent ? 'bad' : 'ok')}>{jsDependent ? 'JS-dependent' : 'server-rendered'}</Pill>}
            >
              {!js ? (
                <Empty>The render check did not run.</Empty>
              ) : (
                <>
                  <div className="flex items-baseline justify-between">
                    <span className="text-caption text-dim">Content lost without JavaScript</span>
                    <span className={`num text-ui font-semibold tabular-nums ${toneOf(lossKind).text}`}>
                      {lossPct === null ? '--' : `${Math.round(lossPct)}%`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-inset">
                    <span className={`block h-full rounded-full ${toneOf(lossKind).fill}`} style={{ width: `${Math.min(100, lossPct ?? 0)}%` }} />
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                    <KV k="Text with JS" v={`${(pick(js, 'textLengthWithJs') ?? 0).toLocaleString()} ch`} />
                    <KV k="Text without JS" v={`${(pick(js, 'textLengthWithoutJs') ?? 0).toLocaleString()} ch`} />
                  </div>
                </>
              )}
            </Card>
          </>
        }
        evidence={
          <>
            <Evidence source={smUrl ?? (tried.length ? `tried ${tried.length} locations` : 'sitemap')}>
              {tried.length > 0 && !smUrl && <p className="text-eyebrow text-faint">tried: {tried.join(', ')}</p>}
              <DataTable
                cols={[
                  { key: 'u', label: 'URL', render: (e: Record<string, unknown>) => <span className="text-dim">{String(e.url ?? e.loc ?? '')}</span> },
                  { key: 'lm', label: 'lastmod', align: 'right', render: (e: Record<string, unknown>) => <span className="text-faint">{e.lastmod ? String(e.lastmod).slice(0, 10) : '—'}</span> },
                ]}
                rows={entries}
                empty="sitemap listed no URLs"
              />
            </Evidence>

            <Evidence source={rawSchemas.length ? `${rawSchemas.length} JSON-LD block(s)` : 'JSON-LD'}>
              <CodeBlock text={jsonPretty(rawSchemas)} empty="no JSON-LD found in the homepage HTML" />
            </Evidence>

            {js && (
              <Evidence source="render diff · first 500 chars each">
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-eyebrow font-bold uppercase tracking-eyebrow text-faint">
                      No JS {'·'} title: {pickStr(js, 'titleWithoutJs') || '∅'}
                    </p>
                    <CodeBlock text={srvText} empty="empty without JS" />
                  </div>
                  <div>
                    <p className="mb-1 text-eyebrow font-bold uppercase tracking-eyebrow text-faint">
                      With JS {'·'} title: {pickStr(js, 'titleWithJs') || '∅'}
                    </p>
                    <CodeBlock text={jsText} empty="empty with JS" />
                  </div>
                </div>
              </Evidence>
            )}
          </>
        }
      />
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Pages
   ════════════════════════════════════════════════════════════════════════ */

type SortKey = 'score' | 'title' | 'meta' | 'words' | 'url';
type PageFilter = 'all' | 'errors' | 'warnings';

function titleKind(len: number | null): ToneKind {
  if (len === null || len === 0) return 'bad';
  if (len < SEO_BANDS.titleMin || len > SEO_BANDS.titleMax) return 'warn';
  return 'neutral';
}
function metaKind(len: number | null): ToneKind {
  if (len === null || len === 0) return 'bad';
  if (len < SEO_BANDS.metaMin || len > SEO_BANDS.metaMax) return 'warn';
  return 'neutral';
}
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

function NumCell({ v, kind }: { v: React.ReactNode; kind: ToneKind }) {
  const t = toneOf(kind);
  return (
    <td className="px-2 py-1.5 text-right">
      <span
        className={`num inline-block min-w-[2.2rem] rounded-r1 px-1.5 text-caption font-semibold tabular-nums ${
          kind === 'neutral' ? 'text-dim' : `${t.soft} ${t.text}`
        }`}
      >
        {v}
      </span>
    </td>
  );
}

function PageRow({ p }: { p: AuditPage }) {
  const [open, setOpen] = useState(false);
  const issues = parseJsonArray<string>(p.issues);
  const types = parseJsonArray<string>(p.jsonLdTypes);
  const errored = p.status >= 400 || p.status === 0;
  const jsonOk = p.jsonLdCount > 0 && p.jsonLdValid;

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
        <NumCell v={errored ? `HTTP ${p.status}` : p.score} kind={errored ? 'bad' : scoreKind(p.score)} />
        <NumCell v={p.titleLength ?? '--'} kind={titleKind(p.titleLength)} />
        <NumCell v={p.metaDescLength ?? '--'} kind={metaKind(p.metaDescLength)} />
        <NumCell v={p.h1Count ?? '--'} kind={(p.h1Count ?? 0) === 1 ? 'neutral' : 'warn'} />
        <td className="px-2 py-1.5 text-right">
          <span className={`num text-caption font-semibold tabular-nums ${jsonOk ? 'text-a-ok' : 'text-a-bad'}`}>
            {p.jsonLdCount > 0 ? (p.jsonLdValid ? `${p.jsonLdCount} ✓` : `${p.jsonLdCount} ✕`) : '0'}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right text-caption tabular-nums text-faint">{p.wordCount?.toLocaleString() ?? '--'}</td>
        <td className="py-1.5 pl-2 pr-3 text-right">
          {issues.length > 0 && <span className="num text-eyebrow font-bold tabular-nums text-a-warn">{issues.length}</span>}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-border/30 bg-bg-inset/30">
          <td colSpan={8} className="px-4 py-2.5">
            <p className="truncate text-eyebrow text-faint">{p.url}</p>
            <div className="mt-1 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <KV k="Title" v={<span className="text-dim">{p.title || '∅'}</span>} />
              <KV k="Meta description" v={<span className="text-dim">{p.metaDescription || '∅'}</span>} />
              <KV k="Canonical" v={<span className="text-dim">{p.canonical || 'none'}</span>} />
              <KV k="Last modified" v={p.lastmod ? p.lastmod.slice(0, 10) : 'undated'} />
              {types.length > 0 && <KV k="JSON-LD types" v={<span className="text-dim">{types.join(', ')}</span>} />}
            </div>
            {issues.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {issues.map((code) => (
                  <span key={code} className="rounded-r2 border border-a-warn-line bg-a-warn-soft px-2 py-0.5 text-eyebrow font-semibold text-a-warn">
                    {PAGE_ISSUE_LABELS[code] ?? code}
                  </span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ChurnList({ title, glyph, tCol, items }: { title: string; glyph: string; tCol: string; items: Array<{ url: string; from?: number; to?: number }> | string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 text-eyebrow font-bold uppercase tracking-eyebrow text-faint">
        <span className={tCol}>{glyph}</span> {title} {'·'} {items.length}
      </p>
      <ul className="space-y-0.5">
        {items.slice(0, 8).map((it, i) => {
          const url = typeof it === 'string' ? it : it.url;
          const move = typeof it === 'string' ? null : it;
          return (
            <li key={i} className="flex items-baseline gap-2 text-caption">
              <span className="min-w-0 flex-1 truncate text-dim">{pathOf(url)}</span>
              {move && move.from !== undefined && (
                <span className="shrink-0 tabular-nums text-faint">
                  {move.from} {'→'} {move.to}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ReportPages({ audit, comparison }: { audit: TechnicalAudit; comparison: AuditComparison | null }) {
  const inv = detailOf(audit, 'page-inventory');
  const pages = useMemo(() => audit.pages ?? [], [audit]);
  const [sort, setSort] = useState<SortKey>('score');
  const [asc, setAsc] = useState(true);
  const [filter, setFilter] = useState<PageFilter>(pages.length > 40 ? 'warnings' : 'all');

  const discovered = pick(inv, 'discovered') ?? 0;
  const crawled = pick(inv, 'crawled') ?? pages.length;
  const budget = pick(inv, 'budget');
  const avg = pick(inv, 'averageScore');
  const errored = pick(inv, 'errored') ?? 0;
  const issueCounts = (inv?.issueCounts as Record<string, number> | undefined) ?? {};
  const topIssues = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]);
  const maxIssue = topIssues[0]?.[1] ?? 1;

  const rows = useMemo(() => {
    let r = [...pages];
    if (filter === 'errors') r = r.filter((p) => p.status >= 400 || p.status === 0);
    else if (filter === 'warnings') r = r.filter((p) => parseJsonArray<string>(p.issues).length > 0 || p.status >= 400);
    const dir = asc ? 1 : -1;
    r.sort((a, b) => {
      switch (sort) {
        case 'title':
          return ((a.titleLength ?? 0) - (b.titleLength ?? 0)) * dir;
        case 'meta':
          return ((a.metaDescLength ?? 0) - (b.metaDescLength ?? 0)) * dir;
        case 'words':
          return ((a.wordCount ?? 0) - (b.wordCount ?? 0)) * dir;
        case 'url':
          return a.url.localeCompare(b.url) * dir;
        default:
          return ((a.score ?? 0) - (b.score ?? 0)) * dir;
      }
    });
    return r;
  }, [pages, sort, asc, filter]);

  const setSortKey = (k: SortKey) => {
    if (k === sort) setAsc((v) => !v);
    else {
      setSort(k);
      setAsc(true);
    }
  };

  const pc = comparison?.pageChanges;
  if (!inv && pages.length === 0)
    return (
      <Panel>
        <Empty>The page inventory did not run for this audit.</Empty>
      </Panel>
    );

  const withIssues = pages.filter((p) => parseJsonArray<string>(p.issues).length > 0 || p.status >= 400).length;
  const errCount = pages.filter((p) => p.status >= 400 || p.status === 0).length;

  const Th = ({ k, label, className }: { k?: SortKey; label: string; className?: string }) => (
    <th
      onClick={k ? () => setSortKey(k) : undefined}
      className={`sticky top-0 z-10 bg-bg-raised px-2 py-1.5 text-eyebrow font-bold uppercase tracking-eyebrow text-faint ${
        k ? 'cursor-pointer select-none hover:text-dim' : ''
      } ${className ?? ''}`}
    >
      {label}
      {k === sort ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  const FilterBtn = ({ f, label }: { f: PageFilter; label: string }) => (
    <button
      type="button"
      onClick={() => setFilter(f)}
      className={`rounded-full px-2.5 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 transition-colors ${
        filter === f ? 'bg-accent text-bg-raised' : 'bg-bg-inset text-faint hover:text-dim'
      }`}
    >
      {label}
    </button>
  );

  return (
    <Panel>
      <RoleBanner>
        The inventory fetches every URL in the sitemap (up to the crawl budget, newest-changed first) and scores
        each against the disclosed rubric: title {SEO_BANDS.titleMin}-{SEO_BANDS.titleMax}, meta{' '}
        {SEO_BANDS.metaMin}-{SEO_BANDS.metaMax}, one H1, valid JSON-LD, and enough body text to be worth quoting.
      </RoleBanner>

      <Card title="Coverage" right={avg !== null ? <span className={`text-eyebrow font-bold tabular-nums ${toneOf(scoreKind(avg)).text}`}>avg {avg}</span> : null}>
        <p className="text-[13px] leading-relaxed text-faint">
          Crawled <span className="font-semibold tabular-nums text-dim">{crawled}</span> of{' '}
          <span className="tabular-nums">{discovered}</span> sitemap URLs
          {budget !== null && discovered > crawled && (
            <span>
              {' '}
              {'·'} budget {budget}
            </span>
          )}
          {errored > 0 && (
            <span className="text-a-warn">
              {' '}
              {'·'} {errored} errored
            </span>
          )}
        </p>
        {topIssues.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {topIssues.slice(0, 8).map(([code, n]) => (
              <li key={code} className="flex items-center gap-3 text-caption">
                <span className="w-44 shrink-0 truncate text-dim">{PAGE_ISSUE_LABELS[code] ?? code}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-bg-inset">
                  <span
                    className={`block h-full rounded-full ${
                      code === 'page-error' || code === 'noindex' || code === 'json-ld-missing' ? 'bg-a-bad' : 'bg-a-warn'
                    }`}
                    style={{ width: `${(n / maxIssue) * 100}%` }}
                  />
                </span>
                <span className="num w-8 shrink-0 text-right tabular-nums text-faint">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pages.length > 0 && (
        <Card
          title="Per-page crawl"
          right={
            <div className="flex items-center gap-1">
              <FilterBtn f="all" label={`all ${pages.length}`} />
              <FilterBtn f="warnings" label={`issues ${withIssues}`} />
              {errCount > 0 && <FilterBtn f="errors" label={`errors ${errCount}`} />}
            </div>
          }
        >
          <div className="-mx-2 max-h-[440px] overflow-auto rounded-r2">
            <table className="w-full min-w-[600px] border-collapse">
              <thead>
                <tr className="text-right">
                  <Th k="url" label="Path" className="!text-left" />
                  <Th k="score" label="Score" />
                  <Th k="title" label="Title" />
                  <Th k="meta" label="Meta" />
                  <Th label="H1" />
                  <Th label="JSON-LD" />
                  <Th k="words" label="Words" />
                  <Th label="Iss" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <PageRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-eyebrow text-faint">
            amber = outside band {'·'} red = missing {'·'} row click expands
          </p>
        </Card>
      )}

      {pc && (pc.added.length || pc.removed.length || pc.improved.length || pc.regressed.length) > 0 && (
        <Card title="Page churn since last run">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ChurnList title="Improved" glyph={'▲'} tCol="text-a-ok" items={pc.improved} />
            <ChurnList title="Regressed" glyph={'▼'} tCol="text-a-bad" items={pc.regressed} />
            <ChurnList title="Added" glyph="+" tCol="text-a-ok" items={pc.added} />
            <ChurnList title="Removed" glyph={'−'} tCol="text-faint" items={pc.removed} />
          </div>
        </Card>
      )}
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   AI readiness
   ════════════════════════════════════════════════════════════════════════ */

export function ReportAgent({ audit }: { audit: TechnicalAudit }) {
  const a = detailOf(audit, 'agent-readiness');
  if (!a)
    return (
      <Panel>
        <Empty>The agent-readiness check did not run.</Empty>
      </Panel>
    );

  const score = pick(a, 'score');
  const label = pickStr(a, 'scoreLabel');
  const reportUrl = pickStr(a, 'reportUrl');
  const source = pickStr(a, 'source');
  const scannedAt = pickStr(a, 'scannedAt');
  const eligible = pick(a, 'eligibleChecks');
  const error = pickStr(a, 'error');
  const issues = pickArr<Record<string, unknown>>(a, 'issues');
  const breakdown = (a.breakdown as Record<string, Record<string, number>> | null) ?? null;

  const role = (
    <RoleBanner>
      <strong>is-agentic</strong> is a third-party audit (built by Vercel) scoring whether an AI agent can{' '}
      <em>discover, read, navigate and transact</em> on the site - checking for <code>/llms.txt</code>, an MCP
      endpoint, clean machine-readable pages, and agent-friendly checkout. It is the one number in this report
      Cailyx does not compute itself; the full breakdown lives on the public report.
    </RoleBanner>
  );

  if (score === null) {
    return (
      <Panel>
        {role}
        <Card title="Agent readiness">
          <Empty>{error ?? 'The scan produced no score this run.'}</Empty>
        </Card>
      </Panel>
    );
  }

  const failing = issues.filter((i) => i.result === 'failed');

  return (
    <Panel>
      {role}
      <Split
        summary={
          <Card
            title="Score"
            right={
              <span className="text-eyebrow uppercase tracking-eyebrow text-faint">
                {source === 'cli' ? 'live scan' : source === 'api' ? 'cached' : ''}
                {scannedAt ? ` · ${rel(scannedAt)}` : ''}
              </span>
            }
          >
            <div className="flex items-center gap-4">
              <Gauge value={score} size={104} stroke={8} tip={label ?? undefined} />
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold text-text">{label ?? 'Scored'}</p>
                {eligible !== null && <p className="text-caption text-faint">{eligible} eligible checks</p>}
                {breakdown && (
                  <div className="mt-2 space-y-1.5">
                    {(['essential', 'recommended', 'bonus'] as const).map((k) => {
                      const bd = breakdown[k];
                      if (!bd) return null;
                      const earned = bd.earned ?? bd.points ?? 0;
                      const available = bd.available ?? null;
                      const p = available ? Math.max(0, Math.min(1, earned / available)) : null;
                      return (
                        <div key={k} className="flex items-center gap-2 text-caption">
                          <span className="w-24 shrink-0 capitalize text-faint">{k}</span>
                          {p !== null ? (
                            <>
                              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                                <span className="block h-full rounded-full bg-a-ok" style={{ width: `${p * 100}%` }} />
                              </span>
                              <span className="w-14 shrink-0 text-right tabular-nums text-dim">
                                {earned}/{available}
                              </span>
                            </>
                          ) : (
                            <span className="tabular-nums text-dim">{earned} pts</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {reportUrl && (
                  <a
                    href={reportUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-3 inline-block text-eyebrow font-bold uppercase tracking-wide2 text-cognac underline-offset-2 hover:underline"
                  >
                    Full is-agentic report {'↗'}
                  </a>
                )}
              </div>
            </div>
          </Card>
        }
        evidence={
          <Evidence source={`${issues.length} checks · ${failing.length} failing`}>
            <DataTable
              cols={[
                {
                  key: 'r',
                  label: '',
                  w: '18%',
                  render: (i: Record<string, unknown>) => (
                    <span className={i.result === 'failed' ? 'text-a-bad' : i.result === 'passed' ? 'text-a-ok' : 'text-a-warn'}>
                      {String(i.result ?? '')}
                    </span>
                  ),
                },
                { key: 'n', label: 'Check', render: (i: Record<string, unknown>) => <span className="text-dim">{String(i.name ?? i.id ?? '')}</span> },
                { key: 'rec', label: 'Recommendation', render: (i: Record<string, unknown>) => <span className="text-faint">{String(i.recommendation ?? '')}</span> },
              ]}
              rows={issues}
              empty="is-agentic returned no per-check detail"
            />
          </Evidence>
        }
      />
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Analysis
   ════════════════════════════════════════════════════════════════════════ */

export function ReportAnalysis({ audit }: { audit: TechnicalAudit }) {
  return (
    <Panel>
      <Card
        title="Analysis"
        right={audit.narrativeModel ? <span className="text-eyebrow text-faint">{audit.narrativeModel.split('/').pop()}</span> : null}
      >
        {audit.narrative ? (
          <Markdown text={audit.narrative} />
        ) : (
          <Empty>
            No written analysis for this run. It is generated when an OpenRouter key is configured, and carries the
            previous run&rsquo;s reading forward as context.
          </Empty>
        )}
      </Card>
    </Panel>
  );
}

/**
 * Detected technology (wave-6 step 3, surfaced in step 8).
 *
 * Lives beside the technical audit because it answers the same operator
 * question — *what is this site actually built on* — and shares its input, the
 * homepage fetch. It is deliberately **not** folded into the audit score: a CMS
 * is not a defect, and scoring "uses WordPress" would turn a fact into a
 * judgement the rubric cannot defend.
 *
 * Every row shows its own evidence, because a detection without the thing that
 * triggered it is indistinguishable from a guess.
 */
export function ReportStack({ projectId, domain }: { projectId: string; domain: string | null }) {
  const [scan, setScan] = useState<TechStackScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getTechStack(projectId)
      .then(setScan)
      .catch(() => setScan(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(load, [load]);

  const run = async () => {
    setBusy(true);
    try {
      setScan(await runTechStackScan(projectId));
    } catch {
      /* the empty state below already says what to do */
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="v2skel h-28 rounded-r4" />;

  if (!scan) {
    return (
      <div className="max-w-prose space-y-3">
        <p className="text-body leading-relaxed text-faint">
          No technology scan yet for {domain ?? 'this domain'}. Reads the homepage and matches headers,
          markup and script sources against an in-repo signature table — one fetch, nothing external.
        </p>
        <Button type="button" variant="soft" size="sm" onClick={run} disabled={busy}>
          {busy ? 'scanning…' : 'Scan technology'}
        </Button>
      </div>
    );
  }

  if (scan.status === 'failed') {
    return (
      <div className="max-w-prose space-y-2">
        <p className="text-body leading-relaxed text-a-warn">
          The scan could not read {scan.domain}: {scan.error ?? 'unknown error'}
        </p>
        <p className="text-caption leading-relaxed text-faint">
          That is a fetch problem, not a finding about their stack — nothing is inferred from a page
          we could not load.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
          {busy ? 'scanning…' : 'Retry'}
        </Button>
      </div>
    );
  }

  const byCategory = new Map<string, typeof scan.findings>();
  for (const f of scan.findings) {
    const bucket = byCategory.get(f.category);
    if (bucket) bucket.push(f);
    else byCategory.set(f.category, [f]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-body text-dim">
          {scan.findings.length} technolog{scan.findings.length === 1 ? 'y' : 'ies'} detected on{' '}
          {scan.domain}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={run} disabled={busy} className="ml-auto">
          {busy ? 'scanning…' : 'Re-scan'}
        </Button>
      </div>

      {scan.findings.length === 0 ? (
        <p className="max-w-prose text-body leading-relaxed text-faint">
          Nothing matched the signature table. That means the signatures did not fire — not that the
          site uses no technology.
        </p>
      ) : (
        [...byCategory.entries()].map(([category, findings]) => (
          <section key={category}>
            <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
              {category}
            </h3>
            <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
              {findings.map((f) => (
                <li key={`${f.category}:${f.name}`} className="px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-body font-semibold text-text">{f.name}</span>
                    <span className="ml-auto shrink-0 text-caption text-faint">
                      {Math.round(f.confidence * 100)}% confidence
                    </span>
                  </div>
                  {/* The evidence, not a summary of it — a detection you cannot
                      check is indistinguishable from a guess. */}
                  {f.evidence.length > 0 && (
                    <p className="mt-0.5 break-words text-caption leading-relaxed text-faint">
                      {f.evidence.join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
