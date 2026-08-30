/**
 * Bot registry for crawler classification (SOP-3/4.5).
 *
 * Static registry by design (v1): UA strings are stable identifiers, and a
 * DB-backed table buys little until real per-engagement tuning shows a need.
 *
 * @module crawler-monitor.types
 */

/** Classification buckets: training vs search vs citation-engine. */
export type BotType = 'training' | 'search' | 'citation-engine' | 'unknown';

export interface BotSignature {
  /** Substring matched case-insensitively against the User-Agent. */
  match: string;
  vendor: string;
  name: string;
  type: BotType;
}

/** The well-known AI + search crawlers Cailyx cares about. */
export const BOT_REGISTRY: BotSignature[] = [
  { match: 'gptbot', vendor: 'openai', name: 'GPTBot', type: 'training' },
  { match: 'oai-searchbot', vendor: 'openai', name: 'OAI-SearchBot', type: 'search' },
  { match: 'chatgpt-user', vendor: 'openai', name: 'ChatGPT-User', type: 'search' },
  { match: 'claudebot', vendor: 'anthropic', name: 'ClaudeBot', type: 'training' },
  { match: 'claude-user', vendor: 'anthropic', name: 'Claude-User', type: 'search' },
  { match: 'perplexitybot', vendor: 'perplexity', name: 'PerplexityBot', type: 'citation-engine' },
  { match: 'perplexity-user', vendor: 'perplexity', name: 'Perplexity-User', type: 'search' },
  { match: 'google-extended', vendor: 'google', name: 'Google-Extended', type: 'training' },
  { match: 'googlebot', vendor: 'google', name: 'Googlebot', type: 'search' },
  { match: 'bingbot', vendor: 'bing', name: 'bingbot', type: 'search' },
  { match: 'bytespider', vendor: 'bytedance', name: 'Bytespider', type: 'training' },
  { match: 'ccbot', vendor: 'common-crawl', name: 'CCBot', type: 'training' },
  { match: 'amazonbot', vendor: 'amazon', name: 'Amazonbot', type: 'training' },
  { match: 'meta-externalagent', vendor: 'meta', name: 'meta-externalagent', type: 'training' },
];

/** One ingested hit the API accepts. */
export interface IngestHitInput {
  timestamp: string;
  url: string;
  userAgent: string;
  ip?: string;
}

/** A stored hit as returned by the API. */
export interface CrawlerHitDto {
  id: string;
  hitAt: string;
  url: string;
  botVendor: string;
  botName: string;
  botType: BotType;
}

/** Activity roll-up (crawler activity report). */
export interface CrawlerSummary {
  totalHits: number;
  byType: Record<BotType, number>;
  byVendor: Array<{ vendor: string; hits: number; byType: Record<string, number> }>;
  topUrls: Array<{ url: string; hits: number }>;
  lastSeen: string | null;
}