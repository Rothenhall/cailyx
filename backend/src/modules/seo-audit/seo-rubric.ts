/**
 * SEO audit rubric — pure classification and scoring.
 *
 * No I/O. Everything here turns a Search Analytics row or a URL Inspection
 * result into (a) a stable issue code, (b) a severity, (c) a human fix, and
 * where possible (d) a ready-to-apply artifact. This is the layer that makes
 * the SEO audit *worth paying for* over the raw Search Console UI.
 *
 * @module seo-audit/seo-rubric
 */

import type { SaRow, UrlInspection } from '../google/search-console.service';

/* ── positional CTR baseline ────────────────────────────────────────────
   Rough industry curve (desktop+mobile blended). Used only to flag pages
   whose CTR is far *below* what their ranking should earn — a title / meta
   rewrite opportunity, not a hard number. */
const CTR_CURVE: number[] = [
  0, 0.285, 0.157, 0.11, 0.08, 0.06, 0.047, 0.037, 0.03, 0.025, 0.021,
];
export function expectedCtr(position: number): number {
  if (position < 1) return CTR_CURVE[1];
  const p = Math.min(Math.round(position), 20);
  if (p <= 10) return CTR_CURVE[p];
  // 11-20: decay from ~2% to ~0.6%
  return 0.02 - (p - 10) * 0.0014;
}

/* ── thresholds ─────────────────────────────────────────────────────────── */
export const SEO_BANDS = {
  strikingMinPos: 4.5,
  strikingMaxPos: 20,
  strikingMinImpr: 30, // impressions in the window to be worth chasing
  ctrGapMinImpr: 100,
  ctrGapRatio: 0.5, // actual CTR below half the expected
  moverMinImpr: 20,
  moverPosDelta: 3, // positions gained/lost to count as a move
} as const;

export type QueryOpportunity =
  | 'striking-distance'
  | 'ctr-gap'
  | 'ranking-gain'
  | 'ranking-drop'
  | 'cannibalization';

export interface QueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  topPage: string | null;
  positionDelta: number | null;
  impressionsDelta: number | null;
  clicksDelta: number | null;
  opportunities: QueryOpportunity[];
}

/** Build the per-query rows: current metrics, movement vs the previous window,
    and the opportunity flags. `pagesByQuery` maps a query to the set of pages
    that ranked for it (for cannibalization). */
export function buildQueryRows(
  current: SaRow[],
  previous: SaRow[],
  pagesByQuery: Map<string, Set<string>>,
): QueryRow[] {
  const prev = new Map(previous.map((r) => [r.keys[0], r]));

  return current
    .map((r) => {
      const q = r.keys[0];
      const p = prev.get(q);
      const positionDelta = p ? round(p.position - r.position, 1) : null; // + = improved
      const impressionsDelta = p ? r.impressions - p.impressions : null;
      const clicksDelta = p ? r.clicks - p.clicks : null;
      const pages = pagesByQuery.get(q);
      const topPage = r.keys[1] ?? null;

      const opportunities: QueryOpportunity[] = [];
      if (
        r.position >= SEO_BANDS.strikingMinPos &&
        r.position <= SEO_BANDS.strikingMaxPos &&
        r.impressions >= SEO_BANDS.strikingMinImpr
      ) {
        opportunities.push('striking-distance');
      }
      if (
        r.impressions >= SEO_BANDS.ctrGapMinImpr &&
        r.ctr > 0 &&
        r.ctr < expectedCtr(r.position) * SEO_BANDS.ctrGapRatio
      ) {
        opportunities.push('ctr-gap');
      }
      if (positionDelta !== null && r.impressions >= SEO_BANDS.moverMinImpr) {
        if (positionDelta >= SEO_BANDS.moverPosDelta) opportunities.push('ranking-gain');
        else if (positionDelta <= -SEO_BANDS.moverPosDelta) opportunities.push('ranking-drop');
      }
      if (pages && pages.size >= 2) opportunities.push('cannibalization');

      return {
        query: q,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: round(r.position, 1),
        topPage,
        positionDelta,
        impressionsDelta,
        clicksDelta,
        opportunities,
      };
    })
    .filter((r) => r.query);
}

/* ── per-page issues from URL Inspection ────────────────────────────────── */

