# Competitors Module

> **Status:** ✅ Built
> **Wave:** 6, step 6 (`docs/analysis/wave-6-audit-pipeline.md` §D4/§4)
> **Spec:** [SPEC.md](SPEC.md), [REQUIREMENTS.md](REQUIREMENTS.md), [LEFT-OUT.md](LEFT-OUT.md)

## Purpose

Turns `Project.competitors` (a JSON string on the `Project` row) into
first-class `Competitor` rows, builds a **light profile** for each one
(homepage tech-stack scan, schema/JSON-LD read, and whatever SERP/AEO
presence already exists for that rival), and produces an honest
client-vs-competitor gap comparison. Answers: **what do our competitors run,
and where do they already beat us?**

Decision D4 (approved): "light now, structured to deepen later." Storing
`Competitor`/`CompetitorProfile` as real rows — not another JSON blob — is
the structural part that makes "deepen later" real. Explicitly **not** in
scope: running the full `technical-audit` module per competitor (that stays
project-scoped; making it domain-scoped is its own future decision).

## Architecture

```
competitors/
├── competitors.module.ts        # NestJS module — imports FetcherModule, TechStackModule
├── competitors.service.ts       # discover, list, gap, profile building, AEO/SERP attachment
├── competitors.controller.ts    # POST discover, GET list, GET gap
├── dto/competitors.dto.ts       # CompetitorInputDto, DiscoverCompetitorsDto
├── README.md                    # This file
├── SPEC.md                      # Detailed module spec
├── REQUIREMENTS.md              # External tools / infra / env vars
├── SETUP-STATUS.md              # What is installed, what is pending
└── LEFT-OUT.md                  # Deferred scope
```

## How it works

1. **`POST /discover`** merges `Project.competitors` (parsed with the same
   `parseCompetitors` util `serp-intelligence` already uses) with an optional
   explicit list in the body, upserts one `Competitor` row per distinct name
   (`source: "project-json"` vs `"manual"`), then builds a fresh
   `CompetitorProfile` for each:
   - **Tech:** `TechStackService.scanDomain(projectId, competitor.domain)` —
     the exact same scan the tech-stack module runs for a project's own
     domain, reused unchanged. The scan is persisted as its own
     `TechStackScan`; the profile only stores its id.
   - **Schema:** `FetcherService.fetchSchema()` (already existed, used by
     other modules) reads the homepage's JSON-LD and records the distinct
     `@type` values found.
   - **AEO presence:** reads the project's most recent **completed**
     `AeoAudit.verdict` (JSON `AeoVerdict`) and looks for this competitor by
     name in `verdict.counted.competitors` (`CompetitorStanding[]`,
     `aeo-audit.types.ts`). Never triggers a new AEO run.
   - **SERP presence:** scans the project's existing `SerpResult` rows
     (`competitorsSeen` / `topDomains`, already written by
     `serp-intelligence`) for this competitor's name or domain. Never
     triggers a new SERP fetch.
   - A competitor with no domain on record still gets AEO/SERP attachment
     (keyed by name), but `status: "skipped"` for the crawl half.
2. **`GET /competitors/profiles`** lists every `Competitor` row with its
   latest `CompetitorProfile`. Not the bare `GET /competitors` path — see
   "A note on the `/competitors` route" below.
