# Reporting Module — generation, editorial lifecycle, client release and share policy

> **Status:** built and verified end-to-end on a live server (177/177 checks, see
> "Verified" below). The editorial lifecycle, share links and the delivery ledger
> are new in this pass (G05 / D11).
> **PRD:** FR-10.1 (web report), FR-10.3 (executive + detailed), FR-10.4 (branding),
> FR-10.5 (noindex) **+** design_plan G05, G10 (gate), G13 (frozen snapshot), G19/D10
> (two axes), D11 (`rubricVersion`/`scoreRunId`, corrected `assetsNote`).

## Purpose

Generates the branded AI Visibility Diagnostic — the actual product deliverable — and
now owns **when a client is allowed to see it**. The one promise this module exists to
enforce: *clients only ever see reports that were reviewed, approved and released.*

```
reporting/
  reporting.module.ts            module wiring (scoring, strategy, findings, backlinks,
                                 results/G13, approvals/G10 gate, delivery/Plunk)
  reporting.service.ts           generation, snapshot freezing, live + released reads,
                                 HTML render (executive/detailed), branding
  report-lifecycle.service.ts    G05: review/approve/publish/withdraw, share links,
                                 delivery attempts, the pre-G05 migration, client reads
  reporting.controller.ts        3 controllers: project routes, the admin migration,
                                 the token-only public render
  reporting.types.ts             ReportData / ReportRevisionSnapshot / lifecycle DTOs
  dto/reporting.dto.ts           validated inputs
  templates/report-html.hbs      branded HTML (executive + detailed, noindex)
  API.md                         per-endpoint reference
  README.md                      this file
```

## The two axes (the thing that goes wrong)

`Report.visibility` and `Report.status` are **different axes** and are never derived from
each other (§6.4, G19/D10):

| Axis | Column | Question it answers | Changed by |
|---|---|---|---|
| Public sharing | `Report.visibility` | may anyone with the URL read the HTML? | `PUT :slug/visibility` (admin/delivery-lead) |
| Editorial | `Report.status` + `Report.releasedRevision` | has this been reviewed and released to its client? | `review`/`approve`/`publish`/`withdraw` |

Consequences, implemented rather than documented:

- Revoking a public link (`DELETE :slug/share-links/:id`, or `visibility: private`) never
  changes `status` or `releasedRevision`.
- Releasing never mints a public link and never turns `visibility` public.
- `visibility` is **not** a QA state. An unreleased report is invisible to its client
  even if someone marks it public — it is a *draft*, and §6.4 excludes unpublished drafts
  from the public projection.

## State machine (§8.3, as implemented)

```
(no revision)
   │ POST :slug/review            snapshot locked, revision 1 created
   ▼
in-review ──POST :slug/approve {changes-requested}──▶ draft ──review──▶ in-review
   │                                                                    (same revision, re-locked)
   │ POST :slug/approve {approved}
   ▼
approved ──POST :slug/publish──▶ released ──POST :slug/withdraw──▶ withdrawn
                                    │
                                    └── review + publish of a NEW revision ──▶
                                        the new revision is released and the old one
                                        becomes superseded (snapshot untouched)
```

`Report.status` is the **summary** state and is deliberately sticky once released: while
a newer revision is being prepared, the report stays `released` and `releasedRevision`
keeps pointing at the version the client is still reading. The in-progress revision's own
state lives on `ReportRevision.status` and is surfaced as
`ReportLifecycleDto.inFlightRevision`. Blanking the report back to `draft` there would
take a live report away from its client — the exact failure G05 exists to prevent.

## The five non-negotiables, and where each one lives

