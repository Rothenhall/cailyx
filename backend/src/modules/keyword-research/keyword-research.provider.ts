/**
 * DataForSEO Keywords Data provider — search volume + competition/CPC for a
 * seed list, and related/long-tail expansion for the same seeds (decision D5,
 * `docs/analysis/wave-6-audit-pipeline.md`). Same vendor account, same
 * Basic-Auth convention, as `serp-intelligence/providers.ts`'s
 * `DataForSeoProvider` — all HTTP goes through `FetcherService`.
 *
 * Two endpoints:
 *   - `google_ads/search_volume/live`         — up to 1000 keywords/request.
 *     Used verbatim for the operator's own seed keywords.
 *   - `google_ads/keywords_for_keywords/live` — up to 20 seed keywords/request,
 *     returns related/expanded keyword ideas. Used for the optional
 *     related/long-tail expansion.
 *
 * Both return the same per-item shape: `search_volume`, `competition`
 * (LOW/MEDIUM/HIGH), `competition_index` (0-100), `cpc`,
 * `low_top_of_page_bid`, `high_top_of_page_bid`. These are Google Ads
 * *advertiser*-competition metrics — a demand-pressure proxy, not an organic
 * SEO ranking-difficulty score. Reported as what they are; never relabelled.
 *
 * @module keyword-research.provider
 */

import type { FetcherService } from '../fetcher/fetcher.service';

const SEARCH_VOLUME_URL = 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live';
const KEYWORDS_FOR_KEYWORDS_URL = 'https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live';

/** DataForSEO accepts at most 20 seeds per `keywords_for_keywords` call. */
export const RELATED_SEED_LIMIT = 20;

export interface KeywordVolumeItem {
  keyword: string;
  searchVolume: number | null;
  competition: string | null;
  competitionIndex: number | null;
  cpc: number | null;
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
}

export interface KeywordDataResponse {
  items: KeywordVolumeItem[];
  /** DataForSEO's own reported charge for this call — the real cost, never estimated. */
  costUsd: number;
}

export interface KeywordLookupOpts {
  locationName?: string;
  languageCode?: string;
}

interface DfsResultRow {
  keyword?: string;
  search_volume?: number | null;
  competition?: string | null;
  competition_index?: number | null;
  cpc?: number | null;
  low_top_of_page_bid?: number | null;
  high_top_of_page_bid?: number | null;
}

interface DfsTask {
  status_code?: number;
  status_message?: string;
  result?: DfsResultRow[] | null;
}

interface DfsEnvelope {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: DfsTask[];
}

function normalizeRow(row: DfsResultRow): KeywordVolumeItem {
  return {
    keyword: row.keyword ?? '',
    searchVolume: typeof row.search_volume === 'number' ? row.search_volume : null,
    competition: row.competition ?? null,
    competitionIndex: typeof row.competition_index === 'number' ? row.competition_index : null,
    cpc: typeof row.cpc === 'number' ? row.cpc : null,
    lowTopOfPageBid: typeof row.low_top_of_page_bid === 'number' ? row.low_top_of_page_bid : null,
    highTopOfPageBid: typeof row.high_top_of_page_bid === 'number' ? row.high_top_of_page_bid : null,
  };
}

/** Thin HTTP client for DataForSEO's Keywords Data family. */
export class DataForSeoKeywordsProvider {
  constructor(
    private readonly fetcher: FetcherService,
    private readonly login: string,
    private readonly password: string,
  ) {}

  /** Exact-match volume/competition/CPC for the given keywords (own seeds). */
  async searchVolume(keywords: string[], opts: KeywordLookupOpts): Promise<KeywordDataResponse> {
    return this.post(SEARCH_VOLUME_URL, keywords, opts);
  }

  /**
   * Related/long-tail keyword ideas for the given seeds. DataForSEO caps this
   * endpoint at {@link RELATED_SEED_LIMIT} seeds/request — callers must slice.
   */
  async relatedKeywords(seedKeywords: string[], opts: KeywordLookupOpts): Promise<KeywordDataResponse> {
    return this.post(KEYWORDS_FOR_KEYWORDS_URL, seedKeywords, opts);
  }

  private async post(url: string, keywords: string[], opts: KeywordLookupOpts): Promise<KeywordDataResponse> {
    const auth = Buffer.from(`${this.login}:${this.password}`).toString('base64');
    const body = JSON.stringify([
      {
        keywords,
        location_name: opts.locationName || 'United States',
        language_code: opts.languageCode || 'en',
      },
    ]);
    const res = await this.fetcher.fetch(
      {
        url,
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body,
      },
      'keyword-research',
    );
    if (res.status >= 400) {
      throw new Error(`DataForSEO HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`);
    }
    const parsed = JSON.parse(res.body || '{}') as DfsEnvelope;
    const task = parsed.tasks?.[0];
    if (!task || (task.status_code && task.status_code >= 40000)) {
      throw new Error(`DataForSEO task error: ${task?.status_message ?? 'no task returned'}`);
    }
    const items = (task.result ?? []).filter((r) => !!r.keyword).map(normalizeRow);
    const costUsd = typeof parsed.cost === 'number' ? parsed.cost : 0;
    return { items, costUsd };
  }
}
