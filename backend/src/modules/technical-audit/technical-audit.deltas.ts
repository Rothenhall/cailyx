/**
 * Run-over-run comparison.
 *
 * A single audit tells you the state of a site. Two audits tell you whether
 * anyone is doing anything about it — which is the actual question a retainer
 * client asks. This module reduces a run to a flat bag of named metrics, then
 * diffs two bags.
 *
 * The registry below is the contract: `key` is stable and safe to chart, and
 * `higherIsBetter` is carried with the metric rather than inferred at the UI,
 * because the set mixes both directions (a score should rise, LCP should fall)
 * and getting that wrong paints a regression green.
 *
 * Pure functions only — no Prisma, no I/O — so this is directly testable.
 *
 * @module technical-audit/deltas
 */

import type {
  AuditComparison,
  AuditDelta,
  AuditFinding,
  AuditPageResult,
  DeltaDirection,
} from './technical-audit.types';

/** A run reduced to the shape the differ needs. */
export interface ComparableRun {
  id: string;
  createdAt: string;
  score: number | null;
  findings: Array<Pick<AuditFinding, 'type' | 'status' | 'severity'> & { detail: unknown }>;
  pages: Array<Pick<AuditPageResult, 'url' | 'score' | 'issues'>>;
}

interface MetricDef {
  key: string;
  label: string;
  higherIsBetter: boolean;
  /** Pull the value out of a run. Null means "not measured this run". */
  read: (run: ComparableRun) => number | null;
}

