# SERP Intelligence Module (Swarm layer — Agent #3)

> **Status:** ✅ Built and e2e-verified (2026-08-30, fixture provider — 25/25 assertions). Live DataForSEO path ships gated.
> **Layer:** Swarm
> **Depends on:** `fetcher` (FetcherService), `database`, `config`
> **Vendor decision:** DataForSEO (`docs/analysis/serp-intelligence.md`)

## Purpose

Tracks Google **SERP rankings, competitors, SERP features, and AI-Overview
presence** for a set of queries over time. Per query per snapshot it records the
client's best organic rank, whether an AI Overview appeared (and whether it
mentioned the client), the featured-snippet owner, the first-page domains in
rank order, which of the project's competitors showed up, and how many distinct
sources the SERP drew on.

**Boundary:** data comes from a **licensed SERP data API (DataForSEO)** read
through `FetcherService`. This module never drives a browser against Google and
never generates queries, clicks, or impressions as a user.

## Providers

| Provider | Gate | Notes |
|---|---|---|
| `dataforseo` (default) | **`SWARM_ALLOW_LIVE=1` + `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`** → else 503 | `POST /v3/serp/google/organic/live/advanced`, Basic auth, `load_async_ai_overview: true`. Per-call cost read from the response and summed. |
| `fixture` | **`SERP_ALLOW_FIXTURE=1`** → else 400 | canned SERPs for a few AI-visibility keywords; deterministic; cost 0. Smoke-harness only. |

## Model

```
SerpTracker (name, locale, device, provider) 1─┬─* SerpQuery (keyword)
                                               └─* SerpSnapshot (one capture run)
                                                        └─* SerpResult (per query: subjectRank, aiOverview*, topDomains, competitorsSeen, sourceCount)
```

## Public API

`@Controller('projects/:projectId/serp-trackers')` — behind the global `JwtAuthGuard`.

| Method | Route | Notes |
|---|---|---|
| GET/POST | `/` | list / create `{ name, keywords[], locationName?, languageCode?, device?, provider? }` |
| GET | `/:trackerId` | detail (+ queries + recent snapshots) |
| POST | `/:trackerId/queries` | `{ keywords[] }` — dedupes, cap 300 |
| DELETE | `/:trackerId/queries/:queryId` | — |
| POST | `/:trackerId/capture` | `{ provider? }` → `{ snapshotId, status, queriesRun, costUsd, note }` |
| GET | `/:trackerId/snapshots` · `/snapshots/:snapshotId` | list / detail (+ results) |
| DELETE | `/:trackerId` | — |

## Guards

| Guard | Effect |
|---|---|
| live provider without `SWARM_ALLOW_LIVE=1` + creds | **503** (shared master switch with `journey`) |
| `fixture` provider without `SERP_ALLOW_FIXTURE=1` | **400** |
| `SERP_MAX_COST_PER_CAPTURE` (default 5.00) | capture stops mid-run → snapshot `partial`, reason in `note` |
| keyword count 1–300, length ≤ 200 (DTO) | — |

## Environment

```
#DATAFORSEO_LOGIN=      #DATAFORSEO_PASSWORD=     # live capture (with SWARM_ALLOW_LIVE=1)
SERP_MAX_COST_PER_CAPTURE=5.00
#SERP_ALLOW_FIXTURE=1                              # offline smoke harness
```

## Design alignment

| Item | Status |
|---|---|
| Agent #3 "SERP Intelligence — rankings, competitors, features, sources" | ✅ + AI-Overview presence/mention |
| Boundary: licensed data feed, not scraping / not user-simulated | ✅ DataForSEO via FetcherService; no browser path |
| Historical visibility measurement | ✅ snapshots over time per tracker |

## Testing

`bash smoke/serp-intelligence.smoke.sh` (backend up, `SERP_ALLOW_FIXTURE=1`, no vendor account) — **25/25 pass** (2026-08-30):

- tracker CRUD: create with 3 keywords, add dedupes existing, remove one
- capture (fixture): snapshot `complete`, 3 queries run, cost 0, 3 results persisted
- metrics vs the canned SERPs: subject organic rank **5** and **9** on two keywords, **null** where the subject is absent; AI-Overview presence detected; both competitors detected; `topDomains` in rank order `[2,3,5,6]`; distinct source count; featured-snippet domain captured; AI Overview does not "mention" an absent subject
- guards: `dataforseo` provider with `SWARM_ALLOW_LIVE=0` → **503**; empty keywords → **400**
- re-capture is deterministic

**Not exercised without a vendor account:** the DataForSEO response parsing against a real payload and live per-query cost. Both run on the first keyed capture.
