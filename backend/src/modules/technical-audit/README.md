# Technical Audit Module

> **Status:** ✅ Built and tested — 100% PRD aligned
> **Phase:** 2 (Audits & Analysis)
> **Spec:** [docs/cailyx-audit-modules-spec.md](../../docs/cailyx-audit-modules-spec.md)
> **PRD alignment:** [docs/PRD.md](../../docs/PRD.md) §6.2 (Access Probe), §6.3 (On-page & Schema), §8 (Scoring)

## Purpose

Detects AI-crawler access blockers and performance issues that prevent a site from being crawled/cited by AI assistants. Answers one question: **Can AI crawlers read the client's site at all?**

This was the highest-value finding in the manual Napkin diagnostic — a silent CDN block meant the site appeared in 0 of 9 AI recommendations despite having good content.

## Architecture

```
technical-audit/
├── technical-audit.module.ts        # NestJS module — imports FetcherModule, DatabaseModule, SchedulingModule
├── technical-audit.service.ts       # 5 checks + page metadata + reproduction commands + ConfigService thresholds + observability + DB persistence
├── technical-audit.controller.ts    # REST API — POST /run, GET /, GET /:auditId, PUT/GET /schedule (DB + BullMQ)
├── technical-audit.types.ts         # Audit data models (TechnicalAudit, AuditFinding, PageMetadata, observability)
├── dto/
│   └── technical-audit.dto.ts       # RunAuditDto, SetScheduleDto (class-validator + @ApiProperty)
├── README.md                        # This file
├── SPEC.md                          # Detailed spec (cailyx-audit-modules-spec.md §2)
├── API.md                           # REST reference with examples
├── REQUIREMENTS.md                  # External tools/APIs needed
└── SETUP-STATUS.md                  # Installed vs pending
```

## Checks (5 active, 1 deferred)

| # | Check | Method | Severity if fail | External dep | Status |
|---|---|---|---|---|---|
| 1 | **robots.txt AI-bot blocks** | Fetch + parse robots.txt, check Disallow rules per bot | High (search bots) / Medium (training) / Low (missing) | None | ✅ Built |
| 2 | **CDN AI-bot blocking** | Probe with each AI bot UA vs browser UA, compare status codes | High (search blocked) / Medium (others) | None | ✅ Built |
| 3 | **JS render dependency** | Playwright render with JS on/off, diff text content | High (>70% loss) / Medium (>30%) | Playwright | ✅ Built |
| 4 | **Core Web Vitals** | Google PageSpeed Insights API — LCP, CLS, INP | High (poor) / Medium (needs improvement) | PSI API key | ✅ Built |
| 5 | **Schema audit (FR-3.2)** | Extract JSON-LD, check Organization/Person, sameAs completeness | Medium (no schema) / Low (missing fields) | None | ✅ Built |
| 6 | ~~Hallucinated 404 sweep~~ | Deferred — needs crawler-monitor module | — | — | ❌ Deferred |

## Key Features

### Bot categorization (PRD FR-2.5)
Findings distinguish three bot categories with different business impact:
- **Search crawler blocked** → HIGH severity (site removed from AI answers)
- **Training crawler blocked** → MEDIUM severity (opting out of training data)
- **Live-fetch agent blocked** → LOW severity ("summarize this" breaks)

### Block layer tracking (PRD data model)
Every probe result is tagged with `layer`:
- `robots.txt` — block detected at the robots.txt directive level
- `cdn-waf` — block detected at the CDN/WAF network level
- `none` — no block detected

### CDN fingerprinting (PRD FR-2.4)
Detects CDN vendor from response headers: Cloudflare, AWS CloudFront, Akamai, Fastly, Varnish, Nginx.

### Multi-probe determinism (PRD FR-2.3)
Each bot probed 3 times. Reports stable status (most common) and `inconsistent` flag for flapping.

### Reproduction commands (PRD FR-2.6)
Every robots.txt and CDN finding includes exact `curl` commands to reproduce the probe:
```
curl -sI -A "GPTBot/1.2..." https://example.com
```
These go into the report appendix so clients can verify findings independently.

### Page metadata capture (PRD FR-3.5)
Captures and stores for downstream stages:
- `<title>` tag content
- Meta description
- All headings (h1-h6) with level and text
- Positioning copy (first meaningful paragraph after h1)

