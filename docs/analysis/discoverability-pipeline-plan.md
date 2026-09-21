# Implementation Plan — Full Discoverability Pipeline

> Source: user-provided workflow doc (Claude Docs artifact `214b1af5-1391-4772-9997-22125878348e`),
> 5 tabs: Complete Workflow Order, Website-to-Company Context Enrichment Workflow,
> Competitor Analysis Workflow, Prompt Set Construction, Brand Voice Extraction Workflow.
> This plan covers everything still needed after Site Context v2 Phase 1
> (`docs/analysis/site-context-v2.md`, shipped 2026-09-22).

## The loop, restated

```
1. Site Context (DONE — Phase 1)
2. Light competitor discovery (keyword/category + comparison search only)
3. Build & run prompts (buckets → prompts → multi-platform execution)
4. Complete competitor build (mine answers → score/rank top 5 → enrich → matrix)
   4 ─╌ new competitors found ╌→ 3 (one more targeted round)
```

Brand voice is a separate branch, gated on verified social profiles (digital-presence),
not part of the numbered loop.

**Headline finding from reading the actual code**: Cailyx is much further along on
Stage 3 than the earlier conversation assumed — `aeo-audit.types.ts`'s `PromptDimension`
enum is a near-verbatim match to the spec's 10 seed buckets (same names, same example
patterns, down to the code comments). The gaps here are specific and narrow, not
"doesn't exist." Stage 2 and brand voice have more real gaps. Stage 4 has one
deliberate, previously-documented scope exclusion that needs a decision, not just code.

---

## Stage 2 — Light Competitor Discovery

**Module**: `competitors/competitors.service.ts::discoverByMarket`

**What exists**: a free pass (mines stored `AeoAudit.verdict` + `SerpResult`, no cost)
and a paid pass gated behind `collectNew: true` that composes queries as
`"<service> in <market>"` or `"best providers in <market>"` through
`SerpIntelligenceService.serpForDiscovery`, then classifies results as
`direct-competitor`/`adjacent-alternative` and writes `Competitor(status: 'candidate')` rows.

**Gap vs spec (§6.1, §6.4)**: the query patterns don't include the comparison/alternatives
forms (`"X" vs`, `"X" alternatives`, `best alternatives to "X"`) or review-site category
listings (G2/Capterra category page pull). These matter specifically for Stage 2's job —
seeding *branded* competitor names for Stage 3's head-to-head/competitor-alternatives
buckets — because the current query set only ever surfaces domains that rank organically
for generic service+market terms, never a domain that shows up specifically because
someone compared it to a *named* competitor (there's a chicken-and-egg problem here:
comparison queries need at least one seed name to compare against, which is why the spec
places `6.4` — name-independent keyword/category search — before `6.1`).

### Steps
1. Add `6.4`-style patterns first (name-independent): `best [service] tools for [ICP]`,
   `[service] for [industry]`, `[service] vendors [market]` — derive `[service]`/`[ICP]`/
   `[industry]` from `businessProfile.getConfirmedProfile()` (already read in this method)
   rather than the current two topic sources (services/segments only).
2. Once `raw` has at least one candidate domain/name from pass 1 (this run's own results,
   not a separate stored list), add one `"<name>" alternatives` / `"<name>" vs` query per
   newly-found candidate, bounded by the existing `MAX_MARKET_QUERIES` budget — this
   directly implements the spec's comment that comparison searches work best once a name
   exists to compare against.
3. Add a review-site category pull as a new evidence kind (`review-site-category`),
   reusing whatever HTTP fetch pattern `serp-intelligence`/`fetcher` already has —
   **no new external tool**, since this is just fetching a public category listing page,
   same trust level as an organic SERP result.
4. Tag results from steps 1–3 with distinct `evidenceKind`s so Stage 4's later scoring
   (see below) can weight them correctly — this module already does this pattern
   (`aeo-verdict` / `serp-snapshot` / `serp-live-search`), just needs the new kinds added.

**Effort**: small, contained — extends one existing method, no schema change, no new
external dependency. Good candidate to build first since Stage 3 depends on its output
for branded-bucket seeding.

---

## Stage 3 — Build & Run the Prompts

**Modules**: `aeo-audit/aeo-matrix.generator.ts` (deterministic cell builder),
`aeo-audit/aeo-matrix.service.ts` (optional LLM phrasing pass), `query-set/*`,
`measurement/*` (multi-platform execution — already confirmed working: 3-engine
multi-surface audits pass their smoke suite today).

