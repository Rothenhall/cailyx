# ClientAccess Module (G02)

> **Status:** HTTP layer built (2026-09-16). Services were already complete
> (`ClientAccessService`, `GoogleDelegationService`).
> **Scope:** client seats, invitations, public acceptance, and the client-scoped
> delegated-Google surface.

## Purpose

Who may sign into a client's portal, with what role and project scope — and, for
Google specifically, whose authorized connection serves a project and who else
may read through it without ever holding its tokens.

## Architecture

```
client-access/
├── client-access.module.ts          # registers all six controllers
├── client-access.controller.ts      # 6 controller classes (operator, public, client)
├── client-access.service.ts         # (pre-existing) seats + invites
├── google-delegation.service.ts     # (pre-existing) delegated Google access
├── client-access.types.ts           # (pre-existing) response shapes
├── dto/client-access.dto.ts         # (pre-existing) request DTOs
└── README.md
```

## REST API — 26 endpoints, 6 controllers

### Operator (`@Roles('admin','delivery-lead')` on every mutation)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/clients/:clientId/members` | Seats |
| `POST` | `/api/clients/:clientId/members` | Add an existing client login as a seat |
| `PATCH` | `/api/clients/:clientId/members/:memberId` | Role / project scope / status |
| `DELETE` | `/api/clients/:clientId/members/:memberId` | Revoke (soft delete) |
| `GET` | `/api/clients/:clientId/invites` | Invitations with derived status |
| `POST` | `/api/clients/:clientId/invites` | Create a 7-day single-use invite |
| `DELETE` | `/api/clients/:clientId/invites/:inviteId` | Revoke a pending invite |

