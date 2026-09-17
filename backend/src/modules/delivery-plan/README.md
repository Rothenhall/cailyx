# Delivery Plan Module

> **Status:** ✅ Built
> **Phases:** G06 (`design_plan.md` — engagements, cycles, work items,
> milestones, capacity, verification) · P01 (client-safe portal projections,
> §3.5) · P11 (§6.1–§6.3 commitments, §5.6 needs-your-action)
> **Spec:** `docs/analysis/design-plan-implementation.md` (G06). This README
> is the module's first written spec for the P01/P11 additions.

## Purpose

The delivery plan: **what we said we'd do, who is doing it, how completion is
verified, and what the client is allowed to see of it.**

Storage is `Engagement` → `Cycle` → `WorkItem`, plus `Milestone`,
`CapacityAllocation`, `Commitment`, `AcceptanceCheck` and `Verification`.
There is deliberately **no `DeliveryPlan` table** — the plan is a projection
over those records, and §6.3's instruction to *"extend with a stable
commitment resource … do not create a second independent plan engine"* is
honoured by adding `Commitment` alongside, not above, the existing cycle
machinery.

Two audiences read the same rows through different serializers: every staff
endpoint returns the operational record (internal notes included), and every
portal endpoint goes through an explicit allowlist that is a different
function, not a filtered spread.

## Architecture

```
delivery-plan/
├── delivery-plan.controller.ts   # 8 controllers, 50 endpoints, one file
├── delivery-plan.service.ts      # the whole module's logic (1655 lines)
├── delivery-plan.types.ts        # status vocabularies + transition tables + DTOs
├── delivery-plan.module.ts       # 8 controllers, 1 provider/export, no imports
├── dto/engagement.dto.ts         # create/update/status
├── dto/cycle.dto.ts              # create/update/status/commit/scope-change
├── dto/commitment.dto.ts         # create/update/status + agree/scope-change/metric/complete/cancel
├── dto/work-item.dto.ts          # create/update/submit/verify/block/checks
├── dto/capacity.dto.ts           # allocations
├── lib/timezone.util.ts          # IANA zone resolution + end-of-day due dates
└── README.md                     # This file

backend/smoke/portal-plan.smoke.sh    # P01 client-projection exit gate
backend/smoke/thirty-day-plan.smoke.sh # P11 commitments + action-queue exit gate
```

**Why eight controllers in one file.** They share the service and the `Actor`
construction; the file's header says so. Splitting them would multiply the
guard/actor boilerplate without separating any concern.

**Every status column is a `String`, re-validated in `delivery-plan.types.ts`
before any write.** SQLite has no enums, so the transition tables in that file
— `CYCLE_TRANSITIONS`, `WORK_ITEM_TRANSITIONS`, `COMMITMENT_TRANSITIONS` —
are the single source of truth, and the service checks them rather than
trusting a DTO. A status that is not reachable through the table is not
reachable at all.

## The three concepts stay distinct (§6.1)

| Concept | Model | Answers |
|---|---|---|
| Plan commitment | `Commitment` | What the team intends to accomplish in the period |
| Work item | `WorkItem` | Who performs a concrete step, by when, verified how |
| Content schedule | `content-calendar` (another module) | When a specific piece goes out |

One commitment links many work items (via `linkedWorkItemIds`); nothing here
counts a content *placement* as a separate deliverable. The commitment is the
thing the client agreed to, which is why it has its own vocabulary, its own
lifecycle and its own client projection rather than being a flag on a work
item.

## Commitments — the rules that make "agreed" mean something

**Statuses:** `draft | proposed | agreed | active | needs-attention |
completed | closed | cancelled | superseded`. Transitions are forward-biased,
and two states are **unreachable from the generic status PATCH**:

```
PATCH …/commitments/:id/status → "agreed"
  409  Use POST .../commitments/:id/agree — "agreed" requires a recorded
       confirmation, not a status PATCH.
PATCH …/commitments/:id/status → "completed"
  409  Use POST .../commitments/:id/complete — completion requires verified
       progress or an outcome metric.
```

**An operator writing the plan is not client agreement.** §6.3 rules it out
explicitly, and `agreeCommitment` is the one path:

