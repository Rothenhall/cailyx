# `aeo-audit` — Answer Engine Optimization audit

Measures whether **ChatGPT, Perplexity and Gemini** name the client when a real
buyer asks the things a real buyer asks — and, when a competitor is named
alongside them, which one the engine puts in front.

The same prompt matrix is run on every engine, which is what makes the
comparison possible: *"named on Perplexity, invisible on ChatGPT"* is a finding
a single-engine audit cannot produce.

> Analysis + approved tool decisions: [`docs/analysis/aeo-audit.md`](../../../../docs/analysis/aeo-audit.md)

---

## The pipeline

```
client URL
   │
   ├─ 1. SITE CONTEXT    crawl their own site → services, ICP, pains, outcomes, competitors
   ├─ 2. PROMPT MATRIX   10 categories × services × competitors × personas × registers
   ├─ 3. MEASUREMENT     every prompt on EVERY engine, n≥5, fresh chat each time
   ├─ 4. EXTRACTION      count mentions / citations / competitor co-occurrence  ← COUNTED
   ├─ 5. STANCE          judge how the client was positioned vs each rival      ← JUDGED
   └─ 6. VERDICT         rates, share of voice, per-category gaps, who wins where
```

Stages 3 and 4 are `measurement`, reused as-is. This module orchestrates; it does
not re-implement run orchestration, the n≥5 floor, or mention extraction.

---

## Counted vs judged — the rule that governs this module

| | Counted | Judged |
|---|---|---|
| Produced by | deterministic extraction over n≥5 repeats | a small LLM reading the answer text (OpenRouter) |
| Examples | mention rate, citation rate, share of voice, co-occurrence | stance, rank among brands, `recommendedOver`, `losesTo` |
| Stored in | `Observation` (measurement) | `AeoStance` (separate table) |
| In the verdict | `verdict.counted` | `verdict.judged` |
| May be quoted as a rate | **yes** | **never** |

They live in separate tables and separate verdict blocks so no consumer can
accidentally report an LLM opinion as a measured statistic. Every judgement
carries a verbatim quote from the answer, so a human can check the call. With no
LLM provider configured the judged block reports `available: false` with the
reason — it is never fabricated, and the counted block is unaffected.

---

## Prompt categorisation

Every generated prompt is stored with its category and full provenance, so
results can be sliced and the matrix curated after seeing which cells produced
signal.

| Column | Holds |
|---|---|
| `QuerySetItem.dimension` | the category (indexed, also indexed with `querySetId`) |
| `QuerySetItem.funnelStage` | problem / solution / product / most-aware |
| `QuerySetItem.meta` | JSON `PromptMeta`: register, branded/unbranded, which service or competitor the cell targets, ICP, geo, template id, whether an LLM rewrote it |
| `AeoStance.dimension` | copied at judge time so stance rolls up per category without a join |

### The ten categories

| Category | Buyer intent | Branded? |
|---|---|---|
| `service-discovery` | "who can help me with {service}" | unbranded |
| `category-best-of` | "best {category} companies in {geo}" | unbranded |
| `competitor-alternatives` | "alternatives to {competitor}" | unbranded |
| `head-to-head` | "{client} vs {competitor}" | branded |
| `brand-direct` | "is {client} any good" | branded |
| `problem-framed` | pain language only, pre-category | unbranded |
| `buying-criteria` | "{category} for a {size} company" | unbranded |
| `objection-trust` | "is {client} legit", "downsides of…" | branded |
| `job-to-be-done` | "how do I {outcome} without…" | unbranded |
| `geo-vertical` | "{service} for {vertical} in {geo}" | unbranded |

**Branded vs unbranded is never averaged together.** Unbranded prompts are the
real visibility test; branded ones only prove the engine knows the name once you
hand it over. The verdict reports both, separately.

A category whose inputs are missing (no competitors recorded → no
`competitor-alternatives`) is **skipped with a stated reason**, recorded on the
query set and returned in `matrix.skipped`. Nothing is invented to fill a quota.

### Curating a matrix

```bash
# one category at a time
GET /api/projects/:projectId/aeo/matrix/:querySetId?dimension=competitor-alternatives
```

The matrix is a `QuerySet`, so it also inherits versioning, immutability on
activation, and the client-facing export at `/api/projects/:id/query-sets/export`.

---

## Architecture

