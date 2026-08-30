# Authority Module (Swarm layer — Agent #6)

> **Status:** ✅ Built and e2e-verified (2026-08-30, SERP fixture + citation discovery — 22/22 assertions)
> **Layer:** Swarm
> **Depends on:** `serp-intelligence` (gated SERP provider), `mention-tracking` (promotion target), `database`, `config`

## Purpose

Finds **legitimate publications, communities, podcasts, directories, and
newsletters** where the client could earn an unpaid mention or link, ranks them
by relevance, and lets an operator **promote** chosen ones into the
`mention-tracking` outreach ledger.

**Boundary:** discovery + drafting only. This module never contacts anyone,
never creates accounts, and never posts. `mention-tracking` stays "manual by
design" — Authority just fills its inbox.

## Discovery methods (combinable — `method`)

| Method | Source | Gate |
|---|---|---|
| `serp` | "best `<category>`" / listicle SERPs via the gated `serp-intelligence` provider — keeps ranking domains + AI-Overview reference domains | live SERP needs `SWARM_ALLOW_LIVE=1` + creds; fixture needs `SERP_ALLOW_FIXTURE=1` |
| `citations` | domains that AI answers already cite in this project's **journeys** + **measurement** runs | none |
| `llm` | Claude lists real publications/communities/podcasts for the category | `ANTHROPIC_API_KEY` → else 503 |
| `combined` (default) | `serp` + `citations` (+ `llm` if `useLlm`) | — |

Every candidate is **excluded if it is the client domain, a direct competitor
domain, or a junk host** (search engines, social networks). Candidates are
classified (`classify()`) into `listicle / community / podcast / publication /
directory / newsletter` and scored for `relevance` (0–1) from category-term
match, SERP rank, and type.

## Promotion

`POST /:scanId/candidates/:candidateId/promote` calls
`MentionTrackingService.createTarget(...)` → a `MentionTarget` (status `new`,
type mapped to `listicle/community/other`), records `promotedTargetId` on the
candidate, and bumps `AuthorityScan.promotedCount`. Re-promoting → **409**.

## Public API

`@Controller('projects/:projectId/authority-scans')` — behind the global `JwtAuthGuard`.

| Method | Route | Notes |
|---|---|---|
| GET / POST | `/` | list / run `{ category?, method?, listicleQueries?, useLlm? }` |
| GET | `/:scanId` | detail + ranked candidates |
| PATCH | `/:scanId/candidates/:candidateId` | `{ status: new\|promoted\|dismissed }` |
| POST | `/:scanId/candidates/:candidateId/promote` | → `{ candidate, target }` |
| DELETE | `/:scanId` | — |

`AUTHORITY_LIMITS`: ≤ 60 candidates, ≤ 8 listicle queries.

## Environment

```
AUTHORITY_LLM_MODEL=claude-opus-5    # method=llm / useLlm only; reuses ANTHROPIC_API_KEY
AUTHORITY_MAX_COST_PER_SCAN=1.50
```

## Design alignment

| Item | Status |
|---|---|
| Agent #6 "Authority Agent — finds legitimate publications, communities, podcasts, directories" | ✅ SERP + citations + optional LLM |
| Boundary: no automated outreach / posting / account creation | ✅ discovery only; promotion just creates a human to-do |
| Feeds the existing outreach ledger | ✅ promotes into `mention-tracking` MentionTarget |

## Testing

`bash smoke/authority.smoke.sh` (backend up, `SERP_ALLOW_FIXTURE=1`, no keys) — **22/22 pass** (2026-08-30):

- builds upstream journey citations, then runs a `combined` scan over 3 fixture keywords
- discovers ≥ 3 candidates; **none is the client or a direct competitor** (`acme-serp.example` / `profound.ai` / `peec.ai` excluded)
- every candidate well-formed; `reddit.com` → `community`; `searchengineland.com` discovered via SERP; a `citation:journey` candidate is present; sorted by relevance desc
- **promote** → MentionTarget created, candidate `promoted` + linked, target visible in the mention-tracking ledger; re-promote → **409**; dismiss → 200
- guards: `method=llm` without key → **503**; unknown method → **400**
- `serp`-only re-run also produces candidates
