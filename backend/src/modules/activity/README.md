# Activity Module (G15 — append-only activity, provenance and audit trail)

Purpose: one durable record of who did what, to which resource, with what
result. Every other module writes to it by injecting `ActivityService` and
calling `record()`; nothing updates or deletes an event afterwards. Summaries
and before/after changes are passed through the redaction helper *inside*
`record()`, so a caller cannot bypass it and a secret pasted into a summary
does not reach the table. A deleted resource still leaves its audit row behind
(`action: "deleted"`).

## File tree

```
activity/
  activity.controller.ts   HTTP layer — 4 controller classes (written this pass)
  activity.service.ts      record() + scoped reads (operator, project, client, export)
  activity.types.ts        ActivityEventDto / ActivityAction / ActorType / origin / result
  redaction.util.ts        summary + changes redaction, applied by the service on every write
  activity.module.ts       registers all four controllers, exports ActivityService
  dto/activity.dto.ts      ListActivityQueryDto + the ACTIVITY_ACTIONS list
```

## Endpoints

| Method | Path | Audience | Query | Returns |
|---|---|---|---|---|
| GET | `/api/activity` | admin, delivery-lead | `resourceType, resourceId, action, clientId, projectId, actorId, limit (1–500, default 100), cursor` | `{ events, nextCursor }` — everything, clientVisible or not |
| GET | `/api/activity/export` | admin, delivery-lead | `resourceType, clientId, projectId, action` | `{ events }` up to the service's 5000-event cap |
| GET | `/api/projects/:projectId/activity` | admin, delivery-lead | `resourceType, limit, cursor` | `{ events, nextCursor }` — project scope, still full visibility |
| GET | `/api/clients/:clientId/activity` | admin, delivery-lead | `resourceType, resourceId, action, projectId, actorId, limit, cursor` | `{ events, nextCursor }` — client scope, full visibility |
| GET | `/api/portal/activity` | client (`@ClientPortal`) | `resourceType, projectId, limit, cursor` | `{ events, nextCursor }` — `clientVisible` rows only |

**Why these roles.** The same rows sit behind all four operator routes, and
design_plan §2.3 files the audit log under Administration, so they share one
`@Roles('admin', 'delivery-lead')`. The client route is a `@ClientPortal()`
class: an operator gets 403, and a client gets only their own client's events.

**Client scope.** `clientId` comes from the JWT (`user.clientId`), never from a
request field, and the service ANDs `clientVisible: true` into the query — an
internal event is absent rather than filtered after the fact. The operator-side
`/api/clients/:clientId/activity` is the same client scope *without* that gate,
which is deliberate: operators see internal events.

**No write route, on purpose.** `record()` is the in-process API other modules
inject, and `ActivityModule` exports the service for exactly that. An HTTP
endpoint taking actor/action/result/origin from a body would let any caller
forge the audit record it is supposed to be evidence of, so none exists.
Events become rows only through the code paths that do the thing being
recorded.

**Why raw query params instead of `ListActivityQueryDto`.** That DTO's `limit`
has `@IsInt()` with no `@Type(() => Number)`, so any request carrying `limit`
fails validation and the whole list route 400s (reproduced: `?limit=2` → 400
"limit must be an integer number"). These handlers take the query params
individually and coerce `limit` themselves (`parseLimit`, 1–500, non-integer →
400 by the same message as the DTO's, so the documented contract holds).
Adding `@Type(() => Number)` to the DTO is the one-line fix that would let the
handler use it again.

## Dependencies

- `PrismaService` — global via `DatabaseModule`, injected, never imported.
- `redaction.util.ts` (module-local) — applied by the service on every write.
- Exports `ActivityService`; the call shape is documented at the top of
  `activity.service.ts`.

## Env vars

None of its own.

## PRD alignment (design_plan.md Appendix A, G15)

| Requirement | Status |
|---|---|
| `GET /api/activity` | ✅ admin/delivery-lead |
| Scoped project / client activity reads | ✅ `/api/projects/:projectId/activity`, `/api/clients/:clientId/activity`, `/api/portal/activity` |
| Export | ✅ `GET /api/activity/export` (5000-event cap; that cap is the service's) |
| Record actor/type, action, resource/version, before/after, timestamp, request/job correlation, result, origin | ✅ `record()` accepts all of it (`requestId`, `jobRunId`, `origin`, `result`) |
| Persist security/role changes, source overrides, approvals, releases, budgets, deletions, external sends | ⚠ depends on each owning module calling `record()`. The in-process API is ready and exported; whether G01/G05/G10/G11/G12 call it is not visible from this module |
| No secrets/plaintext credentials in logs | ✅ `redactSummary`/`redactChanges` are applied inside `record()`, including the actor label |
| Immutable events | ✅ no `update`/`delete` method exists on the service |
| Clients receive only permitted activity | ✅ `listForClient` is always `clientId`-scoped **and** `clientVisible`-gated, regardless of caller filters |
| Deletion retains a safe audit record under policy | ⚠ depends on the deleting module recording `action: "deleted"` before/after it deletes |
| Screen OP19 (audit log) | ✅ read + export surface |

## Verified (2026-09-16, live on :3099, operator token)

- `GET /api/activity?limit=5` → 200 `{ events: [], nextCursor: null }`; a
  filtered read 200; `?limit=nope` → **400** with the explicit message;
  no token → **401** on every route.
- `GET /api/activity/export?projectId=…` → 200 `{ events: [] }`.
- `GET /api/projects/:projectId/activity?limit=3` → 200 page shape;
  `GET /api/clients/:clientId/activity` → 200 page shape.
- `GET /api/portal/activity` with an **operator** token → **403** ("Operator
  accounts must use the operator API, not the client portal"). Not exercised
  with a client JWT — the dev DB has no `type: "client"` user (that account
  belongs to G02's invitation flow), so the `clientVisible` gate itself is
  verified by the service's query construction, not by a live client call.
- No events existed in the dev DB during the run (all reads returned empty
  pages), which is why the export/nextCursor paths were checked for shape
  rather than content.

## Not wired, and why

- **`record()` over HTTP** — deliberately absent (see above). It is the
  injection API for other modules.
- **Retention/offboarding of audit history** — G17's scope, not G15's.
