# Opportunities Module

> **Status:** ✅ Built
> **Phase:** P07 — `platform_improvement_plan.md` §12.5–§12.7 (one canonical
> "idea" record, the observed-corpus keyword-gap engine, the opportunity →
> content conversion contract)
> **Spec:** this README is the module's first written spec — see also
> `backend/smoke/keyword-gaps.smoke.sh`.

## Purpose

One canonical `Opportunity` row per idea, and the keyword-gap engine that
feeds it. Answers: **within the keywords and queries this project has already
captured, where does a confirmed rival rank that this project does not?**

The honest boundary is part of the design, in the service's own header:

> `This is explicitly NOT a claim of discovering a rival's complete ranking
> universe — every gap is computed only within keywords/queries this project
> has actually captured (tracked SERP snapshots + keyword-research sets), and
> every result preserves the exact checked depth / query / location / device /
> capture date it came from.`

§12.6 says finding a rival's full ranking universe would require a data
capability this codebase does not have. So nothing here claims it.

## Architecture

```
opportunities/
├── opportunities.module.ts      # Nest module — imports GrowthExecution + KeywordResearch
├── opportunities.controller.ts  # 7 REST routes, all operator-only
├── opportunities.service.ts     # analyze / list / get / dismiss / reopen / convert
├── opportunities.types.ts       # OPPORTUNITY_ORIGINS, PositionStatus, OpportunityDto
├── dto/opportunities.dto.ts     # 6 validated DTOs
└── README.md                    # This file

backend/smoke/keyword-gaps.smoke.sh   # 47-assertion end-to-end proof
```

## Read-only by construction — `analyze()` triggers no paid call

`OpportunitiesService`'s constructor has exactly **two** collaborators:

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly growthExecution: GrowthExecutionService,
) {}
```

No `ConfigService`, no fetcher, no HTTP client, no SERP provider, no
`SerpIntelligenceService`, no `AeoAuditService`. `analyze()` issues only
`this.prisma.<model>.find*` reads plus writes to `Opportunity` itself, and the
module imports only `GrowthExecutionModule` and `KeywordResearchModule` — the
vendor call path exists solely on the explicit `research-term` route, never on
`analyze`.

Tables read, and nothing is written to any of them:

| Model | What is taken from it |
|---|---|
| `Competitor` | tracked rivals only (`status: 'tracked'`) — never candidates |
| `SerpTracker` | the project's trackers: query, `locationName`, `languageCode`, `device` |
| `SerpQuery` | the tracked keywords (used both as the gap corpus and as the "already tracked" set) |
| `SerpResult` + `SerpSnapshot` | newest result per query, `subjectRank`, `topDomains`/`competitorsSeen`, and `snapshot.status` |
| `KeywordSet` + `Keyword` | the newest completed/partial research set, for rule (c) and for demand data |
| `GrowthAsset` | `targetKeyword` values, for `existingContentMatchId` |
| `Project` | existence + the project's own domain |

The intent is stated in the module header: *"never a new SERP/AEO/vendor
call"*. The smoke suite's premise is the same — it seeds every input with raw
Prisma, and says *"No vendor account needed"*.

## The four evidence families — and what each one is allowed to claim

`evidenceSourceFamily` is part of the dedup identity, so it is also the row's
statement of *how strong* the claim is.

| Family | Rule | What it asserts |
|---|---|---|
| `serp-keyword-gap-absent` | The client was **not observed within the checked depth** of a clean capture, and a confirmed rival was | A real gap, bounded by what was checked. Reason: `` `{rival} ranks #{n} for "{query}" (checked top {depth}); this project was not found within the same checked depth.` `` |
| `serp-keyword-gap-below` | Client **is** ranked, and `clientPosition - rivalPosition >= marginThreshold` (default 5) | A real gap, with both positions quoted: `` `… vs. this project's #{n} — a {k}-position gap (checked top {depth}).` `` |
| `keyword-research-topic-suggestion` | Keyword research found real demand (`>= 10`/mo) for a keyword with **no tracked SERP query at all** | **A topic suggestion, not a verified ranking gap** — the reason string says so in those words |
| `serp-keyword-gap-unknown` | A confirmed rival is observed, but the project's own capture for that query **failed** | Not a gap claim at all: the project's position is *unknown*, and the row says it should be re-checked |

