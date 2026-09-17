# Digital performance score — the §5.4 metric design gate

> **Status:** ✅ built (P14 — `digital-performance / 1` rubric, 2026-09-17)
> **Asked for:** plan §5.2–§5.5 — *"Introduce an explicit score family and
> methodology version, for example `digital-performance / 1`, while preserving
> existing `ScoreRun` history and rubric versions."*
> **Phase:** P14. Exit gate: *"Fixture-calculated scores match exactly;
> incomplete data has no fake total."*

---

## 1. What this is, and what it is not

One question: **how is this client doing across the six areas the plan names —
and what can we honestly say when one of them has not been measured?**

It is *not* the existing score. §5.2 is explicit: the five-dimension
`ScoreRubric`/`ScoreRun` roll-up answers "a narrower AI/search-readiness
question" and *"these are not interchangeable."* The two families are separate
in the database, in the API (`/scores/…` vs `/scoring/…`) and in this document.
Nothing here reads, rewrites or relabels a `ScoreRun` row, and no report
revision is reinterpreted.

This document is the **metric design gate** §5.4 requires: for every submetric,
the business question, exact formula, source and availability, scope, curve,
minimum sample, maximum age, double-counting analysis and versioned fixtures.

### ⚠ This rubric is a proposal, not a validated score

The bucket weights (25/20/20/15/10/10) are §5.2's table, and §22 **D01 ("Score
buckets and weighting")** is still flagged *"Required before scoring
implementation/activation."* The user asked for this phase end to end, so it is
implemented — but implemented as **versioned configuration**, and every read of
the score carries `weightsApproved: false` with the approval note attached. A
change to the weighting is a new `ScoreMethodology` row (a new version), never a
code edit, and never a rewrite of a stored run.

---

## 2. The calculation contract (§5.3), as implemented

1. **Applicability is a recorded decision.** A bucket is applicable unless a
   `ScoreApplicabilityDecision` row says otherwise, and a `not-applicable`
   decision **requires a reason** (`PUT …/applicability` returns 400 without
   one). A bucket that merely could not be measured stays **applicable** and
   reads `not-measured`. That distinction is load-bearing: only an explicit
   `not-applicable` decision sets `effectiveWeight` to 0 and redistributes
   weight. `not-measured` keeps the full weight, which is what makes the run
   incomplete instead of quietly easier to total.
2. **Validity is checked per bucket**: a successful source record must exist, be
   within the bucket's `maxAgeDays`, and clear its `minSample`; the metric
   version comes from the methodology row the run used.
3. **Every value is a deterministic count over stored rows.** No evaluator calls
   a model and no evaluator reads a narrative field (§5.3 rule 3). The AI
   visibility bucket counts *stance labels a judging model already wrote* — the
   model wrote the label, it does not set the number.
4. **Any applicable bucket unmeasured or invalid ⇒ `status: "incomplete"`, and
   `total` is `null`.** `weightedPointsTotal` is nulled with it, so no reader can
   present a partial sum as a total. The measured buckets still show their
   values.
5. **Only when every applicable bucket is `measured`**:
   `total = roundHalfUp(Σ(weight × bucketValue) / Σ(applicableWeight))`.
   The total and the coverage figure are the only rounded outputs;
   `ScoreBucketRun.contribution` is stored **unrounded** on purpose.
6. **Weighted evidence coverage** is returned independently as
   `evidenceCoverage`, with `coverageMeaning` attached: *the share of applicable
   weight actually measured — not statistical confidence and not business
   performance.*
7. **"Last complete score".** `GET …/latest` returns `latest` and `lastComplete`
   as **two separate objects with different run ids**, so their numbers can never
   be blended. When the latest run is incomplete, a `note` says so.

### Rounding, exactly
`roundHalfUp(x) = Math.floor(x + 0.5)` for the non-negative values this rubric
produces (every metric is a non-negative count or percentage). Rounding happens
at: a submetric's own percentage, a bucket's mean of its scored submetrics, the
final total, and the coverage figure. Nowhere else.

