# Content Module (G09 — editable briefs, versioned content, generation jobs)

Purpose: the content pipeline's editable layer. A **brief** is the instruction
set (target query, angle, must-include points, approved claim ids, references,
language, word target); a **revision** is an immutable saved version of an
asset's actual text; a **generation job** produces one artifact per selected
topic *from one exact brief version*, and reports what it requested, produced,
failed and cost. Nothing here rewrites history: an approved brief forks a new
version instead of changing, and an edit to an asset writes a new revision
behind an `expectedVersion` precondition.

## File tree

```
content/
  content.controller.ts   HTTP layer — 3 controller classes (written this pass)
  content.service.ts      brief versioning, revision writes, generation batches
  content.types.ts        ContentBriefDto / ContentRevisionDto / GenerationJobDto / asset-type literals
  content.module.ts       registers all three controllers, exports ContentService
  dto/content.dto.ts      request DTOs (+ validation, incl. the expectedVersion precondition)
```

## Endpoints

| Method | Path | Roles | Input | Returns |
|---|---|---|---|---|
| GET | `/api/projects/:projectId/content-briefs` | any operator | `?status=&assetType=&latestOnly=` | `{ briefs }` |
| POST | `/api/projects/:projectId/content-briefs` | admin, delivery-lead, content | `CreateContentBriefDto` | 201 brief (v1, `draft`) |
| GET | `/api/projects/:projectId/content-briefs/:briefId` | any operator | — | one brief version |
| GET | `/api/projects/:projectId/content-briefs/:briefId/versions` | any operator | — | `{ versions }` oldest first |
| PATCH | `/api/projects/:projectId/content-briefs/:briefId` | admin, delivery-lead, content | `UpdateContentBriefDto` | updated brief, possibly a **new** version |
| GET | `/api/projects/:projectId/growth-execution/assets/:assetId` | any operator | — | `AssetContentDto` (current revision + `currentVersion`) |
| GET | `/api/projects/:projectId/growth-execution/assets/:assetId/revisions` | any operator | — | `{ revisions }` newest first |
| PATCH | `/api/projects/:projectId/growth-execution/assets/:assetId/content` | admin, delivery-lead, content | `UpdateAssetContentDto` (`expectedVersion` required) | saved revision, **or 409** |
| GET | `/api/projects/:projectId/content-jobs` | any operator | `?status=&limit=` | `{ jobs }` with items |
| POST | `/api/projects/:projectId/content-jobs` | admin, delivery-lead, content | `CreateGenerationJobDto` | 201 job (requested/succeeded/failed, per-item ids, cost, retryable ids) |
| GET | `/api/projects/:projectId/content-jobs/:jobId` | any operator | — | one job with its items |
| POST | `/api/projects/:projectId/content-jobs/:jobId/retry` | admin, delivery-lead, content | `RetryGenerationJobDto` | updated job + note |

**Roles.** Mutations are admin / delivery-lead / content, matching design_plan
§2.2's "Generate/edit content" row. Reads carry no `@Roles`, so any operator
(e.g. technical reading the drafts they were asked to check) can read. A
brief's own `status: "approved"` is an internal marker on the instruction set —
the client-facing approval is an `ApprovalRequest` (G10, admin/delivery-lead).

**The 409 precondition.** `PATCH .../assets/:assetId/content` must quote the
version it was based on. If the asset has moved past it, the request is
rejected with **409** and a body carrying `currentVersion` and `current` — the
caller reloads and reapplies, and no concurrent edit is ever silently
overwritten. `currentVersion: 0` means no revision has been saved yet (legacy
pre-G09 `GrowthAsset.content`, when present, is surfaced read-only via
`legacyContentOnly`).

## One deliberate route deviation

design_plan G09 asks for `PATCH .../growth-execution/assets/:assetId`. That
method+path is **already owned** by `growth-execution.controller.ts` (API-122,
"move an asset through its lifecycle"), and `GrowthExecutionModule` is
registered *before* `ContentModule` in `app.module.ts`, so a second handler
there would register second and never run. The content edit therefore lives at
`PATCH .../growth-execution/assets/:assetId/content`; the reads keep the
suggested paths (`GET .../assets/:assetId`, `.../assets/:assetId/revisions`).
Verified live, not assumed — see below. When the two PATCHes are eventually
merged into one handler, this route moves back with a one-line change.