```
POST …/commitments/:id/agree  (no confirm: true)
  409  Agreement requires confirm: true — an operator save alone is not
       client agreement.
```

`confirm: true` is the deliberate act; `agreedAt`/`agreedBy` are written with
it, and only a `draft` or `proposed` commitment can be agreed.

**Progress is derived at read time, never stored.** A countable commitment
(`targetCount` set) counts linked work items whose status is **`verified`** —
the same "verified" concept the cycle's `deliveredCount` already uses, never a
second one. `3 of 10 articles` is reported as exactly that; the code refuses
to invent a percentage. An outcome commitment reports its own recorded metric.
When neither exists but work is linked, the label is the raw count
(`2 of 5 linked item(s) verified`), not a fabricated ratio.

**An outcome commitment cannot complete on closed tasks alone.** §6.2's rule
is enforced in `completeCommitment`:

```
(this is an outcome commitment, no outcomeMetricCurrent supplied)
  409  This is an outcome commitment — completing it requires its own outcome
       metric (outcomeMetricCurrent), never just because linked tasks closed.
```

A countable commitment short of its target needs an explicit `force` **and** a
`forceReason`, and the override is appended to the commitment's scope history
(`Force-completed with 3/10 verified: <reason>`) rather than being silent.
Unforced completion of an unfilled countable commitment is a 409 naming the
count: `Only 3 of 10 target deliverables are verified — pass force+forceReason
to complete anyway.`

**A scope change can knock a commitment back.** If a change requires
reconfirmation and the commitment was `agreed` or `active`, it becomes
`needs-attention` — it cannot stay agreed against terms the client has not
seen, but it must **stay client-visible** (a client cannot reconfirm something
that vanished from their plan), so it never falls back to `proposed`/`draft`.

**Editing is refused, superseding is offered:**
`A "active" commitment cannot be edited — supersede it instead.` The same
discipline applies to scope (`A "completed" commitment's scope cannot
change.`) and cancellation.

## Cycles — the denominator is frozen, scope changes append

`POST …/cycles/:id/commit` is a separate, dedicated action (the generic status
PATCH answers `Use POST .../cycles/:id/commit to commit a cycle — it also
freezes the denominator.`). Committing, in one transaction, moves the cycle's
non-cancelled `backlog` items to `committed` and snapshots
`committedCount = <how many are attached right now>`.

Every later addition, removal or cancellation is an **append** to
`Cycle.scopeChanges` with a reason — `appendScopeChange` *"Never rewrites
`committedCount`"*. So "we delivered 8 of 10 committed" stays true whatever
happens to scope afterwards. Attaching work to an already-committed cycle
without `scopeChangeReason` is a 409, and so is removing it; a closed cycle
refuses the attachment outright (`Cannot attach work to a closed cycle`).

## Work items — verification is evidence, not a checkbox

`backlog | committed | active | review | blocked | verified | cancelled`, with
`review → verified` reachable **only** through `POST …/verify`, which records
a `Verification` row (source URL, run/artifact, observed date, reviewer,
decision). The bare PATCH answers `Use /submit, /verify or /block for this
transition`, so a status edit can never stand in for evidence.

A **rejection reopens** the item (`decision: "rejected"` → back to `active`):
an unverified deliverable never counts as done. `verified` is what
commitments and cycles count.

Deleting is only for scope that was never committed — *"once a cycle is
committed the item must be cancelled instead, so the frozen denominator's
history stays intact"* — and the refusal says so in those words.

Dependencies (`dependsOn`, "must finish before this one") are checked for
cycles with a DFS (409 `This dependency set creates a cycle`) and scoped to
the project; an unknown dependency id is a 404 naming it. Blocking records
**both** the reason and who it is waiting on (`blockedOn`), so a client-caused
blocker is distinguishable from an internal one.

## Pausing an engagement never stops in-flight work

`pausedAt`/`pauseReason` are set on pause and cleared on resume. The gate
(`assertEngagementNotPaused`) is applied to **future** committed work only —
cycle commit and the transitions into `active`:

> `Engagement is paused — future committed work cannot be started. In-flight
> work is unaffected; resume the engagement to continue.`

Work already in `active`/`review`/`blocked` stays exactly where it was. The
design comment is deliberate: *"it never cascades onto in-flight work, which
stays exactly where it was, explicitly, rather than vanishing."*

