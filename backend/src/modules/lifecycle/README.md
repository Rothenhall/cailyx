# `lifecycle` — G17: Export, retention and offboarding policy

Export request/status/download, retention policy administration, and an
offboarding workflow that is previewed before it executes.

Contract source: `design_plan.md` G17 (line 1697). Screens OP05/PJ02/OP21/CP15.

## The six non-negotiables, and where each is implemented

| # | Requirement | Where |
|---|---|---|
| 1 | **Preview before execute.** The preview returns the exact resources affected by type and count. No broad accidental cascade. `execute` requires a prior preview and an explicit confirmation. | `offboarding.service.ts` → `preview` stores `{ resourceType: count }` plus a reserved `__policy` block recording the action chosen for each type. `execute` requires `previewRunId`, re-counts every type, and **refuses (409) if any count moved**; it also requires `confirm: true` *and* `confirmationPhrase` equal to the client's exact name, and refuses a preview older than 30 minutes. See "Three guards" below. |
| 2 | **Downloads are scoped and expiring.** Enforce `expiresAt` and record `downloadedAt`. The response discloses omitted sensitive fields. | `lifecycle.service.ts` → `download`. Scope is re-resolved against the URL; a mismatched scope 404s. Past `expiresAt` the row flips to `expired`, the payload is unlinked and the request gets 410. `downloadedAt` is stamped on success. `omittedNote` is returned in the download envelope and repeated on every status read. |
| 3 | **Define archive / pause / delete for artifacts, credentials, scheduled work, messages and audit history — in code and in this README.** | `lifecycle.policy.ts` is the executable table (`ACTION_MEANINGS`, `RESOURCE_POLICIES`); the table below is the same content for a reader. `archive` is assigned **only** where a row has a real non-destructive state. |
| 4 | **`ReportShareLink` rows survive unless deliberately revoked**, handled per `shareLinkPolicy` and reported. | `offboarding.service.ts` → the tail of `apply`. `revoke` stamps `revokedAt` **and** sets the reports' `visibility` back to `private`, so a revoked link actually stops resolving rather than 404-ing by accident. `keep` leaves both alone and the preview says the links stay live and that this is the one effect a client cannot undo. The applied policy is stored on the run and returned. |
| 5 | **Audit history is retained under policy even when the resource is deleted.** | `activity-events` is fixed at `retain` with `overridable: false`; an override for it is **refused (400)**, not ignored. The run writes its own `ActivityEvent` *before* it removes anything, and a second one on completion or failure. `RetentionService` likewise refuses `delete` for `activity` and permits only `anonymize`. |
| 6 | **The existing hard project delete is not a complete offboarding; the persona/query-set/lead exports are narrower but still useful — do not break them.** | Nothing in this module changes those routes. This module adds a client-scoped workflow beside them; the narrower per-resource exports keep working untouched, and the wider bundle carries `query-sets`, `personas` and `leads` as *optional* sections. `leads` and `activity` are excluded from the default bundle. |

## What archive / pause / delete / retain mean

From `ACTION_MEANINGS`, verbatim — these are the sentences the preview renders:

- **Archive** — "The rows stay, and are marked so they are no longer active: the
  project leaves the active portfolio, the report is withdrawn, the brief is
  archived. Nothing is destroyed and the record remains queryable, so a
  historical report still renders."
- **Pause** — "Recurring work stops being scheduled. The configuration is kept,
  so the schedule can be resumed if the client returns. Nothing is deleted and
  no in-flight run is modified."
- **Delete** — "The rows are removed from their tables. Where a row has a
  soft-delete column, the delete is applied through it; otherwise the row is
  removed. The audit record of this offboarding is written before the rows go and
  is retained under policy."
- **Retain** — "Offboarding leaves these rows untouched. They are listed in the
  preview so their survival is a decision the operator can see, not an omission
  they have to notice."

### The policy table — `RESOURCE_POLICIES`, 38 resource types

**Artifacts**