**What exists and already matches the spec closely**:
- The exact 10-bucket taxonomy (`PROMPT_DIMENSIONS`), with per-dimension funnel stage,
  persona, and branded/unbranded tagging — this *is* the spec's seed taxonomy table.
- "Dimensions whose inputs are missing are skipped honestly rather than filled with
  invented values" (`aeo-matrix.generator.ts`'s own docblock) — matches the spec's
  "not supported → drop the bucket" rule.
- Multi-platform execution (ChatGPT/Claude/Gemini/etc. via `measurement`) already works.

**Real gaps found by reading `aeo-matrix.generator.ts`**:
1. **No LLM-discovered buckets beyond the fixed 10** (spec §3.3) — the taxonomy is
   closed. A company with a distinctive delivery model, certification, or compliance
   angle never gets a bucket for it.
2. **`objection-trust` is branded-only** (`DIMENSION_BRANDING['objection-trust'] =
   'branded'`) — the spec explicitly wants both a branded variant ("is {client} legit")
   *and* an unbranded variant ("downsides of {category}") tagged individually within
   the same bucket. Currently only the branded half is ever generated.
3. **No cross-bucket deduplication** — grepped for dedup/duplicate logic in both files,
   found none. Two dimensions can independently produce near-identical phrasing (a
   `problem-framed` prompt and a `job-to-be-done` prompt converging on the same wording)
   and both survive into the run.
4. **No coverage-gap report** — nothing computes "services/industries/geos with zero
   prompts," the spec's §5.3 validation. `DIMENSION_WEIGHTS`-based allocation gives each
   dimension a *proportional* share of a tier budget, but doesn't check whether every
   confirmed service/industry/geo the business profile lists actually got a prompt
   somewhere in the set.

### Steps
1. **Fix `objection-trust` branding** — smallest, highest-value fix. Split it (and
   check whether any other dimension the spec calls "inherently mixed" needs the same
   treatment) into generating both variants, each with its own `branding` tag, instead
   of a single fixed value per dimension. Contained to `aeo-matrix.generator.ts`'s
   template/interpolation logic — no schema change (a `MatrixCell` already carries its
   own `branding` field per-cell, not per-dimension, so this is a generator bug, not a
   data-model gap).
2. **Add a coverage-check pass** after generation: compare confirmed
   `services`/`icp`/`markets` (from the site-context-v2 work) against what actually
   got interpolated into a generated prompt, and surface a `coverageGaps` list on the
   matrix result — mirrors the exact pattern `aeo-context.service.ts`'s own coverage
   flag already uses for page selection.
3. **Add cross-bucket dedup** — a normalize-and-compare pass over the final cell list
   before it's persisted as a `QuerySet`. Given the existing `normalize(prompt)` helper
   already exists in the generator (currently used for slot-fill checking, not dedup),
   this is an extension of existing code, not new machinery.
4. **LLM-discovered buckets beyond the fixed 10** — the biggest of the four, and the
   one most worth a deliberate go/no-go: it changes `PromptDimension` from a closed
   enum to an open set, which several other places in the codebase key off of directly
   (`DIMENSION_LABELS`, `DIMENSION_STAGE`, `DIMENSION_PERSONA`, the stance service's
   `dimensionsForRun`). **Recommend scoping this as its own follow-up decision** once
   1–3 are shipped and verified, rather than bundling a taxonomy-widening change into
   the same pass as three bug fixes.

**Effort**: 1–3 are small/contained; 4 is a real design decision.

---

## Stage 4 — Complete Competitor Build

**Modules**: `aeo-audit/aeo-stance.service.ts` (mention mining — already exists),
`competitors/competitors.service.ts` (candidate promotion, profiling — already exists).

