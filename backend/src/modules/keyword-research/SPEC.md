# Spec — Keyword Research Module

> **Wave:** 6, step 4 (`docs/analysis/wave-6-audit-pipeline.md` §D5/§4)
> **Stage:** 10 of the 12-stage delivery flow, pulled forward on the operator's instruction

## What it does

Given a list of seed keywords, returns:

1. **Exact volume/competition/CPC** for each seed, from DataForSEO's
   `search_volume/live` endpoint.
2. **Related/long-tail suggestions** for those seeds (on by default), from
   `keywords_for_keywords/live`, tagged `isRelated: true` and further flagged
   `isLongTail: true` when the phrase is 4+ words.

Both calls are billed by DataForSEO per request regardless of keyword count,
so one research run is normally 1-2 vendor charges, not one per keyword.

## Why DataForSEO Keywords Data (not a competitor)

Decision D5: same vendor already integrated for `serp-intelligence`
(`DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`, `SWARM_ALLOW_LIVE` master switch).
No new account, no new integration to approve — this module is an additional
adapter on infrastructure that already exists and is already trusted.

## Honest limits, stated up front

- **"Difficulty" here is Google Ads advertiser competition, not organic SEO
  ranking difficulty.** DataForSEO's Keywords Data family reports
  `competition` (LOW/MEDIUM/HIGH) and `competition_index` (0-100) — how hard
  it is to win the *ad* auction for a keyword, correlated with but not equal
  to how hard it is to *rank organically* for it. The wave-6 doc's own
  language ("difficulty/competition") anticipated this ambiguity; this module
  reports the field DataForSEO actually returns, named for what it is
  (`competition`/`competitionIndex`), rather than relabelling it "SEO
  difficulty" and implying a metric (like Moz DA or Ahrefs KD) that this
  vendor endpoint does not provide.
- **Related-keyword expansion is capped at the first 20 seeds** per research
  run — a DataForSEO limit on `keywords_for_keywords/live`, not a choice made
  here. A request with more than 20 keywords still gets exact volumes for
  *all* of them; only the expansion call is capped.
- **`isLongTail` is a local heuristic** (4+ words), not a vendor field —
  DataForSEO does not classify keywords as long-tail.

## Data model

- `KeywordSet` — one research run. `seedInput` preserves the operator's raw
  submission (JSON string[]) before normalization; `status` is
  `pending → completed | partial | failed`. `partial` means the seed-volume
  call succeeded but the (optional) related-expansion call failed — the run
  still has useful data, so it is not reported as a hard failure.
- `Keyword` — one row per keyword (seed or related) within a set, uniqued on
  `(setId, keyword)` so a related suggestion that matches a seed never
  duplicates it (the seed row wins; see `research()`'s `seen` set).

No FK to `Project` (matches `TechStackScan`'s convention) — `projectId` is a
plain indexed column, keeping this module decoupled from the `Project` model
so it never needs a migration coordinated with other modules' schema changes.

## Request/response shape

```
POST /projects/:projectId/keyword-research
{ "keywords": ["ai visibility platform", "answer engine optimization"] }

201 →
{
  "id": "...", "projectId": "...", "seedInput": ["ai visibility platform", "answer engine optimization"],
  "locationName": null, "languageCode": null,
  "status": "completed", "error": null, "costUsd": 0.0042,
  "createdAt": "...", "finishedAt": "...",
  "keywords": [
    { "id": "...", "keyword": "ai visibility platform", "searchVolume": 320, "competition": "MEDIUM",
      "competitionIndex": 46, "cpc": 4.85, "lowTopOfPageBid": 2.1, "highTopOfPageBid": 7.4,
      "isRelated": false, "isLongTail": false, "createdAt": "..." },
    { "id": "...", "keyword": "best ai visibility tools for saas", "searchVolume": 40, "competition": "LOW",
      "competitionIndex": 12, "cpc": 3.10, "lowTopOfPageBid": 1.5, "highTopOfPageBid": 4.9,
      "isRelated": true, "isLongTail": true, "createdAt": "..." }
  ]
}
```

```
GET /projects/:projectId/keyword-research?minVolume=100

200 → { "sets": [ { ...KeywordSet, "keywords": [ /* filtered to searchVolume >= 100 */ ] } ] }
```

## Failure paths

| Condition | Response |
|---|---|
| `SWARM_ALLOW_LIVE` not `1` | `503` — no row written |
| `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` missing | `503` — no row written |
| Unknown project | `404` |
| Empty/whitespace-only keyword list | `400` |
| `search_volume` call fails after credentials pass gate | `KeywordSet.status = "failed"`, `error` set, `201` returned (not a 500 — a reachable-but-failing vendor call is a reportable outcome) |
| `search_volume` succeeds, `keywords_for_keywords` fails | `KeywordSet.status = "partial"`, seed rows saved, `error` explains the expansion failure |
