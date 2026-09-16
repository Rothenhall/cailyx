# Business Profile Module (G04 — confirmed intake, project attachment and access checklist)

Purpose: make "the client told us this" a checkable fact rather than a note
somebody typed. A `BusinessProfile` version is either a **draft** (a proposal,
nobody has stood behind it) or **confirmed** (a human's id and a timestamp are
on the row), and the two are never blended — not with each other, and not with
the scraped guesses sitting in `SiteContext` on the same project.

Screens: OP06 (project setup), CP04 (welcome checklist), AE05 (site context),
SL03/PJ02 (project detail). §5.3 steps 4–5 of `design_plan.md`.

## File tree

```
business-profile/
  business-profile.controller.ts   4 controller classes (operator profile, attach,
                                   onboarding, client portal)
  business-profile.service.ts      versioning, confirmation, explicit rebuild,
                                   attachment, domain correction, checklist
  business-profile.types.ts        status vocabularies, transition table, DTO shapes
  business-profile.module.ts       registers all 4 controllers, exports the service
  lib/domain.util.ts               domain normalization + validation
  dto/business-profile.dto.ts      profile read/save/confirm/rebuild
  dto/attach.dto.ts                attach + domain correction
  dto/onboarding-request.dto.ts    requests, client-side update, list filters
```

## Endpoints (18)

### Operator — business profile (`/api/projects/:projectId/business-profile`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ profile \| null, confirmedVersion, versionCount, unavailableReason }`. `?version=N` reads one exact version; `?state=confirmed` reads the newest confirmed version and **404s when nothing has ever been confirmed** |
| PUT | `/` | admin, delivery-lead | `{ profile, warnings }` — merges the patch onto the working draft |
| GET | `/versions` | operator | `{ versions, latestConfirmedVersion }`, newest first |
| POST | `/confirm` | admin, delivery-lead | `{ profile (the NEW confirmed version), confirmedFrom, warnings }` |
| GET | `/candidates` | operator | `{ candidates, policy, latestConfirmedVersion }` — extracted `SiteContext` rows |
| POST | `/rebuild` | admin, delivery-lead | `RebuildResult` — per-target before/after + what was deliberately not touched |

### Operator — attachment (`/api/clients/:clientId/projects/:projectId`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/attach-check` | operator | `AttachmentCheckResult` — preflight, writes nothing |
| PUT | `/attach` | admin, delivery-lead | `ProjectAttachmentDto` — the project + its real ownership |
| PUT | `/domain` | admin, delivery-lead | `DomainCorrectionResult` — validated, conflict-checked, audited |

### Operator — onboarding requests and checklist (`/api/projects/:projectId`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/onboarding-requests` | operator | `{ requests, counts }`, filterable by `status`/`kind`/`outstanding` |
| POST | `/onboarding-requests` | admin, delivery-lead | 201 request |
| PATCH | `/onboarding-requests/:requestId` | admin, delivery-lead | 200 updated request |
| GET | `/onboarding-checklist` | operator | `OnboardingChecklistDto` |

**Why these are flat and not `.../onboarding/requests`.** `JobsModule` is
registered earlier in `app.module.ts` and already owns
`@Controller('projects/:projectId/onboarding')` with `@Get(':runId')`. Nest
resolves routes in registration order across modules, so
`GET /api/projects/:projectId/onboarding/checklist` was matched by that
controller's `:runId` route first and never reached this module — confirmed by
running it, not by reading it (it answered `Onboarding run checklist not found`).
The only fix available from inside this module is to not share the prefix;
`POST`/`PATCH` would have coexisted, but splitting one resource's reads from its
writes across two prefixes would be worse than moving all four. Reported rather
than worked around in `jobs/`, which is not this module's to edit.

### Client portal (`/api/portal/projects/:projectId` — `@ClientPortal()`)

| Method | Path | Returns |
|---|---|---|
| GET | `/business-profile` | same envelope as the operator read |
| PUT | `/business-profile` | `{ profile, warnings }` |
| POST | `/business-profile/confirm` | the new confirmed version (the CP04 "confirm your details" action) |
| GET | `/onboarding/checklist` | `OnboardingChecklistDto`, including `blocking` |
| PATCH | `/onboarding/requests/:requestId` | 200 updated request — status limited to `open`/`in-progress`/`done` |

`clientId` on the portal class comes from the JWT only, and every handler still
passes the URL's `projectId` to `ScopeValidationService.assertProjectAccess`,
so a client cannot reach another client's profile by editing the URL.

## How the non-negotiable semantics are implemented

### 1. Confirming writes a new version row

`confirm()` INSERTs a row at `max(version) + 1` carrying `confirmedBy` /
`confirmedAt`, and leaves the draft it read untouched. The draft is the record
of *exactly what the confirming human was shown*; stamping it would destroy
that record the moment somebody edited the profile again.

`saveDraft()` has two cases and no third one:

- newest row is an **unconfirmed draft** → updated in place (no human ever
  stood behind its contents, so no fact is at risk);
- newest row is **confirmed** (or absent) → a NEW draft is created from the
  confirmed values and then patched.

