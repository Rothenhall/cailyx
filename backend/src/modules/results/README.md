# `results` — G13: Comparable outcomes, complete report snapshots and client results

Turns design_plan §6.3 (the metric dictionary, line 792) and §6.4 (the
comparison and evidence policy, line 819) into code. Every metric the
dictionary defines is served for an explicit window, with its evidence bundle,
its coverage and a comparability verdict.

Contract source: `design_plan.md` G13 (line 1671). Screens RP02/RP03/CP07/PJ01/SE03/SP03.

## The seven non-negotiables, and where each is implemented

| # | Requirement | Where |
|---|---|---|
| 1 | **An exact historical window is reproducible.** Never re-derive "last 30 days" from today when serving an old report. | `period.service.ts` → `resolveWindow`. A `periodId` reads `startsOn`/`endsOn`/`timezone` off the row and uses them verbatim; only a request with no period gets a computed window, and that window is labelled `stored: false` with a sentence saying it will move. `PeriodService.update` refuses to move the window of a period pinned by an `EvidenceManifest` (409), because that would leave the manifest describing a window it was never built for. |
| 2 | **Empty is not zero.** A period with no observations returns "not measured" — never `0`. | `results.types.ts` `Metric` / `MetricDelta` are discriminated unions on `state`, and `value` exists **only** on the measured branch. A consumer that has not narrowed on `state === 'measured'` cannot compile a read of `.value` at all, so `0` is not reachable for an unmeasured metric. Verified at runtime: `value` is absent (`hasOwnProperty` false) for every "not-measured" metric. |
| 3 | **Comparability is validated, not assumed.** A change in query set + version, engines, markets or transport is a methodology break — return it as such and withhold the delta. | `cohort.service.ts` → `methodologyHashOf` hashes the comparison key (array order normalised, nulls distinct from empty), `buildChecks` compares two cohorts key by key, `hasHardBreak` decides. `Comparability` has **no `deltas` property** on the `methodology-break` branch, so movement cannot be read. The break is appended to `MeasurementCohort.breaks`, deduplicated by baseline pair. A cohort edit that moves the key without a `breakReason` is refused (409). |
| 4 | **`EvidenceManifest` pins source ids**, records per-source coverage, real source dates and named omissions. A latest-source timestamp is never mislabelled as the period end. | `evidence.service.ts` → `collect` (16 source types, pinned ids, `expected`/`succeeded`/`failed`/`pending` per source) and `buildFreshness`, which keeps `latestSourceObservedAt` and `periodEndsOn` in **two different fields** and states their relationship in a sentence (`sourcesPredatePeriodEnd`, `stalenessDays`, `statement`). |
| 5 | **Pending and failed observations are disclosed, never silently dropped.** | Every collection that started and did not finish, and every one that failed, appears in `coverage[sourceType]` and in `disclosure.pending` / `disclosure.failed` with its reason (sanitised of credentials). `MeasurementRun.failedRequests`, `AeoAudit.status`, `AuthorityScan` partial/failed, `BacklinksSummary` partial, zero-page crawls and empty GSC audits all count as failures with reasons. |
| 6 | **Personal contact data is omitted from public and client aggregates.** | `results.service.ts` → `project`. The client projection removes lead rows, contact names/emails, operator identifiers, raw model answers, internal notes, unpublished drafts and commercial costs, and names each removal in `disclosure.omitted`. Provider error text matching a secret pattern is replaced with a sentence rather than republished. |
| 7 | **Validated revenue needs a CRM/conversion linkage that does not exist. `Lead` rows are Cailyx's own sales pipeline, never client ROI.** | `results.service.ts` → `businessOutcomes` returns `state: 'not-measured'` with the reason and the prerequisite, and labels the `Lead` rows with what they actually are. The client projection zeroes the lead count and says it is not included. |

## File tree

```
results/
  results.module.ts             controllers + providers
  results.types.ts              vocabularies, discriminated unions, constants
  results.util.ts               JSON columns, timezone arithmetic, hashing, redaction
  results.service.ts            the read: metrics, comparability, projection
  cohort.service.ts             methodology fingerprint and comparability verdict
  period.service.ts             stored windows and precedence
  evidence.service.ts           source collection and manifests
  results.controller.ts         operator + client HTTP surface
  dto/
    results.dto.ts              results query, manifest list/create
    cohort.dto.ts               cohort create/update/break
    period.dto.ts               period create/update
```

## Endpoints (14)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/results` | any operator with access | The read: window, metrics, comparability, evidence, disclosure |
| GET | `/api/projects/:projectId/measurement-cohorts` | any operator with access | List cohorts |
| GET | `/api/projects/:projectId/measurement-cohorts/:id` | any operator with access | One cohort with its fingerprint and breaks |
| POST | `/api/projects/:projectId/measurement-cohorts` | admin, delivery-lead | Create; hash computed server-side |
| PATCH | `/api/projects/:projectId/measurement-cohorts/:id` | admin, delivery-lead | Edit; requires `breakReason` when the key moves |
| POST | `/api/projects/:projectId/measurement-cohorts/:id/breaks` | admin, delivery-lead | Record a break no field change expresses |
| GET | `/api/projects/:projectId/report-periods` | any operator with access | Stored windows, newest first |
| GET | `/api/projects/:projectId/report-periods/:id` | any operator with access | One stored window |
| POST | `/api/projects/:projectId/report-periods` | admin, delivery-lead | Store a window; bounds resolved in a timezone |
| PATCH | `/api/projects/:projectId/report-periods/:id` | admin, delivery-lead | Edit; window frozen once a manifest pins it |
| GET | `/api/projects/:projectId/evidence-manifests` | any operator with access | List, filterable by subject/period |
| GET | `/api/projects/:projectId/evidence-manifests/:id` | any operator with access | One manifest: pinned ids, coverage, real source dates |
| POST | `/api/projects/:projectId/evidence-manifests` | admin, delivery-lead | Build and pin a manifest |
| GET | `/api/portal/projects/:projectId/results` | `@ClientPortal()` | The client's own view, narrowed and disclosed |

