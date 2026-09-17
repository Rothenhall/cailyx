# Content Calendar Module

> **Status:** Built
> **Phase:** P10 — `platform_improvement_plan.md` §6.4–§6.7 (one content
> calendar, intention vs execution, the bounded read, DST and idempotency)
> **Spec:** §6.1 (three concepts that must stay distinct), §6.4 (the product
> rule), §6.5 (screen behaviour), §6.6 (intention ≠ execution), §6.7 (API and
> reliability), §20.3 (redirect convention)

## Purpose

One content calendar, one entry contract, one source of scheduling truth
(§6.4). It answers: **what content is planned, for when, on which channel, and
what has actually happened to it?**

It is not a general business calendar. §6.4 excludes audit runs, crawler
checks, report releases, employee leave, generic work deadlines, approvals with
no publication plan, and monitoring jobs. Those keep their own operational
schedules — task due dates live on **Team work**, audit/cadence schedules on
**Monitoring**. They were **removed from this calendar, not deleted**: the
`WorkItem.dueAt` and cadence columns they come from are untouched.

## The three concepts (§6.1) — do not merge them

| Concept | Where it lives | What it means |
|---|---|---|
| Plan commitment | `Commitment` (delivery-plan) | A promise made to a client in a plan period |
| Work item | `WorkItem` | A unit of delivery work with an owner and a status |
| Content schedule | `ContentSchedule` (this module) | A **placement**: a date/timezone/channel a content piece is *intended* for |

`ContentSchedule.commitmentId` is a loose string reference, deliberately not a
foreign key. §6.7 requires that updating a plan date never silently reschedules
content and that updating a content schedule never silently changes a
commitment's target. Nothing propagates in either direction, so nothing can
cascade — and `Commitment.contentRef` works the same way.

## Intention vs execution (§6.6)

```text
Plan commitment
  → content piece (GrowthAsset) / brief family (ContentBrief)
    → planned placement (ContentSchedule: date, timezone, channel, mode)
      → publication attempt(s) (Publication rows, for an approved revision)
```

A placement exists **before** any approval — that is the point of §6.6 — so the
calendar can show a planned date while the piece is still `awaiting-approval`.
`Publication.scheduleId` is the **child** side of the link. The read merges a
placement with its live publication into exactly one event whose identity is
the stable `scheduleId`; N attempts are N child rows and still one event.

### Only source facts are stored

`ContentSchedule.status` holds `planned` or `cancelled` and nothing else. The
other seven states are **derived on every read** from facts that change without
anyone touching the placement (the publication's status, the destination's
connection state, the project's pause state, the approval at the latest
revision, the clock). A stored derived state would be a copy that goes stale
silently. The nine states (§6.6): `planned`, `awaiting-approval`, `ready`,
`scheduled`, `held`, `publishing`, `published`, `failed`, `cancelled`.

### Delivery and verification are separate

`CalendarEvent.verification` is its own object with its own state
(`not-applicable` / `pending` / `verified` / `failed`), so **"Published; live
check pending"** is expressible and is collapsed into neither "published" nor
an error.

### Past due is never read as published

A past planned instant means the date passed, not that anything was sent. The
event carries `pastDue`, the literal label **"Not published yet"** and a
`pastDueReason` naming the actual source fact: `failure`, `approval-hold`,
`disconnected-account`, `manual-publishing`, `unsupported-channel`,
`not-linked`, `dispatch-pending`.

### Channels that cannot deliver (§6.6)

Email, paid ads and organic social have no adapter in this build
(`PLANNING_ONLY_CHANNELS`). A placement on one is planning/manual only, is
labelled "delivered by a person", and offers **no** Send/Launch action anywhere.
An `automated` placement on such a channel is refused with
`channel-not-automatable` rather than downgraded silently. An ad creative
placement grants nothing: no budget change, no campaign launch. Planning-only
channels are listed in a documented `reason` each.

## Data model

`ContentSchedule` (`backend/prisma/schema.prisma`, migration
`20260917102106_p10_content_schedule`):