| Resource type | Default | Overridable to | What actually happens |
|---|---|---|---|
| `client` | archive | retain | `Client.status` → `churned` |
| `projects` | archive | delete | `Project.status` → `archived` |
| `reports` | archive | delete | `Report.status` → `withdrawn`; `visibility` is governed by `shareLinkPolicy`, not here |
| `report-revisions` | retain | delete | frozen snapshots kept |
| `content-briefs` | archive | delete | `ContentBrief.status` → `archived` |
| `content-revisions` | retain | delete | kept |
| `work-items` | archive | retain, delete | `status` → `cancelled`, block cleared, assignee cleared |
| `cycles` | archive | retain, delete | `status` → `closed`, `closedAt` stamped |
| `milestones` | retain | delete | kept |
| `attachments` | delete | retain | `Attachment.deletedAt` stamped (soft) |
| `observations` | delete | retain | rows removed |
| `measurement-runs` | delete | retain | rows removed |
| `score-runs` | delete | retain | rows removed |
| `technical-audits` | retain | delete | kept |
| `seo-audits` | delete | retain | rows removed |
| `aeo-audits` | delete | retain | rows removed (stances and surface runs cascade) |
| `presence-discoveries` | retain | delete | kept |
| `authority-scans` | retain | delete | kept |
| `backlinks-summaries` | retain | delete | kept |
| `competitors` | retain | delete | kept |
| `query-sets` | retain | delete | kept |
| `personas` | retain | delete | kept |

**Credentials** — all `delete`, none overridable. Offboarding has exactly one
non-negotiable effect, and this is it.

| Resource type | What actually happens |
|---|---|
| `google-connections` | Connections owned by this client's own logins are deleted. **An operator-owned connection that merely serves this client through a delegation keeps its row** — deleting it would revoke access for every other client it serves; only the delegation is revoked. The preview says so and names the count. |
| `connection-delegations` | `revokedAt` stamped for this client's projects |
| `client-members` | `ClientMember` rows removed |
| `client-users` | `User` rows of `type: 'client'` for this client removed, with their refresh tokens and sessions |
| `auth-tokens` | Outstanding invite / reset tokens for those users removed |

**Scheduled work**

| Resource type | Default | Overridable to | What actually happens |
|---|---|---|---|
| `cadence-rules` | pause | — | `pausedAt` stamped, `enabled` false, `nextRunAt` cleared |
| `schedule-configs` | pause | — | `active` and `seoActive` false, next-run instants cleared |
| `engagements` | pause | archive | `status` → `paused`, `pausedAt`, `pauseReason: 'Client offboarding'` |

**Messages**

| Resource type | Default | Overridable to | What actually happens |
|---|---|---|---|
| `client-messages` | retain | delete | kept by default; `ClientMessage` has no archive state, so `archive` is not offered |
| `report-delivery-attempts` | retain | delete | kept; each row holds a recipient address |
| `message-read-cursors` | delete | — | removed with the client's users |

**Audit history**

| Resource type | Default | Overridable to | What actually happens |
|---|---|---|---|
| `activity-events` | retain | **not overridable** | never removed by offboarding; an override is refused |
| `job-runs` | retain | delete | kept (steps removed with their runs if deleted) |
| `verifications` | retain | delete | kept |
| `approvals` | retain | delete | kept (decisions removed with their requests if deleted) |
| `exports` | retain | delete | history kept; the files expire and are unlinked on their own schedule |

## Three guards that make "no broad accidental cascade" mechanical

1. **Count drift.** `execute` re-counts every resource type and compares against
   the stored preview. Any difference is a 409 naming each type as
   `planned -> current`. The audit trail is exempt from this comparison, because
   the workflow writes to it as part of running — see `DRIFT_EXEMPT` in
   `offboarding.service.ts` for why that exemption costs nothing.
2. **Frozen snapshots.** If the plan would delete rows a pinned
   `EvidenceManifest` names, `execute` refuses (409) and names each manifest.
   `acknowledgeFrozenSnapshots: true` is required to proceed. A manifest whose
   sources are gone cannot be resolved, and G13's contract is that old reports
   stay reproducible.
3. **Override validation.** An override for a non-overridable type, or an action
   the type does not permit, is **refused (400)** rather than ignored — silently
   dropping one would let an operator believe they had preserved something the
   executor then deleted.

Execution order is `EXECUTION_ORDER`: children before parents, so a project
delete never orphans rows a later step still needs to count. The preview notes
when a plan deletes a parent while retaining a child, since the retained rows
keep a project reference that will no longer resolve.

## Retention

Six resource types, each with a definition (`RETENTION_DEFINITIONS`): what it
covers, which timestamp the window is measured from, which actions are
permitted, and the documented defaults. A type with no policy row is returned
with `configured: false` and its defaults — `JobsController.cadences`'s
"a missing schedule is a state, not a missing row" discipline.

