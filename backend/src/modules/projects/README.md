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