### The five bucket states, and their precedence
| # | State | Condition |
|---|---|---|
| 1 | `failed` | A source reported its own failure on an attempt newer than its last success, or the evaluator itself threw. |
| 2 | `not-measured` | No successful source record at all. |
| 3 | `outdated` | A successful record exists but is older than `maxAgeDays`. |
| 4 | `not-measured` | Source present and fresh, but the denominator is below `minSample`. |
| 5 | `measured` | A value was produced. |

`not-applicable` is resolved **before** this machine, from the recorded decision.

**Why `failed` outranks `outdated`:** silently falling back to a stale number
while the refresh is broken is precisely the smoothing §5.3 rule 4 exists to
prevent, and "we tried and it broke" is a different operational fact from "we
haven't looked recently". The trade-off is real and accepted: a failed
background rediscovery will flag its bucket even when a recent-enough inventory
exists, and the operator sees exactly which bucket and which error.

---

## 3. The buckets, and why they are not traffic metrics

| Bucket | Weight | Source table(s) | Explicitly not |
|---|---:|---|---|
| Website health | 25 | `TechnicalAudit`, `AuditPage` | Google visitor volume |
| Google visibility | 20 | `GoogleDataSnapshot` (search-console) | global domain popularity; paid/advertiser competition |
| AI visibility | 20 | `AeoAudit`, `AeoStance` | a promise of ranking in every AI system |
| Online profiles | 15 | `PresenceAccount` | a raw count of platforms |
| Social activity | 10 | `PresenceAccount`, `PresencePost` | raw follower count |
| Content quality | 10 | `ContentBrief`, `ContentRevision` | the count of drafts generated |

### Double counting: the rule that keeps the six honest
**No two buckets read the same source table.** Website health reads the crawl;
Google visibility reads stored Search Console facts; AI visibility reads judged
answers; online profiles and social activity split cleanly between *the account
inventory* and *the activity attached to it*; content quality reads the agreed
brief set and its revisions. A metric may therefore only appear in one bucket,
and the check is mechanical: a source table appearing twice above is a design
error. Two near-misses are handled deliberately:

- **Website health vs Google visibility.** "Do the pages load and are they
  good?" is a crawl fact; "do we appear for searches?" is a search fact. A fast,
  clean site with no search presence is a real and important state, and merging
  them would hide it. Visitor volume is excluded from both — it belongs to
  Analytics, which the rubric does not touch.
- **Online profiles vs social activity.** The inventory asks whether the accounts
  exist and are confirmed; the activity bucket asks whether they are used. An
  account with no activity scores 0 on cadence and 100-ish on confirmation —
  which is the honest pair of answers, and is why the *confirmed* account is the
  scope gate for the activity bucket rather than an activity signal itself.

### Content quality does not read the crawl
`AuditPage` describes pages we fetched from the client's own site.
`ContentBrief`/`ContentRevision` describes work the client agreed to and we
produced. They are different objects with different owners, so the same page can
never be scored twice even when a delivered article was later published on the
site.

---

## 4. The submetrics, one at a time

Every bucket value is the half-up mean of its **scored** submetrics. A submetric
whose denominator is 0 is **excluded** with a stated reason, never entered as a 0.

### 4.1 `website-health/1` — weight 25, max age 30 days, min sample 3 pages
| Submetric | Business question | Numerator / denominator | Units, rounding |
|---|---|---|---|
| `page-retrievability` | Of the pages the site's own sitemap lists, how many can actually be fetched? | pages with HTTP 200 ÷ pages the crawl stored | percent, half-up |
| `page-quality` | Of the pages that load, how many clear the per-page quality floor? | pages with `score ≥ 60` ÷ pages with HTTP 200 | percent, half-up |

- **Source & availability.** `TechnicalAudit` (newest by `createdAt`) +
  `AuditPage`. A page with `status = 0` (the fetch threw) is *not retrievable*
  and *not* in the quality denominator — the same "excluded, not failed" rule the
  legacy scorer applies to `status: 'error'` findings. No audit at all ⇒
  `not-measured`.
