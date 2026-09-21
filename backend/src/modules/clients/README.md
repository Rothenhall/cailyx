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

## C1 (2026-09-20) — onboarding-wizard gate + admin waive action

`docs/analysis/client-portal.md` §§15/16/33, `docs/PLAN.md` §11.1. Two additions:

- **`Project.onboardingWizardState`** — a new column, one of `not-started |
  confirming-details | connecting-gsc | connecting-ga4 | done | waived`, scoped
  to `Project` (not `Client`) per §16 — a client with several brands onboards
  each project separately. Distinct from `onboardingStatus`/`onboardingStep`
  (the Day-1 bootstrapping pipeline, unchanged, see doc comment on both in
  `schema.prisma`) and from the not-yet-built engagement Phase/Milestone model
  (Phase C3). This stage only builds the column and read/write methods
  (`getOnboardingWizardState`, `waiveOnboardingWizard`) — the sequential wizard
  UI that actually advances a project through `confirming-details` →
  `connecting-gsc` → `connecting-ga4` → `done` is Phase C2, not built here.
- **`POST /clients/:clientId/projects/:projectId/onboarding-wizard/waive`**
  (`@Roles('admin')`) — §15's escape hatch. Sets the gate straight to `waived`
  and writes an audit event via `ActivityService.record()` (action `"waived"`,
  resource `{type: "project", id: projectId}`) so who waived it, when, and for
  which client/project is recorded (§33). `waived` is always returned as the
  literal string in `ClientProjectSummaryDto.onboardingWizardState` — never
  collapsed into a boolean — so it can never be mistaken for a real Google
  connection anywhere it's read.
- **No new audit-log module was built.** `backend/src/modules/activity`
  (G15, `ActivityService`) already IS the shared admin-action audit log §33
  asks for — actor/action/resource/timestamp/redacted-metadata, plus
  already-existing admin-only read routes (`GET /api/activity`,
  `/api/activity/export`, `/api/clients/:clientId/activity`,
  `/api/projects/:projectId/activity`). `ClientsModule` now imports
  `ActivityModule` and calls `activity.record()` from
  `waiveOnboardingWizard()`. `'waived'` was added to `ActivityAction`/
  `ACTIVITY_ACTIONS` as a new, dedicated verb.

## C2 (2026-09-21) — corrected wizard order + auto-email on Day-1 completion

`docs/analysis/client-portal.md` §§2/11/12/17/18, `docs/PLAN.md` §11.2. This
**corrects the report-vs-Google-connect ordering from two earlier attempts**
at C2, one of which was preserved (uncommitted, never merged) on branch
`worktree-agent-aeb71c76ff99ed6d7`. Both earlier attempts made GSC+GA4
connection a hard gate blocking the Day-1 report and the entire portal — that
matched an early draft of client-portal.md's §11 but was reversed after the
product owner reviewed the actual hand-drawn flow diagram
(`client-onbaording.excalidraw`): the report is shown to the client **before**
Google-connect is asked for, not after. `Project.onboardingWizardState`'s
enum values are unchanged from C1 (`not-started | confirming-details |
connecting-gsc | connecting-ga4 | done | waived`) — only what's visible at
each state changed, and that change lives in the web client's gate
(`web/src/app/(client)/client/projects/[projectId]/layout.tsx`), not here.

Two pieces of real backend work landed in this module for C2:

- **Auto-email on Day-1 pipeline completion** (§2/§18). Both completion
  points — the legacy `runDayOnePipeline()`'s report stage and the durable
  `ClientsOnboardingExecutors.reportStage()` (G07/A7) — now call
  `sendPortalReadyEmail(projectId)` after the report stage settles, **whether
  it succeeded or failed** (§18: "a partial/degraded Day-1 run still fires the
  completion email"). That method creates an invite for the project's primary
  contact via `ClientAccessService.createSystemInvite()` (new, `client-access`
  module — the canonical invite-link mechanics, called as a service method,
  never re-triggering the HTTP endpoint) and sends a Plunk email: "your Cailyx
  portal is ready, click here to log in" — no PDF, no report attachment, just
  the link. Best-effort throughout: a missing contact email, an existing
  login, or an unconfigured `PLUNK_SECRET_KEY` are logged and swallowed, never
  thrown back into the pipeline.
- **`ClientsModule` now imports `ClientAccessModule`** so `ClientsService` can
  inject `ClientAccessService` for the above. No circular dependency —
  `client-access` does not import `clients`.

The wizard's own read/transition endpoints (`getOnboardingWizardState`,
`confirmDetailsStep`, `connectGscDoneStep`, `connectGa4DoneStep`) live in
`client-portal.service.ts`/`.controller.ts`, not here — this module still
only owns the state COLUMN and the admin waive escape hatch (C1, unchanged).
See that module's README for the wizard endpoints and the corrected-order
verification.

## Deprecation: temp-password login superseded by invites (2026-09-20)

