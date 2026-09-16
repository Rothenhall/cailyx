# Measurement Module (Wave 1 — the moat)

Measures AI visibility: for every prompt in a project's **active** query set,
queries an AI surface **n≥5 times**, and scores each answer into a structured
`Observation` (mentioned / cited / competitors seen). Summaries aggregate
rates + share of voice. This is PRD §6.6–6.7 and SOP-2 in code.

## Hard rules (PLAN §7)

| Rule | Where enforced |
|---|---|
| **n ≥ 5, no exceptions** | `dto/measurement.dto.ts` (`@Min(5)`) + `measurement.service.ts` (`MIN_RUN_COUNT`) — a lower runCount is a 400 |
| **Name the surface** | every `MeasurementRun` carries `surface`; summary splits `bySurface` |
| **Rates, never positions** | summary reports mention/citation *rates*; `position` is stored on the observation for diagnostics only, never surfaced in summary |
| **Immutable query sets** | only `status=active` sets can be measured (409 otherwise) |
| **Cost governor** | `MEASUREMENT_MAX_COST_PER_RUN` — exceeded → run marked `failed` with the reason recorded |

## Endpoints

| Method | Route | Notes |
|---|---|---|
| POST | `/api/projects/:projectId/measurement/runs` | create; targets the named query set + surface + geo |
| POST | `/api/projects/:projectId/measurement/runs/:runId/execute` | runs all prompts × n; per-observation error isolation; cost-capped |
| GET | `/api/projects/:projectId/measurement/runs` | list, `?surface=` filter |
| GET | `/api/projects/:projectId/measurement/runs/:runId` | run + observations (project-ownership checked) |
| GET | `/api/projects/:projectId/measurement/summary` | rates + SOV, optional `?runId=` |

## Surfaces (adapters)

`SurfaceAdapter { name, runPrompt(prompt, geo): SurfaceAnswer }`:

- `claude` — Anthropic SDK, `web_search_20260209` server tool, citations from tool-result blocks (cost = Opus $5/$25 per MTok)
- `perplexity` — raw `fetch` to `api.perplexity.ai` (`sonar`), `citations[]` in the response
- `mock` — deterministic offline adapter, **gated behind `MEASUREMENT_ALLOW_MOCK=1`** (test-only; never in prod)

Geo v1: recorded per run for baseline structure (PRD FR-6.3); egress proxy
routing is deferred — surface calls egress from the server's own location.

## Re-execute semantics

- `pending` → runs normally
- `completed` → **409** (merge a new query-set version + create a new run; never re-ask the same scored set)
- `failed` → allowed, and wipes the partial observations + counters first so rates never double-count

## Env

```
MEASUREMENT_CLAUDE_MODEL=claude-opus-5
MEASUREMENT_PERPLEXITY_MODEL=sonar
MEASUREMENT_MAX_COST_PER_RUN=5.00
#ANTHROPIC_API_KEY=
#PERPLEXITY_API_KEY=
#MEASUREMENT_ALLOW_MOCK=1   # test-only
```

## PRD alignment

| PRD item | Status |
|---|---|
| FR-5.x / SOP-1 (query sets) | upstream — `query-set` module |
| FR-6.1–6.2 measure AI surfaces | ✅ adapters + runs |
| FR-6.3 n≥5 per prompt per surface per geo (+2 geos on baseline) | ✅ n enforced; geo recorded (multi-geo proxy routing deferred) |
| FR-6.4 mention/citation/competitor extraction | ✅ deterministic string/host matching |
| FR-6.6 cost controls | ✅ per-run cap with stop + reason |
| FR-7 share of voice | ✅ summary.shareOfVoice (subject "(you)" vs named competitors) |

## Verified e2e (2026-08-30, mock surface,SQLite dev.db)

- `runCount: 3` → 400 "runCount must not be less than 5"
- draft set → run → **409** (only active sets measure)
- activated set → run (`n=5`, 4 prompts) → execute → **20 observations, 0 failed**
- summary → `citationRate 1.0`, shareOfVoice entries, per-surface + per-funnel-stage breakdowns
- re-execute a `completed` run → **409**
- unknown surface → 400 (DTO whitelist)

## G19/D20 — empty is unmeasured, and the cohort is named (2026-09-16)

`GET /api/projects/:projectId/measurement/summary` had two defects, one of them
a real access-control gap.

**1. An empty cohort reported `0`, not "unmeasured".** With no observations the
service returned `mentionRate: 0, citationRate: 0`. Rendered, that reads as
"measured — the brand is never mentioned", which is a claim the data does not
support (design_plan §3.3: empty is not zero).

| | before | after |
|---|---|---|
| `observations: 0` | `mentionRate: 0`, `citationRate: 0` | `mentionRate: null`, `citationRate: null` |
| breakdown arrays | `[]` | `[]` (unchanged — no cohort, no groups) |
| `MeasurementSummary` type | `mentionRate: number` | `number \| null` |

The per-surface / per-funnel-stage entries keep non-null rates: a group only
exists because an observation landed in it, so its denominator is never zero.

One backend consumer read those fields — `ScoringService.evalShortlist` now
also checks `summary.mentionRate !== null` before multiplying it. Its behaviour
is unchanged (it was already gated on `observations > 0`); the extra check is
what tells the compiler the value is measured.

**2. `?runId=` was not validated against the project.** `summary(projectId,
runId)` used `where: { runId }` with no ownership check, so a run id belonging
to another project returned *that* project's observations under this project's
URL. `runId` is a filter, not a capability: it is now resolved with
`findFirst({ where: { id: runId, projectId } })` and a miss is a 404, matching
every other nested id in this module. The surface breakdown is scoped to the
requested run for the same reason.

**Cohort, stated rather than implied.** The default (no `runId`) pools every
observation the project has ever stored, across runs and surfaces — a
cumulative record, not a like-for-like period. With `runId` it is one run's
observations (one query set, one surface, one geo, one point in time). Both
shapes are documented on `MeasurementSummary` and on the route, because two
callers reading "mention rate" with different cohorts must not compare them.

Note `runs` counts every measurement run for the project regardless of status;
it is not the number of runs the summary aggregated (that is what the
`observations` count is for). Documented on the field.

**Verified live** (booted backend, dev DB):

| call | result |
|---|---|
| `GET /measurement/summary` on a project with 24 observations | `mentionRate 0.4583`, `citationRate 0.0833` — unchanged behaviour for a real cohort |
| `GET /measurement/summary` on a project with no runs | `{"runs":0,"observations":0,"mentionRate":null,"citationRate":null,"bySurface":[],"byFunnelStage":[],"shareOfVoice":[]}` |
| `GET /measurement/summary?runId=<a run of ANOTHER project>` | `404 Run not found in this project` (previously returned that project's observations) |
| `GET /measurement/summary?runId=does-not-exist` | `404 Run not found in this project` |
| `GET /measurement/summary?runId=<own run>` | `200`, `observations 24`, same rates as the pooled call for this single-run project |

A measured zero is still a zero: the same project's `product-aware` funnel stage
reports `observations: 5, mentionRate: 0` — five observations, none mentioning
the brand. That is the case the nullable rate is *not* for.