# Entity Audit — Requirements

> **Module:** `entity-audit` (SOP-4)
> **Date:** 2026-08-29

## External Tools / APIs / Services

| Tool / Service | Purpose | Required for built features? | Status | Notes |
|---|---|---|---|---|
| **PostgreSQL 17** (`cailyx-postgres:5436`) | Persist `EntityAudit`, `Entity`, `SchemaCheck`, `PlatformRecord`, `ModelDiff` | Yes | ✅ Running | Docker Compose `cailyx-postgres` — `DATABASE_URL=postgresql://cailyx:cailyx_dev@localhost:5436/cailyx` |
| **Redis** (`cailyx-redis:6380`) | Fetcher cache + rate limiter for schema/sameAs fetches | Yes (transitive) | ✅ Running | Docker Compose `cailyx-redis` — `REDIS_URL=redis://localhost:6380` |
| **FetcherModule** (`fetchSchema` + `verifyUrl`) | JSON-LD extraction, sameAs resolve + title identity match, semi-auto platform single-fetch | Yes | ✅ Built | No extra env vars; respects `FETCHER_*` globals |
| **OpenAI / Anthropic / Perplexity / Google AI API** | Model-diff execution: send `What is [entity]?` to each model, store `rawAnswer` | No — deferred | ❌ Not provisioned | See LEFT-OUT.md §1. Must not hard-code model set until access + cost understood (SPEC §3.1) |
| **LLM-judge model + prompt** | Divergence scoring: structured field-level mismatches + `score 0..1` | No — deferred | ❌ Not designed | SPEC §3.1 exception to LLM-deferral; which model is the judge is open (SPEC §7 item 2) |
| **LinkedIn / G2 / Crunchbase official APIs or scraping** | Platform auto-scraping | No — deferred | ❌ Not wired | SPEC §3.3 flagged ToS risk; v1 is manual + `verifySource` single-fetch (low risk). Crunchbase paid API, LinkedIn/G2 largely unavailable |
| **Ollama local LLM** | Local model for dev (`llama3.2:1b` pulled) — potential free judge/model-diff host | No (optional) | ⚠️ Pulled, not wired | `http://localhost:11434` — `ollama list` has `llama3.2:1b` (1.3GB). Could back model-diff in dev without paid keys; not required for built features |

## Database Entities

- `EntityAudit` — per-project container
- `Entity` — `name`, `type` (`brand|product|founder|metric`), `descriptor`, `entityAuditId` FK
- `SchemaCheck` — `schemaType`, `fieldsPresent/Missing`, `sameAsUrls/Verification` (JSON), `status`
- `PlatformRecord` — `platform` (`linkedin|g2|crunchbase|other`), `recordedName/Descriptor`, `sourceUrl`, `consistencyStatus`
- `ModelDiff` — `provider`/`model`/`prompt`/`rawAnswer`/`citations`/`divergence`/`status`/`costUsd`/`latencyMs` (schema ready, rows empty until feature built)

## API Endpoints (built)

`POST/GET/PATCH/DELETE /entities`, `POST .../schema-check/run`, `GET .../schema-checks`, `POST/PATCH/DELETE .../platform-record(s)`, `GET .../platform-consistency`, `GET /` summary, `GET .../model-diffs`, `POST .../model-diff/run` (501 deferred).

## Decisions Still Open (SPEC §7)

1. Which model providers + expected API cost/volume for model-diff.
2. Which model is the LLM-judge + divergence prompt.
3. Platform consistency data source: manual vs semi-auto single-fetch (now the v1) vs paid API — ToS decision.

Gap-analysis (next module) consumes this module's persisted records for the `narrative` dimension mapping.