**Due dates resolve in the project's own timezone** —
the funding engagement's zone if there is one, else the project's. A bare
`YYYY-MM-DD` becomes 23:59:59.999 local to that zone (two-pass DST
correction), anything else is parsed as ISO, and an unparseable date is a 400
rather than a guess. That is why a program template can say "3 days in" and
mean the client's end of day, not the server's.

## The client-safe projections (§3.5, P01)

Every portal response is built by its own function — never a row spread with
fields deleted. The allowlists, and the reasons:

| DTO | Fields | Deliberately absent |
|---|---|---|
| `PortalEngagementDto` | `id, name, serviceTier, status, endsOn` | staffing, hours, timezone, operational notes, `startsOn` |
| `PortalCycleDto` | `id, name, status, startsOn, endsOn, goal, committedAt, committedCount, deliveredCount, currentCount, scopeChanges` | the committer, audit timestamps, project/engagement linkage |
| `PortalWorkItemDto` | `id, projectId, title, description, status, verifyState, dueOn, capabilityLabel, blockedOn, blockedReason` | internal notes, hours, user ids, provenance/dependency ids, `cycleId`, and category/discipline/priority (collapsed to `capabilityLabel`) |
| `PortalMilestoneDto` | `id, title, dueOn, status` | **`description`** — milestone descriptions may carry internal-only detail |
| `PortalScopeChangeDto` | `at, reason, requiresReconfirmation` | `by`/`added`/`removed` — actor and item ids are dropped, never resolved to titles |
| `PortalCommitmentDto` | `id, cycleId, title, reason, workstream, status, progress, accountableLead, targetDate, contentRef, nextClientAction, scopeChanges` | work-item ids; a real lead name only when `clientVisibleLead` is set, else `Your Cailyx team` |

Four rules do work that a field list alone would not show:

**`committedCount` is the frozen denominator, and the aggregates are not
narrowed to match.** `deliveredCount`/`currentCount` count **all** work items
in the cycle — including internal ones the client cannot see — because the
client is being told what the team delivered, not what the client can audit.
`committedCount` is read from the stored column, never recomputed, so the
ratio the client saw when they agreed stays the ratio they see later. The
smoke fixture asserts this explicitly (5 committed / 5 current / 2 delivered
*including* the hidden item).

**Actor stamps are stripped at the boundary, by the server.**
Work-item descriptions carry evidence entries stamped
`[Submitted <iso> by <actorId>]`. `toPortalText()` removes the attribution
while keeping the timestamp, the note and any URL — *"UI-only redaction cannot
protect the JSON response"* — and it applies at the portal mapper only, so
stored evidence and staff responses are unchanged.

**`blockedReason` is normalized to a category.** The raw reason is staff-only
operational text; the client sees one of `client-action` / `approval` /
`dependency` / `other`, derived from the already-coarse `blockedOn` owner tag —
*"rather than parsing the raw operational text (which must never reach the
client)"*.

**A client's evidence submission does not fabricate a verification.**
`POST …/work/:workItemId/evidence` appends to the description and returns the
portal DTO; it does not write a `Verification`, because a `Verification`
records the *reviewer's* observation, not the submitter's claim.

`GET …/plan` deliberately does **not** gain a `commitments` key: that shape is
frozen by `portal-plan.smoke.sh`'s recursive allowlist, so P11 added
`GET …/plan/commitments` as its own route instead of changing an
already-shipped contract. `listPortalCommitmentsForCycles` serves everything
that is not `draft`/`proposed` (unpublished internal drafting stays staff-only)
and its comment is a rule: *"Completed work is never dropped from this list to
make progress look better."*

## The needs-your-action queue (§5.6)

A server-side projection with **no task table of its own**. Every row is
derived live from its source, and `sourceType` + `sourceId` are the identity —
*"never a synthetic id minted just to show a card"*.

