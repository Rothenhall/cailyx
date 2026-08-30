# Cailyx — Module Spec: `fetcher`

> **Status:** Draft for review
> **Date:** 2026-08-28
> **Scope:** Defines the single, shared module responsible for ALL outbound HTTP requests, headless browser actions, API calls, and web scraping across Cailyx. No other module performs network requests directly.

---

## 1. Purpose

Every crawling, fetching, probing, scraping, or API-requesting action in Cailyx belongs to this one module. If any module needs to reach the network — fetch a page, probe a URL, call an API, run a headless browser session, query an AI assistant, hit a search endpoint — it calls `fetcher`. It never does the HTTP request itself.

**The rule:**

```
No module imports axios / fetch / got / playwright / puppeteer / request directly.
Every module imports fetcher.
```

### Why one module?

| Benefit | Explanation |
|---|---|
| **Single chokepoint** | All outbound traffic flows through one place — easy to rate-limit, cache, log, rotate user-agents, retry, and budget |
| **Consistent error handling** | One retry/timeout/backoff strategy, not N different ones per module |
| **Clean separation** | Other modules focus on analysis logic; `fetcher` handles the wire |
| **Testability** | Mock one module instead of intercepting HTTP in every module's tests |
| **Cost control** | Central per-run cost tracking, budget enforcement, and quota management |
| **Compliance** | One place to enforce rate limits, respect robots.txt, log all requests for audit |

---

## 2. What `fetcher` owns

### 2.1 Capabilities

| Capability | Method signature (indicative) | Used by |
|---|---|---|
| Fetch a URL (raw HTTP) | `fetch(url, opts) → { status, headers, body, timing }` | `technical-audit`, `entity-audit`, `intake`, `page-analysis` |
| Probe with specific User-Agent | `probe(url, { userAgent, retries }) → { status, latency, blocked }` | `technical-audit` (access probe) |
| Fetch + render with headless browser | `render(url, { jsDisabled }) → { html, text, screenshot, timing }` | `technical-audit` (JS render diff), `measurement` (high-fidelity capture), `page-analysis` |
| Query an AI assistant via API | `queryAssistant({ provider, prompt, geo }) → { answer, citations, timing, cost }` | `measurement`, `entity-audit` (model-diff) |
| Web search | `search(query, { provider, geo }) → { results[] }` | `entity-audit`, `intake` (competitor discovery), `mention-tracking` |
| Fetch and parse JSON-LD/schema | `fetchSchema(url) → { schemaType, fields }` | `entity-audit`, `page-analysis` |
| Resolve + verify a URL (sameAs check) | `verifyUrl(url, { expectedName }) → { resolves, identityMatch }` | `entity-audit` |
| Call external API (PageSpeed, etc.) | `callApi(provider, params) → { data, cost }` | `technical-audit` (CWV via PSI) |

### 2.2 What `fetcher` does NOT do

- **Analysis or interpretation.** It returns raw data (HTML, JSON, status codes, timing). The calling module interprets.
- **Findings generation.** It does not produce `AuditFinding` records. It produces raw responses.
- **Scoring.** It does not score anything.
- **Business logic.** It is a transport layer, not a logic layer.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│                  fetcher module                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ HTTP     │  │ Headless │  │ AI Assistant   │ │
│  │ Client   │  │ Browser  │  │ Adapters       │ │
│  │ (axios)  │  │ (Playwright)│  │ (OpenAI,     │ │
│  │          │  │          │  │  Anthropic,    │ │
│  │ UA       │  │ Render   │  │  Perplexity,   │ │
│  │ rotation │  │ diff    │  │  Google)       │ │
│  └────┬─────┘  └────┬─────┘  └───────┬────────┘ │
│       │              │                │           │
│  ┌────┴──────────────┴────────────────┴──────┐   │
│  │              Shared services              │   │
│  │  ┌────────┐ ┌──────┐ ┌───────┐ ┌────────┐ │   │
│  │  │ Cache  │ │ Rate │ │ Retry │ │ Cost   │ │   │
│  │  │ (Redis)│ │ limit│ │ /back │ │ tracker│ │   │
│  │  └────────┘ └──────┘ └───────┘ └────────┘ │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │              Logging / audit              │   │
│  │  Every request: URL, UA, status, cost,    │   │
│  │  timing, module that called it            │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
        ▲          ▲          ▲          ▲
        │          │          │          │
  technical-   entity-    measurement  page-
  audit        audit                  analysis
