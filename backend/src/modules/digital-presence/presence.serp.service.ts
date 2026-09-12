/**
 * SERP account discovery — finds accounts the client's own site does not link.
 *
 * The site crawl only ever finds what the client chose to link. Plenty of real
 * accounts are never linked: an old Facebook page, a founder-run X account, a
 * YouTube channel nobody put in the footer. Search is the only way to reach them.
 *
 * **Everything this produces is a candidate, not an account.** That is not
 * caution for its own sake -- it is what the data actually looks like. A live
 * `site:instagram.com "HubSpot"` returns:
 *
 * ```
 *   instagram.com/hubspot/            <- theirs
 *   instagram.com/hubspotlife/        <- theirs (employer brand)
 *   instagram.com/hubspotacademy/     <- theirs
 *   instagram.com/reel/DWVj-HrjmeU/   <- a reel, rejected by the classifier
 *   instagram.com/hubshotspodcast/    <- a different company entirely
 * ```
 *
 * No rule separates the last one from the first three. A human does. So rows
 * land as `state: 'candidate'`, are never counted as accounts, and never reach a
 * client report until an operator says yes.
 *
 * Provider: **DataForSEO**, via the shared `DataForSeoSerpService`. It was
 * Serper.dev — a second vendor, at a higher per-query price, for a search the
 * DataForSEO account already covers, with its own auth and cost model to keep
 * straight. Queries are spent only on expected platforms the crawl did **not**
 * already find, and responses cache for a week.
 *
 * @module presence.serp.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataForSeoSerpService } from '../serp-intelligence/dataforseo-serp.service';
import { classifyUrl } from './presence.signatures';
import { PLATFORM_LABELS, type PresenceEntity, type PresencePlatform } from './presence.types';

/** One search-suggested profile, with a similarity hint for the operator's eye. */
export interface SerpCandidate {
  platform: PresencePlatform;
  url: string;
  handle: string;
  /** Company or a person — carried through from the classifier. */
  entity: PresenceEntity;
  /** 0-1 similarity between the handle and the brand name. A hint, not a gate. */
  confidence: number;
  /** The result title, so the operator can judge without opening the link. */
  title: string | null;
  /** The query that produced it — makes the finding reproducible. */
  query: string;
}

export interface SerpSweepResult {
  candidates: SerpCandidate[];
  /** Queries that actually cost money. Cache hits are excluded. */
  queriesSpent: number;
  /** Real charge from DataForSEO's envelope, summed. Never estimated. */
  costUsd: number;
  /** Set when the sweep did not run; the caller reports it rather than hiding it. */
  skipped: string | null;
}

@Injectable()
export class PresenceSerpService {
  private readonly logger = new Logger(PresenceSerpService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly serp: DataForSeoSerpService,
  ) {}

  /** True when a paid search is possible. Callers report the absence, never guess. */
  get enabled(): boolean {
    return this.serp.availability().ok;
  }