| Resource type | Default window | Permitted actions | Restriction |
|---|---|---|---|
| `observations` | 730 days | delete, anonymize | — |
| `reports` | none | archive, delete | anonymize not offered: nothing personal to anonymize |
| `messages` | 1095 days | delete, anonymize | — |
| `job-runs` | 365 days | delete | archive/anonymize not offered |
| `activity` | none | **anonymize only** | `delete` is refused: audit history is retained under policy |
| `attachments` | 365 days | delete (soft, via `deletedAt`) | — |

Rules enforced: a **disabled policy never acts** (`apply` → 409); a policy cannot
be **enabled with no window** (400) because an unset window is not an unlimited
one; `apply` requires `confirm: true`; counts are recomputed at run time rather
than taken from an earlier preview. Every policy comes with a `/preview` that is
always safe to call.

## File tree

```
lifecycle/
  lifecycle.module.ts          controllers + providers; imports ActivityModule
  lifecycle.types.ts           vocabularies, export sections, response shapes
  lifecycle.policy.ts          the archive/pause/delete policy table (executable)
  lifecycle.service.ts         LifecycleService — export request/status/download
  export-storage.service.ts    the scoped file an export payload lives in
  retention.service.ts         RetentionService — policy reads/updates/preview/run
  offboarding.service.ts       OffboardingService — preview/execute/status/cancel
  lifecycle.controller.ts      five controllers (project/client/retention/offboarding/portal)
  dto/
    export.dto.ts
    retention.dto.ts
    offboarding.dto.ts
```

## Endpoints (22)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/exports` | any operator with access | Project export requests |
| GET | `/api/projects/:projectId/exports/:id` | any operator with access | One request |
| POST | `/api/projects/:projectId/exports` | any operator with access | Request an export |
| GET | `/api/projects/:projectId/exports/:id/download` | any operator with access | Download (`?raw=true` for the file) |
| GET | `/api/clients/:clientId/exports` | any operator with access | Client export requests |
| GET | `/api/clients/:clientId/exports/:id` | any operator with access | One request |
| POST | `/api/clients/:clientId/exports` | admin, delivery-lead | Request a client-wide export |
| GET | `/api/clients/:clientId/exports/:id/download` | any operator with access | Download |
| GET | `/api/retention-policies` | **admin** | Every policy, configured or not |
| GET | `/api/retention-policies/:resourceType` | **admin** | One policy |
| PUT | `/api/retention-policies/:resourceType` | **admin** | Create or replace |
| GET | `/api/retention-policies/:resourceType/preview` | **admin** | Count what a run would affect |
| POST | `/api/retention-policies/:resourceType/run` | **admin** | Run it |
| GET | `/api/clients/:clientId/offboarding` | admin, delivery-lead | Runs, newest first |
| GET | `/api/clients/:clientId/offboarding/:id` | admin, delivery-lead | One run (re-counted while in preview) |
| POST | `/api/clients/:clientId/offboarding/preview` | admin, delivery-lead | The plan — read-only |
| POST | `/api/clients/:clientId/offboarding` | **admin** | Execute a preview |
| POST | `/api/clients/:clientId/offboarding/:id/cancel` | admin, delivery-lead | Abandon an unexecuted preview |
| GET | `/api/portal/exports` | `@ClientPortal()` | This client's exports |
| GET | `/api/portal/exports/:id` | `@ClientPortal()` | One of them |
| POST | `/api/portal/exports` | `@ClientPortal()` | Request one (`leads`/`activity` refused) |
| GET | `/api/portal/exports/:id/download` | `@ClientPortal()` | Download |

### Export sections

`project`, `reports`, `metrics`, `observations`, `audits`, `work`, `query-sets`,
`personas`, `content`, `competitors`, `presence`, `authority`, `backlinks`,
`messages`, `activity`, `attachments`, `leads`.

The default bundle is the first fifteen minus `activity` and `leads`. Both are
exportable but never included by default: `leads` is Cailyx's own sales pipeline
carrying personal contact data, and `activity` is the audit trail. Formats are
`json` (whole bundle) and `csv` (exactly one section — a bundle has no CSV
representation and this module does not invent an archive format it cannot
produce).

## Design decisions worth knowing

- **The export does not recompute.** It carries stored rows, so the numbers it
  contains are the numbers that were recorded. A live `/results` read is a
  different thing and says so on its own response.
