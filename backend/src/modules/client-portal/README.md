# Client Portal Module

> **Status:** ✅ Built (2026-09-13)
> **Scope:** what a client-type `User` can see — project status, their
> reports, and a message thread. Nothing more. See `clients/README.md`
> "What this is NOT" — the same scope limit applies here.

## Purpose

The client-facing counterpart to `clients`. A client logs in (credentials
issued by an operator via `POST /clients/:clientId/login`) and sees their own
project(s) status/progress, their reports, and can read/post messages to the
operator — exactly the three things asked for: *"see their project status and
stuff and seeing reports and leaving messages."*

## Architecture

```
client-portal/
├── client-portal.module.ts       # imports ReportingModule only
├── client-portal.service.ts      # every query scoped to the caller's own clientId
├── client-portal.controller.ts   # @ClientPortal() on the controller — every route
├── client-portal.types.ts        # response DTOs
├── dto/client-portal.dto.ts      # request DTOs
└── README.md
```

## Security model

Every route is `@Controller('portal') @ClientPortal()` — accessible **only**
to a `type: "client"` user, enforced by the global `RolesGuard` (see
`clients/README.md`'s "Auth changes" section), not by an in-controller check
that could be forgotten on a new route.

`clientId` is read from the JWT (`req.user.clientId`) on every method,
**never** accepted from the client as a parameter. Ownership is checked
before every read:

- `listProjects`/`listReports` — pre-filtered to `WHERE clientId = <own>`, so there is nothing to check per-row.
- `getReport(slug)` — looks up the report's project, confirms `project.clientId === own clientId`, and returns a **404** (not 403) on mismatch, so a client can never confirm another client's report slug even exists.
- `postMessage({ projectId })` — when a `projectId` is given, confirms it belongs to the caller's own client before writing; **403** on mismatch.

`getReport` passes `includePrivate: true` into `reporting.getBySlug()`
deliberately: `Report.visibility: "private"` means "not publicly
link-shareable," not "hidden from the client it is about" — those are
different flags and conflating them would have hidden every Day-1 report
from the very client it was generated for.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/portal/projects` | This client's own projects, with status/score/band |
| `GET` | `/portal/reports` | This client's own reports, across all their projects |
| `GET` | `/portal/reports/:slug` | The full report (same shape `reporting` returns to an operator) — 404 if not theirs |
| `GET` | `/portal/messages` | The message thread with the operator |
| `POST` | `/portal/messages` | Post a message |

## Dependencies

`ReportingModule` (for `getBySlug`, after this module's own ownership check).
Every other read goes straight through Prisma — same convention
`gap-analysis` and `clients` already follow, rather than injecting a service
per read.

## Testing notes

Verified end-to-end (see `clients/README.md`'s testing notes for the full
create-client-through-portal-view chain) against a live local backend:
`user.type`/`clientId` land correctly on login, `/portal/projects` shows live
onboarding progress mid-pipeline and the real score/band after, `/portal/reports/:slug`
returns the actual generated report (including the stage-12 growth plan),
messages round-trip both directions, and the ownership guards were exercised
directly: a client hitting `/clients` (operator route) → 403; an operator
hitting `/portal/projects` → 403; a client posting a message against a
`projectId` that is not theirs → 403. `npx tsc --noEmit` clean.
