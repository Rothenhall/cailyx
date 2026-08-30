# Internal-Link Module (Swarm layer — Agent #8)

> **Status:** ✅ Built and e2e-verified (2026-08-30, offline fixture site — 23/23 assertions)
> **Layer:** Swarm
> **Depends on:** `fetcher` (FetcherService — central rate-limit + logging), `database`, `config`

## Purpose

Analyses the **client's own** topical architecture: crawls a bounded set of the
client's pages, builds the internal link graph, finds **orphans** and
**under-linked hubs**, and emits ranked **"add a link A → B"** recommendations
from keyword overlap + inbound-link deficit.

Client-site analysis only. The crawl root defaults to the project's own domain
and every fetch goes through `FetcherService` (per-domain rate limiting is the
fetcher module's job). There is no third-party crawling and no live-AI-surface
interaction here.

## Pipeline

```
discoverSeeds (sitemap.xml / fixture inventory)          orphans = known page, 0 inbound
        +                                                under-linked = inbound ≤ 2
BFS crawl (maxPages, maxDepth, same host)  ──► parse ──► topic keywords (TF, deterministic)
        │                                                        │
        └──────────────► node/edge graph ◄───────────────────────┘
                                │
                    buildRecommendations: on-topic (Jaccard ≥ 0.12) × not already linked
                    × target under-linked/orphan → priority(overlap, deficit, orphan boost)
                                │
                    optional LLM pass: rewrites anchor text only (gated on ANTHROPIC_API_KEY)
```

`discoverSeeds` is what makes orphan detection real — a page nothing links to
can't be reached by BFS from the root, so the crawler also seeds from
`sitemap.xml` (HTTP) or the full page set (fixture).

## Public API

`@Controller('projects/:projectId/link-graph')` — behind the global `JwtAuthGuard`.

| Method | Route | Notes |
|---|---|---|
| GET | `/` | list analysis runs |
| POST | `/` | `{ rootUrl?, maxPages?, maxDepth?, useLlm? }` → completed graph (nodes+edges+recs) |
| GET | `/:graphId` | full detail |
| GET | `/:graphId/recommendations` | `?status=open\|applied\|dismissed` |
| PATCH | `/:graphId/recommendations/:recId` | `{ status }` |
| DELETE | `/:graphId` | — |

`maxPages` 1–300, `maxDepth` 1–6 (DTO-validated). Recommendations capped at
`INTERNAL_LINK_LIMITS.maxRecommendations` (100), one per target from its best source.

## Guards

| Guard | Effect |
|---|---|
| `maxPages` / `maxDepth` DTO bounds + `INTERNAL_LINK_LIMITS` clamp | crawl can't run away |
| All fetches via `FetcherService` | central per-domain rate limit + `FetchLog` accounting |
| `useLlm` without `ANTHROPIC_API_KEY` → **503** | no silent skip |
| `fixture://` root → **400** unless `INTERNAL_LINK_ALLOW_FIXTURE=1` | offline test scaffolding stays out of prod |

## Environment

```
INTERNAL_LINK_MAX_PAGES=50
INTERNAL_LINK_LLM_MODEL=claude-opus-5   # anchor-copy refinement only; reuses ANTHROPIC_API_KEY
#INTERNAL_LINK_ALLOW_FIXTURE=1          # offline smoke harness — enables fixture:// roots
```

## Design alignment

| Item | Status |
|---|---|
| Agent #8 "Internal-Link Agent — continuously improves topical architecture" | ✅ graph + orphan/under-linked detection + ranked recs |
| Client-site only (no third-party crawl) | ✅ root defaults to project domain; fetches via FetcherService |
| Deterministic by default, LLM optional | ✅ TF keywords + Jaccard; LLM only rewrites anchor copy |

## Testing

`bash smoke/internal-link.smoke.sh` (backend up, `INTERNAL_LINK_ALLOW_FIXTURE=1`, no keys) — **23/23 pass** (2026-08-30):

- crawls the 6-page fixture incl. the sitemap-seeded orphan; 9 edges captured
- **exactly 1 orphan** detected and it is `/blog/2026-ai-search-study`
- topic keywords extracted; home page outbound count = 4
- 3 recommendations — the orphan is a target; all well-formed (overlap ≥ 0.12, anchor, reason, integer priority, `from ≠ to`); sorted by priority desc; **none duplicates an existing edge**
- recommendation lifecycle: PATCH → `applied`, status filter works, invalid status → **400**
- `useLlm` without key → **503**; `maxPages: 9999` → **400**
- re-run is byte-stable (same pages / orphans / recommendation count)
