# Approvals Module (G10 — version-bound reviews, immutable decisions, claim gates)

Purpose: make "the client approved this" a checkable fact rather than a claim.
An `ApprovalRequest` binds to **one exact artifact revision**; a decision
records that the decider actually saw that revision; and a newer revision
invalidates an outstanding request instead of inheriting its consent. One
served gate — `ApprovalsService.assertReadyToPublish()` — is the single place
publication asks "is this revision releasable?", so a blocked claim or an
unresolved approval cannot be bypassed by calling a different endpoint.

## File tree

```
approvals/
  approvals.controller.ts   HTTP layer — 3 controller classes (written this pass)
  approvals.service.ts      requests, decisions, invalidation, publish gate, check records
  approvals.types.ts        ApprovalRequestDto / ApprovalDecisionDto / CheckResultDto
  approvals.module.ts       registers all three controllers, exports ApprovalsService
  dto/approvals.dto.ts      CreateApprovalRequestDto / DecideApprovalDto / CancelApprovalDto / ListApprovalsQueryDto
```

## Endpoints

| Method | Path | Audience | Input | Returns |
|---|---|---|---|---|
| GET | `/api/projects/:projectId/approvals` | operator | `?status=&artifactType=&artifactId=` | `{ requests }` newest first |
| POST | `/api/projects/:projectId/approvals` | admin, delivery-lead | `CreateApprovalRequestDto` | 201 request (`pending`) |
| GET | `/api/projects/:projectId/approvals/:id` | operator | — | request + `decisions[]` |
| POST | `/api/projects/:projectId/approvals/:id/decision` | admin, delivery-lead | `DecideApprovalDto` | 200 updated request, **409** on a stale/foreign revision |
| POST | `/api/projects/:projectId/approvals/:id/cancel` | admin, delivery-lead | `CancelApprovalDto` | 200 cancelled request, **409** if already resolved |
| GET | `/api/approvals/check-results` | admin, delivery-lead | `?subjectType=&subjectId=` (both required) | `{ results }` newest first |
| GET | `/api/portal/approvals` | client (`@ClientPortal`) | — | `{ requests }` — this client's own queue |
| GET | `/api/portal/approvals/:id` | client | — | request + `decisions[]`, **404** if not theirs |
| POST | `/api/portal/approvals/:id/decision` | client | `DecideApprovalDto` | 200 updated request, **409** on an unseen revision |

**Roles.** Deciding is admin/delivery-lead on the operator side (design_plan
§2.2: content/technical "submit for review"; the *designated reviewer*
decides). The client decides only on their own requests, and only for the
revision they quote.

**Client scope.** The portal class is `@ClientPortal()`, so RolesGuard's
default-deny applies: an operator hitting it gets 403, a client cannot reach
any operator route. `clientId` comes from the JWT (`user.clientId`) and never
from a request field; a request that is not theirs returns the same 404 as one
that does not exist, so the surface never confirms another client's request.

**Immutability.** `decide` inserts a new `ApprovalDecision` and marks the
previous head `supersededBy` — an earlier decision is never rewritten. A
decision only lands while the request is `pending`/`changes-requested`, and
`revision` must equal the request's current `artifactRevision`, so "approve"
can never mean "approve something I was not shown".

## Why the operator id routes are nested under `:projectId`

`get`/`decide`/`cancel` all take the owning `projectId` and 404 when the row
belongs to another project, so the owning id has to be in the URL for that
check to exist (design_plan G03). There is no `/api/approvals/:id`.

## Dependencies

- `PrismaService` — global via `DatabaseModule`, injected, never imported.
- Exports `ApprovalsService`: `publishing` (G11) and `reporting` (G05, for report
  release) call `assertReadyToPublish`, and any artifact owner calls
  `invalidateStaleRequests` when it locks a new revision (`reporting.review()`
  does this for every report revision).

## Env vars

None. No LLM, no external provider, no queue.

## PRD alignment (design_plan.md Appendix A, G10)

