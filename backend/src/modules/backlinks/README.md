# Backlinks Module

> **Status:** ✅ Built (2026-09-13)
> **Vendor:** DataForSEO Backlinks API — same account already used by
> `serp-intelligence` and `keyword-research`, no new vendor to approve.

## Purpose

Pulls a domain's backlink profile (referring domains, total backlinks, rank,
spam score, broken-link counts, TLD/type/platform/country distributions) plus
a small evidence sample of actual top backlinks, and surfaces the latest pull
in the client report (stage 12) and client portal.

## Architecture

```
backlinks/
├── backlinks.module.ts       # NestJS module — imports FetcherModule
├── backlinks.service.ts      # refresh, latest, list, resolveProvider (gate)
├── backlinks.controller.ts   # POST refresh, GET list/latest
├── backlinks.provider.ts     # DataForSeoBacklinksProvider — summary + backlinks list
├── backlinks.types.ts        # BacklinksSummaryDto, BacklinkSampleDto
├── dto/backlinks.dto.ts      # RefreshBacklinksDto
└── README.md
```

## How it works

1. `POST .../backlinks/refresh` gates on `SWARM_ALLOW_LIVE=1` +
   `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` — **before** writing anything.
   Missing either → `503`, no row created. Same convention
   `keyword-research`/`serp-intelligence` already use for this vendor account.
2. Calls `backlinks/summary/live` for the overall profile (one billed row:
   ~$0.024-0.03) — rank, backlink/referring-domain counts, spam score, and
   the TLD/type/attribute/platform/country distributions, straight off the
   vendor response.
3. Unless `sampleLimit: 0`, also calls `backlinks/backlinks/live` (default 10,
   capped at 100) sorted by rank descending — actual evidence (who links
   here, what anchor text, dofollow or not), not just an aggregate count.
   Bounded by `BACKLINKS_MAX_COST_PER_RUN` (default $1.00) between the two
   calls, same pattern as `keyword-research`'s own cost governor.
4. Persists one `BacklinksSummary` row per refresh (history kept, not
   overwritten). A vendor-call failure past the credential gate is stored as
   `status: "failed"` (summary call failed) or `"partial"` (only the sample
   call failed) with `error` set — never a thrown 500, never silent fake data.

## Built Features

| Feature | Status | Notes |
|---|---|---|
| Overall profile (rank, backlinks, referring domains/IPs/subnets, spam score) | ✅ | `backlinks/summary/live`, one billed row |
| Broken-backlink / broken-page counts | ✅ | Same summary call |
| TLD / link-type / attribute / platform / country distributions | ✅ | JSON, stored as-is |
| Top-backlink evidence sample | ✅ | `backlinks/backlinks/live`, ranked by authority, default 10 |
| Fail-closed on missing credentials | ✅ | `503` naming `SWARM_ALLOW_LIVE` / `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`, before any DB write |
| Partial-failure reporting | ✅ | Summary ok + sample fails → `status: "partial"`, summary still saved |
| Cost governor between the two calls | ✅ | `BACKLINKS_MAX_COST_PER_RUN`, default $1.00 |
| Real vendor cost tracking | ✅ | `BacklinksSummary.costUsd` = DataForSEO's own reported `cost`, summed across the 1-2 calls |
| Wired into the client report | ✅ | `reporting`'s `generateReport()` snapshots the latest pull (`Report.backlinksSnapshot`) — never triggers a fresh pull itself |
| Automatic target derivation from project domain | ✅ | `dto.target` optional — defaults to `Project.domain` |
| Historical trend (`timeseries_summary`, `new_lost_backlinks`) | ❌ Deferred | Only the current-snapshot endpoints are wired; the vendor's timeseries family is a separate future addition |
| Competitor backlink comparison (`backlinks/competitors`) | ❌ Deferred | Would pair naturally with the `competitors` module — not built yet |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/projects/:id/backlinks/refresh` | 10/60s | Body: `{ target?: string, sampleLimit?: number }`. Returns the created summary, whatever the outcome |
| `GET` | `/projects/:id/backlinks` | default | `{ summaries: BacklinksSummaryDto[] }` — full history, newest first |
| `GET` | `/projects/:id/backlinks/latest` | default | Most recent summary, or `null` |

## Dependencies

- `FetcherModule` — the vendor HTTP calls.
- DataForSEO account (`DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`) — same
  account already used by `serp-intelligence`/`keyword-research`.
- `SWARM_ALLOW_LIVE=1` — the same paid-call master switch those modules use.

## Consumers

`reporting.service.ts`'s `generateReport()` reads `backlinksService.latest(projectId)`
(pure read, never triggers a fresh pull) and snapshots it onto the report —
rendered in the HTML template's "Backlinks" section and returned as
`ReportData.backlinks` to both the operator API and the client portal
(`GET /portal/reports/:slug`).

## Pricing note (docs.dataforseo.com/v3/backlinks-overview, dataforseo.com/pricing/backlinks/backlinks)

$0.024/request + $0.000036/row. `summary/live` returns exactly one row
(~$0.024). `backlinks/live` at the default `sampleLimit: 10` adds
~$0.024 + 10×$0.000036 ≈ $0.0244. A default refresh costs roughly $0.05 total.

## Testing notes

Verified end-to-end against a live local backend with real DataForSEO
credentials: `POST refresh` against a real domain returned a completed
summary (real rank/backlink/referring-domain counts) and a 10-item top-backlinks
sample with real source URLs and anchor text; the report generated
immediately after included the same data in its "Backlinks" section, both via
the operator report endpoint and the client-portal endpoint. `npx tsc --noEmit`
clean.
