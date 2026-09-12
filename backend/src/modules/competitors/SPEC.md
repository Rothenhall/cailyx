# Spec — Competitors Module

> Approved decision: `docs/analysis/wave-6-audit-pipeline.md` §D4, step 6 in §4.

## What it does

1. Reads `Project.competitors` (JSON `{name, domain}[]`), merges it with an
   optional explicit list on the request body, and upserts each into a
   `Competitor` row (`@@unique([projectId, name])`).
2. For each `Competitor`, builds a `CompetitorProfile`:
   - Tech: `TechStackService.scanDomain(projectId, competitor.domain)`.
   - Schema: `FetcherService.fetchSchema(homepageUrl)` → distinct `@type`s.
   - AEO: latest completed `AeoAudit.verdict` for the project, matched by
     competitor name against `verdict.counted.competitors` and
     `verdict.counted.shareOfVoice`.
   - SERP: the project's `SerpResult` rows (via its `SerpTracker`s), matched
     by name against `competitorsSeen` and by domain against `topDomains`.
3. `GET /gap` computes the client's own tech + schema live (same zero-cost
   operations, own domain) and diffs against every competitor's latest
   profile — set difference on tech/schema, side-by-side status on AEO/SERP.
   No composite score.

## Explicitly not built (D4)

- Running `technical-audit` (the full sitemap-crawl + Core Web Vitals audit)
  per competitor. That module is project-scoped; making it domain-scoped
  is a separate, future decision.
- Triggering new SERP or AEO runs from this module. It only attaches
  results those modules already produced.
- A composite "competitive score." The gap endpoint is a diff table.

## Data model

### `Competitor`

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | |
| `projectId` | String | |
| `name` | String | unique per project |
| `domain` | String? | nullable — a name-only competitor can still exist |
| `source` | String | `project-json` \| `manual` |
| `createdAt` | DateTime | |

### `CompetitorProfile`

| Field | Type | Notes |
|---|---|---|
| `id` | String (cuid) | |
| `competitorId` | String | FK → `Competitor` |
| `domain` | String? | copied at profile time |
| `status` | String | `completed` \| `failed` \| `skipped` |
| `error` | String? | |
| `techScanId` | String? | FK → `TechStackScan.id` (reference, not duplication) |
| `schemaTypes` | String | JSON `string[]` |
| `schemaRaw` | String | JSON `SchemaBlock[]` — `{type, fields}` per JSON-LD block found, for audit/inspection |
| `aeoStatus` | String | `present` \| `absent` \| `unknown` |
| `aeoStanding` | String? | JSON `AttachedAeoStanding`, null unless `present` |
| `aeoAuditId` | String? | the `AeoAudit.id` the snapshot came from |
| `serpStatus` | String | `present` \| `absent` \| `unknown` |
| `serpPresence` | String? | JSON `AttachedSerpPresence`, null unless `present` |
| `createdAt` | DateTime | one row per `/discover` run, never overwritten |

### `AeoAudit` (minimal mirror — see README "A note on this worktree's `AeoAudit` model")

Scalar-only read mirror (`id`, `projectId`, `status`, `verdict`, `createdAt`)
of the real `aeo-audit` module's model, added here only because that
module's schema had not landed in this worktree's base commit. This module
never writes to it.

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/projects/:projectId/competitors/discover` | `{ competitors?: [{name, domain?}] }` | `{ projectId, totalCompetitors, promoted, competitors: [...with latestProfile] }` |
| `GET` | `/projects/:projectId/competitors/profiles` | — | `{ competitors: [...with latestProfile] }` — see README "A note on the `/competitors` route" for why not the bare path |
| `GET` | `/projects/:projectId/competitors/gap` | — | `{ projectId, domain, generatedAt, tech, schema, competitors, note }` |