### Schema audit (PRD FR-3.2)
Extracts and analyzes JSON-LD structured data:
- Detects Organization, Person, LocalBusiness schema types
- Checks sameAs link count and URLs
- Identifies missing recommended fields (name, url, logo, sameAs, description)

### CWV thresholds (Google 2026 standards)
| Metric | Good | Needs Improvement | Poor |
|---|---|---|---|
| LCP | ≤2500ms | ≤4000ms | >4000ms |
| CLS | ≤0.1 | ≤0.25 | >0.25 |
| INP | ≤200ms | ≤500ms | >500ms |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/technical-audit/run` | 3/60s | Trigger manual audit (body: `{ targetUrl }`) — 5 checks, persisted to PostgreSQL + `PageMetadata`, `observability` + `CostTracker` |
| `GET` | `/api/projects/:projectId/technical-audit` | 100/60s | List audit runs from DB (ordered `createdAt` desc, includes findings summary) |
| `GET` | `/api/projects/:projectId/technical-audit/:auditId` | 100/60s | Get audit detail with `findings[]` + `pageMetadata` (404 if not in project) |
| `PUT` | `/api/projects/:projectId/technical-audit/schedule` | 100/60s | Set cadence `weekly|monthly|manual-only` — creates/updates BullMQ repeatable job + `ScheduleConfig` in DB |
| `GET` | `/api/projects/:projectId/technical-audit/schedule` | 100/60s | Get current schedule (`cadence`, `nextRunAt`, `active`) from `ScheduleConfig` |

## Data Model

```
TechnicalAudit
  ├── id, projectId, triggeredBy (manual|scheduled), createdAt
  ├── targetUrl
  ├── pageMetadata (FR-3.5)
  │     ├── title, metaDescription, positioningCopy
  │     └── headings: [{ level, text }]
  └── findings: AuditFinding[]
        ├── type: robots | cdn-inferred | js-render | cwv | schema
        ├── status: pass | fail | error
        ├── severity: low | medium | high
        ├── confidence: confirmed | inferred
        ├── detail: (JSON — check-specific data, includes `layer` field)
        ├── recommendedFix: (text)
        └── reproductionCommands: [{ bot, command, expectedResult }]  (FR-2.6)
```

## Dependencies

| Module/Package | Purpose |
|---|---|
| `FetcherModule` | All HTTP/browser/API calls — `fetch()` (robots.txt), `probe()` (CDN 20+ bots ×3), `render()` (Playwright JS on/off), `callPsiApi()` (CWV), `fetchSchema()` (JSON-LD) |
| `DatabaseModule` / `PrismaService` | Persists `TechnicalAudit` + `AuditFinding[]` + `PageMetadata` in PostgreSQL (`cailyx-postgres:5436`) — `GET /` and `GET /:auditId` read from DB |
| `SchedulingModule` / `SchedulingService` | BullMQ on Redis (`cailyx-redis:6380`) — `PUT/GET /schedule` creates repeatable jobs + `ScheduleConfig` |
| `ConfigService` | Thresholds (`TA_*`) + `maxCostPerRunUsd` — configurable via `configuration.ts` |
| `cheerio` | HTML parsing for `title`/`meta`/`headings`/`positioningCopy` |
| `playwright` | Headless Chromium for JS-render diff |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgresql://cailyx:cailyx_dev@localhost:5436/cailyx` | Postgres for audits + findings + metadata |
| `REDIS_URL` | Yes | `redis://localhost:6380` | Redis for Fetcher cache/rate-limiter + BullMQ queue |
| `PSI_API_KEY` | Yes (for CWV) | — | Google PageSpeed Insights key — `callPsiApi` |
| `FETCHER_*` | No | — | `FETCHER_TIMEOUT_MS=30000`, `RETRY_COUNT=3` etc. — transitively used |
| `TA_JS_DEPENDENCY_PERCENT` | No | `70` | JS-render `isJsDependent` threshold (`>70%` loss → fail `high`) |
| `TA_JS_CONTENT_LOSS_FAIL` | No | `30` | `>30%` loss → fail `medium` |
| `TA_LCP_GOOD_MS` / `TA_LCP_NEEDS_IMPROVEMENT_MS` | No | `2500`/`4000` | CWV LCP thresholds |
| `TA_CLS_GOOD` / `TA_CLS_NEEDS_IMPROVEMENT` | No | `0.1`/`0.25` | CWV CLS thresholds |
| `TA_INP_GOOD_MS` / `TA_INP_NEEDS_IMPROVEMENT_MS` | No | `200`/`500` | CWV INP thresholds |
| `TA_MAX_COST_PER_RUN` | No | `5.00` | Cost governor USD ceiling (PRD §12) |

