# Entity Audit Module

> **Status:** ✅ Built (model-diff executed in Wave 3 — 503 without keys, live verdicts gated on API keys, see LEFT-OUT.md §1)
> **Phase:** 2 — Audits & Analysis (SOP-4)
> **Spec:** [SPEC.md](SPEC.md) (§3), [API.md](API.md), [LEFT-OUT.md](LEFT-OUT.md)

## Purpose

Detects inconsistency in how AI models and third-party platforms describe/name the client entity. Answers: **Does the AI understand who you are?**

If an AI assistant can't correctly identify a company, it won't recommend them. Entity ambiguity (e.g. Napkin vs napkin.ai) causes the AI to confuse the client with someone else — the module makes that visible and actionable.

## Architecture

```
entity-audit/
├── entity-audit.module.ts        # NestJS module — imports FetcherModule
├── entity-audit.service.ts       # Entity CRUD + schema check + platform records + model-diffs
├── entity-audit.controller.ts    # REST API (CRUD, schema-check, platform, summary, model-diff)
├── entity-audit.types.ts         # TypeScript interfaces (Entity, SchemaCheck, PlatformRecord, ModelDiff)
├── dto/
│   └── entity-audit.dto.ts       # Validated DTOs (class-validator + @ApiProperty)
├── README.md                     # This file
├── SPEC.md                       # Detailed module spec (copy of cailyx-audit-modules-spec.md §3)
├── API.md                        # REST endpoint reference
├── LEFT-OUT.md                   # Deferred items (model-diff execution, LLM-judge)
├── REQUIREMENTS.md               # External tools/APIs/infrastructure needed
└── SETUP-STATUS.md               # What is installed vs pending
```

## Built Features

| Feature | Status | Notes |
|---|---|---|
| **Entity CRUD** | ✅ | Create, list, get, update (PATCH), delete — all ownership-checked (projectId ↔ entityId, 404 on cross-project) |
| **Schema checker** | ✅ | Extract JSON-LD (handles `@graph`, string/array `sameAs`), validate `name/url/description/logo/sameAs`, verify each `sameAs` resolves + title identity match via `fetcher.verifyUrl()` (≤10, cost-controlled) |
| **Platform record entry** | ✅ | Manual entry (delivery lead pastes name/descriptor per platform) |
| **Semi-auto verify** | ✅ | `verifySource=true` with `sourceUrl` → single-page `fetcher.verifyUrl()` fetch, auto-infers `match/mismatch` from title, returns `fetchedTitle` (low ToS risk — one fetch, not crawling) |
| **Platform consistency checker** | ✅ | Compares recorded names (normalized) with entity name; respects stored `match/mismatch`, falls back to name compare; returns per-record status |
| **Schema-check history** | ✅ | `GET .../schema-checks?limit=` — newest first, capped 1..50 |
| **Platform record update/delete** | ✅ | `PATCH` / `DELETE .../platform-records/:recordId` with ownership checks |
| **Audit summary** | ✅ | Full project view with entities → schemaChecks (desc), platformRecords, modelDiffs (desc) |
| **Model-diff schema** | ✅ | `ModelDiff` table exists (provider/model/rawAnswer/citations/divergence/status/cost) + `GET .../model-diffs` list endpoint |
| **Model-diff execution** | ✅ Built (Wave 3) | Asks every keyed surface (Claude / Perplexity via measurement SurfaceAdapters) "What is {entity}?", stores per-provider rows, honest **503** without any keys |
| **LLM-judge divergence scoring** | ✅ Built (Wave 3) | Claude judge (≥2 answers) → `Aligned:` / `Divergent:` verdict stored on the anchor row; skipped with <2 answers, explicit `judge-unavailable`/`judge-failed` on API errors |
| **Platform auto-scraping** | ❌ Deferred | ToS risk (LinkedIn/Crunchbase); manual + single-fetch semi-auto is the v1 boundary |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/api/projects/:id/entity-audit/entities` | 100/60s | Add entity (name, type `brand|product|founder|metric`, descriptor) |
| `GET` | `/api/projects/:id/entity-audit/entities` | 100/60s | List all entities (with checks/records/diffs, ordered by `createdAt`) |
| `GET` | `/api/projects/:id/entity-audit/entities/:eid` | 100/60s | Get entity detail (ownership-checked) |
| `PATCH` | `/api/projects/:id/entity-audit/entities/:eid` | 100/60s | Update entity (partial) |
| `DELETE` | `/api/projects/:id/entity-audit/entities/:eid` | 100/60s | Delete entity (cascade) |
| `POST` | `/api/projects/:id/entity-audit/entities/:eid/schema-check/run` | 5/60s | Run schema check (JSON-LD + sameAs verification) |
| `GET` | `/api/projects/:id/entity-audit/entities/:eid/schema-checks?limit=` | 100/60s | Schema-check history (newest first) |
| `POST` | `/api/projects/:id/entity-audit/entities/:eid/platform-record` | 100/60s | Add platform record (`verifySource=true` enables semi-auto fetch) |
| `PATCH` | `/api/projects/:id/entity-audit/entities/:eid/platform-records/:rid` | 100/60s | Update platform record |
| `DELETE` | `/api/projects/:id/entity-audit/entities/:eid/platform-records/:rid` | 100/60s | Delete platform record |
| `GET` | `/api/projects/:id/entity-audit/entities/:eid/platform-consistency` | 100/60s | Check name consistency (computed + stored) |
| `GET` | `/api/projects/:id/entity-audit` | 100/60s | Full audit summary |
| `GET` | `/api/projects/:id/entity-audit/entities/:eid/model-diffs` | 100/60s | List model-diff history (newest first) |
| `POST` | `/api/projects/:id/entity-audit/entities/:eid/model-diff/run` | 5/60s | Run model-diff (Claude/Perplexity surfaces + Claude judge); **503** without keys |

## Dependencies

| Module / Service | Purpose |
|---|---|
| `FetcherModule` | `fetchSchema()` for JSON-LD extraction, `verifyUrl()` for sameAs + semi-auto platform verify |
| `DatabaseModule` | `PrismaService` — PostgreSQL via Prisma 5 |
| `ConfigModule` | Global — future thresholds (none required for entity-audit today) |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgresql://cailyx:cailyx_dev@localhost:5436/cailyx` | Postgres (Docker `cailyx-postgres:5436`) |
| `REDIS_URL` | Yes | `redis://localhost:6380` | Redis (Docker `cailyx-redis:6380`, used transitively via Fetcher cache/limiter) |
| `FETCHER_TIMEOUT_MS` | No | `30000` | HTTP timeout for schema/sameAs fetches |
| `FETCHER_RETRY_COUNT` | No | `3` | Retry count for fetcher |

