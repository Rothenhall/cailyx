# Competitors Module

> **Status:** ✅ Built
> **Wave:** 6, step 6 (`docs/analysis/wave-6-audit-pipeline.md` §D4/§4)
> **Phase:** P06 — `platform_improvement_plan.md` §12.1–§12.4 (market discovery,
> the exclusion list, relevance classification, rejection memory, frozen
> comparison snapshots)
> **Spec:** [SPEC.md](SPEC.md), [REQUIREMENTS.md](REQUIREMENTS.md), [LEFT-OUT.md](LEFT-OUT.md)

## Purpose

Turns `Project.competitors` (a JSON string on the `Project` row) into
first-class `Competitor` rows, builds a profile for each one (homepage
tech-stack scan, schema/JSON-LD read, homepage SEO/content scoring on the
**identical rubric** the client is scored by, published review ratings via
the same schema-scrape reader `digital-presence` uses, and whatever SERP/AEO
presence already exists for that rival), and produces an honest
client-vs-competitor gap comparison. Answers: **what do our competitors run,
where do they already beat us on SEO/content/reviews, and where do they
already beat us?**

Decision D4 (approved): "light now, structured to deepen later." Storing
`Competitor`/`CompetitorProfile` as real rows — not another JSON blob — is
the structural part that makes "deepen later" real. Explicitly **not** in
scope: running the full `technical-audit` module per competitor (that stays
project-scoped; making it domain-scoped is its own future decision).

## Architecture

```
competitors/
├── competitors.module.ts        # NestJS module — imports FetcherModule, TechStackModule
├── competitors.service.ts       # discover, list, gap, profile building, AEO/SERP attachment
├── competitors.controller.ts    # POST discover, GET list, GET gap
├── dto/competitors.dto.ts       # CompetitorInputDto, DiscoverCompetitorsDto
├── README.md                    # This file
├── SPEC.md                      # Detailed module spec
├── REQUIREMENTS.md              # External tools / infra / env vars
├── SETUP-STATUS.md              # What is installed, what is pending
└── LEFT-OUT.md                  # Deferred scope
```

## How it works

1. **`POST /discover`** merges `Project.competitors` (parsed with the same
   `parseCompetitors` util `serp-intelligence` already uses) with an optional
   explicit list in the body, upserts one `Competitor` row per distinct name
   (`source: "project-json"` vs `"manual"`), then builds a fresh
   `CompetitorProfile` for each:
   - **Tech:** `TechStackService.scanDomain(projectId, competitor.domain)` —
     the exact same scan the tech-stack module runs for a project's own
     domain, reused unchanged. The scan is persisted as its own
     `TechStackScan`; the profile only stores its id.
   - **Schema:** `FetcherService.fetchSchema()` (already existed, used by
     other modules) reads the homepage's JSON-LD and records the distinct
     `@type` values found.
   - **AEO presence:** reads the project's most recent **completed**
     `AeoAudit.verdict` (JSON `AeoVerdict`) and looks for this competitor by
     name in `verdict.counted.competitors` (`CompetitorStanding[]`,
     `aeo-audit.types.ts`). Never triggers a new AEO run.
   - **SERP presence:** scans the project's existing `SerpResult` rows
     (`competitorsSeen` / `topDomains`, already written by
     `serp-intelligence`) for this competitor's name or domain. Never
     triggers a new SERP fetch.
   - **SEO/content:** `extractPageSignals()` — the same page-signal extractor
     `technical-audit` uses, pulled out into a shared function specifically so
     competitors are scored on an identical rubric rather than a second copy
     — runs against the homepage fetch, producing `seoScore`.
   - **Reviews:** `attachReviews()` reads published `AggregateRating` markup
     via the same schema-scrape reader `digital-presence` uses against the
     platforms already discovered for that competitor (no new vendor call);
     an honest `skipped` when no ratable listing exists (e.g. a site sitting
     behind Cloudflare with no discoverable review markup).
   - A competitor with no domain on record still gets AEO/SERP attachment
     (keyed by name), but `status: "skipped"` for the crawl half.