```

### 3.1 Internal structure (NestJS)

```
fetcher/
├── fetcher.module.ts
├── fetcher.service.ts          # Main entry point — all public methods
├── clients/
│   ├── http.client.ts           # Raw HTTP fetch (axios, UA rotation)
│   ├── browser.client.ts        # Playwright headless browser
│   └── ai-adapter.client.ts     # AI assistant API adapters
├── services/
│   ├── cache.service.ts         # Redis-backed response cache
│   ├── rate-limiter.service.ts  # Per-domain + global rate limiting
│   ├── retry.service.ts         # Exponential backoff, circuit breaker
│   └── cost-tracker.service.ts  # Per-run cost budget enforcement
├── adapters/
│   ├── openai.adapter.ts
│   ├── anthropic.adapter.ts
│   ├── perplexity.adapter.ts
│   ├── google-ai.adapter.ts
│   └── psi.adapter.ts           # PageSpeed Insights
└── config/
    ├── user-agents.ts           # AI crawler UA strings + browser control
    └── fetcher.config.ts        # Timeouts, retries, budgets, rate limits
```

---

## 4. Core behaviors

### 4.1 User-Agent rotation

`fetcher` maintains the canonical list of AI crawler user-agents:

```typescript
const AI_USER_AGENTS = {
  'GPTBot':           'Mozilla/5.0 AppleWebKit/... GPTBot/1.0',
  'OAI-SearchBot':    'Mozilla/5.0 AppleWebKit/... OAI-SearchBot/1.0',
  'ChatGPT-User':     'Mozilla/5.0 AppleWebKit/... ChatGPT-User/1.0',
  'PerplexityBot':    'Mozilla/5.0 AppleWebKit/... PerplexityBot/1.0',
  'Perplexity-User':  '... Perplexity-User/1.0',
  'ClaudeBot':        'Mozilla/5.0 AppleWebKit/... ClaudeBot/1.0',
  'Claude-User':      '... Claude-User/1.0',
  'Claude-SearchBot': '... Claude-SearchBot/1.0',
  'Google-Extended':  '... Google-Extended/1.0',
  'Googlebot':        '... Googlebot/2.1',
  'Browser':          'Mozilla/5.0 ... Chrome/... Safari/...',  // control
}
```

No other module defines or hard-codes these strings. They live here.

### 4.2 Caching

- Stable signals (robots.txt, schema, homepage HTML) are cached per-domain with a TTL
- Cache key: `{url, userAgent, method}`
- Cache hit = free (no cost, no rate-limit consumed)
- Cache is per-project so one project's runs don't pollute another's

### 4.3 Rate limiting

- Per-domain rate limit (configurable, default: 1 request / 3 seconds)
- Global rate limit (configurable, default: 10 requests / second across all domains)
- AI assistant APIs: per-provider rate limit (respects their headers)
- Rate-limited requests queue, never fail silently

### 4.4 Retry & backoff

- Default: 3 retries with exponential backoff (1s, 2s, 4s)
- 403/429 → retry with longer backoff
- Circuit breaker per domain: 5 consecutive failures → pause that domain for 60s
- Final failure returns an error result, never silently disappears

### 4.5 Cost tracking

- Every AI assistant call logs token count + provider cost
- Every PSI API call logs cost
- Per-run budget enforced: if budget exceeded, `fetcher` refuses the call and returns a budget-exceeded error
- Calling module sees the cost in the response

### 4.6 Logging

Every request logs:

```json
{
  "timestamp": "...",
  "calledBy": "technical-audit",   // which module requested this
  "method": "probe",
  "url": "https://napkin.ie/robots.txt",
  "userAgent": "GPTBot",
  "httpStatus": 403,
  "latencyMs": 340,
  "cost": 0,
  "cached": false,
  "retryCount": 0,
  "runId": "run_abc123"
}
```

This makes every run fully debuggable end-to-end.

---

## 5. How other modules use it

### Before (scattered fetching — not allowed)

```
technical-audit module:
  - imports axios
  - fetches robots.txt directly
  - fetches homepage directly
  - imports playwright
  - renders page directly

entity-audit module:
  - imports axios
  - fetches schema directly
  - fetches sameAs URLs directly
  - imports openai SDK
  - calls ChatGPT API directly
```

### After (all fetching via fetcher)

```
technical-audit module:
  - calls fetcher.fetch(url, { userAgent: 'GPTBot' })
  - calls fetcher.probe(url, { userAgent: 'ClaudeBot' })
  - calls fetcher.render(url, { jsDisabled: true })
  - calls fetcher.callApi('psi', { url })

entity-audit module:
  - calls fetcher.fetchSchema(url)
  - calls fetcher.verifyUrl(url, { expectedName })
  - calls fetcher.queryAssistant({ provider: 'openai', prompt })
  - calls fetcher.search(query, { provider: 'google' })

