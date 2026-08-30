# Journey Module (Swarm layer — Agent #2)

> **Status:** ✅ Built and e2e-verified (2026-08-30, mock surface, SQLite dev.db — 32/32 assertions)
> **Layer:** Swarm
> **Depends on:** `persona` (identities), `MeasurementModule` (surface adapters), `database`, `config`

## Purpose

Turns a persona into a **branching multi-step search journey** — an opening
query, then realistic follow-ups (refinement / branch / comparison / objection)
that advance the persona's awareness toward "most-aware" and get more specific
with depth — then executes it against an AI-surface adapter, scoring every
answer for subject/competitor presence.

**Boundary:** every step is one API call to an AI surface (or, later, licensed
SERP data). No browser is driven as a fake human; no traffic, clicks, or
impressions are produced on a live surface. Execution defaults to the
deterministic `mock` adapter and only touches a live surface when
**`SWARM_ALLOW_LIVE=1` AND that surface's API key** are both present — otherwise
`execute` returns **503** before any spend.

## Model

```
JourneyCampaign 1─┬─* Journey 1─── * JourneyStep (self-referential tree; parentId=null = root)
                  │
        budgetUsd / spentUsd          per-step: query, rationale, kind, awareness
        the ONE knob bounding         + execution result: answerText, citations,
        a large swarm run             mentioned, cited, position, competitorsSeen, costUsd
```

## How it works

| Phase | What happens |
|---|---|
| **Plan** (`POST /journeys/plan`) | `journey.planner.ts` builds a deterministic tree seeded by the persona's `seed` — same persona → same journey. `useLlm:true` swaps in one LLM-planned tree of the identical shape (needs `ANTHROPIC_API_KEY`, 503 otherwise); it falls back to the deterministic plan on any parse failure so a plan always lands. Nothing executes here. |
| **Execute** (`POST /journeys/:id/execute`) | Walks `pending` steps depth-first against the surface adapter, scores each answer with the shared `subject-match` util (same string/host logic as the `measurement` moat), accumulates cost. |
| **Campaign** (`POST /journey-campaigns`) | Plans one journey per matching **active** persona (≤ `journeyTarget`). With `autoRun` (default) it executes them in order, halting the instant `spentUsd >= budgetUsd`. |

## Leak / cost / fan-out guards

| Guard | Where | Effect |
|---|---|---|
| **Live-surface master switch** | `SWARM_ALLOW_LIVE` (must be exactly `1`) | Any non-mock surface → 503 unless set. Then the surface's key is also required. Checked before anything is persisted for a campaign. |
| **Per-journey cost cap** | `JOURNEY_MAX_COST_PER_RUN` (default 2.00) or `?maxCostUsd=` override | On `cost >= cap`: stop, remaining steps → `skipped`, journey → `partial`, reason recorded in `note`. `maxCostUsd=0` stops before any spend. |
| **Per-campaign budget** | `budgetUsd` on the campaign row | Execution loop stops the moment cumulative spend reaches it; unrun journeys stay `planned`, campaign → `partial`. |
| **Tree size** | `JOURNEY_LIMITS.maxStepsPerJourney = 60` | Hard cap regardless of `maxDepth` (1–6) / `maxBranches` (1–4). |
| **Journey count** | `journeyTarget` validated 1–200; campaign only selects `active` personas | — |

## Public API

`@Controller('projects/:projectId')` — all routes behind the global `JwtAuthGuard`.

| Method | Route | Notes |
|---|---|---|
| GET | `/journeys` | list; `?status=` |
| POST | `/journeys/plan` | `{ personaId, surface?, geo?, maxDepth?, maxBranches?, useLlm? }` |
| GET | `/journeys/:journeyId` | detail + ordered step tree |
| POST | `/journeys/:journeyId/execute` | `?maxCostUsd=` optional cap override → rollup |
| DELETE | `/journeys/:journeyId` | — |
| GET | `/journey-campaigns` | list |
| POST | `/journey-campaigns` | `{ name, journeyTarget, budgetUsd, surface?, personaRoles?, maxDepth?, maxBranches?, useLlm?, autoRun? }` |
| GET | `/journey-campaigns/:campaignId` | detail + journeys |
| POST | `/journey-campaigns/:campaignId/execute` | run remaining journeys under remaining budget |

## Environment

```
SWARM_ALLOW_LIVE=0            # master switch — 1 to allow live AI-surface spend
JOURNEY_MAX_COST_PER_RUN=2.00 # USD cap per journey execution
JOURNEY_LLM_MODEL=claude-opus-5
MEASUREMENT_ALLOW_MOCK=1      # dev/smoke: deterministic surface (reused from measurement)
# live surfaces additionally need ANTHROPIC_API_KEY / PERPLEXITY_API_KEY
```

## Design / PRD alignment

| Item | Status | Notes |
|---|---|---|
| Agent #2 "Journey Agent — long branching journeys, not isolated keywords" | ✅ | real branching planner + LLM planner |
| Randomized query wording, follow-ups, branching, objection queries | ✅ | seeded per persona; kinds: query/refinement/branch/comparison/objection |
| Competitor discovery + subject/citation tracking per step | ✅ | shared `subject-match` util (parity with `measurement`) |
| Boundary: no synthetic traffic / impersonation | ✅ | API-only; `SWARM_ALLOW_LIVE` + key gate; mock default |
| Reuses the measurement surface adapters | ✅ | `MeasurementModule` exports them; no duplication |

## Testing

`bash smoke/journey.smoke.sh` (backend up, `MEASUREMENT_ALLOW_MOCK=1`, no keys) — **32/32 pass** (2026-08-30):

- plan: deterministic 15-step tree at depth 3 / branch 2 — exactly one root, no orphan steps, depth ≤ maxDepth
- execute (mock): all steps run, each stores an answer, cost 0, `mentionedSteps` integer; re-execute → **409**
- cost governor: `?maxCostUsd=0` → journey `partial`, 0 executed, all steps `skipped`, stop reason in `note`
- live guard: planning a `claude` journey is fine; executing it with `SWARM_ALLOW_LIVE=0` → **503**
- `useLlm` plan without `ANTHROPIC_API_KEY` → **503**
- campaign (mock, budget covers all): 3 personas → 3 journeys planned + executed, **all children `completed`**, spend 0; role filter with no active personas → **409**

**Not independently exercised by the zero-cost mock:** the campaign *budget-hit → partial* branch (identical `spent >= budget` pattern to the per-journey cap, which is tested via `maxCostUsd=0`) and live per-step token cost. Both run on the first live campaign.