```
aeo-audit/
├── aeo-audit.types.ts        Categories, stance enum, verdict shape (counted/judged split)
├── aeo-llm.service.ts        Shared constrained-JSON caller (OpenRouter → Anthropic fallback)
├── aeo-context.service.ts    Site crawl + deterministic extraction + optional LLM synthesis
├── aeo-matrix.generator.ts   Deterministic cell builder — the coverage contract
├── aeo-matrix.service.ts     LLM phrasing pass + persistence as a versioned QuerySet
├── aeo-stance.service.ts     The judge (opinion only, evidence-quoted)
├── aeo-audit.service.ts      Orchestrator + verdict computation
├── aeo-audit.controller.ts   REST API
├── aeo-audit.module.ts       Wiring
└── dto/aeo-audit.dto.ts      Validated request bodies
```

The engine adapters live with the other surfaces, in
[`../measurement/adapters/browser-surface.adapter.ts`](../measurement/adapters/browser-surface.adapter.ts)
(the three `*-browser` surfaces) and
[`../measurement/adapters/cloro.adapter.ts`](../measurement/adapters/cloro.adapter.ts)
(the five `cloro-*` surfaces) — `measurement` owns the `SurfaceAdapter`
registry, and its own type comment anticipated both additions. One base class
drives each family; only the per-site selectors (browser) or per-engine
payload/response shape (Cloro) differ.

---

## API

| Method | Path (under `/api/projects/:projectId/aeo`) | Does |
|---|---|---|
| `POST` | `/context` | Crawl the site, build `SiteContext` |
| `GET` | `/context` | Latest stored context |
| `POST` | `/matrix` | Generate the categorised prompt matrix |
| `GET` | `/matrix/:querySetId` | Read a matrix (`?dimension=` to filter) |
| `POST` | `/audits` | Create an audit row (no spend) |
| `POST` | `/audits/full` | Run every stage to a verdict |
| `POST` | `/audits/:auditId/resume` | Continue a stopped/failed audit |
| `POST` | `/audits/:auditId/stance` | Judge (or finish judging) the run |
| `GET` | `/audits` | List audits |
| `GET` | `/audits/:auditId` | One audit + stored verdict |
| `GET` | `/audits/:auditId/verdict` | Recompute the verdict |