export type PageIssueCode =
  | 'not-indexed-crawled'
  | 'not-indexed-discovered'
  | 'duplicate-alt-canonical'
  | 'canonical-mismatch'
  | 'noindex'
  | 'blocked-robots'
  | 'redirect'
  | 'soft-404'
  | 'server-error'
  | 'not-found'
  | 'blocked-4xx'
  | 'breadcrumb-issue'
  | 'rich-result-issue';

export interface PageIssue {
  code: PageIssueCode;
  severity: 'critical' | 'high' | 'medium' | 'low';
  detail: string;
  fix: string;
  /** ready-to-apply snippet, when there is one */
  fixArtifact?: string;
}

const norm = (s: string | null) => (s ?? '').toLowerCase();

export function classifyPage(url: string, insp: UrlInspection): PageIssue[] {
  const out: PageIssue[] = [];
  const cov = norm(insp.coverageState);
  const idxState = norm(insp.indexingState);
  const fetchState = norm(insp.pageFetchState);

  // ── indexing verdict ──────────────────────────────────────────────
  if (idxState.includes('blocked_by_robots') || norm(insp.robotsTxtState) === 'disallowed') {
    out.push({
      code: 'blocked-robots',
      severity: 'critical',
      detail: `robots.txt is blocking Googlebot from ${path(url)}.`,
      fix: `Remove the Disallow rule that matches ${path(url)} from robots.txt (or scope it tighter). Then request a recrawl.`,
    });
  } else if (idxState.includes('blocked_by_meta_tag') || cov.includes("noindex")) {
    out.push({
      code: 'noindex',
      severity: 'critical',
      detail: `${path(url)} carries a noindex directive, so Google will not index it.`,
      fix: `Remove \`<meta name="robots" content="noindex">\` (and any \`X-Robots-Tag: noindex\` header) from ${path(url)} if it should rank.`,
      fixArtifact: '<meta name="robots" content="index, follow" />',
    });
  } else if (idxState.includes('blocked_by_http_header')) {
    out.push({
      code: 'noindex',
      severity: 'critical',
      detail: `An X-Robots-Tag HTTP header on ${path(url)} is blocking indexing.`,
      fix: `Drop the \`X-Robots-Tag: noindex\` response header for this path.`,
    });
  } else if (cov.includes('crawled') && cov.includes('not indexed')) {
    out.push({
      code: 'not-indexed-crawled',
      severity: 'high',
      detail: `Google crawled ${path(url)} but chose not to index it — usually thin, near-duplicate, or low-value content.`,
      fix: `Add unique, substantive content and a clear primary purpose; add Article/Product/FAQ JSON-LD; strengthen internal links pointing here with descriptive anchor text.`,
    });
  } else if (cov.includes('discovered') && cov.includes('not indexed')) {
    out.push({
      code: 'not-indexed-discovered',
      severity: 'high',
      detail: `Google knows about ${path(url)} but has not crawled it — often a crawl-budget or internal-linking signal.`,
      fix: `Link to this page from a few already-indexed pages, make sure it is in the sitemap, and re-submit the sitemap.`,
    });
  } else if (cov.includes('duplicate') && cov.includes('canonical')) {
    out.push({
      code: 'duplicate-alt-canonical',
      severity: 'medium',
      detail: `Google treats ${path(url)} as a duplicate and did not pick your declared canonical${
        insp.googleCanonical ? ` — it indexed ${path(insp.googleCanonical)} instead` : ''
      }.`,
      fix: `If ${path(url)} is the version you want indexed, make its content clearly distinct and ensure it self-references \`<link rel="canonical">\`. Otherwise accept Google's choice and 301 this URL to it.`,
      fixArtifact: `<link rel="canonical" href="${url}" />`,
    });
  } else if (cov.includes('alternate page') && cov.includes('canonical')) {
    out.push({
      code: 'duplicate-alt-canonical',
      severity: 'low',
      detail: `${path(url)} is an alternate of ${path(insp.googleCanonical ?? '')} and correctly points its canonical there. No action needed unless this page should rank in its own right.`,
      fix: `No action — this is expected canonicalisation.`,
    });
  } else if (cov.includes('redirect')) {
    out.push({
      code: 'redirect',
      severity: 'medium',
      detail: `${path(url)} redirects. Search Console and your sitemap should point at the final URL, not the redirect.`,
      fix: `Update the sitemap entry and any internal links to the destination URL.`,
    });
  } else if (cov.includes('soft 404')) {
    out.push({
      code: 'soft-404',
      severity: 'medium',
      detail: `Google classes ${path(url)} as a soft 404 — it returns 200 but looks empty / error-like.`,
      fix: `Either return real content with a 200, or return a genuine 404/410 if the page is gone.`,
    });
  } else if (fetchState.includes('server error') || fetchState.includes('5xx')) {
    out.push({
      code: 'server-error',
      severity: 'critical',
      detail: `Googlebot's last fetch of ${path(url)} returned a server error.`,
      fix: `Check server logs for this path; make sure it responds 200 to the Googlebot user-agent.`,
    });
  } else if (fetchState.includes('not found') || fetchState.includes('404')) {
    out.push({
      code: 'not-found',
      severity: 'high',
      detail: `${path(url)} returns 404 but is still in your sitemap / linked internally.`,
      fix: `Remove it from the sitemap and fix internal links, or restore the page / 301 it to a relevant one.`,
    });
  } else if (fetchState.includes('blocked') || fetchState.includes('access denied') || fetchState.includes('4xx')) {
    out.push({
      code: 'blocked-4xx',
      severity: 'high',
      detail: `Googlebot got a 4xx (auth / access denied) fetching ${path(url)}.`,
      fix: `Ensure the page is publicly reachable without a login or IP allow-list for Googlebot.`,
    });
  }

  // ── declared vs chosen canonical mismatch (independent of coverage) ──
  if (
    insp.userCanonical &&
    insp.googleCanonical &&
    !sameUrl(insp.userCanonical, insp.googleCanonical) &&
    !out.some((i) => i.code === 'duplicate-alt-canonical')
  ) {
    out.push({
      code: 'canonical-mismatch',
      severity: 'medium',
      detail: `You declared canonical ${path(insp.userCanonical)} but Google chose ${path(insp.googleCanonical)}.`,
      fix: `Reconcile the two: point ${path(url)} at the URL you actually want indexed, and make sure that target 200s and self-canonicalises.`,
      fixArtifact: `<link rel="canonical" href="${insp.googleCanonical}" />`,
    });
  }

  // ── rich results / breadcrumbs ─────────────────────────────────────
  for (const item of insp.richResultItems) {
    const bad = item.issues.filter((i) => norm(i.severity) === 'error' || norm(i.severity) === 'warning');
    if (!bad.length) continue;
    const isCrumb = /breadcrumb/i.test(item.type);
    out.push({
      code: isCrumb ? 'breadcrumb-issue' : 'rich-result-issue',
      severity: bad.some((i) => norm(i.severity) === 'error') ? 'medium' : 'low',
      detail: `${item.type} on ${path(url)}: ${bad.map((i) => i.message).slice(0, 3).join('; ')}.`,
      fix: isCrumb
        ? `Fix the BreadcrumbList JSON-LD: every itemListElement needs a numbered "position", a "name", and an "item" URL (absolute), in crawl order from home to this page.`
        : `Fix the flagged properties in the ${item.type} structured data and re-test in the Rich Results Test.`,
      fixArtifact: isCrumb ? breadcrumbTemplate(url) : undefined,
    });
  }

  return out;
}

