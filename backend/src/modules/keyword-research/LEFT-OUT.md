# Left Out — Keyword Research Module

## 1. Automatic seed derivation from `SiteContext.services`

The API surface table in `docs/analysis/wave-6-audit-pipeline.md` §6 lists
`POST /projects/:id/keywords/research` as "pull volume/difficulty/CPC" with no
stated seed source. The build instructions for this module scoped v1 to an
explicit `keywords: string[]` request body — the operator (or a future caller)
supplies the seeds directly. Deriving seeds automatically from the site's
extracted `services[]`/ICP would be a reasonable stage-10 enhancement, but it
is a separate, non-trivial decision (which services become which keyword
phrasings? how many? deduped against what?) and was explicitly deferred to
keep this module's v1 boundary simple and auditable.

**Future path:** an optional `deriveFromContext: true` flag that reads
`SiteContextData.services[]` (or `.markets[]`) and proposes seeds, with the
operator still confirming before any vendor spend — consistent with D8's
"ranked suggestion, never auto-applied" pattern for markets.

## 2. AEO matrix demand weighting — RESOLVED, no longer left out

Wave-6 §4 step 4 notes this module "feeds the AEO matrix generator an
optional demand weighting" later. At the time this file was written that was
out of scope pending this module shipping first. It has since been built —
`backend/src/modules/aeo-audit/aeo-matrix.service.ts`'s `demandIndex()`
reads this module's `KeywordSet`/`Keyword` tables directly via Prisma, and
`aeo-matrix.generator.ts` orders services by matched volume when one exists.
Kept here as a record of the original scoping call, not as an open item.

## 3. Offline/fixture mode

`serp-intelligence` has a `SERP_ALLOW_FIXTURE=1` canned-response mode so its
capture pipeline is smoke-testable with no vendor account. This module does
not build an equivalent fixture provider: the task scope only requires the
honest 503-without-credentials path to be smoke-tested (DataForSEO
credentials are not configured in this environment), and a real live call was
explicitly out of scope for verification here. If keyword research later
needs the same offline-smoke-test treatment as SERP, the fixture provider
pattern in `serp-intelligence/providers.ts` is the template to copy.

## 4. Pagination on `GET /keyword-research`

`list()` returns every `KeywordSet` for a project (each with its keywords,
optionally filtered by `minVolume`) in one response. Fine for the expected
scale (a handful of research runs per project, each up to ~220 keyword rows
given the module's own `maxKeywords=200` + related expansion), but there is
no cursor/limit on the number of *sets* returned. Not built now; add
`?limit=`/`?cursor=` if a project accumulates enough research runs for this
to matter in practice.

## 5. Historical volume trend (`monthly_searches`)

DataForSEO's `search_volume` response includes a `monthly_searches` array
(up to 4 years of history) alongside the current-month figures this module
stores. Not persisted — `Keyword` stores only the current snapshot, matching
what the wave-6 doc actually asked for ("search volume, difficulty/competition,
CPC, related and long-tail"). A trend view would need a new column (JSON
array) and was not part of the approved scope.
