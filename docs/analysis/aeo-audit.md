# Module Analysis — `aeo-audit` (ChatGPT-first Answer Engine Optimization audit)

> **Status:** ✅ **Approved 2026-09-10** — see §11 for the decisions as taken.
> **Date:** 2026-09-10
> **Module name:** `backend/src/modules/aeo-audit`
> **Scope of v1:** one platform — **ChatGPT**. Surface-agnostic seams left in place so
> Perplexity / Google AIO / Gemini drop in later without touching the orchestrator.

---

## 1. What the module does

One end-to-end run, from a client URL to a competitive AEO verdict:

```
client URL
   │
   ├─ 1. SITE CONTEXT      scrape the site → what they do, domain/vertical, services, ICP, competitors
   │
   ├─ 2. PROMPT MATRIX     generate the prompts a real buyer would actually type,
   │                        across N dimensions × personas × funnel stages
   │
   ├─ 3. EXECUTION         run every prompt on ChatGPT, n≥5 repeats each, fresh session
   │
   ├─ 4. EXTRACTION        count mentions / citations / competitor co-occurrence (deterministic)
   │
   ├─ 5. STANCE ANALYSIS   judge *how* the client is positioned vs each competitor
   │
   └─ 6. VERDICT           visibility rates, share of voice, per-dimension gaps,
                            "ChatGPT recommends X over you on these prompts"
```

---

## 2. What already exists — the reuse map (read this before proposing new code)

A large part of the requested pipeline is already built in this repo. The `aeo-audit`
module should be an **orchestrator over existing modules**, not a re-implementation.

| Pipeline stage | Existing asset | Verdict |
|---|---|---|
| Site scraping | `fetcher` (UA rotation, rate limits, retries, `render`, `fetchSchema`) | ✅ Reuse as-is |
| Business context | `intake` — homepage-only: brand, category, description, country, competitors, `ownEntities` | ⚠️ Reuse + deepen (homepage-only is too thin for a services matrix — see D2) |
| Competitor list | `Project.competitors` JSON, seeded by `intake` | ✅ Reuse |
| Buyer personas | `persona` — 10-role deterministic generator, seeded PRNG, optional LLM refine | ✅ Reuse as a matrix dimension |
| Prompt storage | `query-set` — versioned, `draft→active→archived`, immutable on activation, exportable | ✅ Reuse (see D5) |
| Funnel taxonomy | `FunnelStage` = problem/solution/product/most-aware | ✅ Reuse |
| Run orchestration | `measurement` — n≥5 enforced, `SurfaceAdapter` interface, cost governor, `MeasurementRun`/`Observation` | ✅ Reuse — this is exactly the right seam |
| Mention extraction | `measurement.extractObservation` — longest-brand-token match, citation host match, competitor co-occurrence | ✅ Reuse |
| Share of voice | `measurement.summary.shareOfVoice` | ✅ Reuse |
| LLM judge pattern | `entity-audit` model-diff judge; `findings` constrained-JSON LLM | ✅ Reuse the pattern |
| Claims discipline | `claims` — A/B/C provenance, rates must come from own n≥5 measurement | ✅ Must comply |

### Genuinely new work

1. **ChatGPT surface adapter** — does not exist. `Surface = 'claude' | 'perplexity' | 'mock'`
   today; `measurement.types.ts` literally comments *"add ChatGPT / Google AIO later
   without touching the service."* That seam was built for this.
2. **Deep site-context extractor** — services / ICP / vertical, beyond `intake`'s homepage pass.
3. **Prompt matrix generator** — a *dimensional* matrix with coverage guarantees, not a flat list.
4. **Stance analysis** — today extraction is boolean `mentioned`/`cited` plus
   `characterization: 'present' | 'absent'`. It cannot answer *"is ChatGPT recommending them
   over a competitor, or the competitor over them?"* — the core question in this request.
5. **AEO orchestrator + verdict** — the single API call that runs 1→6 and returns the report.

---

## 3. Decisions requiring your approval

### D1 — How do we query ChatGPT? ⚠️ **the most important decision**