/* ── grouped findings ──────────────────────────────────────────────────── */

export interface SeoFindingDraft {
  type: string;
  status: 'fail' | 'warn' | 'pass';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  recommendedFix: string;
  affected: string[];
  fixArtifact: string | null;
  action: string | null;
}

/** Roll per-page issues + per-query opportunities into the "fix these" list. */
export function buildFindings(
  pageIssues: Array<{ url: string; issues: PageIssue[] }>,
  queries: QueryRow[],
  sitemaps: Array<{ path: string; errors: number; warnings: number }>,
): SeoFindingDraft[] {
  const out: SeoFindingDraft[] = [];
  const bySeverity = { critical: 0, high: 1, medium: 2, low: 3 } as const;

  // group page issues by code
  const groups = new Map<PageIssueCode, { urls: string[]; sample: PageIssue }>();
  for (const { url, issues } of pageIssues) {
    for (const iss of issues) {
      if (iss.code === 'duplicate-alt-canonical' && iss.severity === 'low') continue; // expected
      const g = groups.get(iss.code) ?? { urls: [], sample: iss };
      g.urls.push(url);
      if (bySeverity[iss.severity] < bySeverity[g.sample.severity]) g.sample = iss;
      groups.set(iss.code, g);
    }
  }
  for (const [code, g] of groups) {
    out.push({
      type: pageIssueType(code),
      status: g.sample.severity === 'low' ? 'warn' : 'fail',
      severity: g.sample.severity,
      title: `${g.urls.length} page${g.urls.length === 1 ? '' : 's'}: ${titleFor(code)}`,
      detail: g.sample.detail,
      recommendedFix: g.sample.fix,
      affected: g.urls.slice(0, 100),
      fixArtifact: g.sample.fixArtifact ?? null,
      action: code === 'not-indexed-discovered' ? 'submit-sitemap' : null,
    });
  }

  // query opportunities
  const striking = queries.filter((q) => q.opportunities.includes('striking-distance'));
  if (striking.length) {
    const top = [...striking].sort((a, b) => b.impressions - a.impressions).slice(0, 15);
    out.push({
      type: 'striking-distance',
      status: 'warn',
      severity: 'high',
      title: `${striking.length} striking-distance quer${striking.length === 1 ? 'y' : 'ies'} (pos 5–20, real demand)`,
      detail: `These rank on page 1–2 with meaningful impressions. Small on-page gains here convert straight into clicks: e.g. "${top[0].query}" at position ${top[0].position} with ${top[0].impressions} impressions.`,
      recommendedFix: `For each: make sure the ranking page targets the query in its <title> and an H2, add 1–2 internal links with the query as anchor text, and expand the section that answers it.`,
      affected: top.map((q) => `${q.query} — pos ${q.position} — ${q.topPage ?? ''}`),
      fixArtifact: null,
      action: null,
    });
  }
  const ctrGap = queries.filter((q) => q.opportunities.includes('ctr-gap'));
  if (ctrGap.length) {
    const top = [...ctrGap].sort((a, b) => b.impressions - a.impressions).slice(0, 15);
    out.push({
      type: 'ctr-gap',
      status: 'warn',
      severity: 'medium',
      title: `${ctrGap.length} quer${ctrGap.length === 1 ? 'y' : 'ies'} ranking well but under-clicked`,
      detail: `CTR is well below what the position should earn — the title / description isn't compelling for the intent. e.g. "${top[0].query}" at position ${top[0].position} gets ${(top[0].ctr * 100).toFixed(1)}% CTR.`,
      recommendedFix: `Rewrite the <title> and meta description of the ranking page to lead with the query's intent and a concrete benefit / number. Keep title ≤ 60 chars, description 70–155.`,
      affected: top.map((q) => `${q.query} — pos ${q.position} — ${(q.ctr * 100).toFixed(1)}% CTR — ${q.topPage ?? ''}`),
      fixArtifact: null,
      action: null,
    });
  }
  const drops = queries.filter((q) => q.opportunities.includes('ranking-drop'));
  if (drops.length) {
    const top = [...drops].sort((a, b) => (a.positionDelta ?? 0) - (b.positionDelta ?? 0)).slice(0, 15);
    out.push({
      type: 'ranking-drop',
      status: 'fail',
      severity: 'high',
      title: `${drops.length} quer${drops.length === 1 ? 'y' : 'ies'} dropped ≥ 3 positions`,
      detail: `e.g. "${top[0].query}" fell ${Math.abs(top[0].positionDelta ?? 0)} to position ${top[0].position} since the last run.`,
      recommendedFix: `Check the ranking page for recent content changes, lost backlinks, or a stronger competitor result. Refresh the page (freshen facts, expand, re-date) and rebuild internal links to it.`,
      affected: top.map((q) => `${q.query} — ${top[0].positionDelta! > 0 ? '+' : ''}${q.positionDelta} → pos ${q.position}`),
      fixArtifact: null,
      action: null,
    });
  }
  const cannibal = queries.filter((q) => q.opportunities.includes('cannibalization'));
  if (cannibal.length) {
    out.push({
      type: 'cannibalization',
      status: 'warn',
      severity: 'medium',
      title: `${cannibal.length} quer${cannibal.length === 1 ? 'y' : 'ies'} with multiple pages competing`,
      detail: `More than one of your pages ranks for the same query, splitting authority and confusing Google's choice.`,
      recommendedFix: `Pick the page that should own each query; canonical or 301 the others to it, or differentiate their intent and interlink them with clear anchors.`,
      affected: cannibal.slice(0, 15).map((q) => q.query),
      fixArtifact: null,
      action: null,
    });
  }

  // sitemap health
  const badSm = sitemaps.filter((s) => s.errors > 0);
  if (badSm.length) {
    out.push({
      type: 'sitemap',
      status: 'fail',
      severity: 'high',
      title: `${badSm.length} sitemap${badSm.length === 1 ? '' : 's'} with errors in Search Console`,
      detail: badSm.map((s) => `${s.path} (${s.errors} errors, ${s.warnings} warnings)`).join('; '),
      recommendedFix: `Open Search Console → Sitemaps, read the specific errors, fix the offending <loc> entries (usually 404s, non-canonical, or blocked URLs), then re-submit.`,
      affected: badSm.map((s) => s.path),
      fixArtifact: null,
      action: 'submit-sitemap',
    });
  }

  return out.sort((a, b) => bySeverity[a.severity] - bySeverity[b.severity]);
}