There is no code path in which a row with `confirmedAt != null` is written.

Refusals are specific, because "you cannot confirm this" is useless alone:
confirming an already-confirmed version, confirming a draft a newer confirmed
version has superseded, and confirming when no draft exists are three different
situations with three different fixes (409 each, with the fix in the message).

An **empty** draft is refused (`version N is an empty draft, so there is nothing
to confirm`): a confirmation record has to be a confirmation *of* something. An
incomplete but substantive profile confirms normally; its gaps come back in
`warnings` and go into the audit event, rather than being turned into a note
somebody types "ok" into.

### 2. Confirmed values stay separate from extracted candidates

`GET .../candidates` reads `SiteContext` and returns a shape with
`provenance: 'extracted'` and `confirmed: false`; it contains no `confirmedAt`
field anywhere, so nothing that renders one of these can present it as a fact.
`SiteContextCandidateDto` is a different TypeScript type from
`BusinessProfileData` — merging them is a compile error, not a code review
catch. No method in the service reads `SiteContext` on the profile's behalf: a
scrape becomes a fact only by a human typing it into a draft and confirming it.

### 3. `confirmedBy`/`confirmedAt` stay null until a human confirms

Every read response carries `state` (`'draft' | 'confirmed'`), `isDraft`, and
`confirmedVersion` (the newest *confirmed* version, or `null`). A consumer that
must not cite a guess asks for `?state=confirmed` and gets a 404 rather than a
draft.

### 4. Changed facts propagate only on an explicit rebuild

Confirming updates **nothing** else on the project. `POST /rebuild` is the only
path that moves confirmed facts outward, and it:

- requires `targets` (`@IsIn(REBUILD_TARGETS)`, non-empty) — nothing moves by
  implication;
- reads only from a **confirmed** version (naming a draft is a 409);
- supports `dryRun` to report the diff without writing;
- returns `notTouched`, listing the downstream artifacts it deliberately did
  not touch and the endpoint that owns each (gap-analysis sync, strategy build,
  findings generate, report generate) — the honest counterpart to the targets
  it did apply;
- records an audit event naming the source version and the reason.

The one target implemented, `project-competitors`, **merges** the confirmed
rival names into `Project.competitors` (the JSON column intake seeds and
share-of-voice reads). A merge, not a replace: it cannot lose evidence intake
already found. `GET ...?version=N` is the other way to pin a reading without
propagating anything.

### 5. Domain correction is a validated change, not a label edit

`lib/domain.util.ts` normalizes to the bare host (scheme, `www.`, port, path,
case, trailing dot only) and **throws** on anything that is not a hostname — an
unsupported scheme, an email address, an IPv4 literal. `PUT .../domain`
requires the project to actually belong to the `:clientId` in the URL (an
unattached project is a 404 — attach it first), checks every other project's
domain *after normalization* (so `https://www.Example.com/` collides with
`example.com`), demands a reason, and writes an audit event with before/after.
The `@unique` constraint is the last line of defence; a race that beats the
pre-check surfaces as a 409, not a 500.

### 6. `clientName` never masquerades as a `clientId`

`Project` has both a nullable `clientId` (relation) and a legacy `clientName`
(string). They are treated as different things everywhere:

- `ProjectOwnershipDto` reports both, plus `established` (true only when
  `clientId` is set) and `labelWithoutOwnership` (a label with no `clientId`).
- `PUT /attach` never resolves a client from `clientName`. A project whose only
  connection to a client is that string is **unattached**, and the response says
  so in `warnings`.
- The label is written *from* `clientId` (seeded from the owning client's name
  when the column is empty), never read *to* it.
- Moving a project away from another client requires `reassign: true`; a stale
  wizard tab resubmitting cannot relink somebody's project.
- Duplicate domains are refused globally, not per-client: one domain cannot be
  owned by two clients, so a collision against any project must be resolved
  rather than attached around.

### 7. `blockedWork` is exposed with its link

`OnboardingRequest.blockedWork` (JSON string[]) holds WorkItem ids. Every read
returns them **both** as the stored ids and resolved to `blockedWorkLinks`
(id, title, status, cycleId), so a client-facing view can say *what* is waiting
on them. An id that no longer resolves is reported `missing: true`, never
dropped. On write, every id is checked to belong to the same `projectId` — a
foreign or unknown id is a **404** (not a 403), so a caller who guesses another
project's work-item id learns nothing from the error.

## The checklist

`GET .../onboarding/checklist` is built from records, and every line names its
`source`:

| Key | Source | Rule |
|---|---|---|
| `confirm-profile` | `business-profile` | done when a confirmed version exists, regardless of any request |
| `invite-collaborators` | `client-member` | done when the client has more than one active seat; `unavailable` when no client is attached |
| `gsc-access` / `ga4-access` / `cms-access` / `brand-assets` | `onboarding-request` | the request's own status |
| `agree-scope` | `cycle` | done when a cycle exists with status ≠ `planning` |

A line with no backing record is `not-requested`, which is a different state
from `done`, and `unavailable` is a different state from a failure. `counts`
separates all four so a UI cannot collapse them.