| Field | Why |
|---|---|
| `projectId`, `assetId` | The piece this placement is for. `assetId` is required — an entry with no content record behind it is an operational task §6.4 excludes |
| `briefId` | `ContentBrief.id` when the piece came from a brief family |
| `commitmentId` | Loose reference to the plan commitment it serves (see above) |
| `contentType` | Stored, not re-derived: the piece's type can be revised later, and the placement records what was planned |
| `channel`, `deliveryMode`, `destinationId` | Where and how it is intended to go |
| `plannedForUtc` | **The** scheduling truth. All three scopes read this one column |
| `plannedLocalDate`, `plannedLocalTime`, `timezone` | The intended wall clock and IANA zone, stored beside the instant so a timezone-database update cannot silently rewrite what a human chose |
| `dstDisambiguation` | `earlier` / `later` — the choice made for a repeated local time |
| `status`, `cancelledAt`, `cancelReason` | `planned` / `cancelled` only; cancellation keeps the row |
| `ownerId` | Staff owner (delivery lead), for the §6.5 owner filter |
| `version` | Optimistic concurrency |
| `idempotencyKey` | `@@unique([projectId, idempotencyKey])` — a retried create returns the row it already made |

Indexes: `(projectId, plannedForUtc)`, `(projectId, status)`, `assetId`,
`plannedForUtc`, `ownerId`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects/:projectId/content-calendar` | Project scope |
| GET | `/api/content-calendar` | Portfolio scope — the permitted project set comes from the caller's own access rules, never from a parameter |
| GET | `/api/portal/projects/:projectId/content-calendar` | Client scope (read-only) |
| POST | `/api/projects/:projectId/content-schedules` | Plan a placement |
| PATCH | `/api/projects/:projectId/content-schedules/:id` | Move / re-channel a placement |
| POST | `/api/projects/:projectId/content-schedules/:id/cancel` | Cancel (a state change, never a delete) |
| POST | `/api/projects/:projectId/content-schedules/:id/publication` | Link the placement to an approved revision through publishing's gates |

Route paths are `content-calendar` / `content-schedules`, **not** `/calendar`:
`/calendar` is the name the retired screens used, and §20.3 keeps those paths
redirecting rather than reassigning them.

Roles: planning and moving require `admin`, `delivery-lead` or `content` — a
placement is an intention and grants no authority. Linking a publication
requires `admin` or `delivery-lead`, identical to publishing's own
`POST /publications`, so the calendar is never the cheaper route to publishing.
The portal controller has **no** write routes at all.

### The read is bounded, and says when it is truncated (§6.7)

Query: `from`, `to`, `timezone`, `type`, `channel`, `state`, `ownerId`
(staff only), `limit` (default 200, max 500), `unscheduledLimit` (default 50,
max 200), `cursor`.

The response states completeness explicitly rather than implying it:
`totalInWindow`, `totalIsExact`, and a `page` of
`{ items, limit, returned, hasMore, nextCursor, truncated }`. A month with more
than 200 entries reports `truncated: true`, `hasMore: true` and an exact
`totalInWindow`; following the cursor yields every remaining event. Past the
window scan cap (`MAX_WINDOW_SCAN`, 5000) a derived-state filter still answers
but sets `totalIsExact: false` — a partial count is never presented as a total.
Windows are capped at `MAX_WINDOW_DAYS` (366).

`state` filtering is exact. `cancelled` is the one state that is also a stored
column, so it widens the SQL to read cancelled rows *and* filters to them; a
request for cancelled placements returns cancelled placements, not the month
with them in it.

### Writes: concurrency, idempotency, cancellation

- **Optimistic concurrency.** `PATCH` and cancel take the `version` the caller
  read. A stale version is refused with `409 version-conflict` and the refusal
  names `currentVersion` so the caller can reload rather than overwrite.
- **Idempotency.** `idempotencyKey` is unique per project; a retried create
  returns the same placement with its version unchanged.
- **Cancellation preserves history.** The row stays, `status` becomes
  `cancelled`, `cancelledAt`/`cancelReason` are recorded, and the placement
  leaves the default read but is still returned under `state=cancelled` — with
  its publication history intact. Cancelling never deletes the content and
  never retracts an item that was already published.
- **Approval gates.** Linking reuses publishing's own gates and rechecks them at
  dispatch: no approval at the **exact** revision is `409 no-approved-revision`,
  an unusable destination is `409 destination-not-connected`, a manual-only
  channel is `400 manual-delivery-only`. A link that succeeds creates a
  `Publication` queued at the placement's instant.

### Timezones and DST (§6.7)

Both are stored: the UTC instant and the intended local date/time plus IANA
zone. `lib/timezone.util.ts` resolves an intended local time and refuses the two
cases that cannot be resolved honestly:

- **Nonexistent** (inside a spring-forward gap) → `400 time-nonexistent` with
  `nextValidLocal`, rather than silently shifting the user's time.
- **Ambiguous** (a repeated hour at fall-back) → `400 time-ambiguous` with both
  `candidates` (`earlier` / `later`, each with its UTC instant). The user
  chooses; the choice is stored in `dstDisambiguation`. A caller that passes
  `dstDisambiguation` up front is accepted directly.
- Unknown zone or malformed time → `400 invalid-timezone` / `invalid-time`.

**Moving an intention never moves a queued publication.** `PATCH` writes only
the placement; the child `Publication.scheduledFor` is publishing's to change.
The event reports `intentionAndExecutionDiffer: true` when the two instants
disagree, so the divergence is visible instead of silent.

## Client visibility (§6.5)

A client read is filtered **in the query**, not in the rendered rows:

- Only pieces with an explicitly shared revision (`ContentRevision.clientVisible`)
  are readable at all; with no shared pieces the read returns an empty result
  without touching the rest of the pipeline.
- Because the filter is on the query, `totalInWindow`, `unscheduled.total`
  and `page.*` **counts** cannot include an unshared internal draft either —
  a title must not leak through a count any more than through an event.
- Staff-only fields (`destinationLabel`, `ownerId`/`ownerLabel`, `cancelReason`,
  raw provider errors) are never written into a client payload, rather than
  being sent and hidden by the interface. An `ownerId` filter from a client is
  dropped, not honoured.
- A client read agrees with the staff read on the instant of every event.

## Screen behaviour (§6.5)

One React implementation: `web/src/components/patterns/ContentCalendar.tsx`,
used by the project calendar, the portfolio calendar and the client calendar.
Month is the desktop default with Week and Agenda available; mobile defaults to
Agenda. Filters are project, content type, channel, owner (staff), state and
timezone; the date range is server-filtered. An event title is the content
title plus type, channel, time and a plain-language state — never a run ID or
an internal source type. Clicking an event opens the content detail at that
placement (`?scheduleId=…`), never a calendar-local editor. "View live content"
appears only when the server sent a known-safe published URL (http/https with a
host and no credentials). Unscheduled pieces are listed separately and are
never given midnight or arbitrary dates. Rescheduling is a form with an impact
explanation.

The same component's `ContentCalendarPreview` is the small preview §6.4 puts on
an overview — same endpoint, same event contract, no filters and no write
action, and a footer that states the window's total whenever it shows fewer.

## Duplicate destinations, and what happened to them

| Old destination | Outcome |
|---|---|
| `/projects/:id/content/calendar` | A readiness table that was never a calendar. Now **redirects** to `/projects/:id/calendar` (§20.3). Its asset library and approval state live on the content library; publish destinations on Connections |
| `/ops/calendar` nav entry | Renamed to **Content calendar** (§3.4) and rebuilt as the portfolio scope of the same calendar — it previously listed work-item due dates and released reports read from endpoints with no date range at all |
| Work-item due dates, cadence/audit schedules | Removed from this calendar; they remain on Team work and Monitoring |

## Testing

`backend/smoke/content-calendar.smoke.sh` — seeded through Prisma, driven
through the HTTP API, with a cleanup trap. It proves the three gates §6.4–§6.7
exist for: a month complete beyond 200 entries (truncation reported, window
total exact, the cursor reaches every event exactly once), the approval gates
(a planned placement visible as `awaiting-approval` before any approval exists,
dispatch refused without an exact-revision approval or a connected
destination), and DST (a nonexistent local time rejected, a repeated one
disambiguated, and the project, portfolio and client views agreeing on the same
instant) — plus cancellation preserving history, past-due reading "Not published
yet", a move not moving the queued publication, and a client read leaking no
unshared draft in events, counts or titles.
