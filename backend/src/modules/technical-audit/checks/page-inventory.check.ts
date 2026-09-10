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
import * as cheerio from 'cheerio';
import { FetcherService } from '../../fetcher/fetcher.service';
import { findPageIssues, scorePage, summarisePages, type PageSignals } from './seo-rubric';
import type { AuditPageResult, PageInventoryAnalysis, SitemapEntry } from '../technical-audit.types';

@Injectable()
export class PageInventoryCheckService {
  private readonly logger = new Logger(PageInventoryCheckService.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly config: ConfigService,
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
  ): Promise<{ analysis: PageInventoryAnalysis; pages: AuditPageResult[] }> {
    const budget = budgetOverride ?? this.defaultBudget;
    const discovered = entries.length;

    const ordered = this.prioritise(entries);
    const selected = ordered.slice(0, budget);

    const pages: AuditPageResult[] = [];
    for (let i = 0; i < selected.length; i += this.concurrency) {
      const batch = selected.slice(i, i + this.concurrency);
      const done = await Promise.all(batch.map((e) => this.scoreOne(e, runId)));
      pages.push(...done);
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

  private async scoreOne(entry: SitemapEntry, runId: string): Promise<AuditPageResult> {
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
        jsonLdCount: 0,
        jsonLdValid: false,
        noindex: false,
      });
      return { ...base, status, issues, score: scorePage(issues) };
    }

    const signals = this.extract(html, status);
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
      jsonLdTypes: signals.jsonLdTypes,
      jsonLdValid: signals.jsonLdValid,
      jsonLdCount: signals.jsonLdCount,
      issues,
      score: scorePage(issues),
    };
  }

  /** Everything the rubric needs, pulled from server HTML with cheerio. */
  private extract(html: string, status: number): PageSignals & { jsonLdTypes: string[] } {
    const $ = cheerio.load(html);

    const title = $('head title').first().text().trim() || $('title').first().text().trim() || null;
    const metaDescription =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      null;
    const canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;

    const robots = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();
    const noindex = robots.includes('noindex');

    // Strip the parts of the document that are not prose before counting, or
    // an inline script bundle reads as thousands of words of content.
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg').remove();
    const text = body.text().replace(/\s+/g, ' ').trim();
    const wordCount = text ? text.split(' ').length : 0;

    const jsonLdTypes: string[] = [];
    let jsonLdCount = 0;
    let jsonLdValid = true;
    $('script[type="application/ld+json"]').each((_, el) => {
      jsonLdCount++;
      const raw = $(el).contents().text().trim();
      if (!raw) {
        jsonLdValid = false;
        return;
      }
      try {
        jsonLdTypes.push(...this.collectTypes(JSON.parse(raw)));
      } catch {
        jsonLdValid = false;
      }
    });
    if (jsonLdCount === 0) jsonLdValid = false;

    return {
      status,
      title,
      metaDescription,
      h1Count: $('h1').length,
      canonical,
      wordCount,
      jsonLdCount,
      jsonLdValid,
      jsonLdTypes: [...new Set(jsonLdTypes)],
      noindex,
    };
  }

  /**
   * `@type` can be a string, an array, or buried inside `@graph` — walk the
   * structure rather than reading the top level, or a page whose schema lives
   * entirely in a @graph reads as having none.
   */
  private collectTypes(node: unknown, depth = 0): string[] {
    if (depth > 6 || node === null || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap((n) => this.collectTypes(n, depth + 1));

    const obj = node as Record<string, unknown>;
    const out: string[] = [];
    const t = obj['@type'];
    if (typeof t === 'string') out.push(t);
    else if (Array.isArray(t)) out.push(...t.filter((x): x is string => typeof x === 'string'));

    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasPart']) {
      if (obj[key]) out.push(...this.collectTypes(obj[key], depth + 1));
    }
    return out;
  }
}