/* ── composite score ───────────────────────────────────────────────────── */

export function scoreAudit(
  pagesInspected: number,
  pageIssues: Array<{ url: string; issues: PageIssue[] }>,
  queries: QueryRow[],
): number {
  let score = 100;
  const flat = pageIssues.flatMap((p) => p.issues);
  const w = { critical: 14, high: 8, medium: 4, low: 1 } as const;
  for (const i of flat) score -= w[i.severity];

  // opportunity drag — real demand left on the table
  const striking = queries.filter((q) => q.opportunities.includes('striking-distance')).length;
  const ctrGap = queries.filter((q) => q.opportunities.includes('ctr-gap')).length;
  score -= Math.min(15, striking * 1.5);
  score -= Math.min(10, ctrGap * 1.5);

  // scale the page penalty by coverage so a 5-page sample isn't as harsh as 150
  if (pagesInspected > 0 && pagesInspected < 20) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function path(u: string): string {
  try {
    return new URL(u).pathname || u;
  } catch {
    return u;
  }
}
function sameUrl(a: string, b: string): boolean {
  const clean = (s: string) => s.replace(/\/$/, '').replace(/^https?:\/\//, '').toLowerCase();
  return clean(a) === clean(b);
}
function pageIssueType(code: PageIssueCode): string {
  if (code === 'noindex') return 'noindex';
  if (code === 'blocked-robots') return 'robots';
  if (code === 'canonical-mismatch' || code === 'duplicate-alt-canonical') return 'canonical';
  if (code === 'redirect') return 'redirect';
  if (code === 'soft-404') return 'soft-404';
  if (code === 'breadcrumb-issue') return 'breadcrumb';
  if (code === 'rich-result-issue') return 'rich-result';
  if (code === 'server-error' || code === 'not-found' || code === 'blocked-4xx') return 'crawl';
  return 'indexing';
}
function titleFor(code: PageIssueCode): string {
  const m: Record<PageIssueCode, string> = {
    'not-indexed-crawled': 'crawled but not indexed',
    'not-indexed-discovered': 'discovered but not crawled',
    'duplicate-alt-canonical': 'duplicate — Google picked another canonical',
    'canonical-mismatch': 'declared canonical ignored by Google',
    noindex: 'blocked from indexing (noindex)',
    'blocked-robots': 'blocked by robots.txt',
    redirect: 'URL redirects',
    'soft-404': 'soft 404',
    'server-error': 'server error on Googlebot fetch',
    'not-found': '404 but still referenced',
    'blocked-4xx': '4xx / access denied to Googlebot',
    'breadcrumb-issue': 'BreadcrumbList structured-data issue',
    'rich-result-issue': 'rich-result structured-data issue',
  };
  return m[code];
}
function breadcrumbTemplate(url: string): string {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    /* keep '' */
  }
  return JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin || 'https://example.com' },
        { '@type': 'ListItem', position: 2, name: 'Section', item: `${origin}/section` },
        { '@type': 'ListItem', position: 3, name: 'This page', item: url },
      ],
    },
    null,
    2,
  );
}