| Audience | Sources |
|---|---|
| Client (`GET …/portal/projects/:id/actions`) | `ApprovalRequest` assigned to this client with `reviewerType: 'client'` and status `pending`/`changes-requested`; `OnboardingRequest` `open`/`in-progress` |
| Staff (`GET …/projects/:id/actions`) | `ApprovalRequest` with `reviewerType: 'operator'` (the caller's own id, or unassigned — *"which any admin/delivery-lead may pick up"*); `WorkItem` in `review` (review-task); `WorkItem` `blocked` (delivery-blocker) |

Three exclusions do real work:

- **Audit findings never appear.** A `CheckResult` saying "17 pages have
  missing descriptions" is staff evidence, not a client action, unless someone
  explicitly asks the client for something. The smoke suite seeds a result
  carrying a marker string and asserts it appears in **neither** queue.
- **A blocker without a standing request is a staff finding**, not a client
  action — the client path to a blocker is its onboarding request.
- **Scope is the caller's own actor id** for staff: this is a worklist, not a
  portfolio view (admins see all).

An item disappears the moment its **source** is resolved — the smoke suite
proves it by resolving an onboarding request and asserting the card is gone
(not merely marked read). Each row carries its own `completionCondition`, e.g.
*"Resolves when the request is approved, changes-requested, cancelled or
invalidated by a newer revision."*, alongside `currentVersion` so a stale card
can be told from a fresh one, and `eligibleActorId` (the client id, the
assigned reviewer, or `null` when open to any permitted staff).

Ordering is server-side and stable — `overdue` → `blocking` → `ordinary`,
then soonest deadline (null deadline sorts last) — *"so pagination in 'View
all' is consistent"*. Only `delivery-blocker` is `blocking`. `GET
…/actions/overview` returns at most `limit` cards (default 3) **with the true
`total`**, so the count is never a lie about how much is behind it.

## Endpoints (50)

Roles: **operator** = any staff role; a client token gets 403
`Client accounts cannot access this resource` on every route that is not
`@ClientPortal()`. Where a row says *assignee*, the service enforces a
narrower rule than the route: 403 `Caller is neither assignee, reviewer nor
admin`.

### Engagements — `@Controller('clients/:clientId/engagements')`

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ engagements }` |
| GET | `/:id` | operator | one engagement (404 if it belongs to another client) |
| POST | `/` | admin, delivery-lead | created engagement |
| PATCH | `/:id` | admin, delivery-lead | updated engagement |
| PATCH | `/:id/status` | admin, delivery-lead | pause/resume; 409 on an illegal transition |

### Cycles — `@Controller('projects/:projectId/cycles')`

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ cycles }` (`scopeChanges` parsed to an array) |
| GET | `/:id` | operator | one cycle |
| GET | `/:id/detail` | operator | cycle + `workItems`, **including** `internalNotes` |
| POST | `/` | admin, delivery-lead | created cycle |
| PATCH | `/:id` | admin, delivery-lead | updated cycle (409 on a closed cycle) |
| PATCH | `/:id/status` | admin, delivery-lead | transition; 409 for `committed` (use `/commit`) |
| POST | `/:id/commit` | admin, delivery-lead | committed cycle — freezes the denominator |

### Commitments — `@Controller('projects/:projectId/commitments')` (P11)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ commitments }`; `?cycleId= &status=` |
| GET | `/:id` | operator | one commitment with derived progress |
| POST | `/` | admin, delivery-lead | created commitment |
| PATCH | `/:id` | admin, delivery-lead | edit (409 unless still editable — supersede instead) |
| PATCH | `/:id/status` | admin, delivery-lead | forward transition; 409 for `agreed`/`completed` (dedicated actions) |
| POST | `/:id/agree` | admin, delivery-lead | the one path to `agreed`; requires `confirm: true` |
| POST | `/:id/scope-change` | admin, delivery-lead | updated commitment; may knock `agreed` → `needs-attention` |
| POST | `/:id/outcome-metric` | admin, delivery-lead | records an observed metric value (409 if none configured) |
| POST | `/:id/complete` | admin, delivery-lead | 409 without verified ≥ target, or without an outcome metric for an outcome commitment |
| POST | `/:id/cancel` | admin, delivery-lead | cancelled commitment |

### Actions — `@Controller('projects/:projectId/actions')`

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `ActionQueueDto` — the staff-scoped queue |