| # | Rule | Implemented by |
|---|---|---|
| 1 | Public sharing ⇄ client release are independent | separate columns, separate endpoints, no cross-writes (`resolveShareToken` reads `status`, never writes `visibility`) |
| 2 | A released revision is frozen | `snapshot` written once in `review()`; `publish()`/`withdraw()`/later revisions never rewrite it. Superseding sets `status` + `supersededBy` only. |
| 3 | A draft can never appear in the portal | `listReleasedForClient`/`getReleasedForClient` filter `status="released"` **and** `releasedRevision != null`; anything else is a 404 |
| 4 | A failed email does not roll back a release | `ReportDeliveryAttempt` is a separate table written by a separate action; `deliver()` never touches `status`. `sent` = provider accepted, never "read" |
| 5 | Share tokens are stored as sha256 | `ReportShareLink.tokenHash` (unique); the raw token is returned once and never persisted; revoked/expired links 404 |

**The release gate.** `publish()` calls `ApprovalsService.assertReadyToPublish('report',
reportId, revision, revisionId, 'report-revision')` **before** writing anything, and
propagates its refusal verbatim: an unresolved `ApprovalRequest` bound to this exact
revision, or a `RevisionClaimLink` to a blocked `Claim`, refuses the release. `review()`
calls `invalidateStaleRequests` so consent for revision N never carries to N+1.
`GET :slug/lifecycle` runs the same gate read-only and reports `publishBlocked`, so a
screen can say why release is unavailable before anyone presses the button — a
disclosure, never a permission (the gate re-runs inside `publish`).

## Endpoints

