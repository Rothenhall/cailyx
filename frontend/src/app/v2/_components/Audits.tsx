'use client';

/**
 * Audits — /v2. A chrome-less card between the Flywheel and the Agents Feed.
 *
 * One tile per audit-type module, clubbed here and correctly wired to each
 * one's real data — not the Agents Feed, which stays a mix of unrelated
 * swarm-layer capabilities (Journeys, Personas, Council, …) and is left alone.
 * Digital Presence has its own dedicated card directly above this one, so it
 * is deliberately not repeated here as a tile.
 *
 * SEO and AEO used to fake their tile counts by regex-filtering the
 * *Technical* audit's findings by type — a stand-in from before the real
 * `seo-audit`/`aeo-audit` modules existed. Both now read their own module.
 *
 * Tapping a tile opens that module's full workspace (`onExpand`) rather than
 * showing content in-card — 320px has no room for a real report. Technical,
 * SEO and AEO keep a lightweight in-card fallback for when `onExpand` is not
 * wired up; Tech Stack, Rivals and Keywords do not — they have no natural
 * in-card view and always defer to the full workspace.
 *
 * Tech Stack has no workspace of its own — its data lives in the Technical
 * report's own "Stack" section, so its tile opens Technical.
 *
 * @module app/v2/_components/Audits
 */

import { useCallback, useEffect, useState } from 'react';
import { cleanFindingText } from '@/lib/text';
import {
  getAudit,
  getAuditJob,
  getAeoVerdict,
  getCompetitorGap,
  getSeoAudit,
  getTechStack,
  listAeoAudits,
  listAudits,
  listCompetitorProfiles,
  listKeywordSets,
  listLinkGraphs,
  listSeoAudits,
  runAudit,
} from '@/lib/terminal-api';
import { pollUntilDone } from '@/lib/poll-job';
import type {
  AeoAuditSummary,
  AeoVerdict,
  AuditFinding,
  CompetitorGap,
  CompetitorRow,
  KeywordSet,
  LinkGraph,
  SeoAudit,
  TechStackScan,
  TechnicalAudit,
} from '@/types/terminal';
import { band, tone as toneOf, type ToneKind } from '@/app/v2/_lib/audit';
import { Gauge, Pill } from './TechnicalAuditReport';
import { BarIcon, ChevronLeft, SyncIcon } from './icons';
import { Button } from './Button';

type Tab = 'technical' | 'seo' | 'aeo' | 'tech-stack' | 'competitors' | 'keywords';
/** Where a tile opens when expanded. Tech Stack has no workspace of its own. */
type ExpandTarget = 'technical' | 'seo' | 'aeo' | 'competitors' | 'keywords';
function expandTarget(t: Tab): ExpandTarget {
  return t === 'tech-stack' ? 'technical' : t;
}
type Row = { label: string; value: string; warn?: boolean };

/* Technical leads deliberately: it is the audit that actually runs, and Tech
   Stack rides beside it since its data lives in the same report. SEO/AEO
   follow, then Rivals/Keywords, matching the NavRail's own delivery-flow
   order (audits → competitors → keywords). */
const TABS: Tab[] = ['technical', 'tech-stack', 'seo', 'aeo', 'competitors', 'keywords'];

/** Only Technical/SEO/AEO have an in-card fallback view. */
const HAS_INLINE_VIEW = new Set<Tab>(['technical', 'seo', 'aeo']);

/** the disciplines, as the market names them */
const TAB_META: Record<Tab, { label: string; blurb: string }> = {
  technical: { label: 'Technical', blurb: 'Site audit' },
  'tech-stack': { label: 'Tech Stack', blurb: 'Detected technology' },
  seo: { label: 'SEO', blurb: 'On-page' },
  aeo: { label: 'AEO', blurb: 'Answer-ready & AI visibility' },
  competitors: { label: 'Rivals', blurb: 'Gap vs competitors' },
  keywords: { label: 'Keywords', blurb: 'Demand research' },
};

