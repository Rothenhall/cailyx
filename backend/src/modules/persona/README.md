# Persona Module (Swarm layer — Agent #1)

> **Status:** ✅ Built and e2e-verified (2026-08-30, deterministic path, SQLite dev.db)
> **Layer:** Swarm — the synthetic-buyer research agents that sit on top of Waves 0–5
> **Consumed by:** `journey` (fan-out), `council` (planned)

## Purpose

Generates **synthetic buyer personas** — research identities (role, buying
context, and the concrete question the persona is chasing) that seed the
branching search journeys `journey` runs and tag measurement observations by
segment.

A persona is a lens for asking questions of AI surfaces and licensed SERP data.
**It is never used to impersonate a real human to generate traffic, clicks,
impressions, or rankings on any live surface.** That boundary is the whole point
of the layer.

## How a persona is made

| Path | Trigger | Needs a key | Notes |
|---|---|---|---|
| **Deterministic** | `POST /generate` (default) | no | Real generator (`persona.generator.ts`) — per-role goal/pain/trigger/objection/vocabulary pools, seeded PRNG. `(projectId, slotIndex, role)` → the same persona every time. |
| **LLM-refined** | `POST /generate { useLlm: true }` | `ANTHROPIC_API_KEY` (503 without) | One constrained Anthropic call per persona rewrites only the freeform strings; taxonomy (role/seniority/stage/awareness) is fixed. Cost-capped per call. |
| **Manual** | `POST /personas` | no | Hand-authored; lands as a draft. |

Lifecycle mirrors `query-set`: **draft → active → archived**. Only drafts mutate
(`PATCH` a non-draft → 409). `journey` fans out over **active** personas.

## Leak / fan-out guards

| Guard | Env | Default | Effect |
|---|---|---|---|
| Personas per project | `PERSONA_MAX_PER_PROJECT` | 100 | `generate` clamps the batch to the remaining budget (`capped: true`); at cap → 409. Archived rows still count; `DELETE` reclaims a slot. |
| LLM refinement budget | `PERSONA_MAX_COST_PER_GENERATE` | 1.00 (USD) | Once a `generate` call's refinement spend hits the cap, the remaining personas keep their deterministic copy — the batch never fails for cost. |
| Refinement model | `PERSONA_LLM_MODEL` | `claude-opus-5` | — |

## Public API

`@Controller('projects/:projectId/personas')` — all routes behind the global `JwtAuthGuard`.

| Method | Route | Notes |
|---|---|---|
| GET | `/` | list; `?status=draft\|active\|archived` |
| POST | `/` | manual create (draft) |
| POST | `/generate` | `{ count, roles?, useLlm? }` → `{ personas, llmRefined, llmCostUsd, capped }` |
| GET | `/export` | every persona for the project (client owns the set) |
| GET | `/:personaId` | detail |
| PATCH | `/:personaId` | patch (draft only → 409 otherwise) |
| POST | `/:personaId/activate` | draft → active |
| POST | `/:personaId/archive` | any → archived |
| DELETE | `/:personaId` | hard delete (reclaims cap slot) |

`count` is validated `1..100` (DTO); free-text lists are bounded (≤20 items, ≤240 chars each).

## Role catalogue

`founder · cmo · head-of-growth · seo-lead · content-lead · demand-gen · saas-operator · product-marketer · agency-owner · rev-ops`

`generate` round-robins the requested `roles` (or the full catalogue) into new
slots, continuing from the current persona count so regeneration fills fresh
slots rather than colliding.

## Dependencies

- `DatabaseModule` (`PrismaService`) — `Persona` model
- `ConfigModule` (global) — env guards
- `@anthropic-ai/sdk` (already a project dep) — LLM refinement only

## Environment

```
PERSONA_MAX_PER_PROJECT=100
PERSONA_MAX_COST_PER_GENERATE=1.00
PERSONA_LLM_MODEL=claude-opus-5
# LLM refinement reuses ANTHROPIC_API_KEY (measurement's key)
```

## PRD / design alignment

| Item | Status | Notes |
|---|---|---|
| Agent #1 "Search Persona Generator" | ✅ | deterministic + optional LLM refine |
| Feeds `query-set` persona/stage tagging (FR-5.2) | ✅ | `awareness` uses the `PromptPersona` union verbatim |
| Boundary: no synthetic traffic / impersonation | ✅ | personas never leave the research layer; enforced by design (no browser/egress path in this module) |
| One-module-at-a-time (AGENTS.md) | ✅ | schema + module + docs + smoke, nothing else scaffolded |

## Testing

`bash smoke/persona.smoke.sh` (backend running, no keys) — **24/24 assertions pass** (2026-08-30):

- deterministic generate: 12 personas, role round-robin, seed = `projectId:slot:role`, category interpolated, JSON lists populated, `awareness` in union, new rows are `draft`
- regenerate continues at the next slot (no collision); 15 total
- fan-out cap: `count:100` with 15 used → 85 created + `capped:true`; at cap → 409
- `useLlm:true` without `ANTHROPIC_API_KEY` → **503** (capability gate precedes the cap check)
- input validation: `count:0` → 400, unknown role → 400 (DTO whitelist)
- lifecycle: patch draft → 200, activate → 200, patch active → **409** (immutable)
- determinism: wipe all → regenerate founder slot 0 → **byte-identical** to the first run