| | Option | Pros | Cons |
|---|---|---|---|
| **A** ⭐ | **OpenAI Responses API** (`gpt-5`-class model + built-in `web_search` tool), called over raw `fetch` | Official, ToS-clean, stable, deterministic citation annotations, per-token cost, no new npm dep (mirrors how `perplexity.adapter.ts` uses raw fetch), runs unattended in CI | Not literally chatgpt.com — the consumer product has different routing, personalization, memory and grounding. Results correlate with, but do not equal, what a logged-in consumer sees |
| **B** | **Headless browser** driving `chatgpt.com` (Playwright — already a dependency) | Closest to true consumer UX; captures the actual product surface including its ranking of sources | **Violates OpenAI's ToS**; Cloudflare / bot detection; needs a real logged-in session cookie; breaks on every UI change; cannot be sold to clients as a reliable service; account-ban risk |
| **C** | **Third-party vendor with a ChatGPT endpoint** (DataForSEO — *already integrated in `serp-intelligence`* — or SerpApi) | Vendor carries the scraping burden; closer to consumer output than the raw API; DataForSEO creds + gating pattern already exist in this repo (`SWARM_ALLOW_LIVE`, `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`) | Per-query cost; vendor-dependent freshness and coverage; another external dependency to babysit |

**Recommendation: A as the primary adapter, with C added behind the same
`SurfaceAdapter` interface as an optional second provider** (`chatgpt` vs
`chatgpt-consumer`), selectable per run. **B is rejected** — the ToS and reliability
cost is not worth it for a client-facing product.

This also lets the report say honestly *which* ChatGPT surface a number came from, which
the `claims` module's provenance grading requires anyway.

> ⚠️ **Verify at approval time:** the exact current OpenAI model id and the
> `web_search` tool's citation-annotation shape. The model id will be an env var
> (`AEO_CHATGPT_MODEL`), not a hardcoded string — same pattern as `MEASUREMENT_CLAUDE_MODEL`.

**New dependency: none.** Raw `fetch`, per the precedent set in `perplexity.adapter.ts`.

---

### D2 — How deep do we scrape the client site?

| | Option | Pros | Cons |
|---|---|---|---|
| **A** ⭐ | **Extend `intake` via `fetcher`**: homepage + sitemap-guided page picks (`/services`, `/solutions`, `/about`, `/pricing`, `/industries`, `/case-studies`), cheerio extraction, then **one constrained-LLM synthesis pass** into a typed `SiteContext` | Zero new deps; reuses rate limiting + UA rotation; deterministic layer stays auditable; LLM only *synthesizes* what was actually fetched | Weak on heavily JS-rendered sites (mitigated: `fetcher.render` already drives Playwright) |
| **B** | **Firecrawl / ScrapingBee** managed scraping API | Handles JS + anti-bot; markdown-clean output | New paid external dependency; per-page cost; duplicates `fetcher` |
| **C** | **Homepage only** (what `intake` does today) | Free, already built | Too thin — cannot enumerate services, which is the backbone of the matrix |

**Recommendation: A.** Cap at ~12 pages per audit, respect `robots.txt`, reuse `FetcherService`.

---

### D3 — How is the prompt matrix generated?

| | Option | Pros | Cons |
|---|---|---|---|
| **A** | **Fully deterministic templates** (dimension × service × persona, seeded PRNG) | Reproducible, free, guaranteed coverage | Phrasing reads robotic — not how a real person types |
| **B** | **Fully LLM-generated** | Natural consumer phrasing | Non-reproducible; coverage not guaranteed; can invent services the client does not offer |
| **C** ⭐ | **Hybrid**: the deterministic matrix defines the **cells** (coverage contract), an LLM rewrites each cell into natural consumer phrasing **grounded strictly in the scraped `SiteContext`** | Guaranteed coverage *and* human phrasing; reproducible cell set; hallucination-bounded | Costs one LLM pass per audit; needs a fallback to raw template text when no key is set |

**Recommendation: C** — and note this is exactly the pattern `persona` already uses
("the optional LLM refinement only rewrites the freeform strings, never the taxonomy").

---

### D4 — How do we judge competitive stance?

The request's core question — *"is ChatGPT suggesting them as a better alternative, or
suggesting competitors?"* — cannot be answered by string matching.

| | Option | Pros | Cons |
|---|---|---|---|
| **A** | **Deterministic only** — extend `extractObservation` with list position, ordinal, co-occurrence | Cheap, reproducible, fully auditable | Cannot distinguish "recommended first" from "mentioned as the thing to avoid" |
| **B** | **LLM judge on every answer**, constrained JSON | Answers the real question | Costs scale with n≥5 × matrix size; a judged label is not a counted fact |
| **C** ⭐ | **Hybrid, with a hard provenance line**: deterministic extraction remains the *sole* source of every **rate** (mention rate, citation rate, SOV); the LLM judge adds **only qualitative fields** (`stance`, `rankAmongBrands`, `recommendedOver[]`, `losesTo[]`, `evidenceQuote`), stored and reported as **judged, not counted** | Satisfies the `claims` module's A/B/C provenance discipline; answers the question without laundering an opinion into a statistic | Two passes to maintain |