2. **`GET /competitors/profiles`** lists every `Competitor` row with its
   latest `CompetitorProfile`. Not the bare `GET /competitors` path — see
   "A note on the `/competitors` route" below.
3. **`GET /competitors/gap`** builds a plain diff: tech signatures and schema
   types the client has that competitors lack (and vice versa), plus each
   competitor's attached AEO/SERP status side by side. **Not a scored
   verdict** — the data does not support a composite score, so none is
   invented. The client side of the diff is computed live (tech-stack scan +
   schema read against the project's own domain) since both are free, no
   vendor, single-fetch operations — the same cost class as the tech-stack
   module's own scan.

## Market discovery (§12.2) — `POST /discover/market`

Proposes *new* candidates from the services/segments and target markets the
project has already confirmed. It writes `status: "candidate"` rows only —
the tracked list is never replaced, and nothing here profiles anything.

**Two cost classes, and the page load only ever gets the free one.**

| Mode | What it reads | Cost |
|---|---|---|
| default (`collectNew` false/omitted) | the project's newest **completed** `AeoAudit.verdict` for rival names, plus up to 300 existing `SerpResult` rows across the project's `SerpTracker`s for rival domains | **zero** — no vendor call, nothing fetched |
| `collectNew: true` | the above, **plus** a bounded paid pass (see below) | paid/explicit — must be asked for, and reports `costUsd` |

§12.3 says a page load makes no paid calls; this split is how that is kept
true. The result carries the mode back (`collectNew`, `queriesRun`,
`reviewSitesPulled`, `costUsd`), so a caller can tell a free pass from a paid one
without guessing. A free pass legitimately reports `queriesRun: 0, costUsd: 0` — that
is a pass that mined stored evidence, not a pass that failed.

**Paid pass, three passes (2026-09-22, discoverability-pipeline Stage 2):**
1. **Name-independent SERP (spec §6.4)** — `{service} in {market}`, `best {service}
   tools for {icp}`, `{service} for {industry}`, `{service} vendors {market}`
   (`{icp}` = confirmed ICP segment, `{industry}` = confirmed category). Tagged
   `serp-live-search`. Runs first (needs no competitor name), bounded to
   `MAX_MARKET_QUERIES - MAX_COMPARISON_QUERIES`.
2. **Comparison SERP (spec §6.1)** — one `"<name>" alternatives` per branded name
   pass 1 surfaced (`pickComparisonSeeds`), spending the remaining budget
   (`MAX_COMPARISON_QUERIES` = 2). Tagged `serp-comparison-search`. A name only
   exists to compare against after pass 1.
3. **Review-site category pull (spec §6.1)** — best-effort G2 `/categories/<slug>`
   fetch with a **headless `render()` fallback** when bot-blocked, up to
   `MAX_REVIEW_SITE_PULLS` (2). `looksLikeReviewListing` rejects a Cloudflare
   challenge / JS-shell so a block is never parsed as data; `parseG2CategoryListing`
   extracts product names (no domain — the listing links to G2, not the vendor).
   Tagged `review-site-category`. **May be empty in practice** — G2/Capterra
   Cloudflare protection can defeat even the headless fallback; wired end-to-end
   for Stage 4 weighting when it lands, not relied on as a primary source (a paid
   G2/Capterra API is the real fix — follow-up).

These five `evidenceKind`s (`aeo-verdict`, `serp-snapshot`, `serp-live-search`,
`serp-comparison-search`, `review-site-category`) let Stage 4 scoring weight
sources by discovery method.

Bound to `MAX_SERVICES_CONSIDERED = 5` services and
`MAX_MARKETS_CONSIDERED = 3` target countries; the paid pass stops at
`MAX_MARKET_QUERIES` (6) SERP searches + `MAX_REVIEW_SITE_PULLS` (2) review-site
pulls — "a budget, not a suggestion".

## Competitor ranking (Stage 4, 2026-09-22)

`GET /competitors/ranking` → `rankCompetitorsByStance(projectId)` ranks rivals by a
weighted composite (discoverability-pipeline spec §7) over the **newest completed AEO
audit's** stances — read-only, no writes, no LLM/vendor call. It aggregates each rival
name the audit surfaced (`AeoStanceService.aggregateCompetitorSignals`, in the aeo-audit
module) into absence vs. co-mention counts, distinct platform coverage, prompt-dimension
diversity, and average position, then scores:

| Factor | Weight |
|---|---|
| platform coverage | 30% |
| absence-mentions (rival named while the client was absent) | 25% |
| co-mentions (rival named alongside the client) | 15% |
| average position | 15% |
| prompt diversity | 10% |
| external-discovery corroboration (a Stage-2 `market-discovery` row exists) | 5% |

Each factor is normalized 0–1 across the candidate set; the score is 0–100. A
`MIN_PLATFORM_COVERAGE` floor of 2 keeps single-surface noise out of the top list,
relaxing to 1 (with `floorRelaxed: true`) when too few rivals clear it. Returns the top 5
plus a 6th–15th `watchlist` (kept, not discarded, so a later discovery round can
reconsider them). The pure scoring is the exported `rankCompetitorSignals()` — unit-tested
independently of the DB. `competitors` imports `AeoAuditModule` for the read-only
`AeoStanceService` (no cycle: aeo-audit does not import competitors).

**The exclusion list is the point.** `EXCLUDED_DOMAINS` is a fixed set of
registrable domains that are never a competitor even when they legitimately
rank for the client's queries: directories/marketplaces/review platforms
(`yelp.com`, `clutch.co`, `g2.com`, `capterra.com`, `trustpilot.com`,
`indeed.com`, `crunchbase.com`, `bbb.org`, `yellowpages.com`, …), social and
publishing platforms (`facebook.com`, `linkedin.com`, `youtube.com`,
`reddit.com`, `medium.com`, `wordpress.com`, …), reference sites
(`wikipedia.org`, `wikidata.org`), and search/portal infrastructure that
sometimes lands in a captured result as a "domain" (`google.com`, `bing.com`,
`duckduckgo.com`). The client's own domain is excluded first, then these,
then already-existing rows, then rejected candidates. Exclusions are counted
and the first ten reasons are returned as `exclusionSample` — an exclusion
you cannot see is an exclusion you cannot check. The set's own comment is
the design rule: *"Extend cautiously; being too aggressive here silently
drops real rivals, which is the opposite failure mode."*

**Relevance is assigned from evidence, never from a guess** — and a
candidate is **never** auto-classified `not-relevant`:

```
evidenceKinds.has('aeo-verdict')  → 'direct-competitor'
evidenceKinds.size > 1            → 'direct-competitor'
otherwise                         → 'adjacent-alternative'
```

A name an AI verdict mentioned (a market-aware source reasoning about this
project's own competitive set) or one corroborated by two independent
evidence kinds is treated as a likely direct competitor; a bare SERP
co-occurrence is merely adjacent *until a human says otherwise*. `PATCH
…/candidates/:competitorId/relevance` is that human saying so, and it
reclassifies without confirming or rejecting.

**Rejection memory (§12.2).** `DELETE …/candidates/:competitorId` records a
`CompetitorRejection` tombstone (normalized name key + canonical domain key +
reason) **first**, then deletes the candidate row. `listCandidates()` is
self-healing: it deletes any candidate the tombstones say should not exist
rather than filtering it out on read, so a rejection holds even for rows
another producer writes later. The route only ever applies to an
unconfirmed candidate — an already-tracked competitor answers 404 rather
than being deleted, which is why the deletion has no undo but also no way to
remove a rival the client is actually tracking.

## Frozen comparison snapshots (§12.3)

Every `GET …/competitors/gap` computation is persisted as a
`CompetitorComparisonSnapshot` — immutable, never retroactively mutated.
`GET …/comparison-snapshots` lists them newest first (summary only, so the
list stays cheap however many accumulate); `GET
…/comparison-snapshots/:snapshotId` returns the stored `result` **verbatim**,
so a comparison read today says exactly what it said when it was computed,
even after the competitor set has changed underneath it.

Each snapshot carries its provenance: `competitorSetVersion` (a hash of the
competitor set it was computed against), `extractionVersion` (`gap-v1` — the
comparison logic's own version), and `sourceObservationIds` — the
`techScanIds`, `profileIds` and `aeoAuditIds` actually read, plus
`serpResultSampleCount`. A frozen number with no record of what produced it
is not evidence, so the record is part of the snapshot, not a side note.

Snapshot persistence is best-effort and honest about failure: if the row
cannot be written, `GapResult.snapshotId` stays `''` and the gap is still
returned. The comparison is the product; the snapshot is the receipt.

## Built Features

| Feature | Status | Notes |
|---|---|---|
| `Project.competitors` → `Competitor` row promotion | ✅ | JSON column stays populated and readable — additive, not a migration that breaks existing readers |
| Explicit competitor list on `/discover` | ✅ | Merged with the JSON list, never replaces it |
| Per-competitor tech-stack scan | ✅ | Reuses `TechStackService.scanDomain` unchanged |
| Per-competitor schema/JSON-LD read | ✅ | Reuses `FetcherService.fetchSchema` unchanged |
| AEO presence attachment | ✅ | Reads existing `AeoAudit.verdict`; reports `unknown` when no completed audit exists yet, `absent` when one exists but doesn't name this competitor |
| SERP presence attachment | ✅ | Reads existing `SerpResult` rows via the project's `SerpTracker`s |
| Per-competitor SEO/content scoring | ✅ | `seoScore` via shared `extractPageSignals()` — identical rubric to `technical-audit`, not a second copy |
| Per-competitor review ratings | ✅ | `reviewRatings`/`reviewStatus` via `attachReviews()`; honest `skipped`/`failed` when no ratable listing exists |
| Client-side SEO/review comparison in `/gap` | ✅ | The client's own SEO signals and `PresenceReview` rows are read live so the gap table compares against something, not nothing |
| Gap comparison | ✅ | Presence diff on tech/schema/SEO/reviews + side-by-side AEO/SERP status; no composite score |
| No-domain competitors | ✅ | `status: "skipped"` on the crawl half; AEO/SERP attachment still runs by name |
| Market discovery, free pass (`collectNew` false) | ✅ | Mines stored AEO verdicts + SERP results; `queriesRun: 0`, `costUsd: 0` — no vendor call |
| Market discovery, paid pass (`collectNew: true`) | ✅ | Three passes — name-independent + comparison SERP (≤6 total) + best-effort G2 review-site pull (≤2); `costUsd`/`reviewSitesPulled` reported; explicit, never implicit |
| Domain exclusion list | ✅ | Directories, social/publishing, reference, search infra + the client's own domain; counted and sampled in `exclusionSample` |
| Candidate relevance classification | ✅ | `direct-competitor` / `adjacent-alternative` / `not-relevant`; never auto-`not-relevant` |
| Rejection memory (`CompetitorRejection`) | ✅ | Tombstone written before the row is deleted; `listCandidates()` self-heals, not just filters |
| Frozen comparison snapshots | ✅ | Immutable, versioned by competitor set + extraction version + source observation ids |
| Candidate confirm / reclassify / reject | ✅ | See "G19/D01" below for their contract |
| Competitor Social (activity/followers/engagement) | ❌ Not built | No code path yet — the flowchart's one competitor leaf this module doesn't cover |
| Full `technical-audit` per competitor | ❌ Explicitly out of scope (D4) | Project-scoped elsewhere; making it domain-scoped is a future decision |
| High-signal pages beyond the homepage | ❌ Deferred | See LEFT-OUT.md |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/projects/:id/competitors/discover` | 5/60s | Promote + (re)profile every competitor. Body: optional `{ competitors: [{name, domain?}] }` |
| `POST` | `/projects/:id/competitors/discover/market` | 5/60s | Propose candidates from confirmed services + target markets. Body: `{ collectNew?: boolean, provider?: 'dataforseo' \| 'fixture' }`. Free by default; `collectNew: true` is the paid, explicit pass |
| `GET` | `/projects/:id/competitors/profiles` | default (100/60s) | `{ competitors }` — every `Competitor` row with its latest profile (tracked only) |
| `GET` | `/projects/:id/competitors/ranking` | default (100/60s) | **(Stage 4)** rank rivals by the §7 composite over the latest AEO audit's stances — top 5 + 6th–15th watchlist. Read-only |
| `GET` | `/projects/:id/competitors/gap` | default (100/60s) | Client-vs-competitor gap comparison; also persists a frozen snapshot |
| `GET` | `/projects/:id/competitors/comparison-snapshots` | default (100/60s) | `{ snapshots }` — frozen comparisons, newest first, summaries only |
| `GET` | `/projects/:id/competitors/comparison-snapshots/:snapshotId` | default (100/60s) | The stored `GapResult` verbatim; 404 for an unknown or another project's snapshot |
| `GET` | `/projects/:id/competitors/candidates` | default (100/60s) | `{ candidates }` — `status="candidate"` rows awaiting review (possibly empty) |
| `POST` | `/projects/:id/competitors/candidates/:competitorId/confirm` | default (100/60s) | Flip a candidate to `tracked` + append to `Project.competitors`; 404 if not a pending candidate |
| `PATCH` | `/projects/:id/competitors/candidates/:competitorId/relevance` | default (100/60s) | Body: `{ relevance }` — `direct-competitor` \| `adjacent-alternative` \| `not-relevant`. Does not confirm or reject |
| `DELETE` | `/projects/:id/competitors/candidates/:competitorId?reason=` | default (100/60s) | Tombstone + delete a candidate; `{ deleted: true }`. Tracked competitors are not removable here (404) |

### A note on the `/competitors` route

The wave-6 doc's API table (§6) lists the list endpoint as bare
`GET /projects/:id/competitors`. That exact path is already owned by
`ProjectsController` (`projects.controller.ts`) — it returns the named
competitor list + SERP-discovered candidates that share-of-voice, authority
discovery and the frontend's RivalsPanel already read
(`{ tracked[], discovered[] }`). Nest/Express matches routes in registration
order, so adding an identical `GET` on the same path would silently make one
of the two handlers unreachable — confirmed by running both together: the
pre-existing `ProjectsController` handler wins and this module's would never
fire.

Rather than touch that endpoint's response shape (a live consumer this task
was explicitly told not to touch — `frontend/`), this module's list endpoint
lives one segment deeper: `GET /projects/:id/competitors/profiles`. `discover`
and `gap` are unaffected — neither path collides with anything on
`ProjectsController`.

## Dependencies

- `FetcherModule` — schema/JSON-LD read (`fetchSchema`, already existed).
- `TechStackModule` — `TechStackService.scanDomain`, exported specifically
  for this module (wave-6 step 3).
- `DigitalPresenceModule` — its discovery service, reused unchanged, to find
  each rival's own external profiles.
- `BusinessProfileModule` (P06/§12.2) — `BusinessProfileService` read-only for
  the confirmed services/segments and confirmed target markets market
  discovery composes its searches from. That module's own code is untouched.
- `SerpIntelligenceModule` (P06/§12.2) — `SerpIntelligenceService.serpForDiscovery()`,
  the same gated, budget-checked SERP provider `capture()` uses. Reached only
  on `collectNew: true`.
- `PrismaService` (global) — `Competitor`, `CompetitorProfile`,
  `TechStackScan`/`TechFinding` (read), `AeoAudit` (read), `SerpTracker` /
  `SerpResult` (read), and the P06 additions `CompetitorRejection` and
  `CompetitorComparisonSnapshot` (read + write).
- `parseCompetitors`, `hostOf` from `common/utils/subject-match.ts` — the
  same JSON-parsing and domain-normalization utilities `serp-intelligence`
  already uses, for consistency.

No new npm packages, no env vars, no vendor credentials.

## Consumers

None yet. `gap-analysis.service.ts` reads `Competitor` rows (name-matching
for standings) but does not yet read `CompetitorProfile.seoScore` or
`.reviewRatings` — those two fields exist and are API-accessible but are not
consolidated into stage 8 findings yet. A future frontend Competitors
workspace (wave-6 step 8) is the other expected consumer.

## PRD Alignment

| Requirement | Status | Notes |
|---|---|---|
| D4 — light per-competitor profile (tech + schema + attached SERP/AEO) | ✅ | See "How it works" |
| D4 — `Competitor` as first-class rows, not JSON | ✅ | `Competitor` / `CompetitorProfile` models |
| D4 — `Project.competitors` JSON stays readable during migration | ✅ | Column untouched, still populated by `intake` |
| D4 — full `technical-audit` per competitor is NOT in scope | ✅ | Not called; documented explicitly here and in LEFT-OUT.md |
| §6 API surface — discover/list/gap | ✅ | All three endpoints implemented |
| §5 data model — `Competitor`, `CompetitorProfile` | ✅ | Both added |
| §12.1 — competitors derived from the client's services + markets, not a global list | ✅ | `discoverByMarket()` composes from `BusinessProfileService`'s confirmed services/markets |
| §12.2 — exclusion list (directories/partners/publishing platforms) | ✅ | `EXCLUDED_DOMAINS`, plus the client's own domain; exclusions counted + sampled |
| §12.2 — relevance classification (direct competitor / adjacent alternative) | ✅ | Assigned from evidence; `not-relevant` is only ever set by a human |
| §12.2 — rejection memory prevents rediscovery loops | ✅ | `CompetitorRejection` tombstone written before delete; `listCandidates()` self-heals |
| §12.3 — page load makes no paid calls | ✅ | Free pass reads stored rows only; the paid pass requires `collectNew: true` |
| §12.3 — comparisons are versioned and never retroactively mutated | ✅ | `CompetitorComparisonSnapshot`, read verbatim, provenance attached |
| §12.2 — candidates require human confirmation before joining the tracked set | ✅ | `status: "candidate"`; never profiled, never in `/gap`, never fed to the AEO prompt |
| §12.3 — store source IDs, extraction version, competitor-set version | ✅ | `CompetitorComparisonSnapshot` provenance (see above) |
| §12.4 — no combined "competitor score" from unrelated metrics | ✅ | `/gap` is a diff; AEO and SERP statuses are reported side by side with no composite score |
| §12.4 — AI appearances/recommendations by topic and market | ⚠️ | Out of this module: the AEO/AI-visibility surface owns per-topic AI answers. `/gap` attaches the project's most recent completed `AeoAudit.verdict` for a rival, but does not break it down by topic against Google positions |
| §12.4 — evidence-backed content gaps | ⚠️ | The profile diff (tech/schema/SEO/reviews) is here; the keyword/content gap list is the `opportunities` module's (§12.6/§12.7) |
| §12.4 — "not checked / not found within checked results", not automatic zero | ✅ | `aeoStatus` reads `unknown` when no completed audit exists, `absent` only when one exists and does not name this rival |

## Testing notes

- `backend/smoke/competitors.smoke.sh` — the original wave-6 end-to-end
  check: a throwaway project seeds `Project.competitors` (JSON) directly via
  Prisma (same pattern as `authority.smoke.sh`), then exercises
  discover → list → gap against real domains, asserting on promotion, profile
  shape, and the gap diff.
- `backend/smoke/competitors-unified.smoke.sh` — the P06/§12.1–§12.4 exit-gate
  proof. Run it with `/opt/homebrew/bin/bash` and `API=http://localhost:3002/api`
  (the harness's default). What it asserts, in its own terms:

  - the **free** pass (`collectNew` omitted) reports `queriesRun: 0` and
    `costUsd: 0`, proposes a real rival, and excludes `clutch.co` with a
    reason visible in `exclusionSample`;
  - a rival named in a stored AEO verdict is classified `direct-competitor`;
  - re-running proposes **0** new candidates (dedup + rejection memory);
  - rejecting a candidate removes it from `/candidates` and it does not
    resurface on a later discovery pass; confirming a candidate flips it to
    `tracked`;
  - `GET /gap` makes **no paid call**; a rival with a completed audit that
    does not name it reads `aeoStatus: 'absent'`, a never-observed rival reads
    `'unknown'` — never a silent zero;
  - `collectNew: true` with `provider: fixture` runs the bounded searches at
    `costUsd: 0` and excludes `wikipedia.org`;
  - a frozen snapshot reads identically twice across a changed competitor set,
    and the snapshots list accumulates rather than being overwritten;
  - reclassifying to `not-relevant` leaves `status=candidate` (classification
    is not confirmation);
  - an unknown project / snapshot id is a 404.

  **Not re-run during documentation.** This README was written while other
  agents were mid-flight on shared source and the dev database, so running the
  suite could have produced a false negative. The assertions above are read
  from the script; none of them is a claim that the suite passes right now.

### A note on this worktree's `AeoAudit` model

~~This module was built in a git worktree branched before the `aeo-audit`
module had landed... a minimal, non-relational mirror...~~ **Resolved:** the
full relational `AeoAudit` model (with `SiteContext`/`AeoStance`/
`AeoSurfaceRun` relations) is now in `schema.prisma`; this module reads
`verdict` off that model directly. No mirror remains.

⚠️ `SPEC.md` and `REQUIREMENTS.md`/`SETUP-STATUS.md` still describe that
worktree-era arrangement and have not been rewritten — where they and this
README disagree, the code and this README are current.

## G19/D01 — the three candidate operations are in the contract (2026-09-16)

`Appendix B` D01: "OpenAPI has 261 operations; controller extraction has 264.
Extra routes in competitors controller: candidate list/confirm/delete." The
routes existed in source, but only as bare `@ApiOperation({ summary })` — and
the checked-in `backend/openapi.json` does not contain them at all.

**Nothing about the routes changed**; what changed is that their contract is now
written down in `competitors.controller.ts`, where the schema generator reads it:

| route | envelope | documented statuses |
|---|---|---|
| `GET  …/competitors/candidates` | `{ candidates: Competitor[] }`, always `status="candidate"` (possibly empty) | 200, 404 |
| `POST …/competitors/candidates/:competitorId/confirm` | the now-tracked `Competitor` row, `status="tracked"` | 201, 404 |
| `DELETE …/competitors/candidates/:competitorId` | `{ deleted: true }` | 200, 404 |

`COMPETITOR_ROW_SCHEMA` states the two vocabularies a caller has to switch on,
which no annotation recorded before:

- `status`: `tracked | candidate`. `candidate` rows are never profiled, never
  returned by `/profiles` or `/gap`, and never fed back into the AEO stance
  prompt as a "known competitor".
- `source`: `project-json | manual | aeo-answer` — with `aeo-answer` called out
  as the only producer of candidates today.

`GET /profiles` now says explicitly that it excludes candidates (it always did,
via `status: { not: 'candidate' }`); the old description left that to be
inferred from a one-line summary.

**Not done, and why:** `backend/openapi.json` was not regenerated. It is a
checked-in artifact with no generator in `package.json` and no script anywhere
in the repo (`api-docs.html` is hand-authored HTML, not a Swagger bundle), so
regenerating it would mean hand-editing a 605 KB document — which is exactly how
it drifted from source in the first place. **It needs regenerating from the
running app's `/api/docs-json` before any client is generated from it.**

**Verified:** `npx tsc --noEmit` clean for this module; the routes are still
registered (confirmed on a booted instance).