### Work items — `@Controller('projects/:projectId/work-items')`

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ workItems }`; `?status= &cycleId= &assigneeId=` |
| GET | `/:id` | operator | work item + `acceptanceChecks` + `verifications` |
| POST | `/` | admin, delivery-lead | created item; 409 on a dependency cycle |
| PATCH | `/:id` | **assignee** | updated item; 403 otherwise |
| DELETE | `/:id` | admin, delivery-lead | `{ deleted: true }`; 409 once the cycle is committed |
| POST | `/:id/submit` | assignee | `active → review`; 409 otherwise |
| POST | `/:id/verify` | assignee | `{ workItem, verification }` — records the evidence |
| POST | `/:id/block` | assignee | records reason **and** who it waits on |
| POST | `/:id/unblock` | assignee | back to `active`, clears both fields |
| POST | `/:id/checks` | admin, delivery-lead | created acceptance check |
| PATCH | `/:id/checks/:checkId` | assignee | updated check |

### Milestones — `@Controller('projects/:projectId/milestones')`

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ milestones }` — includes `clientVisible: false` rows |
| POST | `/` | admin, delivery-lead | created milestone (`clientVisible` defaults true) |
| PATCH | `/:id` | admin, delivery-lead | updated; stamps `metAt` on `met` |
| DELETE | `/:id` | admin, delivery-lead | `{ deleted: true }` |

### Capacity — `@Controller('team/capacity')`

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ allocations, availableHours, allocatedHours, remainingHours }`; `?userId= &from= &to=` |
| GET | `/projects/:projectId` | operator | same shape; `?cycleId=` |
| POST | `/projects/:projectId` | admin, delivery-lead | created allocation |
| POST | `/org` | admin, delivery-lead | allocation with `projectId: null` — leave, holiday, overhead |
| PATCH | `/:id` | admin, delivery-lead | updated allocation |
| DELETE | `/:id` | admin, delivery-lead | `{ deleted: true }` |

### Client portal — `@ClientPortal()`, `@Controller('portal/projects/:projectId')`

`clientId` comes from the JWT, never from a request field, so a client cannot
ask for another client's plan by editing the URL; a project that is not theirs
is a 404 with no ids disclosed.

| Method | Path | Returns |
|---|---|---|
| GET | `/plan` | `PortalPlanDto` = `{ engagement, cycles, milestones, workItems }` |
| GET | `/plan/commitments` | `{ commitments }` — served separately so `/plan`'s shape never changes |
| GET | `/work` | `{ workItems }` — `clientVisible` rows only |
| POST | `/work/:workItemId/evidence` | the portal work DTO (never the staff serializer) |
| GET | `/actions` | client-scoped `ActionQueueDto` |
| GET | `/actions/overview` | the same, capped (`limit`, default 3) with the true `total` |

## Dependencies

- `PrismaService` — global via `DatabaseModule`; the module has **no
  `imports:` at all** and the service's only injected collaborator is Prisma.
- Global `JwtAuthGuard` + `RolesGuard` (default-deny for client tokens),
  `ThrottlerGuard`, and the global `ValidationPipe` with
  `forbidNonWhitelisted: true`.
- `lib/timezone.util.ts` — a local `Intl` implementation; `budgets`,
  `content-calendar`, `jobs` and `publishing` carry parallel copies of the
  same utility rather than importing this one.

## Environment variables

**None.** No `ConfigService`, no `process.env` anywhere in the module — it has
zero configuration surface.

## Consumers

- `organization` — `DeliveryPlanService.createWorkItem()` when applying a
  `cycle` program template, so every G06 rule (closed cycle refused, committed
  cycle demands a scope-change reason) applies to the copy instead of being
  re-implemented there. This is the only backend module that injects the
  service.
- The client portal and operator UI read the HTTP surface; `approvals` and
  `onboarding` feed the action queue **through their own routes** — the smoke
  suite creates an approval via `/projects/:id/approvals` and resolves an
  onboarding request via `PATCH /projects/:id/onboarding-requests/:id`, which
  is the proof that the queue is fed and drained by other modules rather than
  by writes inside this one.

## Plan alignment

| Requirement | Status | Notes |
|---|---|---|
| §6.1 — commitment / work item / content schedule stay distinct | ✅ | `Commitment` is its own resource with its own lifecycle; work items link to it; content scheduling stays in `content-calendar` |
| §6.3 — extend, do not build a second plan engine | ✅ | Reuses Engagement/Cycle/WorkItem ownership; one new model, no parallel plan store |
| §6.3 — "agreed" requires recorded confirmation, not an operator save | ✅ | The status PATCH refuses `agreed`; `POST …/agree` requires `confirm: true` |
| §6.3 — scope change records previous/new target+date, reason, actor, reconfirmation | ✅ | `recordCommitmentScopeChange` + `PortalCommitmentScopeChangeDto` (actor id stripped on the portal side) |
| §6.3 — client-safe history shows what changed and why, never internal actor ids | ✅ | `toPortalScopeChanges` drops `by`/`added`/`removed` entirely |
| §6.3 — completed work is not silently removed to look better | ✅ | `listPortalCommitmentsForCycles` keeps completed commitments |
| §6.2 — progress derived from linked verified deliverables, "3 of 10" not a percentage | ✅ | `toCommitmentProgress`; never stored |
| §6.2 — an outcome goal cannot complete on closed tasks alone | ✅ | 409 unless `outcomeMetricCurrent` is supplied |
| §6.2 — "Your Cailyx team" unless a name is intentionally shared | ✅ | `clientVisibleLead` gates the real name |
| §5.6 — server-side projection, derived from source, no duplicate task rows | ✅ | Two queues, four source types, identity = `sourceType` + `sourceId` |
| §5.6 — audit findings are not client actions | ✅ | No `CheckResult`/audit read exists in the module; asserted by `thirty-day-plan.smoke.sh` |
| §5.6 — ordering + true totals beyond the three cards | ✅ | `sortActionItems`; `/actions/overview` returns `total` alongside the capped `items` |
| §5.6 — an item leaves only when its source resolves | ✅ | Live derivation; asserted by resolving the source, not by a read |
| §3.5 — client-safe projections per audience | ✅ | Explicit allowlist functions (table above); recursive allowlist asserted by the smoke suite |
| §3.5 — publication is not implied by approval or discovery | ➖ | Not this module's surface: publishing lives in `publishing`, account discovery in `digital-presence` |
| `design_plan.md` G06 — cycles, work items, verification, milestones, capacity | ✅ | Plus the pause policy, dependency-cycle check and timezone rule |
| §6.4/§6.5 — the one content calendar | ➖ | Another module (`content-calendar`); this README names the boundary rather than implying coverage |

## What was verified, and what was not

Two suites, both run with `/opt/homebrew/bin/bash` and the default
`API=http://localhost:3002/api`, both seeding through Prisma and driving the
real HTTP surface:

**`backend/smoke/portal-plan.smoke.sh` (318 lines, 17 assertions)** — the P01
exit gate. Its premise is a **recursive JSON key allowlist** over every client
response: *"a future Prisma column leaking through a spread must fail even
when its value is null."* It asserts the exact field sets for work items,
scope changes, cycles, engagements and milestones (quoted in the table above);
that no operator or client user id appears anywhere, including inside
description/evidence stamps; that no cuid-shaped value appears under
`actor|actorId|userId|assigneeId|assignedToId|reviewerId|createdBy|committedBy|by`;
that `by`/`added`/`removed` are absent from cycle scope history; and the
aggregate counts `committedCount=5, currentCount=5, deliveredCount=2`
**including hidden work**, with one client-visible milestone.

**`backend/smoke/thirty-day-plan.smoke.sh` (278 lines, 30 assertions)** — the
P11 exit gate, driven with staff **and two distinct client accounts**. It
asserts the commitment lifecycle (agreement requires `confirm: true`; the bare
status PATCH cannot reach `agreed` or `completed`; an outcome commitment
cannot be completed without its own metric; progress is derived from verified
work items), the action queue (a client's own items, a staff member's own
items, `limit=1` returning 1 item with `total` = 2, cross-client access a 404
with nothing disclosed), that a seeded audit finding appears in neither queue,
and that resolving an onboarding request's source — not opening the card —
removes it from the queue.

**Not re-run during documentation.** Both suites were read, not executed,
while this README was written: other agents were mid-flight on shared source
and the dev database, so a failure could not have been attributed to this
module. Everything above is a claim about what the scripts assert, not a
statement that they pass today.