`docs/analysis/client-portal.md` §2, `docs/PLAN.md` §11.0. `POST
/clients/:clientId/login` (below) is **no longer the canonical way to grant
portal access** — `POST /clients/:clientId/invites` (`client-access` module,
single-use 7-day link, client sets their own password) is. The temp-password
endpoint is kept working, not removed or restricted — it is a documented,
non-default escape hatch (`@deprecated` JSDoc on both the controller handler
and `ClientsService.createClientLogin`). Its one known caller,
`web/.../ops/clients/[clientId]/access/page.tsx`, now carries an in-page
warning banner saying the same thing; no ops-side invite UI exists yet
(that's G02/future work), so this page stays the working fallback until one
is built. No new caller should be wired to the deprecated endpoint.

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
| `GET` | `/clients/:clientId/projects/:projectId/onboarding-wizard` | any operator | Read the onboarding-wizard gate state (C1) |
| `POST` | `/clients/:clientId/projects/:projectId/onboarding-wizard/waive` | **admin only** | Waive the Google-connect gate for this project (C1/§15), writes an audit event |
| `POST` | `/clients/:clientId/login` | delivery-lead | **[Deprecated]** Create a client-portal login (temp password) — use `POST /clients/:clientId/invites` instead |
| `GET` | `/clients/:clientId/messages` | any operator | The message thread |
| `POST` | `/clients/:clientId/messages` | any operator | Post a message (visible to the client) |

## Dependencies

`JobsModule`, `DigitalPresenceModule`, `TechStackModule`, `CompetitorsModule`,
`GapAnalysisModule`, `StrategyModule`, `ReportingModule` — every module the
Day-1 pipeline calls into. No new audit logic lives here.
`ClientsOnboardingExecutors` uses the same set plus `OnboardingService` (from
`JobsModule`); the only new dependency it adds is `PrismaService` (global) for
the run's artifacts and the legacy onboarding columns.

C1 adds `ActivityModule` (`../activity/activity.module`) as a new dependency,
for `ActivityService.record()` — used only by `waiveOnboardingWizard()`.

## PRD alignment (C1 — `docs/analysis/client-portal.md` §§15/16/33)

| Requirement | Status | Notes |
|---|---|---|
| §33 shared admin-action audit log (actor, action, target, timestamp, metadata) | ✅ | Reused the existing `activity` (G15) module rather than building a new one — it already matched the spec. Added `'waived'` as a new `ActivityAction`. |
| §16 per-project onboarding-wizard state model | ✅ (state model only) | `Project.onboardingWizardState` column + `getOnboardingWizardState`/`waiveOnboardingWizard` service methods. The wizard UI that transitions through the non-waived states is Phase C2 — not built here. |
| §15 admin waive action, admin-only, audited, visibly distinct from `done` | ✅ | `POST .../onboarding-wizard/waive`, `@Roles('admin')`, writes an `ActivityEvent`, `onboardingWizardState` always returned as the literal string. |
| §11.0 cleanup — collapse to one client-login mechanism | ⚠️ | Invite-link flow (`client-access`) confirmed canonical; temp-password endpoint marked `@deprecated`, kept functional as an escape hatch (not removed — matches the plan's "deprecate, don't necessarily delete" framing). No ops-side invite UI was built (out of scope for C1), so the deprecated page remains the only working ops UI for now. |
| §11.0 cleanup — retire CP04 as the onboarding gate (rename only) | ✅ | `welcome/page.tsx` now carries an inline transition-plan comment; no UI restructuring done, per the stage's explicit scope limit. |
| §11.0 cleanup — separate namespaces for pipeline stages vs. future Phase/Milestone | ✅ | Doc comments added to `onboardingStatus`/`onboardingStep`/`onboardingWizardState` in both `schema.prisma` and `schema.production.prisma`. |
| §2/§18 auto-email on Day-1 completion (success or honest-partial), invite-link not temp-password | ✅ | `sendPortalReadyEmail()`, called from both the legacy and durable report-stage completion points, success and failure branches alike. |
| §17 wizard gate is project-scoped, never user-scoped | ✅ | Verified live: a brand-new colleague login created after a project reached `done` read `done` on its very first `GET .../onboarding-wizard` call — see client-portal module README for the transcript. |

## Testing notes

Verified end-to-end against a live local backend: create client → create
project (pipeline completes in ~15-20s against `example.com`) → create login
→ client logs in → sees their own project/report/messages → confirmed 403 in
both directions (client blocked from every operator route, operator blocked
from `/portal/*`) → confirmed cross-client `projectId` spoofing on a message
is rejected. `users.smoke.sh`, `dashboard.smoke.sh`, `competitors.smoke.sh`
re-run clean after the `RolesGuard` change (no regression). `npx tsc --noEmit`
clean.

**C1 (2026-09-20), verified live against a booted backend + real Postgres:**
created a client and project (`onboardingWizardState: "not-started"` on
create) → `GET .../onboarding-wizard` returned `{"state":"not-started"}` →
`POST .../onboarding-wizard/waive` (admin token, `reason` supplied) returned
`onboardingWizardState: "waived"` → re-read via `GET .../onboarding-wizard`
confirmed the state persisted as `{"state":"waived"}` → `GET
/api/activity?action=waived&clientId=...` returned exactly one event with
`actorId` = the admin's user id, `action: "waived"`, `resourceType:
"project"`, `resourceId` = the project id, and `changes: {onboardingWizardState:
{before: "not-started", after: "waived"}}` → confirmed the deprecated `POST
.../login` endpoint still works (201, temp password returned) — deprecation is
documentation-only, not a functional break. `npx tsc --noEmit` clean
(zero errors) after all C1 changes.

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
