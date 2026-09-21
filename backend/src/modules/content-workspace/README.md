# Content Workspace Module

> **Status:** Built (P08); this file was missing and is added now as part of
> Phase C4's post-completion checklist, since C4 materially changed this
> module (`sourceClientRequestId`, `source: 'client-request'`).
> **Phase:** P08 (platform_improvement_plan.md §13.1–§13.5, §13.9–§13.11), extended by C4.

## Purpose

Composes existing records — `GrowthAsset` (growth-execution), `ContentBrief`/
`ContentRevision` (content), `ApprovalRequest`/`CheckResult` (approvals),
`Publication` (publishing) — into ONE canonical content list/detail with
correctly separated state axes, rather than reimplementing generation,
approvals or publishing. Also supplies the client-safe shared-revision read
that `client-portal` uses for the client's own "Content" tab.

## Architecture

```
content-workspace/
├── content-workspace.module.ts     # NestJS module
├── content-workspace.service.ts    # List/detail, state derivation, client-safe reads
├── content-workspace.controller.ts # Staff REST API
├── content-workspace.types.ts      # Asset-type taxonomy + state-axis unions/DTOs
└── dto/
    └── content-workspace.dto.ts
```

## State axes (§13.4)

Four independently-tracked axes per content piece — `editorialState`,
`clientReviewState`, `publicationSummary`, `updateState` — each derived from
the underlying records, never stored redundantly on `GrowthAsset` itself.
`editorialState` defaults to `planned` when no `ContentRevision` exists yet
(the correct state for a piece just created and not yet drafted — see C4's
`content-requests` module, which relies on exactly this).

## Public API (staff)

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/content-workspace/capabilities` | any | Type capability matrix |
| `GET` | `/api/projects/:projectId/content-workspace/items` | any | Canonical filtered/paginated list |
| `GET` | `/api/projects/:projectId/content-workspace/items/:assetId` | any | Full detail |
| `PATCH` | `.../items/:assetId/assignee` | admin, delivery-lead, content | Set/clear owner |
| `POST` | `.../items/:assetId/revisions/:revisionId/share` | admin, delivery-lead, content | Mark client-visible |
| `POST` | `.../items/:assetId/revisions/:revisionId/unshare` | admin, delivery-lead, content | Withdraw client visibility |
| `POST` | `/brief-families/merge` | admin, delivery-lead, content | Staff tool: reunite legacy brief families |

Client-safe reads (`listClientSafeItems`, `getClientSafeItem`) are called by
`client-portal.service.ts`, not exposed directly here.

## C4 addition (client-portal.md §14/§22)

`GrowthAsset.sourceClientRequestId` — set once, at creation, only by
`GrowthExecutionService.createFromClientRequest` (called from the new
`content-requests` module). `source` derivation
(`toItemDto`/`ContentWorkspaceItemDto.source`) now reports `'client-request'`
for these pieces, alongside the existing `'gap' | 'opportunity' | 'manual'`.
No new state was invented: a client-requested piece with no revision yet
reads as `editorialState: 'planned'`, `clientReviewState: 'not-shared'` —
the same honest "submitted, not started" signal any other piece gets.

## Dependencies

- **Modules:** `database` (PrismaService).
- **Read-only reuse of other modules' tables:** `growth-execution`
  (`GrowthAsset`), `content` (`ContentBrief`, `ContentRevision`), `approvals`
  (`ApprovalRequest`, `CheckResult`), publishing (`Publication`) — a
  cross-cutting workspace view needs joins none of those modules' own
  service methods return in one shape, so this module reads their tables
  directly rather than importing their services.
- **npm:** none beyond existing deps.
- **External services:** none.

## Environment variables

None.

## Consumers

- `client-portal` — the client's "Content" tab (`listClientSafeItems`/`getClientSafeItem`).
- `content-requests` (C4) — creates the asset this module then lists/details.
- `opportunities` — `convertToContent` creates assets this module also surfaces.

## PRD alignment

| Requirement | Status | Notes |
|---|---|---|
| §13.3 canonical list, one predicate for page + total | ✅ | |
| §13.4 four independent state axes | ✅ | |
| §13.5 client-safe shared-revision read | ✅ | Never the latest internal draft |
| §14/§22 (C4) client-originated tagging | ✅ | `sourceClientRequestId` + `source: 'client-request'` |

## Testing notes

See `content-requests/README.md` and `prompt-requests/README.md` for the C4
end-to-end verification that exercises this module's `source` derivation and
client-safe read live against a real server + Postgres (2026-09-21). Prior
P08 verification predates this file.