### Query parameters (`GET .../results`)

| Param | Meaning |
|---|---|
| `periodId` | Stored `ReportPeriod`. Replaces `from`/`to` entirely; bounds and timezone come from the row. |
| `from`, `to` | `YYYY-MM-DD` (whole day in `timezone`) or full ISO 8601. Ignored when `periodId` is set. |
| `baselineId` | A `ReportPeriod` id, a `MeasurementCohort` id (its earliest period), or `previous`. Omitted means **no comparison** — the response says so rather than inventing a baseline. |
| `cohortId` | Explicit cohort; else the period's, else the project's most recent, with the rung reported in `cohortSource` notes. |
| `timezone` | IANA zone the bounds resolve in. Defaults to the project's. |

## Metrics served

`rubricScore`, `mentionRate`, `citationRate`, `shareOfVoice`, `observations`,
`coverage`, `crawlerActivity`, `referringDomains`.

All eight are always present, measured or not — the dictionary is never
filtered down to whatever happened to have data, because a missing row is the
ambiguity "empty is not zero" exists to remove.

Each metric carries `unit`, `definition`, `sample` (with the n≥5 floor and its
caveat), `scope` (the comparison key), and `notes`. No confidence interval or
significance badge is produced: no statistical method has been approved for
this system.

## Design decisions worth knowing

- **Metrics and evidence come from one collection pass.** `EvidenceService.collect`
  returns both, so a snapshot cannot report a rate its own manifest does not cover.
- **Large sources pin a bounded prefix.** Up to 500 ids per source type; anything
  longer is named in `truncations` rather than silently shortened. Observations
  pin their parent run, because a run is the reproducible unit.
- **`omissions` holds two facts** — what was absent and what was truncated —
  distinguished by a stored `absent: ` / `truncated: ` prefix so both survive
  the round trip through one JSON column.
- **A break withholds only the delta keys** (`rubricScore`, `mentionRate`,
  `citationRate`, `shareOfVoice`, `coverage`). Raw counts and inventories are
  still reported, because a count is not a movement.
- **The export/`results` distinction is deliberate.** An export carries stored
  rows; this endpoint computes from them. An export must not serve a live number
  where a recorded one exists.

## Dependencies

- `PrismaService` — global (`DatabaseModule`).
- `ScopeValidationService` — global (`ScopeValidationModule`, activated in `AuthModule`).
- No new packages. Timezone arithmetic is `Intl`-based (`results.util.ts`);
  hashing is `node:crypto`.

## Env vars

None.

## What was verified

Run against a live server (`node dist/main`, port 3123) with the dev database:

- Default read: `appliedBy: 'default'`, `stored: false`, reproducibility note present.
- All eight metrics `not-measured` on a window with no data, and **`value` absent**
  from the payload for each (`hasOwnProperty` check).
- Stored period: `window.stored: true`, `appliedBy: 'period'`, bounds byte-identical
  to the row, and a bare `2026-03-01`..`2026-03-31` in `America/New_York` resolving
  to `2026-03-01T05:00:00.000Z`..`2026-04-01T04:00:00.996Z` (EST→EDT, correct).
- Methodology break: `state: 'methodology-break'` with **no `deltas` property**,
  the changed key named (`Engines / surfaces`), one break recorded on the cohort,
  and the withheld metric keys listed. The same read against a matching cohort
  returned `state: 'comparable'` **with** `deltas`.
- Engine order normalised: `["perplexity-browser","chatgpt-browser"]` hashes the
  same as `["chatgpt-browser","perplexity-browser"]`.
- Cohort edit moving the key without `breakReason` → 409; with it → 200 and the
  break appended.
- Evidence manifest create/list/read: 15 source types with coverage, 15 named
  omissions, `window.stored: true`, and `freshness.periodEndsOn` distinct from
  `latestSourceObservedAt`.
- A period pinned by a manifest: window PATCH → 409 naming the manifest; label
  PATCH → 200.
- Unknown nested ids → 404.

## Not implemented / left as an explicit unavailable state

- **Acquisition categories beyond AI sources.** G13 says to "expand beyond the
  current AI-source-only DTO only after defining acquisition categories". Those
  categories are not defined anywhere, so no acquisition metric is served rather
  than one being invented.
- **Search rank, CTR and engagement rate** (§6.3 rows) are not served as metrics:
  they live in the `seo-audit` module's own records, and re-deriving them here
  would create a second, divergent definition. They are exportable through G17.
- **Confidence intervals / significance badges** — deliberately absent; no
  approved statistical method exists.
- **Public (unauthenticated) results surface.** `ResultsAudience` includes
  `'public'` and `project()` handles it, but no public route exists in this
  package (the design plan's public surface is the report renderer, owned by G05).
- **Extending report creation** (G13: "extend report creation with reportType,
  window, baseline/cohort and pinned source IDs") lives in the `reporting`/`reports`
  modules, which this package must not edit. `Report.periodId`, `Report.cohortId`
  and `Report.manifestId` already exist in the schema; the reporting module needs
  to accept and store them and call `POST .../evidence-manifests` at release. See
  the final report for the exact change needed.

## G03 adoption

Every handler calls `ScopeValidationService.assertProjectAccess` before touching a
row, and every nested id (cohort, period, manifest) is resolved with
`findFirst({ where: { id, projectId } })` inside the URL's project — a foreign id
404s rather than resolving. The client route is a separate class marked
`@ClientPortal()`, with `clientId` taken from the JWT only.
