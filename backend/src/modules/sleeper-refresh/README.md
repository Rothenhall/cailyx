# Sleeper Refresh (SOP-10)

Declining-traffic + intact-backlinks pages → refresh candidates with an auditable
refresh SLA. Traffic evidence arrives via manual entry or a **pasted GSC CSV/TSV
export** — the GSC OAuth integration is an explicit external prerequisite
(docs/analysis/wave-4.md §3) and is honestly NOT wired.

## Files

```
sleeper-refresh/
├── sleeper-refresh.service.ts    # createPage, importPages (upsert), listPages, updatePage, markRefreshed, summary
├── sleeper-refresh.controller.ts # 7 routes under /projects/:id/sleeper-refresh
├── dto/sleeper-refresh.dto.ts
├── sleeper-refresh.module.ts
└── README.md
```

## Behavior

| Route | Notes |
|---|---|
| `POST /pages` | Manual candidate: url + optional `trafficDeclinePct` / `referringDomains` |
| `POST /import` | CSV/TSV text (`url[, declinePct[, referringDomains]]` per row; header row auto-skipped) or structured `pages[]`; upserts by URL; **@returns `{upserted, skipped}`** — nothing silently dropped; 400 when nothing parses; 500-row cap |
| `GET /pages` | Sorted by decline; each row gets `sleeperStatus` = `sleeper` (decline ≥20% AND refs ≥3 by default, both overridable via query) / `not-sleeper` / `unproven` (no evidence numbers on file) |
| `PATCH /pages/:id` | Evidence / label / notes / status (`flagged → brief-sent → in-progress → refreshed | abandoned`) |
| `POST /pages/:id/refreshed` | Records `dateModifiedAfter` — the SLA ("the refresh actually moved the page") is auditable against `dateModifiedBefore` |
| `GET /summary` | Counts by status + `dateModifiedMoved` (refreshes that verifiably changed dateModified) |

## e2e evidence (2026-08-30, :3111)

1. Manual page (38% decline, 12 refs) → `sleeper`; imported rows (31%/25%) classified correctly.
2. CSV import: `{upserted:2, skipped:2}` (header + not-a-url skipped and **counted**).
3. CSV bug found + fixed during e2e: the optional third column (referringDomains) was parsed but dropped — re-import saved `refs 7` onto the 31% row; dedupe by URL verified.
4. `markRefreshed` → `status:refreshed, dateModifiedAfter 2026-08-30`; `summary → {total:3, refreshed:1, dateModifiedMoved:1}`.
5. `status:"bogus"` → **400**.

Test rows wiped; server killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| SOP-10 sleeper pages | decline + referring-domain thresholds → `sleeperStatus` |
| SOP-10 candidate sort | list ordered by `trafficDeclinePct` desc |
| SOP-10 refresh shipping | status lifecycle + `dateModifiedBefore/After` audit |
| GSC pull | **left out** (OAuth prerequisite) — pasted export stands in; recorded in MODULES-STATUS |