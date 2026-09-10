/**
 * Sitemap check — "is the sitemap present, and is it actually being updated?"
 *
 * Presence alone is close to worthless: a sitemap committed once in 2023 and
 * never touched since is worse than none, because it asserts freshness it does
 * not have. So this check reports two things, and the second is the one that
 * matters — how many URLs declare a `<lastmod>` at all, and how stale the
 * newest one is.
 *
 * Discovery order is deliberate. robots.txt `Sitemap:` is checked first
 * because it is the only *declared* location; the conventional paths are
 * guesses, and a site that serves a sitemap at a guessed path but never
 * declares it is a finding in itself.
 *
 * @module technical-audit/checks/sitemap
 */

import { Injectable, Logger } from '@nestjs/common';
import { FetcherService } from '../../fetcher/fetcher.service';
import type { SitemapAnalysis, SitemapEntry } from '../technical-audit.types';

/** Conventional locations, tried in order after robots.txt yields nothing. */
const FALLBACK_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap'];

/** A sitemap index can point at hundreds of children; bound the fan-out. */
const MAX_CHILD_SITEMAPS = 20;

/** Guard against a pathological sitemap blowing out memory. */
const MAX_ENTRIES = 50_000;

@Injectable()
export class SitemapCheckService {
  private readonly logger = new Logger(SitemapCheckService.name);

  constructor(private readonly fetcher: FetcherService) {}

  /**
   * Locate and parse the sitemap for an origin.
   *
   * Never throws — an unreachable or malformed sitemap is a *finding*, not an
   * error, and the audit must continue to the remaining checks.
   */
  async analyze(targetUrl: string, runId: string): Promise<SitemapAnalysis> {
    const empty = (over: Partial<SitemapAnalysis> = {}): SitemapAnalysis => ({
      found: false,
      sitemapUrl: null,
      triedUrls: [],
      statusCode: 0,
      isIndex: false,
      childSitemaps: [],
      urlCount: 0,
      withLastmod: 0,
      newestLastmod: null,
      oldestLastmod: null,
      staleDays: null,
      declaredInRobots: false,
      duplicateCount: 0,
      offOriginCount: 0,
      entries: [],
      ...over,
    });

    let origin: string;
    try {
      origin = new URL(targetUrl).origin;
    } catch {
      return empty();
    }

    const declared = await this.readRobotsSitemaps(origin, runId);
    const candidates = [...declared, ...FALLBACK_PATHS.map((p) => `${origin}${p}`)];
    const tried: string[] = [];

    for (const candidate of this.dedupe(candidates)) {
      tried.push(candidate);
      const doc = await this.fetchXml(candidate, runId);
      if (!doc) continue;

      const isIndex = /<sitemapindex[\s>]/i.test(doc.body);
      let entries: SitemapEntry[];
      let childSitemaps: string[] = [];

      if (isIndex) {
        childSitemaps = this.extractLocs(doc.body).slice(0, MAX_CHILD_SITEMAPS);
        entries = await this.fetchChildren(childSitemaps, runId);
      } else {
        entries = this.parseUrlset(doc.body);
      }

      // An empty <urlset> is a real answer, not a miss — report it as found
      // with zero URLs rather than falling through to the next candidate and
      // mislabelling the site as having no sitemap at all.
      return this.summarise({
        found: true,
        sitemapUrl: doc.finalUrl,
        triedUrls: tried,
        statusCode: doc.status,
        isIndex,
        childSitemaps,
        declaredInRobots: declared.includes(candidate),
        entries: entries.slice(0, MAX_ENTRIES),
      }, origin);
    }

    return empty({ triedUrls: tried, declaredInRobots: declared.length > 0 });
  }

  // ─── discovery ────────────────────────────────────────────────