  /**
   * Search for the client's accounts on platforms the crawl did not find.
   *
   * @param brand Brand name, quoted into the query. Without one there is nothing
   *   to search for and the sweep is skipped rather than run on the bare domain.
   * @param domain Client domain — used as a secondary signal in the query.
   * @param platforms Platforms to sweep. Callers pass only the missing ones, so
   *   a re-run on a fully-discovered client spends nothing.
   * @returns Candidates plus the credits actually spent.
   */
  async sweep(
    brand: string | null,
    domain: string,
    platforms: PresencePlatform[],
  ): Promise<SerpSweepResult> {
    const gate = this.serp.availability();
    if (!gate.ok) {
      return { candidates: [], queriesSpent: 0, costUsd: 0, skipped: gate.reason };
    }
    if (!brand || brand.trim().length < 2) {
      return {
        candidates: [],
        queriesSpent: 0,
        costUsd: 0,
        skipped: 'no brand name to search for — set the project name or client name',
      };
    }
    if (platforms.length === 0) {
      return { candidates: [], queriesSpent: 0, costUsd: 0, skipped: 'nothing missing to search for' };
    }

    const cleanBrand = brand.trim();
    // "Rothenhall" and "Rothenhall Partners" are the same company, but nothing
    // tells us up front which one their handle actually uses -- so best-effort
    // means trying the plausible variants, not just the one string an operator
    // happened to type into `Project.name`.
    const variants = nameVariants(cleanBrand, domain);

    // A hard ceiling on TOTAL queries across every platform × variant, not a
    // per-platform allowance. These are paid DataForSEO credits; an unbounded
    // sweep across a client list would drain them without anyone noticing until
    // a call fails. Raised from the single-query-per-platform default (5) now
    // that finding one platform can cost several.
    const budget = Number(this.config.get<string>('PRESENCE_SERP_MAX_QUERIES', '20'));

    const candidates: SerpCandidate[] = [];
    let queriesSpent = 0;
    let costUsd = 0;
    const searchedPlatforms = new Set<PresencePlatform>();
    const exhausted = () => queriesSpent >= budget;

    platformLoop: for (const platform of platforms) {
      if (exhausted()) break;
      const host = SEARCH_HOST[platform];
      if (!host) continue;

      for (const variant of variants) {
        if (exhausted()) break platformLoop;
        const query = `site:${host} "${variant}"`;

        try {
          const lookup = await this.serp.search(query);
          if (lookup.skipped) {
            this.logger.warn(
              `SERP sweep skipped for ${PLATFORM_LABELS[platform]} ("${variant}"): ${lookup.skipped}`,
            );
            continue;
          }
          // A cache hit is not a spend. Counting it would tell the operator
          // credits went out when none did -- and the budget guard, which
          // prices the next run off this number, would refuse runs that are
          // actually free.
          if (!lookup.cached) queriesSpent++;
          costUsd += lookup.costUsd;
          searchedPlatforms.add(platform);

          let strongHit = false;
          for (const row of lookup.links) {
            if (!row.url) continue;
            // The same signature table the crawler uses. It is what drops the
            // `/reel/…` and `/p/…` rows a SERP is full of.
            const hit = classifyUrl(row.url);
            if (!hit || hit.platform !== platform) continue;
            if (candidates.some((c) => c.url === hit.url)) continue;
            // Ranked against the ORIGINAL brand, not the variant that found it
            // — a variant is a search strategy, not the identity the operator
            // should judge the match against.
            const confidence = similarity(hit.handle, cleanBrand);
            candidates.push({
              platform,
              url: hit.url,
              handle: hit.handle,
              entity: hit.entity,
              confidence,
              title: row.title ?? null,
              query,
            });
            if (confidence >= 0.6) strongHit = true;
          }

          // Best-effort, not exhaustive: once a confident match is on the
          // board for this platform, trying the remaining variants only
          // spends budget for candidates the operator will not need.
          if (strongHit) break;
        } catch (err) {
          // One query failing must not void the rest of the sweep.
          this.logger.warn(
            `SERP sweep failed for ${PLATFORM_LABELS[platform]} ("${variant}"): ${(err as Error).message}`,
          );
        }
      }
    }

    // Best name match first — the operator reads top-down and should meet the
    // likeliest row first, even though the ranking decides nothing.
    candidates.sort((a, b) => b.confidence - a.confidence);

    const unsearched = platforms.filter((p) => !searchedPlatforms.has(p));
    const skipped =
      unsearched.length > 0
        ? `budget of ${budget} queries reached — ${unsearched.length} platform(s) not searched`
        : null;

    return { candidates, queriesSpent, costUsd, skipped };
  }

}

/** The host each platform is searched under. */
const SEARCH_HOST: Partial<Record<PresencePlatform, string>> = {
  // Scoped to /company on purpose: a bare linkedin.com search returns founders'
  // personal profiles, which are not what a company footprint is asking for.
  linkedin: 'linkedin.com/company',
  instagram: 'instagram.com',
  facebook: 'facebook.com',
  x: 'x.com',
  youtube: 'youtube.com',
  tiktok: 'tiktok.com',
  pinterest: 'pinterest.com',
  threads: 'threads.net',
  medium: 'medium.com',
  substack: 'substack.com',
  github: 'github.com',
  crunchbase: 'crunchbase.com/organization',
  g2: 'g2.com/products',
  capterra: 'capterra.com',
  trustpilot: 'trustpilot.com/review',
  glassdoor: 'glassdoor.com',
  yelp: 'yelp.com/biz',
  producthunt: 'producthunt.com/products',
  clutch: 'clutch.co/profile',
};

