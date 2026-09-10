# SEO Audit Module

The technical audit's sibling, sourced from **Google Search Console**. Search
Console shows the data; this shows the data **and what to do about it** — every
issue and opportunity carries a fix, and where Cailyx can act (re-submit the
sitemap) or hand over a paste-ready block (canonical tag, BreadcrumbList
JSON-LD) it does.

Depends on `GoogleModule` — the per-operator Search Console OAuth connection
and its project→property mapping (`GoogleProjectResource`).

## What a run does (`SeoAuditService.run`)

1. Resolve the project's mapped GSC property.
2. Pull Search Analytics for the current window and the one before it:
   totals, query+page rows, page rows, a daily timeseries.
3. Collapse `http:// / https:// / www` variants of the same URL by a
   normalised key (`seo-rubric.normUrl`) — GSC lists them separately and a
   redirect artifact must not be inspected or flagged.
4. URL-Inspect the top `SEO_INSPECT_BUDGET` (default 40) URLs by impressions,
   concurrency 4.
5. `seo-rubric` classifies everything:
   - **per query**: `striking-distance` (pos 5–20, ≥10 impr), `ctr-gap` (CTR
     under half the positional-curve expectation, ≥50 impr), `ranking-drop` /
     `ranking-gain` (±3 positions vs last run), `cannibalization` (≥2 distinct
     normalised pages, ≥15 impr). Search-operator queries (`site:`, `-site:`,
     `intitle:` …) are excluded.
   - **per page** from URL Inspection: `not-indexed-crawled` /
     `not-indexed-discovered`, `noindex`, `blocked-robots`, `canonical-host`
     (www vs non-www preference — one low-severity finding), `canonical-mismatch`
     (a real path/domain difference), `redirect`, `soft-404`, server/4xx crawl
     errors, `breadcrumb-issue` / `rich-result-issue`.
6. `buildFindings` groups per-page issues by code into one actionable row each,
   adds the query-opportunity rollups and sitemap-error findings, sorts by
   severity.
7. `scoreAudit` → 0–100 (issue-free-ness, not ranking performance).
8. Persist `SeoAudit` + `SeoQuery[]` + `SeoPage[]` + `SeoFinding[]`, compute
   run-over-run `deltas`, write observability.

## API (all behind the global `JwtAuthGuard`)

| route | |
|---|---|
| `POST /projects/:id/seo-audit/run` `{windowDays?}` | run now |
| `GET  /projects/:id/seo-audit` | list runs (summary rows) |
| `GET  /projects/:id/seo-audit/:auditId` | one run: queries + pages + findings |
| `GET  /projects/:id/seo-audit/:auditId/comparison` | run-over-run deltas |
| `GET  /projects/:id/seo-audit/trend/history` | score / clicks / impressions series |
| `POST /projects/:id/seo-audit/submit-sitemaps` | **the one live action** — re-submit the property's sitemap(s) to Google |
| `GET  /projects/:id/seo-audit/schedule` · `PUT …/schedule` `{cadence}` | recurring cadence (daily/weekly/monthly/manual-only) |

## Recurring

`SeoAuditSchedulerService` — in-process `@Cron(EVERY_HOUR)`, polls the `seo*`
columns of `ScheduleConfig`, runs any due audit as the operator whose Search
Console connection is mapped to the project. Stood down when
`SCHEDULING_BACKEND=bullmq`. No notifications — a finished run lands in the DB
and shows next time the workspace is opened.

## Config

| env | default | |
|---|---|---|
| `SEO_INSPECT_BUDGET` | `40` | URL Inspection calls per run (GSC quota 2000/day, 600/min) |

## Verified

Run end-to-end against `rothenhall.com`'s live Search Console (2026-09-10):
18 URLs inspected, ~40s, deltas + comparison chain correct. Three classes of
false positive found and fixed in the process — all rooted in domain-property
host/protocol variants (see the `fix(seo-audit): kill false positives` commit).
