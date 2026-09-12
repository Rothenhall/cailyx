# Keyword Research Module

> **Status:** ✅ Built
> **Wave:** 6, step 4 (`docs/analysis/wave-6-audit-pipeline.md` §D5/§4)
> **Spec:** [SPEC.md](SPEC.md), [LEFT-OUT.md](LEFT-OUT.md)

## Purpose

Given a list of seed keywords, returns search volume, competition/CPC, and
(optionally) related/long-tail keyword suggestions — via DataForSEO Keywords
Data. Pulled forward from stage 10 of the 12-stage delivery flow on the
operator's instruction (decision D5): real demand data instead of guessing at
which topics matter.

## Architecture

```
keyword-research/
├── keyword-research.module.ts       # NestJS module — imports FetcherModule
├── keyword-research.service.ts      # ensureProject, research, list, resolveProvider (gate)
├── keyword-research.controller.ts   # POST (research), GET (list/filter)
├── keyword-research.provider.ts     # DataForSeoKeywordsProvider — search_volume + keywords_for_keywords
├── dto/keyword-research.dto.ts      # RunKeywordResearchDto, ListKeywordSetsQueryDto
├── README.md                        # This file
├── SPEC.md                          # Detailed spec, incl. the competition-vs-difficulty caveat
├── REQUIREMENTS.md                  # External tools/APIs/env vars
├── SETUP-STATUS.md                  # What is installed, what is pending
└── LEFT-OUT.md                      # Deferred scope
```

## How it works

1. `POST` normalizes the submitted keywords (trim/lowercase/dedupe, 200 max)
   and gates on `SWARM_ALLOW_LIVE=1` + `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`
   — **before** writing anything. Missing either → `503`, no row created.
2. Once gated, creates one `KeywordSet` row, then calls DataForSEO's
   `search_volume/live` for the seeds.
3. Unless `includeRelated: false`, also calls `keywords_for_keywords/live`
   (capped at the first 20 seeds — a vendor limit on that endpoint) for
   related/long-tail suggestions, tagged `isRelated: true` and further
   `isLongTail: true` at 4+ words.
4. Persists every keyword as a `Keyword` row under the set and returns the
   full set. A vendor-call failure past the credential gate is stored as
   `status: "failed"` (seed call failed) or `"partial"` (only the related
   expansion failed) with `error` set — never a thrown 500, and never silent
   fake data.

## Built Features

| Feature | Status | Notes |
|---|---|---|
| Seed volume/competition/CPC | ✅ | `search_volume/live`, up to 200 keywords/request |
| Related/long-tail expansion | ✅ | `keywords_for_keywords/live`, default on, capped at 20 seeds/request (vendor limit) |
| Fail-closed on missing credentials | ✅ | `503` naming `SWARM_ALLOW_LIVE` / `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`, before any DB write |
| Partial-failure reporting | ✅ | Seed call ok + expansion call fails → `status: "partial"`, seed data still saved |
| List/filter | ✅ | `GET ?setId=` for one set, `?minVolume=` to filter keyword rows either way |
| Real vendor cost tracking | ✅ | `KeywordSet.costUsd` = DataForSEO's own reported `cost`, summed across the 1-2 calls |
| Automatic seed derivation from site context | ❌ Deferred | See LEFT-OUT.md — v1 is explicit `keywords[]` input only |
| AEO matrix demand weighting | ✅ Built | `aeo-matrix.service.ts`'s `demandIndex()` reads this module's own `KeywordSet`/`Keyword` rows directly via Prisma and reorders `generateMatrix()`'s services by volume — see below |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/projects/:id/keyword-research` | 10/60s | Body: `{ keywords: string[], locationName?, languageCode?, includeRelated? }`. Returns the created `KeywordSet` (incl. its keywords), whatever the outcome |
| `GET` | `/projects/:id/keyword-research?setId=&minVolume=` | default | `{ sets: KeywordSet[] }` — all sets, or one via `setId`; `minVolume` filters keyword rows |

## Dependencies

- `FetcherModule` — the vendor HTTP calls.
- DataForSEO account (`DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`) — **same
  account already used by `serp-intelligence`**, no new vendor to approve.
- `SWARM_ALLOW_LIVE=1` — the same paid-call master switch `serp-intelligence`
  uses.

Not set in this repo's `backend/.env` today, so live calls correctly fail
closed with a `503` — see SETUP-STATUS.md.

## Consumers

`aeo-audit/aeo-matrix.service.ts`'s `demandIndex(projectId)` reads this
project's latest `completed`/`partial` `KeywordSet` (plus its `Keyword` rows)
directly via Prisma — this module has no service-level API for it, and
doesn't need one, since Prisma is the shared contract. `generateMatrix()`
orders services by matched search volume when a demand index is available and
degrades to unordered when it isn't (no keyword research run yet), never
inventing or dropping a service based on volume. This was built as part of
the `aeo-audit` module rather than here — see LEFT-OUT.md §2 for why the
history reads like this was deferred; it was picked back up later.

## PRD / wave-6 alignment

| Requirement | Status | Notes |
|---|---|---|
| D5 — DataForSEO Keywords Data: volume, difficulty/competition, CPC | ✅ | `search_volume/live`; "difficulty" reported honestly as advertiser `competition`/`competitionIndex`, see SPEC.md |
| D5 — related and long-tail keywords | ✅ | `keywords_for_keywords/live`, default on, `isRelated`/`isLongTail` flags |
| §6 API surface — research + list endpoints | ✅ | `POST`/`GET /projects/:id/keyword-research`, filterable by `setId`/`minVolume` |
| §4 step 4 — "feeds the AEO matrix generator an optional demand weighting" | ✅ Built | Implemented in `aeo-audit/aeo-matrix.service.ts` + `aeo-matrix.generator.ts`, reading this module's tables directly |
| Fail closed without vendor credentials | ✅ | `503`, no row written, verified by smoke test |

## Testing notes

- `npx tsc --noEmit` — clean, no `any`.
- `backend/smoke/keyword-research.smoke.sh` — run against a live local
  backend (throwaway project, cleaned up on exit): **8/8 passed**. Since
  `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`/`SWARM_ALLOW_LIVE` are not set in
  this environment, the smoke test asserts the honest fail-closed path (a
  `503` naming exactly what to configure, and confirms no `KeywordSet` row
  is written on that path) rather than a real paid vendor call — the same
  discipline `serp-intelligence.smoke.sh` follows for its own missing
  credentials. Also covers: empty list, empty keyword-array validation,
  unknown-project 404.
