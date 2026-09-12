/**
 * Page inventory — fetch the sitemap's URLs and score each one.
 *
 * This is the check that turns a homepage audit into a site audit: JSON-LD
 * presence, title and meta-description lengths, H1 count, canonical and thin
 * content, per URL, against the disclosed rubric in seo-rubric.ts.
 *
 * Two deliberate limits:
 *
 * - **Budget.** "Every page" is unbounded, and a 5,000-URL sitemap is hours of
 *   fetching. Pages are ordered by `<lastmod>` newest-first and the first
 *   `budget` are taken, so a truncated run audits what actually changed rather
 *   than whatever the sitemap happened to list first. `discovered` vs
 *   `crawled` is reported so a truncated run is self-describing.
 * - **Server HTML only.** Each page is fetched, not rendered. Rendering every
 *   page in Playwright is minutes per hundred pages; the *site-wide* JS
 *   dependency question is already answered by the js-render check against the
 *   homepage, and per-page rendering is the natural next escalation if that
 *   check fails.
 *
 * @module technical-audit/checks/page-inventory
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FetcherService } from '../../fetcher/fetcher.service';
import { RobotsService } from '../../fetcher/services/robots.service';
import {
  findDuplicateContent,
  findPageIssues,
  scorePage,
  summarisePages,
} from './seo-rubric';
import { extractPageSignals } from './page-signals';
import type { AuditPageResult, PageInventoryAnalysis, SitemapEntry } from '../technical-audit.types';

/**
 * A scored page plus the fingerprint the run-level duplicate pass groups on.
 * The hash is internal to the run and never reaches `AuditPageResult`.
 */
interface ScoredPage extends AuditPageResult {
  contentHash: string | null;
}

@Injectable()
export class PageInventoryCheckService {
  private readonly logger = new Logger(PageInventoryCheckService.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly config: ConfigService,
    private readonly robots: RobotsService,
  ) {}

  private get defaultBudget(): number {
    return Number(this.config.get('technicalAudit.pageCrawlBudget', 150)) || 150;
  }

  private get concurrency(): number {
    return Number(this.config.get('technicalAudit.pageCrawlConcurrency', 6)) || 6;
  }

  /**
   * Crawl up to `budget` sitemap URLs and score each. Never throws; a page
   * that fails to fetch becomes a `page-error` row so the count still reconciles.
   */
  async analyze(
    entries: SitemapEntry[],
    runId: string,
    budgetOverride?: number,
    targetUrl?: string,
  ): Promise<{ analysis: PageInventoryAnalysis; pages: AuditPageResult[] }> {
    const budget = budgetOverride ?? this.defaultBudget;
    const discovered = entries.length;

    // Falls back to the first sitemap entry's own host when the caller does
    // not pass `targetUrl` explicitly — keeps this a non-breaking addition
    // for any other caller of `analyze()`, current or future.
    const siteHost = this.hostOf(targetUrl) ?? this.hostOf(entries[0]?.url) ?? '';

    const ordered = this.prioritise(entries);
    const candidates = ordered.slice(0, budget);

    // Respect the site's own robots.txt before spending a single fetch on a
    // disallowed URL — this crawler previously fetched whatever the sitemap
    // listed regardless of Disallow rules. Fails open (RobotsService's own
    // discipline): a robots.txt that cannot be read blocks nothing.
    const allowedUrls = new Set(await this.robots.filterAllowed(candidates.map((e) => e.url)));
    const selected = candidates.filter((e) => allowedUrls.has(e.url));
    if (selected.length < candidates.length) {
      this.logger.log(`Page inventory: ${candidates.length - selected.length} sitemap URL(s) skipped — disallowed by robots.txt`);
    }

    const pages: ScoredPage[] = [];
    for (let i = 0; i < selected.length; i += this.concurrency) {
      const batch = selected.slice(i, i + this.concurrency);
      const done = await Promise.all(batch.map((e) => this.scoreOne(e, runId, siteHost)));
      pages.push(...done);
    }

    // Duplicate content is the one finding a single page cannot produce — it
    // only exists relative to the other pages in the run. Applied here, after
    // the crawl, then re-scored so the deduction actually lands.
    const duplicates = findDuplicateContent(pages);
    if (duplicates.size > 0) {
      for (const page of pages) {
        if (!duplicates.has(page.url)) continue;
        // A page that failed to load is already reported as `page-error` and
        // carries no copy to duplicate; leave it alone.
        if (page.issues.includes('page-error')) continue;
        page.issues = [...page.issues, 'duplicate-content'];
        page.score = scorePage(page.issues);
      }
      this.logger.log(`Page inventory: ${duplicates.size} page(s) share body copy with another page`);
    }

    this.logger.log(
      `Page inventory: ${pages.length}/${discovered} crawled (budget ${budget}), ` +
        `${pages.filter((p) => p.issues.includes('page-error')).length} errored`,
    );

    return { analysis: summarisePages(pages, discovered, budget), pages };
  }

