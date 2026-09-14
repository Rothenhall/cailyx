# Strategy Module

> **Status:** ✅ Built (committed in `df4bc8e feat(competitors, gap-analysis, strategy): market research + planning`)
> **Stage:** 9, "Strategy & Recommendations" (12-stage delivery flow)
> **Note:** this module shipped without the standard module docs (README, API.md
> entry, MODULES-STATUS.md row) — this file closes that gap; the code itself
> has been live since the commit above.

## Purpose

"Create Action Plan": takes `gap-analysis`'s stage-8 output (already
consolidated, categorised, impact/effort-scored) and groups every actionable
gap into the nine recommendation buckets the flowchart draws. This module
owns sequencing and client-facing framing only — it never re-derives
evidence; `gap-analysis` is the only place that reads the other audit
modules' raw data.

Strengths are excluded on purpose: `recommendationCategory` is null on every
strength row (`gap-analysis.types.ts`), because there is nothing to act on. A
strategy is a set of things to DO.

## Architecture

```
strategy/
├── strategy.module.ts        # NestJS module
├── strategy.service.ts       # buildActionPlan, getActionPlan
├── strategy.controller.ts    # REST API
├── strategy.types.ts         # ActionPlanDto, RecommendationDto
└── README.md                 # This file
```

## How it works

1. `buildActionPlan()` runs `gapAnalysisService.sync()` first, so the plan
   always reflects the latest evidence every audit module has — never a
   snapshot the operator forgot to refresh.
2. Every open, actionable gap (`issue`/`gap`/`opportunity`/`risk` — never
   `strength`) is bundled by its `recommendationCategory`.
3. Categories are ranked **quick-wins-first**: sorted by quick-win count
   descending, then total impact descending, then alphabetically — "do the
   cheap high-value work first" is the point of scoring impact/effort at all.
4. Each category becomes one `Recommendation` row with deterministic,
   template-based copy (title + summary naming the counts and the
   highest-impact gap) — **no LLM in the loop**, so nothing in the summary can
   drift from the evidence it's built from.
5. Idempotent: re-running replaces each category's recommendation in place
   and deletes any category no longer backed by a live gap (a fixed issue
   doesn't leave a stale recommendation behind).

## The nine recommendation categories

Matches the flowchart's stage-9 leaf nodes exactly (`gap-analysis.types.ts`
`RECOMMENDATION_CATEGORIES`):

| Category | Label |
|---|---|
| `seo-improvements` | SEO Improvements |
| `content-strategy` | Content Strategy |
| `social-strategy` | Social Strategy |
| `reputation-strategy` | Reputation / Review Strategy |
| `search-aeo-strategy` | Search / AEO Strategy |
| `conversion-optimization` | Conversion Optimization |
| `technology-improvements` | Technology Improvements |
| `advertising-opportunities` | Advertising Opportunities |
| `market-expansion` | Market Expansion Opportunities |

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/projects/:projectId/strategy/build` | Create/rebuild the action plan (re-syncs gap-analysis first) |
| `GET` | `/projects/:projectId/strategy` | Latest stored action plan; 404 if `build` has never run |

## Dependencies

| Dependency | Purpose |
|---|---|
| `GapAnalysisService` | The only source of evidence — stage 8's classified, prioritized gaps |
| `PrismaService` | `ActionPlan` / `Recommendation` persistence |

## Consumers

None yet. `reporting` (stage 12) does not read `ActionPlan`/`Recommendation`
— the "Prioritized Growth Roadmap" the flowchart draws as the final output
has no wiring back to this module's action plan today.

## What's NOT built

- No README/API.md/MODULES-STATUS.md entry existed before this file — the
  post-module completion gate (`docs/MODULES-STATUS.md` §4) was skipped when
  this module was committed.
- Not consumed by `reporting` — the final client report does not currently
  include the action plan this module builds.
- No LLM-authored narrative per recommendation (by design, for now — see
  "How it works" §4); if richer client-facing copy is wanted per category,
  it would follow the same constrained-LLM + claims-discipline pattern
  `findings` already uses, not a new pattern.
