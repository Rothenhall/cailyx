# Fetcher Module

> **Status:** ✅ Built and tested
> **Phase:** 0 (Foundation — all other modules depend on this)
> **Spec:** [docs/fetcher-module-spec.md](../../docs/fetcher-module-spec.md)

## Purpose

The **single source of all outbound network requests** in Cailyx. No other module imports `axios`, `playwright`, or makes HTTP requests directly. Everything goes through `FetcherService`.

## Architecture

```
fetcher/
├── fetcher.module.ts              # NestJS module — exports FetcherService
├── fetcher.service.ts             # Main entry point — all public methods
├── fetcher.constants.ts           # 25+ AI crawler bot user-agent strings
├── fetcher.types.ts               # TypeScript interfaces for all I/O
├── clients/
│   ├── http-client.service.ts     # Raw HTTP via axios + UA rotation
│   └── browser-client.service.ts  # Playwright headless browser
├── services/
│   ├── cache.service.ts           # Redis-backed response cache
│   ├── rate-limiter.service.ts    # Per-domain + global rate limiting
│   ├── retry.service.ts           # Exponential backoff + circuit breaker
│   └── cost-tracker.service.ts    # Per-run cost tracking + budget enforcement
└── adapters/
    └── psi.adapter.ts             # Google PageSpeed Insights API v5
```

## Public API (NestJS service — injected via DI)

| Method | Signature | Description |
|---|---|---|
| `fetch()` | `fetch(opts: FetchOptions, calledBy?, runId?) → Promise<FetchResult>` | Raw HTTP GET/POST with custom User-Agent |
| `probe()` | `probe(opts: ProbeOptions, calledBy?, runId?) → Promise<ProbeResult>` | Access probe: sends requests with each AI bot UA, repeats N times, reports stable result |
| `render()` | `render(opts: RenderOptions, calledBy?, runId?) → Promise<RenderResult>` | Headless browser render with optional JS disabled |
| `fetchSchema()` | `fetchSchema(url, calledBy?, runId?) → Promise<SchemaResult>` | Extract JSON-LD structured data from a page |
| `verifyUrl()` | `verifyUrl(opts: VerifyUrlOptions, calledBy?, runId?) → Promise<VerifyUrlResult>` | Resolve a URL and check identity match (sameAs verification) |
| `callPsiApi()` | `callPsiApi(url, calledBy?, runId?) → Promise<PsiResult>` | Call Google PageSpeed Insights API for Core Web Vitals |
| `getLogs()` | `getLogs() → FetchLogEntry[]` | Get all fetch operation logs |
| `getRunCost()` | `getRunCost(runId) → number` | Get total cost for a run |

## AI Crawler Bot List (25+ bots, 19 companies)

Three categories — each with different business impact when blocked:

| Category | Bots | Impact of blocking |
|---|---|---|
| **Training crawlers** | GPTBot, ClaudeBot, Bytespider, CCBot, Meta-ExternalAgent, Amazonbot, Applebot-Extended, cohere-ai, Diffbot, ai2bot, GrokBot | Site won't be in model training data |
| **Search crawlers** | OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot, CopilotBot, YouBot, PhindBot, KagiBot, DuckAssistBot | Site removed from AI answers entirely (de-indexing) |
| **Live-fetch agents** | ChatGPT-User, Claude-User, Perplexity-User, MistralAI-User, FacebookBot | "Summarize this link" features break |
| **Policy tokens** | Google-Extended | robots.txt directive only — no real UA to probe |

## Built-in Services

| Service | Purpose | Fallback |
|---|---|---|
| CacheService | Redis-backed response caching (per-domain TTL) | Skips caching if Redis down |
| RateLimiterService | Per-domain (3s) + global (10/s) rate limiting | In-memory fallback if Redis down |
| RetryService | Exponential backoff (1s, 2s, 4s) + circuit breaker (5 failures → 60s pause) | Always works (in-memory) |
| CostTrackerService | Per-run cost tracking + budget enforcement | Always works (in-memory) |

## Dependencies

| Package | Purpose |
|---|---|
| `axios` | HTTP client |
| `playwright` | Headless browser for JS render diff |
| `ioredis` | Redis client for cache + rate limiting |
| `@nestjs/schedule` | Cron scheduling support |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6380` | Redis connection URL |
| `PSI_API_KEY` | (required for CWV) | Google PageSpeed Insights API key |
| `FETCHER_TIMEOUT_MS` | `30000` | HTTP request timeout |
| `FETCHER_RETRY_COUNT` | `3` | Default retry attempts |
| `FETCHER_RETRY_BACKOFF_MS` | `1000` | Initial backoff (doubles each retry) |
| `FETCHER_RATE_LIMIT_PER_DOMAIN_MS` | `3000` | Min ms between requests to same domain |
| `FETCHER_RATE_LIMIT_GLOBAL_PER_SEC` | `10` | Max requests per second globally |

## Consumers

| Module | What it calls |
|---|---|
| `technical-audit` | `fetch()`, `probe()`, `render()`, `callPsiApi()` |
| `entity-audit` (planned) | `fetchSchema()`, `verifyUrl()`, `queryAssistant()` |
| `measurement` (planned) | `queryAssistant()`, `render()` |
| `intake` (planned) | `fetch()`, `search()` |
| `page-analysis` (planned) | `fetch()`, `render()` |
| `mention-tracking` (planned) | `search()` |

## Testing

Verified end-to-end against `https://example.com`:
- robots.txt fetch: ✅ (detected 404 — no robots.txt)
- CDN probe: ✅ (20+ bots probed, Cloudflare detected, no blocks)
- JS render diff: ✅ (Playwright launched, 0% content loss)
- PSI API: ✅ (LCP: 760ms, CLS: 0, Score: 100)
- Redis cache: ✅ (connected, caching active)
- Rate limiting: ✅ (per-domain + global working)