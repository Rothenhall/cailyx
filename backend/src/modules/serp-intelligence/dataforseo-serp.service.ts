/**
 * DataForSEO SERP — one client, shared by every module that needs a Google
 * result page.
 *
 * Cailyx was paying two vendors for the same thing: `serp-intelligence` used
 * DataForSEO for rankings while `digital-presence` used Serper.dev to find
 * unlinked social profiles. The account is already funded here, DataForSEO is
 * cheaper per query, and two providers meant two auth paths, two cost models
 * and two places for a bug to hide. This is the one place that knows how to ask
 * Google.
 *
 * **Credit discipline**, because these are paid and finite:
 *
 * - **Cached hard.** A `site:instagram.com "Acme"` result does not change hour
 *   to hour, so responses are cached for a week. This is the single biggest
 *   saving — and it only became safe once the fetcher's cache key started
 *   discriminating on the request body (it previously did not, which made every
 *   SERP call inside the TTL return the first keyword's results).
 * - **Depth 10.** DataForSEO bills per 10 results, so asking for 20 doubles the
 *   price. Nothing here needs a second page.
 * - **Real cost, never estimated.** `cost` is read off the response envelope,
 *   the same discipline the OpenRouter and Cloro paths follow.
 * - **Fails closed.** No credentials, or `SWARM_ALLOW_LIVE` unset, and it
 *   returns a typed "disabled" result rather than a guess.
 *
 * @module serp-intelligence/dataforseo-serp.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FetcherService } from '../fetcher/fetcher.service';

const DATAFORSEO_LIVE_URL = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';

/** A week. Search results for a `site:` query are stable over that window. */
const SERP_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** One organic result. */
export interface SerpLink {
  url: string;
  title: string | null;
  /** 1-based position on the page, for diagnostics only — never a ranking claim. */
  position: number | null;
}

/**
 * Outcome of one query.
 *
 * `skipped` is a first-class outcome rather than an exception: a caller that
 * cannot search needs to say so in its report, and an absent search is not an
 * absent result.
 */
export interface SerpLookup {
  links: SerpLink[];
  /** Real charge from the response envelope. 0 on a cache hit or a skip. */
  costUsd: number;
  /** True when this came from cache — no credit was spent. */
  cached: boolean;
  /** Why nothing was searched. Null on a successful lookup. */
  skipped: string | null;
}

@Injectable()
export class DataForSeoSerpService {
  private readonly logger = new Logger(DataForSeoSerpService.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether a live query is possible at all.
   *
   * Two gates, both deliberate: credentials, and the `SWARM_ALLOW_LIVE` master
   * switch that every paid vendor path in this repo sits behind. Callers report
   * the reason rather than silently returning nothing.
   */
  availability(): { ok: true } | { ok: false; reason: string } {
    const login = this.config.get<string>('DATAFORSEO_LOGIN');
    const password = this.config.get<string>('DATAFORSEO_PASSWORD');
    if (!login || !password) {
      return { ok: false, reason: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set' };
    }
    if (this.config.get<string>('SWARM_ALLOW_LIVE') !== '1') {
      return { ok: false, reason: 'SWARM_ALLOW_LIVE=1 is required before any paid SERP call' };
    }
    return { ok: true };
  }

  /**
   * Run one Google query and return its organic links.
   *
   * @param query The search string, e.g. `site:instagram.com "Acme"`.
   * @param opts.locationName DataForSEO location, default `United States`.
   * @param opts.languageCode Default `en`.
   * @param opts.fresh Bypass the cache. Use only when staleness would be wrong —
   *   it spends a credit every time.
   */
  async search(
    query: string,
    opts: { locationName?: string; languageCode?: string; fresh?: boolean } = {},
  ): Promise<SerpLookup> {
    const gate = this.availability();
    if (!gate.ok) return { links: [], costUsd: 0, cached: false, skipped: gate.reason };

    const login = this.config.get<string>('DATAFORSEO_LOGIN') as string;
    const password = this.config.get<string>('DATAFORSEO_PASSWORD') as string;
    const auth = Buffer.from(`${login}:${password}`).toString('base64');

    const body = JSON.stringify([
      {
        keyword: query,
        location_name: opts.locationName ?? 'United States',
        language_code: opts.languageCode ?? 'en',
        // Billed per 10 results. Nothing in this codebase reads a second page,
        // and asking for one would double the charge.
        depth: 10,
      },
    ]);

    try {
      const res = await this.fetcher.fetch(
        {
          url: DATAFORSEO_LIVE_URL,
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body,
          cacheTtlSeconds: SERP_CACHE_TTL_SECONDS,
          bypassCache: opts.fresh === true,
          timeout: 30_000,
        },
        'dataforseo-serp',
      );

      if (res.status >= 400) {
        return {
          links: [],
          costUsd: 0,
          cached: false,
          skipped: `DataForSEO returned HTTP ${res.status}`,
        };
      }

      const parsed = JSON.parse(res.body || '{}') as DfsEnvelope;
      const task = parsed.tasks?.[0];
      if (!task || (task.status_code ?? 0) >= 40000) {
        return {
          links: [],
          costUsd: 0,
          cached: false,
          skipped: `DataForSEO task error: ${task?.status_message ?? 'no task returned'}`,
        };
      }

      const items = task.result?.[0]?.items ?? [];
      const links: SerpLink[] = items
        .filter((i) => i.type === 'organic' && typeof i.url === 'string')
        .map((i) => ({
          url: i.url as string,
          title: typeof i.title === 'string' ? i.title : null,
          position: typeof i.rank_absolute === 'number' ? i.rank_absolute : null,
        }));

      // A cache hit costs nothing, and the envelope's `cost` from the original
      // call must not be re-reported as if it were spent again.
      const costUsd = res.cached ? 0 : typeof parsed.cost === 'number' ? parsed.cost : 0;
      if (!res.cached) {
        this.logger.debug(`DataForSEO SERP "${query.slice(0, 60)}" — ${links.length} links, $${costUsd}`);
      }

      return { links, costUsd, cached: res.cached === true, skipped: null };
    } catch (err) {
      return { links: [], costUsd: 0, cached: false, skipped: (err as Error).message };
    }
  }
}

// ─── Response shape (only the fields read above) ──────────────────────────

interface DfsEnvelope {
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    result?: Array<{ items?: Array<Record<string, unknown>> }>;
  }>;
}