Operator routes are `@Roles`-restricted and every one validates project access
(`ScopeValidationService`) and resolves the slug **within** the URL's project.

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/api/projects/:projectId/reports` | any assigned operator | Generate (3/min). Result is an **unreleased draft**. |
| GET | `/api/projects/:projectId/reports` | any assigned operator | Summaries with both axes (`visibility`, `status`, `releasedRevision`) |
| GET | `/api/projects/:projectId/reports/:slug/view` | any assigned operator | Live row JSON (drafts included) |
| GET | `/api/projects/:projectId/reports/:slug/render` | `@Public` (or operator bearer) | HTML; renders the **released revision** when there is one |
| PUT | `/api/projects/:projectId/reports/:slug/visibility` | admin, delivery-lead | Public-link flag (not the editorial state) |
| GET | `/api/projects/:projectId/reports/:slug/lifecycle` | any assigned operator | `ReportLifecycleDto`: both axes, revisions, in-flight revision, gate verdict |
| GET | `/api/projects/:projectId/reports/:slug/revisions` | any assigned operator | Revision history (metadata) |
| GET | `/api/projects/:projectId/reports/:slug/revisions/:revision` | any assigned operator | One revision **with its frozen snapshot** |
| POST | `/api/projects/:projectId/reports/:slug/review` | admin, delivery-lead, content, technical, outreach | Lock the snapshot for review (creates N+1, or re-locks the draft) |
| POST | `/api/projects/:projectId/reports/:slug/approve` | admin, delivery-lead | `approved` \| `changes-requested` |
| POST | `/api/projects/:projectId/reports/:slug/publish` | admin, delivery-lead | **Release** (G10 gate first) |
| POST | `/api/projects/:projectId/reports/:slug/withdraw` | admin, delivery-lead | Pull it back, reason required |
| GET | `/api/projects/:projectId/reports/:slug/share-links` | any assigned operator | Links; never a token |
| POST | `/api/projects/:projectId/reports/:slug/share-links` | admin, delivery-lead | Mint an expiring link (released reports only) — token returned **once** |
| DELETE | `/api/projects/:projectId/reports/:slug/share-links/:linkId` | admin, delivery-lead | Revoke (idempotent) |
| GET | `/api/projects/:projectId/reports/:slug/delivery-attempts` | any assigned operator | The send ledger |
| POST | `/api/projects/:projectId/reports/:slug/delivery-attempts` | admin, delivery-lead, sales | Record (and for `email`, attempt) a delivery |
| GET | `/api/reports/shared/:token` | `@Public` | Token-only HTML of the **current release** |
| POST | `/api/reports/classify-legacy` | admin | The pre-G05 migration (idempotent) |
| GET | `/api/reports/classify-legacy/preview` | admin | Dry run of the same |

Client surface (unchanged paths, now release-gated — see "client reads" below):

| Method | Path | Returns |
|---|---|---|
| GET | `/api/portal/reports` | Only released reports, each with `revision` + `releasedAt` |
| GET | `/api/portal/reports/:slug` | The frozen snapshot (`ReportData` shape + `revision`/`snapshotAt`), 404 unless released and owned |

## Client reads — what "released" means on the wire

`ClientPortalService` delegates to this module's `ReportLifecycleService` (the portal
service no longer reads the live `Report` row at all):

- `listReleasedForClient(clientId, projectId?)` — filters `status="released"` **and**
  `releasedRevision != null`, and reads each title/score from the *frozen revision*, so a
  released report's summary cannot drift when the row is edited.
- `getReleasedForClient(clientId, slug)` — ownership first (a foreign report is the same
  404 as a missing one), then release. Draft, in-review, approved-but-unreleased and
  withdrawn reports are all 404: the portal cannot be used to discover that a draft
  exists.
- `ClientPortalService.listProjects` now reports `latestScore`/`lastAuditAt` from the
  latest **released** report — an unreleased draft no longer leaks its score into the
  project header.

> **Lane note.** The delegation required three small edits outside this directory
> (`client-portal.service.ts`: two method bodies + one query filter, and one added
> field on `PortalReportSummaryDto`). They are the client-facing reads G05 requires and
> no other agent owns that module; everything else in this pass is confined to
> `reporting/**`. `reporting.getBySlug`'s public signature changed
> (`getBySlug(slug, options)`) and that was its only remaining caller.

## Migration policy for pre-G05 reports

Before G05 every `Report` was `status="draft"` **and readable by its client's portal**
(§5.10 step 4). Two policies were available: hide them all until someone reviews them, or
keep them visible and say so.

**Chosen: keep them visible, and label them** — `POST /api/reports/classify-legacy`.

Each unclassified report becomes revision 1 with `status="released"`, a snapshot of its
existing content, `publishedAt` = the row's own `createdAt` (when the client could already
read it), `decision="grandfathered"`, and a `decisionNote` stating plainly that **no
internal review happened**. `reviewedBy`/`reviewedAt` stay `null`, because claiming a
review that never took place would be exactly the fabricated-provenance failure this
codebase refuses everywhere else.

Why not hide them:

- Hiding deletes content a client may already have read, been emailed, or discussed with
  their delivery lead. The app cannot know which — and silently pulling a delivered report
  back is the unannounced change G05 exists to prevent.
- It would add no safety: the report was *already* in the portal. Keeping it visible
  preserves exactly the exposure that existed and freezes it, so the next change to it
  has to go through review → approve → release as revision 2.

The migration is admin-only, dry-runnable (`GET .../preview`), and idempotent (any report
that already has a revision row is skipped). Applied to the dev database on 2026-09-16:
**24 reports classified, 0 skipped**; a re-run classifies 0.

**Behaviour changes to be aware of:**

- A report generated *from now on* — including the Day-1 report `clients.service`
  produces during onboarding — is a draft and reaches the client only after review,
  approval and release. That is the intended G05 semantic, and it is a change from
  "generated ⇒ immediately visible".
- `PUT :slug/visibility` is now `admin`/`delivery-lead` only (G03: report visibility had
  no specialist-role enforcement). `content`/`technical`/`outreach`/`sales` operators can
  still read everything they are assigned; they can no longer flip the public-link flag.
- Every operator route in this module now asserts project access, so a non-admin operator
  needs a live `OperatorAssignment` covering the project — the G03 policy the other
  modules already apply.

## D11 — provenance on the report, and the `assetsNote` repair

- **`rubricVersion` / `scoreRunId`** are now persisted and exposed. The report pins them
  through its G13 evidence manifest: `generateReport` calls
  `evidence.create(..., { scoreRunId: scoreResult.id })`, which stores the run id and its
  rubric version on `EvidenceManifest` (`scoreRunId`, `rubricVersion` — columns that exist
  precisely for this). Reads resolve them through `Report.manifestId`; `ReportData` and
  `ReportRevisionSnapshot` expose both. **No schema change was needed or made.**
  They are `null` when the report has no pinned manifest — reported as *unrecorded*, never
  inferred from "the project's latest ScoreRun", which would be a guess about provenance.
- **`assetsNote`** said stage 11 "has no module yet". That was true when written and is
  false now: `growth-execution` exists and holds real assets. The generated text now
  states what is actually true — how many assets exist by status, read (never written) at
  generation time — and says the briefs/bodies are *not copied into this snapshot*
  (that section is G09/G13). "Not included in this snapshot" and "nothing exists" are
  different disclosures; the old sentence said the second when the first was meant.
- Reports generated **before** 2026-09-16 still carry the old sentence in their stored
  snapshot. Because released snapshots are frozen, the repair happens **on read** and is
  flagged with `assetsNoteCorrected: true` — the stored bytes are untouched, and a reader
  is never shown edited history as if it were the original.

## Delivery attempts

`POST :slug/delivery-attempts` writes the row as `queued` **before** calling the provider
and then updates it to `sent`/`failed`, so an attempt that dies mid-flight is visible as
"attempted, outcome unknown" rather than vanishing. `email` reuses the existing Plunk
adapter (`DeliveryService.sendReport` — no second email implementation). `link-share` and
`manual` record that the operator sent it themselves; for those channels `sent` is the
operator's record, not a provider receipt — stated in the README and the schema comment,
never presented as delivery proof.

A failed send is a **200** with `status: "failed"` and the recorded error: the ledger row
is the resource that was created, and the report's release state is untouched by
construction. Only a **released** report can be delivered at all (409 otherwise): sending
a client a link their own portal will not open would be a lie about release.

## Sharing: tokens, not visibility

A share link is a capability on the *report*, not a pinned copy of one revision:

- Created only for a released report (`409` otherwise) — §6.4 excludes unpublished drafts
  from the public projection.
- `tokenHash` = sha256 of a 43-character base64url token (`randomBytes(32)`). The raw token
  is returned exactly once, on creation; the list endpoint never returns one.
- `GET /api/reports/shared/:token` serves the report's **currently released revision**,
  always with `noindex`. Unknown, revoked, expired, or a report with nothing released
  (withdrawn included) all answer the same 404, so the response does not disclose which.
- Revocation is immediate and idempotent and does not touch release state.
- `ReportShareLink.revisionId` records which revision was current at creation (audit);
  resolution follows the current release so a superseded version is never served under a
  live link.

`visibility` remains the older "anyone with the URL" flag and is unchanged in behaviour
except that the HTML it serves now comes from the frozen release when one exists.

## Endpoint → screen

| Screen | Reads |
|---|---|
| RP01/RP02 (library, create) | `GET/POST /reports` |
| RP03 (report detail) | `GET :slug/view`, `GET :slug/lifecycle` |
| RP04 (review & release) | `GET :slug/lifecycle`, `revisions/:n`, `review`, `approve`, `publish`, `withdraw`, `PUT :slug/visibility`, `share-links` |
| RP05 (delivery) | `GET/POST :slug/delivery-attempts`, `GET :slug/render` |
| CP11 (client report list) | `GET /portal/reports` |
| CP12 (client report) | `GET /portal/reports/:slug`, `GET /reports/shared/:token` |

## Dependencies

| Dependency | Why |
|---|---|
| `ScoringModule` | rubric score + the ScoreRun D11 pins |
| `StrategyModule`, `FindingsModule`, `BacklinksModule`, `DigitalPresenceModule`, `CompetitorsModule` | snapshot sections — **all read-only**; generation never triggers a paid run |
| `ResultsModule` (G13) | `PeriodService` (exact window) + `EvidenceService` (the manifest) |
| `ApprovalsModule` (G10) | `assertReadyToPublish`, `invalidateStaleRequests` |
| `DeliveryModule` | the existing Plunk adapter for `email` attempts |
| `AuthModule` | `isValidBearer` for the public render's operator preview |
| `handlebars` | HTML template |

`PrismaService` and `ScopeValidationService` are global — injected, never imported.
Env vars: `REPORT_BRAND_NAME`, `REPORT_BRAND_TAGLINE` (branding), plus `PLUNK_SECRET_KEY`
for the email channel (absent ⇒ the attempt is recorded `failed` with the
`email-unconfigured` reason; nothing else changes).

## Verified

Live server (`PORT=3098`, SQLite `prisma/dev.db`, operator token + a client-portal token),
**177 checks, 0 failures**. Highlights, mapped to the acceptance cases:

- §11.2 **case 11** — a draft and an approved-but-unreleased report are absent from the
  portal list and 404 on detail; a released report is readable by its own client and only
  its own client; `visibility` was flipped public→private with release state unchanged.
- §11.2 **case 12** — after release the live `Report` row was rewritten out of band; the
  revision's `snapshot` column stayed **byte-identical** (sha256 compared), the portal kept
  serving the frozen content, the operator view showed the new row, and a second
  review→approve→publish released revision 2 while revision 1 flipped to `superseded` with
  its snapshot still byte-identical.
- Gate — `publish` before `review`, while `in-review`, and for an already-released
  revision all 409; the gate is called before any write.
- Share links — unreleased report 409; token stored as sha256 (verified against the
  digest, not just "not equal to the raw"); render 200 and noindex; revoked 404; expired
  404; unknown 404; list never carries a token; revoking left the report released.
- Delivery — manual attempt recorded `sent` with the released revision id and the actor;
  a malformed recipient (409) and an email attempt with no `reportUrl` (400) are both
  refused with **no** attempt row written; release state unchanged afterwards.
- Migration — preview wrote nothing, `POST` classified every candidate, a re-run
  classified 0, and a classified report was readable by its client with a full snapshot.
- D11 — a real pinned score run is exposed as `rubricVersion`/`scoreRunId` on both
  operator and portal reads and frozen into the revision; a report with no manifest
  reports `null`; the legacy `assetsNote` is repaired on read and flagged; a freshly
  generated report carries the corrected note and a pinned run, is a private draft, and is
  invisible to the client and to the public render.
- Cross-cutting — every operator route 401 without a token, 403 for a client token, 403
  for an operator on a portal route; a foreign projectId with a real slug 404s and vice
  versa (G03).

Also run: `npx tsc --noEmit` → 0 errors, `npx nest build` → clean, boot with
`PORT=3098 node dist/main.js` → no DI errors and all 21 new/changed routes mapped.

**Not exercised live:** the `email` delivery channel's provider call (the recipient
matcher and the ledger were exercised; no outbound email was sent from a verification
run). The gate's *refusal* paths were exercised structurally — `publish` refuses without
approval — but not with an existing `ApprovalRequest` bound to the same revision; that
requires G10's client-decision flow, and the call itself is a straight pass-through of
`assertReadyToPublish`.

## Known gaps (named, not hidden)

- **`Report.status` has no `superseded` value** (deliberate, matches the schema comment):
  supersession is a *revision* state. A report whose newest revision was superseded by a
  newer release stays `released`, which is what §8.3 shows.
- **Sharing serves HTML only.** There is no unauthenticated JSON read; the existing
  authenticated `:slug/view` stays operator-only. §5.10 describes public HTML links, so
  that is the surface implemented.
- **A `changes-requested` decision re-locks the same revision number** rather than opening
  a new one. Its snapshot is rewritten while it is a draft — the only place a snapshot is
  ever overwritten, and it is safe precisely because nothing was ever approved or released
  from it. Once approved, the snapshot is immutable; a later change opens revision N+1.
- **`CheckResult` (G10) has no project column**, so claim/source review records for a
  report revision cannot be listed through a project-scoped route here either. That is
  G10's own recorded gap.
