# Entity Audit — Setup Status

> **Date:** 2026-08-29
> **Module:** `entity-audit`

## Installed / Verified

| Item | Status | Verified |
|---|---|---|
| `EntityAudit`, `Entity`, `SchemaCheck`, `PlatformRecord`, `ModelDiff` Prisma models | ✅ `prisma db push` + `generate` — `cailyx:5436` in sync | `npx prisma db push` 2026-08-29 |
| `EntityAuditModule` wired in `app.module.ts` | ✅ | `AppModule` imports `EntityAuditModule` |
| Fetcher `fetchSchema` + `verifyUrl` | ✅ | E2E `runSchemaCheck("https://example.com")` passed |
| Entity CRUD (create/list/get/update/delete) + ownership checks | ✅ | E2E `PATCH`/`DELETE` + cross-project 404 verified |
| Platform manual + semi-auto (`verifySource`) | ✅ | `POST .../platform-record` with `verifySource` returns `fetchedTitle` |
| Platform consistency compare | ✅ | `GET .../platform-consistency` returns `match/mismatch` |
| Schema-check history + model-diffs list | ✅ | `GET .../schema-checks` + `GET .../model-diffs` |
| Docker `cailyx-postgres:5436` + `cailyx-redis:6380` | ✅ Up | `docker ps` — both `Up` |
| `prisma.service.ts` (plain `PrismaClient`, no adapter) | ✅ | `npx tsc --noEmit` 0 errors |
| DTOs with `@ApiProperty` + `class-validator` | ✅ | `CreateEntityDto`, `UpdateEntityDto`, `Create/UpdatePlatformRecordDto`, `RunSchemaCheckDto` |
| Ollama `llama3.2:1b` (local, optional) | ✅ Pulled | `ollama list` — 1.3GB, `http://localhost:11434` |

## Pending / Deferred (intentional — see LEFT-OUT.md)

| Item | Status | Requires |
|---|---|---|
| Model-diff execution (`POST .../model-diff/run`) | ❌ 501 stub | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `PERPLEXITY_API_KEY` (decision on provider set + cost) |
| LLM-judge divergence scoring | ❌ | Judge model selection + prompt design (SPEC §7 item 2) |
| Platform auto-scraping (LinkedIn/G2/Crunchbase crawl) | ❌ | ToS decision (SPEC §7 item 3); v1 remains manual + single-fetch |
| Frontend Entity Audit page | ❌ | Next — consumes the built REST API (no feeder missing) |

## How to Verify

```bash
# from Cailyx root
docker compose up -d          # postgres:5436 + redis:6380 — already running
cd backend
npx prisma db push            # sync schema (no-op if already synced)
npm run start:dev             # http://localhost:3002 — Swagger at /api/docs
# Swagger: Entity Audit tag — try POST /projects/:id/entity-audit/entities
```

## Next Step

Gap-analysis — consumes Finding shapes from `technical-audit` + `entity-audit` (SchemaCheck/PlatformRecord/ModelDiff) for the 6-dimension auto-classification (SPEC §4).
