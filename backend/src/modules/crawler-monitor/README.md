# Crawler Monitor (Wave 3, SOP-3 / §4.5)

Server-log ingestion of AI-crawler traffic. This is the "did the training /
search / citation crawlers actually show up?" half of visibility — it unblocks
the hallucinated-404 sweep downstream (AI-referral URL data now has a home).

## Files

```
crawler-monitor/
├── crawler-monitor.types.ts      # BOT_REGISTRY (14 signatures), BotType, CrawlerSummary
├── crawler-monitor.service.ts    # ingest / classify / parseLogText / summary / listHits
├── crawler-monitor.controller.ts # REST surface
├── dto/crawler-monitor.dto.ts    # IngestDto (hits[] / logText), ListHitsQueryDto
├── crawler-monitor.module.ts
└── README.md
```

## Ingest contract

| Input | Shape | Behavior |
|---|---|---|
| `hits[]` JSON | `{timestamp, url, userAgent, ip?}` | Stored as-is, then classified by UA |
| `logText` | Nginx/Apache **combined log format**, one hit per line | Only lines whose UA matches the bot registry are ingested; human + malformed lines are counted (nothing silently dropped) |

- Returns `{ingested, skipped}`; **400** when nothing parsed at all.
- `logText` max 2 MB per request; `hits[]` entries are per-element validated (`@ValidateNested`).
- Timestamps may be ISO strings or CLF time (`29/Aug/2026:11:15:00 +0000`, normalized to ISO).

## Classification

Static registry (`crawler-monitor.types.ts`) — longest substring match wins, so
`OAI-SearchBot` beats `GPTBot`-family overlap. Registry covers GPTBot,
OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot,
Perplexity-User, Google-Extended, Googlebot, Bingbot, Bytespider, CCBot,
Amazonbot, Meta-ExternalAgent. Unmatched UAs → `{vendor: 'other', type: 'unknown'}`.

| BotType | Meaning |
|---|---|
| `training` | Model-training crawlers (GPTBot, ClaudeBot, Google-Extended, …) |
| `search` | Answer-engine search crawlers (OAI-SearchBot, …) |
| `citation-engine` | For-citation fetchers (PerplexityBot) |
| `unknown` | Bot-ish traffic not in the registry |

## API

| Route | Notes |
|---|---|
| `POST /projects/:projectId/crawler-monitor/ingest` | 10 req/min |
| `GET /projects/:projectId/crawler-monitor/summary?daysBack=30` | `{totalHits, byType, byVendor[], topUrls[] (≤20), lastSeen}` |
| `GET /projects/:projectId/crawler-monitor/hits?limit=&botType=` | newest first, limit 1–1000 (default 100) |

## e2e evidence (2026-08-30, :3111)

1. `hits[]` ingest (GPTBot / ClaudeBot / MadeUpCrawler) → `{ingested: 3, skipped: 0}`.
2. CLF `logText` with 3 bot lines + 1 human Chrome line + 1 junk line → `{ingested: 3, skipped: 2}`.
3. Summary (`daysBack=30`): `totalHits 6`, `byType {training:3, search:1, citation-engine:1, unknown:1}`, `byVendor` openai:3 / perplexity:1 / anthropic:1 / other:1, `topUrls` `/pricing:3, /blog/listicle:1, /blog/ai-seo:1, /:1`, `lastSeen` correct.
4. `?botType=search` → exactly 1 hit (OAI-SearchBot).
5. Empty ingest (`hits: []`) → **400** `No parseable hits…`.
6. Bug found + fixed during e2e: `?limit=3` returned 400 (missing `@Type(() => Number)` on the query DTO) — fixed, hits listing verified.

Test rows wiped afterward; test server killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| SOP-3 crawler-log sweep | `logText` ingest + registry classification |
| §4.5 training vs search split | `byType` roll-up in summary |
| FR-9.x evidence inputs | CrawlerHit counts surface in monitoring `GET /snapshot` |