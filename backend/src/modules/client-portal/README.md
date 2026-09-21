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
| `GET` | `/portal/projects/:projectId/onboarding-wizard` | **(C2)** Wizard gate state: `not-started \| confirming-details \| connecting-gsc \| connecting-ga4 \| done \| waived` |
| `POST` | `/portal/projects/:projectId/onboarding-wizard/confirm-details` | **(C2)** Step (a): advance past confirm/edit details — requires a confirmed business-profile version, 409 otherwise |
| `POST` | `/portal/projects/:projectId/onboarding-wizard/connect-gsc-done` | **(C2)** Step (b): advance past connecting GSC — 409 unless a live mapped `GoogleProjectResource` actually exists |
| `POST` | `/portal/projects/:projectId/onboarding-wizard/connect-ga4-done` | **(C2)** Step (c): advance past connecting GA4 into `done` — same gating |
| `GET` | `/portal/messages` | The message thread with the operator |
| `POST` | `/portal/messages` | Post a message |

## C2 (2026-09-21) — onboarding-wizard endpoints, corrected order

`docs/analysis/client-portal.md` §§2/11/12/16/17, `docs/PLAN.md` §11.2. Adds
the wizard's read state + 3 step-transition endpoints above.
`Project.onboardingWizardState` (C1's column, unchanged enum) advances
`not-started`/`confirming-details` → `connecting-gsc` → `connecting-ga4` →
`done`, or `waived` via the admin escape hatch in `clients` (C1, unchanged).

**This corrects the ordering from two earlier attempts at C2** — one
uncommitted-but-preserved on branch `worktree-agent-aeb71c76ff99ed6d7` — both
of which built the wizard so that GSC+GA4 connection blocked the Day-1
report and the entire portal. That was reversed after the product owner
reviewed the actual hand-drawn onboarding flow diagram
(`client-onbaording.excalidraw` at the repo root): the report is shown
**before** Google-connect is asked for. Concretely, what changed and what
didn't:

- **Unchanged from the salvaged branch:** the transition-endpoint shapes
  themselves (`confirmDetailsStep`/`connectGscDoneStep`/`connectGa4DoneStep`),
  their 409 gating rules (a confirmed profile must exist before
  `confirmDetailsStep` succeeds; a live `GoogleProjectResource` mapping must
  exist before either Google step succeeds), and the `projectId`-scoped
  (never `callerId`-scoped) reads — these were already order-agnostic, since
  the state machine's values didn't change.
- **What changed:** the web client's project-level gate
  (`web/src/app/(client)/client/projects/[projectId]/layout.tsx`) now blocks
  ONLY while state is `not-started`/`confirming-details` — not
  `connecting-gsc`/`connecting-ga4`. The moment `confirm-details` succeeds,
  the client can navigate anywhere in the portal, including their Day-1
  report; the earlier attempt kept `layout.tsx` blocking through all three
  steps. The `/onboarding` wizard page itself is now a single confirm-details
  step (not three), redirecting to the project dashboard on success; the
  still-outstanding Google-connect step is now a guided banner on
  `welcome/page.tsx`, not a second blocking page.

`assertOwnsProject` (existing) guards all three new mutation methods the same
way every other client-portal method is guarded — no new security surface.

## Testing notes (C2)

Verified end-to-end against a live local backend + real Postgres (client +
project created via the admin API, business profile saved and confirmed via
`PUT`/`POST .../business-profile[/confirm]`, then driven entirely through
`/api/portal/*` as an actual client-type login):

1. `GET .../onboarding-wizard` on a fresh project → `{"state":"not-started"}`.
2. `POST .../onboarding-wizard/confirm-details` → `{"state":"connecting-gsc"}`.
3. **`GET /api/portal/reports` succeeded (200) immediately after step 2**,
   while the wizard state was still `connecting-gsc` — confirms the report is
   reachable before Google-connect, the corrected-order requirement.
4. `POST .../connect-gsc-done` with no `GoogleProjectResource` mapped yet →
   409 (`"Google Search Console is not connected yet..."`).
5. A `GoogleConnection` + `GoogleProjectResource` row inserted directly
   (simulating a completed OAuth authorize/callback, which needs real Google
   credentials this environment doesn't have) → retried `connect-gsc-done` →
   `{"state":"connecting-ga4"}`.
6. Same 409-then-succeed pattern for `connect-ga4-done` → `{"state":"done"}`.
7. **§17 verification:** a brand-new colleague login was created on the same
   client *after* the project reached `done` and had never called any wizard
   endpoint itself — its very first `GET .../onboarding-wizard` call returned
   `{"state":"done"}` immediately, confirming the gate reads `Project` state,
   never a per-user "has this login personally finished onboarding" flag.
8. The C1 admin-waive escape hatch was re-verified unaffected on a second,
   separate project: `POST /clients/:clientId/projects/:projectId/onboarding-wizard/waive`
   → `onboardingWizardState: "waived"`.

`backend`: `npx tsc --noEmit` clean (zero errors). `web`: `npm run typecheck`
clean (zero errors). Not verified in this pass: the real Google OAuth
authorize/callback round trip (needs live Google API credentials not present
in this dev environment) and a full click-through of the web UI in a browser
(verified via the API only, plus reading the gate/wizard/banner source for
correctness) — see the C2 handback report for the complete honest checklist.

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
