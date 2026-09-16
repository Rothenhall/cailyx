# Operations Module (G14)

> **Status:** HTTP layer built (2026-09-16). Service was already complete.
> **Scope:** the operator-only portfolio surface — overview counts, per-client
> health, and paginated work / report / lead lists, plus per-user saved views.

## Purpose

One request loads a portfolio. A list of 200 clients costs a handful of grouped
queries, not 200 round trips, and every list carries a `total` computed with the
same filters as its page. Nothing here is reachable from the client portal.

## Architecture

```
operations/
├── operations.module.ts       # registers both controllers; exports the service
├── operations.controller.ts   # OperationsController + SavedViewsController
├── operations.service.ts      # (pre-existing) scope + aggregation
├── operations.types.ts        # (pre-existing) Page<T> and row DTOs
├── dto/operations.dto.ts      # (pre-existing) query DTOs
└── README.md
```

## REST API — 9 endpoints, 2 controllers

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/operations/overview` | Portfolio counts for the caller's whole visible scope |
| `GET` | `/api/operations/clients/health` | `Page<ClientHealthDto>` — per-client attention rows |
| `GET` | `/api/operations/work` | `Page<WorkRowDto>` — filtered, paginated work |
| `GET` | `/api/operations/reports` | `Page<ReportRowDto>` — filtered, paginated reports |
| `GET` | `/api/operations/sales/leads` | `Page<SalesLeadRowDto>` — filtered, paginated leads |
| `GET` | `/api/saved-views?surface=` | The caller's own saved views |
| `POST` | `/api/saved-views` | Save the current filter state |
| `PATCH` | `/api/saved-views/:id` | Rename / re-filter / re-default |
| `DELETE` | `/api/saved-views/:id` | Delete |

## Contract notes documented in the HTTP layer

- **Paginated aggregates, never a fan-out.** Every list is a server-computed
  page; the `@ApiOperation` text on each route says so explicitly, so no caller
  is tempted to poll per client.
- **`Page<T>` = `{ items, page, pageSize, total }`.** The actual query DTOs use
  `page`/`pageSize` (defaults `1`/`25`, `pageSize` capped at 100) — not a cursor
  — and `total` is computed with the same `where` as `items`.
- **`highestLatestProjectScore` is the highest latest project score, not an
  aggregate health score.** There is no aggregate health contract, so the route
  description says this where the field surfaces; a `null` means "not measured
  yet", which is not a zero and not a failure. `healthReasons` carries the
  transparent reasons behind a row instead of a hidden composite.
- **Assignment scope comes from the caller.** `user` is the service's first
  argument on every method; a `clientId`/`projectId` in the query only narrows
  that scope (403 for a foreign client, 404 for a foreign project).
- **Saved views are per-user and store filter state, never rows.** `userId`
  comes from the JWT; read/update/delete are owner-checked in the service, so
  another user's view is a 404.

## Dependencies

`PrismaService` (global, via `DatabaseModule`). No other module.

## Env vars

None.

## PRD alignment (design_plan.md)

| Source | Requirement | Where |
|---|---|---|
| G14 (line 1687) | `GET /api/operations/overview`, `/clients/health`, `/work`, `/reports`, `/sales/leads` with server filters and scoped totals | `OperationsController` |
| G14 | "large portfolio loads without per-client polling storm" | grouped/batched queries in the service; stated on every route |
| G14 | "current client latestScore is the highest latest project score, not an aggregate health score; label it accurately" | `clients/health` description + `ClientHealthDto.highestLatestProjectScore` |
| G14 | "Saved-view CRUD stores filters, not cached sensitive result sets" | `SavedViewsController` + `CreateSavedViewDto.filters` |
| G14 acceptance | "assignment scope enforced" | every service call takes `user` first; verified live (below) |
| Screens | OP01/OP02/OP10/OP14/SL02 | the five portfolio routes |

## What was verified

`npx tsc --noEmit` clean. The app boots with all 9 routes mapped, and each was
called against a live local backend on a seeded DB:

- overview → `200`, `scope: "all"` for the admin caller.
- `clients/health` → `200` with `Page<ClientHealthDto>` and honest nulls
  (`highestLatestProjectScore: null` for a client with no report).
- `work` / `reports` / `sales/leads` → `200`, filters applied, `total` consistent.
- An unknown query param → `400` (global `forbidNonWhitelisted` pipe), so the
  DTO is the contract.
- Saved-view create → patch → list → delete round-trip → `200/200/200/200`.
- An unassigned `delivery-lead` → `403` on `/clients/:id/members`; after an
  `OperatorAssignment` was added, the same caller → `200`, and
  `?clientId=<foreign>` → `403` / `?projectId=<foreign>` → `404`.
- A `type: "client"` token on `/operations/overview` → `403`.

## Known blocker (not in this controller's files)

`CreateSavedViewDto.filters` and `UpdateSavedViewDto.filters`
(`dto/operations.dto.ts`) are declared with `@ApiProperty` but **no
class-validator decorator**. With the global `whitelist` +
`forbidNonWhitelisted` pipe, every request that carries `filters` is rejected:

```
POST /api/saved-views  {"surface":"work","name":"x","filters":{"overdue":true}}
→ 400 {"message":["property filters should not exist"]}
```

The endpoints work without `filters`, but a saved view then stores `{}` — which
defeats the feature. The fix is one decorator per class (`@IsObject()` on
`filters`, plus `@IsOptional()` / `@ValidateIf` semantics as intended). The DTO
file was outside this task's file list, so it was reported rather than edited.
