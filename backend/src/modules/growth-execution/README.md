# Growth Execution Module

> **Status:** ✅ Built (2026-09-13; real content generation for article/ad-copy added 2026-09-13)
> **Stage:** 11, "Marketing & Growth Execution" (12-stage delivery flow) — the
> flowchart's last previously-unbuilt stage before Final Output (`reporting`).

## Purpose

Two distinct capabilities, not one:

1. **Briefs** (`POST /assets`) — for all 9 of the flowchart's "Create
   Recommended Assets" leaves, reads stage-8's open gaps and produces a
   title + 2-3 sentence angle per gap × asset type. A to-do for a writer,
   not a deliverable.
2. **Real content** (`POST /content`) — for exactly **article** and
   **ad-copy**, reads stage-10's priority keywords (via `suggestTopics()`)
   and generates the actual deliverable: a full SEO-ready article, or
   ready-to-run ad copy variants. Not a brief — this is the finished draft.

Do not confuse the two. `GrowthAsset.content` is null for a brief-only row
and populated for a real-content row (`article`/`ad-copy` from `/content`).

## Architecture

```
growth-execution/
├── growth-execution.module.ts       # imports GapAnalysisModule, KeywordResearchModule (LlmService is global)
├── growth-execution.service.ts      # suggestTopics, createAssets (briefs), generateContent (real copy)
├── growth-execution.controller.ts   # REST API
├── growth-execution.types.ts        # AssetType, ArticleContent, AdCopyContent, GrowthAssetDto
├── dto/growth-execution.dto.ts      # CreateAssetsDto, GenerateContentDto, ...
└── README.md
```

## "Suggest Blog Topics & Ad Angles" (`GET /topics`)

Deterministic. Reads `keyword-research.priority()` (pure read, no vendor
call) for the project's top keywords, turns each into a topic title and an
ad angle. Preview only — never persisted. Empty array, not an error, when no
keyword-research set has been run yet for the project.

## "Create Recommended Assets" — briefs (`POST /assets`)

Covers all 9 asset types. Groups stage-8's open, actionable gaps by their
stage-9 recommendation category (`CATEGORY_TO_ASSET_TYPES`), generates one
row per gap × mapped type. Deterministic template by default; `useLlm: true`
refines the brief text with one short constrained call (still just a title +
brief, `maxTokens: 400`) via the shared `LlmService`. `technology-improvements`
maps to no asset type on purpose — a CRM gap is not a blog post.

## Real content generation (`POST /content`)

**Always uses the LLM — there is no deterministic long-form writer, so this
503s honestly (`llm.isAvailable()` false) rather than faking one.** Takes the
top `limit` (default 3, capped 10) priority-keyword topics from
`suggestTopics()` and, per requested type:

- **`article`**: one `LlmService.json()` call (`maxTokens: 4000`) asks the
  model for structured fields only — `title`, `metaDescription`, `slug`,
  an 800-1200 word `bodyMarkdown` (intro + 3-5 `##` sections + conclusion),
  and 3-4 `faq` question/answer pairs. The FAQ section is then appended to
  the body **and** used to build a `FAQPage` JSON-LD block; a `BlogPosting`
  JSON-LD block is always built too — both **constructed in code**, never
  asked of the model directly, so the markup is guaranteed valid schema.org
  rather than a hallucinated shape. `author`/`publisher` come from the
  project's real name; `mainEntityOfPage` is a suggested `/blog/<slug>` path
  (the asset is `status: "recommended"`, not a live page — not a claim the
  URL exists).
- **`ad-copy`**: one `LlmService.json()` call (`maxTokens: 700`) asks for
  exactly 4 variants with genuinely distinct angles (benefit-led, urgency,
  social-proof, direct-offer), each a headline (~30 chars) + description
  (~90 chars). Lengths are an instruction, not a hard-enforced truncation —
  a model that runs 1-2 characters over is not silently cut, which would
  break words mid-sentence.

Each topic × type is its own LLM call — `limit` directly bounds cost/time.
A failure on one topic/type is logged and skipped; it never aborts the rest
of the batch.

## Built Features

| Feature | Status | Notes |
|---|---|---|
| Topic/angle suggestion from priority keywords | ✅ | Deterministic, zero cost |
| Brief generation, all 9 asset types | ✅ | Deterministic template; optional LLM refine (still brief-length) |
| **Real article generation** | ✅ | Title, meta description, slug, 800-1200 word body, FAQ section, `BlogPosting` + `FAQPage` JSON-LD |
| **Real ad copy generation** | ✅ | 4 distinct ready-to-run variants |
| Real content for the other 7 types (social/email/landing-page/structured-data/seo-fix/faq/review-campaign) | ❌ Not built | Explicitly deferred by the operator — briefs only for now |
| Hard length enforcement on ad headlines/descriptions | ⚠️ Soft | Instructed, not truncated — verified live: 2 of 4 variants ran 1-2 chars over a 30-char headline target |
| Image generation / selection for articles | ❌ Not built | No image field in `ArticleContent` — never a fabricated URL |

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/projects/:id/growth-execution/topics` | Preview blog topics + ad angles |
| `POST` | `/projects/:id/growth-execution/assets` | Create brief rows across the 9 asset types |
| `POST` | `/projects/:id/growth-execution/content` | Generate real article/ad-copy content |
| `GET` | `/projects/:id/growth-execution/assets` | List, filterable by `assetType`/`status` |
| `PATCH` | `/projects/:id/growth-execution/assets/:assetId` | Move through lifecycle (`recommended` → `in-progress` → `published`) |

## Dependencies

`GapAnalysisModule`, `KeywordResearchModule` — both read-only, never
triggered to re-sync/re-pull. `LlmService` (global, `common/llm`) —
OpenRouter preferred, Anthropic fallback.

## Consumers

- `opportunities` — `convertToContent` → `createFromOpportunity` (idempotent create-then-link).
- `content-requests` (C4, client-portal.md §14/§22) — `createFromClientRequest`, added this phase. Same create-then-link shape as `createFromOpportunity`: creates the `GrowthAsset` directly (no separate triage step), tagged `sourceClientRequestId` so `content-workspace`'s `source` derivation reports `'client-request'`.

## Testing notes

Verified end-to-end against a live local backend with real DataForSEO
keyword data and a real OpenRouter call (`qwen/qwen3-30b-a3b-instruct-2507`):
generated a 929-word article for "project management software" with a
correct 5-section + FAQ structure, valid `BlogPosting` + `FAQPage` JSON-LD
(author/publisher from the real project name, keywords from the real target
keyword), and 4 ad-copy variants with genuinely distinct angles. `npx tsc
--noEmit` clean.
