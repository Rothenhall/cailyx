# Analysis — Site Context Pipeline v2, Phase 2

> Requested: 2026-09-22, user directive — "yeah please build it," following
> from `docs/analysis/site-context-v2.md` (Phase 1)'s own "Next steps":
> "Scope and approve Phase 2 (social/external enrichment, research agent,
> independent verifier) as its own decision when the user is ready for it."
> Builds the four items Phase 1 explicitly deferred, against the same pasted
> 23-step spec (`website-to-company-context-workflow.md`).

## What it does

Extends `AeoContextService` (`backend/src/modules/aeo-audit/aeo-context.service.ts`)
with four new capabilities, each **opt-in** (never triggered by a plain
`build()`/`resume()` call — matches this codebase's existing pattern for any
paid/external action, e.g. `collectNew` on competitor discovery):

1. **Social-discovery fallback + verification** (spec §14–16) — when a known
   platform (LinkedIn, X, Instagram, etc.) has no confirmed `PresenceAccount`
   after Phase 1's read-only merge, search for candidates and score them
   against the spec's point-based verification table (official-site backlink
   +45, exact domain match +40, personal/unrelated account −50, etc.), landing
   each candidate at `verified` (80–100) / `probable` (60–79) / `possible`
   (40–59) / `rejected` (<40). Ambiguous candidates (deterministic evidence
   inconclusive) get one LLM entity-match call — never open-ended research.
2. **External company enrichment** (spec §17) — targeted searches for HQ,
   founding year, founders/leadership, funding/ownership, press coverage —
   kept as a distinct `source: 'external'` fact, never merged into first-party
   facts until consolidation, per the spec's own ordering rule.
3. **Bounded gap-research agent** (spec §19) — after category consolidation,
   build a gap list of missing high-value fields (per-category
   `missingFields`, already computed in Phase 1) and run a small number of
   targeted searches against *only* those fields — never a "find everything"
   pass. Hard caps: max searches, max pages fetched, explicit stop condition.
4. **Independent verification pass** (spec §21) — a second LLM call,
   separate from extraction, that checks each fact's cited excerpt actually
   supports the claim, flags claims about a customer/partner rather than the
   subject, and separates current vs. historical/first-party vs. third-party
   facts. Unsupported claims are downgraded or dropped before the context is
   returned. Per the spec's own allowance ("if only one model is available,
   use a separate call... treat as secondary review"), this runs as a second
   OpenRouter call with a distinct verifier-only prompt — not a second vendor.

## Tool/technology decision

**No new external vendor** — same philosophy as Phase 1. Reuses two services
already paid for and live in this codebase:

| Need | Tool | Status | Cost |
|---|---|---|---|
| Social-candidate search (§15), external-enrichment search (§17), gap-research search (§19) | `DataForSeoSerpService.search()` (`serp-intelligence/dataforseo-serp.service.ts`) | Already integrated, already has real credentials (`DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`), already cost-tracked per call, already cached | ~$0.002–0.006/query (billed per-10-results; exact rate per DataForSEO's live pricing) |
| Ambiguous social-candidate matching (§16), external-fact extraction (§17), gap-research extraction (§19), independent verifier (§21) | `AeoLlmService.json()` (`aeo-audit/aeo-llm.service.ts`) | Already integrated, OpenRouter primary / Anthropic fallback, cost reported per call | Small — same cheap model class Phase 1 already uses per call |

No alternative options considered/needed: introducing a second search vendor
(e.g. Serper, the actual "SerpAPI" product) or a dedicated company-data API
(Clearbit, Crunchbase, Apollo) would duplicate infrastructure this project
already pays for and already gates by the same budget/cache discipline, for
no capability this workflow needs that DataForSEO's SERP results can't cover.

## Budget & gating

Real, metered spend (DataForSEO) starts the moment any of these four stages
run, so — mirroring `collectNew` on `/competitors/discover/market` and the
AEO audit's own pre-flight `/budget` endpoint —

- Every new stage is **off by default**. `POST /aeo/context` and
  `context/runs/:id/resume` gain an opt-in body flag,
  `phase2: { social?: boolean; externalEnrichment?: boolean; gapResearch?: boolean; verify?: boolean }`
  (independent verification, §4 above, costs only an LLM call and is safe to
  default `true` once implemented — everything DataForSEO-backed stays opt-in).
- Gap-research (§19) gets its own hard caps, per the spec's own requirement:
  `maxSearches` (default 5), `maxPagesPerGap` (default 2), scoped to fields
  `SiteContextCategorySummary.missingFields` actually lists — never a general
  research pass.
- A pre-flight cost estimate, matching the AEO audit's `/aeo/budget` pattern,
  so an operator sees the expected DataForSEO spend before opting in.

## Database changes

- `SiteContextFact.source` (new) — `'first-party' | 'external'`, default
  `'first-party'` for every existing row. Keeps §17's "never merge external
  into first-party facts until consolidation" rule enforceable, not just
  documented.
- New model `SiteContextSocialCandidate` — one row per (run, platform,
  candidate URL): the query that found it, the verification score and its
  component breakdown, status (`verified`/`probable`/`possible`/`rejected`),
  and the LLM judgment call's id when one ran. Confirmed candidates promote
  into `PresenceAccount` (digital-presence module) the same way an operator
  confirming a first-party-discovered account already does today — reuses
  that existing confirm path rather than inventing a second one.
- `SiteContextRun`: `searchesUsed`, `searchCostUsd`, `verifierCostUsd` (new) —
  spend tracking for the two new metered stages, alongside the existing
  `pagesSpent`/`requestsSpent`/`elapsedMs` budget columns.
- Applied to both `prisma/schema.prisma` and `prisma/schema.production.prisma`
  identically, per that file's own header instruction (same as Phase 1).
  `prisma db push` against local dev Postgres for now — Phase 1's note about
  production migration generation being blocked on the pre-existing
  migration-lock/provider drift still applies and is unrelated to this work.

## Build order

One stage at a time, each independently testable, cheapest/lowest-risk first:

1. Independent verifier (§21) — no schema change, no new paid call, pure
   quality improvement on data Phase 1 already produces.
2. External enrichment (§17) — needs the `SiteContextFact.source` column.
3. Social-discovery fallback + verification (§15–16) — needs the new
   `SiteContextSocialCandidate` model; largest single piece.
4. Bounded gap-research agent (§19) — built last since it composes the other
   three (search like §17, verify like §21, and reuses whatever social
   candidates §15–16 already scored).

## What's still out of scope

- Franchise/regional-site multi-location identity resolution (Phase 1 already
  flagged this as needing evidence this pipeline doesn't gather).
- Re-running the AEO stance-judging model benchmark (Phase 1's own carried-
  over next step, unrelated to this work).
- Migrating `persona`/`content`/`growth-execution`/`keyword-research` onto
  `BusinessProfileService.getConfirmedProfile()` (Phase 1's "make this the
  base for everything" goal — a separate, larger migration).
