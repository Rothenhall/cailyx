# Cailyx API Documentation

> **Base URL:** `http://localhost:3002/api`
> **Swagger UI:** `http://localhost:3002/api/docs`
> **Format:** JSON
> **Auth:** JWT bearer tokens — a global guard requires
> `Authorization: Bearer <accessToken>` on every endpoint except the
> `@Public()` ones (health, auth register/login/refresh/logout, `/api/docs`).
> Client-account tokens are default-deny outside `@ClientPortal()` routes.
> See the Auth Module section below.

---

## Setup

### Prerequisites
- Node.js v22+ (managed via Volta)
- Docker Desktop (for Redis)
- Google PageSpeed Insights API key (free — https://console.cloud.google.com)

### Quick Start

```bash
# 1. Start Redis
docker compose up -d                    # from Cailyx root — starts Redis on port 6380

# 2. Configure backend
cd backend
cp .env.example .env                   # copy template
# Edit .env — fill in PSI_API_KEY

# 3. Install dependencies
npm install

# 4. Start the server
npm run start:dev                      # starts on http://localhost:3002
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3002` | API server port (backend `.env.example:2`) |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Frontend origin for CORS |
| `DATABASE_URL` | Yes | `postgresql://cailyx:cailyx_dev@localhost:5436/cailyx` | Postgres (`cailyx-postgres:5436`, 12 Prisma models) |
| `REDIS_URL` | Yes | `redis://localhost:6380` | Redis (`cailyx-redis:6380`, cache + rate-limiter + BullMQ) |
| `PSI_API_KEY` | Yes (for CWV) | — | Google PSI key (`technical-audit` `callPsiApi`, `FETCHER_*` transitively) |
| `FETCHER_TIMEOUT_MS` | No | `30000` | HTTP timeout (schema/sameAs + probe) |
| `FETCHER_RETRY_COUNT` | No | `3` | Max retries (`RetryService`) |
| `FETCHER_RATE_LIMIT_PER_DOMAIN_MS` | No | `3000` | Per-domain limiter (ms) |
| `FETCHER_RATE_LIMIT_GLOBAL_PER_SEC` | No | `10` | Global limiter (per sec) |
| `TA_JS_DEPENDENCY_PERCENT` | No | `70` | `technical-audit` `isJsDependent` `>70%` loss → `high` (`ConfigService`) |
| `TA_JS_CONTENT_LOSS_FAIL` | No | `30` | `>30%` loss → `fail` `medium` |
| `TA_LCP_GOOD_MS` | No | `2500` | CWV `LCP` good ≤2500ms |
| `TA_LCP_NEEDS_IMPROVEMENT_MS` | No | `4000` | CWV `LCP` needs-improvement ≤4000ms |
| `TA_CLS_GOOD` | No | `0.1` | CWV `CLS` good |
| `TA_CLS_NEEDS_IMPROVEMENT` | No | `0.25` | CWV `CLS` needs-improvement |
| `TA_INP_GOOD_MS` | No | `200` | CWV `INP` good ≤200ms |
| `TA_INP_NEEDS_IMPROVEMENT_MS` | No | `500` | CWV `INP` needs-improvement ≤500ms |
| `TA_MAX_COST_PER_RUN` | No | `5.00` | Cost governor USD ceiling (PRD §12) |

### Team Setup

```bash
git clone <repo>
cd Cailyx
docker compose up -d          # starts Redis
cd backend
cp .env.example .env          # copy template, fill in PSI_API_KEY
npm install
npm run start:dev
```

### Docker Compose

The `docker-compose.yml` at the Cailyx root starts Redis for caching, rate-limiting, and job queues:

```bash
docker compose up -d        # start
docker compose down          # stop
docker compose logs -f       # view logs
```

Redis runs on port **6380** (not 6379) to avoid conflicts with other projects.

---

## Global Configuration

- **Global prefix:** All routes are under `/api/`
- **Validation:** Global `ValidationPipe` with `whitelist`, `transform`, `forbidNonWhitelisted`
- **Rate limiting:** Global `ThrottlerGuard` — 100 requests per 60s per IP (default)
- **Swagger:** Interactive docs at `/api/docs`
- **CORS:** Enabled for `CORS_ORIGIN` (default: `http://localhost:3000`)

---

## Modules and their API docs

Each module has its own `API.md` inside its module folder with detailed endpoint documentation.

### Auth Module
- **Module type:** Feature (REST API) + global guards — **ALL other endpoints require a bearer token**
- **API docs:** [`backend/src/modules/auth/README.md`](../backend/src/modules/auth/README.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register operator (first account = admin bootstrap; then admin-gated) | 5/60s |
| `POST` | `/api/auth/login` | Login → access + refresh tokens | 10/60s |
| `POST` | `/api/auth/refresh` | Rotate refresh token → new pair (reuse detection revokes all sessions) | 20/60s |
| `POST` | `/api/auth/logout` | Revoke refresh token (idempotent) | 100/60s |
| `GET` | `/api/auth/me` | Current operator profile | 100/60s |

**Auth header:** `Authorization: Bearer <accessToken>` on every endpoint except `@Public()` routes (health, auth register/login/refresh/logout, `/api/docs`).

### Database Module
- **Module type:** Infrastructure (global — available to all modules via DI)
- **API docs:** [`backend/src/modules/database/API.md`](../backend/src/modules/database/API.md)
- **Exposes:** `PrismaService` — Prisma ORM access to PostgreSQL
- **Models:** TechnicalAudit, AuditFinding, PageMetadata, ScheduleConfig, FetchLog, EntityAudit, Entity, SchemaCheck, PlatformRecord, ModelDiff, GapAnalysis, Gap

### Scheduling Module
- **Module type:** Infrastructure (shared — imported by feature modules)
- **API docs:** [`backend/src/modules/scheduling/API.md`](../backend/src/modules/scheduling/API.md)
- **Exposes:** `SchedulingService` — BullMQ-based recurring task management

### Health Module
- **Module type:** Infrastructure (always present)
- **API docs:** [`backend/src/modules/health/API.md`](../backend/src/modules/health/API.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/health` | Server health check | 100/60s |

### Fetcher Module
- **Module type:** Internal (no REST endpoints — injected via DI)
- **API docs:** [`backend/src/modules/fetcher/API.md`](../backend/src/modules/fetcher/API.md)
- **Exposes:** `FetcherService` with methods: `fetch()`, `probe()`, `render()`, `fetchSchema()`, `verifyUrl()`, `callPsiApi()`

### Technical Audit Module
- **Module type:** Feature (REST API)
- **API docs:** [`backend/src/modules/technical-audit/API.md`](../backend/src/modules/technical-audit/API.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/technical-audit/run` | Run full audit (5 checks) | 3/60s |
| `GET` | `/api/projects/:projectId/technical-audit` | List audit runs | 100/60s |
| `GET` | `/api/projects/:projectId/technical-audit/:auditId` | Get audit detail | 100/60s |
| `PUT` | `/api/projects/:projectId/technical-audit/schedule` | Set cadence | 100/60s |
| `GET` | `/api/projects/:projectId/technical-audit/schedule` | Get cadence | 100/60s |

### Entity Audit Module
- **Module type:** Feature (REST API)
- **Status:** ✅ Built (model-diff execution deferred — schema ready, see `backend/src/modules/entity-audit/LEFT-OUT.md`)
- **API docs:** [`backend/src/modules/entity-audit/API.md`](../backend/src/modules/entity-audit/API.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/entity-audit/entities` | Add entity (brand/product/founder/metric) | 100/60s |
| `GET` | `/api/projects/:projectId/entity-audit/entities` | List all entities | 100/60s |
| `GET` | `/api/projects/:projectId/entity-audit/entities/:entityId` | Get entity detail (ownership-checked) | 100/60s |
| `PATCH` | `/api/projects/:projectId/entity-audit/entities/:entityId` | Update entity (partial) | 100/60s |
| `DELETE` | `/api/projects/:projectId/entity-audit/entities/:entityId` | Delete entity (cascade) | 100/60s |
| `POST` | `/api/projects/:projectId/entity-audit/entities/:entityId/schema-check/run` | Run schema check (JSON-LD + sameAs) | 5/60s |
| `GET` | `/api/projects/:projectId/entity-audit/entities/:entityId/schema-checks?limit=` | Schema-check history (newest first) | 100/60s |
| `POST` | `/api/projects/:projectId/entity-audit/entities/:entityId/platform-record` | Add platform record (manual + semi-auto `verifySource`) | 100/60s |
| `PATCH` | `/api/projects/:projectId/entity-audit/entities/:entityId/platform-records/:recordId` | Update platform record | 100/60s |
| `DELETE` | `/api/projects/:projectId/entity-audit/entities/:entityId/platform-records/:recordId` | Delete platform record | 100/60s |
| `GET` | `/api/projects/:projectId/entity-audit/entities/:entityId/platform-consistency` | Check name consistency | 100/60s |
| `GET` | `/api/projects/:projectId/entity-audit` | Full audit summary | 100/60s |
| `GET` | `/api/projects/:projectId/entity-audit/entities/:entityId/model-diffs` | List model-diff history (per-provider rows) | 100/60s |
| `POST` | `/api/projects/:projectId/entity-audit/entities/:entityId/model-diff/run` | Run model-diff (Claude + Perplexity surfaces via measurement adapters, Claude judge for `Aligned:`/`Divergent:`) — 503 without keys | 5/60s |

### Gap Analysis Module
- **Module type:** Feature (REST API)
- **Status:** ✅ Built
- **API docs:** [`backend/src/modules/gap-analysis/API.md`](../backend/src/modules/gap-analysis/API.md)
- **Mapping table:** `backend/src/modules/gap-analysis/gap-analysis.service.ts` `CLASSIFICATION_RULES` (reviewable constant, SPEC §4.4)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/gap-analysis?dimension=&action=&status=` | List gaps (filterable, `priorityScore` desc nulls last) | 100/60s |
| `GET` | `/api/projects/:projectId/gap-analysis/gaps/:gapId` | Get gap detail (404 if not in project) | 100/60s |
| `POST` | `/api/projects/:projectId/gap-analysis/sync` | Re-run auto-classification (idempotent upsert) | 100/60s |
| `PATCH` | `/api/projects/:projectId/gap-analysis/gaps/:gapId` | Override dimension/action/status + set 1-5 priority inputs (recomputes `priorityScore`) | 100/60s |
| `GET` | `/api/projects/:projectId/gap-analysis/roadmap` | Roadmap grouped by `fix→build→influence`, sorted `priorityScore` | 100/60s |

### Projects Module
- **Module type:** Feature (REST API)
- **API docs:** [`backend/src/modules/projects/API.md`](../backend/src/modules/projects/API.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects` | Create project (domain unique) | 10/60s |
| `GET` | `/api/projects` | List, filter by status, search | 100/60s |
| `GET` | `/api/projects/:id` | Detail + artifact stats | 100/60s |
| `PATCH` | `/api/projects/:id` | Update fields | 100/60s |
| `PUT` | `/api/projects/:id/transition` | Lifecycle: scorecard → diagnostic → sprint → retainer | 100/60s |
| `DELETE` | `/api/projects/:id` | Delete project (admin only) | 100/60s |

### Intake Module
- **Module type:** Feature (REST API)
- **API docs:** see `backend/src/modules/intake/intake.controller.ts` (README pending)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/intake/subject` | Intake a domain → create/attach project + auto-enrichment | 5/60s |
| `POST` | `/api/intake/bulk` | Bulk CSV intake (array of domains) | 2/60s |
| `GET` | `/api/intake/enrichments/count` | Count of enrichments performed (admin) | 100/60s |

### Measurement Module
- **Module type:** Feature (REST API) — Wave 1 moat (PRD §6.6–6.7, SOP-2)
- **API docs:** `backend/src/modules/measurement/README.md` (surface adapters, hard rules) + `backend/src/modules/measurement/API.md`
- **Design rules:** n≥5 per prompt per surface per geo (lowers are 400); rates never positions; surfaces are adapters (`claude`, `perplexity`; `mock` test-only behind `MEASUREMENT_ALLOW_MOCK=1`); per-run cost cap `MEASUREMENT_MAX_COST_PER_RUN`
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/measurement/runs` | Create run vs active query set (n≥5 enforced) | 10/60s |
| `POST` | `/api/projects/:projectId/measurement/runs/:runId/execute` | Execute all prompts × n (cost-capped; per-obs error isolation) | 3/60s |
| `GET` | `/api/projects/:projectId/measurement/runs` | List runs (`?surface=` filter) | 100/60s |
| `GET` | `/api/projects/:projectId/measurement/runs/:runId` | Run + observations | 100/60s |
| `GET` | `/api/projects/:projectId/measurement/summary` | Mention/citation rates + share of voice (rates, never positions) | 100/60s |

### Scoring Module
- **Module type:** Feature (REST API) + library service — Wave 2 (PRD §8, FR-8.1–8.4)
- **API docs:** `backend/src/modules/scoring/README.md`
- **Design rules:** versioned rubrics (weights must sum to 100), evidence-linked sub-scores, partial dimensions flagged with reasons (never silent zeros), PRD bands (invisible/faint/present/recommended). Rubric v1 auto-seeds on first score. Reporting consumes this service.
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/scoring/run` | Score against active rubric, persist ScoreRun | 10/60s |
| `GET` | `/api/projects/:projectId/scoring` | List score runs (newest first, evidence included) | 100/60s |
| `GET` | `/api/projects/:projectId/scoring/latest` | Latest score run | 100/60s |
| `GET` | `/api/projects/:projectId/scoring/:runId` | One score run + evidence | 100/60s |
| `GET` | `/api/rubrics` | List rubric versions | 100/60s |
| `POST` | `/api/rubrics` | Create rubric version (weights sum to 100) | 5/60s |

### Claims Module
- **Module type:** Feature (REST API) + library — Wave 2 (FR-9.4 hard guardrail)
- **API docs:** `backend/src/modules/claims/README.md`
- **Design rules:** deterministic banned-phrase blocker, grade A (own n≥5 measurement) / B (2+ independent sources) / C (single source); approval is a hard gate — banned-phrase, single-run-rate, and ungraded-numeric claims can never be approved.
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/claims/check` | Discipline-check arbitrary copy | 30/60s |
| `POST` | `/api/projects/:projectId/claims` | Register claim (auto-checked; banned → blocked) | 20/60s |
| `GET` | `/api/projects/:projectId/claims?status=` | List claims (draft/approved/blocked) | 100/60s |
| `GET` | `/api/projects/:projectId/claims/:claimId` | Claim + full check report + sources | 100/60s |
| `POST` | `/api/projects/:projectId/claims/:claimId/approve` | Hard-gated approval | 100/60s |
| `POST` | `/api/projects/:projectId/claims/:claimId/sources` | Attach source (2 independent → auto-B) | 100/60s |

### Findings Module
- **Module type:** Feature (REST API) — Wave 2 (FR-9.1–9.3)
- **API docs:** `backend/src/modules/findings/README.md`
- **Design rules:** constrained-LLM what/why/fix copy (executive + technical registers) from ranked open gaps; claims-discipline filtered (banned copy regenerated once, then skipped); `thinRun` honest flag below the non-obvious evidence threshold; requires `ANTHROPIC_API_KEY` (503 otherwise).
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/findings/generate` | Generate findings from open gaps (LLM + claims filter) | 3/60s |
| `GET` | `/api/projects/:projectId/findings` | List findings (thinRun flagged) | 100/60s |
| `GET` | `/api/projects/:projectId/findings/:findingId` | One finding, both registers | 100/60s |

### Reporting Module
- **Module type:** Feature (REST API)
- **API docs:** [`backend/src/modules/reporting/API.md`](../backend/src/modules/reporting/API.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/reports` | Generate branded report (executive + detailed HTML, §8 scoring) | 3/60s |
| `GET` | `/api/projects/:projectId/reports` | List reports | 100/60s |
| `GET` | `/api/projects/:projectId/reports/:reportId` | Report detail | 100/60s |

### Query Set Module
- **Module type:** Feature (REST API)
- **API docs:** [`backend/src/modules/query-set/API.md`](../backend/src/modules/query-set/API.md)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/query-sets?status=` | List all sets/versions (items included) | 100/60s |
| `POST` | `/api/projects/:projectId/query-sets` | Create v1 draft set for one persona | 10/60s |
| `GET` | `/api/projects/:projectId/query-sets/export` | Export all sets + prompt rows (client owns it) | 100/60s |
| `GET` | `/api/projects/:projectId/query-sets/:setId` | Set detail with items | 100/60s |
| `POST` | `/api/projects/:projectId/query-sets/:setId/prompts` | Add prompt (draft only) | 60/60s |
| `DELETE` | `/api/projects/:projectId/query-sets/:setId/prompts/:itemId` | Remove prompt (draft only) | 100/60s |
| `POST` | `/api/projects/:projectId/query-sets/:setId/activate` | Activate — immutable, requires ≥ 1 prompt | 20/60s |
| `POST` | `/api/projects/:projectId/query-sets/:setId/fork` | Next draft version (copies prompts) | 10/60s |

### Crawler Monitor Module
- **Module type:** Feature (REST API) — Wave 3 (SOP-3, §4.5)
- **API docs:** `backend/src/modules/crawler-monitor/README.md`
- **Design rules:** static bot registry (14 signatures, longest-substring match); `training` vs `search` vs `citation-engine` vs `unknown`; nothing silently dropped — unparseable entries are counted as skipped
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/crawler-monitor/ingest` | Ingest `hits[]` JSON or combined-log-format `logText` (bot UAs only; rest skipped) | 10/60s |
| `GET` | `/api/projects/:projectId/crawler-monitor/summary?daysBack=` | Roll-up: `{totalHits, byType, byVendor, topUrls (≤20), lastSeen}` | 100/60s |
| `GET` | `/api/projects/:projectId/crawler-monitor/hits?limit=&botType=` | Raw hits, newest first (limit 1–1000) | 100/60s |

### Monitoring Module
- **Module type:** Feature (REST API) — Wave 3 (FR-12.1–12.4)
- **API docs:** `backend/src/modules/monitoring/README.md`
- **Design rules:** reads only existing artifacts (score runs, measurement runs, crawler hits); thresholds score −10 pts / mention-rate −15 pts (severity escalates at −20/−30); alerts persisted as rows; no silent renormalization of partial runs
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/monitoring/snapshot` | Latest score + latest completed measurement (rates) + crawler-hit count; 404 when empty | 100/60s |
| `GET` | `/api/projects/:projectId/monitoring/delta` | Two-latest score runs `{before, after, change}` + observation trend | 100/60s |
| `POST` | `/api/projects/:projectId/monitoring/check` | Compare latest runs vs thresholds, persist Alert rows | 30/60s |
| `GET` | `/api/projects/:projectId/monitoring/alerts?kind=&severity=&limit=` | List alerts (filterable) | 100/60s |
| `PUT` | `/api/projects/:projectId/monitoring/schedule` | Cadence (weekly/monthly/manual-only) — requires Redis (BullMQ) | 100/60s |
| `GET` / `DELETE` | `/api/projects/:projectId/monitoring/schedule` | Read / remove cadence (GET works without Redis) | 100/60s |

---

### Page Analysis Module
- **Module type:** Feature (REST API) — Wave 4 (SOP-6, FR-3.3)
- **API docs:** `backend/src/modules/page-analysis/README.md`
- **Design rules:** strictly deterministic scoring (disclosed weights BLUF 30 / question-H2 25 / format 25 / claims 20 → 0–100, never renormalized); every analyze call persists a row (restructure-comparable history); `useLlm` adds Claude `llmNotes` that are never scored (503 without `ANTHROPIC_API_KEY`, nothing persisted then)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/page-analysis/analyze` | Fetch + analyze a page (BLUF / question-H2 / standalone / extractable claims / format) | 10/60s |
| `GET` | `/api/projects/:projectId/page-analysis` | Analysis history (newest first) | 100/60s |
| `GET` | `/api/projects/:projectId/page-analysis/:analysisId` | One analysis (ownership-checked) | 100/60s |

### Mention Tracking Module
- **Module type:** Feature (REST API) — Wave 4 (SOP-7, FR-4.4)
- **API docs:** `backend/src/modules/mention-tracking/README.md`
- **Design rules:** manual candidate entry + semi-auto **single-fetch** checks (no crawling); mention-check ledger drives decay (`stale` at ≥90 days); outreach lifecycle `new → contacted → replied → placed | rejected`
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` / `GET` | `/api/projects/:projectId/mentions/campaigns` | Target grouping (anchored to a "best X" hunt query) | 100/60s |
| `POST` / `GET` | `/api/projects/:projectId/mentions/targets` | Record / list targets (latest check attached, `?status=` filter) | 100/60s |
| `PATCH` / `DELETE` | `/api/projects/:projectId/mentions/targets/:targetId` | Update lifecycle / delete (checks cascade) | 100/60s |
| `POST` | `/api/projects/:projectId/mentions/targets/:targetId/check` | Semi-auto mention check (brand token + evidence excerpt) | 20/60s |
| `GET` | `/api/projects/:projectId/mentions/targets/:targetId/checks` | Check ledger (newest first) | 100/60s |
| `GET` | `/api/projects/:projectId/mentions/decay?brandToken=` | Decay view (lastMentionedAt / daysSince / stale) | 100/60s |

### Sleeper Refresh Module
- **Module type:** Feature (REST API) — Wave 4 (SOP-10)
- **API docs:** `backend/src/modules/sleeper-refresh/README.md`
- **Design rules:** traffic evidence via manual entry or pasted GSC CSV/TSV (OAuth pull is an external prerequisite, left out); sleeper thresholds decline ≥20% + refs ≥3 (query-overridable); refresh SLA audited via `dateModifiedBefore/After`
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/sleeper-refresh/pages` | Record a candidate | 100/60s |
| `POST` | `/api/projects/:projectId/sleeper-refresh/import` | Import CSV/TSV or `pages[]` (upsert, `{upserted, skipped}`) | 5/60s |
| `GET` | `/api/projects/:projectId/sleeper-refresh/pages` | Candidates sorted by decline (`sleeper`/`not-sleeper`/`unproven`) | 100/60s |
| `GET` | `/api/projects/:projectId/sleeper-refresh/summary` | SLA roll-up (byStatus + dateModifiedMoved) | 100/60s |
| `PATCH` / `DELETE` | `/api/projects/:projectId/sleeper-refresh/pages/:pageId` | Update / delete | 100/60s |
| `POST` | `/api/projects/:projectId/sleeper-refresh/pages/:pageId/refreshed` | Mark shipped (stamps `dateModifiedAfter`) | 100/60s |

### Data Asset Module
- **Module type:** Feature (REST API) — Wave 4 (SOP-8, P3; minimal by design)
- **API docs:** `backend/src/modules/data-asset/README.md`
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/data-asset` | Create asset track (brand alignment, methodology, survey size) | 100/60s |
| `GET` | `/api/projects/:projectId/data-asset` | List (newest first) | 100/60s |
| `PATCH` | `/api/projects/:projectId/data-asset/:assetId` | Update (published stamps `publishedAt`) | 100/60s |
| `DELETE` | `/api/projects/:projectId/data-asset/:assetId` | Delete | 100/60s |

### Pipeline Math Module
- **Module type:** Feature (REST API) — Wave 5 (GTM Playbook qualification arithmetic)
- **API docs:** `backend/src/modules/pipeline-math/README.md`
- **Design rules:** one persisted model per project; every intermediate stage stored, not just the verdict; verdict rule disclosed (required visitors > 1.5 × market → `fiction`, `FICTION_FACTOR` returned in every response)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `PUT` | `/api/projects/:projectId/pipeline-math` | Compute (create/replace): revenueTarget ÷ ACV ÷ winRate ÷ meetingToSql ÷ leadToMeeting ÷ visitorToLead | 100/60s |
| `GET` | `/api/projects/:projectId/pipeline-math` | Current model + stages + verdict (404 with a PUT hint when never computed) | 100/60s |
| `PATCH` | `/api/projects/:projectId/pipeline-math` | What-If recalc (partial body; unspecified inputs keep stored values) | 100/60s |

### Scorecard Module
- **Module type:** Feature (REST API) — Wave 5 (PRD §13 Rung 0, §17 decision: engine now, public via flag)
- **API docs:** `backend/src/modules/scorecard/README.md`
- **Design rules:** fresh technical audit (never blocks the run — failures become partial dimensions with reasons) → versioned-rubric score → exactly **3 named problems** from the run's own evidence, deterministic, no LLM key required; `nonObvious` flag = probe-only facts (blocked/render/schema-fail); public view gated behind `SCORECARD_PUBLIC=1`
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/scorecard` | Run the Rung-0 diagnostic (persists `ScorecardRun` + public share token) | 5/60s |
| `GET` | `/api/projects/:projectId/scorecard` | Run history | 30/60s |
| `GET` | `/api/projects/:projectId/scorecard/public/:publicToken` | Public shareable view (@Public; 403 while flag off) | 30/60s |
| `GET` | `/api/projects/:projectId/scorecard/:runId` | One run (ownership-checked) | 30/60s |

### Delivery Module
- **Module type:** Feature (REST API) — Wave 5 (PRD §6.11 FR-11.1–11.4)
- **API docs:** `backend/src/modules/delivery/README.md`
- **Design rules:** Plunk email (honest 503s: `email-unconfigured` / `email-send-failed`); internal `Lead` CRM + append-only CTA event log + CSV export; Stripe Checkout links env-configured (`STRIPE_CHECKOUT_URL_FULL` / `_MONITORING`, honest 503 absent)
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/delivery/send` | Report-link email (+ testimonial ask); subject operator-editable | 10/60s |
| `POST` / `GET` | `/api/projects/:projectId/delivery/leads` | Capture / list leads (?status=) | 60/60s |
| `GET` | `/api/projects/:projectId/delivery/leads/export` | CSV export for any external CRM | 60/60s |
| `GET` / `PATCH` | `/api/projects/:projectId/delivery/leads/:leadId` | One lead with CTA log / pipeline status | 60/60s |
| `POST` | `/api/projects/:projectId/delivery/leads/:leadId/cta` | Log a CTA click (book-call / review-ask / upgrade-click) | 60/60s |
| `POST` / `GET` | `/api/projects/:projectId/delivery/upgrades` | Issue a checkout link / ledger | 60/60s |
| `POST` | `/api/projects/:projectId/delivery/upgrades/:upgradeId/click` | Log the checkout click (flips the lead's log too) | 60/60s |
| `POST` | `/api/projects/:projectId/delivery/upgrades/:upgradeId/complete` | @Public webhook stand-in (Stripe SDK = next iteration) | 60/60s |

---

## Swarm layer — synthetic-buyer research agents (added 2026-08-30)

- **Analysis / boundary:** `docs/analysis/swarm-layer.md`. Research & measurement only — never generates traffic/clicks/impressions/rankings as a user.
- **Shared gate:** `SWARM_ALLOW_LIVE=1` (+ the surface/vendor key) is required before any live AI-surface or paid SERP call; default adapters are deterministic (`mock` / `fixture`). LLM-optional paths 503 without `ANTHROPIC_API_KEY`.

### Persona Module (Agent #1)
- **API docs:** `backend/src/modules/persona/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` / `POST` | `/api/projects/:projectId/personas` | list (?status=) / hand-author one | 30/60s |
| `POST` | `/api/projects/:projectId/personas/generate` | `{count, roles?, useLlm?}` → deterministic (or LLM-refined) personas; clamped to `PERSONA_MAX_PER_PROJECT` | 30/60s |
| `GET` | `/api/projects/:projectId/personas/export` | full persona set | — |
| `GET`/`PATCH`/`DELETE` | `/api/projects/:projectId/personas/:personaId` | detail / patch (draft only → 409) / delete | 60/60s |
| `POST` | `/api/projects/:projectId/personas/:personaId/activate` \| `/archive` | lifecycle | 60/60s |

### Journey Module (Agent #2)
- **API docs:** `backend/src/modules/journey/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/journeys` | list (?status=) | — |
| `GET` | `/api/projects/:projectId/journeys/suggestions` | deterministic buyer-query **suggestion wheel** (`{hub, spokes[]}` by awareness stage) — feeds the Flywheel card; no LLM, no spend | — |
| `POST` | `/api/projects/:projectId/journeys/plan` | `{personaId, surface?, maxDepth?, maxBranches?, useLlm?}` → branching step tree | 30/60s |
| `GET` | `/api/projects/:projectId/journeys/:journeyId` | detail + step tree | — |
| `POST` | `/api/projects/:projectId/journeys/:journeyId/execute` | run pending steps; `?maxCostUsd=` cap override; stops → `partial` | 20/60s |
| `DELETE` | `/api/projects/:projectId/journeys/:journeyId` | — | — |
| `GET`/`POST` | `/api/projects/:projectId/journey-campaigns` | list / create `{name, journeyTarget, budgetUsd, surface?, personaRoles?, useLlm?, autoRun?}` | 10/60s |
| `GET` | `/api/projects/:projectId/journey-campaigns/:campaignId` | detail + journeys | — |
| `POST` | `/api/projects/:projectId/journey-campaigns/:campaignId/execute` | run remaining journeys under remaining budget | 10/60s |

### SERP Intelligence Module (Agent #3 — DataForSEO)
- **API docs:** `backend/src/modules/serp-intelligence/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET`/`POST` | `/api/projects/:projectId/serp-trackers` | list / create `{name, keywords[], locationName?, languageCode?, device?, provider?}` | 20/60s |
| `GET` | `/api/projects/:projectId/serp-trackers/:trackerId` | detail (+ queries + recent snapshots) | — |
| `POST` | `/api/projects/:projectId/serp-trackers/:trackerId/queries` | add keywords (dedupes; cap 300) | — |
| `DELETE` | `/api/projects/:projectId/serp-trackers/:trackerId/queries/:queryId` | — | — |
| `POST` | `/api/projects/:projectId/serp-trackers/:trackerId/capture` | `{provider?}` → snapshot (subject rank, AI-Overview, competitors, topDomains); `SERP_MAX_COST_PER_CAPTURE` governor | 10/60s |
| `GET` | `/api/projects/:projectId/serp-trackers/:trackerId/snapshots[/:snapshotId]` | list / detail (+ results) | — |
| `DELETE` | `/api/projects/:projectId/serp-trackers/:trackerId` | — | — |

### Authority Module (Agent #6)
- **API docs:** `backend/src/modules/authority/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET`/`POST` | `/api/projects/:projectId/authority-scans` | list / run `{category?, method?, listicleQueries?, useLlm?}` (method ∈ serp\|citations\|llm\|combined) | 12/60s |
| `GET` | `/api/projects/:projectId/authority-scans/:scanId` | detail + ranked candidates | — |
| `PATCH` | `/api/projects/:projectId/authority-scans/:scanId/candidates/:candidateId` | `{status: new\|promoted\|dismissed}` | — |
| `POST` | `/api/projects/:projectId/authority-scans/:scanId/candidates/:candidateId/promote` | → creates a `mention-tracking` MentionTarget | — |
| `DELETE` | `/api/projects/:projectId/authority-scans/:scanId` | — | — |

### Internal-Link Module (Agent #8)
- **API docs:** `backend/src/modules/internal-link/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET`/`POST` | `/api/projects/:projectId/link-graph` | list / crawl the client site `{rootUrl?, maxPages?, maxDepth?, useLlm?}` → graph + orphan/under-linked detection + ranked "add link" recs | 20/60s |
| `GET` | `/api/projects/:projectId/link-graph/:graphId` | full detail (nodes + edges + recs) | — |
| `GET` | `/api/projects/:projectId/link-graph/:graphId/recommendations` | ?status=open\|applied\|dismissed | — |
| `PATCH` | `/api/projects/:projectId/link-graph/:graphId/recommendations/:recId` | `{status}` | — |
| `DELETE` | `/api/projects/:projectId/link-graph/:graphId` | — | — |

### Council Module (Agent #10)
- **API docs:** `backend/src/modules/council/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET`/`POST` | `/api/projects/:projectId/council` | list / run `{question?, rounds?, agentRoles?, useLlm?}` → contributions + ranked interventions (reads existing artefacts only) | 20/60s |
| `GET` | `/api/projects/:projectId/council/:sessionId` | detail | — |
| `DELETE` | `/api/projects/:projectId/council/:sessionId` | — | — |

---

## Dashboard aggregation — Okara Terminal (added 2026-08-30)

Backs the operator console frontend (`frontend/` — the dark 4-pane terminal).

### Integrations Module
- **API docs:** `backend/src/modules/integrations/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/integrations` | Every external connection Cailyx can use — Google Analytics / Search Console (OAuth), Anthropic, Perplexity, DataForSEO, Redis (live ping), Database, Stripe, Plunk, and the `SWARM_ALLOW_LIVE` mode. **PageSpeed Insights is not listed** — `PSI_API_KEY` is a server-side key consumed by `technical-audit`, not an operator-connected integration — each with `connected` + `configHint`. **Booleans + metadata only; no secret values returned.** | default |

### Agents Module
- **API docs:** `backend/src/modules/agents/README.md`

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/agents` | The Agents Feed: one card per capability (SEO, GEO, Articles, Authority, Journey, Persona, Council, Mentions, SERP, Monitoring) with a live `status` / `headline` / `activity[]` derived from what that module has produced for the project. | default |

### Users Module (operator administration — **admin only**)
- **API docs:** `backend/src/modules/users/README.md`
- Login / registration / token rotation stay in `auth`; this is the CRUD behind the dashboard's User Management UI. Never returns password or token hashes. Guard rails: the last `admin` cannot be demoted or deleted, and you cannot delete your own account here.

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `GET` | `/api/users` | list operators (`{ users: SafeUser[] }`) | default |
| `GET` | `/api/users/roles` | role catalogue for the UI | default |
| `POST` | `/api/users` | create operator `{ email, password, name, role }` → SafeUser | 20/60s |
| `GET` | `/api/users/:id` | one operator | default |
| `PATCH` | `/api/users/:id` | update `{ name?, role? }` (409 demoting last admin) | default |
| `POST` | `/api/users/:id/password` | reset password `{ password }` → `{ id, sessionsRevoked }` (revokes their sessions) | 20/60s |
| `DELETE` | `/api/users/:id` | delete operator (400 self, 409 last admin) | default |

---

## AEO Audit — answer-engine visibility (added 2026-09-10)

Analysis + approved decisions: [`docs/analysis/aeo-audit.md`](analysis/aeo-audit.md).
Module docs: [`backend/src/modules/aeo-audit/README.md`](../backend/src/modules/aeo-audit/README.md).

### AEO Audit Module
- **Module type:** Feature (REST API) — orchestrates `fetcher` + `query-set` + `measurement`
- **Design rules:**
  - **Counted vs judged never mix.** `verdict.counted` (mention rate, citation rate,
    share of voice) comes from deterministic extraction over n≥5 repeats and may be
    quoted as a rate. `verdict.judged` (competitive stance) is an LLM reading the same
    answers, stored in its own table, evidence-quoted, and **never** expressed as a rate.
  - **Branded and unbranded prompts are reported separately** — unbranded is the honest
    visibility test.
  - **Every prompt is categorised in storage** (`QuerySetItem.dimension` + `meta`) across
    ten buyer categories, so results can be sliced and the matrix curated afterwards.
  - **A category with no inputs is skipped with a stated reason**, never filled with
    invented values.
  - **Three answer engines**, all measured with the same matrix so they can be compared:
    `chatgpt-browser`, `perplexity-browser`, `gemini-browser`. Each is the vendor's
    consumer product driven in a headless browser with an operator-supplied session.
  - **A failed engine does not void the audit.** Each is measured independently and
    records a typed `failureKind` (`no-session`, `blocked`, `rate-limited`,
    `selector-drift`, …); the verdict's headline names the engines absent from the
    numbers rather than silently averaging over the gap.
  - All engines are **off by default** (`AEO_ALLOW_BROWSER_SURFACE=1` + one session file
    each). Automating these products is against their ToS — see the module README. They
    never bypass a block; they fail the run honestly.
  - Search runs in the browser; **analysis** (context synthesis, prompt phrasing, stance
    judging) runs on OpenRouter with a small cheap model.
- **Endpoints:**

| Method | Path | Description | Rate Limit |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/aeo/context` | Crawl the client site → services, ICP, pains, outcomes. **P03:** a six-stage, resumable pipeline (discover → inspect → select → extract → reconcile → validate); when the elapsed-time budget runs out the response carries `{ paused: true, runId, reachedStage }` instead of a partial context | 5/60s |
| `GET` | `/api/projects/:projectId/aeo/context` | Latest stored site context | default |
| `GET` | `/api/projects/:projectId/aeo/context/runs` | Staged-pipeline run history — stage, budgets, coverage plan (staff) | default |
| `GET` | `/api/projects/:projectId/aeo/context/runs/:runId` | One run in full: every page with its `selectionReason`, every fact with its citation and `validated` flag (staff) | default |
| `POST` | `/api/projects/:projectId/aeo/context/runs/:runId/resume` | Continue a paused or failed run from its last completed stage — already-fetched pages are not re-fetched, already-extracted pages are not re-extracted | 10/60s |
| `POST` | `/api/projects/:projectId/aeo/matrix` | Generate the categorised prompt matrix (stored as a versioned QuerySet) | 5/60s |
| `GET` | `/api/projects/:projectId/aeo/matrix/:querySetId?dimension=` | Read a matrix, grouped by category (the curation view) | default |
| `POST` | `/api/projects/:projectId/aeo/audits` | Create an audit row — no scraping, no spend. Body takes `surfaces[]` to measure several engines with one matrix | default |
| `POST` | `/api/projects/:projectId/aeo/audits/full` | Run every stage to a verdict (long-running) | 3/300s |
| `POST` | `/api/projects/:projectId/aeo/audits/:auditId/resume` | Continue from the last completed stage | default |
| `POST` | `/api/projects/:projectId/aeo/audits/:auditId/stance` | Judge competitive stance (idempotent) | 5/60s |
| `GET` | `/api/projects/:projectId/aeo/audits` | List audits (newest first) | default |
| `GET` | `/api/projects/:projectId/aeo/audits/:auditId` | One audit + stored verdict | default |
| `GET` | `/api/projects/:projectId/aeo/audits/:auditId/verdict` | Recompute the verdict from stored rows | default |

**Prompt categories** (`dimension`): `service-discovery`, `category-best-of`,
`competitor-alternatives`, `head-to-head`, `brand-direct`, `problem-framed`,
`buying-criteria`, `objection-trust`, `job-to-be-done`, `geo-vertical`.

**Stance values** (judged): `recommended-primary`, `recommended-alternative`,
`mentioned-neutral`, `mentioned-negative`, `absent`.

**Engines** (`surfaces[]`): `chatgpt-browser`, `perplexity-browser`,
`gemini-browser`, `mock`. Calls = `prompts × runCount × engines`, so three
engines at the `standard` tier is 1,500 questions — budget time, not just money.

**Pre-flight budget** — `GET /api/projects/:projectId/aeo/budget?surfaces=&tier=&runCount=&markets=`

Prices a run before it starts, so the cost is visible while the tier is still
being chosen rather than at the moment the run is refused.

```json
{ "required": 325, "remaining": 228, "fits": false, "unavailableReason": null,
  "perSurface": [
    { "surface": "cloro-chatgpt",    "label": "ChatGPT (Cloro)",    "credits": 125, "metered": true },
    { "surface": "cloro-perplexity", "label": "Perplexity (Cloro)", "credits": 100, "metered": true },
    { "surface": "cloro-gemini",     "label": "Gemini (Cloro)",     "credits": 100, "metered": true }
  ],
  "calls": 75, "prompts": 5, "runCount": 5, "markets": 1 }
```

Browser surfaces report `credits: 0` and `metered: false` — a subscription pays
for them, and a made-up per-call price would corrupt the total. When the balance
cannot be read, **`remaining` and `fits` are `null`** with `unavailableReason`
set: an unknown balance is neither sufficient nor insufficient.

**Matrix tiers** (`tier`):

| Tier | Prompts | Categories covered | Intended use |
|---|---|---|---|
| `trial` | 5 | 5 of 10 (heaviest-weighted) | Probe on a metered/free allowance — 5 × 3 engines answers *which engine is failing us* |
| `trial-wide` | 10 | 10 of 10 | Same budget spent on breadth instead — *how broad is the problem* |
| `scorecard` | 25 | 10 | Standard client scorecard |
| `standard` | 100 | 10 | Default |
| `full` | 300 | 10 | Deep audit |

A tier smaller than the ten categories cannot cover them all. Rather than thin
every category to one prompt, the generator funds the heaviest-weighted ones and
returns the rest in `skipped[]` with the reason — so a probe is never mistaken for
full coverage. `skipped[]` is also populated when the site context is too thin to
fill a category, which is why a `standard` run can return fewer than 100 prompts.

Example verdict (abridged):

```json
{
  "surface": "chatgpt-browser",
  "surfaceRuns": [
    { "surface": "chatgpt-browser",   "label": "ChatGPT",    "status": "completed", "observations": 500, "failureKind": null,        "error": null },
    { "surface": "perplexity-browser","label": "Perplexity", "status": "completed", "observations": 500, "failureKind": null,        "error": null },
    { "surface": "gemini-browser",    "label": "Gemini",     "status": "failed",    "observations": 0,   "failureKind": "no-session","error": "Session file not found" }
  ],
  "runCount": 5,
  "counted": {
    "overall":   { "prompts": 100, "observations": 500, "mentionRate": 0.184, "citationRate": 0.06 },
    "unbranded": { "prompts": 82,  "observations": 410, "mentionRate": 0.081, "citationRate": 0.032 },
    "branded":   { "prompts": 18,  "observations": 90,  "mentionRate": 0.652, "citationRate": 0.19 },
    "byDimension": [
      { "dimension": "competitor-alternatives", "label": "Competitor alternatives",
        "prompts": 14, "observations": 70, "mentionRate": 0.043, "citationRate": 0.0,
        "stanceCounts": { "recommended-primary": 0, "recommended-alternative": 3,
                          "mentioned-neutral": 0, "mentioned-negative": 0, "absent": 67 } }
    ],
    "shareOfVoice": [ { "name": "Acme (you)", "share": 0.11 }, { "name": "Profound", "share": 0.44 } ],
    "bySurface": [
      { "surface": "chatgpt-browser",    "label": "ChatGPT",    "status": "completed", "observations": 500,
        "mentionRate": 0.184, "unbrandedMentionRate": 0.081, "citationRate": 0.06, "rivalsAheadCount": 186 },
      { "surface": "perplexity-browser", "label": "Perplexity", "status": "completed", "observations": 500,
        "mentionRate": 0.402, "unbrandedMentionRate": 0.310, "citationRate": 0.22, "rivalsAheadCount": 74 }
    ],
    "competitors": [
      { "name": "Profound", "observations": 221, "mentionRate": 0.442,
        "clientAheadCount": 2, "clientBehindCount": 19, "wonWhileClientAbsent": 186 }
    ]
  },
  "judged": {
    "available": true,
    "judgeModel": "claude-opus-5",
    "observationsJudged": 500,
    "stanceCounts": { "recommended-primary": 6, "recommended-alternative": 48,
                      "mentioned-neutral": 30, "mentioned-negative": 8, "absent": 408 },
    "losingPrompts": [
      { "prompt": "alternatives to Profound", "dimension": "competitor-alternatives",
        "losesTo": ["Profound"],
        "evidenceQuote": "For most teams I'd start with Profound, which has the deepest..." }
    ],
    "winningPrompts": []
  },
  "headlines": [
    "Named in 18% of 500 answers on chatgpt-browser (n=5 per prompt).",
    "On the 410 answers to prompts that never mention the brand — the real visibility test — the mention rate is 8%."
  ]
}
```

---

## Digital Presence — where the client exists online (added 2026-09-11, extended 2026-09-12)

### Digital Presence Module

| Method | Endpoint | Rate limit | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/presence` | default | Full inventory: accounts, gaps, footprint, business profile, reviews, social activity, last run |
| `POST` | `/api/projects/:projectId/presence/discover` | 5/60s | Crawl the site for profile links, classify, verify |
| `GET` | `/api/projects/:projectId/presence/discoveries` | default | Discovery run history (newest first) |
| `POST` | `/api/projects/:projectId/presence/accounts` | default | Add an account by URL |
| `POST` | `/api/projects/:projectId/presence/accounts/:accountId/confirm` | default | Accept a search candidate as a real account |
| `PATCH` | `/api/projects/:projectId/presence/accounts/:accountId` | default | Correct an account URL |
| `DELETE` | `/api/projects/:projectId/presence/accounts/:accountId` | default | Remove an account |
| `POST` | `/api/projects/:projectId/presence/business-profile` | 5/60s | **(wave-6 D2)** DataForSEO Business Data pull — Google My Business profile + Google/Trustpilot/Yelp review counts |
| `POST` | `/api/projects/:projectId/presence/social-activity` | 2/60s | **(wave-6 D7)** Apify social-activity pull — posting cadence, followers, engagement. **Opt-in only; spends real account credit** |

**Account states** — three-valued, deliberately:

| State | Meaning |
|---|---|
| `confirmed` | Found and the URL resolved |
| `unverified` | Found on the client's own site, but the platform refused the check |
| `missing` | Nothing linked, nothing supplied |
| `candidate` | Found by Google search — **not known to be theirs**, awaiting confirmation |

**Whose profile** (`entity`): `company` · `personal` · `unknown`. The audit is
about the company; a founder's personal LinkedIn (`/in/…`), Google Scholar or
ORCID profile is recorded but **excluded from `counts.total`** and cannot close a
gap. Decided from the site's own schema `@type` first (a `sameAs` under `Person`
is a person's), then the URL shape.

**Categories** (`group`) mirror stage 2 of the delivery flow: `social` ·
`directory` · `review` · `marketplace` · `publishing` · `personal` · `other`.

**`assessment`** on `GET /presence` is stage 2's *analyse* column:

| Field | Meaning |
|---|---|
| `headlines` | Plain-language read, worst first. Facts and absences, never a score |
| `coverage` | Per category: `covered` / `partial` / `absent` / `not-checked` |
| `notMeasured` | What the module cannot yet reflect, each entry naming **why** — see below |
| `businessProfile` + `inferredFrom` | Which business type the expected platforms came from, and the category text it was guessed from |

**`notMeasured` is three-valued**, the same way account `state` is — it is an
array of `{ label, state, note }`, never a bare string list, so "no code for
this" is never confused with "built, but this environment has no
credentials" or "built and configured, but nobody has run it for this
project":

| `state` | Meaning |
|---|---|
| `not-built` | No code for this yet (e.g. directory-listing completeness) |
| `not-configured` | Built, but the vendor credentials this needs are absent in this environment (e.g. `DATAFORSEO_LOGIN`/`_PASSWORD`, `APIFY_API_KEY`) |
| `not-run` | Built and configured, but nobody has pulled it for **this project** yet |

An item is removed from `notMeasured` entirely once it is built, configured
**and** has data on file for the project — it is never silently dropped just
because the module gained code for it.

Expected platforms are keyed on business type (B2B services, B2B software, local
services, consumer brand), so a consultancy is measured against Clutch and
Crunchbase rather than TikTok. The inference is a heuristic and is reported
alongside its input so a wrong guess can be corrected by editing the project
category.

`unverified` is the routine outcome for Instagram, Facebook, LinkedIn, X, TikTok
and Threads: those platforms wall logged-out requests, so they are not fetched at
all and the row carries the reason verbatim. **It is not `missing`** — treating it
as an absent account would report a working profile as a gap.

**Sources** (`source`): `json-ld-sameas` (declared, wins ties) · `page-link` ·
`serp` (Google suggestion — candidate only) · `manual` (operator entry — outranks
all, never overwritten by a re-scan).

**`POST /discover` body** is optional. `{"searchWeb": true}` additionally sweeps
Google (DataForSEO) for accounts the site does not link. It is **opt-in because it
bills**: one query per platform still missing, so a client already holding 4 of 5
expected platforms costs one query, not five. Responses cache for seven days and a
cache hit is not counted as spend. The default run crawls only and spends nothing —
which is what keeps the smoke harness zero-spend. The run record carries
`serpQueries` (billable only), `serpCostUsd` (the real charge off DataForSEO's
envelope, never estimated), `candidates` and `serpSkipped` (the stated reason no
search ran).

**Candidates are never accounts.** They are excluded from `counts.total`, cannot
close a gap, and are promoted only by `POST /accounts/:accountId/confirm`, which
makes them `manual`. This is not caution for its own sake: a live
`site:instagram.com "HubSpot"` returns three genuine HubSpot accounts plus one
unrelated podcast, and for Notion the *highest* name-similarity hit is not the
official account. `confidence` is an ordering hint; no code branches on it.

**Adding an account** takes only a URL; the platform and handle are derived from
it. A URL that is not a profile is rejected with **400** naming the problem —
share widgets (`facebook.com/sharer.php`), intent links
(`twitter.com/intent/tweet`), posts (`instagram.com/p/…`) and videos
(`youtube.com/watch?v=…`) are all refused rather than stored as accounts.

```json
POST /api/projects/abc123/presence/accounts
{ "url": "https://www.linkedin.com/company/acme-ltd" }

201 →
{
  "id": "cmt…",
  "platform": "linkedin",
  "label": "LinkedIn",
  "group": "social",
  "url": "https://linkedin.com/company/acme-ltd",
  "handle": "acme-ltd",
  "source": "manual",
  "sourceLabel": "Entered by operator",
  "state": "unverified",
  "reason": "LinkedIn refuses datacentre IPs (HTTP 999)",
  "statusCode": null,
  "verifiedAt": "2026-09-11T21:04:00.000Z"
}
```

**The footprint** returned by `GET /presence` aggregates what other modules
discovered — identity (`aeo-audit`), owned properties (`technical-audit`),
connected data (`google`, `seo-audit`), answer engines (`aeo-audit`) and
competitors (`intake`). Every item names its source module, and its `state` is
`found` · `none` · **`not-checked`** — the last meaning no module has looked yet,
which is not the same as having looked and found nothing.

### Business profile + reviews — DataForSEO Business Data (wave-6 D2)

`POST .../presence/business-profile` pulls the Google My Business profile
(name, categories, hours, rating, review count) plus a fresh Google /
Trustpilot / Yelp review-count snapshot, and stores all four as new rows —
never an upsert, since a business profile drifts over time and a re-pull
should not erase what the last one saw. Optional body:
`{ businessName?, locationName? }` (default business name: the project's
client name / name; default location: `PRESENCE_BUSINESS_LOCATION`, "United
States" if unset).

**Rating and review count only — no sentiment is invented.** DataForSEO's
Business Data reviews endpoints give no sentiment score over review text, and
this module does not synthesize one.

Requires `SWARM_ALLOW_LIVE=1` **and** `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`
(reusing `serp-intelligence`'s auth convention — same vendor, same env vars).
**Neither is set in this repository's `backend/.env`** — calling this endpoint
here returns:

```json
POST /api/projects/abc123/presence/business-profile
503 →
{ "statusCode": 503, "message": "DataForSEO Business Data is blocked — set SWARM_ALLOW_LIVE=1 to allow paid DataForSEO calls.", "error": "Service Unavailable" }
```

never an empty or fabricated profile in place of that error. `GET /presence`
reflects the same honesty: `businessProfile` stays `null` and `reviews` stays
`[]` until a pull actually succeeds, and `assessment.notMeasured` carries a
`not-configured` entry naming exactly which env vars are missing.

### Social activity — Apify (wave-6 D7)

`POST .../presence/social-activity` runs Apify actors against this project's
already-linked accounts (LinkedIn, Instagram, Facebook, X/Twitter by default;
YouTube and TikTok are supported but off unless requested) for posting
cadence, followers and engagement, normalising each actor's very different
raw output into one `PresencePost` shape before storage.

**This spends real Apify account credit** (the `FREE` plan's $5/month usage
cap), so it is opt-in in the strictest sense the API can express:

```json
POST /api/projects/abc123/presence/social-activity
{}                       → 400, "nothing was run and nothing was spent"
{ "confirmSpend": false } → 400, same
{ "confirmSpend": true }  → runs — spends real credit
```

`confirmSpend: true` is **required**, checked before the project is even
looked up, mirroring the existing `searchWeb` opt-in on `/discover` — a
default or automatic presence scan must never reach Apify. Optional body
fields: `platforms` (subset of `linkedin`/`instagram`/`facebook`/`twitter`/
`youtube`/`tiktok`) and `postsPerPlatform` (default `APIFY_POSTS_PER_PLATFORM`,
20). The response reports `pulled` rows, `skipped` platforms (e.g. no linked
account on file) and per-role `errors` — a failed platform never voids the rest
of the run.

Requires `APIFY_API_KEY`; absent, this returns a 503. `GET /presence`'s
`socialActivity[]` is derived purely from stored `PresencePost` rows and never
triggers a pull itself — reading the inventory never costs anything.

---

## Tech Stack — technology fingerprinting (added 2026-09-12)

Wave 6, step 3. Analysis + approved decision:
[`docs/analysis/wave-6-audit-pipeline.md`](analysis/wave-6-audit-pipeline.md) §D3.
Module docs: [`backend/src/modules/tech-stack/README.md`](../backend/src/modules/tech-stack/README.md).

| Method | Endpoint | Rate limit | Description |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/tech-stack/scan` | 10/60s | Scan a domain's homepage for known technology signatures. Body: optional `{ domain }`, defaults to the project's own. Runs synchronously — the result is the response, no job/poll |
| `GET` | `/api/projects/:projectId/tech-stack?domain=` | default | `{ scan }` — the latest stored scan for a domain (defaults to the project's own); `scan: null` if none has run yet |

Detection is a deterministic in-repo signature table (~90 entries) over one
fetch's headers, HTML, script `src` URLs and `<meta name="generator">` — no
vendor, no API key, no per-lookup cost. Categories: `analytics`, `ads`, `crm`,
`chat`, `cms`, `hosting`, `cdn`, `ecommerce`, `tag-manager`, `ab-testing`.

A blocked/unreachable domain is stored as `status: "failed"` with `error` set
— **HTTP 200**, never a 500. `domain` can be any domain, not just the
project's own, so wave-6's later `competitors` module can profile a rival by
calling the same service method.

```json
POST /api/projects/abc123/tech-stack/scan
{ "domain": "example-shop.com" }

201 →
{
  "id": "cmt…",
  "projectId": "abc123",
  "domain": "example-shop.com",
  "status": "completed",
  "error": null,
  "createdAt": "2026-09-12T07:00:00.000Z",
  "findings": [
    { "category": "ecommerce", "name": "Shopify", "confidence": 1, "evidence": ["cdn.shopify.com/..."] },
    { "category": "cdn", "name": "Cloudflare", "confidence": 1, "evidence": ["cloudflare"] }
  ]
}
```

---

## Competitors — light per-competitor profile + gap comparison (added 2026-09-12)

Wave 6, step 6. Analysis + approved decision:
[`docs/analysis/wave-6-audit-pipeline.md`](analysis/wave-6-audit-pipeline.md) §D4.
Module docs: [`backend/src/modules/competitors/README.md`](../backend/src/modules/competitors/README.md).

Promotes `Project.competitors` (JSON) into first-class `Competitor` rows and
builds a light profile for each: a homepage tech-stack scan (reusing the
Tech Stack module unchanged), a schema.org/JSON-LD read, and whatever
SERP/AEO presence already exists for that competitor, attached by reference.
Decision D4: "light now, structured to deepen later" — explicitly **not** a
full `technical-audit` per competitor, and this module never triggers a new
SERP or AEO run of its own.

| Method | Endpoint | Rate limit | Description |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/competitors/discover` | 5/60s | Merge `Project.competitors` (JSON) with an optional explicit body list `{ competitors?: [{name, domain?}] }`, upsert `Competitor` rows, and (re)build a profile for each. Runs synchronously |
| `GET` | `/api/projects/:projectId/competitors/profiles` | default | `{ competitors }` — every `Competitor` row with its latest profile. **Not** the bare `GET /api/projects/:id/competitors` path — that already belongs to `ProjectsController`'s named-competitor list (`{ tracked[], discovered[] }`, read by share-of-voice and the RivalsPanel frontend); this module lives one segment deeper to avoid shadowing it |
| `GET` | `/api/projects/:projectId/competitors/gap` | default | Client-vs-competitor diff on tech / schema / **external presence**, plus each competitor's attached AEO/SERP status. A plain comparison table, not a scored verdict |

**The `presence` diff** (added 2026-09-12) is the row a client acts on — *"three
of your four rivals are on Clutch and you are not"* is a decision; a tech-stack
diff is trivia. Each rival's own site is crawled by `digital-presence`'s
discovery service (**company** profiles only — a founder's personal LinkedIn is
not their company's footprint). The client side of the diff is read from stored
`digital-presence` rows, never a fresh crawl, so a client who has never had a
presence scan shows as having **none** rather than as having been checked.

Crawl only: DataForSEO and Apify bill per entity, and multiplying that by the
competitor count is not a cost this endpoint will incur on its own. Per-competitor
keyword research is likewise not wired — it needs the same DataForSEO credentials
and would bill per rival.

A competitor with no domain on record still gets AEO/SERP attachment (keyed
by name) but `status: "skipped"` on the crawl half — no domain, no homepage
to fetch. AEO/SERP attachment is honestly three-valued: `"present"` (data
found for this competitor), `"absent"` (a run exists for the project but
didn't name this competitor), `"unknown"` (no completed AEO audit / SERP
tracker exists yet for the project at all).

```json
POST /api/projects/abc123/competitors/discover
{}

201 →
{
  "projectId": "abc123",
  "totalCompetitors": 2,
  "promoted": 2,
  "competitors": [
    {
      "id": "cmt…",
      "name": "Acme Corp",
      "domain": "acme.com",
      "source": "project-json",
      "latestProfile": {
        "status": "completed",
        "techScanId": "cmt…",
        "schemaTypes": ["Organization"],
        "aeoStatus": "unknown",
        "aeoStanding": null,
        "serpStatus": "unknown",
        "serpPresence": null
      }
    }
  ]
}
```

```json
GET /api/projects/abc123/competitors/gap

200 →
{
  "domain": "client.com",
  "tech": {
    "clientOnly": [{ "key": "analytics:GA4", "competitors": [] }],
    "competitorsOnly": [{ "key": "cdn:Cloudflare", "competitors": ["Acme Corp"] }],
    "shared": []
  },
  "schema": { "clientOnly": [], "competitorsOnly": [], "shared": [] },
  "competitors": [{ "name": "Acme Corp", "aeoStatus": "unknown", "serpStatus": "unknown" }],
  "note": "Tech/schema are a presence diff, not a score. AEO/SERP rows reflect whatever those modules have already measured — this endpoint never triggers a new AEO or SERP run."
}
```

---

## Keyword Research — volume, competition/CPC, related & long-tail (added 2026-09-12)

Wave 6, step 4. Analysis + approved decision:
[`docs/analysis/wave-6-audit-pipeline.md`](analysis/wave-6-audit-pipeline.md) §D5.
Module docs: [`backend/src/modules/keyword-research/README.md`](../backend/src/modules/keyword-research/README.md).

| Method | Endpoint | Rate limit | Description |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/keyword-research` | 10/60s | Body: `{ keywords: string[], locationName?, languageCode?, includeRelated? }`. Pulls exact volume/competition/CPC for the seeds via DataForSEO Keywords Data and, by default, related/long-tail suggestions too (one extra call, capped at the first 20 seeds). Runs synchronously — the result is the response |
| `GET` | `/api/projects/:projectId/keyword-research?setId=&minVolume=` | default | `{ sets: KeywordSet[] }` — every research run for the project (or one via `setId`), each with its keywords; `minVolume` filters the keyword rows |

Same DataForSEO account already used by `serp-intelligence` — requires
`SWARM_ALLOW_LIVE=1` and `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`. Neither is
set in this repo's `backend/.env`, so a request correctly returns **503**
naming exactly what to configure, before writing anything.

**"Difficulty" is reported honestly.** DataForSEO's Keywords Data family
returns Google Ads *advertiser* competition (`competition`: LOW/MEDIUM/HIGH,
`competitionIndex`: 0-100) — a demand-pressure proxy, not an organic SEO
ranking-difficulty score. Fields are named `competition`/`competitionIndex`,
not "difficulty", so the report never implies a metric this vendor endpoint
doesn't provide.

A vendor-call failure past the credential gate is stored on the `KeywordSet`
as `status: "failed"` (seed call failed) or `"partial"` (only the optional
related-expansion call failed) with `error` set — **HTTP 201**, never a 500.

```json
POST /api/projects/abc123/keyword-research
{ "keywords": ["ai visibility platform", "answer engine optimization"] }

201 →
{
  "id": "cmt…", "projectId": "abc123",
  "seedInput": ["ai visibility platform", "answer engine optimization"],
  "locationName": null, "languageCode": null,
  "status": "completed", "error": null, "costUsd": 0.0042,
  "createdAt": "2026-09-12T08:00:00.000Z", "finishedAt": "2026-09-12T08:00:01.200Z",
  "keywords": [
    { "id": "…", "keyword": "ai visibility platform", "searchVolume": 320,
      "competition": "MEDIUM", "competitionIndex": 46, "cpc": 4.85,
      "lowTopOfPageBid": 2.1, "highTopOfPageBid": 7.4,
      "isRelated": false, "isLongTail": false, "createdAt": "…" },
    { "id": "…", "keyword": "best ai visibility tools for saas", "searchVolume": 40,
      "competition": "LOW", "competitionIndex": 12, "cpc": 3.10,
      "lowTopOfPageBid": 1.5, "highTopOfPageBid": 4.9,
      "isRelated": true, "isLongTail": true, "createdAt": "…" }
  ]
}
```

Not built here (see the module's `LEFT-OUT.md`): automatic seed derivation
from `SiteContext.services` (v1 takes explicit `keywords[]` input only), and
feeding the AEO matrix generator a demand weighting — an optional stretch
goal noted in the wave-6 plan, not attempted in this pass.

---

## Platform improvement phases — P01–P11 surfaces (added 2026-09-17)

> `platform_improvement_plan.md` added four backend modules and substantially
> extended five existing ones. Documented below are the phases whose modules
> have a written README today: `delivery-plan` (P01/P11), `business-profile`
> (P02/P04), `digital-presence` (P05), `competitors` (P06) and `opportunities`
> (P07). **`content-workspace` (P08/P09), `writing-style` and `website` (P12)
> exist under `backend/src/modules/` but their endpoints are deliberately not
> documented here yet** — those phases were still landing while this section
> was written, and a moving target documented once is wrong twice. Their
> module READMEs are deferred with them.

### Business Profile Module — business information + target locations (P02/P04)

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/business-profile/overview` | operator | `{ fields[], suppressedRejectedCount }` — `confirmed` / `suggestions` / `gaps` per field |
| `POST` | `/api/projects/:projectId/business-profile/candidates/reject` | admin, delivery-lead | Body `{ field, reason? }` — the "keep current" decision behind a suggestion |
| `GET` | `/api/projects/:projectId/business-profile/target-locations` | operator | `MarketTarget[]` + `suggestedCountries` + a `providerSupport` preview |
| `GET` | `/api/portal/projects/:projectId/business-profile/overview` | `@ClientPortal()` | the same overview, client-safe by construction |
| `GET` | `/api/portal/projects/:projectId/business-profile/target-locations` | `@ClientPortal()` | the same target locations |
| `POST` | `/api/portal/projects/:projectId/business-profile/candidates/reject` | `@ClientPortal()` | the client's own "keep current" |

**Three lists per field, never merged.** A confirmed value, a suggestion
extracted from the client's own site (with its source page and date) and a
field with no extraction source at all are three different facts, and the
response keeps them apart.

**A decline is remembered by value, not by field.** `BusinessProfileRejection`
is keyed `(projectId, fieldPath, valueHash)`, where the hash is a sha256 of a
canonical form of the suggested value — so declining one suggestion does not
suppress the next, different suggestion for the same field, and declining the
same value twice is idempotent. The value is read from the stored
`SiteContext`, never from the request body: a caller cannot inject a value in
order to decline it. `suppressedRejectedCount` reports how many suggestions
are being held back on each read, so a decline is visible rather than silent.

| Status | Refusal |
|---|---|
| 404 | `"<field>" has no suggested value to decline.` |
| 409 | `Project <id> has no extracted site context, so there is no suggestion for "<field>" to decline.` |
| 409 | `There is no current suggestion for "<field>" to decline.` |
| 409 | `"<field>" already matches the current confirmed/drafted value — there is nothing to decline.` |

**No target market means no silent US default (§10.2).** The measurement
market resolves in this order — an explicit `geo` on the run, then
`getConfirmedTargetCountries()`, then a site-derived provisional value (which
logs a warning, so a provisional market is never indistinguishable from a
confirmed one) — and then it **refuses**, naming the screen that fixes it:

```
409  Project <id> has no confirmed target market (Business information ->
     Target locations) and no site-derived service-area signal to fall back
     to. Confirm at least one target country before running this audit, or
     pass an explicit "geo" for a staff-approved provisional run (results
     will be marked provisional).
```

`GET …/target-locations` returns structured targets in `draft` or `confirmed`
state plus the countries still suggested; the per-provider support table marks
a city-level market a provider cannot serve rather than widening it to the
country and calling it the city. See `business-profile/README.md` §10.2 and
`target-markets.smoke.sh`.

### Digital Presence Module — applicability + "not ours" (P05)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/presence/applicability` | `{ status, reason, ruleVersion, overridden }` per platform (the same list `GET /presence` embeds) |
| `PATCH` | `/api/projects/:id/presence/applicability/:platform` | Body `{ status, reason }` — a versioned override: the prior one is superseded, never mutated |
| `POST` | `/api/projects/:id/presence/accounts/:accountId/reject` | "Not ours" — writes a `PresenceRejection` tombstone, then removes the candidate row |
| `GET` | `/api/projects/:id/presence/rejections` | Tombstones for the project, newest first, reconsidered ones included |
| `POST` | `/api/projects/:id/presence/rejections/:rejectionId/reconsider` | Undo — clears the tombstone's effect and keeps the row |
| `GET` | `/api/portal/projects/:id/presence` | `@ClientPortal()` — plain-English, client-safe projection |

**Applicability is what stops the module scoring a client for something that
does not apply to them.** `status` is `relevant | optional | not-relevant`.
Gaps count only `relevant` rows, coverage uses the same set, the Google sweep
searches `relevant` + `optional` + needs-confirmation, and a `not-relevant`
platform is never searched — hiding a platform's tab while still subtracting
points for its absence is the bug §11.2 exists to prevent. Overrides are
versioned (rule `applicability-v1`) and survive rediscovery, so a decision
made once is not re-litigated by the next crawl.

**Rejecting a candidate requires a reason, because the reason is what the
next reviewer reads:**

```
400  A reason is required to reject a candidate — it is shown on the
     tombstone and to future reviewers.
400  Only a search candidate can be rejected as "Not ours".
```

Tombstones match by normalized URL (scheme/host case, trailing slash, `www`,
tracking parameters), so the same account found again by a later sweep is
still "not ours". The portal projection replaces internal vocabulary with
plain-English labels and carries no confidence, run id, query text or spend.
Client-portal routes go through the global `@ClientPortal()` guard and
`ScopeValidationService.assertProjectAccess` — another client's project is a
**403 `This project does not belong to your client account`** (delivery-plan's
portal routes answer 404 instead; both disclose nothing, and the difference is
in the code, not an oversight in this table).

### Competitors Module — market discovery + frozen snapshots (P06)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects/:id/competitors/discover/market` | Body `{ collectNew?: boolean, provider?: 'dataforseo' \| 'fixture' }` — propose candidates from confirmed services + target markets |
| `GET` | `/api/projects/:id/competitors/comparison-snapshots` | Frozen comparisons, newest first, summaries only |
| `GET` | `/api/projects/:id/competitors/comparison-snapshots/:snapshotId` | The stored `GapResult` verbatim; 404 for an unknown or another project's snapshot |

**Two cost classes, and the free one is the default.** The default pass mines
the newest completed `AeoAudit.verdict` and up to 300 stored `SerpResult` rows
and reports `queriesRun: 0, costUsd: 0`. Only `collectNew: true` runs live
discovery searches — at most six `"<service> in <market>"` queries
(`MAX_SERVICES_CONSIDERED = 5`, `MAX_MARKETS_CONSIDERED = 3`,
`MAX_MARKET_QUERIES = 6`), through `serpForDiscovery()` and the SERP module's
existing gates.

Every candidate is a **proposal**: excluded from counts, unable to close a
gap, promoted only by an explicit `POST …/candidates/:competitorId/confirm`.
A rejected candidate is tombstoned first and removed second, so a later sweep
does not re-propose it.

**A comparison snapshot is immutable and carries its own provenance** —
`competitorSetVersion`, `extractionVersion`, the source observation ids and
the SERP sample size — so a comparison made in August can still be explained
in December. Nothing overwrites a snapshot; a new comparison appends a new
one.

### Opportunities Module (P07)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects/:projectId/opportunities/analyze` | Body `{ keywordSetId?, marginThreshold? }` (1–50, default 5) — compute gaps inside the already-captured corpus |
| `GET` | `/api/projects/:projectId/opportunities` | `?status= &origin= &search= &page= &pageSize=` (≤100), relevance-desc |
| `GET` | `/api/projects/:projectId/opportunities/:opportunityId` | one opportunity |
| `PATCH` | `/api/projects/:projectId/opportunities/:opportunityId/dismiss` | Body `{ reason }` **required**, min 3 chars |
| `PATCH` | `/api/projects/:projectId/opportunities/:opportunityId/reopen` | Body `{ reason }` **required**, min 3 chars |
| `POST` | `/api/projects/:projectId/opportunities/:opportunityId/convert` | Body `{ idempotencyKey (min 8), assetType? }` — create a content brief, idempotently |
| `POST` | `/api/projects/:projectId/opportunities/research-term` | passthrough of keyword research — the only route here that can reach a paid vendor call |

Every write route above is operator-only. As of the 2026-09-21 client-nav
restructure ("Digital Marketing → Ideation"), there is now one read-only
client-portal route:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/portal/projects/:projectId/opportunities` | `@ClientPortal()`, same `?status= &origin= &search= &page= &pageSize=` query as the operator list. `ScopeValidationService.assertProjectAccess` checks the project belongs to the caller's client; 403 otherwise. No analyze/dismiss/reopen/convert on the portal side. |

**Analysis is read-only.** `analyze` issues Prisma reads plus writes to
`Opportunity` itself. It never triggers a SERP, AEO or vendor call, and it
claims nothing beyond what the project has already captured — each row keeps
the exact query, location, language, device, checked depth and capture date
it came from.

**Three-valued position status, and no coerced zeros.** A rank not observed
within the checked depth is `not-observed`; a capture that *failed* is
`unknown` — its own row family (`serp-keyword-gap-unknown`), saying the
project's position is unknown and should be re-checked, never "not ranking".
Missing volume/CPC stays `null` (exposed as `unavailable`), never `0`.

**One row per idea, forever.** Dedup identity is `(projectId, topic, market,
language, intent, evidenceSourceFamily)` over a normalized topic (trimmed,
lowercased, whitespace collapsed — no stemming, no punctuation stripping).
Re-running `analyze` appends evidence to the same row and **cannot** write
`status`/`dismissedReason`/`dismissedAt`, so a dismissed idea stays dismissed
until someone explicitly reopens it with a new reason.

**Conversion is idempotent twice over:** a replayed `idempotencyKey` returns
the existing asset with `created: false`, and a *different* key against an
opportunity that already has a linked asset returns that same draft rather
than creating a duplicate. The source opportunity is never deleted — it is
marked converted and linked.

### Delivery Plan Module — commitments + the client-safe plan (P01/P11)

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/api/clients/:clientId/engagements` | operator | `{ engagements }` |
| `POST` | `/api/clients/:clientId/engagements` | admin, delivery-lead | create |
| `GET` | `/api/clients/:clientId/engagements/:id` | operator | one engagement (404 if another client's) |
| `PATCH` | `/api/clients/:clientId/engagements/:id` | admin, delivery-lead | update |
| `PATCH` | `/api/clients/:clientId/engagements/:id/status` | admin, delivery-lead | pause / resume; 409 on an illegal transition |
| `GET` | `/api/projects/:projectId/cycles` | operator | `{ cycles }` |
| `GET` | `/api/projects/:projectId/cycles/:id` | operator | one cycle |
| `GET` | `/api/projects/:projectId/cycles/:id/detail` | operator | cycle + work items, **including** `internalNotes` |
| `POST` | `/api/projects/:projectId/cycles` | admin, delivery-lead | create |
| `PATCH` | `/api/projects/:projectId/cycles/:id` | admin, delivery-lead | update (409 on a closed cycle) |
| `PATCH` | `/api/projects/:projectId/cycles/:id/status` | admin, delivery-lead | transition; 409 for `committed` — use `/commit` |
| `POST` | `/api/projects/:projectId/cycles/:id/commit` | admin, delivery-lead | commit the cycle and freeze the denominator |
| `GET` | `/api/projects/:projectId/phases` | operator | `{ phases }`, ordered by `order` then `createdAt` — Plan C3 |
| `GET` | `/api/projects/:projectId/phases/:id` | operator | one phase |
| `POST` | `/api/projects/:projectId/phases` | admin, delivery-lead | create (`order` defaults to end of list, `status` defaults `upcoming`) |
| `PATCH` | `/api/projects/:projectId/phases/:id` | admin, delivery-lead | edit name/order/status |
| `POST` | `/api/projects/:projectId/phases/:id/assign` | admin, delivery-lead | assign one existing `cycleId` **or** `commitmentId` to this phase; 409 if both or neither given |
| `POST` | `/api/projects/:projectId/phases/unassign` | admin, delivery-lead | clear one `cycleId`'s or `commitmentId`'s phase assignment |
| `GET` | `/api/projects/:projectId/commitments` | operator | `?cycleId= &status=` |
| `GET` | `/api/projects/:projectId/commitments/:id` | operator | one commitment with derived progress |
| `POST` | `/api/projects/:projectId/commitments` | admin, delivery-lead | create |
| `PATCH` | `/api/projects/:projectId/commitments/:id` | admin, delivery-lead | edit — 409 unless still editable (supersede instead) |
| `PATCH` | `/api/projects/:projectId/commitments/:id/status` | admin, delivery-lead | forward transition; 409 for `agreed` / `completed` |
| `POST` | `/api/projects/:projectId/commitments/:id/agree` | admin, delivery-lead | the one path to `agreed`; requires `confirm: true` |
| `POST` | `/api/projects/:projectId/commitments/:id/scope-change` | admin, delivery-lead | may move `agreed` → `needs-attention` |
| `POST` | `/api/projects/:projectId/commitments/:id/outcome-metric` | admin, delivery-lead | record an observed metric value |
| `POST` | `/api/projects/:projectId/commitments/:id/complete` | admin, delivery-lead | 409 without verified ≥ target (or an outcome metric) |
| `POST` | `/api/projects/:projectId/commitments/:id/cancel` | admin, delivery-lead | cancel |
| `GET` | `/api/projects/:projectId/actions` | operator | the caller's own needs-your-action queue |
| `GET` | `/api/projects/:projectId/work-items` | operator | `?status= &cycleId= &assigneeId=` |
| `GET` | `/api/projects/:projectId/work-items/:id` | operator | item + acceptance checks + verifications |
| `POST` | `/api/projects/:projectId/work-items` | admin, delivery-lead | create; 409 on a dependency cycle |
| `PATCH` | `/api/projects/:projectId/work-items/:id` | assignee | update; 403 for anyone else |
| `DELETE` | `/api/projects/:projectId/work-items/:id` | admin, delivery-lead | 409 once the cycle is committed |
| `POST` | `/api/projects/:projectId/work-items/:id/submit` | assignee | `active → review` |
| `POST` | `/api/projects/:projectId/work-items/:id/verify` | assignee | records a `Verification` — the only route to `verified` |
| `POST` | `/api/projects/:projectId/work-items/:id/block` | assignee | records the reason **and** who it waits on |
| `POST` | `/api/projects/:projectId/work-items/:id/unblock` | assignee | back to `active`, clears both fields |
| `POST` | `/api/projects/:projectId/work-items/:id/checks` | admin, delivery-lead | add an acceptance check |
| `PATCH` | `/api/projects/:projectId/work-items/:id/checks/:checkId` | assignee | update a check |
| `GET` | `/api/projects/:projectId/milestones` | operator | `{ milestones }`, client-visible or not |
| `POST` | `/api/projects/:projectId/milestones` | admin, delivery-lead | create (`clientVisible` defaults true) |
| `PATCH` | `/api/projects/:projectId/milestones/:id` | admin, delivery-lead | update; stamps `metAt` on `met` |
| `DELETE` | `/api/projects/:projectId/milestones/:id` | admin, delivery-lead | delete |
| `GET` | `/api/team/capacity` | operator | `?userId= &from= &to=` → allocations + available/allocated/remaining hours |
| `GET` | `/api/team/capacity/projects/:projectId` | operator | the same shape for one project (`?cycleId=`) |
| `POST` | `/api/team/capacity/projects/:projectId` | admin, delivery-lead | create an allocation |
| `POST` | `/api/team/capacity/org` | admin, delivery-lead | allocation with no project — leave, holiday, overhead |
| `PATCH` | `/api/team/capacity/:id` | admin, delivery-lead | update |
| `DELETE` | `/api/team/capacity/:id` | admin, delivery-lead | delete |

Client portal (`@ClientPortal()`; every path is under
`/api/portal/projects/:projectId`, `clientId` taken from the JWT, never the
request):

| Method | Path | Description |
|---|---|---|
| `GET` | `/plan` | `{ engagement, cycles, milestones, workItems }` — deliberately without a `commitments` key, so this shape never changes under a shipped client contract |
| `GET` | `/plan/commitments` | `{ commitments }` — everything not `draft`/`proposed`, completed ones included |
| `GET` | `/plan/phases` | `{ phases }` — Plan C3, each phase carrying its assigned `cycles`/`commitments` through the same `PortalCycleDto`/`PortalCommitmentDto` shapes as above; served separately so `/plan`'s shape never changes, same precedent as `/plan/commitments` |
| `GET` | `/work` | client-visible work items |
| `POST` | `/work/:workItemId/evidence` | append evidence as the client; returns the portal work DTO |
| `GET` | `/actions` | the client's own needs-your-action queue |
| `GET` | `/actions/overview` | the same, capped (`?limit=`, default 3) with the true `total` |

**Phase (Plan C3) is a display-only grouping, not a new gate.** `POST
.../phases/:id/assign` example request/response:

```json
// POST /api/projects/:projectId/phases/:phaseId/assign
{ "cycleId": "cm...cycle" }

// 200
{ "assigned": true }
```

```json
// GET /api/portal/projects/:projectId/plan/phases -> 200
{
  "phases": [
    {
      "id": "cm...phase",
      "name": "Diagnose",
      "order": 0,
      "status": "upcoming",
      "cycles": [ { "id": "cm...cycle", "name": "Cycle 1", "status": "planning", "committedCount": 0, "currentCount": 1, "deliveredCount": 0, "scopeChanges": [] } ],
      "commitments": [ { "id": "cm...commit", "title": "Fix top crawlability issues", "status": "agreed", "accountableLead": "Your Cailyx team" } ]
    }
  ]
}
```

**"Agreed" cannot be written by a status edit.** Two states are reachable
only through their dedicated actions:

```
409  Use POST .../commitments/:id/agree — "agreed" requires a recorded
     confirmation, not a status PATCH.
409  Use POST .../commitments/:id/complete — completion requires verified
     progress or an outcome metric.
409  Agreement requires confirm: true — an operator save alone is not
     client agreement.
409  This is an outcome commitment — completing it requires its own outcome
     metric (outcomeMetricCurrent), never just because linked tasks closed.
```

**Progress is derived at read time and never stored.** A countable commitment
counts linked work items in status `verified` — the same concept the cycle's
`deliveredCount` uses — and reports "3 of 10", never a percentage. An outcome
commitment reports its own recorded metric. Completing early takes `force`
**and** a `forceReason`, and the override is appended to the commitment's
scope history rather than being silent.

**The denominator is frozen; scope changes append.** Committing a cycle
snapshots `committedCount`; every later addition, removal or cancellation is
an append to `Cycle.scopeChanges` with a reason, and `committedCount` is never
rewritten — so "delivered 8 of 10 committed" stays true afterwards. Attaching
work to a committed cycle without a reason is a 409.

**Pausing an engagement never stops in-flight work** — only future committed
work (cycle commit and the transitions into `active`) is gated. **Due dates
resolve in the project's own timezone**: a bare `YYYY-MM-DD` becomes 23:59:59
local to the engagement's (else the project's) zone, and an unparseable date
is a 400 rather than a guess.

**Client responses are built by allowlists, not by filtering a staff row.**
No internal notes, hours, user ids, provenance or dependency ids reach the
portal; `blockedReason` is normalized to `client-action | approval |
dependency | other`; `[Submitted <ts> by <actorId>]` stamps are stripped at
the portal boundary only; the client sees the frozen `committedCount` next to
aggregate counts that include internal work. `portal-plan.smoke.sh` asserts
this with a recursive key allowlist.

**The needs-your-action queue has no table of its own** — every row is
derived live from an approval request, an onboarding request, a work item in
review or a blocked work item, and disappears when its source is resolved.
Audit findings are never client actions. Ordering is `overdue` → `blocking` →
`ordinary`, then soonest deadline.

**Web screens (§16.2 S02).** The project Overview shows at most three cards
(§5.1) and links "View all" to the full queue at `P/actions` — staff
`/projects/:projectId/actions`, client
`/client/projects/:projectId/actions`. Neither is a primary navigation item
(§3.2 keeps "Needs your action" in Overview rather than adding an overlapping
label); both render through the shared `ActionQueueList` component and offer a
link to the source record only — never a completion control, because opening an
item must not resolve it.

See `delivery-plan/README.md`, `backend/smoke/portal-plan.smoke.sh`,
`backend/smoke/thirty-day-plan.smoke.sh` and `backend/smoke/nav-rollout.smoke.sh`
(the last asserts that both "View all" links still land on the full queue).

---

## Client Portal & Admin Console — Stage 1 (C1: audit trail + onboarding-gate foundation, added 2026-09-20)

> Full decision record: `docs/analysis/client-portal.md` §§15/16/33. Build order:
> `docs/PLAN.md` §11.0 (cleanup) / §11.1 (Phase C1). See `backend/src/modules/clients/README.md`
> and `backend/src/modules/activity/README.md` for the full write-up — this section is
> the endpoint reference only.

### Clients Module — onboarding-wizard gate (new endpoints)

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/api/clients/:clientId/projects/:projectId/onboarding-wizard` | any operator | Read the onboarding-wizard gate state for one project |
| `POST` | `/api/clients/:clientId/projects/:projectId/onboarding-wizard/waive` | **admin only** | §15 — waive the Google-connect gate for this project |

**`GET .../onboarding-wizard`** — response `{ projectId: string, state: OnboardingWizardState }`,
where `OnboardingWizardState` is one of `not-started | confirming-details | connecting-gsc |
connecting-ga4 | done | waived`. 404 if the client doesn't exist or the project doesn't belong
to it.

Example:
```
GET /api/clients/cmua.../projects/cmua.../onboarding-wizard
→ 200 { "projectId": "cmua51yb6001hskw5y6u3s1am", "state": "not-started" }
```

**`POST .../onboarding-wizard/waive`** — body `{ reason?: string }` (free text, recorded on the
audit event). Sets the gate straight to `"waived"` — a real, visibly distinct terminal state,
never collapsed into a boolean "is onboarded" anywhere it's read — and writes an
`ActivityEvent` (`action: "waived"`, `resourceType: "project"`) recording the acting admin,
timestamp, and before/after state. Returns the updated `ClientProjectSummaryDto` (same shape as
`GET /api/clients/:clientId`'s per-project rows, now including `onboardingWizardState`). 403 if
the caller is not `admin`; 404 if the client/project pairing doesn't resolve.

Example:
```
POST /api/clients/cmua.../projects/cmua.../onboarding-wizard/waive
{ "reason": "Agency handoff pending, IT ticket open" }
→ 200 {
    "id": "cmua51yb6001hskw5y6u3s1am",
    "name": "C1 Verification Project",
    "domain": "c1-verify-example.com",
    "status": "diagnostic",
    "onboardingStatus": "running",
    "onboardingStep": "entity-audit",
    "onboardingError": null,
    "onboardingWizardState": "waived",
    "latestScore": null, "latestBand": null, "latestReportSlug": null,
    "openGapCount": 0,
    "createdAt": "2026-09-20T18:17:11.154Z"
  }
```

**Deprecated (kept, not removed):** `POST /api/clients/:clientId/login` (temp-password login) is
superseded by `POST /api/clients/:clientId/invites` (`client-access` module, invite-link flow)
as of this stage — see `docs/analysis/client-portal.md` §2 and `docs/PLAN.md` §11.0. The
endpoint still works (unchanged response shape); it is marked `@deprecated` in its JSDoc and no
longer treated as the default path. No request/response shape changed, so it is not re-documented
here — see the existing Clients module write-up above.

### Activity Module — new action value

`ActivityAction` / `ACTIVITY_ACTIONS` gained `'waived'` (previously: `created`, `updated`,
`deleted`, `released`, `approved`, `rejected`, `published`, `sent`, `started`, `cancelled`,
`granted`, `revoked`, `logged-in`). No endpoint shape changed — this only affects the `action`
value on rows written via the waive action above and the `action` filter/enum on the existing
`GET /api/activity` family of routes (unchanged endpoints, already documented in
`backend/src/modules/activity/README.md`).

---

## Client Portal & Admin Console — Phase C5 (lifecycle, billing grace period, seat permissions, added 2026-09-21)

> Full decision record: `docs/analysis/client-portal.md` §§5/23/27/30/32. Build order:
> `docs/PLAN.md` §11.5. See `backend/src/modules/clients/README.md`, `backend/src/modules/billing/README.md`
> and `backend/src/modules/approvals/README.md` for the full write-up — this section is the
> endpoint reference only.

### Clients Module — suspend / reactivate / ownership transfer (new endpoints)

| Method | Path | Roles | Description |
|---|---|---|---|
| `POST` | `/api/clients/:clientId/suspend` | **admin only** | §5/§23 — set status `suspended`, revoke every Google connection reachable through the client's projects, audit-logged |
| `POST` | `/api/clients/:clientId/reactivate` | **admin only** | §23 — set status back to `active`. Does NOT restore Google access |
| `POST` | `/api/clients/:clientId/transfer-ownership` | **admin only** | §32 — reassign the client's primary contact, from an existing seat (`memberId`) or raw `contactName`/`contactEmail` |

**`POST .../suspend`** — body `{ reason?: string }`. Response is the client plus which Google
connections were actually revoked:

```
POST /api/clients/cmua.../suspend
{ "reason": "non-payment, grace period elapsed" }
→ 200 {
    "id": "cmua...", "name": "...", "status": "suspended", ...,
    "googleConnectionsRevoked": ["cmua<projectId>:search-console"]
  }
```

Also called internally by the payment-failure grace-period sweep (see Billing below) with
`actor: {type: "scheduler", label: "billing-grace-period-sweep"}` — the resulting `ActivityEvent`
shows `actorType: "scheduler"` instead of `"user"` so the audit trail distinguishes an admin's
manual suspend from an automatic one. 403 if the caller is not `admin`; 404 if the client doesn't
exist.

**`POST .../reactivate`** — body `{ reason?: string }`. Returns the updated client (`status:
"active"`). Google access is **not** restored — each project's GSC/GA4 connection must be
reconnected from scratch, same as first onboarding (§23's accepted tradeoff).

**`POST .../transfer-ownership`** — body `{ memberId?: string, contactName?: string, contactEmail?: string, reason?: string }`.
Exactly one of `memberId` (an existing `ClientMember.id` for this client — that seat's user's
name/email become the new primary contact) or `contactName`/`contactEmail` must be supplied; a
call with neither returns `409`. Returns the updated client. 404 if `memberId` doesn't belong to
this client.

**`PATCH /api/clients/:clientId`** still accepts `status: "suspended"` for backward compatibility,
but does NOT revoke Google access or write the `"suspended"` audit action — use `POST .../suspend`
for a real suspension.

### Billing Module — payment-failure grace period (§30)

No new HTTP endpoints — `StripeWebhookService` now also reacts to `invoice.payment_failed` (already
handled before C5, extended to stamp `Subscription.pastDueSince` once per grace window) and
`customer.subscription.past_due` (an explicit literal event name the task named; Stripe's real
delivery for this transition is `customer.subscription.updated` with `status: "past_due"`, already
handled). `GET /api/billing/subscriptions` and `GET /api/portal/billing/subscriptions` now include
`pastDueSince: string | null` in `SubscriptionView`.

An in-process hourly cron (`PaymentFailureSweepService`, `@nestjs/schedule`, same pattern as
`PublicationSchedulerService`/`SeoAuditSchedulerService`) finds every subscription still `past-due`
whose `pastDueSince` is older than `BILLING_GRACE_PERIOD_DAYS` (default 21) and suspends its client
via the exact same `ClientsService.suspendClient` path an admin's manual suspend uses. `pastDueSince`
clears back to `null` the moment a subscription is seen `active` again (`invoice.paid`/
`invoice.payment_succeeded`, or a subscription-updated event reporting `active`/`trialing`) — this
does **not** auto-reactivate an already-suspended client, which stays a separate, explicit admin
action.

### Approvals Module — client-admin gate on decisions (§27)

`POST /api/portal/approvals/:id/decision` now requires the caller's client seat to be
`client-admin` — a `client-collaborator` seat gets `403 {"message":"Only a client-admin seat may
approve or request changes on content before it publishes"}`. `GET /api/portal/approvals` and
`GET /api/portal/approvals/:id` are unchanged (both roles keep view access). No other endpoint
shape changed.

---

## Client Portal & Admin Console — Phase C6 (governance, cost control & security, added 2026-09-21)

> Full decision record: `docs/analysis/client-portal.md` §§28/29/31. Build order:
> `docs/PLAN.md` §11.6. See `backend/src/modules/business-profile/README.md` (§29) and
> `backend/src/modules/reporting/README.md` (§31) for the full write-up — this section is the
> endpoint reference only.

### §29 — Competitor cap (business-profile)

No new endpoint. The existing client draft-save now enforces a per-plan-tier cap on the number of
competitors a client can directly add:

| Method | Path | Roles | Description |
|---|---|---|---|
| `PUT` | `/api/portal/projects/:projectId/business-profile` | `@ClientPortal()` | Save a draft. **New:** a save that would push the competitor count above the owning client's plan-tier cap returns `422`. |

Per-tier caps (proposed as part of this work — `client-portal.md` §29 left the numbers open;
retunable from `backend/src/modules/business-profile/lib/competitor-cap.util.ts`):
`starter` 5 · `growth` 15 · `scale` 50 · `enterprise` unlimited. A project not yet attached to a
client is treated as `starter`. The cap blocks **only a save that increases** the count — a client
already over the cap can still remove competitors or edit other fields.

The `422` body is machine-readable so the portal renders it as an upsell, not a validation error:

```
PUT /api/portal/projects/abc123/business-profile
{ "competitors": [ {"name":"A"}, {"name":"B"}, {"name":"C"}, {"name":"D"}, {"name":"E"}, {"name":"F"} ] }
→ 422 {
    "error": "competitor-cap-exceeded",
    "message": "The starter plan allows up to 5 tracked competitors. Remove one, or upgrade the plan to track more.",
    "planTier": "starter",
    "competitorCap": 5,
    "requestedCount": 6
  }
```

### §31 — Public report-link security (reporting)

The token share link (`ReportShareLink`, which already carried `expiresAt` + revocation) gains an
**optional password**. Expiry and revocation are unchanged.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/reports/:slug/share-links` | `admin`, `delivery-lead` | Mint a link. **New:** optional `password` (4–72 chars). |
| `GET` | `/api/reports/shared/:token` | public | Render the report — or, for a protected link with no valid unlock cookie, a password-prompt page. |
| `POST` | `/api/reports/shared/:token/unlock` | public | **New.** Submit the password; on success sets a short-lived HttpOnly unlock cookie and returns the report HTML. |
| `GET` | `/api/reports/shared/:token.pdf` | public | Render the PDF. **New:** `401` for a protected link not yet unlocked via the HTML link. |
| `GET` / `DELETE` | `/api/projects/:projectId/reports/:slug/share-links[/:linkId]` | `admin`, `delivery-lead` | List / revoke. Each link now reports `hasPassword: boolean` (the hash itself is never returned). |

**Create with a password:**

```
POST /api/projects/abc123/reports/q3-2026/share-links
{ "expiresInHours": 168, "password": "acme-2026" }
→ 201 {
    "id": "cmv...", "token": "<43-char base64url — shown once>",
    "url": "/api/reports/shared/<token>",
    "expiresAt": "2026-09-28T...Z", "hasPassword": true, "viewCount": 0, ...
  }
```

**Opening a protected link:** `GET /api/reports/shared/:token` returns the report HTML directly for
an unprotected link; for a protected one with no valid `cailyx_report_unlock` cookie it returns a
self-contained password-prompt page (200). The recipient's password is submitted only via
`POST .../unlock` (form body, never a URL). A wrong password re-serves the prompt at `401`. A
correct one sets the HttpOnly, `SameSite=Lax`, path-scoped (`/api/reports/shared`), 30-minute
unlock cookie (an HMAC-`JWT_SECRET`-signed grant bound to that one link id) and serves the report;
the same cookie lets the sibling `.pdf` download without re-prompting. Password stored only as a
bcrypt hash (cost 10) — never returned, never recoverable (revoke + re-mint to change it).

### §28 — Data-freshness ("as of [date]") labeling

Frontend-only (`web/`). No backend change: every score/metric/data panel in the client portal now
carries a visible "as of [date]" built from the timestamp its data already carries, via a shared
`AsOf` component (`web/src/components/patterns/AsOf.tsx`). No endpoint shape changed.

---

## Client Portal & Admin Console — Phase C2 (onboarding wizard, corrected order, added 2026-09-21)

> Full decision record: `docs/analysis/client-portal.md` §§2/11/12/17/18. Build order:
> `docs/PLAN.md` §11.2. See `backend/src/modules/client-portal/README.md`,
> `backend/src/modules/clients/README.md`, `backend/src/modules/client-access/README.md`
> and `backend/src/modules/business-profile/README.md` for the full write-up.
>
> **This corrects the report-vs-Google-connect ordering from two earlier attempts** at C2
> (one preserved, uncommitted, on branch `worktree-agent-aeb71c76ff99ed6d7`), which made
> GSC+GA4 connection a hard gate blocking the Day-1 report and the whole portal. The real,
> reviewed order (per `client-onbaording.excalidraw`): confirm details → the report and rest
> of the portal are already reachable → connect GSC → connect GA4 → done.
> `Project.onboardingWizardState`'s enum values (C1) are unchanged — only what each state
> blocks changed, in the web client's gate.

### Client Portal Module — onboarding-wizard endpoints (new)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/portal/projects/:projectId/onboarding-wizard` | Read the wizard gate state for this project |
| `POST` | `/api/portal/projects/:projectId/onboarding-wizard/confirm-details` | Step (a): advance past confirm/edit details |
| `POST` | `/api/portal/projects/:projectId/onboarding-wizard/connect-gsc-done` | Step (b): advance past connecting Google Search Console |
| `POST` | `/api/portal/projects/:projectId/onboarding-wizard/connect-ga4-done` | Step (c): advance past connecting Google Analytics 4 — terminal, into `done` |

All four are `@ClientPortal()` — client-type login only, scoped to the caller's own `clientId`
off the JWT; `projectId` ownership is re-checked on every call (`assertOwnsProject`). The state
machine is unchanged from C1: `not-started | confirming-details | connecting-gsc |
connecting-ga4 | done | waived`.

**`GET .../onboarding-wizard`**
```
GET /api/portal/projects/cmub.../onboarding-wizard
→ 200 { "projectId": "cmub769n4001jaxnhd91qkjut", "state": "not-started" }
```

**`POST .../onboarding-wizard/confirm-details`** — 409 unless a CONFIRMED business-profile
version already exists for the project (`POST .../business-profile/confirm`, reused as-is).
Advances to `"connecting-gsc"`. From this point on, the report and the rest of the portal are
reachable — this is the corrected part; nothing in the backend ever gated `/api/portal/reports`
on wizard state, and the web gate now matches that.
```
POST /api/portal/projects/cmub.../onboarding-wizard/confirm-details
→ 200 { "projectId": "cmub769n4001jaxnhd91qkjut", "state": "connecting-gsc" }
```

**`POST .../onboarding-wizard/connect-gsc-done`** / **`.../connect-ga4-done`** — 409 unless a
live, project-mapped `GoogleProjectResource` row for that service already exists (the same row
`connections/page.tsx`'s OAuth authorize/callback flow writes — no new OAuth mechanics here,
only the gating check). `connect-ga4-done` is the terminal transition, into `"done"`.
```
POST /api/portal/projects/cmub.../onboarding-wizard/connect-gsc-done   (no mapping yet)
→ 409 { "statusCode": 409, "error": "Conflict",
        "message": "Google Search Console is not connected yet for this project. Complete the OAuth connection (POST .../integrations/google/authorize, then map a resource) before continuing." }

POST /api/portal/projects/cmub.../onboarding-wizard/connect-gsc-done   (mapping exists)
→ 200 { "projectId": "cmub769n4001jaxnhd91qkjut", "state": "connecting-ga4" }
```

### Client Access Module — `createSystemInvite()` (service-only, no new HTTP endpoint)

`ClientAccessService.createSystemInvite(clientId, email, projectIds, createdBySystemLabel)` —
called directly by `clients`' Day-1-pipeline-completion hook, never over HTTP. Same
invite-link mechanics as `POST /api/clients/:clientId/invites`, with a system `createdBy`
label instead of an operator id, and `{ alreadyHasLogin: true }` instead of throwing when the
recipient already has a login.

### Clients Module — auto-email on Day-1 pipeline completion

No new endpoint. When the Day-1 pipeline (`POST /clients/:clientId/projects`'s background run,
either the legacy or the durable G07/A7 path) reaches its report stage — success OR
honest-partial failure — `ClientsService.sendPortalReadyEmail(projectId)` fires automatically:
creates an invite via `createSystemInvite()` above, then sends a Plunk email ("your Cailyx
portal is ready, click here to log in" — no PDF, no report attachment). Best-effort: a missing
contact email, an existing login, or an unconfigured `PLUNK_SECRET_KEY` are logged, never
surfaced as an API error.

### Business Profile Module — new `category` field

`GET/PUT /api/projects/:projectId/business-profile` and its portal equivalent
(`GET/PUT /api/portal/projects/:projectId/business-profile`) now read/write `category` (business
category/type, e.g. `"SaaS"`) alongside the existing `brandName`/`legalName`/`description`
fields — no new endpoint, the field was simply missing from the existing merge-patch/confirm
shapes. Also appears in `GET .../business-profile/overview`'s `about` section (confirmed /
suggested / gap), suggested from `SiteContext.category` (already extracted, previously unused
for this purpose).
```
PUT /api/projects/cmub.../business-profile
{ "category": "SaaS" }
→ 200 { "profile": { ..., "data": { ..., "category": "SaaS", ... } }, "warnings": [] }
```

---

## Refresh-Cadence — automatic measurement+scoring refresh (C7, added 2026-09-21)

> Full decision record: `docs/analysis/client-portal.md` §19, `docs/PLAN.md` §11.7. Full
> scoping write-up, cadence-per-tier table, and verification notes:
> `backend/src/modules/refresh-cadence/README.md` — this section is the endpoint reference only.

Cadence is derived automatically from `Client.planTier` (starter=weekly, growth/scale=daily,
enterprise=daily — see the module README for why enterprise is not literally real-time) and
kept in sync by an hourly internal poller. **There is no cadence-configuration endpoint** — an
operator never sets a project's refresh cadence; the two routes below are read-only status plus
an optional manual override.

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/refresh-cadence` | any operator with project access | Read-only cadence status: plan tier, derived cadence, active/next/last run, last error |
| `POST` | `/api/projects/:projectId/refresh-cadence/run-now` | any operator with project access | Runs the same scoped refresh (one measurement run + a scoring run) the scheduler would run on cadence, immediately — does not change the automatic schedule |

**`GET .../refresh-cadence`** — response:
```json
{
  "projectId": "cmub8nz89001g11aszalq4tcd",
  "clientId": "cmub8nuka001e11askomxmwki",
  "planTier": "growth",
  "cadence": "daily",
  "active": true,
  "nextRunAt": "2026-09-22T12:52:14.688Z",
  "lastRunAt": "2026-09-21T12:52:14.688Z",
  "lastError": null
}
```
`cadence: "manual-only"` and `active: false` until the project's Day-1 pipeline reaches
`onboardingStatus: "completed"` and its client has a recognized `planTier`.

**`POST .../refresh-cadence/run-now`** — no request body. Response:
```json
{
  "projectId": "cmub8nz89001g11aszalq4tcd",
  "ran": true,
  "measurementRunId": "cmub8vxdm0000j13l8btjq5j3",
  "scoreRunId": "cmub8vxel000cj13lw33y8bmm"
}
```
`ran: false` with a `skippedReason` when there is nothing yet to replay (no prior completed
measurement run, or no active query set) — this is a `200`, not an error, since it's a legitimate
"not ready yet" state for a brand-new project. A run that fails internally (e.g. the
`MEASUREMENT_MAX_COST_PER_RUN` cap trips) surfaces as a failed request rather than a quiet
success — see the module README's "Cost governor" section.

### `clients` module — `planTier` on the existing client DTOs (new field, not a new endpoint)

`Client` gained a `planTier` field (`starter | growth | scale | enterprise`, default `starter`),
settable via the already-documented `PATCH /api/clients/:clientId` and returned on every
existing client read/write response. No new route — see the `clients` module's existing API
reference above for the unchanged request/response shapes of `POST/GET/PATCH /api/clients...`.

---

## Client Portal — prompt visibility + request queues (C4: request queues, added 2026-09-21)

> Full decision record: `docs/analysis/client-portal.md` §§13/14/20/22. Build order:
> `docs/PLAN.md` §11.4 (Phase C4). See `backend/src/modules/prompt-requests/README.md` and
> `backend/src/modules/content-requests/README.md` for the full write-up — this section is
> the endpoint reference only.

### Prompt Requests Module

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/prompt-requests?status=` | admin, delivery-lead | Admin queue for a project |
| `POST` | `/api/projects/:projectId/prompt-requests/:id/decide` | admin | Record a decision — never mutates the QuerySet itself |
| `GET` | `/api/portal/projects/:projectId/prompts` | `@ClientPortal()` | Read-only active query-set prompts (§13) |
| `GET` | `/api/portal/projects/:projectId/prompt-requests` | `@ClientPortal()` | This client's own requests + status |
| `POST` | `/api/portal/projects/:projectId/prompt-requests` | `@ClientPortal()` | Propose an add, or flag an existing prompt for removal |

**`POST /api/portal/projects/:projectId/prompt-requests`** — body:
```
{ "action": "add", "prompt": "What CRM integrates with Slack for a small team?", "persona": "problem-aware" }
```
or
```
{ "action": "remove", "targetItemId": "<QuerySetItem.id>" }
```
Response (`201`) carries a §20 quota snapshot taken at request time:
```
{
  "id": "cmub8wapc001v138bcb0ipzbu",
  "action": "add",
  "prompt": "What CRM integrates with Slack for a small team?",
  "status": "pending",
  "activePromptCount": 2,
  "planPromptLimit": 100,
  "planTier": "starter",
  "overQuota": false,
  "decidedAt": null,
  "resultQuerySetItemId": null,
  "createdAt": "2026-09-21T12:52:31.921Z"
}
```
`overQuota: true` is never a rejection — the request is still created; it is a flag for the
admin reviewing the queue (§20's "upsell moment, not a bug"). See
`prompt-requests/README.md`'s "§20 quota enforcement" section for how `planTier` is derived —
no clean `planTier` field exists on `Client`/`Subscription` in this codebase, so it is resolved
from the client's most recent `Subscription.offerId` → `Offer.code`/`Offer.name`, defaulting to
`starter` when nothing resolves.

**`POST /api/projects/:projectId/prompt-requests/:id/decide`** — body:
```
{ "decision": "approved", "resultQuerySetItemId": "<QuerySetItem.id>", "decisionNote": "Added to v2, activated." }
```
This endpoint only records the decision. The actual prompt add/remove happens first, through the
existing `query-set` module's own endpoints (fork the active set → add/remove the prompt →
activate) — see `docs/API.md`'s Query Set section (unchanged by C4). `409` if the request was
already decided.

### Content Requests Module

| Method | Path | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/content-requests` | admin, delivery-lead, content | Traceability read — every row already has a real `growthAssetId` |
| `GET` | `/api/portal/projects/:projectId/content-requests` | `@ClientPortal()` | This client's own submitted requests |
| `POST` | `/api/portal/projects/:projectId/content-requests` | `@ClientPortal()` | Submit the structured "request new content" form |

**`POST /api/portal/projects/:projectId/content-requests`** — body:
```
{
  "contentType": "article",
  "topic": "best CRM for small sales teams",
  "priority": "high",
  "note": "Cover pricing and Slack integration"
}
```
`contentType` must be one of `content-workspace`'s own six tracked content types (`article`,
`ad-copy`, `social-content`, `email-campaign`, `landing-page`, `faq`) — `400` otherwise.
`priority` is `low | normal | high` (default `normal`).

Response (`201`):
```
{
  "id": "cmub8xs5a00189y04644xaghs",
  "contentType": "article",
  "topic": "best CRM for small sales teams",
  "priority": "high",
  "note": "Cover pricing and Slack integration",
  "growthAssetId": "cmub8xs5e00199y04x7i4zjb8",
  "createdAt": "2026-09-21T12:53:41.182Z"
}
```
Per §22, `growthAssetId` is set immediately — the request is already a real, client-tagged
`content-workspace` item (`source: "client-request"`) that an operator can pick up from the
ordinary content list. There is no separate triage step to convert it. It does **not** appear in
`GET /api/portal/projects/:projectId/content` (the client's own "shared with you" list) until an
operator explicitly shares a revision — the same rule that already governs every other content
piece.

### Query Set Module — unchanged

No endpoint shape changed. `QuerySetService.list(projectId, 'active')` is reused directly by
`GET /api/portal/projects/:projectId/prompts` above; see `query-set/README.md`.

### Growth Execution Module — new internal method, no new endpoint

`GrowthExecutionService.createFromClientRequest` (mirrors the existing
`createFromOpportunity`) is called by `content-requests`, not exposed as its own route.

---

## Planned Modules (not yet built)

| Module | Type | Endpoints |
|---|---|---|
| Frontend feature UIs (module by module) | Next.js App Router | consume the API above; react-pdf for the report PDF. The dashboard shell (nav, login, project list, Rung-0 scorecard workspace) is built and browser-verified |

---

## Error Response Format

All errors follow a consistent shape:

```json
{
  "statusCode": 400,
  "message": "targetUrl must be a valid URL",
  "error": "Bad Request"
}
```

Rate limit errors (429):
```json
{
  "statusCode": 429,
  "message": "Throttler limit: 3 per minute"
}
```