**What exists**: `aeo-stance.service.ts::judgeOne` already extracts `otherNamesSeen`
per observation (competitor names an AI answer surfaced that weren't already known),
and — since `stance` is recorded per observation as `recommended-primary` /
`recommended-alternative` / `mentioned-neutral` / `mentioned-negative` / `absent` — the
absence-vs-co-mention distinction the spec wants is **already implicitly present** in
the data (an `absent` stance + `otherNamesSeen` populated = an absence-competitor
signal; any other stance + `otherNamesSeen` populated = a co-mention signal). It is
just never aggregated that way.

**Real gaps** (confirmed against `competitors/SPEC.md`'s own "Explicitly not built"
section, not new findings):
1. **No weighted ranking/scoring.** Candidates get a binary relevance label
   (`direct-competitor` / `adjacent-alternative`) via evidence-kind counting, never a
   composite score, never capped to a top N.
2. **No per-competitor full company-context enrichment.** `SPEC.md` §"Explicitly not
   built (D4)" says outright: competitor profiles only get a tech/schema/SERP/AEO diff,
   never a real crawl. The spec's Step 5 wants each top-5 competitor to get the *same*
   Stage-1 pipeline run against its own domain.

### Steps
1. **Build the absence/co-mention aggregation.** New read-only aggregation over
   `AeoStance` rows (already stored) grouped by the `otherNamesSeen` name: count total
   mentions, split by whether the paired observation's `stance` was `absent` (absence
   signal, weight higher) vs. anything else (co-mention signal), count distinct
   platforms/surfaces, track prompt diversity (distinct `dimension` values), average
   position where derivable. This is pure aggregation over existing data — no new
   extraction, no new LLM call, no schema change beyond maybe one new read-model type.
2. **Implement the weighted composite score** (spec §7's exact weights: platform
   coverage 30%, absence-mentions 25%, co-mention 15%, position 15%, prompt diversity
   10%, external-discovery corroboration 5% — the last one uses Stage 2's new
   `evidenceKind`s). Rank descending, apply the `min_platform_coverage` floor (relax +
   flag if too few candidates clear it), select top N (default 5), keep 6th–15th as an
   explicit watchlist rather than discarding.
3. **Decision needed from the user before building this part**: does per-competitor
   full company-context enrichment belong inside `competitors` module now (reversing
   the explicit D4 "not built" decision), or should the top-5 ranked list simply be
   handed to `aeo-context.service.ts::build()` once per competitor domain as an
   *external caller*, keeping `competitors` itself unchanged in scope? The second
   option is less invasive and reuses Phase-1 site-context work directly; the first
   would need `competitors`' own schema/API surface redesigned. **Recommend the second**
   — call `AeoContextService.build(syntheticProjectId-or-domain-scoped-run, ...)` once
   per top-5 competitor domain from a new orchestration step, store the resulting
   `SiteContext` id on `CompetitorProfile`, and leave `competitors.service.ts`'s own
   scope/SPEC.md unchanged. Needs your confirmation either way since it's the one real
   architecture fork in this whole plan.
4. **Comparative positioning matrix** (spec §9) — once #3 is resolved, this is a
   straightforward diff/table builder over the client's own `SiteContext` +
   `BusinessProfile` and each competitor's, following the spec's exact dimension table
   (positioning, ICP, pricing, differentiators, geography, discoverability score,
   "where they beat us" / "where we're co-considered" from the lost-prompt lists).
5. **The loop-back**: if step 2's ranking surfaces competitors Stage 2 never seeded,
   feed their names back into a targeted Stage 3 prompt round (new head-to-head/
   competitor-alternatives cells for just those names) and re-run step 1–2 to confirm —
   this is orchestration (a controller/service method that calls Stage 3's matrix
   generator with an explicit competitor list, then re-runs stance judging), not new
   extraction logic.

**Effort**: 1–2 are contained aggregation/scoring work. 3 is the one real decision
point in this entire plan. 4–5 depend on 3 being resolved first.

---

## Brand Voice (branch, gated on digital-presence verification)

**Modules**: `digital-presence/presence.apify.service.ts` (scraping),
`presence.brand-voice.service.ts` (synthesis), `writing-style/writing-style.service.ts`
(downstream consumer).

**Real gap found by reading the code — this one matters**: `presence.service.ts`'s
`socialActivity()` method (the Apify scrape trigger) filters accounts with
`state: { not: 'candidate' }` — this includes both `confirmed` **and** `unverified`
accounts. The spec's Quality Rule #1 is explicit: "Only scrape channels that cleared
identity verification... never an unverified or merely-possible profile." Scraping an
unverified account risks building a "brand voice" from a different company's posts
entirely.

**Other gaps in `presence.brand-voice.service.ts`**:
- The "deterministic" layer is just grouping captions by platform and counting them —
  far short of the spec's §6 statistical profile (sentence length, emoji usage rate +
  top emoji, hashtag stats, exclamation/question rate, first/second-person rate, CTA
  presence rate, all-caps rate) and §6.3's n-gram recurring-phrase extraction. The LLM
  synthesis pass currently has no statistical grounding to check its output against.
- No test-generation validation pass (spec §10) and no human sign-off status
  (`draft`/`reviewed`/`approved`) — `BrandVoiceResult.extraction` only distinguishes
  `llm-synthesized` vs `insufficient-data`, nothing about whether a human has confirmed
  it's usable for real content.