⚠️ The service's header comment enumerates only three families (absent / below
/ topic suggestion); the code writes four. `serp-keyword-gap-unknown` is real,
emitted at `opportunities.service.ts:226-228`, and the smoke suite asserts on
it. The README lists what the code does.

### The honesty rules, each with the code that holds it

**A null rank from a failed capture is `unknown`, never "not ranking"**
(§12.6). `SerpSnapshot.status === 'failed'` is the only signal the schema has
for failed-vs-clean, and it decides:

```ts
const captureFailed = result.snapshot?.status === 'failed';
const clientPositionStatus = captureFailed ? 'unknown'
  : result.subjectRank != null ? 'ranked' : 'not-observed';
```

`PositionStatus` is three-valued (`ranked | unknown | not-observed`) precisely
so those three can never collapse into one. A failed capture is still
*surfaced* — a rival genuinely ranked there, which is worth a human's
attention — but with its own family, its own wording, and
`clientPosition: null`.

**Missing volume/CPC stays `unavailable` (null), never zero**:

```ts
// Missing volume/CPC stays `unavailable` (null), never coerced to zero (§12.6).
return { demandVolume: row.searchVolume, demandCpc: row.cpc, demandCompetition: row.competition };
```

"no demand data" and "zero demand" are different facts, and a zero here would
silently become a ranking input.