  /** `Sitemap:` lines from robots.txt. Absolute URLs only, as the spec requires. */
  private async readRobotsSitemaps(origin: string, runId: string): Promise<string[]> {
    try {
      const res = await this.fetcher.fetch(
        { url: `${origin}/robots.txt`, cacheTtlSeconds: 86400 },
        'technical-audit',
        runId,
      );
      if (res.status >= 400 || !res.body) return [];
      return [...res.body.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)]
        .map((m) => m[1].trim())
        .filter((u) => /^https?:\/\//i.test(u));
    } catch {
      return [];
    }
  }

  private async fetchXml(url: string, runId: string) {
    // .gz sitemaps are valid but the fetcher returns bytes we cannot parse as
    // text; skip rather than emit a spurious "malformed sitemap".
    if (/\.gz(\?|$)/i.test(url)) return null;
    try {
      const res = await this.fetcher.fetch({ url, cacheTtlSeconds: 3600 }, 'technical-audit', runId);
      if (res.status >= 400 || !res.body) return null;
      if (!/<(urlset|sitemapindex)[\s>]/i.test(res.body)) return null;
      return { status: res.status, body: res.body, finalUrl: res.finalUrl || url };
    } catch {
      return null;
    }
  }

  private async fetchChildren(children: string[], runId: string): Promise<SitemapEntry[]> {
    const all: SitemapEntry[] = [];
    for (const child of children) {
      if (all.length >= MAX_ENTRIES) break;
      const doc = await this.fetchXml(child, runId);
      if (doc) all.push(...this.parseUrlset(doc.body));
    }
    return all;
  }

  // ─── parsing ──────────────────────────────────────────────────

  private extractLocs(xml: string): string[] {
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => this.decode(m[1]));
  }

  /**
   * Pull `<url>` blocks out of a `<urlset>`, keeping `<loc>` paired with its
   * own `<lastmod>`. Matching per-block rather than harvesting both tags
   * globally matters: sitemaps routinely omit `<lastmod>` on some entries, and
   * two independent global matches would silently shift every date by one.
   */
  private parseUrlset(xml: string): SitemapEntry[] {
    const out: SitemapEntry[] = [];
    for (const block of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
      const inner = block[1];
      const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(inner);
      if (!loc) continue;
      const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(inner);
      out.push({
        url: this.decode(loc[1]),
        lastmod: lastmod ? this.normaliseDate(lastmod[1]) : null,
      });
      if (out.length >= MAX_ENTRIES) break;
    }
    return out;
  }

  /** Sitemaps are XML, so `&amp;` in a URL is routine. */
  private decode(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /** W3C datetime → ISO. Returns null on anything unparseable. */
  private normaliseDate(raw: string): string | null {
    const d = new Date(raw.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  private dedupe(urls: string[]): string[] {
    return [...new Set(urls)];
  }

  // ─── rollup ───────────────────────────────────────────────────

  private summarise(
    base: Omit<
      SitemapAnalysis,
      | 'urlCount'
      | 'withLastmod'
      | 'newestLastmod'
      | 'oldestLastmod'
      | 'staleDays'
      | 'duplicateCount'
      | 'offOriginCount'
    >,
    origin: string,
  ): SitemapAnalysis {
    const { entries } = base;
    const stamps = entries
      .map((e) => e.lastmod)
      .filter((d): d is string => !!d)
      .sort();

    const seen = new Set<string>();
    let duplicateCount = 0;
    let offOriginCount = 0;
    for (const e of entries) {
      if (seen.has(e.url)) duplicateCount++;
      seen.add(e.url);
      try {
        if (new URL(e.url).origin !== origin) offOriginCount++;
      } catch {
        offOriginCount++;
      }
    }

    const newest = stamps.length ? stamps[stamps.length - 1] : null;
    const staleDays = newest
      ? Math.max(0, Math.floor((Date.now() - new Date(newest).getTime()) / 86_400_000))
      : null;

    return {
      ...base,
      urlCount: entries.length,
      withLastmod: stamps.length,
      newestLastmod: newest,
      oldestLastmod: stamps.length ? stamps[0] : null,
      staleDays,
      duplicateCount,
      offOriginCount,
    };
  }
}
