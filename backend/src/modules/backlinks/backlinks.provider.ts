/**
 * DataForSEO Backlinks API provider. Same vendor account, same Basic-Auth
 * convention as `serp-intelligence/providers.ts` and
 * `keyword-research/keyword-research.provider.ts` — all HTTP goes through
 * `FetcherService`.
 *
 * Two endpoints:
 *   - `backlinks/summary/live`   — one billed row per call: overall profile
 *     (rank, backlink/referring-domain counts, spam score, TLD/type/country
 *     distributions). ~$0.024-0.03/call (docs.dataforseo.com/v3/backlinks-overview).
 *   - `backlinks/backlinks/live` — up to `limit` individual backlink rows,
 *     sorted by rank desc, so a report can show real evidence (who actually
 *     links here) rather than only an aggregate count.
 *
 * @module backlinks.provider
 */

import type { FetcherService } from '../fetcher/fetcher.service';

const SUMMARY_URL = 'https://api.dataforseo.com/v3/backlinks/summary/live';
const BACKLINKS_URL = 'https://api.dataforseo.com/v3/backlinks/backlinks/live';

export interface BacklinksSummaryItem {
  target: string;
  rank: number | null;
  backlinks: number | null;
  backlinksSpamScore: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  referringPages: number | null;
  referringIps: number | null;
  referringSubnets: number | null;
  brokenBacklinks: number | null;
  brokenPages: number | null;
  firstSeen: string | null;
  lostDate: string | null;
  referringLinksTld: Record<string, number> | null;
  referringLinksTypes: Record<string, number> | null;
  referringLinksAttributes: Record<string, number> | null;
  referringLinksPlatformTypes: Record<string, number> | null;
  referringLinksCountries: Record<string, number> | null;
}

export interface BacklinkSampleItem {
  urlFrom: string;
  urlTo: string;
  anchor: string | null;
  dofollow: boolean;
  rank: number | null;
  domainFromRank: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  itemType: string | null;
}

export interface BacklinksSummaryResponse {
  item: BacklinksSummaryItem | null;
  costUsd: number;
}

export interface BacklinksListResponse {
  items: BacklinkSampleItem[];
  costUsd: number;
}

interface DfsEnvelope {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: unknown[] | null;
  }>;
}

/** Thin HTTP client for DataForSEO's Backlinks API family. */
export class DataForSeoBacklinksProvider {
  constructor(
    private readonly fetcher: FetcherService,
    private readonly login: string,
    private readonly password: string,
  ) {}

  /** Overall backlink profile for one target. Single billed row. */
  async summary(target: string): Promise<BacklinksSummaryResponse> {
    const task = await this.post(SUMMARY_URL, {
      target,
      include_subdomains: true,
      include_indirect_links: true,
      backlinks_status_type: 'live',
    });
    const row = (task.result?.[0] ?? null) as Record<string, unknown> | null;
    if (!row) return { item: null, costUsd: task.costUsd };
    const dist = (key: string): Record<string, number> | null => {
      const v = row[key];
      return v && typeof v === 'object' ? (v as Record<string, number>) : null;
    };
    return {
      costUsd: task.costUsd,
      item: {
        target: typeof row.target === 'string' ? row.target : target,
        rank: numOrNull(row.rank),
        backlinks: numOrNull(row.backlinks),
        backlinksSpamScore: numOrNull(row.backlinks_spam_score),
        referringDomains: numOrNull(row.referring_domains),
        referringMainDomains: numOrNull(row.referring_main_domains),
        referringPages: numOrNull(row.referring_pages),
        referringIps: numOrNull(row.referring_ips),
        referringSubnets: numOrNull(row.referring_subnets),
        brokenBacklinks: numOrNull(row.broken_backlinks),
        brokenPages: numOrNull(row.broken_pages),
        firstSeen: typeof row.first_seen === 'string' ? row.first_seen : null,
        lostDate: typeof row.lost_date === 'string' ? row.lost_date : null,
        referringLinksTld: dist('referring_links_tld'),
        referringLinksTypes: dist('referring_links_types'),
        referringLinksAttributes: dist('referring_links_attributes'),
        referringLinksPlatformTypes: dist('referring_links_platform_types'),
        referringLinksCountries: dist('referring_links_countries'),
      },
    };
  }

  /** Up to `limit` individual backlinks, ranked highest-authority first — evidence, not just a count. */
  async topBacklinks(target: string, limit: number): Promise<BacklinksListResponse> {
    const task = await this.post(BACKLINKS_URL, {
      target,
      limit,
      mode: 'as_is',
      order_by: ['rank,desc'],
    });
    const container = (task.result?.[0] ?? null) as { items?: unknown[] } | null;
    const rawItems = Array.isArray(container?.items) ? container!.items : [];
    const items: BacklinkSampleItem[] = rawItems.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        urlFrom: typeof r.url_from === 'string' ? r.url_from : '',
        urlTo: typeof r.url_to === 'string' ? r.url_to : '',
        anchor: typeof r.anchor === 'string' ? r.anchor : null,
        dofollow: r.dofollow !== false,
        rank: numOrNull(r.rank),
        domainFromRank: numOrNull(r.domain_from_rank),
        firstSeen: typeof r.first_seen === 'string' ? r.first_seen : null,
        lastSeen: typeof r.last_seen === 'string' ? r.last_seen : null,
        itemType: typeof r.item_type === 'string' ? r.item_type : null,
      };
    });
    return { items, costUsd: task.costUsd };
  }

  private async post(url: string, payload: Record<string, unknown>): Promise<{ result: unknown[] | null; costUsd: number }> {
    const auth = Buffer.from(`${this.login}:${this.password}`).toString('base64');
    const res = await this.fetcher.fetch(
      {
        url,
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([payload]),
      },
      'backlinks',
    );
    if (res.status >= 400) {
      throw new Error(`DataForSEO HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`);
    }
    const parsed = JSON.parse(res.body || '{}') as DfsEnvelope;
    const task = parsed.tasks?.[0];
    if (!task || (task.status_code && task.status_code >= 40000)) {
      throw new Error(`DataForSEO task error: ${task?.status_message ?? 'no task returned'}`);
    }
    return { result: task.result ?? null, costUsd: typeof task.cost === 'number' ? task.cost : 0 };
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