**Recommendation: C.** Proposed stance enum:

`recommended-primary` · `recommended-alternative` · `mentioned-neutral` ·
`mentioned-negative` · `absent`

plus `recommendedOver: string[]` and `losesTo: string[]` per observation, so the report
can state *"on 12 of 20 'alternatives to X' prompts, ChatGPT named Competitor A ahead of you."*

---

### D5 — Where do the generated prompts live?

| | Option | Pros | Cons |
|---|---|---|---|
| **A** ⭐ | **Reuse `QuerySet` / `QuerySetItem`**, adding nullable `dimension` + `meta` columns to `QuerySetItem` and a new `source` value `'aeo-matrix'` | Inherits versioning, `draft→active` immutability, client export ("the query set is the asset"), and — critically — the entire `measurement` execution path for free. Nullable columns = non-breaking | Slightly overloads an existing model |
| **B** | **New `PromptMatrix` / `PromptMatrixItem` models** | Clean separation | Duplicates versioning + immutability + export; `measurement` would need a second code path to execute it |

**Recommendation: A.** This is the difference between writing an adapter and rewriting the engine.

---

### D6 — Cost governor sizing

`n≥5` is a non-negotiable design principle in this repo, so cost scales as
`prompts × 5 × (search-enabled call)`.

| Tier | Matrix size | Calls at n=5 |
|---|---|---|
| Free / scorecard | 25 prompts | 125 |
| Standard | 100 prompts | 500 |
| Full (PRD FR-5.1 ceiling) | 300 prompts | 1,500 |

**Recommendation:** default to the Standard tier, hard-capped by
`AEO_MAX_COST_PER_AUDIT` (mirrors `MEASUREMENT_MAX_COST_PER_RUN` / `TA_MAX_COST_PER_RUN`),
which **stops the run and records the reason** rather than silently truncating.

> Actual $/audit will be filled in once D1's model + pricing is confirmed at approval time.

---

## 4. The prompt matrix — dimensions

Ten dimensions, each covering a different way a real buyer reaches for an AI assistant.
Every cell is `dimension × (service | competitor | persona | modifier)`.

| # | Dimension | Buyer intent | Example shape |
|---|---|---|---|
| 1 | **Service discovery** | "who does this thing" | *"who can help me with {service} for a {ICP}?"* |
| 2 | **Category / best-of** | shortlist building | *"best {category} companies in {geo}"* |
| 3 | **Competitor-named alternatives** ★ | actively shopping away | *"alternatives to {competitor}"* |
| 4 | **Head-to-head comparison** ★ | final two | *"{client} vs {competitor} — which is better for {ICP}?"* |
| 5 | **Brand-direct** | validating you | *"is {client} any good?"*, *"{client} reviews"* |
| 6 | **Problem-framed** | pre-category, pain language only | *"my {pain} keeps happening, what do I do?"* |
| 7 | **Buying criteria** | qualifiers | *"{category} for a {size} company on a {budget} budget"* |
| 8 | **Objection / trust** | risk checking | *"is {client} legit?"*, *"downsides of {category}"* |
| 9 | **Job-to-be-done** | outcome language | *"how do I get {outcome} without hiring a team?"* |
| 10 | **Geo / vertical modifier** | local + industry intent | *"{service} agency for {vertical} in {geo}"* |

★ = the two dimensions you explicitly called out (competitors, alternatives). Dimensions
1, 7 and 9 cover "what services they provide" from three different angles.

**Cross-cut on every dimension:** persona (from `persona`), funnel stage (existing
`FunnelStage`), phrasing register (terse search-style vs conversational), and geo.

---

## 5. Data model (Prisma)

**New models**

| Model | Purpose |
|---|---|
| `AeoAudit` | Run header: projectId, surface, status, tier, matrix size, cost, verdict summary JSON |
| `SiteContext` | Scraped business context: services[], ICP[], vertical, valueProps[], pagesFetched, extraction provenance |
| `AeoStance` | Per-observation judged stance: `observationId`, `stance`, `rankAmongBrands`, `recommendedOver[]`, `losesTo[]`, `evidenceQuote`, `judgeModel` |