No entity-audit-specific API keys are required for the built features. Model-diff uses `ANTHROPIC_API_KEY` and/or `PERPLEXITY_API_KEY` (shared with the measurement module) — **503** with honest messaging when none are set.

## Prisma Models

| Model | Purpose |
|---|---|
| `EntityAudit` | Container per project (`projectId`, `createdAt`) — 1 per project, holds entities |
| `Entity` | Tracked entity (`name`, `type`, `descriptor`, `entityAuditId` → cascade) |
| `SchemaCheck` | Schema check result (`schemaType`, `fieldsPresent/Missing`, `sameAsUrls/Verification`, `status`) |
| `PlatformRecord` | Platform row (`platform`, `recordedName/Descriptor`, `sourceUrl`, `consistencyStatus`) |
| `ModelDiff` | Model-diff run (`provider`, `model`, `prompt`, `rawAnswer`, `citations`, `divergence` JSON, `status`, `costUsd`, `latencyMs`) — one row per provider per run; anchor row holds the judged `divergence` |

## Consumers

- **Frontend:** `GET /entity-audit` summary drives the Entity Audit page; `POST .../schema-check/run` and platform-record forms are the primary write paths.
- **Gap-analysis (next module):** consumes `SchemaCheck` (missing fields, broken `sameAs`), `PlatformRecord` (mismatch), and future `ModelDiff` (divergence) to auto-classify gaps (dimension `narrative` per SPEC §4.4 mapping table).
- **Reporting:** will roll up entity consistency into the monthly report.

## PRD Alignment

| PRD Requirement | Status | Notes |
|---|---|---|
| FR-3.2 Structured-data audit: JSON-LD `Organization`/`Person`, `sameAs` | ✅ | Schema checker built — handles `@graph`, validates 5 recommended fields, caps sameAs verification at 10 |
| FR-3.2 `sameAs` verification (resolves + identity match) | ✅ | `fetcher.verifyUrl()` per sameAs URL — `resolves` (2xx/3xx) + `identityMatch` (title contains entity name) |
| SOP-4 Entity listing (brand/product/founder/metric) | ✅ | Full CRUD with ownership checks, ordered listing |
| SOP-4 Name/descriptor consistency across platforms | ✅ | Manual entry + semi-auto single-fetch verify + `platform-consistency` compare (normalized, respects stored status) |
| SOP-4 Model-diff (ask 5 models "what is X?" + LLM-judge) | ❌ Deferred | Schema + list endpoint ready; execution needs AI provider keys + judge prompt — explicitly flagged in SPEC §3.1/§6. No hard-coded model set. See LEFT-OUT.md |
| Platform auto-scraping (LinkedIn/G2/Crunchbase crawl) | ❌ Deferred | ToS risk acknowledged in SPEC §3.3/§7 item 3; v1 is manual + single-fetch semi-auto — not full scraping |
| Gap-analysis input contract | ✅ | Entity, SchemaCheck, PlatformRecord, ModelDiff all typed and persisted in shapes gap-analysis can ingest |

## Testing Notes

- **E2E (2026-08-29, verified):** `createEntity` → `listEntities` (1) → `getEntity` (0 checks) → `runSchemaCheck("https://example.com")` (`status:fail`, correct fix, DB persisted `SchemaCheck`) → `createPlatformRecord(linkedin)` → `checkPlatformConsistency` (`match`) → `getAuditSummary` (1 entity) → cleanup (delete records/checks/entity/audit). All 8 steps passed against live Postgres `cailyx:5436` + Redis `6380`.
- **Enhancement run (2026-08-29):** verified `PATCH` entity, `DELETE` entity cascade, `verifySource` semi-auto, `GET .../schema-checks` history, `GET .../model-diffs` (empty), cross-project 404 on `GET`/`PATCH`, `DELETE` platform-record.
- **Type check:** `npx tsc --noEmit` — 0 errors. **Build:** `npx nest build` — success.
- **Coverage gaps (intentional):** model-diff execution + LLM-judge divergence scoring — no live provider calls by design until API keys are provisioned; building them would require paid keys and a judge prompt decision per SPEC §7.

## Known Limitations

- `sameAs` `/@graph` flattening is best-effort — exotic JSON-LD (nested graphs, remote `@context`) may not fully flatten; the checker still reports `pass/fail` rather than erroring.
- Platform single-fetch uses `title` substring match for identity — a weak signal for ambiguous names; the result is `inferred` consistency, not a definitive platform-identity assertion.