### Steps
1. **Fix the verification-status filter first** — ✅ **DONE 2026-09-22.** Changed
   `socialActivity()`'s query (`presence.service.ts` ~line 586) from
   `state: { not: 'candidate' }` to `state: 'confirmed'`. Verified the actual state
   vocabulary before choosing the filter: these accounts are
   `candidate | unverified | needs-confirmation | confirmed` (no `probable`/`verified`
   alias exists here), so `confirmed` is the only cleared-verification state and a plain
   equality is correct (not `{ in: [...] }`). Left the sibling `state: { not: 'candidate' }`
   query at ~line 216 untouched — it's a SERP-sweep dedup set (which platforms are already
   held), where counting a found-but-unverified account is correct, not a second scrape bug.
   **Verified live against the prod DB** (Docker unavailable this session; service/DB-level
   test, not the shell smoke suite — see note): seeded a labelled test project with all four
   account states, confirmed the fixed query returns only the 1 `confirmed` account while the
   old filter returned 3 (confirmed + unverified + needs-confirmation). `npx tsc --noEmit`
   clean. Cleaned up the test project.
   > **Verification-method note:** the shell smoke suites (`digital-presence.smoke.sh`, etc.)
   > log in as the dev fixture admin `smoke@cailyx.test`, which does **not** exist on the
   > prod DB (and creating a test admin in prod was declined). So this plan's steps are
   > verified with targeted service/DB-level tests against prod + `tsc`, not the shell smoke
   > suites, for as long as verification runs against prod rather than a local Postgres.
2. **Add the deterministic statistical layer** — pure computation over already-stored
   `PresencePost.caption` text (sentence/word counts, regex-based emoji/hashtag/
   exclamation/question counting, simple person-pronoun regex, n-gram frequency for
   recurring phrases). No new dependency; this is the same "deterministic pass before
   any LLM call" discipline `aeo-context.service.ts` already follows.
3. **Feed the stats into the LLM synthesis prompt as grounding context** (spec §7,
   "the actual clean post text plus the Step 3 statistics") — extends the existing
   `runSynthesis` prompt rather than replacing it.
4. **Split output into explicit core-voice vs. platform-register fields** with a
   `variationFromCore` note per platform, rather than the current flat
   `tone`/`themes`/`byPlatform` shape — a schema/type change to `BrandVoiceResult`.
5. **Add the validation/sign-off gate**: a test-generation call (reuse
   `writing-style`'s or `content-generation`'s existing generation path with the new
   guide as the style input), a fidelity check against the Step-2 statistics, and a
   `signoffStatus: 'draft' | 'reviewed' | 'approved'` field that gates whether
   `writing-style`/`content-generation` are allowed to treat this guide as usable.

**Effort**: 1 is a one-line-ish fix that should ship on its own, immediately, given
it's a real data-integrity risk, not a feature gap. 2–3 are a contained deterministic
layer + prompt update. 4–5 are a genuine schema/workflow addition.

---

## Recommended build order

Per AGENTS.md's "one module at a time," in priority order:

1. **Brand-voice verification-status fix** — ✅ **DONE 2026-09-22** (see Brand Voice step 1).
   `socialActivity()` now scrapes only `confirmed` accounts. Verified live vs prod DB, tsc clean.
2. **Stage 3 fix #1** (`objection-trust` branding split) — small, independent, ships fast.
3. **Stage 2** (competitor discovery query patterns) — needed before Stage 4 scoring can
   use `evidenceKind` diversity meaningfully, and before Stage 3's branded buckets have
   good seed names.
4. **Stage 3 fixes #2–3** (coverage-gap report, cross-bucket dedup).
5. **Stage 4 steps 1–2** (absence/co-mention aggregation + weighted ranking) — the
   biggest net-new logic in this plan, but pure aggregation over data that already exists.
6. **Decision point**: Stage 4 step 3 (per-competitor enrichment scope) — needs your
   answer before 4–5 can be built.
7. **Brand-voice steps 2–5** (statistical layer, core/register split, validation gate).
8. **Stage 3 fix #4** (LLM-discovered buckets) — deferred as its own follow-up decision
   given the taxonomy-widening blast radius.

Each of 1–5 and 7 is scoped to fit AGENTS.md's "analysis before code" discipline as a
contained change to one existing module; none of them need a new external tool/vendor
decision. Only step 6 is a real architecture fork requiring your input before code.
