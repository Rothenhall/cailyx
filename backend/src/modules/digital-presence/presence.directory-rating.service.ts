/**
 * Directory / marketplace rating lookup — reads the rating a listing page
 * already publishes about itself, rather than a paid API.
 *
 * Wave-6 D2 confirmed DataForSEO's Business Data catalogue only covers
 * Google / Trustpilot / Yelp reviews — there is no vendor endpoint for a G2,
 * Capterra, Clutch, Glassdoor, Crunchbase or Product Hunt rating
 * (`presence.dataforseo.service.ts`). But every one of those platforms embeds
 * an `AggregateRating` (JSON-LD, or `itemprop` microdata) on a company's own
 * listing page for their own SEO — the same fact a search result snippet
 * shows ("4.7 ★ · 128 reviews"), just structured. Reading it costs one fetch
 * of a URL `digital-presence` already discovered and holds nothing back that
 * was not already public.
 *
 * Same deterministic, no-new-dependency, no-per-lookup-cost discipline as
 * `tech-stack` (decision D3) and `page-inventory.check.ts`'s own JSON-LD
 * walk: the fetcher already retrieves the page; this only structures a value
 * the page already declared. A page whose rating is rendered client-side
 * after JS runs, or that simply does not publish one, honestly returns
 * `found: false` — never a guessed number.
 *
 * @module presence.directory-rating.service
 */

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import type { PresencePlatform } from './presence.types';

/**
 * Platforms whose listing pages carry a meaningful public rating. Pure social
 * platforms (LinkedIn, Instagram, X, …) are excluded on purpose — a "rating"
 * there is not a concept the platform has.
 */
export const RATABLE_PLATFORMS: readonly PresencePlatform[] = [
  'g2',
  'capterra',
  'trustpilot',
  'glassdoor',
  'yelp',
  'clutch',
  'crunchbase',
  'producthunt',
];

export interface DirectoryRatingResult {
  platform: PresencePlatform;
  url: string;
  found: boolean;
  rating: number | null;
  bestRating: number | null;
  reviewCount: number | null;
  /** How the value was read, so a finding can be checked at source. */
  method: 'json-ld' | 'microdata' | null;
  /** The exact fields the extraction matched, verbatim — never reshaped. */
  raw: string | null;
  /** Set when the fetch itself failed (blocked, timeout, non-2xx) — distinct
   *  from `found: false`, which means the page loaded but declared no rating. */
  error: string | null;
}

interface RawAggregate {
  ratingValue?: unknown;
  bestRating?: unknown;
  ratingCount?: unknown;
  reviewCount?: unknown;
}

