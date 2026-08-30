# Council Module (Swarm layer — Agent #10)

> **Status:** ✅ Built and e2e-verified (2026-08-30, deterministic engine — 22/22 assertions)
> **Layer:** Swarm
> **Depends on:** `database`, `config`. Reads (never writes) artefacts from gap-analysis, internal-link, journey, measurement, technical-audit, entity-audit.

## Purpose

Six role-agents — **technical, content, authority, measurement, narrative,
skeptic** — debate which interventions will most improve AI visibility; a
synthesizer aggregates the votes into a ranked list with a recorded **dissent**.

The council **reads only artefacts other modules already produced** and proposes
**no new measurement**. Every candidate intervention traces back to a real
artefact via `sourceRefs`.

## Candidate sources → dimension

| Artefact | Becomes a candidate when… | Dimension |
|---|---|---|
| gap-analysis `Gap` (open) | any open gap | mapped from gap dimension |
| latest complete `LinkGraph` | orphans or link recommendations exist | `architecture` |
| completed `Journey` rows | mention rate < 50% / cite rate < 35% | `authority` / `extractability` |
| latest completed `MeasurementRun` | same thresholds (independent evidence → widens breadth) | `authority` / `extractability` |
| latest `TechnicalAudit` findings | `status = fail` (≤ 6) | `machine-access` |
| latest `EntityAudit` schema checks | any `status = fail` | `entity-clarity` |

`evidenceBreadth` grows when the same lever is implied by more than one artefact
type — the `measurement` agent rewards that, the `skeptic` punishes its absence.

## Debate → synthesis

- **Round 1:** each agent votes `for` / `against` / `conditional` on every candidate with a rule-based bias (champions vs wary dimensions).
- **Round 2–3** (optional, `rounds` ≤ 3): the skeptic concedes on items that already have ≥ 60% weighted consensus.
- **Synthesizer:** `consensus` = weighted-for ÷ total-weight; `expectedImpact` = dimension baseline + evidence bonus (0–100); rank by `consensus × expectedImpact`; `dissent` = highest-weight non-`for` rationale.

Deterministic — same artefacts → same debate → same ranking. `useLlm:true` runs
one Anthropic call producing the same JSON shape, validated against the
candidate key set, falling back to the deterministic engine on any problem.

## Public API

`@Controller('projects/:projectId/council')` — behind the global `JwtAuthGuard`.

| Method | Route | Notes |
|---|---|---|
| GET | `/` | list sessions |
| POST | `/` | `{ question?, rounds?, agentRoles?, useLlm? }` → session + contributions + rankings |
| GET | `/:sessionId` | detail |
| DELETE | `/:sessionId` | — |

`rounds` 1–3, `agentRoles` ⊆ the six roles (DTO-validated).

## Guards

| Guard | Effect |
|---|---|
| No artefacts in scope | session completes with **0 rankings** — never invents work |
| `useLlm` without `ANTHROPIC_API_KEY` → **503** | |
| `COUNCIL_MAX_COST_PER_RUN` (default 1.00) | ceiling for the LLM debate |
| `rounds` / `agentRoles` DTO bounds | |

## Environment

```
COUNCIL_LLM_MODEL=claude-opus-5   # useLlm:true only; reuses ANTHROPIC_API_KEY
COUNCIL_MAX_COST_PER_RUN=1.00
```

## Design alignment

| Item | Status |
|---|---|
| Agent #10 "Council Agent — agents debate which interventions improve visibility" | ✅ 6 agents × rounds + synthesizer |
| Reads existing artefacts only, proposes no new measurement | ✅ `gatherArtefacts` is read-only; candidates carry `sourceRefs` |
| Deterministic + optional LLM | ✅ rule-based engine; LLM validated + falls back |

## Testing

`bash smoke/council.smoke.sh` (backend up, no keys) — **22/22 pass** (2026-08-30):

- empty project → session `complete`, **0 rankings** (no invented work)
- builds real upstream artefacts (3-journey mock campaign + fixture link graph with an orphan), then debates
- 3 ranked interventions; **6 contributions** (6 roles × 1 round); every ranking well-formed and in `rank` order
- top intervention carries ≥ 1 `sourceRefs`; the link-graph orphan surfaces as `architecture:internal-links`
- minority **dissent** recorded; every agent stated positions
- `rounds:2` + 3-role subset → 6 contributions, session records `rounds = 2`
- `useLlm` → **503**; `rounds:9` → **400**; unknown role → **400**
- re-run is deterministic (same top intervention, same count)
