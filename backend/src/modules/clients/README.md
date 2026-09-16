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
├── clients.module.ts              # imports every module the Day-1 pipeline calls into
├── clients.service.ts             # CRUD, onboarding orchestration, messages
├── clients.onboarding-executors.ts # the Day-1 stages as G07 resume executors
├── clients.controller.ts          # REST API (operator-only, @Roles('delivery-lead') on mutations)
├── clients.types.ts               # response DTOs
├── dto/clients.dto.ts             # request DTOs
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

## G07/A7 — the Day-1 stages as durable, resumable executors (2026-09-16)

`clients.onboarding-executors.ts` registers one executor per Day-1 stage with
`OnboardingService.registerStageExecutor`, so a durable onboarding run
(`POST /api/projects/:projectId/onboarding` + `/resume`) can advance through the
same stage bodies this pipeline sequences. Each executor calls the same service
method with the same arguments as the corresponding stage above; nothing new is
integrated and nothing here imports `modules/jobs`' internals. Rules the
executors keep:

- **A stage the run did not ask for runs nothing** (the four opt-in stages read
  the run's own `runKeywordResearch` / `runGrowthExecution` / `runAeoAudit` /
  `runBacklinksRefresh` input, the same flags the add-client form sends) and
  reports `attempted: 0, succeeded: 0`.
- **An enqueued stage is re-checked, not re-bought.** The technical-audit and
  digital-presence executors write the job/run id they started into the run's
  `artifacts`; a later resume polls *that* id instead of queueing a second paid
  run.
- **A stage that produced nothing is a failed step**, so the run reads `partial`
  instead of `completed`; the queued stages also carry real cost
  (`keyword-research`, `backlinks`) onto the run.
- The legacy `Project.onboardingStatus`/`onboardingStep` columns are kept in
  step as stages advance, so the dashboard that polls them keeps working.

`ClientsService.createProject` is **unchanged**: it still drives the background
`runDayOnePipeline`, and no durable run is created for it — doing both would run
every stage twice. Moving Day-1 onto the ledger is a deliberate follow-up.

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
`ClientsOnboardingExecutors` uses the same set plus `OnboardingService` (from
`JobsModule`); the only new dependency it adds is `PrismaService` (global) for
the run's artifacts and the legacy onboarding columns.

## Testing notes

Verified end-to-end against a live local backend: create client → create
project (pipeline completes in ~15-20s against `example.com`) → create login
→ client logs in → sees their own project/report/messages → confirmed 403 in
both directions (client blocked from every operator route, operator blocked
from `/portal/*`) → confirmed cross-client `projectId` spoofing on a message
is rejected. `users.smoke.sh`, `dashboard.smoke.sh`, `competitors.smoke.sh`
re-run clean after the `RolesGuard` change (no regression). `npx tsc --noEmit`
clean.

## G19/D26 — operator message write validates project ownership (2026-09-16)

**Before:** `POST /clients/:clientId/messages` accepted an optional `projectId`
and wrote it straight onto the row after only checking that the *client* exists.
The client-portal write (`ClientPortalService.postMessage`) had always checked
that the project belongs to the client; the operator path had not.

**After:** `ClientsService.postMessage` performs the same check, with the same
status code and message, so both write paths answer identically:

```
const owns = await prisma.project.findUnique({ where: { id: dto.projectId }, select: { clientId: true } });
if (!owns || owns.clientId !== clientId) throw new ForbiddenException('That project does not belong to this client');
```

| | before | after |
|---|---|---|
| foreign `projectId` | 201 — message filed under another client's project | 403 `That project does not belong to this client` |
| unknown `projectId` | 201 | 403 (not 404 — matching the portal, and refusing to confirm whether the id exists) |
| omitted `projectId` | client-wide message | unchanged |
| `authorType` | always server-set `operator` | unchanged |

**Verified live** (booted backend, dev DB, two real clients each owning a project):

| call | result |
|---|---|
| `POST /clients/{A}/messages` `{ projectId: <A's project> }` | `201`, row written with `authorType: "operator"` |
| `POST /clients/{A}/messages` `{ projectId: <B's project> }` | `403 {"message":"That project does not belong to this client","error":"Forbidden","statusCode":403}` |
| `POST /clients/{A}/messages` `{ projectId: "nonexistent-project-id" }` | `403` — same message; the response does not confirm whether the id exists |
| `POST /clients/{A}/messages` `{ body }` (no projectId) | `201`, `projectId: null` — client-wide message unchanged |