@Injectable()
export class PresenceDirectoryRatingService {
  private readonly logger = new Logger(PresenceDirectoryRatingService.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Read one listing page's published rating.
   *
   * Never throws — a fetch failure or an unrated page are both reportable
   * outcomes, the same discipline `tech-stack.service.ts` and
   * `presence.discovery.service.ts` use for their own failure paths.
   */
  async fetchRating(platform: PresencePlatform, url: string, runId?: string): Promise<DirectoryRatingResult> {
    const base: DirectoryRatingResult = {
      platform,
      url,
      found: false,
      rating: null,
      bestRating: null,
      reviewCount: null,
      method: null,
      raw: null,
      error: null,
    };

    let html = '';
    try {
      const res = await this.fetcher.fetch({ url, cacheTtlSeconds: 86400 }, 'digital-presence', runId);
      if (res.status === 0 || res.status >= 400) {
        return { ...base, error: `Fetch failed: HTTP ${res.status} ${res.statusText}`.trim() };
      }
      html = res.body ?? '';
    } catch (err) {
      return { ...base, error: (err as Error).message };
    }

    if (!html) return { ...base, error: 'Empty response body' };

    const fromJsonLd = this.extractJsonLd(html);
    if (fromJsonLd) {
      return { ...base, found: true, method: 'json-ld', ...fromJsonLd };
    }

    const fromMicrodata = this.extractMicrodata(html);
    if (fromMicrodata) {
      return { ...base, found: true, method: 'microdata', ...fromMicrodata };
    }

    // Page loaded fine; it simply does not declare a rating (no listings yet,
    // unclaimed profile, or the platform renders it client-side after JS).
    return base;
  }

  /**
   * Read every ratable account in one pass. One failing platform never voids
   * the rest — same convention as `PresenceSerpService.sweep()`.
   */
  async fetchAll(
    accounts: Array<{ platform: PresencePlatform; url: string }>,
    runId?: string,
  ): Promise<DirectoryRatingResult[]> {
    const targets = accounts.filter((a) => RATABLE_PLATFORMS.includes(a.platform));
    const out: DirectoryRatingResult[] = [];
    for (const target of targets) {
      out.push(await this.fetchRating(target.platform, target.url, runId));
    }
    return out;
  }

  /**
   * {@link fetchAll} plus persistence, one `PresenceReview` row per platform
   * that returned a rating. A page that loaded but declared nothing, or that
   * failed to fetch, writes no row — an absence must never be indistinguishable
   * from "we never looked" or read back later as a fabricated zero.
   *
   * @param projectId Project these accounts belong to.
   * @param accounts Discovered listing accounts (platform + URL) to check —
   *   typically a project's `PresenceAccount` rows filtered by
   *   {@link RATABLE_PLATFORMS}, passed in by the caller.
   */
  async fetchAndStore(
    projectId: string,
    accounts: Array<{ platform: PresencePlatform; url: string }>,
    runId?: string,
  ): Promise<DirectoryRatingResult[]> {
    const results = await this.fetchAll(accounts, runId);
    for (const r of results) {
      if (!r.found) continue;
      try {
        await this.prisma.presenceReview.create({
          data: {
            projectId,
            platform: r.platform,
            rating: r.rating,
            reviewCount: r.reviewCount,
            url: r.url,
            raw: r.raw,
            source: 'schema-scrape',
          },
        });
      } catch (err) {
        this.logger.warn(`Failed to persist directory rating for ${r.platform} (${projectId}): ${(err as Error).message}`);
      }
    }
    return results;
  }

  /**
   * {@link fetchAndStore} for the client's own project — reads whichever of
   * its already-discovered accounts are ratable, straight from
   * `PresenceAccount`, so this is callable as its own endpoint rather than
   * requiring the caller to assemble the account list by hand (which is why
   * this existed only as `fetchAndStore` — usable, but nothing on the
   * client's own project ever called it; `competitors.service.ts` only ever
   * called it for rivals).
   *
   * Candidates and personal profiles are excluded for the same reason they
   * are excluded everywhere else in this module: a search guess is not an
   * account, and a founder's own listing is not the company's.
   */
  async fetchAndStoreForProject(projectId: string, runId?: string): Promise<DirectoryRatingResult[]> {
    const accounts = await this.prisma.presenceAccount.findMany({
      where: {
        projectId,
        state: { not: 'candidate' },
        entity: { not: 'personal' },
        platform: { in: [...RATABLE_PLATFORMS] },
      },
      select: { platform: true, url: true },
    });
    return this.fetchAndStore(
      projectId,
      accounts.map((a) => ({ platform: a.platform as PresencePlatform, url: a.url })),
      runId,
    );
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Walk every `<script type="application/ld+json">` block on the page for an
   * `AggregateRating`, at any depth — as a top-level `@type`, or nested under
   * an `aggregateRating` field on an Organization/Product/LocalBusiness block,
   * including inside a `@graph` array. A regex-and-JSON.parse walk rather than
   * `FetcherService.fetchSchema()`, because that helper's own extractor drops
   * everything inside `@graph` except the first item's `@type` — exactly the
   * shape review platforms commonly use.
   */
  private extractJsonLd(html: string): { rating: number | null; bestRating: number | null; reviewCount: number | null; raw: string } | null {
    const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const block of blocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block[1].trim());
      } catch {
        continue; // malformed blocks are common on real sites — not an error here
      }
      const agg = findAggregateRating(parsed);
      if (agg) return this.coerceAggregate(agg);
    }
    return null;
  }

  /**
   * Fallback for pages that render the rating as `itemprop` microdata rather
   * than JSON-LD (some Capterra/G2 templates do this server-side).
   */
  private extractMicrodata(html: string): { rating: number | null; bestRating: number | null; reviewCount: number | null; raw: string } | null {
    const $ = cheerio.load(html);
    const valueOf = (sel: string): string | undefined =>
      $(sel).attr('content')?.trim() || $(sel).text().trim() || undefined;

    const ratingValue = valueOf('[itemprop="ratingValue"]');
    if (!ratingValue) return null;

    const bestRating = valueOf('[itemprop="bestRating"]');
    const reviewCount = valueOf('[itemprop="reviewCount"]') ?? valueOf('[itemprop="ratingCount"]');

    const rating = toNumber(ratingValue);
    if (rating === null) return null;

    return {
      rating,
      bestRating: toNumber(bestRating),
      reviewCount: toNumber(reviewCount) !== null ? Math.round(toNumber(reviewCount)!) : null,
      raw: JSON.stringify({ ratingValue, bestRating, reviewCount }),
    };
  }

  private coerceAggregate(agg: RawAggregate): { rating: number | null; bestRating: number | null; reviewCount: number | null; raw: string } {
    const rating = toNumber(agg.ratingValue);
    const bestRating = toNumber(agg.bestRating);
    const countRaw = toNumber(agg.reviewCount) ?? toNumber(agg.ratingCount);
    return {
      rating,
      bestRating,
      reviewCount: countRaw !== null ? Math.round(countRaw) : null,
      raw: JSON.stringify({
        ratingValue: agg.ratingValue ?? null,
        bestRating: agg.bestRating ?? null,
        reviewCount: agg.reviewCount ?? null,
        ratingCount: agg.ratingCount ?? null,
      }),
    };
  }
}

/**
 * Recursively search a parsed JSON-LD document for an `AggregateRating`
 * block — either a node whose own `@type` is `AggregateRating`, or a field
 * named `aggregateRating` on any other node. Depth-capped the same way
 * `page-inventory.check.ts`'s `collectTypes` is, for the same reason: schema
 * blocks nest arbitrarily and an unbounded walk on a malformed document is a
 * real hang, not a theoretical one.
 */
function findAggregateRating(node: unknown, depth = 0): RawAggregate | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAggregateRating(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  const isAggregateRating =
    type === 'AggregateRating' || (Array.isArray(type) && type.includes('AggregateRating'));
  if (isAggregateRating) return obj as RawAggregate;

  if (obj.aggregateRating && typeof obj.aggregateRating === 'object') {
    const nested = findAggregateRating(obj.aggregateRating, depth + 1);
    if (nested) return nested;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'aggregateRating') continue; // already checked above
    if (value && typeof value === 'object') {
      const found = findAggregateRating(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** JSON-LD numeric fields are legally either a number or a numeric string. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}