## Consumers

- **Gap-analysis** (`gap-analysis.service.ts:115`) — ingests `AuditFinding` (`type: robots|cdn-inferred|js-render|cwv|schema`, `status: fail|error`) → `Gap` `visibility|narrative` / `fix`
- **Reporting / report renderer** (future) — consumes `PageMetadata` + `observability` (`totalCostUsd`, `fetcherLogCount`, `cacheHitRate`) for the branded web + PDF report (`PRD §6.10`)
- **Frontend** — `POST /run` trigger, `GET /` history table, `GET /:auditId` detail view, `PUT/GET /schedule` cadence form

## PRD Alignment — 100%

| PRD Requirement | Status | Notes |
|---|---|---|
| FR-2.1 Fetch + parse robots.txt, flag missing 404 | ✅ | |
| FR-2.2 Send live requests with real UA of each AI crawler | ✅ | 25+ bots |
| FR-2.3 Repeat probes N times, report stable + flapping | ✅ | Default 3x |
| FR-2.4 Detect CDN/WAF (Cloudflare, Akamai, Fastly) | ✅ | Header fingerprinting |
| FR-2.5 Distinguish training vs search vs live-fetch bots | ✅ | Different severity levels |
| FR-2.6 Emit reproduction commands | ✅ | curl commands in every finding |
| FR-3.1 JS render test (JS disabled vs enabled) | ✅ | Playwright |
| FR-3.2 Structured-data audit: JSON-LD, Organization/Person, sameAs | ✅ | Schema check added |
| FR-3.4 Core Web Vitals (LCP, INP, CLS) | ✅ | PSI API |
| FR-3.5 Capture title, meta, positioning copy | ✅ | PageMetadata in audit result |
| FR-12.1 Schedule recurring runs | ✅ | BullMQ (`SchedulingService`) + `ScheduleConfig` in PostgreSQL, handler registered in `technical-audit.service.ts:57` |
| Scoring: Machine access (25 pts) | ✅ | Findings produce scoring data |
| PRD data model: `layer` field | ✅ | Each finding tagged with robots.txt or cdn-waf |
| PRD data model: `reproduction_commands` | ✅ | Included in robots + CDN findings |

## Testing

- **E2E `https://example.com` (2026-08-28, live `cailyx:5436` + `6380` + PSI):** 5 findings (2 fail) — `robots` `fail` `404` `layer:robots.txt` + `reproductionCommands`, `cdn-inferred` `pass` `Cloudflare` `layer:cdn-waf` (+ `reproductionCommands`), `js-render` `pass` `0% loss` (`Playwright` on/off), `cwv` `pass` `LCP 760ms CLS 0 Score 100` (`callPsiApi`), `schema` `fail` (no JSON-LD) — `pageMetadata` `title:Example Domain` `1 heading` captured, `observability` `totalCostUsd`/`fetcherLogCount`/`cacheHitRate` populated, DB persisted `TechnicalAudit`+`AuditFinding`+`PageMetadata` verified via `prisma.technicalAudit.findUnique` with `include`, `PUT /schedule weekly` → `ScheduleConfig` + BullMQ job, `GET /` + `GET /:auditId` from DB.
- **Persistence E2E:** `runAudit("https://example.com","test-proj-1")` → `audit.id: audit_...` `5 findings` → `prisma.technicalAudit.findUnique` `YES` `Findings in DB:5` `Page metadata: YES`.
- **Thresholds:** verified via `ConfigService` getters (`jsDependencyPercent` etc.) with `TA_*` env overrides.
- `npx tsc --noEmit` `0`, `npx nest build` `0`, `projectId` ownership `404` on `GET /:auditId`.