### Public

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/invites/:token/accept` | `@Public()` — set a password, open a session |

### Client portal (`@ClientPortal()` — client-only, operator-forbidden)

| Method | Endpoint | Description |
|---|---|---|
| `GET`, `POST` | `/api/portal/members` | The client's own seats (POST: client-admin) |
| `PATCH`, `DELETE` | `/api/portal/members/:memberId` | Change / revoke a seat (client-admin) |
| `GET`, `POST` | `/api/portal/invites` | The client's own invites (POST: client-admin) |
| `DELETE` | `/api/portal/invites/:inviteId` | Revoke a pending invite (client-admin) |
| `GET` | `/api/portal/projects/:projectId/integrations/google/status` | Are OAuth creds configured |
| `GET` | `.../google/connections` | Per-service state from this caller's point of view |
| `POST` | `.../google/authorize` | OAuth consent for the caller's own Google account |
| `GET`/`PUT` | `.../google/resources` | Sites/properties + current mapping / map one |
| `GET` | `.../google/connections/:connectionId/impact` | What breaks if disconnected |
| `DELETE` | `.../google/connections/:service` | Disconnect (cascades mappings + delegations) |
| `GET` | `.../google/test-read` | Proxied read to prove the mapping works |
| `GET`/`POST` | `.../google/connections/:connectionId/delegations` | List / grant delegated access |
| `DELETE` | `.../google/connections/:connectionId/delegations/:granteeUserId` | Revoke |

## Scope model (enforced server-side, never in the UI)

- **Operator routes**: `clientId` from the URL is checked against the caller's
  assigned portfolio via `ScopeValidationService.assertClientAccess` before the
  service touches a row — a `delivery-lead` not assigned to the client gets
  `403`, not another client's seat list.
- **Client routes**: `clientId` comes from the JWT (`user.clientId`) on every
  handler — never a request field — so a client cannot address another client by
  editing a URL. Reading seats is open to any seat; **mutations require a
  `client-admin` seat** (resolved through `resolveMembership`, which treats a
  pre-G02 login with no `ClientMember` row as a full-scope client-admin so nobody
  is locked out).
- **Google routes**: the seat is resolved and the project is checked against it
  (`requireProjectInScope`) — 404 for another client's project, 403 for a
  sibling project outside a scoped seat. `impact` is additionally restricted to
  the caller's own client's projects (narrowed to the seat scope when it has
  one), so a connection mapped across several clients cannot leak their project
  ids or delegate list.
- **Public acceptance**: the grant (clientId / role / projectIds) is read from
  the STORED token row. `AcceptInviteDto` carries only `password` (and an
  optional `name`); a body that tries to send `role` or `clientId` is rejected
  `400` by the global pipe, so a tampered body has nothing to widen.
- **Ownership beats roles on the Google surface**: only the connection owner may
  map a resource, disconnect or grant a delegation; only the owner or the
  grantee may revoke one. No handler here ever passes a caller-supplied `userId`
  as an owner — the owner is derived from the stored row inside the service.

## Dependencies

`GoogleModule` (supplies the OAuth / connection / Search Console / Analytics
services to `GoogleDelegationService`), `JwtModule.register({})` for the
post-acceptance session, and `ScopeValidationService` (global, from
`common/guards` — activated by AuthModule importing `ScopeValidationModule`).
`PrismaService` is global.

## Env vars

| Var | Used for |
|---|---|
| `JWT_SECRET`, `JWT_ACCESS_TTL` | Access token issued on invite acceptance |
| `CLIENT_PORTAL_ORIGIN` / `CORS_ORIGIN` | Base of the emailed accept URL |
| `PLUNK_SECRET_KEY` | Invite email; absent → `emailSent: false` + `emailError`, never a false claim |

## PRD alignment (design_plan.md)

| Source | Requirement | Where |
|---|---|---|
| G02 (line 1603) | operator seat/invite list/create/revoke under `/api/clients/:clientId/members` and `/invites` | `ClientMembersController`, `ClientInvitesController` |
| G02 | "authorized client equivalents under `/api/portal/members` and `/invites`" | portal classes, `client-admin` gate |
| G02 | "public token acceptance with server-resolved scope" | `InviteAcceptanceController` (`@Public`) |
| G02 | client-scoped Google `status`, `connections`, `authorize`, `resources`, disconnect and test-read under `/api/portal/projects/:projectId/integrations/google/*` | `ClientPortalGoogleController` |
| G02 | "Add `GET .../connections/:connectionId/impact` and controlled reassignment/delegation" | `impact` + delegation routes |
| G02 acceptance | "foreign project denied" | `requireProjectInScope` (404) |
| G02 acceptance | "collaborator sees only permitted projects" | seat scope checked on every Google route |
| G02 acceptance | "second operator can use delegated grant" | `proxiedSummary` / delegation routes (see note) |
| §2.2 | "Create/manage client: admin + delivery-lead; client: no" | `@Roles('admin','delivery-lead')` on operator mutations |
| Screens | OP08, PJ03, PJ04, CP04, CP05, CP14 | the route groups above |

## Deviations / additions worth knowing

- **`authorize`, the delegations list, and `GET .../delegations`** are exposed
  beyond the literal endpoint list in the task, because G02's own text names
  `authorize` for this surface and grant/revoke without a "who currently has
  access" read is half a feature. All three map 1:1 onto existing service
  methods.
- **`test-read` takes `service`/`days` as bare query params**, not a DTO: the
  only query DTO in `dto/client-access.dto.ts` (`GoogleResourceQueryDto`) has
  just `service`, and `days` exists only in the *google* module's
  `SummaryQueryDto`. Both values are validated manually in the controller
  (`service ∈ {search-console, analytics}`, `days ∈ [1,90]`, default 28) —
  matching how `google.controller.ts` validates its own `service` path param.
  Adding a DTO would have meant editing a file outside this task's file list.
- **The Google portal surface is client-only** (`@ClientPortal()`), per its
  `/api/portal/...` path. An *operator* using a delegated grant would need the
  operator `/api/integrations/google/*` surface, which is outside this module.
- **Operator-side seat removal is `@Roles('admin','delivery-lead')`, not
  admin-only**: §2.2 gives delivery-lead "Create/manage client: Yes" and the
  service implies no admin restriction, so revocation follows the same rule as
  creation.

## What was verified

`npx tsc --noEmit` clean. All 26 routes were mapped at boot and exercised
against a live local backend:

- **Operator**: `GET .../members` and `.../invites` → `200`; unknown client →
  `404` from the scope check; `POST .../invites` → `201` with a one-time
  `token`/`acceptUrl` and an honest `emailSent: false` (Plunk 401 in dev).
- **Public**: accept with `{password,name}` → `200` with a session + seat;
  a body containing `role`/`clientId` → `400` (proving scope cannot be widened
  from the request); replaying the token → `409`; unknown token → `404`.
- **Portal**: as a `client-collaborator`, `GET` members/invites → `200`, `POST`
  → `403` ("Only a client-admin seat may manage seats and invitations").
  An operator token on `/api/portal/members` → `403`; a client token on
  `/api/operations/overview` → `403`.
- **Google**: `status` → `{configured:true}`; `connections` → one row per
  service with `access: "none"` and `connectionId: null` when nothing reaches
  the caller; `resources` → `readOnly: true`, empty options; `test-read`
  without a mapping → `404`; bad `service` → `400`; `days=900` → `400`;
  `disconnect` with no own connection → `null`; `set-resource` with no own
  connection → `409`; unknown connection for `impact`/grant/revoke → `404`.
- **Delegation, with a temporary connection + resource mapping inserted into the
  dev DB** (then deleted): `connections` reported `access: "owner"` with the
  mapped resource; `impact` listed the affected project; grant → `201`;
  delegations list → the row; `impact` then listed the affected delegate;
  revoke → `{ok:true}` and the delegate list emptied; granting to a
  non-existent user → `400`. `test-read` as the owner reached the Google client
  and failed only on the fake token (`ERR_CRYPTO_INVALID_AUTH_TAG` inside
  `google/crypto.util.js`), which confirms the delegation gate passed and the
  read ran with the owner's stored grant.
- **Scope, cross-client**: another client's user on this project → `404`
  ("Project … not found for this client"). An unassigned `delivery-lead` →
  `403` on members/invites; after an `OperatorAssignment` was added, the same
  caller → `200`.
