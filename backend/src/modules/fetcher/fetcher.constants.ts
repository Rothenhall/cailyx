/**
 * AI Crawler User-Agent Constants
 *
 * Comprehensive list of 25+ AI crawler bots from 19 companies (August 2026).
 * Three categories: training crawlers, search/index crawlers, and live-fetch agents.
 *
 * This is the SINGLE source of truth for AI bot user-agent strings in Cailyx.
 * No other module should define or hard-code these strings.
 *
 * @module fetcher.constants
 */

export type BotCategory = 'training' | 'search' | 'live-fetch' | 'browser';

export interface BotDefinition {
  /** Short name used in logs, findings, and reports */
  name: string;
  /** The User-Agent string to send in HTTP requests */
  userAgent: string;
  /** Company that operates the bot */
  operator: string;
  /** What the bot does — training, search indexing, or live user-triggered fetch */
  category: BotCategory;
  /** Whether this bot respects robots.txt directives */
  honorsRobotsTxt: boolean;
  /** True if this is a policy-only token (no real UA, robots.txt directive only) */
  isPolicyToken?: boolean;
}

/**
 * Training crawlers — fetch content for model training.
 * Blocking these = opt out of being included in model training data.
 */
export const TRAINING_CRAWLERS: BotDefinition[] = [
  {
    name: 'GPTBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    operator: 'OpenAI',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'ClaudeBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    operator: 'Anthropic',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'Bytespider',
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 Bytespider',
    operator: 'ByteDance',
    category: 'training',
    honorsRobotsTxt: false, // Notorious for ignoring robots.txt
  },
  {
    name: 'CCBot',
    userAgent: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
    operator: 'Common Crawl',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'Meta-ExternalAgent',
    userAgent: 'Meta-ExternalAgent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    operator: 'Meta',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'Amazonbot',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
    operator: 'Amazon',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'Applebot-Extended',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    operator: 'Apple',
    category: 'training',
    honorsRobotsTxt: true,
    isPolicyToken: true, // Primarily a robots.txt policy token
  },
  {
    name: 'cohere-ai',
    userAgent: 'cohere-ai/1.0 (+https://cohere.ai/bot)',
    operator: 'Cohere',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'Diffbot',
    userAgent: 'Mozilla/5.0 (compatible; Diffbot/0.1; +https://www.diffbot.com)',
    operator: 'Diffbot',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'ai2bot',
    userAgent: 'Mozilla/5.0 (compatible; ai2bot/1.0; +https://allenai.org/crawler)',
    operator: 'AI2 (Allen Institute)',
    category: 'training',
    honorsRobotsTxt: true,
  },
  {
    name: 'GrokBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GrokBot/1.0; +https://x.ai)',
    operator: 'xAI',
    category: 'training',
    honorsRobotsTxt: true,
  },
];

/**
 * Search/index crawlers — feed AI search products (AI overviews, AI answers).
 * Blocking these = removal from AI answers entirely (de-indexing).
 */
export const SEARCH_CRAWLERS: BotDefinition[] = [
  {
    name: 'OAI-SearchBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
    operator: 'OpenAI',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'Claude-SearchBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +claudebot@anthropic.com)',
    operator: 'Anthropic',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'PerplexityBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://docs.perplexity.ai/guides/bots)',
    operator: 'Perplexity',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'Googlebot',
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    operator: 'Google',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'CopilotBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; CopilotBot/1.0; +https://www.bing.com/bingbot.htm)',
    operator: 'Microsoft',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'YouBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; YouBot/1.0; +https://you.com/bot)',
    operator: 'You.com',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'PhindBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PhindBot/1.0; +https://phind.com/bot)',
    operator: 'Phind',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'KagiBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; KagiBot/1.0; +https://kagi.com/bot)',
    operator: 'Kagi',
    category: 'search',
    honorsRobotsTxt: true,
  },
  {
    name: 'DuckAssistBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; DuckAssistBot/1.0; +https://duckduckgo.com/duckassistbot)',
    operator: 'DuckDuckGo',
    category: 'search',
    honorsRobotsTxt: true,
  },
];

/**
 * Live-fetch agents — user-triggered real-time fetches.
 * Blocking these = "summarize this link" and "read this page" features break.
 */
export const LIVE_FETCH_AGENTS: BotDefinition[] = [
  {
    name: 'ChatGPT-User',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    operator: 'OpenAI',
    category: 'live-fetch',
    honorsRobotsTxt: false, // Partial — respects for retrieval but not always
  },
  {
    name: 'Claude-User',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claudebot@anthropic.com)',
    operator: 'Anthropic',
    category: 'live-fetch',
    honorsRobotsTxt: false,
  },
  {
    name: 'Perplexity-User',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://docs.perplexity.ai/guides/bots)',
    operator: 'Perplexity',
    category: 'live-fetch',
    honorsRobotsTxt: false,
  },
  {
    name: 'MistralAI-User',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://mistral.ai/bot)',
    operator: 'Mistral',
    category: 'live-fetch',
    honorsRobotsTxt: false,
  },
  {
    name: 'FacebookBot',
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; FacebookBot/1.0; +https://developers.facebook.com/docs/sharing/bot)',
    operator: 'Meta',
    category: 'live-fetch',
    honorsRobotsTxt: true,
  },
];

/**
 * Google-Extended is a policy-only token — it has no real user-agent string.
 * It's a robots.txt directive that controls whether Google can use content for AI training.
 * We include it in the list for robots.txt analysis but cannot probe it via HTTP.
 */
export const POLICY_TOKENS: BotDefinition[] = [
  {
    name: 'Google-Extended',
    userAgent: '', // No real UA — robots.txt directive only
    operator: 'Google',
    category: 'training',
    honorsRobotsTxt: true,
    isPolicyToken: true,
  },
];

/**
 * Standard browser User-Agent string used as a control in probe comparisons.
 * If the browser gets 200 but an AI bot gets 403, that indicates a CDN/WAF AI-bot block.
 */
export const BROWSER_CONTROL: BotDefinition = {
  name: 'Browser',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  operator: 'N/A',
  category: 'browser',
  honorsRobotsTxt: false,
};

/**
 * All AI bots that can be probed via HTTP (excludes policy-only tokens).
 */
export const ALL_PROBEABLE_BOTS: BotDefinition[] = [
  ...TRAINING_CRAWLERS.filter((b) => !b.isPolicyToken),
  ...SEARCH_CRAWLERS,
  ...LIVE_FETCH_AGENTS,
];

/**
 * All bots including policy tokens (used for robots.txt analysis).
 */
export const ALL_BOTS: BotDefinition[] = [
  ...TRAINING_CRAWLERS,
  ...SEARCH_CRAWLERS,
  ...LIVE_FETCH_AGENTS,
  ...POLICY_TOKENS,
  BROWSER_CONTROL,
];

/**
 * Lookup a bot definition by name.
 */
export function getBotByName(name: string): BotDefinition | undefined {
  return ALL_BOTS.find((b) => b.name === name);
}

/**
 * Get the User-Agent string for a bot by name, or the browser control UA as fallback.
 */
export function getUserAgent(botName: string): string {
  const bot = getBotByName(botName);
  return bot?.userAgent || BROWSER_CONTROL.userAgent;
}