3. **`GET /competitors/gap`** builds a plain diff: tech signatures and schema
   types the client has that competitors lack (and vice versa), plus each
   competitor's attached AEO/SERP status side by side. **Not a scored
   verdict** — the data does not support a composite score, so none is
   invented. The client side of the diff is computed live (tech-stack scan +
   schema read against the project's own domain) since both are free, no
   vendor, single-fetch operations — the same cost class as the tech-stack
   module's own scan.

## Built Features

| Feature | Status | Notes |
|---|---|---|
| `Project.competitors` → `Competitor` row promotion | ✅ | JSON column stays populated and readable — additive, not a migration that breaks existing readers |
| Explicit competitor list on `/discover` | ✅ | Merged with the JSON list, never replaces it |
| Per-competitor tech-stack scan | ✅ | Reuses `TechStackService.scanDomain` unchanged |
| Per-competitor schema/JSON-LD read | ✅ | Reuses `FetcherService.fetchSchema` unchanged |
| AEO presence attachment | ✅ | Reads existing `AeoAudit.verdict`; reports `unknown` when no completed audit exists yet, `absent` when one exists but doesn't name this competitor |
| SERP presence attachment | ✅ | Reads existing `SerpResult` rows via the project's `SerpTracker`s |
| Gap comparison | ✅ | Presence diff on tech/schema + side-by-side AEO/SERP status; no composite score |
| No-domain competitors | ✅ | `status: "skipped"` on the crawl half; AEO/SERP attachment still runs by name |
| Full `technical-audit` per competitor | ❌ Explicitly out of scope (D4) | Project-scoped elsewhere; making it domain-scoped is a future decision |
| High-signal pages beyond the homepage | ❌ Deferred | See LEFT-OUT.md |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/projects/:id/competitors/discover` | 5/60s | Promote + (re)profile every competitor. Body: optional `{ competitors: [{name, domain?}] }` |
| `GET` | `/projects/:id/competitors/profiles` | default (100/60s) | `{ competitors }` — every `Competitor` row with its latest profile |
| `GET` | `/projects/:id/competitors/gap` | default (100/60s) | Client-vs-competitor gap comparison |

### A note on the `/competitors` route

The wave-6 doc's API table (§6) lists the list endpoint as bare
`GET /projects/:id/competitors`. That exact path is already owned by
`ProjectsController` (`projects.controller.ts`) — it returns the named
competitor list + SERP-discovered candidates that share-of-voice, authority
discovery and the frontend's RivalsPanel already read
(`{ tracked[], discovered[] }`). Nest/Express matches routes in registration
order, so adding an identical `GET` on the same path would silently make one
of the two handlers unreachable — confirmed by running both together: the
pre-existing `ProjectsController` handler wins and this module's would never
fire.

Rather than touch that endpoint's response shape (a live consumer this task
was explicitly told not to touch — `frontend/`), this module's list endpoint
lives one segment deeper: `GET /projects/:id/competitors/profiles`. `discover`
and `gap` are unaffected — neither path collides with anything on
`ProjectsController`.

## Dependencies

- `FetcherModule` — schema/JSON-LD read (`fetchSchema`, already existed).
- `TechStackModule` — `TechStackService.scanDomain`, exported specifically
  for this module (wave-6 step 3).
- `PrismaService` (global) — `Competitor`, `CompetitorProfile`,
  `TechStackScan`/`TechFinding` (read), `AeoAudit` (read), `SerpTracker` /
  `SerpResult` (read).
- `parseCompetitors`, `hostOf` from `common/utils/subject-match.ts` — the
  same JSON-parsing and domain-normalization utilities `serp-intelligence`
  already uses, for consistency.

No new npm packages, no env vars, no vendor credentials.

## Consumers

None yet. A future frontend Competitors workspace (wave-6 step 8) is the
expected consumer.

## PRD Alignment

| Requirement | Status | Notes |
|---|---|---|
| D4 — light per-competitor profile (tech + schema + attached SERP/AEO) | ✅ | See "How it works" |
| D4 — `Competitor` as first-class rows, not JSON | ✅ | `Competitor` / `CompetitorProfile` models |
| D4 — `Project.competitors` JSON stays readable during migration | ✅ | Column untouched, still populated by `intake` |
| D4 — full `technical-audit` per competitor is NOT in scope | ✅ | Not called; documented explicitly here and in LEFT-OUT.md |
| §6 API surface — discover/list/gap | ✅ | All three endpoints implemented |
| §5 data model — `Competitor`, `CompetitorProfile` | ✅ | Both added |

## Testing notes

See `backend/smoke/competitors.smoke.sh` for the automated end-to-end check:
a throwaway project seeds `Project.competitors` (JSON) directly via Prisma
(same pattern as `authority.smoke.sh`), then exercises
discover → list → gap against real domains, asserting on promotion, profile
shape, and the gap diff.

### A note on this worktree's `AeoAudit` model

This module was built in a git worktree branched before the `aeo-audit`
module (also wave-6, built the same day) had landed in this branch's base
commit. `schema.prisma` here therefore carries a **minimal, non-relational
mirror** of `AeoAudit` (scalar columns only: `id`, `projectId`, `status`,
`verdict`, `createdAt`) — just enough to read `verdict` back. This module
never writes to that table. When the full relational `AeoAudit` model (with
`SiteContext`/`AeoStance`/`AeoSurfaceRun` relations) lands in `schema.prisma`,
delete this mirror in favour of it — see the comment directly above the model
in `schema.prisma`.