`blocking` is the "why is this waiting on me" view: each outstanding request
with the work items it is holding up.

## Dependencies

- `PrismaService` — global via `DatabaseModule`, injected, never imported.
- `ScopeValidationService` — global via `ScopeValidationModule`, used by every
  handler to derive/validate `clientId`/`projectId` ownership before touching a
  row. It is imported explicitly in `BusinessProfileModule` only for
  `ActivityModule`, below.
- `ActivityService` (`ActivityModule`) — audit events for attach, domain
  correction, draft writes, confirmations, explicit rebuilds, request changes.
  An audit failure is logged and does not fail the business write.

## Env vars

None. No LLM, no external provider, no queue.

## PRD alignment (design_plan.md Appendix A, G04 + §5.3)

| Requirement | Status |
|---|---|
| `PUT /api/clients/:clientId/projects/:projectId/attach` with explicit authorized reassignment | ✅ `reassign: true` required to move between clients; `expectedCurrentClientId` optional optimistic guard; `attach-check` preflight |
| `GET/PUT /api/projects/:projectId/business-profile` | ✅ plus `/versions`, `/confirm`, `/candidates`, `/rebuild` |
| Scoped portal equivalent | ✅ `/api/portal/projects/:projectId/business-profile`, `.../confirm`, `.../onboarding/checklist`, `.../onboarding/requests/:id` |
| `GET/POST/PATCH .../onboarding/requests` and checklist reads | ✅ all four verbs, at `.../onboarding-requests` and `.../onboarding-checklist` — see "Why these are flat" above for why the nested path is not usable |
| Business profile: version, brand/legal name, description/services, ICP, markets/languages, facts, competitors, goals, approvers, CMS/publishing, confirmedBy/time | ✅ every field on the model is read and written; `publishing` carries cms/constraints/styleNotes |
| Persist confirmed values separately from extracted candidates | ✅ separate endpoint, separate type, no shared read path |
| Sales handoff does not duplicate a unique domain | ✅ attach attaches the existing project; `attach-check` and `attach` both refuse a normalized duplicate |
| `clientName` does not masquerade as `clientId` | ✅ ownership reported structurally; legacy label reported, superseded, never resolved |
| Changed facts propagate only on explicit rebuild/version selection | ✅ `POST /rebuild` with required targets, confirmed-only source, dry run, `notTouched`; `?version=` for non-propagating reads |
| Domain correction requires validated normalization/conflict/ownership policy | ✅ `lib/domain.util.ts` + global conflict check + ownership 404 + mandatory reason + audit |
| Request: type, requested person, due, status, blocked work | ✅ plus `blockedWorkLinks`, `outstanding`, `overdue` |
| Draft-project / setup launch separation | ⚠ **not implemented.** §5.3 asks for "save draft, finish setup, then launch" without creating a project prematurely. `POST /api/clients/:id/projects` still creates the project and starts the pipeline immediately, and G07 owns durable orchestration/resume. Nothing in this module simulates a draft project — creating a hidden project to fake one is exactly what the plan forbids. |
| Interim: notes/messages and operator edits, labeled unstructured | ➖ not needed: the structured intake path exists, so no unstructured interim is served. |

## What was verified, and what was not

- `npx tsc --noEmit` on `backend/` → **0 errors**; `npx nest build` → succeeds.
- **90/90 smoke assertions pass**, run end to end against a booted server
  (`PORT=3099 SCHEDULING_BACKEND=bullmq CADENCE_TICK_MS=0 node dist/main`, so
  the hourly audit schedulers and the cadence ticker stood down and no second
  instance could trigger work). The script lives at `/tmp/g04-g20.smoke.sh` and
  sources the repo's own `smoke/_common.sh`; it was not added to `backend/smoke/`
  because that directory is outside this task's scope.
  Directly exercised, among others:
  - confirm writes version 2 while the draft is version 1, and
    `?state=confirmed` afterwards still returns version 2 carrying the
    *pre-edit* data after a later draft edit → the confirmed row is never
    mutated;
  - a rebuild from a draft version 409s; a dry run reports the change without
    writing; a real rebuild moves `Project.competitors`; **confirming a version
    propagates nothing**;
  - `blockedWork` with a foreign id 404s, and a valid one resolves to the work
    item's title;
  - attach refuses a normalized duplicate domain (409), is a no-op when the
    project is already owned by the named client, requires `reassign: true` to
    move a project between clients, and reports a legacy `clientName` as
    non-ownership;
  - domain correction refuses a collision (409) and invalid input (400), and
    normalizes `HTTPS://WWW.X/` to `x`;
  - the client portal returns 403 for another client's project, 403 on the
    operator route, and a client's edit produces a `draft`, not a fact.
- **Not covered by the smoke run:** `assertPublicShareAllowed` is a G20
  concern; nothing calls it over HTTP by design, so it is verified by
  compilation and inspection only.
- The 404 for a project id that does not exist is returned before the ownership
  check can distinguish it (both are 404 on the portal surface), which is
  intentional — see `ScopeValidationService.assertOwnedByProject`.