- **Scope.** The project's own domain, every sitemap URL the newest crawl
  fetched. Nothing here is a benchmark against other sites.
- **Curve, and why it is fair across company types and sizes.** Both submetrics
  are proportions of a site's *own* pages, so a 12-page site and a 4,000-page
  site are judged by the same standard of self-consistency. `60/100` is the
  technical-audit's own per-page rubric (a deterministic published scale), not a
  number invented here.
- **Unknown vs observed zero.** A crawl of 5 pages where all 5 return 200 and one
  scores 40 gives `retrievability = 100`, `quality = 80`, bucket `90`. A crawl
  where all 5 return 404 gives `retrievability = 0`, `quality` **excluded**
  (no denominator), bucket `0` — a real, measured zero. A crawl that stored no
  pages gives `not-measured`, never 0.
- **Known limitation.** The bucket cannot see pages missing from the sitemap, and
  it says so in its own `notes` rather than implying site-wide coverage.

### 4.2 `google-visibility/1` — weight 20, max age 30 days, min sample 5 queries
| Submetric | Business question | Numerator / denominator | Units, rounding |
|---|---|---|---|
| `queries-on-target` | Of the searches this site is actually visible for, how many show up at position 20 or better? | queries with impression-weighted position ≤ 20 ÷ queries with ≥ 1 impression | percent, half-up |

- **Source & availability.** The newest stored `GoogleDataSnapshot` with
  `service = "search-console"`, `kind = "page-query-date"`. **No live call**: the
  snapshot is written by the explicit Website sync (§7.6), so building a score
  never refreshes a paid provider (§5.7). Not connected / never synced ⇒
  `not-measured` with a reason that says exactly that.
- **Aggregation.** Stored rows are page/query/date/country/device. A query's
  position is its **impression-weighted average** across its rows, which is the
  only aggregation that does not let a one-impression page-2 impression outvote a
  thousand-impression page-1 one.
- **Scope and its honest limitation.** §5.2 asks for "an agreed, measured set of
  relevant queries/pages". **Narrowing to an operator-approved query set is NOT
  implemented in v1** — it needs the query-set approval surface, and matching
  Search Console query strings to stored prompts would be an invented fuzzy rule,
  not a measurement. v1 therefore measures *every query with at least one
  impression in the stored window*, states that in the bucket's own `notes`, and
  exposes `scope.querySource = "all-queries-in-window"` so a later approved
  version can switch it to `approved-query-set` **as configuration**.
- **Also honest about:** a snapshot with `complete = false` is a partial fetch,
  and the bucket says so in `notes` instead of implying property-wide coverage.
- **Curve.** A proportion over the client's own observable queries. It is a
  visibility measure, not a difficulty measure: advertiser competition is never
  mixed in, because Search Console rows are organic only.
- **Unknown vs observed zero.** No stored queries at all ⇒ `not-measured`. Five
  stored queries, none inside position 20 ⇒ `measured`, value `0`.

### 4.3 `ai-visibility/1` — weight 20, max age 30 days, min sample 5 judged answers
| Submetric | Business question | Numerator / denominator | Units, rounding |
|---|---|---|---|
| `mention-rate` | How often is the business named at all? | answers whose stance is any of `recommended-primary`, `recommended-alternative`, `mentioned-neutral`, `mentioned-negative` ÷ judged answers | percent, half-up |
| `recommendation-rate` | How often is it recommended, not merely mentioned? | answers whose stance is `recommended-primary` or `recommended-alternative` ÷ judged answers | percent, half-up |

- **Source & availability.** The newest **completed** `AeoAudit` and its
  `AeoStance` rows. A newer audit that is still running does **not** blank the last
  real measurement; a newer audit the source itself reports as `failed` **does**
  turn the bucket `failed` — and the message says the refresh broke rather than
  scoring an older sample as current.
