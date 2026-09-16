# Projects Module

> **Status:** ✅ Built and tested
> **Phase:** 0 (PLAN Phase 0 — backbone entity)

## Purpose

The backbone entity all other Cailyx modules reference. Manages project records, engagement lifecycle transitions (scorecard → diagnostic → sprint → retainer), and cross-module artifact stats.

## Architecture

```
projects/
├── projects.module.ts        # NestJS module
├── projects.service.ts       # CRUD + lifecycle + stats
├── projects.controller.ts    # REST API (root /api/projects)
├── projects.types.ts         # Types
├── dto/
│   └── projects.dto.ts       # Validated DTOs
└── README.md
```

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/api/projects` | 10/60s | Create project (domain unique) |
| `GET` | `/api/projects` | 100/60s | List, filter by status, search |
| `GET` | `/api/projects/:id` | 100/60s | Detail + artifact stats |
| `PATCH` | `/api/projects/:id` | 100/60s | Update fields |
| `PUT` | `/api/projects/:id/transition` | 100/60s | Lifecycle transition |
| `DELETE` | `/api/projects/:id` | 100/60s | Delete project |

## Lifecycle (PLAN Phase 0)

```
scorecard → diagnostic → sprint → retainer
    ↓           ↓          ↓         ↓
  archived   archived  archived archived
                       ↓    ↓
                 diagnostic (restart)
```

Invalid transitions return 409. Stats include: technicalAudits, reports, entities, gaps, scheduleActive.

## Dependencies

- `DatabaseModule` — PrismaService for project records + cross-entity counts

## G19/D12 — list response documented as the wrapper it is (2026-09-16)

`GET /api/projects` returns `{ projects: [...] }`. The checked-in
`backend/openapi.json` describes a **bare array** of projects (with a four-field
item schema), which no caller has ever received.

The response shape was **not** changed. A frontend already normalizes the
wrapper, and switching to a bare array to make a stale description true would
break a working screen. `projects.controller.ts` now carries an explicit
`@ApiResponse` for the 200 describing `{ projects: Project[] }` — it previously
had none at all, so the only description of this route's success shape was the
wrong one in the static document.

**Verified:** `npx tsc --noEmit` clean; the corrected annotation appears in the
live spec served at `/api/docs-json` on a booted instance.