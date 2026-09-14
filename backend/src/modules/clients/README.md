# Clients Module

> **Status:** ✅ Built (2026-09-13)
> **Scope:** the lean admin/client-management layer — see "What this is NOT" below.

## Purpose

Admin side of client management: create/list/update clients, add a project
under a client and run the "Day-1 pipeline" (the full audit-to-report chain
in one call), create a client-portal login, and read/post the message thread
with a client. Answers exactly what was asked for: *"we should be able to
create clients and see their status/progress"* and *"how we manage clients."*

## What this is NOT

`docs/analysis/client-portal.md` (draft v0.1) specs a much larger system:
multi-seat `Account`/`Membership`/`Invite`, an `Engagement` timeline with
`Phase`/`Milestone`/`Approval`/`Escalation`, a publish-gated `ClientSnapshot`
read model, and a 5-phase build order gated on ~9 open business decisions
(pricing tie-in, seats model, white-label timing) plus a Postgres migration.
None of that is built here — this module is the scope actually requested on
the call: a `Client` that owns projects, an admin view of their status, and a
client-facing status/reports/messages view. If the fuller plan is ever
approved, `Client`/`ClientMessage` here are additive and would extend into
`Account`/`Engagement`/`ClientSnapshot` rather than being replaced.

## Architecture

```
clients/
├── clients.module.ts       # imports every module the Day-1 pipeline calls into
├── clients.service.ts      # CRUD, onboarding orchestration, messages
├── clients.controller.ts   # REST API (operator-only, @Roles('delivery-lead') on mutations)
├── clients.types.ts        # response DTOs
├── dto/clients.dto.ts      # request DTOs
└── README.md
```

## The Day-1 pipeline

`POST /clients/:clientId/projects` creates the `Project` (with
`clientId`, `onboardingStatus: "running"`) and returns immediately — the
pipeline itself runs in the background (`void this.runDayOnePipeline(...)`,
deliberately not awaited by the HTTP handler). Progress is polled via
`GET /clients/:clientId` (`Project.onboardingStatus`/`onboardingStep`), not
held open on one long request.

Stages, in order, none of them new logic — every one is an existing module's
own method:

1. **technical-audit** — queued via `PipelineQueueService`, polled to `completed`/`failed`.
2. **digital-presence discover** — also queued (its own `PresenceDiscovery` row), polled the same way.
3. **tech-stack scan** — synchronous.
4. **competitors discover** — synchronous; a no-op when `Project.competitors` is still empty (normal on day one).
5. **gap-analysis sync** — consolidates everything above.
6. **strategy build** — the ranked action plan.
7. **reporting generate** — the actual Day-1 deliverable.

A stage failing logs a warning and the pipeline continues — most stages
degrade gracefully already (gap-analysis is per-source resilient by design).
Only a failure at stage 7 (report generation itself) marks
`onboardingStatus: "failed"`, because that is the one stage with nothing to
show for it.

## Client-portal login

`POST /clients/:clientId/login` creates a `type: "client"` `User` row (same
table, same JWT/refresh machinery as operators — see `auth` module changes
below) with a random 16-character temporary password, hashed the same way
operator registration hashes passwords. Best-effort emails it via Plunk
(mirrors `delivery`'s own inline Plunk call rather than a shared
`sendEmail()` — this module's audit found 12 similar small self-contained
integrations already in the codebase and recommended against forcing a
shared abstraction for a single fetch call). The plaintext temporary
password is returned in the HTTP response **exactly once** — if
`emailSent: false`, that response is the operator's only copy.

## Auth changes this module required

`User` gained `type: "operator" | "client"` and `clientId`. `RolesGuard`
(global) now checks the client/operator split **before** `@Roles()`, and is
**default-deny** for client-type users: a client login can reach ONLY routes
marked `@ClientPortal()` (see `client-portal` module), never an undecorated
operator route by accident. An operator hitting a `@ClientPortal()` route is
rejected too — no shared component ever renders both operator and client
data, enforced at the guard, not just the UI.

## REST API

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/clients` | any operator | List with progress overview (score, band, open gaps, onboarding state) |
| `POST` | `/clients` | delivery-lead | Create a client |
| `GET` | `/clients/:clientId` | any operator | Client detail + its projects |
| `PATCH` | `/clients/:clientId` | delivery-lead | Update name/contact/status/owner/notes |
| `POST` | `/clients/:clientId/projects` | delivery-lead | Add a project, run the Day-1 pipeline (202-shaped 201: returns immediately, `onboardingStatus: "running"`) |
| `POST` | `/clients/:clientId/login` | delivery-lead | Create a client-portal login |
| `GET` | `/clients/:clientId/messages` | any operator | The message thread |
| `POST` | `/clients/:clientId/messages` | any operator | Post a message (visible to the client) |

## Dependencies

`JobsModule`, `DigitalPresenceModule`, `TechStackModule`, `CompetitorsModule`,
`GapAnalysisModule`, `StrategyModule`, `ReportingModule` — every module the
Day-1 pipeline calls into. No new audit logic lives here.

## Testing notes

Verified end-to-end against a live local backend: create client → create
project (pipeline completes in ~15-20s against `example.com`) → create login
→ client logs in → sees their own project/report/messages → confirmed 403 in
both directions (client blocked from every operator route, operator blocked
from `/portal/*`) → confirmed cross-client `projectId` spoofing on a message
is rejected. `users.smoke.sh`, `dashboard.smoke.sh`, `competitors.smoke.sh`
re-run clean after the `RolesGuard` change (no regression). `npx tsc --noEmit`
clean.