| Requirement | Status |
|---|---|
| `POST /api/projects/:projectId/approvals` with artifactType/id/version, requiredReviewer, due, decision scope | ✅ |
| detail / list / decision / cancel | ✅ |
| Client-scoped `/api/portal/approvals` + `POST .../:id/decision` | ✅ |
| "Add claim/source review records linked to the exact content/report revision" | ⚠ read-only route (`GET /api/approvals/check-results`). `recordCheckResult` is deliberately not exposed — it is the in-process API other modules call, and an HTTP write would let a caller file its own review evidence. |
| Server checks current approved version before publication/release | ✅ implemented in the service (`assertReadyToPublish`) and called by **both** publishers before anything is written: the `publishing` module (G11) before any remote write, and `reporting`'s `ReportLifecycleService.publish()` (G05, 2026-09-16) before a report revision is released. Deliberately **no HTTP route** — a caller-asserted release gate is not a gate. **Report release is now gated:** G05 added `POST /api/projects/:projectId/reports/:slug/publish`, which calls this gate first, uses `artifactType "report"` / `revisionType "report-revision"` (the value `RevisionClaimLink` documents for a frozen report revision), and propagates the refusal. `review()` also calls `invalidateStaleRequests`, so consent for revision N never carries to N+1. History: the original row claimed a `reporting.publish()` that did not exist (corrected 2026-09-16 by the G16/G11 pass), and the corrected wording said report release was *not* gated — that is now superseded by G05. |
| Edits invalidate approval | ✅ `invalidateStaleRequests`, called by the revision's owner. **For reports** that has been true since G05 (`ReportLifecycleService.review()`). **For content revisions it was not**, and this row claimed otherwise until 2026-09-17: `ContentService` saved revision N+1 without telling this service, so an approval for revision N stayed `approved` and a scheduled publication could ship the pre-edit body (§21.2 journey 12). Two things now close it: `ContentService.updateAssetContent` calls `invalidateStaleRequests` like reporting does, and both dispatch gates — `PublishingService.dispatchBlockedReason` and `ContentCalendarService.executionBlock` — compare the revision being published against the asset's current one, because an approval that is still legitimately `approved` can nonetheless be superseded. The calendar reports that case as its own hold reason (`content-changed-since-approval`), not as a withdrawn approval, since the approval was never withdrawn. |
| Client cannot approve unseen/foreign/stale version | ✅ 404 foreign, 409 stale — both verified |
| Blocked claims cannot bypass via another endpoint | ✅ the gate lives in one service method, not in a controller |
| Decisions immutable with superseding action | ✅ new row + `supersededBy` pointer |
| Screens CP09/CP10 (client approval queue and detail) | ✅ |
| Screens CT05/CL01/RP04 (operator review surfaces) | ⚠ approval half present; the surrounding screens are other modules' work |

### Known gap: `CheckResult` has no owning column

`CheckResult` carries `subjectType` + `subjectId` only — no `projectId` and no
`clientId` (`prisma/schema.prisma:3142`). Because of that the check-results
route is **not** project-scoped: there is nothing for a `:projectId` in the URL
to be checked against, and mounting it under a project path without a check
would be exactly the nested-id hole G03 describes. The compensating control is
the role restriction (admin/delivery-lead only). Fixing it properly means
either a `projectId` column on `CheckResult` or a scoped read on the service —
both outside this pass's file set (schema changes are coordinator-owned).

## Verified (2026-09-16, live on :3099, operator token)

- Request lifecycle: create → **201** `pending`; list `?status=pending` 200;
  detail 200 with `decisions: []`; foreign id → 404.
- `POST :id/decision` quoting `revision: 42` against a request bound to
  revision 1 → **409** with the "reload the request before deciding" message.
- Decision with the correct revision → **200**, status `approved`, one decision
  row; a second decision afterwards → **409** (the service only re-decides
  while `pending`/`changes-requested`; superseding happens in that window).
- `POST :id/cancel` on a decided request → **409** `is "approved" and cannot be
  cancelled`.
- `GET /api/approvals/check-results` → 200 `{results: []}`; missing
  `subjectId` → **400** with the explicit message.
- `GET /api/portal/approvals` with an **operator** token → **403** ("Operator
  accounts must use the operator API"). Not exercised with a client JWT: the
  dev DB has no `type: "client"` user, and creating one belongs to G02's
  invitation flow, not this pass.
- Every route without a token → 401. All test rows deleted afterwards.
