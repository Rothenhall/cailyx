# Platform changes: content, delivery, calendar and client contracts

Status: static source research for the platform change plan; not an implementation or runtime verification. Paths below are repository-relative. Line references identify inspected source, not immutable API documentation. API paths are controller-relative (normally under the backend's API prefix).

## 1. Existing content support — reuse, do not rebuild

| Concern | Current contract / model | Source |
|---|---|---|
| Recommendations | `GET /projects/:projectId/growth-execution/topics`; `POST/GET .../assets`; `PATCH .../assets/:assetId` | `backend/src/modules/growth-execution/growth-execution.controller.ts:13` |
| Legacy generation | `POST /projects/:projectId/growth-execution/content`, article/ad-copy from ranked topics | `backend/src/modules/growth-execution/growth-execution.controller.ts:44` |
| Editorial instructions | `GET/POST /projects/:projectId/content-briefs`; `GET/PATCH .../:briefId`; `GET .../:briefId/versions` | `backend/src/modules/content/content.controller.ts:66` |
| Editable content | `GET /projects/:projectId/growth-execution/assets/:assetId`; `GET .../:assetId/revisions`; `PATCH .../:assetId/content` with expected version | `backend/src/modules/content/content.controller.ts:142` |
| Generation tracking | `GET/POST /projects/:projectId/content-jobs`; `GET .../:jobId`; `POST .../:jobId/retry` | `backend/src/modules/content/content.controller.ts:194` |
| Reviews | `GET/POST /projects/:projectId/approvals`; detail, decision and cancel; client `GET /portal/approvals`, detail and decision | `backend/src/modules/approvals/approvals.controller.ts:50`, `:203` |
| Data identity | `GrowthAsset` is stable content identity; `ContentRevision` pins `assetId`, revision, content hash and generating brief version | `backend/prisma/schema.prisma:1114`, `:3001` |

### Important distinctions and defects

- A recommendation (`GrowthAsset.brief`) is not an approved instruction record (`ContentBrief`), and neither is a finished draft. The current opportunities UI labels creation of GrowthAssets as “Create briefs”; consolidate the UX but retain these distinctions internally. Evidence: `web/src/app/(ops)/projects/[projectId]/content/opportunities/page.tsx:165`, `:301`; schema `:1114`, `:2961`.
- Current content list separately queries GrowthAssets and ContentBriefs and sends generation to another page. Replace with one workspace and contextual creation, not duplicate records. Evidence: `web/src/app/(ops)/projects/[projectId]/content/page.tsx:85`, `:99`, `:265`, `:338`.
- Generation is implemented only for `article` and `ad-copy`; seven other tracked types are recommendation/manual-content workflows. Do not promise email, social, FAQ or landing-page generation without adding and testing writers. Evidence: `backend/src/modules/content/content.types.ts:9`, `:18`; `content.service.ts:507`.
- `createGenerationJob` persists job/items, then awaits sequential item execution and finalization before responding. Durable queued execution, resumable worker leases and an immediate accepted response are not established merely by the presence of a jobs table. Evidence: `backend/src/modules/content/content.service.ts:493`, `:550`, `:572`, `:577`.
- Generation validates the exact approved brief version; partial results and retryable failed items are supported. Preserve these controls when moving the form into a dialog. Evidence: `content.service.ts:493`, `:653`, `:692`.
- `voiceContextVersion` is currently an optional label included in prompt text; this is not loading a reviewed Brand Voice profile or verified Business Profile content. Add owned, immutable version references and resolved snapshots. Evidence: `backend/src/modules/content/dto/content.dto.ts:288`; `content.service.ts:803`.
- Latest briefs and version history are grouped by title, not a stable lineage identifier. Introduce a stable family/thread ID before depending on rename-safe unified content timelines. Evidence: `content.service.ts:165`, `:188`; `backend/prisma/schema.prisma:2993`.
- Recommendation creation writes new GrowthAsset records; do not assume repeat clicks are idempotent. Add source-linked deduplication/conversion keys and request idempotency for idea → instructions → generation. Evidence: `backend/src/modules/growth-execution/growth-execution.service.ts:129`, `:218`.
- Legacy generation remains a second route; new UI should use the brief-bound job contract, while an explicit compatibility/deprecation policy handles existing integrations. Evidence: both controllers above.

### Recommended extensions (proposed, not existing)

1. One paginated content workspace reader with search, type, stage and source filters; server computes statuses from actual records rather than trusting `GrowthAsset.status` as review/publishing truth.
2. Stable relationships among recommendation/source opportunity, brief family/version, generation item, asset, revision, approval and publication; preserve original IDs and existing detail links.
3. Idempotent “use this idea” / keyword-gap conversion that opens existing work on repeat, pre-fills the source query and captures source observation IDs.
4. Asynchronous, recoverable job creation and failed-item-only retry if a nonblocking generation dialog is required; reuse approved infrastructure instead of selecting a new queue silently.
5. Real Brand Voice / Business Profile snapshot inputs, client-safe generation permissions, type capability flags and translated error/status copy.

## 2. Delivery planning and action-required priorities

Existing contracts:

- `/clients/:clientId/engagements`: list, detail, create, edit and status (`delivery-plan.controller.ts:64`).
- `/projects/:projectId/cycles`: list/detail/detail-with-work/create/edit/status and `POST :id/commit` (`:125`).
- `/projects/:projectId/work-items`: list/detail/create/edit/delete, submit/verify/block/unblock and acceptance checks (`:209`).
- `/projects/:projectId/milestones`: list/create/edit/delete (`:364`).
- `/team/capacity` plus project/org allocation operations (`:409`).
- `/portal/projects/:projectId/plan`, `/work`, and `POST /work/:workItemId/evidence` (`:488`).

Models already exist: `Cycle` with goal/date range and frozen committed count; `WorkItem` with owner, due date, dependency IDs, client visibility and source IDs; `AcceptanceCheck`; `Verification`; `Milestone`; `CapacityAllocation`. Source: `backend/prisma/schema.prisma:2613` onward.

Current roadmap mixes strategy recommendations, gap details and delivery data; current priorities are gap-analysis inventory. Sources: `web/src/app/(ops)/projects/[projectId]/roadmap/page.tsx:24`, `:96`; `priorities/page.tsx:114`; `web/src/services/planning.ts:1`.

Required plan changes:

1. Reuse cycles for a 30-day delivery window and milestones for larger commitments; add outcome/goal groups (SEO/content/email/ads as applicable), target/unit and links to execution work. A dated “publish ten articles” commitment is not the same as a list of ten technical findings.
2. Keep internal detailed execution in team work/cycles. Roadmap is high-level goals and progress; only meaningful linked details open on demand.
3. Build an audience-specific action-required reader combining approvals, missing access/profile decisions and explicitly assigned/blocked work; do not call every open gap a client priority.
4. Freeze goal denominators on commitment, record scope changes and distinguish verified delivery from self-marked completion. Existing `commitCycle` freezes count and prevents deletion of committed work (`delivery-plan.service.ts:269`, `:535`).
5. Do not claim the portal plan has a release gate: it currently returns cycles and client-visible work/milestones directly. Add a specific plan release/revision policy if product requires reviewed client plans (`delivery-plan.service.ts:812`).
6. Tighten portal DTOs: current work projection removes `internalNotes` but spreads the remaining row, including operator/source IDs and estimated/actual hours; cycle projection spreads `committedBy` and scope-change actor fields. Use explicit client allowlists rather than hidden UI fields (`delivery-plan.service.ts:313`, `:652`, `:812`).
7. Keep client evidence submission separate from verification; only the assigned client owner can submit active work, which moves to review, not verified (`delivery-plan.service.ts:850`).

## 3. Publishing exists, calendar wiring is stale

Existing contracts:

- `GET /publishing/providers` returns declared capabilities and registered adapters (`publishing.controller.ts:65`).
- `/projects/:projectId/publish-destinations`: list/detail/create/update, authorize/test/resources/select-resource/revoke (`:86`).
- `/projects/:projectId/publications`: list/detail/create, verify/cancel/retry (`:246`).
- `Publication` already contains asset/revision/approval/destination IDs, `scheduledFor`, remote result, verification and attempt state (`backend/prisma/schema.prisma:3216`).
- The scheduler checks due stored publications every minute and dispatches through approval/connection gates. Persisted rows survive restart, but an in-process overlap guard is not itself proof of cross-instance exactly-once delivery (`backend/src/modules/publishing/publication-scheduler.service.ts:43`, `:73`).
- Create and dispatch require the correct revision approval, connected destination, valid permissions and publication gates; changes to content or consent must not silently authorize a scheduled push (`publishing.service.ts:581`, `:642`; `approvals.service.ts:256`).
- Only the custom-webhook adapter is registered in `PublishingService` today. Other catalog entries are declarations, not functioning WordPress/social/email/ads integrations (`publishing.service.ts:166`).

The current project calendar reads dated work, milestones, approvals, cadence and released reports; the content calendar reads content readiness and destinations but no publications. Both contain outdated statements that publishing has no contract. Sources: `web/src/app/(ops)/projects/[projectId]/calendar/page.tsx:36`, `:111`; `content/calendar/page.tsx:32`, `:100`. The portfolio calendar uses work/report lists, not content publication schedules, and filters date windows locally on loaded pages (`web/src/services/calendar.ts:1`, `:95`).

### Required canonical calendar contract

1. One content-only reader backed by stored content plans and publications; global/project views are filters of the same data and component, not separate calendars with different semantics.
2. Add server date range, timezone, stable pagination, project/destination/channel/status filters. Existing `ListPublicationsQueryDto` has only status, destinationId, assetId and limit (max 200), so it cannot produce complete arbitrary month views (`publishing/dto/publication.dto.ts:104`).
3. A plan entry is needed before approval/destination configuration: existing publication creation requires publish readiness. Do not schedule unapproved content by relaxing safety gates. Link planned entries to actual publications when ready.
4. Preserve a distinguishable planned date, approved/scheduled remote dispatch, publication outcome and verified-live state. A remote draft is not a live publication; an email plan is not proof of a sent campaign.
5. Rescheduling needs a guarded write contract (version/optimistic lock, timezone conversion, pending-only eligibility, audit reason). No dedicated reschedule route is present in the publishing controller.
6. Calendar click navigates directly to the existing content detail `/projects/:projectId/content/:assetId` (client equivalent via safe projection). No extra calendar-detail modal; use explicit edit actions if date changes are required.
7. Redirect obsolete calendar routes and update links. Keep operational cadence configuration in team/settings, not content calendar; do not delete the scheduling engine.
8. Include supported manual/external content plans for email/social/ads only with honest action/status labels; never imply auto-send or ad launch from provider names alone.

## 4. Client content is a real missing contract

The client content page is intentionally unavailable and reads only a project summary: content and publication controllers are operator-only. Source: `web/src/app/(client)/client/projects/[projectId]/content/page.tsx:18`; the controller groups listed above have no `@ClientPortal` equivalent.

Add explicit client-safe list/detail/calendar endpoints, project ownership checks and a sharing/review policy. Clients should see deliberately shared review revisions and approved/published content, not all draft iterations, provider costs, raw generation inputs, private notes or service credentials. Do not make the operator APIs client-accessible just to reuse a screen. Existing `/portal/approvals` can still handle approval decisions with exact-revision binding.

Recommended client copy: “Content”, “Ideas”, “Drafts”, “Waiting for your approval”, “Scheduled”, “Published”, “Changes needed”, “Writing style”; avoid “GrowthAsset”, “artifact”, “generation item”, “provider”, “revision hash”, “machine-generated” and developer prerequisite paragraphs.

## 5. Reports, results and released-score consistency

- Report lifecycle is already implemented: review, approve, publish, withdraw; frozen revisions; share links and delivery attempts. Sources: `backend/src/modules/reporting/reporting.controller.ts:264`; `report-lifecycle.service.ts:17`, `:177`, `:285`, `:359`.
- Client report list/detail routes serve only released frozen revisions, not mutable drafts. Preserve these gates during navigation/UX changes. Sources: `backend/src/modules/client-portal/client-portal.service.ts:56`, `:81`; `report-lifecycle.service.ts:610`, `:648`.
- Client project summary currently filters for released reports but reads `Report.scoreTotal/scoreBand` from the mutable report row; released report readers obtain scores from the frozen snapshot. Align overview scores to the chosen published/live policy explicitly, rather than mixing the two sources. Source: `client-portal.service.ts:32` versus `report-lifecycle.service.ts:624`.
- Results already support report periods, methodology/cohort scope and evidence manifests. Preserve measured versus not-measured states and comparison breaks when introducing the new composite score. Sources: `backend/src/modules/results/results.controller.ts:70`, `:114`, `:209`, `:280`, `:380`.
- Client results projection omits sales pipeline/PII/internal notes/costs and reports intentional omissions; do not bypass this projection for a simpler dashboard. Source: `backend/src/modules/results/results.service.ts:710`.
- Simplify displayed language without suppressing essential scope: show “Last updated”, “We still need…”, “Compared with last month”, and “These periods use different checks” rather than removing freshness/methodology warnings. Technical IDs/provider diagnostics belong in team details.

## 6. Minimum acceptance tests for these changes

1. Recommendation conversion retries return the same work/brief link; unrelated ideas with identical titles remain separate.
2. Renaming an approved brief retains lineage and historical generation inputs.
3. Generation receives actual selected voice/profile snapshot text and IDs, not a label alone; restart and partial failure do not regenerate successful items.
4. Unsupported content/channel capabilities remain explicit without showing client-facing technical setup errors.
5. One calendar returns all month entries beyond 200 rows, uses project timezone including daylight-saving boundaries, and contains no audit-run/report-release/work-task noise.
6. Moving a calendar entry changes the intended pending plan/publication exactly once; editing content invalidates the old approval and prevents unapproved dispatch.
7. Client calendar/detail routes cannot access another client's content or unshared drafts by ID guessing; no private staff fields/costs leak in JSON.
8. Roadmap target progress counts verified delivery against the frozen commitment; late scope edits are visible instead of rewriting history.
9. Client action-required cards disappear when completed and never list unassigned internal gaps as client tasks.
10. Dashboard score agrees with its explicitly chosen report snapshot/live measurement source; withdrawn or unreleased report values never leak.

No code was changed or services started for this research. These findings are implementation-plan inputs, not claims that the new behavior exists.
