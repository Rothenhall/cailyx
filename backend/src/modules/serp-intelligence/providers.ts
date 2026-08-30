/**
 * SERP data providers.
 *
 *   - `DataForSeoProvider` — real. Calls DataForSEO's Google Organic Live
 *     Advanced endpoint (licensed data feed). Requires `DATAFORSEO_LOGIN` +
 *     `DATAFORSEO_PASSWORD` and the `SWARM_ALLOW_LIVE=1` master switch (SERP
 *     calls cost money). All HTTP goes through FetcherService.
 *   - `FixtureSerpProvider` — deterministic canned SERPs for a handful of
 *     AI-visibility keywords. Enabled only with `SERP_ALLOW_FIXTURE=1`. Lets the
 *     capture → analyse → persist pipeline be smoke-tested with no vendor
 *     account and no spend.
 *
 * @module serp-intelligence.providers
 */

import type { FetcherService } from '../fetcher/fetcher.service';
import type { SerpItem, SerpProvider, SerpResponse } from './serp-intelligence.types';

const DATAFORSEO_URL = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';

/** Real DataForSEO provider. */
export class DataForSeoProvider implements SerpProvider {
  readonly name = 'dataforseo' as const;

  constructor(
    private readonly fetcher: FetcherService,
    private readonly login: string,
    private readonly password: string,
  ) {}

  async fetchSerp(
    keyword: string,
    opts: { locationName: string; languageCode: string; device: string },
  ): Promise<SerpResponse> {
    const auth = Buffer.from(`${this.login}:${this.password}`).toString('base64');
    const body = JSON.stringify([
      {
        keyword,
        location_name: opts.locationName,
        language_code: opts.languageCode,
        device: opts.device,
        // ask DataForSEO to include the AI Overview element when present
        load_async_ai_overview: true,
      },
    ]);
    const res = await this.fetcher.fetch(
      {
        url: DATAFORSEO_URL,
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body,
      },
      'serp-intelligence',
    );
    if (res.status >= 400) {
      throw new Error(`DataForSEO HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`);
    }
    const parsed = JSON.parse(res.body || '{}') as DataForSeoEnvelope;
    const task = parsed.tasks?.[0];
    if (!task || (task.status_code && task.status_code >= 40000)) {
      throw new Error(`DataForSEO task error: ${task?.status_message ?? 'no task returned'}`);
    }
    const result = task.result?.[0];
    const items = (result?.items ?? []).map(normalizeDfsItem);
    const costUsd = typeof parsed.cost === 'number' ? parsed.cost : 0;
    return { keyword, items, costUsd };
  }
}

interface DataForSeoEnvelope {
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    result?: Array<{ items?: DfsItem[] }>;
  }>;
}
interface DfsItem {
  type?: string;
  rank_absolute?: number;
  domain?: string;
  url?: string;
  title?: string;
  items?: Array<{ domain?: string; url?: string; title?: string; text?: string }>;
  references?: Array<{ url?: string; domain?: string }>;
  text?: string;
}

function normalizeDfsItem(it: DfsItem): SerpItem {
  const references =
    it.type === 'ai_overview'
      ? [
          ...(it.references ?? []).map((r) => r.url).filter((u): u is string => !!u),
          ...(it.items ?? []).map((s) => s.url).filter((u): u is string => !!u),
        ]
      : undefined;
  return {
    type: it.type ?? 'unknown',
    rankAbsolute: typeof it.rank_absolute === 'number' ? it.rank_absolute : null,
    domain: it.domain ?? null,
    url: it.url ?? null,
    title: it.title ?? null,
    references,
    text: it.text ?? ((it.items ?? []).map((s) => s.text).filter(Boolean).join(' ') || undefined),
  };
}

// ─── fixture ────────────────────────────────────────────────────

/** Canned SERPs keyed by a normalized keyword. Deterministic. */
const FIXTURE_SERPS: Record<string, SerpItem[]> = {
  'ai visibility platform': [
    { type: 'ai_overview', rankAbsolute: 1, domain: null, url: null, title: null, text: 'Several platforms measure AI visibility, including Profound and Peec AI.', references: ['https://profound.ai/guide', 'https://peec.ai/blog'] },
    { type: 'organic', rankAbsolute: 2, domain: 'profound.ai', url: 'https://profound.ai/', title: 'Profound — AI visibility' },
    { type: 'organic', rankAbsolute: 3, domain: 'peec.ai', url: 'https://peec.ai/', title: 'Peec AI' },
    { type: 'organic', rankAbsolute: 5, domain: 'acme-serp.example', url: 'https://acme-serp.example/product', title: 'Acme — AI visibility measurement' },
    { type: 'organic', rankAbsolute: 6, domain: 'searchengineland.com', url: 'https://searchengineland.com/aeo', title: 'What is AEO' },
  ],
  'answer engine optimization': [
    { type: 'featured_snippet', rankAbsolute: 1, domain: 'searchengineland.com', url: 'https://searchengineland.com/aeo-guide', title: 'AEO guide' },
    { type: 'organic', rankAbsolute: 2, domain: 'searchengineland.com', url: 'https://searchengineland.com/aeo-guide', title: 'AEO guide' },
    { type: 'organic', rankAbsolute: 4, domain: 'profound.ai', url: 'https://profound.ai/aeo', title: 'AEO by Profound' },
    { type: 'organic', rankAbsolute: 9, domain: 'acme-serp.example', url: 'https://acme-serp.example/guides/aeo', title: 'Acme AEO guide' },
  ],
  'how to get cited by chatgpt': [
    { type: 'ai_overview', rankAbsolute: 1, domain: null, url: null, title: null, text: 'To be cited, publish extractable, well-structured content. Tools like Profound track this.', references: ['https://profound.ai/', 'https://openai.com/'] },
    { type: 'organic', rankAbsolute: 2, domain: 'profound.ai', url: 'https://profound.ai/', title: 'Profound' },
    { type: 'organic', rankAbsolute: 3, domain: 'reddit.com', url: 'https://reddit.com/r/seo', title: 'r/SEO thread' },
  ],
};

function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class FixtureSerpProvider implements SerpProvider {
  readonly name = 'fixture' as const;

  async fetchSerp(keyword: string): Promise<SerpResponse> {
    const key = normalizeKeyword(keyword);
    const items = FIXTURE_SERPS[key] ?? [
      { type: 'organic', rankAbsolute: 1, domain: 'example.com', url: 'https://example.com/', title: 'Example' },
      { type: 'organic', rankAbsolute: 2, domain: 'wikipedia.org', url: 'https://wikipedia.org/', title: 'Wikipedia' },
    ];
    return { keyword, items, costUsd: 0 };
  }
}
