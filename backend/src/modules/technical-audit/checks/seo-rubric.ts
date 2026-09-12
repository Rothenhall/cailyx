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
  /**
   * Share of a page's content images that may lack an `alt` attribute before it
   * is a finding. Not zero: one undescribed image on a page of twenty is a
   * typo, and flagging it would bury the page where half the images are
   * undescribed. A page with *any* images and *all* of them missing alt trips
   * regardless of this ratio.
   */
  maxMissingAltRatio: 0.25,
  /**
   * Full URL length. 115 is the conventional practical ceiling cited for SERP
   * display/usability (Backlinko/Moz) — well under the ~2048-char technical
   * limit browsers and servers actually enforce, which is not a useful band
   * for anything a client would act on.
   */
  urlMaxLength: 115,
  /** More than this many query parameters reads as faceted-nav or tracking bloat. */
  urlMaxParams: 3,
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
  'canonical-cross-domain': 18,
  'meta-missing': 15,
  'h1-missing': 12,
  'canonical-malformed': 10,
  'json-ld-invalid': 10,
  'thin-content': 10,
  'duplicate-content': 10,
  'images-missing-alt': 8,
  'title-too-long': 8,
  'title-too-short': 8,
  'canonical-missing': 8,
  'heading-level-skipped': 6,
  'meta-too-long': 6,
  'meta-too-short': 6,
  'h1-multiple': 6,
  'url-excess-params': 5,
  'url-too-long': 4,
  'url-has-uppercase': 4,
  'url-has-underscore': 3,
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
  'canonical-malformed': 'Canonical link does not resolve to a valid URL',
  'canonical-cross-domain': 'Canonical points to a different domain',
  'json-ld-missing': 'No JSON-LD structured data',
  'json-ld-invalid': 'JSON-LD present but does not parse',
  'thin-content': `Under ${SEO_BANDS.minWords} words of body copy`,
  'images-missing-alt': 'Content images with no alt attribute',
  'duplicate-content': 'Body copy identical to another page in this run',
  'heading-level-skipped': 'Heading levels skip a level (e.g. H1 straight to H3)',
  'url-too-long': `URL over ${SEO_BANDS.urlMaxLength} characters`,
  'url-has-uppercase': 'URL path contains uppercase letters',
  'url-has-underscore': 'URL path uses underscores instead of hyphens',
  'url-excess-params': `URL has more than ${SEO_BANDS.urlMaxParams} query parameters`,
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
  /** Content images — decorative ones already excluded by the extractor. */
  imageCount: number;
  /** Of those, how many have no `alt` attribute at all. */
  imagesMissingAlt: number;
  /** This page's own URL, as crawled — the basis for the URL-structure checks
   *  and for resolving a relative canonical. */
  url: string;
  /** The site's own hostname (from the audited `targetUrl`), for the
   *  cross-domain canonical check. `www.` is ignored on both sides. */
  siteHost: string;
  /** Every h1-h6 tag's level, in document order (e.g. [1,2,2,3]) — the basis
   *  for the heading-hierarchy check. */
  headingLevels: number[];
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

  issues.push(...findHeadingIssues(s.headingLevels));
  issues.push(...findCanonicalIssues(s.canonical, s.url, s.siteHost));
  issues.push(...findUrlIssues(s.url));

  if (s.jsonLdCount === 0) issues.push('json-ld-missing');
  else if (!s.jsonLdValid) issues.push('json-ld-invalid');

  if (s.wordCount < SEO_BANDS.minWords) issues.push('thin-content');

  // Missing alt, not empty alt. `alt=""` is the correct, deliberate marker for a
  // decorative image — treating it as a fault would tell a client to "fix"
  // markup that is already right, and would train them to put junk text in it.
  // Only a wholly absent attribute counts, and the extractor has already
  // dropped images the author marked decorative.
  if (s.imageCount > 0 && s.imagesMissingAlt > 0) {
    const ratio = s.imagesMissingAlt / s.imageCount;
    if (ratio > SEO_BANDS.maxMissingAltRatio || s.imagesMissingAlt === s.imageCount) {
      issues.push('images-missing-alt');
    }
  }

  return issues;
}

/**
 * Heading hierarchy: a level may only ever appear once the level above it has
 * been introduced. An H1 followed directly by an H3, with no H2 anywhere in
 * between, is the textbook case (WCAG 2.4.6) — screen-reader users navigate
 * by heading level, and a skipped level reads as a missing section.
 *
 * One flag per page, not one per skip. The site-wide count this rolls up
 * into ({@link summarisePages}) is "how many pages have a broken hierarchy",
 * which is the number a client acts on — counting every individual skip on a
 * badly-templated page would just make that one page's number meaningless.
 *
 * @param levels Every h1-h6 tag's level, in document order.
 */
export function findHeadingIssues(levels: number[]): PageIssueCode[] {
  let deepestIntroduced = 0;
  for (const level of levels) {
    if (level > deepestIntroduced + 1) return ['heading-level-skipped'];
    if (level > deepestIntroduced) deepestIntroduced = level;
  }
  return [];
}

/**
 * Canonical correctness, beyond "is one present".
 *
 * Deliberately narrow: a canonical pointing at a DIFFERENT URL on the same
 * site is routinely correct (pagination, tracking-param stripping, faceted
 * navigation all canonicalise elsewhere on purpose), so flagging that would
 * be a false-positive machine. What is never legitimate is a canonical that
 * cannot be resolved to a real URL at all, or one that resolves to a
 * different domain entirely — the second is a well-known, serious
 * misconfiguration (a leftover staging value, a copy-pasted template) that
 * silently hands the page's ranking signal to someone else's domain.
 *
 * No extra fetch: this reads only the canonical value and the page's own
 * URL, both already on hand from the crawl. Whether the canonical TARGET
 * itself is reachable is a different, more expensive question (it would
 * double the crawl's fetch count) and is out of scope here.
 */