measurement module:
  - calls fetcher.queryAssistant({ provider, prompt, geo })
  - calls fetcher.render(url) for high-fidelity capture

intake module:
  - calls fetcher.fetch(url) for homepage
  - calls fetcher.search(query) for competitor discovery

page-analysis module:
  - calls fetcher.fetch(url)
  - calls fetcher.render(url)

mention-tracking module:
  - calls fetcher.search(query, { provider })
```

---

## 6. Data model

`fetcher` does not own persistent business records — it is stateless from the calling module's perspective. It does maintain:

### 6.1 Request log (append-only)

```
FetchLog
  ├── id, run_id, called_by (module name), created_at
  ├── method: fetch | probe | render | queryAssistant | search | fetchSchema | verifyUrl | callApi
  ├── url, user_agent, http_status, latency_ms
  ├── cost (decimal), cached (bool), retry_count
  └── response_hash (for cache key tracking)
```

### 6.2 Cache (Redis, not persistent DB)

```
key: fetcher:{url}:{userAgent}:{method}
value: serialized response
ttl: configurable per method (e.g. robots.txt = 24h, AI response = 0/never cache)
```

---

## 7. API (internal NestJS service, not HTTP endpoints)

`fetcher` is NOT exposed via HTTP REST endpoints. It is an internal NestJS service injected via dependency injection into other modules.

```typescript
// Injected into any module that needs it
constructor(private fetcher: FetcherService) {}

// Usage examples
const robots = await this.fetcher.fetch('https://napkin.ie/robots.txt');
const probe = await this.fetcher.probe('https://napkin.ie/', { userAgent: 'GPTBot' });
const rendered = await this.fetcher.render('https://napkin.ie/', { jsDisabled: false });
const schema = await this.fetcher.fetchSchema('https://napkin.ie/');
const answer = await this.fetcher.queryAssistant({ provider: 'openai', prompt: 'What is Napkin?', geo: 'US' });
const results = await this.fetcher.search('napkin ie', { provider: 'google', geo: 'IE' });
const verified = await this.fetcher.verifyUrl('https://linkedin.com/company/napkin', { expectedName: 'Napkin' });
const cwv = await this.fetcher.callApi('psi', { url: 'https://napkin.ie/' });
```

---

## 8. Dependencies

| Dependency | Purpose |
|---|---|
| `axios` | HTTP client (single instance, shared) |
| `playwright` | Headless browser for render + JS-diff |
| `openai` (npm SDK) | OpenAI/ChatGPT API adapter |
| `@anthropic-ai/sdk` | Anthropic/Claude API adapter |
| Redis | Cache + rate-limit state |
| BullMQ | Request queue for async/batch fetches |

---

## 9. Phase and priority

**Phase 0 (build first, before any audit/measurement module)**

`fetcher` is a foundational module. It must exist before `technical-audit`, `entity-audit`, `measurement`, or `intake` can be built, because all of them depend on it.

Build sequence within fetcher:
1. `http.client.ts` — basic fetch + UA rotation (unblocks `technical-audit` robots/probe)
2. `cache.service.ts` + `rate-limiter.service.ts` — prevents hammering domains
3. `browser.client.ts` — Playwright render (unblocks `technical-audit` JS diff, `page-analysis`)
4. `ai-adapter.client.ts` — OpenAI + Anthropic adapters (unblocks `measurement`, `entity-audit`)
5. `cost-tracker.service.ts` — budget enforcement (unblocks paid-tier runs)
6. Remaining adapters (Perplexity, Google AI, PSI) — as each surface is added

---

## 10. Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | One module for all fetching | Yes — no module does HTTP directly, all go through `fetcher` |
| 2 | Module name | `fetcher` |
| 3 | Internal or HTTP API | Internal NestJS service (DI), not a separate HTTP service |
| 4 | Caching | Redis, per-domain TTL, stable signals cached |
| 5 | User-agent list | Owned here, not duplicated elsewhere |
| 6 | Cost tracking | Per-call cost logged, per-run budget enforced |
| 7 | Headless browser | Playwright, shared pool, managed here |
| 8 | Logging | Every request logged with calling module + run ID |

---

## 11. Open items

1. Multi-geo egress: do we need proxy infrastructure for geo-distributed probing, or is single-egress acceptable for Phase 0?
2. Headless browser pool size: how many concurrent Playwright instances for Phase 1?
3. AI assistant API keys: which providers confirmed, and what are the rate limits/quotas?
4. Cache TTL per method: needs tuning once real usage patterns are known.
5. Should `fetcher` enforce robots.txt respect for non-probe fetches (ethical crawling)?