## Dependencies

- `PrismaService` — global via `DatabaseModule`, injected, never imported.
- `ConfigService` + `LlmService` (`common/llm`) — used only by the generation
  path (OpenRouter preferred, Anthropic fallback).
- Exports `ContentService` for other modules.

## Env vars

| Var | Needed for | If missing |
|---|---|---|
| `OPENROUTER_API_KEY` | generation (preferred provider) | falls back to Anthropic |
| `ANTHROPIC_API_KEY` | generation (fallback) | `POST content-jobs` with ≥1 item → **503**; briefs/revisions/zero-item jobs still work |

## PRD alignment (design_plan.md Appendix A, G09)

| Requirement | Status |
|---|---|
| `POST/GET/PATCH /api/projects/:projectId/content-briefs` | ✅ |
| `GET/PATCH .../growth-execution/assets/:assetId` with version precondition | ⚠ PATCH at `.../:assetId/content` (path already owned — see above); GET at the spec path; 409 verified |
| `/assets/:assetId/revisions` | ✅ |
| `POST .../content-jobs` + job status (requested/succeeded/failed, cost, artifact ids, errors, retryable ids) | ✅ + `POST .../:jobId/retry` |
| Generation input: approved briefId/version, selected topic ids, type, source/claim ids, voice/context version, language, constraints | ✅ all in `CreateGenerationJobDto`; `briefVersion` mismatch → 422, unapproved brief → 422 |
| Seven non-article/ad types stay brief-only until implemented | ✅ service 422s; `article`/`ad-copy` are the only generatable types |
| Edits must not be lost or overwrite concurrent revisions | ✅ 409 precondition, verified |
| "Add draft-body analysis endpoint if extractability checks are promised" | ❌ not built — conditional in the PRD, and `ContentService` has no such method; nothing promises it yet |
| Screens CT01–CT06 (operator content pipeline) | ✅ API surface present |
| Screen CP08 (client content view) | ❌ not built — `ContentService` exposes only project-scoped operator reads; a client read needs a client-scoped/ownership method first (gap for the G09 portal surface) |

## Verified (2026-09-16, against a live boot on :3099)

All routes mapped (`RouterExplorer`), all three controllers registered, app
booted with no DI error. Then, with a real operator token:

- `PATCH .../assets/:assetId` with `{expectedVersion}` → **400** from
  growth-execution's own DTO (`expectedVersion` "should not exist") — the
  shadowing above, reproduced rather than assumed.
- `PATCH .../assets/:assetId/content` → reaches `ContentService` (404 naming
  the asset and project).
- Brief lifecycle: create 201 v1/draft → list/read/versions 200 → draft PATCH
  in place (still v1) → `status:"approved"` → edit forks **v2, draft** →
  `/versions` holds 2.
- Jobs: stale `briefVersion` 422, unapproved brief 422, brief-only asset type
  422 (via the brief's own type), foreign brief 404, zero-item job **201**
  (`requested 0`, `completed`, explanatory `note`) with no LLM call, retry with
  nothing retryable → 200 + "nothing was retried", foreign job 404.
- Asset content (throwaway row, deleted after): v0 → PATCH `expectedVersion:7`
  **409** with `currentVersion:0` → save at v0 → revision 1, `origin:
  operator-edit`, word count 3 → replaying v0 **409** `currentVersion:1` →
  save at v1 → revision 2 → `/revisions` newest first → all three asset routes
  under a foreign `:projectId` 404 with **no** revision created.
- Reads without a token 401 on every route; `?limit=abc` on `/api/activity`
  400. Dev DB left clean (0 briefs/jobs/items/revisions/assets afterwards).

## Not wired, and why

- **Client (portal) content surface** — no client-scoped service method exists.
- **Draft-body analysis / extractability endpoint** — PRD-conditional, no
  service method.
