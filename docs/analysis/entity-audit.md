# Entity Audit — Tool & Technology Analysis

> **Module:** `entity-audit` (SOP-4 / PRD §6.3-6.4) · **Date:** 2026-08-29 · **Status:** Built (retrospective to satisfy AGENTS §3)

## What the module does

Detects entity inconsistency: **does the AI understand who you are?** Entity CRUD (`brand|product|founder|metric`, `name`+`descriptor`) scoped by `projectId` via `EntityAudit` container; schema checker (extract JSON-LD `Organization`/`Person`/`LocalBusiness`, handles `@graph`, string/array `sameAs`, validates `name/url/description/logo/sameAs`, verifies each `sameAs` `resolves`+`identityMatch` via `fetcher.verifyUrl` ≤10, cost-controlled); platform records (manual `linkedin|g2|crunchbase|other` + semi-auto `verifySource` single-fetch `fetcher.verifyUrl` → auto `match|mismatch` + `fetchedTitle`, low ToS risk — not crawling); consistency compare (normalized name, respects stored status); audit summary. Model-diff/LLM-judge deferred (SPEC §3.1).

## External tools — 2-3 options each

| Need | A | B | C | Pick |
|---|---|---|---|---|
| **JSON-LD extract** | `fetcher.fetchSchema()` (fetch + regex `<script type=application/ld+json>` + `parseSchemaBlock` handles `@graph`) + `cheerio` fallback | `jsonld` npm | `schema-dts` | **A:** already in `FetcherModule`, handles `@graph` flatten in `entity-audit.service.ts:340` + `extractSameAs`. No new dep. |
| **sameAs verify** | `fetcher.verifyUrl({url, expectedName})` → `{resolves, title, identityMatch}` (fetch + `extractTitle` substring) | `axios` direct | `open-graph` scrape | **A:** in `FetcherService`, cached `86400s`, title substring is weak signal — labelled “inferred” in docs. |
| **Platform semi-auto** | Single `verifyUrl` on `sourceUrl` (`verifySource:true`) → infer `match/mismatch` | Full crawling | Manual only | **A:** v1 = manual + single-fetch (SPEC §3.3 “build last”, chosen as low-risk semi-auto). Crunchbase paid API, LinkedIn/G2 largely n/a. |
| **Model-diff** | `fetcher.queryAssistant({provider,prompt})` adapters `openai|anthropic|perplexity|google` | Ollama local (`llama3.2:1b` pulled at `11434`) | headless chat UIs | **Deferred:** `ModelDiff` table exists (`provider/model/prompt/rawAnswer/citations/divergence/status/costUsd`), `GET .../model-diffs` live but `POST .../model-diff/run` is `501` until keys chosen per SPEC §3.1 (do not hard-code 5 models). Ollama is free dev option already pulled. |
| **LLM-judge divergence** | `openai`/`anthropic` judge prompt → `{score 0..1, fieldMismatches}` | local Ollama | rule-based diff | **Deferred:** SPEC §3.1 exception to LLM-deferral, judge model open (SPEC §7#2). |
| **Persistence** | Postgres via `PrismaService` (`EntityAudit`, `Entity` `→ SchemaCheck[]`/`PlatformRecord[]`/`ModelDiff[]`) | SQLite | memory | **A: Postgres** — `cailyx-postgres:5436`, ownership checks `entity.entityAudit.projectId` → `404` cross-project. |

**No new packages** — `axios`, `cheerio`, `@prisma/client` already. Model-diff will add `openai`, `@anthropic-ai/sdk` when keys provisioned (not now).

## Database entities

`EntityAudit(projectId)` 1—* `Entity(name, type, descriptor, entityAuditId FK cascade)` 1—* `SchemaCheck(entityId, schemaType, fieldsPresent/Missing Json, sameAsCount, sameAsUrls Json, sameAsVerification Json, status)` + `PlatformRecord(entityId, platform, recordedName/Descriptor, sourceUrl, consistencyStatus)` + `ModelDiff(entityId, provider, model, prompt, rawAnswer @db.Text, citations Json, divergence Json, status, costUsd, latencyMs)` (+ indexes).

## API endpoints

`POST/GET/PATCH/DELETE /entities` (owner-checked, `PATCH` partial, `DELETE` cascade), `POST /entities/:eid/schema-check/run` `5/60s` → `SchemaCheckResult` + DB `SchemaCheck`, `GET /entities/:eid/schema-checks?limit` history, `POST /entities/:eid/platform-record` (`verifySource` semi-auto), `PATCH/DELETE /entities/:eid/platform-records/:rid`, `GET /entities/:eid/platform-consistency`, `GET /` summary (`entities[ checks desc, records, diffs desc]`), `GET /entities/:eid/model-diffs`, `POST .../model-diff/run` `501` stub.

## Frontend

Entity list/cards + `+Entity` form (`name/type/descriptor`), schema-check runner (`url` + result badge), platform-record table (`verifySource` checkbox + `fetchedTitle` hint), summary page. Deferred — backend is the contract.

## Decisions open (SPEC §7)

1. Model-diff provider set + cost/volume. 2. Judge model. 3. Platform source (manual vs single-fetch now vs paid API) — answered as manual+single-fetch v1.