/**
 * Crude handle-vs-brand similarity, 0-1.
 *
 * Deliberately simple: it orders a short list for a human, and nothing branches
 * on it. Anything cleverer would invite treating the number as a decision, and
 * the whole point of a candidate is that the decision is not ours to make.
 * (`hubspot` vs "HubSpot" scores 1; `hubshotspodcast` scores low; `hubspotlife`
 * scores in between — which is the right shape, since it *is* theirs but the
 * name alone cannot prove it.)
 */
function similarity(handle: string, brand: string): number {
  const h = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!h || !b) return 0;
  if (h === b) return 1;
  if (h.startsWith(b)) return Math.max(0.6, b.length / h.length);
  if (h.includes(b)) return Math.max(0.45, (b.length / h.length) * 0.8);
  if (b.includes(h)) return Math.max(0.4, (h.length / b.length) * 0.7);

  // Fall back to character overlap so an unrelated name scores near zero rather
  // than the same as a near-miss.
  const set = new Set(b);
  let hit = 0;
  for (const ch of h) if (set.has(ch)) hit++;
  return Math.min(0.35, (hit / Math.max(h.length, b.length)) * 0.35);
}

/**
 * Corporate suffixes a handle routinely drops. "Rothenhall Partners" becomes
 * `@rothenhall`, not `@rothenhallpartners` — a platform handle is a short
 * identity, not a registered company name, so it is these words that get cut
 * first.
 */
const CORPORATE_SUFFIX =
  /\s+(partners?|group|holdings?|consulting|consultants?|associates?|ventures?|studio|studios|labs?|agency|agencies|solutions?|co|company|corp|corporation|inc|llc|ltd|limited|plc|gmbh)\.?$/i;

/**
 * Best-effort list of name variants to search, most-likely-to-hit first.
 *
 * Nothing tells us up front whether a company's social handle uses its full
 * registered name, its shortened trading name, or a word pulled from its own
 * domain — real companies use all three inconsistently across platforms. This
 * is the "search all possible combinations" step: cheap, deterministic
 * derivations of the one brand string we do have, tried in order until the
 * caller (`sweep`) gets a confident hit or runs out of query budget.
 *
 * @param brand The project's recorded name, e.g. "Rothenhall Partners".
 * @param domain The client's domain, e.g. "rothenhall.com" — a second, independent
 *   signal for the trading name when the recorded brand is long or formal.
 * @returns Deduped variants, longest/most-specific first (a specific query is
 *   less likely to return an unrelated company than a short one).
 */
export function nameVariants(brand: string, domain: string): string[] {
  const variants = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = v?.trim();
    if (t && t.length >= 2) variants.add(t);
  };

  add(brand);

  // Strip corporate suffixes repeatedly: "Rothenhall Partners Group" -> "Rothenhall".
  let stripped = brand.trim();
  for (let i = 0; i < 3; i++) {
    const next = stripped.replace(CORPORATE_SUFFIX, '').trim();
    if (next === stripped) break;
    stripped = next;
    add(stripped);
  }

  // First word alone, when the brand is multi-word — the single main word
  // companies fall back to for a short handle: "Rothenhall Partners" -> "Rothenhall".
  const firstWord = brand.trim().split(/\s+/)[0];
  add(firstWord);

  // Domain-derived token, title-cased: "rothenhall-partners.com" -> "Rothenhall Partners".
  // An independent signal from the brand string — useful when `Project.name`
  // is a formal legal name the site itself never actually uses.
  const domainToken = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('.')[0]
    .replace(/[-_]+/g, ' ')
    .trim();
  if (domainToken) {
    add(domainToken.replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  // Longest first: a longer, more specific string is the likelier match and
  // the one least likely to pull in an unrelated company of the same short name.
  return [...variants].sort((a, b) => b.length - a.length);
}