- **Scope.** Every surface the audit actually ran, over the audit's own question
  sample; the surface list and the markets are written into the bucket's
  `sources`, so "named on Perplexity, invisible on ChatGPT" stays visible.
- **Curve.** Two proportions of the same sample, averaged. No weighting by
  surface and no difficulty adjustment: with `minSample = 5` and a whole-sample
  denominator, a small sample cannot be dressed up as a strong one — it simply
  fails the minimum and the bucket stays `not-measured`.
- **§5.2's exclusion, in the payload.** The bucket's `notes` state that this is
  the measured sample, "not a promise of ranking in every AI system".

### 4.4 `online-profiles/1` — weight 15, max age 90 days, min sample 1 account
| Submetric | Business question | Numerator / denominator | Units, rounding |
|---|---|---|---|
| `confirmed-share` | Of the accounts we know about, how many has someone confirmed are yours? | accounts in state `confirmed` ÷ accounts in states `confirmed`, `unverified`, `missing` | percent, half-up |
| `verification-evidence` | Of the accounts we call confirmed, how many carry the evidence that confirmed them? | confirmed accounts with `verifiedAt` and HTTP 200 ÷ confirmed accounts | percent, half-up |

- **Source & availability.** `PresenceAccount` rows with `entity = "company"`.
  `candidate` rows are excluded: a candidate is a question the operator has not
  answered, and §5.2 scores *"confirmed relevant accounts"*.
- **Why the second submetric exists.** §5.2 says "confirmed ... **and evidence**".
  `verification-evidence` is the only honest way to say that without inventing a
  quality judgement: it asks whether the confirmation itself is backed by a
  stored read. When nothing is confirmed the submetric is **excluded**
  (there is no confirmed account whose evidence could be missing) rather than
  scored 0, which would punish a project for the order it did things in.
- **`unverified` is not a failure.** Instagram and Facebook serve login walls and
  LinkedIn returns 999 to datacentre IPs, so `unverified` is the routine honest
  outcome for exactly the platforms that matter most — a documented constraint of
  this codebase, not an assumption. It lowers `confirmed-share` and is disclosed
  as such.
- **Curve.** Shares of the client's own inventory. Never a count of platforms:
  more listings is not a better business, and a business relevant to two
  directories can score 100.

### 4.5 `social-activity/1` — weight 10, max age 30 days, min sample 1 observed channel
| Submetric | Business question | Numerator / denominator | Units, rounding |
|---|---|---|---|
| `cadence:<platform>` (one per channel in scope) | Does the business post on this channel at least as often as the cadence agreed for it? | observed posts in the last 28 days ÷ (agreed posts/week × 4) | percent, half-up, **capped at 100** |
| `engagement-facts` | How much engagement did the observed posts receive? | recorded counts | **not scored** (`scored: false`) |

- **Source & availability.** Confirmed company `PresenceAccount` rows define the
  channels **in scope** (a channel only counts if the account is confirmed *and*
  the methodology defines a cadence for that platform); `PresencePost` rows carry
  the activity. A channel with **no** stored row at all is *not fetched* — it is
  removed from the average with that stated reason, because its activity is
  unknown, not zero.
- **§5.3's cadence rule, literally.** Cadence is per channel and lives in
  `thresholds.channelPostsPerWeek` on the methodology version:
  LinkedIn 2/week, Instagram 3/week, Facebook/X/YouTube/TikTok 1/week, with
  `defaultPostsPerWeek` as the fallback for an unlisted platform. *"A B2B business
  must not be penalized for not posting daily on TikTok"* — it isn't: TikTok is
  not in a B2B project's scope unless a confirmed account puts it there, and even
  then it is held to 1/week.
- **Curve.** The submetric compares a channel against **the agreed cadence for
  that channel**, not against a global target and not against other companies.
  It is capped at 100 so over-posting earns nothing extra: cadence is a floor of
  presence, not a leaderboard.