Full request/response shapes: [`docs/API.md`](../../../../docs/API.md#aeo-audit).

---

## The engines

| Surface | Product driven | Gate |
|---|---|---|
| `cloro-chatgpt` | ChatGPT, via Cloro's API | `CLORO_API_KEY` |
| `cloro-perplexity` | Perplexity, via Cloro's API | `CLORO_API_KEY` |
| `cloro-gemini` | Gemini, via Cloro's API | `CLORO_API_KEY` |
| `cloro-ai-overview` | Google's AI Overview box, via Cloro's API | `CLORO_API_KEY` |
| `cloro-ai-mode` | Google AI Mode, via Cloro's API | `CLORO_API_KEY` |
| `chatgpt-browser` | `chatgpt.com`, driven directly | `AEO_ALLOW_BROWSER_SURFACE=1` + `AEO_CHATGPT_SESSION_PATH` |
| `perplexity-browser` | `perplexity.ai`, driven directly | `AEO_ALLOW_BROWSER_SURFACE=1` + `AEO_PERPLEXITY_SESSION_PATH` |
| `gemini-browser` | `gemini.google.com`, driven directly | `AEO_ALLOW_BROWSER_SURFACE=1` + `AEO_GEMINI_SESSION_PATH` |
| `mock` | test-only, deterministic | — |

**A failed engine never voids the audit.** Each is measured independently; one
that is blocked, signed out, or hit by a UI change records a typed reason
(`blocked`, `session-expired`, `selector-drift`, `cloro-disabled`,
`cloro-budget-exceeded`, …) and contributes nothing, while the others still
report. The verdict's headline names the engines that were not measured, so a
number is never quietly missing an engine.

Search runs in the browser, or via Cloro; **analysis does not** — context
synthesis, prompt phrasing and stance judging go through OpenRouter (see
below).

### Cloro (wave-6 D1) — the default way to measure

[Cloro](https://cloro.dev) queries the *consumer* products on our behalf via
API — same motivation as the browser surfaces ("an API answer is not what a
buyer sees") without the ToS exposure of automating a signed-in session
ourselves. It is the **primary** measurement path; the browser surfaces above
are the fallback.

- **Async, never sync.** `cloro.adapter.ts` submits via `POST /v1/async/task`
  and polls `GET /v1/async/task/{id}` — the sync `/v1/monitor/*` endpoints
  carry a surcharge for nothing this module needs.
- **Cost is the real charge, not an estimate.** `costUsd = creditsCharged ×
  CLORO_CREDIT_USD`, read back from the completed task. A failed task charges
  `0` credits.
- **Pre-flight budget guard.** Before running a `cloro-*` surface,
  `cloroFitsBudget()` estimates `prompts × runCount × perTaskCredits` against
  `GET /v1/credits` and refuses to start a surface that cannot finish inside
  the remaining allowance — burning most of a free month's credits and
  stopping half way is worse than not starting. The surface run records why
  (`cloro-budget-exceeded`) rather than silently truncating mid-run.
- **`cloro-ai-overview` is a `GOOGLE` task, not its own `taskType`.** The box
  appears at `response.aioverview` only when `include.aioverview` is set — a
  different flag (`include.paaAioverview`) answers expanded "People Also Ask"
  questions instead, which is not the same feature.
- **Fallback chain.** `cloro-chatgpt` / `cloro-perplexity` / `cloro-gemini`
  each fall back once to their `*-browser` equivalent when that Cloro surface
  fails **and** the browser surface is itself enabled
  (`AEO_ALLOW_BROWSER_SURFACE=1` + a valid session) — never a second silent
  attempt with nothing to show. `AeoSurfaceRun.attemptedVia` records which
  surface actually answered, so a fallback run is never reported as a Cloro
  measurement. `cloro-ai-overview` and `cloro-ai-mode` have no browser
  equivalent and fail closed.
- **Typed failures**, distinguished so the report can say *why* an engine
  produced nothing: `cloro-disabled` (no key), `cloro-budget-exceeded` (won't
  fit the remaining allowance), `cloro-task-failed`, `cloro-timeout`,
  `cloro-api-error`.

See [`../measurement/adapters/cloro.adapter.ts`](../measurement/adapters/cloro.adapter.ts)
for the client and per-engine adapters.

---

## Markets (wave-6 D8) — derived from the client, not configured globally

Markets are **not** a fixed list and **not** a single country guessed from the
ccTLD. They come from what the client's own site says it serves, in this
precedence order:

1. **Explicit override** — `RunAuditDto.markets` (ISO-3166 alpha-2 codes) on
   the `POST /audits` request. Given, this fans out `surface × market`
   immediately — one `AeoSurfaceRun` per combination.
2. **Extracted service areas** — `SiteContext.markets[]`, ranked, from what the
   site names as served.
3. **Client HQ / registered geo** — `SiteContext.geo`.
4. **`'US'`** — last resort.

A run with no override defaults to **one market** (the highest-ranked) —
never all of them — because markets multiply cost: `prompts × runCount ×
engines × markets`. A naive "use every extracted market" would silently
multiply a bill the operator never asked to pay.

**Provenance is never mixed.** Browser surfaces report geo as **not steered**
(§FR-6.3 below); Cloro surfaces report it as real, via the `country` parameter
on every request. `verdict.counted.byMarket` and per-`AeoSurfaceRun.market`
carry this apart from the aggregate `overall` numbers, so a market column
never quietly averages a real number with a fictional one.

---

## ⚠️ The browser surfaces — read before enabling

Decision **D1-B**: the operator chose to drive the vendors' consumer products
rather than their APIs, after reviewing the trade-offs. An API answer is not what
a buyer sees, and this audit is about what buyers see. The concerns stand and are
restated here because they reach whoever runs it:

- **Automating these products is against their Terms of Use** — OpenAI,
  Perplexity and Google alike. The risk (account suspension, IP blocks) sits with
  whoever supplies the session.
- **They are fragile by nature** — each breaks whenever its vendor changes the
  UI. When a composer selector stops matching, the adapter reports
  `selector-drift` and names the constant to update, rather than failing
  mysteriously.
- **Never point them at a client's account** — only ones the operator controls
  and has accepted this risk for.

### What the adapter deliberately does not do

- No CAPTCHA solving, and no solver-service integration.
- No stealth plugin, fingerprint spoofing, or other anti-detection layer.
- No credential handling — the operator signs in by hand once and exports a
  Playwright `storageState`; this module never sees a password.

When ChatGPT challenges, blocks, or rate-limits the session, the adapter fails
the observation with a typed reason (`challenged`, `rate-limited`, `blocked`,
`session-expired`) and the run records it. **It does not attempt to get past any
of them.** A run where every call failed marks the audit `failed` with the reason
rather than producing a verdict built on nothing.

### Enabling them

One master switch, then one session file per engine you want measured:

```bash
AEO_ALLOW_BROWSER_SURFACE=1
AEO_CHATGPT_SESSION_PATH=/abs/path/chatgpt-session.json
AEO_PERPLEXITY_SESSION_PATH=/abs/path/perplexity-session.json
AEO_GEMINI_SESSION_PATH=/abs/path/gemini-session.json
AEO_SURFACES=chatgpt-browser,perplexity-browser,gemini-browser
```

Create each session file once, by hand (repeat per engine URL):

```js
// node scripts/save-chatgpt-session.js — run locally, sign in in the window
const { chromium } = require('playwright');
const ctx = await (await chromium.launch({ headless: false })).newContext();
await (await ctx.newPage()).goto('https://chatgpt.com/');
// …sign in manually, then:
await ctx.storageState({ path: '/abs/path/chatgpt-session.json' });
```

Both variables are required; without them every call fails closed with
`surface-disabled` / `no-session`.

**The API-based surface remains the ToS-clean option.** The `SurfaceAdapter` seam
is untouched, so it can be added later as a second surface without changing the
orchestrator.

---

## Dependencies

| Kind | What | Why |
|---|---|---|
| Module | `measurement` | Run orchestration, n≥5 floor, surface adapters, mention extraction |
| Module | `fetcher` | Site crawl — UA rotation, rate limits, Playwright render |
| Module | `database` | `SiteContext`, `AeoAudit`, `AeoSurfaceRun`, `AeoStance`, reused `QuerySet` tables |
| npm | `playwright` | Already a dependency (`technical-audit` JS render diff) |
| npm | `@anthropic-ai/sdk`, `cheerio` | Already dependencies |
| External | Cloro (cloro.dev) | `CLORO_API_KEY` — the primary measurement path (wave-6 D1) |
| External | ChatGPT/Perplexity/Gemini session | Operator-supplied, browser fallback only |

**No new npm packages were added.** Cloro (wave-6 D1) is the one new paid
service this module talks to; it is metered and gated behind `CLORO_API_KEY`,
with a pre-flight budget guard so a run cannot overspend the free allowance.

---

## Environment variables

### The analysis LLM

All three analysis passes — context synthesis, matrix phrasing, stance judging —
go through `AeoLlmService`, which prefers **OpenRouter** and falls back to
Anthropic. These are extraction and classification jobs, not writing jobs, so a
small cheap model is the right tool.

The default was chosen by **benchmarking candidates on this module's real
stance task** (four cases: absent / led / placed-behind / warned-about):

| model | cases | avg latency | $/Mtok in → out |
|---|---|---|---|
| **`qwen/qwen3-30b-a3b-instruct-2507`** | **4/4** | **1.5s** | 0.048 → 0.193 |
| `openai/gpt-oss-120b` | 4/4 | 7.7s | 0.037 → 0.170 |
| `google/gemini-2.5-flash-lite` | 3/4 | 1.1s | 0.100 → 0.400 |
| `openai/gpt-5-nano` | 0/4 | 16s | 0.050 → 0.400 |

`gemini-2.5-flash-lite` failed the **absent** case — it reported
`mentioned-neutral` for an answer that never named the subject. That is the one
error this module cannot absorb: it turns "you are invisible" into "you were
mentioned". `gpt-5-nano` spends its budget on reasoning tokens and truncates the
JSON. **Re-run that comparison before changing `AEO_LLM_MODEL`.**

Cost is taken from OpenRouter's reported `usage.cost` per call — the real charge,
not an estimate from a local price table that would drift. Measured on a live
125-observation stance pass: **$0.0058 total, 0 failures, ~1.8s per judgement**.
Extrapolated to the `standard` tier (500 observations): **~$0.02 and ~15 minutes**.

| Name | Default | Description |
|---|---|---|
| `AEO_LLM_MODEL` | `qwen/qwen3-30b-a3b-instruct-2507` | OpenRouter model for all three analysis passes. |
| `AEO_LLM_TIMEOUT_MS` | `60000` | Per-call ceiling; without it one hung request stalls a whole pass. |
| `AEO_LLM_REFERER` | `https://cailyx.local` | OpenRouter attribution header. |
| `AEO_STANCE_JUDGE_MODEL` | `claude-opus-5` | Used **only** on the Anthropic fallback path. |
| `AEO_ALLOW_BROWSER_SURFACE` | `0` | Master switch for the chatgpt.com surface. Fails closed. |
| `AEO_CHATGPT_SESSION_PATH` | — | Playwright `storageState` JSON, operator-supplied. Required. |
| `AEO_CHATGPT_URL` | `https://chatgpt.com/` | Entry point. |
| `AEO_CHATGPT_HEADLESS` | `1` | `0` shows the browser — useful when a selector breaks. |
| `AEO_CHATGPT_TIMEOUT_MS` | `120000` | Per-prompt ceiling. |
| `AEO_CHATGPT_MIN_GAP_MS` | `8000` | Deliberate gap between prompts. Politeness, not evasion. |
| `AEO_CHATGPT_LABEL` | `chatgpt-web` | Recorded as the observation's `model`. |
| `AEO_MATRIX_TIER` | `standard` | `scorecard`=25, `standard`=100, `full`=300 prompts. |
| `AEO_MAX_COST_PER_AUDIT` | `10.00` | USD ceiling. Stops the run and records why. |
| `AEO_CONTEXT_MAX_PAGES` | `12` | Page ceiling for the site crawl. |
| `CLORO_API_KEY` | — | Enables the five `cloro-*` surfaces. Absent → `cloro-disabled`, fails closed. |
| `CLORO_CREDIT_USD` | `0.0004` | Price per credit, for the reported `costUsd` only — the real free-tier spend is `$0`. Update if on a different Cloro plan. |

Every LLM path degrades honestly when **no** provider is configured: context
falls back to deterministic extraction, the matrix keeps template phrasing, and
the stance pass returns `503` rather than inventing verdicts. Counted metrics
never depended on a model, so they are unaffected either way.

---

## Cost

Calls = `prompts × runCount`. n≥5 is enforced repo-wide, so:

Calls = `prompts × runCount × engines`.

| Tier | Prompts | Categories | 1 engine | 3 engines |
|---|---|---|---|---|
| `trial` | 5 | 5 of 10 | 25 | **75** |
| `trial-wide` | 10 | 10 of 10 | 50 | 150 |
| `scorecard` | 25 | 10 | 125 | 375 |
| `standard` | 100 | 10 | 500 | 1,500 |
| `full` | 300 | 10 | 1,500 | 4,500 |

With an ~8s politeness gap between prompts, three engines at the standard tier
is several hours of wall clock. Budget the **time**, not just the money.

**The `trial` tiers are probes, not verdicts.** They exist for metered measurement
surfaces on a free allowance, where credits bind before analysis does. Because 5 is
smaller than the ten categories, `trial` funds only the five heaviest-weighted ones
— `service-discovery`, `competitor-alternatives`, `category-best-of`, `head-to-head`,
`problem-framed` — and names every unfunded angle in `skipped[]`. `trial-wide`
trades that engine coverage for one prompt on all ten. Treat a `trial` mention rate
as a signal to investigate, never as a measured rate: 5 prompts × 5 runs is a
small enough sample that a single phrasing quirk moves it.

The browser surface reports `costUsd: 0` per observation — it is paid for by the
operator's ChatGPT subscription, not per call. Reporting a made-up per-prompt
price would corrupt the cost governor, so it reports the truth. The LLM passes
(context, phrasing, stance) do carry real per-token cost and are capped by
`AEO_MAX_COST_PER_AUDIT`.

---

## PRD alignment

| PRD requirement | Status | Notes |
|---|---|---|
| FR-5.1 (100–300 prompts) | ✅ | `standard`=100, `full`=300; `scorecard`=25, and `trial`/`trial-wide` (5/10) for metered surfaces on a free allowance — flagged as probes |
| FR-5.2 (tagging) | ✅ | Category + funnel stage + full `PromptMeta` per prompt |
| FR-5.3 (versioning) | ✅ | Inherited from `QuerySet` — immutable on activation, version per matrix |
| FR-5.4 (export) | ✅ | Inherited from `QuerySet` export |
| FR-6.1 (n≥5) | ✅ | Enforced by `measurement`; DTO rejects `runCount < 5` |
| FR-6.2 (fresh sessions) | ✅ | A new chat per prompt, so repeats stay independent |
| FR-6.3 (multi-geo) | ✅ / ⚠️ | **Real** on `cloro-*` surfaces via the `country` parameter (wave-6 D1/D8) — `SiteContext.markets[]`, `AeoAudit.markets`, `AeoSurfaceRun.market`, `verdict.counted.byMarket`. Still **not steered** on the `*-browser` surfaces (no proxy egress); the two are never mixed in one number |
| FR-6.4 (Observation schema) | ✅ | Reuses `measurement`'s |
| FR-6.5 (surface adapters) | ✅ | `chatgpt-browser`/`perplexity-browser`/`gemini-browser` plus five `cloro-*` surfaces, all behind the existing `SurfaceAdapter` interface |
| FR-7.1–7.3 (share of voice) | ✅ | From `measurement.summary`, plus per-competitor standings |
| FR-9.4 (claims discipline) | ✅ | Counted/judged split; judged output is never expressed as a rate |

---

## Testing

`backend/smoke/aeo-audit.smoke.sh` — full pipeline, **zero API keys, zero spend**:
context (deterministic) → matrix (template phrasing) → measurement on the mock
surface at n=5 → verdict, plus the honest-gate assertions.

Verified 2026-09-11 against a running backend (`MEASUREMENT_ALLOW_MOCK=1`):

- **38 passed, 0 failed, 1 skipped**
- 125 observations recorded across a 25-prompt matrix at n=5
- Matrix is byte-identical across regenerations (deterministic seed)
- `?dimension=` filter returns exactly one category
- Every prompt carries `dimension`, `branding` and `template` in storage
- With `refine:false` / `skipStance`: `extraction=deterministic`, `refined=false`,
  `judged.available=false` with a stated reason
- `runCount=3` → `400`; resuming a completed audit → `409`
- `chatgpt-browser` while disabled → audit marked `failed`, no empty verdict

`npx tsc --noEmit` and `npx nest build` both clean.

### What the smoke run deliberately does not do

The smoke harness is **zero-spend by contract**, so it never invokes an LLM
provider. Assertions that depend on whether one is configured branch on what the
server reports, and the keyed branch is **skipped, not exercised** — judging 125
observations costs real money. That is the one `SKIP` above.

The LLM paths were instead verified by a **separate live run** (2026-09-11,
OpenRouter / `qwen/qwen3-30b-a3b-instruct-2507`):

| pass | result | cost |
|---|---|---|
| context synthesis | `extraction=llm-synthesized`, 6 services / 6 ICP / 7 pains / 6 outcomes | $0.0006 |
| matrix phrasing | 89 prompts, `refined=true`, 9 categories | included above |
| stance judging | **125 judged, 0 failed**, ~1.8s each | $0.0058 |

That live run is also what caught the merge bug, the wrong-model attribution, the
register bleed and the placeholder grammar — none of which the mock-surface smoke
could have surfaced, because none of them involve the surface.

**Not yet exercised against a live ChatGPT session** — the browser surface's
selectors are written against the current UI but have not been run end-to-end
here. First live run should use `AEO_CHATGPT_HEADLESS=0` and a `scorecard`-tier
matrix to confirm the selectors before spending a full run.

---

## Known limitation: deterministic service extraction is noisy

Also run against a real site (rothenhall.com, 5 pages). That found and fixed three
real bugs — marketing sentences captured as service names, a SPA catch-all
inflating `pagesFetched` (8 phantom pages → 5 real, now content-fingerprinted),
and a `"this kind of service"` placeholder leaking into prompts. It also exposed
the honest ceiling of the deterministic layer.

Without `ANTHROPIC_API_KEY`, extraction is heading-based, so a site's **values,
principles and team names can land in `services[]`** alongside real offerings:

```
AI Visibility           ← real
Revenue Operations      ← real
Fixed-fee Sprints       ← real
One accountable owner   ← a value, not a service
Kunal Achintya Reddy    ← a person
```

Anything in `services[]` gets interpolated into prompts, so junk in means prompts
like *"companies that do Kunal Achintya Reddy"* out.

**The LLM synthesis pass (D2 layer 2) resolves this** — it reads the same fetched
page text and returns only offerings a buyer can actually pay for. Verified on the
same site: `services[]` went from 19 heading-derived candidates (including a
founder's name) to **6 real offerings**, and `painPoints` / `outcomes` went from
empty to populated — which unblocked the `problem-framed` and `job-to-be-done`
categories that had been skipped entirely. Cost: **$0.0006**.

A successful synthesis **replaces** the deterministic list rather than merging
with it. Merging was the original behaviour and it was wrong: the model is asked
to drop values and people's names, and the union put them straight back.

Leave `refine` at its default for any client-facing run.

Deliberately **not** solved with more heuristics: distinguishing "Proof over
claims" from a real service name without reading meaning is guesswork, and a
wrong guess silently corrupts the matrix. The filters here stop at what can be
decided structurally (sentence shape, single-word tier/step labels, team and
testimonial blocks). Review `services[]` before activating a matrix on a
deterministic-only run — `GET /aeo/context` returns it.