**Modified models (both non-breaking, nullable-only)**

| Model | Change |
|---|---|
| `QuerySetItem` | `+ dimension String?`, `+ meta String?` (JSON: service / competitor / persona refs) |
| `MeasurementRun` | `surface` comment extended to include `chatgpt` (string column — no migration needed) |

**Type change:** `Surface = 'claude' | 'perplexity' | 'chatgpt' | 'mock'` plus the `SURFACES` array.

---

## 6. API surface (proposed)

| Method | Path | Does |
|---|---|---|
| `POST` | `/aeo-audit/:projectId/context` | Scrape + build `SiteContext` |
| `GET` | `/aeo-audit/:projectId/context` | Read latest context |
| `POST` | `/aeo-audit/:projectId/matrix` | Generate prompt matrix → draft `QuerySet` |
| `GET` | `/aeo-audit/:projectId/matrix/:querySetId` | Read matrix, grouped by dimension |
| `POST` | `/aeo-audit/:projectId/run` | Execute on ChatGPT via `measurement` (n≥5) |
| `POST` | `/aeo-audit/:projectId/run/:runId/stance` | Judge pass over the run's observations |
| `GET` | `/aeo-audit/:projectId/run/:runId/verdict` | Rates + SOV + per-dimension gaps + stance roll-up |
| `POST` | `/aeo-audit/:projectId/full` | Orchestrate 1→6 in one call (the demo path) |

---

## 7. Environment variables (new)

```
# ChatGPT browser surface (D1-B). Off unless BOTH are set.
AEO_ALLOW_BROWSER_SURFACE=0
AEO_CHATGPT_SESSION_PATH=            # Playwright storageState JSON, operator-supplied
AEO_CHATGPT_URL=https://chatgpt.com/
AEO_CHATGPT_HEADLESS=1
AEO_CHATGPT_TIMEOUT_MS=120000
AEO_CHATGPT_MIN_GAP_MS=8000          # polite gap between prompts on one session

AEO_MAX_COST_PER_AUDIT=10.00
AEO_MATRIX_TIER=standard             # scorecard | standard | full
AEO_CONTEXT_MAX_PAGES=12
AEO_STANCE_JUDGE_MODEL=claude-opus-5 # reuses ANTHROPIC_API_KEY
```

---

## 8. Frontend

`/projects/[projectId]/aeo` — context card → matrix table grouped by dimension →
run button with live progress → verdict view (visibility rate, SOV bar, per-dimension
heatmap, and the "ChatGPT recommends these over you" table with evidence quotes).

---

## 9. Honest risks

1. **API ≠ consumer ChatGPT.** Every number must be labelled with the exact surface it
   came from. The report must not claim "this is what your buyers see in ChatGPT" — it is
   what the named ChatGPT surface returned, n≥5, on a given date.
2. **Answer volatility.** ChatGPT answers vary run to run — which is precisely why n≥5
   exists. Single-run findings will be blocked by the `claims` module.
3. **Judged ≠ counted.** Stance labels are LLM output. They ship as grade-B/C claims and
   must never be reported as rates.
4. **Cost.** 300 prompts × 5 runs × web-search-enabled calls is the expensive path. The
   governor stops the run; it does not silently shrink the matrix.
5. **Scraping bounds.** Client site only, `robots.txt` respected, page cap enforced.

---

## 10. Proposed build order (after approval)

1. `SiteContext` extractor (plus deepened `intake` reuse)
2. Prompt matrix generator (deterministic cells → `QuerySet`, LLM phrasing pass)
3. ChatGPT `SurfaceAdapter` in `measurement` + `Surface` union widening
4. Orchestrator service + `AeoAudit` model
5. Stance judge + `AeoStance` model
6. Verdict roll-up + REST controller
7. Frontend page
8. AGENTS.md post-completion checklist (README, SPEC, REQUIREMENTS, API.md, PRD table, `tsc`, e2e, CHANGELOG)

---

## 11. Decisions — as approved 2026-09-10

