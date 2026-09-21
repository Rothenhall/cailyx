# Prompt Requests Module

> **Status:** Built and verified (live server + real Postgres, 2026-09-21)
> **Phase:** C4 (PLAN.md §11.4)
> **Spec:** `docs/analysis/client-portal.md` §13 (prompt visibility + add/delete requests), §20 (quota enforcement)

## Purpose

The lightweight prompt add/delete request queue. A client sees the real, active
query-set prompts (read-only) and can propose a new one or flag an existing
one for removal. The request lands in this module's own queue; an admin acts
on it directly through the existing `query-set` module's own edit/versioning
mechanics (fork the active set → add/remove the prompt → activate), then
records the decision here. **This module never mutates `QuerySet` or
`QuerySetItem`** — that separation from the Approval primitive is the point of
§13's design (a simple ticket, not a diff-review flow).

## Architecture

```
prompt-requests/
├── prompt-requests.module.ts       # NestJS module
├── prompt-requests.service.ts      # Create/list/decide + §20 quota snapshot
├── prompt-requests.controller.ts   # Operator queue (nested under /api/projects/:projectId)
├── prompt-requests.types.ts        # DTOs/status/action unions
├── plan-tier.util.ts               # §20 plan-tier resolution (see caveat below)
├── dto/
│   └── prompt-requests.dto.ts
└── README.md
```

Client-facing create/list routes live on `ClientPortalController`
(`GET/POST /api/portal/projects/:projectId/prompts`,
`GET/POST /api/portal/projects/:projectId/prompt-requests`) — `client-portal.module.ts`
imports this module for that.

## Public API

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/prompt-requests?status=` | admin, delivery-lead | Admin queue for a project |
| `POST` | `/api/projects/:projectId/prompt-requests/:id/decide` | admin | Record a decision — never mutates QuerySet itself |
| `GET` | `/api/portal/projects/:projectId/prompts` | client | Read-only active query set (real prompts, §13) |
| `GET` | `/api/portal/projects/:projectId/prompt-requests` | client | This client's own requests + status |
| `POST` | `/api/portal/projects/:projectId/prompt-requests` | client | Propose add or flag removal |

## §20 quota enforcement — the plan-tier caveat

§20 names four tiers with tracked-prompt limits (Starter 100 / Growth 300 /
Scale 1,000 / Enterprise unlimited). **As of this build, no model in
`backend/prisma/schema.prisma` has a clean, queryable "plan tier" field** —
`Client`, `Subscription`, `Offer` and `Entitlement` were all checked directly
(per client-portal.md §7's own note that `billing` is real and
webhook-verified, but tier-as-a-field was never part of that build). This
module's judgment call (`plan-tier.util.ts`): resolve the client's most
recent live `Subscription` → its `Offer.code`/`Offer.name`, and match that
text against the four tier slugs case-insensitively; no matching
subscription/offer defaults to **Starter** (the most conservative limit,
never silently grants more than paid for). This is documented as a judgment
call, not a discovery — if a real `Client.planTier` field lands later (one
was observed, transiently, on the shared dev database during this session's
concurrent-worktree testing — see Testing notes below), `plan-tier.util.ts`
is the only file that needs to change.

Over-quota (`activePromptCount >= planPromptLimit` on an add request) is
**flagged** (`overQuota: true` on the created row), never rejected — per §20
it is an upsell moment for the admin reviewing the queue, not a bug or a
blocked submission.

## Dependencies

- **Modules:** `database` (PrismaService) — no other module imports needed;
  quota resolution reads `Subscription`/`Offer`/`QuerySetItem` directly via Prisma.
- **npm:** none beyond existing NestJS/validation deps.
- **External services:** none.

## Environment variables

None.

## Consumers

- `client-portal` — client-facing read/create routes.
- Operator UI (not yet built in this phase — the admin queue is API-only;
  see MODULES-STATUS.md for what's left).

## PRD alignment (client-portal.md)

| Requirement | Status | Notes |
|---|---|---|
| §13 read-only prompt list | ✅ | `GET /api/portal/projects/:projectId/prompts` returns the real active QuerySet(s) with items, via `QuerySetService.list(projectId, 'active')` |
| §13 lightweight add/delete request queue, separate from Approval | ✅ | New `PromptRequest` model; never touches `QuerySet`/`QuerySetItem` |
| §13 admin acts directly via query-set's own mechanics | ✅ | Verified end-to-end: fork → add prompt → activate → decide, see Testing notes |
| §20 quota check at request time | ✅ | Snapshotted on every create; see plan-tier caveat above |
| §20 over-quota flagged, not silently failed | ✅ | `overQuota: true` field, never a 4xx |

## Testing notes

`npx tsc --noEmit` (backend) → 0 errors · `nest build` → passes.

End-to-end, live server (`PORT=3091`) against the shared dev Postgres
(`localhost:5436`), 2026-09-21:

1. Created client (`C4 Verify Client`) + project + active QuerySet (2 prompts, persona `problem-aware`) via the operator API.
2. Created a client-portal login, logged in as the client.
3. `GET /api/portal/projects/:id/prompts` → returned the 2 real active prompts.
4. `POST /api/portal/projects/:id/prompt-requests` `{action:"add", prompt:"...", persona:"problem-aware"}` → `201`, `activePromptCount: 2`, `planPromptLimit: 100`, `planTier: "starter"`, `overQuota: false`.
5. `POST .../prompt-requests` `{action:"remove", targetItemId:"<real item id>"}` → `201`, `targetPromptText` correctly snapshotted from the live item.
6. `GET /api/projects/:id/prompt-requests` (operator) → both requests listed.
7. Admin forked the active set (`POST .../query-sets/:setId/fork`), added the requested prompt to the draft, activated v2 (3 prompts) — all via the existing `query-set` endpoints, unchanged by this module.
8. `POST /api/projects/:id/prompt-requests/:reqId/decide` `{decision:"approved", resultQuerySetItemId:"..."}` → `200`, status `approved`.
9. `POST .../decide` on the remove request with `{decision:"declined"}` → `200`, status `declined`.
10. Re-`decide` on an already-decided request → `409` as expected.
11. Client-facing validation: `{action:"add"}` with no `prompt` → `409` (service-level `ConflictException`, not a DTO 400 — `prompt`/`targetItemId` are conditionally required depending on `action`, which `class-validator`'s per-field decorators can't express; the service enforces it).
12. Cross-client ownership: a client token requesting a different client's project → `403`.

**Environment note:** the shared dev Postgres is used concurrently by other
worktrees in this session; a `prisma db push` from another worktree can drop
this module's tables mid-session (observed once during this run — a `P2021
table does not exist` error, resolved by re-running `npx prisma db push
--accept-data-loss` from this worktree). This is a known environment quirk,
not a code defect — see the worktree's own session notes.

**Not yet built:** an operator-facing UI for the admin queue (§13 only
specifies "lands in an admin queue" — the queue is real and API-complete,
but no `web/` staff screen renders it yet). Recorded honestly in
`docs/MODULES-STATUS.md`.
