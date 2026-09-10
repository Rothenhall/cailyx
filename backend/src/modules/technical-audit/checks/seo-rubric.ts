/**
 * Per-page SEO rubric — pure, deterministic, no I/O.
 *
 * Every page in the sitemap is scored by exactly this function, so two runs
 * over unchanged HTML produce an identical number and a run-over-run delta
 * means a real content change rather than scorer drift. That is the same
 * determinism rule page-analysis follows; keep it that way — if a signal needs
 * a network call or a model, it belongs in the check, not in here.
 *
 * The bands are the ones the transcript asks for ("ideal lengths of the title,
 * the meta description"), taken at their conventional SERP-truncation values
 * rather than invented:
 *
 *   title   30-60 chars   — under 30 wastes the slot, over ~60 truncates
 *   meta    70-160 chars  — under 70 wastes it, over 160 truncates
 *   h1      exactly 1
 *   content >= 150 words  — below that a page rarely answers anything
 *
 * @module technical-audit/checks/seo-rubric
 */

import type { AuditPageResult, PageIssueCode } from '../technical-audit.types';

/** Disclosed bands. Exported so the API can tell a client what it was judged against. */
export const SEO_BANDS = {
  titleMin: 30,
  titleMax: 60,
  metaMin: 70,
  metaMax: 160,
  minWords: 150,
} as const;

/**
 * Deductions per issue. They do not sum to 100 — a page can trip several — so
 * the score is clamped at 0. Weights are ordered by how much each actually
 * costs an AI crawler trying to use the page: no structured data and no title
 * hurt most, a slightly long meta description hurts least.
 */
export const SEO_DEDUCTIONS: Record<PageIssueCode, number> = {
  'page-error': 100,
  'noindex': 100,
  'json-ld-missing': 20,
  'title-missing': 20,
  'meta-missing': 15,
  'h1-missing': 12,
  'json-ld-invalid': 10,
  'thin-content': 10,
  'title-too-long': 8,
  'title-too-short': 8,
  'canonical-missing': 8,
  'meta-too-long': 6,
  'meta-too-short': 6,
  'h1-multiple': 6,
};

/** Human labels for the issue codes — the UI renders these, never the raw code. */
export const ISSUE_LABELS: Record<PageIssueCode, string> = {
  'page-error': 'Page did not return 200',
  'noindex': 'Page is marked noindex',
  'title-missing': 'No <title>',
  'title-too-short': `Title under ${SEO_BANDS.titleMin} characters`,
  'title-too-long': `Title over ${SEO_BANDS.titleMax} characters`,
  'meta-missing': 'No meta description',
  'meta-too-short': `Meta description under ${SEO_BANDS.metaMin} characters`,
  'meta-too-long': `Meta description over ${SEO_BANDS.metaMax} characters`,
  'h1-missing': 'No H1',
  'h1-multiple': 'More than one H1',
  'canonical-missing': 'No canonical link',
  'json-ld-missing': 'No JSON-LD structured data',
  'json-ld-invalid': 'JSON-LD present but does not parse',
  'thin-content': `Under ${SEO_BANDS.minWords} words of body copy`,
};

/** What a page must look like to be scored. Everything optional is "not found". */
export interface PageSignals {
  status: number;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  canonical: string | null;
  wordCount: number;
  jsonLdCount: number;
  jsonLdValid: boolean;
  noindex: boolean;
}

/**
 * Derive the issue list for a page. Order is stable (rubric order, not
 * discovery order) so a persisted `issues` array can be compared literally
 * between runs.
 */
export function findPageIssues(s: PageSignals): PageIssueCode[] {
  const issues: PageIssueCode[] = [];

  // A page that did not load cannot be judged on anything else — the other
  // signals would all be absent and would pile on misleading deductions.
  if (s.status === 0 || s.status >= 400) return ['page-error'];
  if (s.noindex) issues.push('noindex');

  const t = s.title?.trim() ?? '';
  if (!t) issues.push('title-missing');
  else if (t.length < SEO_BANDS.titleMin) issues.push('title-too-short');
  else if (t.length > SEO_BANDS.titleMax) issues.push('title-too-long');

  const m = s.metaDescription?.trim() ?? '';
  if (!m) issues.push('meta-missing');
  else if (m.length < SEO_BANDS.metaMin) issues.push('meta-too-short');
  else if (m.length > SEO_BANDS.metaMax) issues.push('meta-too-long');

  if (s.h1Count === 0) issues.push('h1-missing');
  else if (s.h1Count > 1) issues.push('h1-multiple');

  if (!s.canonical) issues.push('canonical-missing');

  if (s.jsonLdCount === 0) issues.push('json-ld-missing');
  else if (!s.jsonLdValid) issues.push('json-ld-invalid');

  if (s.wordCount < SEO_BANDS.minWords) issues.push('thin-content');

  return issues;
}

/** 100 minus the deductions for each issue, clamped to 0. */
export function scorePage(issues: PageIssueCode[]): number {
  const total = issues.reduce((sum, i) => sum + (SEO_DEDUCTIONS[i] ?? 0), 0);
  return Math.max(0, 100 - total);
}

/**
 * Roll a set of page results into the run-level shape. Pages that errored are
 * excluded from `averageScore` — averaging a 502 into a content score would
 * make an outage look like an SEO regression.
 */
export function summarisePages(pages: AuditPageResult[], discovered: number, budget: number) {
  const ok = pages.filter((p) => !p.issues.includes('page-error'));
  const issueCounts: Record<string, number> = {};
  for (const p of pages) for (const i of p.issues) issueCounts[i] = (issueCounts[i] ?? 0) + 1;

  const worstPages = [...ok]
    .sort((a, b) => a.score - b.score || a.url.localeCompare(b.url))
    .slice(0, 20)
    .map((p) => ({ url: p.url, score: p.score, issues: p.issues }));

  return {
    discovered,
    crawled: pages.length,
    budget,
    ok: ok.length,
    errored: pages.length - ok.length,
    averageScore: ok.length
      ? Math.round(ok.reduce((s, p) => s + p.score, 0) / ok.length)
      : null,
    issueCounts,
    worstPages,
    pagesWithoutJsonLd: issueCounts['json-ld-missing'] ?? 0,
    pagesWithBadTitle:
      (issueCounts['title-missing'] ?? 0) +
      (issueCounts['title-too-short'] ?? 0) +
      (issueCounts['title-too-long'] ?? 0),
    pagesWithBadMeta:
      (issueCounts['meta-missing'] ?? 0) +
      (issueCounts['meta-too-short'] ?? 0) +
      (issueCounts['meta-too-long'] ?? 0),
  };
}