| ID | Question | My recommendation | **Decision taken** |
|---|---|---|---|
| **D1** | ChatGPT access | A (OpenAI Responses API) | **B — headless browser on `chatgpt.com`** (operator override; see §11.1) |
| **D2** | Site scrape depth | A | **A** — `fetcher` multi-page + LLM synthesis, no new deps |
| **D3** | Matrix generation | C | **C** — deterministic cells + LLM phrasing pass |
| **D4** | Stance analysis | C | **C** — deterministic rates + LLM stance, provenance-separated. Runs on **OpenRouter** (D7) |
| **D5** | Prompt storage | A | **A** — reuse `QuerySet`, nullable columns added |
| **D6** | Matrix tier + cost cap | Standard | **Standard** — 100 prompts, `AEO_MAX_COST_PER_AUDIT=10.00` |

| **D7** | Which LLM runs the analysis passes? | — (raised after build) | **OpenRouter, `qwen/qwen3-30b-a3b-instruct-2507`** — see §11.2 |

**New npm dependencies: none.** Playwright is already a dependency (`technical-audit`
uses it for the JS render diff); OpenRouter is called over raw `fetch`, the same
way `perplexity.adapter.ts` works.
**New external services: OpenRouter** (key already present in the monorepo root
`.env`). The browser adapter drives `chatgpt.com` with a session the operator supplies.

### 11.2 D7 — the analysis model, chosen by benchmark

The three analysis passes (context synthesis, matrix phrasing, stance judging)
are extraction and classification jobs, not writing jobs, so they run on a small
cheap model through OpenRouter rather than a frontier model. Anthropic remains a
fallback so a deployment with only `ANTHROPIC_API_KEY` is unchanged.

Candidates were benchmarked on the module's **real stance task** — four cases
covering the outcomes that drive the report: subject absent, subject led, subject
placed behind a competitor, subject warned about.

| model | cases | avg latency | $/Mtok in → out |
|---|---|---|---|
| **`qwen/qwen3-30b-a3b-instruct-2507`** | **4/4** | **1.5s** | 0.048 → 0.193 |
| `openai/gpt-oss-120b` | 4/4 | 7.7s | 0.037 → 0.170 |
| `google/gemini-2.5-flash-lite` | 3/4 | 1.1s | 0.100 → 0.400 |
| `openai/gpt-5-nano` | 0/4 | 16s | 0.050 → 0.400 |

The cheapest model that passes is not automatically the right one:

- `gemini-2.5-flash-lite` failed the **absent** case, reporting
  `mentioned-neutral` for an answer that never named the subject. That single
  error class turns "you are invisible" into "you were mentioned" — the headline
  the whole audit exists to produce. Disqualifying.
- `gpt-5-nano` spends its budget on reasoning tokens and truncates the JSON.
- `gpt-oss-120b` is correct but 5× slower, which on a 500-observation pass is the
  difference between 15 minutes and over an hour.

**Cost is read from OpenRouter's reported `usage.cost`**, the real charge, rather
than estimated from a local price table that would silently drift — so the audit's
cost governor is fed a true number. Measured live: a 125-observation stance pass
cost **$0.0058 with 0 failures**; context synthesis costs **$0.0006**.

Re-run the comparison before changing `AEO_LLM_MODEL`. "Absent" is the case that
must not regress.

### 11.1 D1-B — what was chosen, and the boundary it is built inside

The operator chose the headless-browser surface over the API, having seen the trade-offs
in this document. Building it as chosen. The concerns from §3 D1 still hold and are
restated in the module README so they reach whoever operates it:

- Automating `chatgpt.com` is **against OpenAI's Terms of Use**. The risk (account
  suspension, IP blocks) sits with whoever supplies the session.
- The surface is **fragile by nature** — it breaks whenever OpenAI changes the UI.
- It **cannot be run against a client's account**, only an account the operator controls
  and has accepted this risk for.

**What this adapter does _not_ contain, by design:**

- no CAPTCHA solving and no third-party solver integration,
- no stealth / fingerprint-spoofing / anti-detection layer,
- no credential handling — the operator logs in themselves, once, and the adapter reuses
  the saved Playwright `storageState`; the module never sees or stores a password.

When ChatGPT blocks, rate-limits, or challenges the session, the adapter **fails the
observation honestly** (`blocked` / `challenged` / `rate-limited`) and lets the run record
the reason. It does not attempt to defeat the block. Runs are **off by default** and
require `AEO_ALLOW_BROWSER_SURFACE=1` plus a session file to execute at all.

The `SurfaceAdapter` seam is unchanged, so the OpenAI-API adapter (D1-A) can be added
later as a second, ToS-clean surface without touching the orchestrator.
