/**
 * Page sources for the internal-link crawler.
 *
 *   - `HttpPageSource`    — real crawl of the client's site through FetcherService
 *                           (rate-limited + logged centrally, per the fetcher
 *                           module contract).
 *   - `FixturePageSource` — a small in-memory site with a known link structure
 *                           (one orphan, one under-linked hub, one obvious
 *                           missing link). Lets the whole analyze → recommend
 *                           pipeline be smoke-tested offline. Enabled only when
 *                           `INTERNAL_LINK_ALLOW_FIXTURE=1` and the root URL is
 *                           `fixture://<name>`.
 *
 * @module internal-link.page-source
 */

import type { FetcherService } from '../fetcher/fetcher.service';
import type { FetchedPage, PageSource } from './internal-link.types';

/** Real HTTP crawl. */
export class HttpPageSource implements PageSource {
  readonly kind = 'http' as const;

  constructor(private readonly fetcher: FetcherService) {}

  async fetchPage(url: string): Promise<FetchedPage> {
    const res = await this.fetcher.fetch({ url, method: 'GET' }, 'internal-link');
    return { url: res.finalUrl || url, status: res.status, html: res.body ?? '' };
  }

  /** Best-effort `<origin>/sitemap.xml` → `<loc>` URLs. Empty on any failure. */
  async discoverSeeds(rootUrl: string): Promise<string[]> {
    let origin: string;
    try {
      origin = new URL(rootUrl).origin;
    } catch {
      return [];
    }
    try {
      const res = await this.fetcher.fetch({ url: `${origin}/sitemap.xml`, method: 'GET' }, 'internal-link');
      if (res.status >= 400 || !res.body) return [];
      const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      return locs.filter((u) => {
        try {
          return new URL(u).origin === origin;
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
}

/** Deterministic in-memory site: `fixture://demo`. */
const FIXTURE_SITES: Record<string, Record<string, string>> = {
  demo: {
    '/': `<!doctype html><html><head><title>Home — Acme AI Visibility</title></head><body>
      <h1>Acme AI Visibility</h1>
      <p>Acme helps teams measure and improve how AI assistants describe and recommend them.</p>
      <nav>
        <a href="/guides/ai-visibility">AI visibility guide</a>
        <a href="/guides/answer-engine-optimization">Answer engine optimization</a>
        <a href="/product">Product</a>
        <a href="/pricing">Pricing</a>
      </nav></body></html>`,
    '/guides/ai-visibility': `<!doctype html><html><head><title>What is AI visibility?</title></head><body>
      <h1>What is AI visibility?</h1>
      <p>AI visibility is how often and how accurately AI assistants mention, cite, and recommend
      your brand. Measuring AI visibility means sampling answers across surfaces and tracking
      mention rate, citation rate, and share of voice over time.</p>
      <p>See also <a href="/guides/answer-engine-optimization">answer engine optimization</a> and
      our <a href="/product">product</a>.</p></body></html>`,
    '/guides/answer-engine-optimization': `<!doctype html><html><head><title>Answer Engine Optimization (AEO)</title></head><body>
      <h1>Answer Engine Optimization</h1>
      <p>Answer engine optimization (AEO) is the practice of structuring content so answer engines
      can extract and cite it. AEO overlaps with AI visibility: extractable content raises citation
      rate. Key tactics include BLUF answers, question-shaped headings, and schema.</p>
      <p>Back to the <a href="/">home page</a>.</p></body></html>`,
    // Under-linked hub: only the home page links here, though it is highly on-topic.
    '/product': `<!doctype html><html><head><title>Acme Product — AI visibility measurement</title></head><body>
      <h1>Acme Product</h1>
      <p>The Acme product measures AI visibility: mention rate, citation rate, share of voice,
      and answer engine optimization findings, with scheduled re-runs and alerts.</p>
      <p><a href="/pricing">Pricing</a></p></body></html>`,
    '/pricing': `<!doctype html><html><head><title>Pricing — Acme</title></head><body>
      <h1>Pricing</h1><p>Simple per-project pricing. <a href="/product">Back to product</a>.</p></body></html>`,
    // Orphan: nothing links to it.
    '/blog/2026-ai-search-study': `<!doctype html><html><head><title>2026 AI Search Study</title></head><body>
      <h1>2026 AI Search Study</h1>
      <p>Our study of AI visibility across 500 B2B brands: citation rate, mention rate, and share
      of voice benchmarks for answer engine optimization.</p></body></html>`,
  },
};

export class FixturePageSource implements PageSource {
  readonly kind = 'fixture' as const;
  private readonly pages: Record<string, string>;

  constructor(siteName: string) {
    this.pages = FIXTURE_SITES[siteName] ?? FIXTURE_SITES.demo;
  }

  static isFixtureUrl(url: string): boolean {
    return /^fixture:\/\//i.test(url);
  }

  static siteName(url: string): string {
    return url.replace(/^fixture:\/\//i, '').split('/')[0] || 'demo';
  }

  /** Fixture "origin" so the analyzer's same-host + path logic works unchanged. */
  static origin(url: string): string {
    return `fixture://${FixturePageSource.siteName(url)}`;
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    const origin = FixturePageSource.origin(url);
    const path = url === origin || url === `${origin}/` ? '/' : url.slice(origin.length) || '/';
    const html = this.pages[path];
    if (html === undefined) return { url, status: 404, html: '' };
    return { url, status: 200, html };
  }

  /** The fixture's full page inventory — models a complete sitemap. */
  async discoverSeeds(rootUrl: string): Promise<string[]> {
    const origin = FixturePageSource.origin(rootUrl);
    return Object.keys(this.pages).map((p) => (p === '/' ? `${origin}/` : origin + p));
  }
}
