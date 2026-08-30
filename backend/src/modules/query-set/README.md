# Query Set Module

> **Status:** ✅ Built and tested
> **Phase:** 1 (PLAN Phase 1 — PRD FR-5, SOP-1)
> **PRD:** FR-5.1 (prompt sets, 100-300 at full scale — no cap enforced in code), FR-5.2 (persona/stage tagging), FR-5.3 (immutable versioning), FR-5.4 (export — client owns it)

## Purpose

Builds and versions the buyer prompt sets that every downstream measurement run consumes. A QuerySet is a versioned list of natural-language prompts tagged by persona (problem/solution/product/most-aware) and funnel stage. Drafts are mutable; activation freezes the version; editing an active set means forking a new draft version and re-activating. Export returns every set with every prompt row — per DESIGN PRINCIPLE 8, the query set is the asset and the client owns it.

## Architecture

```
query-set/
├── query-set.module.ts        # NestJS module
├── query-set.service.ts       # CRUD + activation + fork + export
├── query-set.controller.ts    # REST API (nested under /api/projects/:projectId)
├── query-set.types.ts         # Persona / status / source / funnel-stage unions
├── dto/
│   └── query-set.dto.ts       # Validated DTOs
└── README.md
```

## Public API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/query-sets?status=` | 100/60s | List all versions of all persona sets (items included) |
| `POST` | `/api/projects/:projectId/query-sets` | 10/60s | Create v1 draft for one persona (optional seed prompt) |
| `GET` | `/api/projects/:projectId/query-sets/export` | 100/60s | Export every set with all prompt rows |
| `GET` | `/api/projects/:projectId/query-sets/:setId` | 100/60s | Set detail with items |
| `POST` | `/api/projects/:projectId/query-sets/:setId/prompts` | 60/60s | Add prompt (draft only) |
| `DELETE` | `/api/projects/:projectId/query-sets/:setId/prompts/:itemId` | 100/60s | Remove prompt (draft only) |
| `POST` | `/api/projects/:projectId/query-sets/:setId/activate` | 20/60s | Activate — immutable, requires ≥ 1 prompt |
| `POST` | `/api/projects/:projectId/query-sets/:setId/fork` | 10/60s | Copy active/archived set into next draft version |

## Versioning rules (PRD FR-5.3)

- One v1 per `projectId + persona` (DB unique constraint); 409 on duplicate create.
- `POST .../activate` → `status=active`, `activatedAt` stamped; further mutation → 409.
- `POST .../fork` → new draft at `max(version) + 1` (same project + persona) with all prompts copied. Forking a draft → 409 (edit the draft in place).

## Dependencies

- **Modules:** `database` (PrismaService)
- **npm:** none beyond existing NestJS/validation deps
- **External services:** none

## Environment variables

None — fully DB-backed.

## Consumers

- `measurement` (Wave 1, not yet built) — will read **active** sets as its prompt source
- `reporting` — dashboard/query-set ownership surfaces (planned)

## PRD alignment

| PRD Requirement | Status | Notes |
|---|---|---|
| FR-5.1 Prompt sets (100-300) | ⚠️ | CRUD built; no min-count enforcement at activation (full-scale sets arrive with seeded sources in paid tiers) |
| FR-5.2 Persona/stage tagging | ✅ | Persona on set, funnel stage per item, validated |
| FR-5.3 Versioning (never edit in place) | ✅ | Draft→activate→fork cycle, unique `(projectId, version, persona)` |
| FR-5.4 Export (client owns it) | ✅ | JSON export of all sets + prompt rows |

## Testing notes

`npx tsc --noEmit` → 0 errors · `nest build` → passes. End-to-end (live server, real SQLite DB, 2026-08-30): create project + v1 set → duplicate create 409 → add/remove prompt on draft → activate (empty-guard verified via item count) → post-activation mutation 409 → fork → v2 draft with copied items → fork-a-draft 409 → export (2 sets / 2 items) → status filter → invalid persona 400 → unknown set 404. All results as expected. Test rows removed after the run.