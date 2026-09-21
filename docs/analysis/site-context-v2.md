# Analysis — Site Context Pipeline v2 (Phase 1)

> Approved: 2026-09-21, user directive — "Just go ahead and implement this."
> Context that shaped this doc: the user wants `SiteContext` to become the
> single reusable company-context foundation for every Cailyx workflow
> (content generation, keyword research, blog topics, personas, competitors —
> "the base for anything that will be done inside Cailyx"), not just an
> AEO-audit input as it was originally built. The target pipeline shape came
> from a pasted external workflow spec (23 steps, `website-to-company-context-
> workflow.md`); this doc scopes what of that spec Phase 1 actually builds.

## What it does

Reworks `AeoContextService` (`backend/src/modules/aeo-audit/aeo-context.service.ts`)
— the staged, resumable, budget-bounded crawl-and-extract pipeline that
produces `SiteContext` — to close the highest-value gaps against the pasted
spec, without pulling in new external vendors or a materially different
execution model (that's Phase 2).

## Tool/technology decisions

No new external tool, library, or paid API. Everything below reuses
infrastructure already approved and in use elsewhere in the codebase:

| Need | Tool | Status |
|---|---|---|
| JSON-LD / schema.org parsing | `cheerio` | Already a dependency; previously used for headings/meta only |
| Page fetch incl. JS-rendered | `FetcherService.render()` | Already used |
| LLM extraction/consolidation | `AeoLlmService` (OpenRouter, `deepseek/deepseek-v4.1-flash` default) | Already used — more calls, same client |
| Sitemap/robots discovery | `FetcherService.fetch()` | Already used — more paths tried |
| Confirmed social profiles | Direct read of `PresenceAccount` (digital-presence module's table) | Read-only merge, no new dependency, no cross-module service coupling |

## What was built (Phase 1)

1. **JSON-LD/schema.org parsing** (spec §9) — new stage-2 extraction of
   `Organization`/`LocalBusiness`/`Corporation`/`Brand`/etc. blocks, kept as
   evidence (`SiteContextRunPage.jsonLd`), turned into cited facts
   (`legalName`, `alternateName`, `foundedYear`, `headquarters`, `contact`,
   `award`, `leadership`, `brand`) in stage 4's deterministic pass.
2. **Expanded fact taxonomy** (spec §11) — `FactField` grew from 10 to 25
   values, covering identity, geography, organization, credibility, go-to-
   market and technology categories the pre-v2 pipeline had no room for.
   The LLM extraction prompt gained explicit per-field guidance for every
   field that previously had none (`painPoints`, `outcomes`, `category`,
   `vertical`, plus all the new fields).
3. **Fact type + confidence scoring** (spec §13) — every fact now carries
   `factType` (`explicit | strong_inference | weak_inference | conflicted`,
   the LLM's own classification, validated against a closed enum) and a
   `confidence` score computed from factType + citing-page authority +
   cross-source corroboration — never the LLM's bare self-report alone.
4. **Category-level consolidation** (spec §18) — new stage 7
   (`stageConsolidate`), producing one `SiteContextCategorySummary` row per
   category (identity, descriptions, offerings, positioning, customers,
   geography, organization, credibility, go_to_market, technology) with a
   summary, conflicts, and a missing-fields list. Bounded to one LLM call
   per run (batched across categories) rather than the spec's literal
   "one call per category," to keep a run's total LLM call count bounded.
5. **Identity resolution** (spec §2, narrow) — a conservative heuristic
   flags when the site's own declared legal/brand name shares no word with
   the Cailyx project name on record (`identityType: 'subsidiary'`) versus
   matching (`'company'`) versus no signal at all (`'unknown'`). Confirmed
   correct in live testing against basecamp.com → 37signals LLC.
   Franchise/regional-site detection is explicitly **not** attempted — it
   needs multi-location evidence this pipeline doesn't gather.
6. **Digital-presence merge** — `compile()` reads confirmed `PresenceAccount`
   rows (read-only) into `SiteContext.socialProfiles`, so a consumer gets
   one object instead of having to separately query two modules.
7. **Weighted completeness/confidence scoring** (spec §22) — per-category
   completeness (1 − missingFields/totalFields) plus a fixed-weight overall
   score (identity 15%, offerings 15%, customers 15%, positioning 10%,
   geography 10%, credibility 10%, digital_presence 5%, organization 5%,
   go_to_market 5%, technology 5%, descriptions 5%).
8. **Broader discovery** (spec §3) — `robots.txt` `Sitemap:` directives tried
   before guessed paths; added `sitemap_index.xml`/`wp-sitemap.xml`/etc.
   fallbacks; expanded page classification from 12 to 17 types (added
   leadership, security, press, careers, partner).

## Database changes

- `SiteContextRunPage.jsonLd` (new) — raw parsed JSON-LD entities.
- `SiteContextRunPage.pageType` — same column, more string values (no migration).
- `SiteContextFact.factType`, `SiteContextFact.confidence` (new).
- `SiteContextFact.field` — same column, more string values (no migration).
- `SiteContext.identityType`, `identityConfidence`, `completeness`,
  `overallCompleteness`, `socialProfiles`, `facts` (new — the last is a
  generic bag for the 15 new field categories, avoiding 15 more named columns).
- New model `SiteContextCategorySummary` (one row per run per category).

Applied to `prisma/schema.prisma` and `prisma/schema.production.prisma`
identically (kept byte-for-byte in sync per that file's own header
instruction). **`prisma/schema.postgres.prisma` was left untouched** — its
own header says it's a SQLite→Postgres migration mirror, and `schema.prisma`
itself switched to Postgres directly as of 2026-09-16, so that file looks
stale/dead; flagged for the user to confirm before anyone deletes it.

No `prisma migrate` file was generated: `prisma/migrations/migration_lock.toml`
still says `provider = "sqlite"` while both schema files target Postgres —
a pre-existing drift this work did not create and did not attempt to fix
(regenerating migration history is a repo-wide, deploy-affecting decision).
Schema changes were applied to the local dev Postgres via `prisma db push`
for development/testing; **production still needs a proper migration
generated against a clean baseline before this ships**, which is blocked on
that pre-existing migration-lock mismatch being resolved first.

## Bug found and fixed during implementation (not scoped, but load-bearing)

`AeoLlmService`'s OpenRouter call had no `reasoning: { enabled: false }` flag.
`deepseek/deepseek-v4.1-flash` (the module's current default model) is a
reasoning model that can spend its entire `max_tokens` budget on hidden
chain-of-thought before writing any content, returning an empty message that
this service reported as "model returned non-JSON." Confirmed live via a
direct OpenRouter call (162 reasoning tokens on a call that should have taken
~20). This was silently degrading or failing *any* call in this module whose
prompt was long/hard enough to trigger heavy reasoning — not just the new
Phase 1 code — predating this work. Fixed by disabling reasoning
unconditionally on every call this service makes.

## Explicitly excluded from Phase 1 (deferred to Phase 2)

- Social profile discovery/verification/SerpAPI fallback (spec §14–16) beyond
  the read-only merge in item 6 above.
- External company enrichment — HQ, founders, funding, press (spec §17).
- Bounded research agent for unresolved gaps (spec §19).
- Independent second-pass LLM verifier (spec §21) — Phase 1 keeps the
  existing deterministic verbatim-excerpt-match validation, which is stronger
  than an LLM self-check for what it covers.
- Re-running the stance-judging model benchmark (`aeo-llm.service.ts`'s own
  docblock has flagged this as outstanding since 2026-09-13) — the reasoning
  fix above is necessary but not sufficient to fully re-trust the model
  choice; still recommended as the next thing to check.

## Verification performed

- `npx tsc --noEmit` — zero errors across the whole backend.
- Live end-to-end run against `basecamp.com` (real site, real OpenRouter
  call): correctly extracted `legalName: "37signals LLC"`,
  `leadership: "Jason Fried, Co-founder & CEO"`, `businessModel`,
  `pricingModel`, `differentiator`; correctly flagged `identityType:
  "subsidiary"` (Basecamp *is* legally 37signals LLC — a real, accurate catch
  of exactly the kind of identity subtlety spec §2 wanted); category
  consolidation produced accurate, well-formed per-category summaries;
  fact-level `factType`/`confidence` populated correctly (0.9 for a
  corroborated fact, 0.85 for a single-source one); JSON-LD-sourced facts
  passed stage-6 verbatim validation.
- Existing automated smoke suites re-run with no regressions:
  `aeo-context-staged.smoke.sh` (44/44), `aeo-audit.smoke.sh` (59/59, 1
  intentional skip), `competitors.smoke.sh` (20/20),
  `competitors-unified.smoke.sh` (33/33).
- Found and fixed a real gating bug during smoke-test verification:
  `stageConsolidate` initially ignored `run.refine: false` and would have
  called the LLM anyway when facts existed — inconsistent with `stageExtract`'s
  contract and would have broken the "this run never calls an LLM" guarantee
  the smoke suite depends on. Fixed before it shipped.

## Next steps (not yet done)

- Generate a real Postgres migration once the migration-lock/provider drift
  is resolved (needs a decision from the user or whoever owns deploy).
- Re-run the AEO stance-judging benchmark now that the reasoning-token bug
  is fixed, to fully re-validate the 2026-09-13 model swap.
- Migrate `persona`, `content`, `growth-execution`, and `keyword-research` off
  raw `Project` columns onto `BusinessProfileService.getConfirmedProfile()` —
  the actual "make this the base for everything" work, which depends on
  Phase 1's richer `SiteContext` flowing into a confirmed `BusinessProfile`
  worth reading.
- Scope and approve Phase 2 (social/external enrichment, research agent,
  independent verifier) as its own decision when the user is ready for it.
