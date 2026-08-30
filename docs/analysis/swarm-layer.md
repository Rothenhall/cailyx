# Analysis — Swarm layer (synthetic-buyer research agents)

> **Status:** ✅ Approved & built 2026-08-30 (user: "build everything … DataForSEO … keep building the rest")
> **Modules:** `persona` (#1), `journey` (#2), `serp-intelligence` (#3), `authority` (#6), `internal-link` (#8), `council` (#10)
> **Rule reminder:** one module at a time, analysis-before-code, no unapproved deps (`AGENTS.md`).

## What the layer does

A bounded swarm of research agents that simulate buyer discovery to find AI/Google
visibility gaps, then feed the existing Cailyx modules (gap-analysis, findings,
mention-tracking, scoring):

1. `persona` — synthetic buyer personas (role, context, research objective).
2. `journey` — branching multi-step search journeys per persona, executed against AI surfaces.
3. `serp-intelligence` — SERP rankings / competitors / features / AI-Overview presence over time.
4. `authority` — discovers legitimate publications/communities/podcasts to earn mentions.
5. `internal-link` — the client's own topical-architecture graph + link recommendations.
6. `council` — role-agents debate which interventions to prioritise; a synthesizer ranks them.

## The boundary (explicit, enforced in code)

The layer performs **measurement and research only**. It must never impersonate a
real human to generate artificial Google/AI **traffic, clicks, impressions, or
rankings**.

| Enforcement | Where |
|---|---|
| Journeys/campaigns hit a live AI surface only with `SWARM_ALLOW_LIVE=1` **and** the surface key; default is the deterministic `mock` adapter | `journey.service.assertLiveAllowed` |
| SERP data is a **licensed API feed (DataForSEO)** through `FetcherService` — no headless browser, no user-simulated queries | `serp-intelligence` (only providers are `dataforseo` + offline `fixture`) |
| Authority is discovery + drafting; promotion just creates a `MentionTarget` (a human to-do). No outreach, posting, or account creation | `authority.service.promote` |
| `internal-link` crawls the **client's own** domain (root defaults to `project.domain`), rate-limited by `FetcherService` | `internal-link.service` |
| Fan-out bounded: `PERSONA_MAX_PER_PROJECT`, journey depth/branch/step caps, `journeyTarget`, `AUTHORITY_LIMITS`, SERP keyword cap | per-module DTO + limits |
| Spend bounded: per-run + per-campaign USD governors, all defaulting low | `*_MAX_COST_*` env |

## Tool / dependency decisions

| Need | Options considered | Decision | Rationale |
|---|---|---|---|
| SERP data (Agent #3, #6) | **DataForSEO** · SerpApi · Bright Data SERP | **DataForSEO** (user-approved 2026-08-30) | Lowest per-query cost at volume, `live/advanced` returns AI Overview + all SERP-feature element types in one call, Basic-auth REST fits `FetcherService` with no SDK. |
| LLM (persona refine, journey/council/authority LLM modes) | **`@anthropic-ai/sdk`** (already a dep) | reuse existing `ANTHROPIC_API_KEY` | no new dependency; same client/key as `measurement` + `findings`. |
| AI-surface execution for journeys | reuse `measurement` `SurfaceAdapter`s (`claude`/`perplexity`/`mock`) | reuse via `MeasurementModule` exports | no duplication; the moat's n≥5 detection logic is shared as `common/utils/subject-match`. |
| HTML parsing (`internal-link`) | **`cheerio`** (already a dep) | reuse | — |
| Deterministic RNG | in-repo `common/utils/prng.ts` | new shared util (no dep) | reproducible generators/planners; smoke tests assert exact output. |

**Net new npm dependencies: none.** New external service: DataForSEO (live SERP
only; gated, fixture-backed for tests).

## New env

```
SWARM_ALLOW_LIVE=0                 # master switch for any live AI-surface / paid SERP spend
PERSONA_MAX_PER_PROJECT=100        PERSONA_MAX_COST_PER_GENERATE=1.00   PERSONA_LLM_MODEL=claude-opus-5
JOURNEY_MAX_COST_PER_RUN=2.00      JOURNEY_LLM_MODEL=claude-opus-5
INTERNAL_LINK_MAX_PAGES=50         INTERNAL_LINK_LLM_MODEL=claude-opus-5   #INTERNAL_LINK_ALLOW_FIXTURE=1
COUNCIL_LLM_MODEL=claude-opus-5    COUNCIL_MAX_COST_PER_RUN=1.00
#DATAFORSEO_LOGIN=  #DATAFORSEO_PASSWORD=   SERP_MAX_COST_PER_CAPTURE=5.00   #SERP_ALLOW_FIXTURE=1
AUTHORITY_LLM_MODEL=claude-opus-5  AUTHORITY_MAX_COST_PER_SCAN=1.50
```

## Data model additions (Prisma)

`Persona` · `Journey` / `JourneyStep` / `JourneyCampaign` · `LinkGraph` /
`LinkNode` / `LinkEdge` / `LinkRecommendation` · `CouncilSession` /
`CouncilContribution` / `CouncilRanking` · `SerpTracker` / `SerpQuery` /
`SerpSnapshot` / `SerpResult` · `AuthorityScan` / `AuthorityCandidate`.

## Verification

`backend/smoke/` — one self-contained `*.smoke.sh` per module + `run-all.sh`.
All zero-key / zero-spend (deterministic + fixture adapters). **2026-08-30:
148/148 assertions pass, 6/6 scripts.** `tsc --noEmit` clean, `nest build` green.

Not exercisable without credentials (each runs on first keyed use): live LLM
refinement/debate paths, the DataForSEO response parse against a real payload,
live per-call cost accounting, the campaign budget-hit branch under non-zero cost.