- **`__policy` is the one reserved key in `OffboardingRun.planned`.** Every other
  key is `resourceType: count` exactly as the model documents. Storing the chosen
  actions is what lets `execute` carry out the plan that was *shown* rather than
  re-deriving one from defaults.
- **`ExportRequest.storageKey` is never published.** Callers get a computed
  `expired` and `downloadAvailable`; the key is a locator on this host and the
  read paths strip it.
- **Payload storage is the local filesystem** (`node:fs/promises`), rooted at
  `CAILYX_EXPORT_DIR` (default `os.tmpdir()/cailyx-exports`). Storage keys are
  validated as bare filenames and resolved under the root, so a stored value can
  never be used to read outside it. Nothing new is installed; a deployment that
  outgrows the directory points the env var at a mounted volume. If the payload
  is missing (cleared temp dir, different instance), the download returns 410
  with that reason rather than an empty body.
- **Audit writes go through `ActivityService`**, not direct inserts. G15 owns the
  table and its `record()` applies the redaction that keeps secrets out of the
  trail; a second implementation here would diverge.

## Dependencies

- `ActivityModule` (imported) — the audit trail writer.
- `PrismaService` — global (`DatabaseModule`).
- `ScopeValidationService` — global (`ScopeValidationModule`, activated in `AuthModule`).
- No new packages.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `CAILYX_EXPORT_DIR` | `os.tmpdir()/cailyx-exports` | Directory export payloads are written to and read from |

## What was verified

Run against a live server (`node dist/main`, port 3123) with the dev database,
using throwaway probe clients so the shared demo data was not disturbed:

- Export request → `ready` with a size; sections, `expiresAt` and `omittedNote`
  present; `storageKey` absent from the response.
- Download → 200 with the bundle; `downloadedAt` recorded (checked in the DB
  before and after). `?raw=true` → 200 with `Content-Type` and
  `Content-Disposition`. `csv` with two sections → 400.
- Expiry: `expiresAt` forced into the past → download 410, row flipped to
  `expired`, payload unlinked, list view showing `expired: true` /
  `downloadAvailable: false`.
- Cross-scope read of an export id from another project → 404.
- Retention: `activity` + `delete` → 400 with the reason; `activity` + `anonymize`
  → 200; preview counts and cutoff; run an **unconfigured** policy → 404; run a
  **configured but disabled** policy → 409; run without `confirm` → 400; run with
  `confirm` → 200 with `eligible`/`applied`/`ranAt`; enabling a policy with no
  window → 400.
- Offboarding preview: 38 resource types listed with counts and sentences, per-class
  totals, `totalsByAction`, the share-link decision spelled out, override
  validation (audit trail → 400, credential → 400, message → accepted and marked
  `overridden: true`).
- Offboarding execute: wrong confirmation phrase → 400; `confirm: false` → 400;
  **count drift on a real resource (`client-messages 0 -> 1`) → 409**, and the same
  drift reported on the status read; frozen-snapshot conflict → 409 naming the
  manifest, and 200 with `acknowledgeFrozenSnapshots: true`.
- A completed offboarding: `status: completed`, client `churned`, project
  `archived`, per-type `executed` counts, the audit trail still readable
  afterwards (including the run's own `started` and `deleted` events), and
  re-executing the same preview → 409.

## Not implemented / left as an explicit unavailable state

- **No background worker for export assembly.** Assembly runs inside the POST, so
  `queued`/`running` are transient and the response carries the final state. The
  row is created before assembly so a failure is durable and diagnosable; a
  future worker would flip `running` → `ready` asynchronously without changing
  the API.
- **`csv-bundle` is not offered.** The schema comment on `ExportRequest.format`
  mentions it; producing it needs a zip implementation and no dependency may be
  added, so `csv` is defined as exactly one section instead of emitting an
  archive nothing can open.
- **Attachment *file* contents are not exported** — only metadata. Nothing in this
  backend stores attachment bytes, so there is no file to hand over; the storage
  key is deliberately withheld.
- **A retention `apply` is per resource type**, not a single "run everything"
  sweep. A one-click sweep would be exactly the broad cascade the offboarding
  preview exists to prevent.
- **Nothing else outstanding on the client surface.** Verified with a real
  client login: `leads` and `activity` both refused (400), a normal bundle
  requested (201, `ready`), and that client's own export downloaded (200).
