# Content Requests Module

> **Status:** Built and verified (live server + real Postgres, 2026-09-21)
> **Phase:** C4 (PLAN.md §11.4)
> **Spec:** `docs/analysis/client-portal.md` §14 (structured request form), §22 (routing decision)

## Purpose

The client's structured "request new content" form. Per §22's explicit
decision, a submission becomes a real `content-workspace` item
(`GrowthAsset`) **immediately** — there is no separate triage inbox an
operator must convert first. This module validates the structured input
(content type / topic / priority) against `content-workspace`'s own existing
taxonomy and lifecycle, then creates the asset via
`GrowthExecutionService.createFromClientRequest` and links the two rows.

## Architecture

```
content-requests/
├── content-requests.module.ts      # NestJS module (imports GrowthExecutionModule)
├── content-requests.service.ts     # Validate + create-then-link
├── content-requests.controller.ts  # Operator traceability read (nested under /api/projects/:projectId)
├── content-requests.types.ts       # DTOs
├── dto/
│   └── content-requests.dto.ts
└── README.md
```

Client-facing create/list routes live on `ClientPortalController`
(`GET/POST /api/portal/projects/:projectId/content-requests`) —
`client-portal.module.ts` imports this module for that.

## How a request becomes content

1. `ContentRequest` row created (`growthAssetId: null` briefly).
2. `GrowthExecutionService.createFromClientRequest` creates the `GrowthAsset`
   (same create-then-link shape as the module's existing
   `createFromOpportunity` — see `growth-execution/README.md`), tagging it
   `sourceClientRequestId`.
3. `ContentRequest.growthAssetId` is patched to the new asset's id.

The new asset starts with no `ContentRevision`, so `content-workspace`'s
existing `deriveEditorialState` correctly reports `planned` (its "no revision
yet" state) — an honest "submitted, not started" signal, reusing an existing
lifecycle state rather than inventing a new one. `clientReviewState` is
`not-shared`, so the piece does **not** appear in the client's own "Content"
list (`listPortalContent`) until an operator explicitly shares a revision —
verified end-to-end, see Testing notes.

## content-workspace changes made to support this

- `GrowthAsset` gains `sourceClientRequestId` (nullable, non-FK — same
  traceability pattern as `sourceGapId`/`sourceOpportunityId`).
- `ContentWorkspaceItemDto.source` now reports `'client-request'` for these
  pieces (was previously only `'gap' | 'opportunity' | 'manual'`).
- `GrowthAssetDto`/`ContentWorkspaceItemDto` both carry the new
  `sourceClientRequestId` field.

## Public API

| Method | Endpoint | Roles | Description |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/content-requests` | admin, delivery-lead, content | Traceability read — every row already has a real `growthAssetId` |
| `GET` | `/api/portal/projects/:projectId/content-requests` | client | This client's own submitted requests |
| `POST` | `/api/portal/projects/:projectId/content-requests` | client | Submit the structured form — creates the workspace item immediately |

## Dependencies

- **Modules:** `database` (PrismaService), `growth-execution` (asset creation).
- **npm:** none beyond existing deps.
- **External services:** none.

## Environment variables

None.

## Consumers

- `client-portal` — client-facing read/create routes.
- `content-workspace` — reads `sourceClientRequestId` for the `source` derivation; the created `GrowthAsset` flows through its existing list/detail/share endpoints unchanged.

## PRD alignment (client-portal.md)

| Requirement | Status | Notes |
|---|---|---|
| §14 structured form (type/topic/priority) | ✅ | `contentType` validated against `CONTENT_WORKSPACE_ASSET_TYPES`; `priority` is `low\|normal\|high` |
| §14 reuse existing taxonomy, not a new one | ✅ | No new asset-type enum — imports `CONTENT_WORKSPACE_ASSET_TYPES` directly |
| §22 straight into content-workspace, no triage inbox | ✅ | `GrowthAsset` created in the same request that creates `ContentRequest` |
| §22 tagged client-originated | ✅ | `sourceClientRequestId` + `source: 'client-request'` in every workspace read |

## Testing notes

`npx tsc --noEmit` (backend) → 0 errors · `nest build` → passes.

End-to-end, live server (`PORT=3091`) against the shared dev Postgres, 2026-09-21:

1. `POST /api/portal/projects/:id/content-requests` `{contentType:"article", topic:"best CRM for small sales teams", priority:"high", note:"..."}` as the client → `201`, returned `growthAssetId` set (non-null).
2. `GET /api/portal/projects/:id/content-requests` (client) → the request listed.
3. `GET /api/projects/:id/content-requests` (operator) → same row, traceability confirmed.
4. `GET /api/projects/:id/content-workspace/items/:assetId` (operator) → `source: "client-request"`, `sourceClientRequestId` matches the request id, `editorialState: "planned"`, `clientReviewState: "not-shared"`, `assetType: "article"`, `title` = the submitted topic.
5. `GET /api/portal/projects/:id/content` (client, existing endpoint) → returned `{items: []}` — confirms the new piece is correctly **absent** from the client's shared-content list until an operator shares a revision, per the existing client-safe projection's rule.
6. Invalid `contentType` (`"video"`, not in the tracked taxonomy) → `400`.

**Not yet built:** priority is stored but not yet surfaced as a sort/filter
in the operator's `content-workspace` UI — recorded honestly in
`docs/MODULES-STATUS.md`.