export function findCanonicalIssues(canonical: string | null, pageUrl: string, siteHost: string): PageIssueCode[] {
  if (!canonical || !canonical.trim()) return ['canonical-missing'];

  let resolved: URL;
  try {
    // Relative canonicals ("/services") are valid per spec and resolved
    // against the page's own URL, same as a browser would.
    resolved = new URL(canonical.trim(), pageUrl);
  } catch {
    return ['canonical-malformed'];
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return ['canonical-malformed'];

  const canonicalHost = resolved.hostname.toLowerCase().replace(/^www\./, '');
  const ownHost = siteHost.toLowerCase().replace(/^www\./, '');
  if (ownHost && canonicalHost !== ownHost) return ['canonical-cross-domain'];

  return [];
}

/**
 * URL-structure hygiene. Four independently well-documented best practices
 * (Google's own guidance on hyphens vs underscores; conventional SERP-display
 * length; case-sensitive-URL duplication risk; faceted-nav/tracking-param
 * bloat) — deliberately NOT a broader "URL quality" score, since anything
 * fuzzier than these four would be a threshold this module invented and would
 * have to defend to a client.
 */
export function findUrlIssues(url: string): PageIssueCode[] {
  const issues: PageIssueCode[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return issues; // an unparseable URL is already `page-error` territory elsewhere
  }

  if (url.length > SEO_BANDS.urlMaxLength) issues.push('url-too-long');
  if (/[A-Z]/.test(parsed.pathname)) issues.push('url-has-uppercase');
  if (/_/.test(parsed.pathname)) issues.push('url-has-underscore');
  if ([...parsed.searchParams.keys()].length > SEO_BANDS.urlMaxParams) issues.push('url-excess-params');

  return issues;
}

/**
 * Mark pages whose body copy is identical to another page's in the same run.
 *
 * Cross-page by nature, so it cannot live in {@link findPageIssues} — that
 * function sees one page. Runs after the crawl, over fingerprints the extractor
 * already computed.
 *
 * **Exact matches only.** Near-duplicate detection needs a similarity threshold,
 * and a threshold is a number this module would have to invent and then defend
 * to a client. An exact match is a fact: these two URLs serve the same copy.
 * Every page in a duplicate group is flagged, not just the later ones — without
 * knowing which URL the client considers canonical, calling one "the original"
 * would be a guess.
 *
 * @param pages Fingerprint per page. A null hash (page errored, or no body) is
 *   skipped rather than grouped — an empty page matching another empty page is
 *   not a content duplication finding.
 * @returns URLs that share their copy with at least one other page.
 */
export function findDuplicateContent(pages: Array<{ url: string; contentHash: string | null }>): Set<string> {
  const byHash = new Map<string, string[]>();
  for (const p of pages) {
    if (!p.contentHash) continue;
    const bucket = byHash.get(p.contentHash);
    if (bucket) bucket.push(p.url);
    else byHash.set(p.contentHash, [p.url]);
  }

  const duplicates = new Set<string>();
  for (const urls of byHash.values()) {
    if (urls.length > 1) for (const u of urls) duplicates.add(u);
  }
  return duplicates;
}

/**
 * Fingerprint a page's body copy.
 *
 * Same shape as the one `aeo-context` uses for its SPA dedupe: djb2 over
 * whitespace-normalised text, with the length appended so two different strings
 * that happen to collide still differ. Capped at 4000 chars — enough to
 * distinguish real pages, short enough that a long shared footer cannot make
 * two different pages look identical on length alone.
 */
export function contentFingerprint(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!normalized) return null;
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (Math.imul(hash, 33) ^ normalized.charCodeAt(i)) >>> 0;
  }
  return String(hash) + ':' + normalized.length;
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
    pagesThin: issueCounts['thin-content'] ?? 0,
    pagesWithMissingAlt: issueCounts['images-missing-alt'] ?? 0,
    pagesWithDuplicateContent: issueCounts['duplicate-content'] ?? 0,
    pagesWithHeadingIssues: issueCounts['heading-level-skipped'] ?? 0,
    // Canonical's three codes are mutually exclusive per page (findCanonicalIssues
    // returns at most one), so summing the counts is safe — same reasoning as
    // pagesWithBadTitle/pagesWithBadMeta above.
    pagesWithBadCanonical:
      (issueCounts['canonical-missing'] ?? 0) +
      (issueCounts['canonical-malformed'] ?? 0) +
      (issueCounts['canonical-cross-domain'] ?? 0),
    // URL issues are NOT mutually exclusive — one page can trip several at
    // once (too long AND uppercase, say) — so this counts DISTINCT pages
    // rather than summing issueCounts, which would double-count them.
    pagesWithUrlIssues: pages.filter((p) =>
      p.issues.some((i) => i === 'url-too-long' || i === 'url-has-uppercase' || i === 'url-has-underscore' || i === 'url-excess-params'),
    ).length,
    // Image totals across the crawl. The per-page ratio decides whether a page
    // is *flagged*; these two are what a client actually acts on -- "31 of 212
    // images have no alt text" is a work item, where a list of flagged URLs is
    // a diagnosis. Counted over every crawled page, flagged or not, so the
    // total is the site's real figure and not a sum of only the worst pages.
    imagesTotal: pages.reduce((sum, p) => sum + (p.imageCount ?? 0), 0),
    imagesMissingAlt: pages.reduce((sum, p) => sum + (p.imagesMissingAlt ?? 0), 0),
  };
}
