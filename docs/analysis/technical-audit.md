# Technical Audit — Tool & Technology Analysis

> **Module:** `technical-audit` (SOP-3 / PRD §6.2, §6.3)
> **Date:** 2026-08-28 · **Status:** Built (retrospective analysis doc to satisfy AGENTS §3)

## What the module does

Detects AI-crawler access blockers + performance: `robots.txt` AI-bot Disallow, CDN/WAF UA-triggered 403 (header-sniff + probe vs browser control), JS-render dependency (Playwright on/off text diff), Core Web Vitals (PSI API LCP/INP/CLS), JSON-LD schema (`Organization`/`Person` + `sameAs` completeness). Every finding carries `layer` (`robots.txt`|`cdn-waf`), `confidence` (`confirmed`|`inferred`), `severity`, `detail` JSON, `recommendedFix`, `reproductionCommands` (`curl -A` UA). Also captures `PageMetadata` (title/meta/headings/positioningCopy) for downstream entity-audit. Scheduled via BullMQ.

## External tools / APIs — 2-3 options each

| Need | Option A | Option B | Option C | Recommendation |
|---|---|---|---|---|
| **HTTP / probe** | `axios` + custom UA + retry | `got` | Node `fetch` | **A: `axios` via `HttpClientService`** — already used in `FetcherModule`, with `RetryService` (`max3` + `backoff`) + `RateLimiterService` (per-domain 3s, global 10/s) + `CacheService` (Redis). No new dep. |
| **Headless render** | `playwright` (Chromium) | `puppeteer` | `happy-dom/jsdom` (no real render) | **A: `playwright`** — SOP-3 requires real render on/off. `backend` already `playwright@1.62`. |
| **CWV** | Google PageSpeed Insights API (`psiAdapter`) | `web-vitals` (RUM) | `chrome-ux-report` (CrUX) | **A: PSI API** — official deterministic field+lab LCP/CLS/INP. `PSI_API_KEY` (`docs/PRD.md:26` Free 25k/d). Cached 24h in `FetcherService.callPsiApi` via Redis. |
| **CDN/WAF detection** | Response header sniff (`server`/`cf-ray`/`via`/`x-amz-cf-id`) + probe compare | CDN vendor API (Cloudflare API token) | DNS lookup | **A: header-sniff + probe** — SPEC §2 “header-sniffing only, no OAuth”. Probes each AI bot UA ×3 (`fetcher.probe`) with `isBlockedStatus` 403/429 + challenge page heuristics, `layer:cdn-waf` + `inferred` confidence. No token needed. |
| **robots.txt parse** | Custom parser in `technical-audit.service.ts:275` (handles `User-agent` groups, `Allow` override, wildcard `*` expansion) | `robots-parser` lib | `robots-txt-guard` | **A: custom parser** — deterministic, no extra dep, expands `*` to all known bots (`fetcher.constants.ts:7` `ALL_PROBEABLE_BOTS`). |
| **HTML parse** | `cheerio` | `jsdom` | regex | **A: `cheerio`** — title/meta/headings extraction (`extractTitle` etc.). Already `cheerio@1.2`. |
| **Persistence** | PostgreSQL via `PrismaService` (`cailyx-postgres:5436`) | SQLite file | in-memory | **A: Postgres** — consistent with `entity-audit`/`gap-analysis`, powers `GET /`, `GET /:auditId`, `ScheduleConfig`. |
| **Scheduling** | BullMQ on Redis (`SchedulingModule` + `SchedulingService`) | `@nestjs/schedule` cron | DB polling | **A: BullMQ** — `SchedulingService` already global, `registerHandler('technical-audit', ...)` in `technical-audit.service.ts:57`, `PUT/GET /schedule` creates repeatable job + `ScheduleConfig` row. |
| **Cost/timing observability** | `CostTrackerService` + `fetcher.getLogsByRun(runId)` | none | ad-hoc | **A:** already in `technical-audit.service.ts:145` `observability` (`totalCostUsd`, `fetcherLogCount`, `totalLatencyMs`, `cacheHitRate`) — PRD §12. |

**No new npm packages** beyond already installed `playwright`, `cheerio`, `axios`, `bullmq`, `ioredis`, `@prisma/client`.

## Database entities

`TechnicalAudit(id, projectId, targetUrl, triggeredBy, createdAt)` 1—* `AuditFinding(id, auditId FK cascade, type, status, severity, confidence, detail Json, recommendedFix, reproductionCommands Json?)` indexed `(type,status)`, 1—1 `PageMetadata(auditId unique, title, metaDescription, headings Json, positioningCopy)` + `ScheduleConfig(projectId unique, cadence, nextRunAt, active)` + `FetchLog` (read via Fetcher).

## API endpoints

`POST /projects/:projectId/technical-audit/run` `{targetUrl}` `3/60s` → `TechnicalAudit` + `findings[]` + `pageMetadata` + `observability`; `GET /` list from DB; `GET /:auditId` detail (404 project-scoped); `PUT /schedule` `{cadence: weekly|monthly|manual-only}` (needs `targetUrl` from latest audit or `manual-only`); `GET /schedule`.

## Frontend

History table (`GET /`), detail view (`findings` with `layer` badge + `reproductionCommands` copy buttons), schedule form. Deferred — backend is the source of truth; frontend consumes same REST.

## Decisions confirmed

Header-sniff only (no CDN token), custom robots parser, Playwright, PSI API, Postgres+Prisma, BullMQ via `SchedulingModule`.