- **Unknown vs observed zero.** A confirmed channel that *was* fetched in the
  window with zero posts in it scores `0` — a measured zero. A confirmed channel
  that was never fetched is excluded from the average and named in `notes`. If no
  channel was fetched, the bucket is `not-measured`.
- **What is recorded but deliberately not scored.** Median likes, median
  comments, posts in window and the largest follower count seen are stored as
  `facts` on a `scored: false` submetric. §5.2 rules out raw follower count as a
  success score, and **no defensible comparison dataset exists** to turn
  engagement into a score — so it is not turned into one.

### 4.6 `content-quality/1` — weight 10, max age 180 days, min sample 1 approved brief
| Submetric | Business question | Numerator / denominator | Units, rounding |
|---|---|---|---|
| `brief-coverage` | Of the pieces the client agreed to produce, how many have written content against them? | approved briefs with ≥ 1 saved revision ÷ approved briefs | percent, half-up |
| `brief-target-met` | Of the written pieces with an agreed length, how many reached it? | revisions with `wordCount ≥ 0.8 × brief.wordTarget` ÷ revisions whose brief has a target | percent, half-up |

- **Source & availability.** `ContentBrief` rows with `status = "approved"` — the
  **agreed** important-content set — and the **latest saved revision of each
  content asset** (`ContentRevision`), so a superseded draft is never scored as
  the delivered content. No approved brief ⇒ `not-measured`: a content score
  without an agreed set would only measure how much was drafted, which §5.2
  excludes.
- **Curve.** Against each brief's **own** word target — the number the client
  agreed to — with an 80 % floor so that a brief written to 800 of 1,000 words
  is not treated as a failure. No external "ideal article length" is assumed.
- **Unknown vs observed zero.** One approved brief with no revision is an
  observed `0 %` coverage. Zero approved briefs is `not-measured`.

---

## 5. Trends, segments and drilldown (§5.5)

Two runs are comparable only when **all** of these match: score family,
methodology version, applicability decisions, market set, source (metric)
versions and measurement-window definitions. That tuple is hashed into
`ScoreFamilyRun.comparisonKey`.

- Same key ⇒ `comparisonState = "comparable"`, same `segmentIndex`, and a change
  is shown **only if both runs are `complete`**. Two incomplete runs, or a
  complete run beside an incomplete one, produce `changeInTotal: null` with a
  reason — never a subtraction against a number that does not exist.
- Different key ⇒ `comparisonState = "scoring-changed"`, `segmentIndex`
  increments, and the reader is told **"Scoring changed"**. `GET …/trend` groups
  runs into `segments`; there is no code path anywhere that averages two segments
  together.
- **Concrete dates are deliberately NOT in the key.** The key carries window
  *definitions* (28 days, 30-day max age) so a comparison does not break merely
  because a day passed; the concrete dates live per bucket in
  `windowStart`/`windowEnd`.
- **The market set comes from the newest *confirmed* `BusinessProfile`.** An
  unconfirmed draft profile cannot silently invalidate a client's score history.
- **Drilldown.** Each bucket stores `detailPath` + `detailQuery` and its own
  measurement window, returned as `detail.period`, so a bucket card opens
  client-safe detail with the period preserved.

---

## 6. What this document deliberately does NOT invent

§5.4 is a gate against fabrication, so the exclusions are as important as the
formulas:

| Not built | Why |
|---|---|
| Any **"confidence: 92 %"** style badge | No statistical method is defined for it. `evidenceCoverage` is shipped instead, labelled as coverage — a count of how much applicable weight was measured — and explicitly *not* confidence. |
| Any **percentile / "better than 78 % of businesses"** comparison | There is no defensible comparison dataset. **This document deliberately does not invent one**, and no bucket references one. Every submetric compares a client against its own pages, its own queries, its own agreed briefs, its own agreed cadence or its own account inventory. |
| A **band table** ("weak / good / excellent") | The plan does not define band names for this score, and there is no approved basis for the cut-offs. `MethodologyConfig.bands` exists and `ScoreFamilyRun.band` is a real column, so a later approved version can add bands **as configuration**. v1 returns `band: null`. |
| **Engagement** as a score | No defensible benchmark; recorded as facts and marked `scored: false`. |
| A **social "health" score** from follower counts | §5.2 excludes raw follower count as a success score. |
| An **agreed query set** for Google visibility, and a **quality rubric** for AI answers | Both need an approval surface that does not exist yet. Both are declared as v1 limitations in the bucket's own `notes` and in `scope`, and both are switchable by configuration in a later version. |
| A **content-quality judgement** of the writing itself | "Good writing" is not measurable deterministically here. The bucket measures coverage of the agreed set and delivery against the agreed target, and says so. |

If an area cannot be measured defensibly, its standalone facts are shown and the
overall score stays **incomplete** — which is the plan's instruction and the
literal exit gate.

---

## 7. Versioned fixtures (§5.4's last requirement)

`backend/smoke/digital-performance-score.smoke.sh` seeds inputs whose expected
values are stated by hand and asserts **exact** equality — the P14 exit gate.

**Methodology v1 fixture, all six buckets valid:**

| Bucket | Seeded inputs | Expected bucket |
|---|---|---:|
| Website health | 5 sitemap pages, all HTTP 200, page scores 92/85/78/64/40, floor 60 | retrievability `100`, quality `80` → **90** |
| Google visibility | 5 queries at positions 3/9/14/19/26, target ≤ 20 | **80** |
| AI visibility | 5 judged answers: primary, alternative, alternative, neutral, absent | mention `80`, recommendation `60` → **70** |
| Online profiles | 5 company accounts: 2 confirmed (both with evidence), 3 unverified | confirmed `40`, evidence `100` → **70** |
| Social activity | LinkedIn agreed 2/wk with 4 posts in 28 d; Instagram agreed 3/wk with 12 posts | `50` and `100` → **75** |
| Content quality | 5 approved briefs, 4 with a revision; 4 revisions with a target, 3 meeting 0.8 × | coverage `80`, target `75` → **77.5 → 78** |

`Σ(weight × value) = 2250 + 1600 + 1400 + 1050 + 750 + 780 = 7830`;
`Σ applicable weight = 100`; **total = 78**, coverage 100. The half-up step is
exercised by content-quality (`77.5 → 78`), not applied to any intermediate.

| Case | Fixture | Expected |
|---|---|---|
| **Maximum** | as above | `complete`, total exactly **78** |
| **N/A** | social activity recorded `not-applicable` with a reason | `complete`, numerator `7080`, denominator `90`, total **79**; social `effectiveWeight = 0` |
| **Partial** | social-activity rows deleted | `incomplete`, `total = null`, `weightedPointsTotal = null`, coverage **90**; the other five buckets keep their values; social `effectiveWeight = 10` (unmeasured ≠ N/A) |
| **Outdated** | social rows backdated 60 days | `outdated`, `incomplete`, no total |
| **Failed** | a newer `AeoAudit` with `status = "failed"` | `failed`, `incomplete`, no total — in the same run as the `outdated` bucket, so the two states are distinguishable side by side |
| **Boundary** | the same inputs run twice | identical totals and bucket values (determinism), and the earlier run's rows are byte-identical afterwards (immutability) |

---

## 8. Open items for approval

1. **§22 D01 — the weights.** Implemented as proposed and marked unapproved on
   every read. An approved change is a new `ScoreMethodology` version.
2. **Google visibility scope.** Approve an operator-owned query set (or confirm
   "every query with impressions" for v1).
3. **Bands**, if the score should ever read "good" rather than a number.
4. **AI visibility `minSample`.** Currently 5 judged answers, matching the AEO
   module's own `n≥5` convention. A larger sample gives a more stable bucket.
5. **`failed` vs `outdated` precedence** (§2) — accepted as designed; worth
   revisiting if a flaky background refresh makes the score flap.