  /**
   * Newest `<lastmod>` first; entries without one go last, in sitemap order.
   * A page the site just changed is the page most likely to have regressed.
   */
  private prioritise(entries: SitemapEntry[]): SitemapEntry[] {
    const seen = new Set<string>();
    const unique = entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
    return unique.sort((a, b) => {
      if (a.lastmod && b.lastmod) return b.lastmod.localeCompare(a.lastmod);
      if (a.lastmod) return -1;
      if (b.lastmod) return 1;
      return 0;
    });
  }

  private async scoreOne(entry: SitemapEntry, runId: string, siteHost: string): Promise<ScoredPage> {
    const base = {
      url: entry.url,
      lastmod: entry.lastmod,
      title: null,
      titleLength: null,
      metaDescription: null,
      metaDescLength: null,
      h1Count: null,
      canonical: null,
      wordCount: null,
      imageCount: null,
      imagesMissingAlt: null,
      jsonLdTypes: [] as string[],
      jsonLdValid: false,
      jsonLdCount: 0,
    };

    let status = 0;
    let html = '';
    try {
      const res = await this.fetcher.fetch(
        { url: entry.url, cacheTtlSeconds: 3600 },
        'technical-audit',
        runId,
      );
      status = res.status;
      html = res.body ?? '';
    } catch (err) {
      this.logger.debug(`page fetch failed ${entry.url}: ${(err as Error).message}`);
    }

    if (!html || status === 0 || status >= 400) {
      const issues = findPageIssues({
        status,
        title: null,
        metaDescription: null,
        h1Count: 0,
        canonical: null,
        wordCount: 0,
        imageCount: 0,
        imagesMissingAlt: 0,
        jsonLdCount: 0,
        jsonLdValid: false,
        noindex: false,
        url: entry.url,
        siteHost,
        headingLevels: [],
      });
      return { ...base, status, issues, score: scorePage(issues), contentHash: null };
    }

    const signals = extractPageSignals(html, status, entry.url, siteHost);
    const issues = findPageIssues(signals);

    return {
      ...base,
      status,
      title: signals.title,
      titleLength: signals.title ? signals.title.length : null,
      metaDescription: signals.metaDescription,
      metaDescLength: signals.metaDescription ? signals.metaDescription.length : null,
      h1Count: signals.h1Count,
      canonical: signals.canonical,
      wordCount: signals.wordCount,
      imageCount: signals.imageCount,
      imagesMissingAlt: signals.imagesMissingAlt,
      contentHash: signals.contentHash,
      jsonLdTypes: signals.jsonLdTypes,
      jsonLdValid: signals.jsonLdValid,
      jsonLdCount: signals.jsonLdCount,
      issues,
      score: scorePage(issues),
    };
  }

  /** Hostname of a URL, or `null` when it does not parse. */
  private hostOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  /**
   * `@type` can be a string, an array, or buried inside `@graph` — walk the
   * structure rather than reading the top level, or a page whose schema lives
   * entirely in a @graph reads as having none.
   */
}