**A rival-content / AI-answer topic is labelled a topic suggestion, not a
verified gap.** §12.6 asks for the distinction between *"a topic observed in
rival content/AI answers but not yet measured as a Google keyword"* and a real
gap. This build has no per-topic rival AI-answer corpus to mine (that is
`aeo-audit`'s territory, explicitly off limits here), so the honest analogue
available today is "relevant per keyword research, not yet SERP-tracked" — and
that is exactly what is labelled, *"nothing stronger."*

**`checkedDepth` never implies deeper coverage than was captured** — it is the
parsed length of the stored `topDomains` array (0 on unparseable JSON), and
every gap row carries the exact query, location, language, device, competitor
position and capture date it came from in `evidence[]`.

**`relevance` is a disclosed formula, not a promise** — demand (0–60,
`log10`-scaled) + gap-type weight (40 absent / 30 below / 15 suggestion),
capped at 100. A null volume scores **20, not 0**: missing data is not
penalised. The convention is inherited from keyword-research's `priorityScore`
and says so in the code.

**`market`/`language` are stored as `''`, never SQL NULL.** The comment
explains the trap: SQLite treats NULL as distinct per row in a unique index,
so a NULL market would silently disable dedup for every opportunity without
one. `''` means "unspecified" and is exposed as `null` in the DTO.

## Dedup identity — one row per idea, forever

```prisma
@@unique([projectId, topic, market, language, intent, evidenceSourceFamily], name: "opportunityIdentity")
```

`topic` is the normalized keyword: trimmed, lowercased (full Unicode
`toLowerCase`), whitespace runs collapsed to one space — and **nothing else**.
No punctuation stripping, no stopwords, no accent folding, no stemming, so two
keywords that differ in a meaningful way never merge. `topicDisplay` keeps the
original casing for humans and is never part of the identity.

Re-running `analyze()` updates the **same** row: evidence is *appended* (never
replaced), demand and existing-content matches are recomputed, and

> `'status'/'dismissedReason'/'dismissedAt' are therefore never touched here,
> for ANY existing status.`

That is §12.6's "a deliberately dismissed idea must not silently reopen"
implemented as a write that simply does not exist. Reopening takes an explicit
`PATCH …/reopen` with its own new reason, which is prefixed `Reopened: ` so the
human act is distinguishable from the engine's original wording.

## Opportunity → content (§12.7)

On `GrowthAsset`, two columns carry the contract:

- `sourceOpportunityId` — deliberately **not** a foreign key, for the same
  reason as `sourceGapId`: an opportunity may later be pruned or reanalyzed,
  and a dangling reference must never delete or break a brief someone is
  already acting on.
- `idempotencyKey String? @unique` — caller-supplied, and unique at the
  database level, so a retried "Create content" click cannot insert a second
  row even if the service check were bypassed.

`convertToContent` resolves in this order:

1. **Same `idempotencyKey` → replay.** The existing asset comes back with
   `created: false`. No write, no error. (A key that belongs to a *different*
   project is a **404** — `Idempotency key was not issued for project …` —
   explicitly not a 409, so a guessed key learns nothing.)
2. **Different key, but this opportunity already has a linked asset → "Open
   existing draft".** The oldest linked asset is returned with `created:
   false`. A new key can never produce a duplicate.
3. **Otherwise create** at `status: 'recommended'`, `source: 'deterministic'`,
   `sourceGapId: null`.

The source opportunity is **never deleted**: it is marked `status:
'converted'` + `linkedGrowthAssetId` only if it was not already converted, so
a third call with a fresh key leaves the row untouched and still returns the
same asset.

**Known edge, stated rather than hidden:** `idempotencyKey` is unique
table-wide, not per project. If a caller reuses one key across two different
opportunities in the same project, step 1 returns the *first* opportunity's
asset and step 2 then links the *second* opportunity to it. The contract is on
the caller — the web client mints a fresh `opp-convert-<timestamp>-<random>`
key per click — but the server does not enforce that the key was minted for
*this* opportunity.

**Not built, from §12.7's own list:** the "update an existing page" branch
(only `existingContentMatchId` is recorded, for display) and the fuller
prefilled brief (audience, location/language, intent, source references). The
code labels both as P08's work — *"this is deliberately the minimal real
thing"* — rather than pretending they are covered.

## Endpoints (7)

Base: `/api/projects/:projectId/opportunities`. **Every route is
operator-only.** The global `JwtAuthGuard` + `RolesGuard` are default-deny for
`user.type === 'client'` (`Client accounts cannot access this resource`), and
no route here carries `@Roles()` or `@ClientPortal()` — so any operator role
passes, and there is no client-portal surface for this module at all.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/analyze` | `{ keywordSetId?, marginThreshold? }` (`marginThreshold` 1–50, default 5) | `AnalyzeOpportunitiesResult` — counts + the `note` honesty string |
| GET | `/` | `?status= &origin= &search= &page= &pageSize=` (≤100) | `{ total, page, pageSize, opportunities }`, ordered relevance desc then measured desc |
| GET | `/:opportunityId` | — | one `OpportunityDto` |
| PATCH | `/:opportunityId/dismiss` | `{ reason }` (**required**, min 3 chars) | the dismissed row. A dismissal without a reason could not be distinguished from a bug, so it cannot be written |
| PATCH | `/:opportunityId/reopen` | `{ reason }` (**required**, min 3) | the reopened row, with the reason recorded as `Reopened: …` |
| POST | `/:opportunityId/convert` | `{ idempotencyKey (min 8), assetType? }` | `{ opportunity, asset, created }` |
| POST | `/research-term` | `{ keyword, locationName?, languageCode? }` | passthrough of `KeywordResearchService.research()` — the one route that can reach a paid vendor call, under that module's existing gates |

An unknown project is `Project <id> not found` (404); an unknown — or another
project's — opportunity id is `Opportunity <id> not found for project <id>`
(404, not 403: a cross-tenant id probe must not learn that the row exists).

Validation is global (`whitelist: true, forbidNonWhitelisted: true`), so an
unknown body key is a 400 before any handler runs.

## 2026-09-21 addendum — one read-only client-portal route

The client-nav restructure added a "Digital Marketing → Ideation" item to the
client project tree, which needed a client-facing read of this queue. Rather
than change anything above (all 7 operator routes, and the "every route is
operator-only" claim, are unchanged), a second controller class was added:

`OpportunitiesPortalController` — `@ClientPortal() @Controller('portal/
projects/:projectId/opportunities')`:

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/portal/projects/:projectId/opportunities` | — (same `?status= &origin= &search= &page= &pageSize=` query as the operator list) | `{ total, page, pageSize, opportunities }` |

Scoped via `ScopeValidationService.assertProjectAccess(user, projectId)` —
the same pattern `BusinessProfilePortalController` and `ResultsPortalController`
already use, not a new auth mechanism. Read-only: no analyze/dismiss/reopen/
convert on the portal side, matching the writing-style module's existing
precedent that client-edit rights for this kind of staff-curated queue were
never confirmed by product. Web adapter: `listPortalOpportunities()` in
`web/src/services/opportunities.ts`. Consumer:
`web/src/app/(client)/client/projects/[projectId]/digital-marketing/
ideation/page.tsx`.

## Deliberately not built

- **`origin` values that nothing writes.** `ai-question-gap`, `refresh` and
  `client-request` are valid in `OPPORTUNITY_ORIGINS` and on the Prisma model,
  but no code path produces them and there is no create endpoint — every row
  this build makes is `search-gap`. The schema comment is explicit: *"no
  placeholder rows are fabricated to fill the enum."*
- **`editorial-idea`.** `opportunities.types.ts` says the build writes it; a
  grep of `backend/src` finds the enum entry and that comment and nothing
  else. Documented here as a doc-vs-code discrepancy rather than smoothed
  over — see "What was verified" for how to re-check it.
- **`intent`.** Always the literal `'unspecified'` — used only as a dedup
  identity field, never inferred, per §12.6.
- **`manual-lookup`.** Declared as an evidence `kind`, never written.
- **Per-topic rival AI-answer mining.** `aeo-audit`'s territory; off limits
  here by design (§12.6's strongest-sounding option is the one this build
  explicitly refuses to fake).

## Dependencies

- `GrowthExecutionModule` — `createFromOpportunity()`, the idempotent
  asset-creation path (this module never writes `GrowthAsset` itself).
- `KeywordResearchModule` — the "Research a search term" secondary action
  (§12.6 R29); reuses its vendor call and cost gates unchanged.
- `PrismaService` (global) — every read listed above.

## Environment variables

**None read directly by this module** — no `ConfigService`, no `process.env`
in any of the five files. `analyze` needs no credentials at all. The only
indirect reads are on the `research-term` route, via
`KeywordResearchService.resolveProvider()`: `SWARM_ALLOW_LIVE` (must be
exactly `1`), `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, and
`KEYWORD_RESEARCH_MAX_COST_PER_RUN`.

## Consumers

- `app.module.ts` — registered; that is the only backend registration.
  No other backend module injects `OpportunitiesService` today, despite the
  export: §12.5's "Website / AI visibility / Competitors / reports link to a
  filtered view" is satisfied in the UI, not by cross-module injection.
- `web/src/services/opportunities.ts` — the typed API adapter.
- `web/src/app/(ops)/projects/[projectId]/content/opportunities/page.tsx` —
  CT01, the canonical home §12.5 asks for.
- **No client-portal consumer**, by design (see Endpoints).

## Plan alignment (P07)

| Requirement | Status | Notes |
|---|---|---|
| §12.5 — one canonical `Opportunity` record | ✅ | `Opportunity` model; every field §12.5 lists is present |
| §12.5 — origins include AI-question gap, refresh, client request, editorial idea | ⚠️ | Modelled and accepted by the enum; only `search-gap` is ever written. No create endpoint exists, so nothing else is reachable |
| §12.6 — compute gaps only inside the observed corpus, never claim a rival's full universe | ✅ | Read-only engine; the boundaries are restated in the API description, the module header and the per-run `note` |
| §12.6 — null/failed rank is `unknown`, not "not ranking" | ✅ | Three-valued `PositionStatus`; asserted by the smoke suite |
| §12.6 — missing volume/CPC stays unavailable | ✅ | `null`, never 0; asserted |
| §12.6 — distinguish a topic suggestion from a verified gap | ✅ | Separate family + wording; asserted |
| §12.6 — dedup identity | ✅ | `opportunityIdentity` unique constraint |
| §12.6 — re-running analysis must not reopen a dismissal | ✅ | The update path cannot write `status`; asserted twice |
| §12.7 — idempotency key + "Open existing draft" | ✅ | Two independent guarantees (DB unique + linked-asset lookup); asserted three ways |
| §12.7 — preserve the source opportunity after conversion | ✅ | Marked converted, never deleted; asserted by a direct row count |
| §12.7 — "update an existing page" as well as "create a new piece" | ❌ Not built | `existingContentMatchId` is recorded for display only; the code names P08 as the owner |
| §12.7 — brief prefilled with audience/location/intent/source refs | ⚠️ | Title, reason-based brief and normalized keyword only — the minimal contract, labelled as such in code |

## What was verified, and what was not

`backend/smoke/keyword-gaps.smoke.sh` (228 lines, 47 assertions) is the exit
gate. Run it with the stock-bash-safe interpreter:

```bash
API=http://localhost:3002/api /opt/homebrew/bin/bash smoke/keyword-gaps.smoke.sh
```

It needs a booted backend and no vendor account: it seeds a `Competitor`
(tracked), a `SerpTracker` + 3 `SerpQuery` rows, two snapshots (one
`complete`, one `failed`), three `SerpResult` rows (`null` absent / `15`
below / `null` on the failed snapshot) and a completed `KeywordSet` with one
keyword, all via raw Prisma, then drives the real HTTP surface. It cleans up
on exit.

What it asserts, in its own terms:

- one `analyze` produces exactly 4 rows — absent, below, **unknown**,
  topic-suggestion — from 3 considered queries;
- the absent row: `clientPositionStatus = "not-observed"`, rival position
  preserved, `demandVolume` empty (**never coerced to 0**), and the evidence
  keeps the exact query, `checkedDepth = 1` and `device`;
- the failed-capture row (**EXIT GATE**): `unknown` — not `not-observed`, not
  zero — with its own family, so it is never mislabelled as a confirmed gap;
- the topic-suggestion row: `keyword-research-topic-suggestion` with its
  demand data, i.e. labelled a suggestion, not a verified ranking gap;
- a second `analyze` creates 0 and updates 4; the row `id` is unchanged and
  its `evidence` array grew to 2 (reinforced, not replaced);
- a dismissal survives re-analysis with its reason verbatim (**EXIT GATE**);
  reopen requires and records a new reason;
- convert: `created: true` and the source marked converted + linked; the same
  key returns the same asset id; a *different* key returns the existing draft
  with `created: false`; and a direct Prisma count proves **exactly one**
  `GrowthAsset` exists for that opportunity after three calls;
- `research-term` returns either an honest 503 (no live DataForSEO
  credentials — never a fabricated result) or a 200/201 — anything else
  fails;
- an unknown project is a 404.

**Not re-run during documentation.** This README was written while other
agents were mid-flight on shared source and the dev database, so the suite
could not have been attributed cleanly. The assertions above are read from
the script; none of them is a claim that it passes right now. The one claim
worth re-checking by hand is the `editorial-idea` discrepancy in
"Deliberately not built": `grep -rn "editorial-idea" backend/src/modules`
should show only the enum entry in `opportunities.types.ts`, the comment above
it, and this README's own two mentions.