/** Read a numeric field out of a finding's `detail`, whatever shape it arrived in. */
function detailNumber(run: ComparableRun, type: string, path: string[]): number | null {
  const f = run.findings.find((x) => x.type === type);
  if (!f) return null;
  let cur: unknown = f.detail;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

function countPageIssue(run: ComparableRun, code: string): number | null {
  if (!run.pages.length) return null;
  return run.pages.filter((p) => p.issues.includes(code as never)).length;
}

export const METRICS: MetricDef[] = [
  {
    key: 'composite',
    label: 'Overall audit score',
    higherIsBetter: true,
    read: (r) => r.score,
  },
  {
    key: 'openFailures',
    label: 'Failing checks',
    higherIsBetter: false,
    read: (r) => r.findings.filter((f) => f.status === 'fail').length,
  },
  {
    key: 'agentReadiness',
    label: 'Agent readiness (is-agentic)',
    higherIsBetter: true,
    read: (r) => detailNumber(r, 'agent-readiness', ['score']),
  },
  {
    key: 'lighthousePerformance',
    label: 'Lighthouse performance',
    higherIsBetter: true,
    read: (r) => detailNumber(r, 'cwv', ['categories', 'performance']),
  },
  {
    key: 'lighthouseSeo',
    label: 'Lighthouse SEO',
    higherIsBetter: true,
    read: (r) => detailNumber(r, 'cwv', ['categories', 'seo']),
  },
  {
    key: 'lighthouseAccessibility',
    label: 'Lighthouse accessibility',
    higherIsBetter: true,
    read: (r) => detailNumber(r, 'cwv', ['categories', 'accessibility']),
  },
  { key: 'lcp', label: 'LCP (ms)', higherIsBetter: false, read: (r) => detailNumber(r, 'cwv', ['lcp']) },
  { key: 'cls', label: 'CLS', higherIsBetter: false, read: (r) => detailNumber(r, 'cwv', ['cls']) },
  { key: 'inp', label: 'INP (ms)', higherIsBetter: false, read: (r) => detailNumber(r, 'cwv', ['inp']) },
  {
    key: 'sitemapUrls',
    label: 'URLs in sitemap',
    higherIsBetter: true,
    read: (r) => detailNumber(r, 'sitemap', ['urlCount']),
  },
  {
    key: 'sitemapStaleDays',
    label: 'Days since sitemap last changed',
    higherIsBetter: false,
    read: (r) => detailNumber(r, 'sitemap', ['staleDays']),
  },
  {
    key: 'pageAverageScore',
    label: 'Average page score',
    higherIsBetter: true,
    read: (r) => detailNumber(r, 'page-inventory', ['averageScore']),
  },
  {
    key: 'pagesWithoutJsonLd',
    label: 'Pages with no JSON-LD',
    higherIsBetter: false,
    read: (r) => countPageIssue(r, 'json-ld-missing'),
  },
  {
    key: 'pagesBadTitle',
    label: 'Pages with a title problem',
    higherIsBetter: false,
    read: (r) =>
      r.pages.length
        ? r.pages.filter((p) =>
            p.issues.some((i) => i === 'title-missing' || i === 'title-too-long' || i === 'title-too-short'),
          ).length
        : null,
  },
  {
    key: 'pagesBadMeta',
    label: 'Pages with a meta-description problem',
    higherIsBetter: false,
    read: (r) =>
      r.pages.length
        ? r.pages.filter((p) =>
            p.issues.some((i) => i === 'meta-missing' || i === 'meta-too-long' || i === 'meta-too-short'),
          ).length
        : null,
  },
  {
    key: 'blockedBots',
    label: 'AI crawlers blocked at the CDN',
    higherIsBetter: false,
    read: (r) => {
      const f = r.findings.find((x) => x.type === 'cdn-inferred');
      const d = f?.detail as { blockedBots?: unknown[] } | undefined;
      return Array.isArray(d?.blockedBots) ? d!.blockedBots!.length : null;
    },
  },
];

function direction(prev: number | null, cur: number | null, higherIsBetter: boolean): DeltaDirection {
  if (cur === null) return 'unchanged';
  if (prev === null) return 'new';
  if (cur === prev) return 'unchanged';
  const rose = cur > prev;
  return rose === higherIsBetter ? 'improved' : 'regressed';
}

/**
 * Diff two runs across the registry. Metrics neither run measured are dropped
 * entirely, so an audit that could not reach PSI does not report a wall of
 * empty rows.
 */
export function computeDeltas(current: ComparableRun, previous: ComparableRun | null): AuditDelta[] {
  const out: AuditDelta[] = [];
  for (const m of METRICS) {
    const cur = m.read(current);
    const prev = previous ? m.read(previous) : null;
    if (cur === null && prev === null) continue;

    out.push({
      metric: m.key,
      label: m.label,
      previous: prev,
      current: cur,
      change: cur !== null && prev !== null ? round(cur - prev) : null,
      direction: direction(prev, cur, m.higherIsBetter),
      higherIsBetter: m.higherIsBetter,
    });
  }
  return out;
}

/** CLS is fractional; everything else is whole. Avoid float noise in the diff. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Page-level churn between two runs, joined on URL. */
export function comparePages(current: ComparableRun, previous: ComparableRun | null): AuditComparison['pageChanges'] {
  const curMap = new Map(current.pages.map((p) => [p.url, p]));
  const prevMap = new Map((previous?.pages ?? []).map((p) => [p.url, p]));

  const added = [...curMap.keys()].filter((u) => !prevMap.has(u));
  const removed = [...prevMap.keys()].filter((u) => !curMap.has(u));

  const improved: Array<{ url: string; from: number; to: number }> = [];
  const regressed: Array<{ url: string; from: number; to: number }> = [];
  for (const [url, cur] of curMap) {
    const prev = prevMap.get(url);
    if (!prev || prev.score === cur.score) continue;
    (cur.score > prev.score ? improved : regressed).push({ url, from: prev.score, to: cur.score });
  }

  const bySwing = (a: { from: number; to: number }, b: { from: number; to: number }) =>
    Math.abs(b.to - b.from) - Math.abs(a.to - a.from);

  return {
    added: added.slice(0, 100),
    removed: removed.slice(0, 100),
    improved: improved.sort(bySwing).slice(0, 50),
    regressed: regressed.sort(bySwing).slice(0, 50),
  };
}

export function buildComparison(current: ComparableRun, previous: ComparableRun | null): AuditComparison {
  return {
    currentAuditId: current.id,
    previousAuditId: previous?.id ?? null,
    currentAt: current.createdAt,
    previousAt: previous?.createdAt ?? null,
    deltas: computeDeltas(current, previous),
    pageChanges: comparePages(current, previous),
  };
}