/** A tile's headline metric + whether it deserves the attention dot. Each
 *  module reports what it actually measures — no invented composite score
 *  where the module has none (tech-stack/keywords/competitors are counts,
 *  not a pass/fail signal). */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

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
  hasRun,
  onRun,
  busy,
}: {
  findings: AuditFinding[];
  /** Whether this discipline has ever produced a run — decoupled from the
   *  Technical-specific `TechnicalAudit` type so SEO/AEO can reuse this. */
  hasRun: boolean;
  /** Omitted disciplines (SEO/AEO) have no run action wired here — they only
   *  say "not run yet", pointing at the full workspace to actually run one. */
  onRun?: () => void;
  busy: boolean;
}) {
  const live = findings.filter((f) => f.status !== 'error');
  const errored = findings.filter((f) => f.status === 'error');
  const crit = live.filter((f) => f.status === 'fail').length;
  const warn = live.filter((f) => f.status === 'warn').length;

  if (!hasRun) {
    return (
      <div className="mt-3">
        <SectionLabel>Issues</SectionLabel>
        <p className="text-body leading-relaxed text-faint">
          No audit has been run for this project yet.
        </p>
        {onRun && (
          <button
            onClick={onRun}
            disabled={busy}
            className="mt-2 rounded-r2 border border-accent-dim px-2 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent-dim/14 disabled:opacity-50"
          >
            {busy ? 'running…' : 'Run the first audit'}
          </button>
        )}
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
   * Open a discipline in the full-canvas workspace instead of in-card.
   * Technical, SEO and AEO also have an in-card fallback for when this is not
   * supplied; Tech Stack, Rivals and Keywords have none and no-op without it.
   */
  onExpand?: (tab: ExpandTarget) => void;
}) {
  /* null = the tile list; a value = that discipline's stats (technical/seo/aeo only) */
  const [tab, setTab] = useState<Tab | null>(null);
  const [audit, setAudit] = useState<TechnicalAudit | null>(null);
  const [graphs, setGraphs] = useState<LinkGraph[] | null>(null);
  const [seoAudit, setSeoAudit] = useState<SeoAudit | null>(null);
  const [aeoAudit, setAeoAudit] = useState<AeoAuditSummary | null>(null);
  const [aeoVerdict, setAeoVerdict] = useState<AeoVerdict | null>(null);
  const [techStack, setTechStack] = useState<TechStackScan | null>(null);
  const [keywordSets, setKeywordSets] = useState<KeywordSet[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorRow[]>([]);
  const [competitorGap, setCompetitorGap] = useState<CompetitorGap | null>(null);
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
      const audits = await listSeoAudits(projectId);
      setSeoAudit(audits[0] ? await getSeoAudit(projectId, audits[0].id) : null);
    } catch {
      setSeoAudit(null);
    }
    try {
      const audits = await listAeoAudits(projectId);
      const latest = audits[0] ?? null;
      setAeoAudit(latest);
      setAeoVerdict(latest ? await getAeoVerdict(projectId, latest.id).catch(() => null) : null);
    } catch {
      setAeoAudit(null);
      setAeoVerdict(null);
    }
    try {
      setTechStack(await getTechStack(projectId));
    } catch {
      setTechStack(null);
    }
    try {
      setKeywordSets(await listKeywordSets(projectId));
    } catch {
      setKeywordSets([]);
    }
    try {
      setCompetitors(await listCompetitorProfiles(projectId));
    } catch {
      setCompetitors([]);
    }
    try {
      setCompetitorGap(await getCompetitorGap(projectId));
    } catch {
      setCompetitorGap(null);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    setAudit(null);
    setGraphs(null);
    setSeoAudit(null);
    setAeoAudit(null);
    setAeoVerdict(null);
    setTechStack(null);
    setKeywordSets([]);
    setCompetitors([]);
    setCompetitorGap(null);
    void load();
  }, [load]);

  const doRunAudit = async () => {
    if (!projectId || !domain || busy) return;
    setBusy(true);
    try {
      // No target URL — the backend audits the project's own domain, so the
      // operator never retypes it and a project rename cannot desync them.
      const { jobId } = await runAudit(projectId);
      const job = await pollUntilDone(() => getAuditJob(projectId, jobId));
      if (job.status === 'failed') throw new Error(job.error || 'audit failed');
      if (job.result) setAudit(job.result);
      onNotify('audit complete');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'audit failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  /* ── derived ───────────────────────────────────────────────────────── */
  const findings = audit?.findings ?? [];
  const techIssues = findings.filter((f) => f.status !== 'pass');
  const graph = graphs?.find((g) => g.status === 'complete') ?? null;

  const title = audit?.pageMetadata?.title ?? null;
  const desc = audit?.pageMetadata?.metaDescription ?? null;
  const h1s = countH1(audit?.pageMetadata?.headings ?? null);
  const fails = findings.filter((f) => f.status === 'fail').length;
  const warns = findings.filter((f) => f.status === 'warn').length;

  const seoFindings = seoAudit?.findings ?? [];
  const seoOpen = seoFindings.filter((f) => f.status !== 'pass');
  const seoFails = seoFindings.filter((f) => f.status === 'fail').length;
  const seoWarns = seoFindings.filter((f) => f.status === 'warn').length;

  const seoRows: Row[] = [
    { label: 'Meta title', value: title ? `${title.length} chars` : '—', warn: (title?.length ?? 0) > 60 || !title },
    { label: 'Meta description', value: desc ? `${desc.length} chars` : '—', warn: (desc?.length ?? 0) > 160 || !desc },
    { label: 'H1 tags', value: h1s === null ? '—' : String(h1s), warn: (h1s ?? 0) !== 1 },
    {
      label: 'Search Console findings',
      value: seoAudit ? `${seoFails} fail · ${seoWarns} warn` : '—',
      warn: seoFails + seoWarns > 0,
    },
  ];

  const aeoOverall = aeoVerdict?.counted.overall ?? null;
  const aeoFailedSurfaces = aeoVerdict?.surfaceRuns.filter((r) => r.status === 'failed').length ?? 0;
  const aeoRows: Row[] = [
    {
      label: 'Mentioned',
      value: aeoOverall ? pct(aeoOverall.mentionRate) : '—',
      warn: !!aeoOverall && aeoOverall.mentionRate < 0.3,
    },
    {
      label: 'Cited',
      value: aeoOverall ? pct(aeoOverall.citationRate) : '—',
      warn: !!aeoOverall && aeoOverall.citationRate < 0.15,
    },
    {
      label: 'Engines measured',
      value: aeoVerdict ? `${aeoVerdict.surfaceRuns.length - aeoFailedSurfaces}/${aeoVerdict.surfaceRuns.length}` : '—',
      warn: aeoFailedSurfaces > 0,
    },
  ];

  const latestKeywordSet = keywordSets[0] ?? null;
  const competitorGapCount =
    (competitorGap?.tech.competitorsOnly.length ?? 0) + (competitorGap?.schema.competitorsOnly.length ?? 0);

  /** Each tile's headline + whether it earns the attention dot. Modules
   *  without a pass/fail signal (tech-stack/keywords/competitors) report a
   *  plain count instead of inventing a score. */
  const tileMetric: Record<Tab, { text: string; warn: boolean }> = {
    technical: {
      text:
        techIssues.length + (graph ? graph.orphanCount + graph.recommendationCount : 0) > 0
          ? `${techIssues.length + (graph ? graph.orphanCount + graph.recommendationCount : 0)} to review`
          : audit
            ? 'clear'
            : 'not run',
      warn: techIssues.length + (graph ? graph.orphanCount + graph.recommendationCount : 0) > 0,
    },
    'tech-stack': {
      text: techStack
        ? techStack.status === 'failed'
          ? 'scan failed'
          : `${techStack.findings.length} detected`
        : 'not scanned',
      warn: techStack?.status === 'failed',
    },
    seo: {
      text: seoAudit ? (seoOpen.length > 0 ? `${seoOpen.length} to review` : 'clear') : 'not run',
      warn: seoOpen.length > 0,
    },
    aeo: {
      text: aeoOverall ? `${pct(aeoOverall.mentionRate)} mentioned` : 'not run',
      warn: aeoFailedSurfaces > 0,
    },
    competitors: {
      text: competitors.length
        ? competitorGapCount > 0
          ? `${competitorGapCount} gaps`
          : `${competitors.length} profiled`
        : 'not profiled',
      warn: competitorGapCount > 0,
    },
    keywords: {
      text: latestKeywordSet ? `${latestKeywordSet.keywords.length} tracked` : 'not researched',
      warn: false,
    },
  };

  const health: { label: string; kind: ToneKind; note: string } = !audit
    ? { label: 'Not measured', kind: 'neutral', note: 'run an audit to populate this card' }
    : fails > 0
      ? {
          label: 'Needs work',
          kind: 'bad',
          note: `${techIssues.length} open issue${techIssues.length === 1 ? '' : 's'} · technical`,
        }
      : warns > 0
        ? { label: 'Minor issues', kind: 'warn', note: `${warns} warning${warns === 1 ? '' : 's'}` }
        : { label: 'Healthy', kind: 'ok', note: 'no open findings' };

  const skeleton = booting || (loading && !audit && !graphs);

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
          {tileMetric[tab].warn && (
            <span className="num ml-auto shrink-0 rounded-full border border-a-warn-line bg-a-warn-soft px-1.5 text-eyebrow text-a-warn">
              {tileMetric[tab].text}
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
          /* ── the six audits, stacked ─────────────────────────────────
             One column, not a grid. Reading order follows the delivery flow
             (NavRail's own ordering): Technical leads because it is the audit
             that actually runs, Tech Stack rides beside it since its data
             lives in the same report, then SEO/AEO, then Rivals/Keywords. A
             single column gives each row the full 320px, so the name, the
             discipline and the metric all fit on one line. */
          <div className="v2-stagger flex flex-col gap-2 p-3">
            {TABS.map((t, i) => {
              const m = tileMetric[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => (onExpand ? onExpand(expandTarget(t)) : HAS_INLINE_VIEW.has(t) ? setTab(t) : undefined)}
                  style={{ ['--i' as string]: i }}
                  className={`relative flex w-full items-center gap-3 rounded-r3 border bg-bg-raised px-3 py-2.5 text-left transition-colors duration-micro hover:border-accent-dim ${
                    m.warn ? 'border-border-strong' : 'border-border'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-display text-title font-semibold text-text">
                        {TAB_META[t].label}
                      </span>
                      {m.warn && <span className="v2-dot v2-dot-attention shrink-0" />}
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-faint">
                      {TAB_META[t].blurb}
                    </span>
                  </span>
                  <span
                    className={`num shrink-0 text-body font-medium tabular-nums ${
                      m.warn ? 'text-a-warn' : 'text-faint'
                    }`}
                  >
                    {m.text}
                  </span>
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0 rotate-180 text-faint" />
                </button>
              );
            })}
          </div>
        ) : (
          <div key={tab} className="v2tab-in p-3">
            {tab === 'seo' && (
              /* Reached only when no onExpand is wired up (the tile jumps
                 straight to the full SEO report otherwise). No run action
                 here — running one lives in that report, not this card. */
              <>
                <SignalTable rows={seoRows} />
                <Issues
                  findings={seoFindings.map((f) => ({
                    id: f.id,
                    type: f.type,
                    status: f.status,
                    severity: f.severity,
                    confidence: 'high',
                    detail: f.detail,
                    recommendedFix: f.recommendedFix,
                  }))}
                  hasRun={!!seoAudit}
                  busy={busy}
                />
              </>
            )}
            {tab === 'aeo' && (
              /* Reached only when no onExpand is wired up (the tile jumps
                 straight to the full AEO report otherwise, same as SEO and
                 Technical) — a plain fallback, not a place to cram both
                 structural and measured content. AEO has no findings list
                 (it's a measurement, not a set of pass/fail checks), so this
                 is just the rate summary. */
              <SignalTable rows={aeoRows} />
            )}
            {tab === 'technical' &&
              (!audit ? (
                <Issues findings={[]} hasRun={false} onRun={doRunAudit} busy={busy} />
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
                  <Issues findings={techIssues} hasRun={!!audit} onRun={doRunAudit} busy={busy} />
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
