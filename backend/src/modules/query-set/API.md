# Query Set — API Reference

All routes are nested under the owning project: `/api/projects/:projectId/query-sets`.

## POST `/` — create v1 draft

`POST /api/projects/:projectId/query-sets`

```json
{
  "persona": "solution-aware",
  "label": "E2E set",
  "source": "manual",              // optional: manual | sales-questions | support-tickets
  "prompt": "How do mid-market...",// optional seed prompt (min 5, max 500 chars)
  "funnelStage": "solution-aware"  // optional; defaults to persona
}
```

**201** — the created draft (items included):

```json
{
  "id": "cmteutmt600017r3temw93a95",
  "projectId": "cmteutmhm00007r3t4kuz0cjf",
  "version": 1,
  "persona": "solution-aware",
  "label": "E2E set",
  "status": "draft",
  "source": "manual",
  "createdAt": "2026-08-29T20:49:55.387Z",
  "activatedAt": null,
  "items": []
}
```

Errors: `404` project not found · `409` a v1 set for this persona exists · `400` invalid persona/fields

## GET `/` — list

`/api/projects/:projectId/query-sets?status=active` — `status` optional. Returns all versions, newest first, each with `items`.

## GET `/export` — export all

`/api/projects/:projectId/query-sets/export` — every set of every persona/version with all prompt rows. The client owns this artifact.

## GET `/:setId` — detail

Set with items. `404` when unknown.

## POST `/:setId/prompts` — add prompt (draft only)

```json
{ "prompt": "What is the best Automated Outreach platform for mid-market?", "funnelStage": "product-aware" }
```

**201** — item row. `409` when the set is not a draft.

## DELETE `/:setId/prompts/:itemId` — remove prompt (draft only)

**200** — `{ "removed": "<itemId>" }`. `404` when item missing or not in this set. `409` when set is not a draft.

## POST `/:setId/activate` — activate

**200** — the set with `status:"active"` and `activatedAt` stamped. Requires ≥ 1 prompt (`409` when empty). After activation all mutations return `409`.

## POST `/:setId/fork` — next version

**201** — a new draft at version+1 (same project + persona), pre-populated with every prompt of the source. `409` when the source is still a draft.

## Error shape

```json
{ "statusCode": 409, "message": "Query set <id> is active — immutable. Fork it to create a new version.", "error": "Conflict" }
```