# Wave 6 — Completing the audit pipeline, stages 1–7

> **Status:** ✅ **Approved 2026-09-11** — decisions recorded in §3. Two inputs
> still needed before step 1 can run live: the Cloro API key and the Apify actor
> ids (§9).
> **Date:** 2026-09-11
> **Scope:** stages 1–7 of the 12-stage delivery flow, **plus** keyword research
> (stage 10) pulled forward on the operator's instruction — see §3 D5.
> **Prior waves:** `wave-2.md`, `wave-4.md`, `wave-5.md`, `swarm-layer.md`, `aeo-audit.md`.

---

## 1. What this wave is

The 12-stage flow is: understand the business → measure its presence everywhere →
find the gaps → decide what to do → produce assets → hand over a roadmap. This
wave finishes the **measurement half** (1–7). Stages 8–12 (findings, strategy,
execution, report) are a later wave and already have partial coverage.

---

## 2. Verified current state

Checked against the codebase, not assumed. ✅ = built, ⚠️ = partial, ❌ = absent.

| # | Stage | Existing coverage | Status |
|---|---|---|---|
| 1 | Discovery & data gathering | `intake`, `aeo-audit/context` (multi-page crawl, services/ICP/pains/outcomes), `technical-audit` (sitemap + per-page rows), `internal-link` (BFS crawl + graph) | ✅ |
| 2 | External presence & reputation | `entity-audit` (platform records), `mention-tracking` (listicles, reviews), `authority` (directories, communities, publications) | ⚠️ discovery only; auto-analysis excluded on ToS grounds, reviews manual |
| 3 | Technology & marketing stack | — (grep confirms no detection anywhere) | ❌ |
| 4 | SEO & technical audit | `technical-audit`, `seo-audit`, `page-analysis`, `internal-link` | ✅ except images/alt + explicit thin-content |
| 5 | Search, AEO & discoverability | `aeo-audit` (10 intents × 3 engines), `serp-intelligence` (SERP + AI Overview via DataForSEO) | ✅ except Maps/local |
| 6 | Market & geographic analysis | `serp-intelligence` supports `location_name`; **AEO geo recorded but not steered** | ⚠️ |
| 7 | Competitor discovery & analysis | competitors are **strings** on `Project.competitors`; `authority` discovers, `aeo-audit` scores share of voice | ⚠️ names only |
| 10 | Keyword research | — (grep confirms no volume/difficulty/CPC) | ❌ |

---

## 3. Decisions

### D1 — Cloro replaces the browser adapters as the AEO measurement surface ⚠️ **reopens the earlier D1-B call**

The operator directed AEO geo to [cloro.dev](https://cloro.dev/docs/introduction/quickstart).
Reading the docs changes more than geo, so this needs an explicit decision.

**What Cloro is:** a monitoring API that queries the *consumer* answer engines on
your behalf and returns the answer text plus sources.

| Engine | Endpoint | Base cost |
|---|---|---|
| ChatGPT | `/v1/monitor/chatgpt` | 5 credits |
| Perplexity | `/v1/monitor/perplexity` | 4 |
| Gemini | `/v1/monitor/gemini` | 4 |
| Google AI Overview | `/v1/monitor/google/ai-overview` | 3 + 2 |
| Google AI Mode | `/v1/monitor/aimode` | 4 |
| Google Search / News | `/v1/monitor/google` · `/google-news` | 3 |
| Copilot | `/v1/monitor/copilot` | 5 |

- **Auth:** bearer token. **Response:** `{ success, result: { text, sources[] } }`.
- **Geo:** `country` parameter on every engine; state targeting +2 on
  ChatGPT/Copilot/Perplexity/Gemini. **This is the thing we could not do at all.**
- **Async:** `POST /v1/async/task` → `taskId`, retrieved by polling
  `GET /v1/async/task/{taskId}` or a webhook. Batches of 500 via
  `/v1/async/task/batch`. **Async avoids the +2 sync surcharge.**
- **Billing:** credits charged only on `success: true`; failures cost nothing.
- **Not available:** Claude, Mistral, Meta AI, DeepSeek, Amazon Rufus — their
  auth requirements conflict with Cloro's terms.

| | Option | Pros | Cons |
|---|---|---|---|
| **A** ⭐ | **Cloro primary, browser adapters retained as an optional secondary** | ToS-clean — no session to maintain, no account to risk, nothing to bypass. Real geo targeting. 9 engines including AI Overview and AI Mode, which we cannot reach at all today. Async + batch + concurrency turns a **3.3-hour** browser run into **~15 minutes**. Cheaper than expected (§7). Zero selector maintenance | A vendor between us and the engine; we inherit their coverage and freshness. Another external dependency |
| **B** | Keep browser adapters as primary | No vendor in the path; we see exactly what a signed-in user sees | Keeps the ToS exposure across three vendors, the session maintenance, the selector drift, and the hours-long runs — and still cannot do geo |
| **C** | Cloro only, delete the browser adapters | Simplest; one path | Throws away a working fallback and any ability to verify Cloro's output independently |

**Recommendation: A. ✅ Approved.** Cloro satisfies the original motivation behind
D1-B — *"an API answer is not what a buyer sees"* — **without** the ToS exposure,
because Cloro queries the consumer products. That was option D1-C in
`aeo-audit.md` ("third-party vendor with a ChatGPT endpoint"), which I originally
recommended as a complement. It is now the primary.

The `SurfaceAdapter` seam already supports both, so this is additive: new
`cloro-*` surfaces alongside the existing `*-browser` ones.

**Browser adapters become the automatic fallback.** Per the operator's decision,
when a Cloro surface fails the run retries that engine on its browser equivalent
rather than recording a dead surface:

| Cloro surface | falls back to |
|---|---|
| `cloro-chatgpt` | `chatgpt-browser` |
| `cloro-perplexity` | `perplexity-browser` |
| `cloro-gemini` | `gemini-browser` |

Fallback is **off unless the browser surface is itself enabled** (`AEO_ALLOW_BROWSER_SURFACE=1`
plus that engine's session), and every observation still records which surface
actually answered — a fallback run must never be reported as a Cloro measurement.
`cloro-ai-overview` and `cloro-ai-mode` have no browser equivalent and fail closed.

> ⚠️ **Verify at build time:** exact `payload` shape per engine, the `sources[]`
> element structure, and the `taskType` enum values. The docs give paths and
> costs; they do not give a full schema in the pages read.

---

### D2 — Stage 2 external presence: DataForSEO ✅ *decided*

Operator chose paid data APIs. DataForSEO is already wired
(`SWARM_ALLOW_LIVE`, `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`) for
`serp-intelligence`, so this is an adapter on an existing vendor.

Target endpoints (**to confirm against their catalogue at build time**):

| Need | DataForSEO family |
|---|---|
| Business profile, hours, categories, ratings | Business Data → Google → My Business Info |
| Reviews + sentiment | Business Data → Google / Trustpilot / Yelp Reviews |
| Directory & citation presence | Business Data → Business Listings |
| Social profile discovery | derive from site outbound links + SERP `site:` queries |

**Limit, and how it is covered:** DataForSEO handles *profiles, listings and
reviews* well but gives no organic social activity (post cadence, engagement).
**That gap is closed by Apify — see D7.**

---

### D3 — Stage 3 technology detection

| | Option | Pros | Cons |
|---|---|---|---|
| **A** ⭐ | **Deterministic fingerprinter in-repo** over HTML, headers, scripts and cookies that `fetcher` already retrieves | No new dependency, no new service, no per-lookup cost. Runs on any page we already crawl — including competitors, which D4 needs. Fully auditable | We maintain the signature table. Misses tech that only appears at runtime |
| **B** | Wappalyzer / BuiltWith API | Large maintained signature set | Paid per lookup; Wappalyzer's open-source core was relicensed — check terms before vendoring signatures |
| **C** | `wappalyzer` npm package | Free, big signature set | Unmaintained forks, heavy Playwright dependency, licence ambiguity |

**Recommendation: A**, seeded with a ~60-signature table covering the categories
the flow names: analytics, ads/tracking, CRM/lead, chat/conversion, CMS, hosting,
CDN, ecommerce, tag managers, A/B testing.

---

### D4 — Stage 7 competitor depth: light profile ✅ *decided*

Operator chose "light now, structured to deepen later". Per competitor:
crawl homepage + high-signal pages, detect tech (D3), read schema, and attach the
SERP/AEO presence we already measure. Stored as **first-class `Competitor` rows**
rather than JSON strings on the project — which is the structural part that makes
"deepen later" real.

**Not in scope:** running the full `technical-audit` per competitor. Those modules
are project-scoped, and making them domain-scoped is a refactor that should be its
own decision, not a side effect of this wave.

---

### D5 — Keyword research pulled forward ✅ *decided*

Operator chose yes. DataForSEO **Keywords Data** (same vendor): search volume,
difficulty/competition, CPC, related and long-tail.

Two things it unlocks that stages 5 and 7 currently guess at:
1. **Demand-weighted prompt matrix** — today every matrix cell is weighted by a
   hardcoded `DIMENSION_WEIGHTS` table. Real volume data lets the matrix spend its
   prompt budget where buyers actually are.
2. **Real competitive gap** — "they rank for 340 keywords worth 12k/mo that you
   don't" instead of a qualitative gap list.

---

### D6 — Cloro plan: **free tier for now** ✅ *decided*

Operator is starting on free credits: **500 credits/month, concurrency 1**. That
is a hard ceiling, and it does not stretch as far as it looks.

**What actually fits in 500 credits** (async, n=5 — the repo's non-negotiable floor):

| Prompts | Engines | Geo | Credits | Fits? |
|---|---|---|---|---|
| 5 | 3 | no | 325 | ✅ |
| **5** | **3** | **yes** | **475** | ✅ **one full comparison audit/month** |
| 10 | 1 | no | 250 | ✅ |
| 10 | 1 | yes | 350 | ✅ |
| 10 | 2 | no | 450 | ✅ |
| 10 | 2 | yes | 650 | ❌ |
| 10 | 3 | no | 650 | ❌ |
| 10 | 3 | yes | 950 | ❌ |

**The operator asked for 5–10 prompts. At 3 engines only 5 fits.** Ten prompts is
reachable on one engine, or two without geo. This is arithmetic, not a limitation
we can engineer around — `n≥5` is a design principle the whole product rests on,
and lowering it to buy prompt count would break every rate the audit reports.

**Recommendation: a new `trial` tier of 5 prompts**, defaulting to 3 engines with
geo (475 credits) — a genuine cross-engine comparison inside the free allowance.
A `trial-wide` variant of 10 prompts × 1 engine is offered for when breadth of
questions matters more than cross-engine comparison.

Two things that make the free tier more usable than it looks:
- **Failed requests cost zero credits**, so building and debugging the integration
  is free — only successful answers bill.
- Concurrency 1 means a 5×5×3 run is ~75 sequential tasks, roughly **12–25 minutes**.
  Slow, but nothing like the browser path's hours.

Upgrade path when it stops fitting, unchanged from the earlier analysis:

| Plan | $/mo | Credits | Concurrency | $/credit | Standard 3-engine audit |
|---|---|---|---|---|---|
| Lite | 30 | 37,500 | 10 | $0.00080 | $7.60 · ~25 min |
| **Hobby** | 100 | 250,000 | 20 | $0.00040 | **$3.80 · ~13 min** |
| Starter | 250 | 650,000 | 50 | $0.000385 | $3.66 · ~5 min |

---

### D7 — Social presence & activity: **Apify** ✅ *decided, actors selected*

This **reverses** the scope note in D2. Organic social activity was going to be
left out because DataForSEO does not cover it; Apify closes that gap.

- **API:** `POST https://api.apify.com/v2/actors/{actorId}/runs` (async) →
  `defaultDatasetId` → `GET /v2/datasets/{id}/items`. The sync run-and-get-items
  variant caps at **300s**, so anything real runs async.
- **Auth:** `Authorization: Bearer $APIFY_API_KEY` (already in the root `.env`).
- **Account:** plan `FREE` — **$5/month usage credit**, 16 GB actor memory,
  datacentre proxies only (`BUYPROXIES94952`), **no residential proxies**.

#### Actors chosen

Selected by querying the Apify Store API and ranking on **reliability first, then
price**: minimum 5 reviews, ≥85% 30-day run success, then weighted by rating,
official-publisher status and monthly adoption.

| Platform | Actor | Rating | 30d success | Price | Why this one |
|---|---|---|---|---|---|
| LinkedIn — company | `harvestapi/linkedin-company` | 4.69★ (11) | 100% | $0.004 /company | **No cookies needed** — no session to maintain |
| LinkedIn — activity | `harvestapi/linkedin-profile-posts` | 4.90★ (20) | 100% | $0.002 /post | Same publisher, no cookies |
| Instagram — profile | `apify/instagram-profile-scraper` | 4.75★ (174) | 99.7% | $0.0026 /profile | Official; 26k monthly users — by far the most-exercised |
| Instagram — posts | `apify/instagram-post-scraper` | 4.29★ (139) | 99.9% | $0.0017 /post | Official |
| Facebook — page | `apify/facebook-pages-scraper` | 4.64★ (54) | 99.9% | $0.012 /page | Official |
| Facebook — posts | `apify/facebook-posts-scraper` | 4.64★ (233) | 99.7% | $0.005 /post | Official; most-reviewed actor in the set |
| X / Twitter | `xquik/x-tweet-scraper` | 4.55★ (14) | 99.9% | **$0.00015** /tweet | ~30× cheaper than any alternative, still 1k monthly users |
| YouTube | `streamers/youtube-channel-scraper` | 4.63★ (40) | 99.5% | $0.0013 | Best adoption in its category |
| TikTok | `clockworks/tiktok-profile-scraper` | 4.71★ (72) | 99.0% | $0.003 /profile | Best adoption in its category |

**Why adoption beat raw price on the defaults.** Cheaper actors exist and are
noted below, but each has 100–800 monthly users against the chosen ones'
5,000–26,000. A scraper with a couple of hundred users rots quietly when the
platform changes its markup, and a rotted actor means a **gap in a client
report**. The map is env-driven, so switching is a config change if the economics
change:

| Platform | Cheaper alternative | Trade-off |
|---|---|---|
| Instagram | `coderx/instagram-profile-scraper-bio-posts` — 5.00★ (9), $0.0011, bio **and** posts in one call | 831 users/30d vs 26k |
| Facebook posts | `scraper_one/facebook-posts-scraper` — 5.00★ (6), $0.0025 | Half the price, 198 users/30d |
| TikTok | `apidojo/tiktok-profile-scraper-api` — 5.00★ (6), $0.0003 | 10× cheaper, 173 users/30d |

#### Default platform set

`linkedin, instagram, facebook, twitter` — YouTube and TikTok configured but off,
since they matter for some verticals and not others. Configured as
`APIFY_ACTORS` (`platform:role → actorId`), normalised into one `PresencePost` /
`PresenceProfile` shape at the adapter boundary: actor output schemas differ
wildly and that variance must not leak into the module.

#### Honest limits on the free plan

- **$5/month is the hard ceiling** — see §7 for what it buys.
- **Datacentre proxies only.** Instagram and Facebook are the most aggressive
  blockers, so those two are the likeliest to underperform here. If they do, that
  is a plan limit rather than a code fault, and the module must report it as such
  rather than as "no social presence found".
- Per-actor input schemas are **unverified**. Step 5 confirms each against one
  live run before building on it.

---

---

### D8 — Markets are derived from the client, not configured globally ✅ *decided*

**Approved:** *"depends on the client, and the areas they provide their services."*

So markets are **not** a fixed list in config and **not** a single country guessed
from the ccTLD. They come from what the client's own site says it serves, and the
operator can override before a run.

| Source | Precedence | Notes |
|---|---|---|
| Operator override on the run | 1 | Explicit `markets[]` on `RunAuditDto` always wins |
| Extracted service areas | 2 | `SiteContextData.markets[]` — cities/regions/countries the site names as served |
| Client HQ / registered geo | 3 | Existing `SiteContextData.geo` |
| ccTLD inference | 4 | Last resort, and flagged as inferred |

**Why it has to work this way.** A local trades business and a global SaaS look
identical to the current extractor — one country string — and that is wrong in both
directions. The trades business needs *towns*, not "United Kingdom"; the SaaS needs
its actual sales regions, not the country its domain was registered in. A single
global list would be right for neither.

**Cost consequence, and the guard it forces.** Markets multiply credits: prompts ×
runs × engines × **markets**. `trial` at 5 × 5 × 3 is already 75 calls at one
market; two markets is 150. The extractor can plausibly return six service areas,
so a naive implementation would silently 6× the spend. Therefore:

- Extracted markets are a **ranked suggestion**, never auto-applied in full.
- A run defaults to **one market** — the highest-ranked — unless the operator picks
  more.
- The budget guard (step 1) counts markets as a multiplier and refuses the run
  before it starts, not half way through.

Provenance is preserved as in D1: browser surfaces report geo as **not steered**,
Cloro surfaces report it as real. A market column that mixed the two would be a
fabricated number.

---

## 4. Build plan

Dependency-ordered. Each step is a complete module per AGENTS.md — built, tested,
documented — before the next starts.

### Step 0 — `trial` matrix tier ✅ **built**
- `TIER_SIZES` gains `trial: 5` and `trial-wide: 10`; `MATRIX_TIERS` exported so
  the DTO enums stop hand-listing the tiers and drifting.
- **Allocation had to change.** The generator floored every eligible dimension at
  one prompt, so a 5-prompt tier produced 10 — the tier would have silently
  doubled the spend it exists to cap. When `target < eligible.length` it now funds
  the `target` heaviest-weighted dimensions at one prompt each and records the rest
  in `skipped`. Verified: `trial` = 5 prompts / 5 categories, `trial-wide` = 10 / 10,
  both deterministic, and `competitor-alternatives` + `head-to-head` survive the
  cut (they are the two heaviest after `service-discovery`).
- Workspace default moves to `trial`, and the selector warns **"probe only — covers
  5 of 10 angles"** so a small tier cannot be mistaken for full coverage.
- ~~*Deferred to step 1:*~~ ✅ **closed 2026-09-12.** `GET /projects/:id/aeo/budget`
  prices a configuration before it runs — credits required, credits remaining,
  and whether it fits — and the workspace shows it live as the operator changes
  engines, tier or markets. Browser surfaces report **0** (a subscription pays
  for them, not the meter). When the balance cannot be read, `remaining` and
  `fits` come back **null** with the reason: an unknown balance is neither
  sufficient nor insufficient, and a tick shown on a guess is worse than no tick.
  First live call was immediately useful — 228 credits left, `trial` × 3 engines
  needs 325, so that run would have been refused after the click.

### Step 1 — `cloro` surface adapters *(unblocks 5 + 6)*
- `measurement/adapters/cloro.adapter.ts`: one base + per-engine subclasses,
  mirroring how `browser-surface.adapter.ts` is structured.
- Async-first: submit via `/v1/async/task/batch`, poll or webhook. Never the sync
  endpoint — the +2 surcharge is a 30–40% cost increase for nothing.
- Surfaces: `cloro-chatgpt`, `cloro-perplexity`, `cloro-gemini`,
  `cloro-ai-overview`, `cloro-ai-mode`.
- `costUsd` from `credits.creditsCharged` × `CLORO_CREDIT_USD` — the real charge,
  same discipline as the OpenRouter cost handling.
- **Budget guard:** a pre-flight estimate refuses to start a run that cannot
  finish inside the remaining allowance. Burning 400 of 500 credits and stopping
  half way is worse than not starting — the operator gets told what will fit.
- **Fallback chain** (D1): a failed Cloro engine retries on its `*-browser`
  equivalent when that surface is enabled. The `AeoSurfaceRun` records
  `attemptedVia` so the report can say an answer came from the fallback.
- Gated: `CLORO_API_KEY` absent → fails closed with a typed reason, as before.
- **Concurrency 1 on the free tier** ✅ **built** — enforced in `CloroClient`
  with an in-flight gate and a FIFO queue, read from `CLORO_MAX_CONCURRENCY`
  (default 1). The executor happens to run prompts sequentially today, so the
  limit was previously 1 *by accident*; the moment anything upstream
  parallelises, that would silently exceed the plan. Slots are released in a
  `finally`, so a thrown task cannot permanently shrink the pool.

### Step 2 — geo in `aeo-audit` *(stage 6)* — per **D8**
- `SiteContextData.markets[]`: extract the service areas the site actually names,
  ranked. This is the input D8 requires; the existing single `geo` becomes a
  fallback, not the source of truth.
- `AeoAudit.markets` (JSON `string[]`), one `AeoSurfaceRun` per **surface × market**,
  defaulting to the top-ranked market only.
- Verdict gains `counted.byMarket` and `byMarketSurface`. ✅ **both built** —
  `byMarketSurface` is the market × engine cross, populated only when more than
  one market was measured (on a single-market audit it would just repeat
  `bySurface`). Each cell carries its own run status, so an engine that failed in
  one market but worked in another cannot inherit the aggregate and disappear.
- Browser surfaces keep reporting geo as **not steered**; Cloro surfaces report it
  as real. The report must never present the two as the same kind of number.

### Step 3 — `tech-stack` module *(stage 3)*
- Signature table + detector over `fetcher` output; `TechStackScan` / `TechFinding`.
- Runs against **any domain**, so competitor profiling reuses it unchanged.

### Step 4 — `keyword-research` module *(stage 10, pulled forward)*
- DataForSEO Keywords Data adapter; `KeywordSet` / `Keyword` rows.
- ~~Feeds the AEO matrix generator an optional demand weighting.~~ ✅ **built
  2026-09-12.** `generateMatrix` takes an optional `DemandIndex`
  (keyword → monthly volume, loaded from the project's latest `KeywordSet`) and
  orders the client's services by measured demand. It matters most where the
  budget is tightest: a 5-prompt `trial` that spends its one service-discovery
  cell on the offering nobody searches for has wasted the run. **Ordering only** —
  no prompt is invented, dropped or rewritten from a volume number, so a stale
  keyword set can reorder the matrix but can never put a service in it that the
  client does not sell. Services with no matching keyword keep their original
  order and sit after the matched ones; absence of a volume figure is not
  evidence of low demand. No research run → unchanged behaviour.

### Step 5 — `external-presence` module *(stage 2)*
- **Two adapters behind one module:**
  - DataForSEO Business Data → `PresenceProfile`, `PresenceReview` (profiles,
    listings, reviews)
  - Apify actors → `PresencePost` (social activity: cadence, engagement)
- Actor ids come from an `APIFY_ACTORS` map (`platform → actorId`), so swapping or
  custom-building an actor is an env change. Each actor's raw output is normalised
  at the adapter boundary — actor schemas differ wildly and that must not leak.
- Apify runs async (`POST /v2/actors/{id}/runs` → poll → `GET /v2/datasets/{id}/items`);
  the 300s sync variant is too short for anything real.
- Consistency checks reuse `entity-audit`'s descriptor logic rather than
  repeating it. ✅ **built** — the rules were extracted from
  `entity-audit.service.ts` into `entity-audit.consistency.ts` (pure, no Nest),
  and **both** modules now import it, so neither can drift. Two rules, because a
  recorded name and a fetched title are not the same evidence: `namesMatchExactly`
  is strict (an operator typing "Acme" vs "Acme Ltd" is a real inconsistency
  worth surfacing), `titleIdentifies` is containment (platforms pad titles —
  "Acme Ltd | LinkedIn" — so equality would mark every real profile a mismatch).
  `digital-presence` uses the title rule and reports `nameConsistency` per
  account; no title, as on every walled platform, stays `not-checked`.

### Step 6 — `competitors` module *(stage 7)*
- Promotes competitors to entities; orchestrates steps 3–5 + existing SERP/AEO
  data per rival; produces the gap comparison.
  - Step 3 (tech-stack) ✅, existing SERP/AEO attachment ✅.
  - Step 5 (external presence) ✅ **built** — each rival's own site is crawled
    with `PresenceDiscoveryService.crawl` (reused unchanged; it already took a
    bare domain), company profiles only, and `GET /competitors/gap` gained a
    **`presence` diff** alongside tech and schema. That is the row a client
    reacts to: "three of your four rivals are on Clutch and you are not" is a
    decision, where a tech-stack diff is trivia. The client side of the diff is
    read from stored `digital-presence` rows, never a fresh crawl.
  - **Crawl only, never the paid enrichment.** DataForSEO and Apify spend real
    money per entity; multiplying that by the competitor count is not a cost
    anyone asked for, and profiles are not verified per-platform either (it would
    multiply requests to platforms that wall them, for a number the gap report
    does not use).
  - ⚠️ **Step 4 (keyword research) per rival is not wired** — it needs the same
    `DATAFORSEO_LOGIN`/`PASSWORD` that are still unset, and would bill per
    competitor. Blocked on credentials, not on code.
- Migrates `Project.competitors` JSON → `Competitor` rows, keeping the JSON
  column readable so nothing downstream breaks mid-migration.

### Step 7 — stage 4 residue ✅ **built 2026-09-12**
- **Image/alt coverage.** New `images-missing-alt` issue code. The rule that
  matters: **missing `alt` is the fault, empty `alt=""` is not.** An empty alt is
  the correct, deliberate marker for a decorative image — flagging it would tell
  a client to "fix" markup that is already right, and would train them to stuff
  junk text into it. The extractor drops anything the author marked decorative
  (`alt=""`, `aria-hidden="true"`, `role="presentation"`, 1x1 tracking pixels),
  so the denominator is images that were *supposed* to describe something.
  Band: `maxMissingAltRatio: 0.25` — one undescribed image out of twenty is a
  typo, not a finding, and flagging it would bury the page where half are
  undescribed. A page where **all** images lack alt trips regardless of ratio.
- **Duplicate content.** New `duplicate-content` issue code, applied run-level
  after the crawl (a single page cannot know it is a duplicate). Exact matches
  only, on a whitespace-normalised fingerprint — near-duplicate detection needs a
  similarity threshold, and a threshold is a number this module would have to
  invent and then defend to a client. An exact match is a fact: these two URLs
  serve the same copy. **Every** page in a duplicate group is flagged, not just
  the later ones: without knowing which URL the client considers canonical,
  calling one "the original" would be a guess. Pages that errored are skipped —
  they carry no copy to duplicate.
- **Thin content** was already built (`thin-content`, under 150 words) but had no
  named roll-up either — it, alt and duplicates now all surface in
  `PageInventoryAnalysis` (`pagesThin`, `pagesWithMissingAlt`,
  `pagesWithDuplicateContent`) plus site-wide `imagesTotal` / `imagesMissingAlt`.
  Counted over **every** crawled page, not just flagged ones, so "31 of 212
  images have no alt text" is the site's real figure — a work item, where a list
  of flagged URLs is only a diagnosis. The `page-inventory` finding reports each
  clause **only when there is something to say**, so a clean site does not read
  as a wall of zeros.
- Verified: 10/10 rule cases (band edges, all-missing, errored pages, null
  hashes, whitespace normalisation) plus the extractor over real markup —
  4 content images / 2 missing from a sample containing an empty alt, an
  `aria-hidden`, a `role="presentation"` and a tracking pixel.

### Step 8 — frontend ✅ **built 2026-09-12**
- **Markets tab** on the AEO workspace ✅ (landed earlier with step 2).
- **Competitors workspace** ✅ — five tabs (Overview / Presence / Tech / Schema /
  Rivals), same pattern as AEO and Presence. Reached from `RivalsPanel`
  ("Full gap analysis →") rather than a fifth tile on the Audits card, which is a
  list of *disciplines* and would have to stop meaning that; also in the command
  palette. Three rules the layout enforces:
  - **`unknown` is not `absent`.** A rival with `aeoStatus: unknown` means no
    completed audit exists to attach — nobody looked. Rendering it as "not
    present" would report an unasked question as a negative finding.
  - **`competitorsOnly` leads every diff.** What rivals have and the client does
    not is the actionable half; `clientOnly` is reassurance and sits last.
    Putting reassurance first would bury the finding.
  - **An empty client side is called out.** If nothing is recorded on the
    client's own side, *every* rival signature shows as a gap — the view says so
    rather than letting a missing scan read as a competitive deficit.
- **Tech stack on the Technical audit** ✅ — new `stack` section beside
  Structure. Deliberately **not** folded into the audit score: a CMS is not a
  defect, and scoring "uses WordPress" would turn a fact into a judgement the
  rubric cannot defend. Every row prints its own evidence, because a detection
  you cannot check is indistinguishable from a guess.
- ⚠️ **`keyword-research` still has no UI.** Not in this step's bullet, but it
  leaves the module reachable only by API.

**Verified live** against `rothenhall.com` + its three real competitors — the
endpoint shapes the UI consumes (`/competitors/profiles`, `/competitors/gap`,
`/tech-stack`) all match, and the gap produced a real finding:

```
client platforms: linkedin
they have, you do not:  x  <- Athena, Peec AI
                        youtube  <- Peec AI
shared:                 linkedin
```

---

## 5. Data model

**New:** `TechStackScan`, `TechFinding`, `KeywordSet`, `Keyword`,
`PresenceProfile`, `PresenceReview`, `Competitor`, `CompetitorProfile`.

**Modified (additive only):** `AeoAudit.markets`, `AeoSurfaceRun.market`,
`Surface` union + `cloro-*` entries.

---

## 6. API surface

| Method | Path | Does |
|---|---|---|
| `POST` | `/projects/:id/tech-stack/scan` | Detect stack for the project or any domain |
| `GET` | `/projects/:id/tech-stack` | Latest scan |
| `POST` | `/projects/:id/keywords/research` | Pull volume/difficulty/CPC |
| `GET` | `/projects/:id/keywords` | Keyword set, filterable |
| `POST` | `/projects/:id/presence/scan` | Profiles, listings, reviews |
| `GET` | `/projects/:id/presence` | Latest presence snapshot |
| `POST` | `/projects/:id/competitors/discover` | Promote + profile rivals |
| `GET` | `/projects/:id/competitors` | Competitor list with profiles |
| `GET` | `/projects/:id/competitors/gap` | Gap comparison |

---

## 7. Cost model

### On the free tier (current)

500 credits/month, concurrency 1. Async, n=5.

| Tier | Prompts | Engines | Geo | Credits | Fits? | Wall clock |
|---|---|---|---|---|---|---|
| **`trial`** ⭐ | 5 | 3 | yes | **475** | ✅ one per month | ~12–25 min |
| `trial` | 5 | 3 | no | 325 | ✅ | ~12–20 min |
| `trial-wide` | 10 | 1 | yes | 350 | ✅ | ~8–17 min |
| `trial-wide` | 10 | 2 | no | 450 | ✅ | ~17–33 min |
| — | 10 | 3 | any | 650–950 | ❌ **does not fit** | — |

Failures cost zero credits, so building and debugging the integration does not
consume the allowance — only successful answers bill.

### After upgrading

Per AEO audit, 3 engines, `country` targeting, n=5, Hobby rate ($0.0004/credit):

| Tier | Prompts | Credits | Cost | Wall clock @20 concurrent |
|---|---|---|---|---|
| scorecard | 25 | 2,375 | $0.95 | ~4 min |
| standard | 100 | 9,500 | $3.80 | ~13 min |
| full | 300 | 28,500 | $11.40 | ~40 min |

Each additional market multiplies this.

### Other stages

| Stage | Cost per audit |
|---|---|
| Tech stack (3) | **$0** — own fetcher |
| Keywords (10) | ~$0.05–0.20 (DataForSEO) |
| Presence — profiles/reviews (2) | ~$0.10–0.50 (DataForSEO) |
| Presence — social activity (2) | **~$0.20 per entity** across 4 platforms — see below |
| Competitors (7) | ≈ tech + presence, per rival |

### Apify, measured

Now that the actors are chosen (D7), this is no longer a guess. Per entity —
one profile plus 20 recent posts, on the four default platforms:

| Platform | Profile | 20 posts | Subtotal |
|---|---|---|---|
| LinkedIn | $0.004 | $0.040 | $0.044 |
| Instagram | $0.0026 | $0.034 | $0.037 |
| Facebook | $0.012 | $0.100 | $0.112 |
| X / Twitter | — | $0.003 | $0.003 |
| **Total** | | | **≈ $0.20** |

Against the free plan's **$5/month**:

| Scope | Entities | Cost | Runs/month on $5 |
|---|---|---|---|
| Client only | 1 | $0.20 | ~25 |
| Client + 3 competitors | 4 | **$0.78** | **~6** |
| Client + 6 competitors | 7 | $1.37 | ~3 |

Facebook is **57% of the per-entity cost** on its own. Dropping it to the cheaper
alternative in D7, or turning it off for B2B clients where it carries little
signal, roughly halves the bill.

---

## 8. Risks

1. **Vendor dependency.** Cloro sits between us and the engines. Keeping the
   browser adapters means we can spot-check its output rather than trust it blindly.
2. **Cloro schema unverified.** Paths, costs and the top-level response shape come
   from their docs; exact per-engine payloads were not in the pages read. Step 1
   starts by confirming against a live call on free credits.
3. **DataForSEO coverage varies by market and vertical.** Reviews and listings are
   strong for local/SMB, thinner for B2B SaaS. Where a lookup returns nothing, the
   report must say "not found" rather than "none" — those differ.
4. **Competitor migration.** `Project.competitors` is read by `measurement`,
   `aeo-audit`, `authority` and `serp-intelligence`. The JSON column stays
   populated until every consumer reads `Competitor` rows.
5. **Scope.** This is six modules. The one-module-at-a-time rule holds; anything
   less and the middle of the wave is a pile of half-built scaffolding.

---

## 9. Open questions

Decisions are settled. What remains are **inputs**, not choices:

1. ~~**Cloro API key**~~ ✅ **Resolved** — `CLORO_API_KEY` is in the root `.env`.
   Step 1 starts with one real request to confirm the per-engine payload schema,
   which the docs do not fully specify.
2. ~~**Apify token + actor ids.**~~ ✅ **Resolved.** `APIFY_API_KEY` is in the root
   `.env`; actors selected from the Store API in D7. Remaining choice: confirm the
   default platform set (`linkedin, instagram, facebook, twitter`) and whether to
   enable YouTube/TikTok.
3. ~~**Markets.**~~ ✅ **Resolved** — *"depends on the client, and the areas they
   provide their services"*. There is no global market list. Markets are **derived
   per client from their own stated service areas**, operator-overridable. See D8.
4. ~~**`trial` default.**~~ ✅ **Resolved** — **5 prompts × 3 engines**. Cross-engine
   comparison is the thing the audit does that nothing else does, so the trial
   budget buys that rather than breadth. `trial-wide` (10 × 1 engine) stays
   available for the breadth question.

**All questions are now closed. Implementation is unblocked.**
