# Cailyx — Module Status & Required-Modules Plan

> **Status:** Living document, updated per module completion
> **Date:** 2026-08-29 — last extended 2026-09-17 (platform improvement phases, §1.2g)
> **Sources:** `docs/PRD.md` (AI Visibility Diagnostic, working name Beacon), `docs/PLAN.md`, `docs/cailyx-audit-modules-spec.md`, module READMEs in `backend/src/modules/`
> **Rule reminder:** One module at a time. Analysis doc (`docs/analysis/<module>.md`) with 2-3 tool options per dependency, user approval, then code. See `AGENTS.md`.
> **Going live:** see [`docs/PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) for every secret / API key / infra / hardening step. Build history: [`CHANGELOG.md`](../CHANGELOG.md).

---

## 1. What exists today (current state)

### 1.1 Built — infrastructure (shared, pre-feature)

| Module | What it does | Status |
|---|---|---|
| `health` | Liveness/status endpoint | ✅ Built |
| `database` | Prisma (SQLite `prisma/dev.db` as of 2026-08-30 — was PostgreSQL 17), 16 models, `PrismaService` | ✅ Built |
| `fetcher` | HTTP client: UA rotation, per-domain + global rate limits, retries, `verifyUrl`, PSI adapter | ✅ Built |
| `scheduling` | BullMQ + Redis (`6380`) job queue, per-project cadence configs | ✅ Built |

### 1.2 Built — feature modules (Phase 2 audits)

| Module | Maps to | Built | Deferred inside the module |
|---|---|---|---|
| `technical-audit` | PRD §6.2 (access probe), §6.3 (on-page), SOP-3 | 5 checks: robots.txt AI-bot blocks, CDN UA-probe (inferred), JS render diff (Playwright), CWV via PSI, schema audit. Bot categorization (search/training/live-fetch), layer tracking, 3x determinism probes, reproduction commands, scheduling, DB persistence | Hallucinated 404 sweep (needs `crawler-monitor`) |
| `entity-audit` | PRD §6.4 (entity), SOP-4 | Entity CRUD, schema checker (`@graph`, `sameAs` resolve + identity match), platform records (manual + semi-auto single fetch), consistency checker, audit summary. **Wave 3:** model-diff execution (Claude + Perplexity via measurement SurfaceAdapters; honest `503` without keys) + Claude judge divergence (`Aligned:`/`Divergent:`, skipped <2 answers, `judge-unavailable`/`judge-failed` on errors) | Platform auto-scraping (ToS, excluded); live model-diff verdicts gated on API keys (guard e2e-verified) |
| `gap-analysis` | PRD §6.9 partial, SOP-5 | Rules engine (`CLASSIFICATION_RULES`, 9 rules), auto dimension/action classification, `sync` upsert, overrides, manual 1-5 priority inputs, computed `priorityScore`, roadmap | `topic`/`format`/`web-mentions`/`demand` dimensions stay empty until source modules exist |

### 1.2c Built — Wave 2 feature modules (added 2026-08-30)

| Module | Maps to | Built | Deferred inside the module |
|---|---|---|---|
| `measurement` | PRD §6.6–6.7, SOP-2 (the moat) | Surface adapters (Claude via @anthropic-ai/sdk `claude-opus-5`, Perplexity raw `sonar`, `mock` behind `MEASUREMENT_ALLOW_MOCK`), runs vs active query sets (n≥5 enforced), observation extraction (longest brand-token match), rates/SOV, cost caps, re-execute guards (completed→409 / failed→wipe) | Multi-geo egress proxy routing (FR-6.3 open decision) |
| `scoring` | PRD §8 + FR-8.x | Versioned rubrics (weights sum 100, auto-seed v1), 5-dimension scoring with **honest partials** (missing inputs → dimension contributes 0, run flagged `partial`, never renormalized), bands 0–40/41–60/61–80/81–100 | Live extractability/authority inputs until `page-analysis` exists |
| `claims` | FR-9.4 | Deterministic banned-phrase blocker + single-run-rate detection, A/B/C grading (A own n≥5, B ≥2 sources, C single), hard approve gate, source attach with auto regrade (C→B verified) | — |
| `findings` | FR-9.1–9.3 | Constrained two-register LLM copy (what/why/fix × executive/technical) from ranked open gaps, banned-hit regen-then-skip, `thinRun` honest flag, `MIN_FINDINGS=3` | Live run needs `ANTHROPIC_API_KEY` (503 honest guard verified) |

### 1.2d Built — Wave 3 feature modules (added 2026-08-30)

| Module | Maps to | Built | Deferred inside the module |
|---|---|---|---|
| `crawler-monitor` | SOP-3, §4.5 | Log ingestion (`hits[]` JSON + CLF `logText`, skip-counted, 400 when nothing parses), static 14-bot registry (longest-substring classification: training/search/citation-engine/unknown), roll-up summary (`byType`/`byVendor`/`topUrls≤20`/`lastSeen`), hit listing with `botType` filter | Hallucinated-404 sweep itself (needs AI-referral URL data — the ledger this module feeds) |
| `monitoring` | PRD §6.12, FR-12.1–12.4 | Snapshot (score + rates + crawler hits, honest 404 when empty), two-latest delta, threshold alerts (score −10/mention −15, escalate −20/−30) persisted as Alert rows, `monitoring` scheduled handler (re-check + `scheduled-run-failed` alert), cadence endpoints | `PUT/DELETE /schedule` need Redis 6380 running (docker-compose, same as technical-audit); `ScheduleConfig` row is per-project shared with technical-audit cadence |

### 1.2e Built — Swarm layer (synthetic-buyer research agents, added 2026-08-30)

> Analysis + boundary: `docs/analysis/swarm-layer.md`. **No new npm deps.** New external service: DataForSEO (live SERP only, gated + fixture-backed). All 6 modules e2e-verified via `backend/smoke/*.smoke.sh` (**148/148 assertions, zero keys / zero spend**), `tsc` clean, `nest build` green.

| Module | Agent | Built | Gated / deferred |
|---|---|---|---|
| `persona` | #1 Search Persona Generator | Deterministic role-catalogue generator (10 roles, seeded PRNG, reproducible), optional constrained LLM refinement, draft→active→archived lifecycle, `PERSONA_MAX_PER_PROJECT` fan-out cap + per-generate LLM cost budget | LLM refine needs `ANTHROPIC_API_KEY` (503) |
| `journey` | #2 Journey Agent | Branching multi-step journey planner (awareness ladder, kinds: query/refinement/branch/comparison/objection) seeded per persona; executor over the `measurement` SurfaceAdapters; `JourneyCampaign` fan-out; per-journey `maxCostUsd` cap + per-campaign `budgetUsd` governor | live surface needs `SWARM_ALLOW_LIVE=1` + key (503); LLM planner needs key |
| `serp-intelligence` | #3 SERP Intelligence | SerpTracker/Query/Snapshot/Result; DataForSEO `live/advanced` provider (via FetcherService) + offline `fixture` provider; per-query subject rank, AI-Overview presence/mention, featured snippet, topDomains, competitorsSeen, sourceCount; `SERP_MAX_COST_PER_CAPTURE` governor | live provider needs `SWARM_ALLOW_LIVE=1` + `DATAFORSEO_LOGIN/PASSWORD` (503); fixture needs `SERP_ALLOW_FIXTURE=1` (400) |
| `authority` | #6 Authority Agent | Discovery via SERP listicles + AI-answer citations (journeys + measurement) + optional LLM; classify (listicle/community/podcast/publication/directory/newsletter) + relevance; excludes client + competitors + junk hosts; **promote → `mention-tracking` MentionTarget** | LLM/`method=llm` needs key (503); live SERP inherits #3's gate; no automated outreach by design |
| `internal-link` | #8 Internal-Link Agent | BFS crawl of the **client's own** site via FetcherService + sitemap/inventory seed; TF topic keywords; node/edge graph; orphan + under-linked detection; ranked "add link A→B" recs (Jaccard + inbound deficit); optional LLM anchor-copy refinement | LLM refine needs key (503); `fixture://` root needs `INTERNAL_LINK_ALLOW_FIXTURE=1` (400) |
| `council` | #10 Council Agent | 6 role-agents (technical/content/authority/measurement/narrative/skeptic) × rounds debate over candidate interventions derived from existing artefacts (gap-analysis, link graph, journeys, measurement, technical/entity audits); synthesizer ranks by consensus × expected impact, records dissent; **proposes no new measurement** | LLM debate needs key (503); empty project → 0 rankings (honest) |

Shared infra added: `common/utils/prng.ts`, `common/utils/subject-match.ts` (subject/competitor scoring, parity with the `measurement` moat), `backend/smoke/` harness.
Leak fix: `scheduling.service.ts` now implements `OnModuleDestroy` (closed the BullMQ Worker + both ioredis connections it leaked on every `--watch` reload).

### 1.2f Built — AEO audit (answer-engine visibility, added 2026-09-10)

> Analysis + approved decisions: `docs/analysis/aeo-audit.md`. **No new npm deps, no new paid services.**
> Verified via `backend/smoke/aeo-audit.smoke.sh` (**39/39 assertions, zero keys / zero spend**), `tsc` clean, `nest build` green.

| Module | Maps to | Built | Gated / deferred |
|---|---|---|---|
| `aeo-audit` | PRD FR-5.x (query sets), FR-6.x (measurement), FR-7.x (share of voice), SOP-1/2 — the ChatGPT-first half of the moat | **Site context**: crawl of the client's own site (homepage + sitemap-guided service/pricing/about pages, content-fingerprint dedupe so a SPA catch-all cannot inflate the page count), deterministic services/valueProps extraction + optional constrained-LLM synthesis of services/ICP/pains/outcomes. **Prompt matrix**: 10 buyer categories (service-discovery, category-best-of, competitor-alternatives, head-to-head, brand-direct, problem-framed, buying-criteria, objection-trust, job-to-be-done, geo-vertical) × services × competitors × personas × register (terse/conversational) × branded/unbranded; deterministic cells define coverage, optional LLM rewrites phrasing only (a rewrite that drops the cell's named entity is rejected); persisted as a versioned `QuerySet` (`source="aeo-matrix"`) so it inherits immutability-on-activation + export. **Categorisation persisted per prompt** (`QuerySetItem.dimension` indexed + `meta` JSON) and copied onto `AeoStance` — the curation surface. **Execution**: reuses `measurement` (n≥5, cost governor, deterministic mention/citation extraction) via a new `chatgpt-browser` `SurfaceAdapter`. **Stance**: LLM judge per answer → `recommended-primary`/`recommended-alternative`/`mentioned-neutral`/`mentioned-negative`/`absent` + `recommendedOver[]`/`losesTo[]`/`rankAmongBrands` + verbatim evidence quote. **Verdict**: `counted` (rates, SOV, per-category, branded vs unbranded split, competitor standings) and `judged` (stance) in **separate blocks and separate tables** — an LLM opinion can never be reported as a measured rate | `chatgpt-browser` surface is **off by default** (`AEO_ALLOW_BROWSER_SURFACE=1` + operator-supplied Playwright session) and **not yet run against a live ChatGPT session** — selectors written against the current UI, unverified e2e. Automating chatgpt.com is against OpenAI's ToS (decision D1-B, operator's call; adapter contains no CAPTCHA solving, no stealth layer, no credential handling, and fails honestly on a block). LLM passes need `ANTHROPIC_API_KEY` (context falls back to deterministic, matrix keeps template phrasing, stance → 503). Multi-geo recorded but **not steered** (no proxy egress). Frontend page not built |

Schema added: `SiteContext`, `AeoAudit`, `AeoStance`. Modified nullable-only (no data migration): `QuerySetItem.dimension`, `QuerySetItem.meta` + two indexes. `Surface` union widened with `chatgpt-browser`.

### 1.2g Built — platform improvement phases (added 2026-09-17)

> Source: `platform_improvement_plan.md` (the 36 changes from the two product
> discussions; introduced in `CHANGELOG.md` 2026-09-16). Section references
> below (§3.5, §6.x, §9.x, §10, §11, §12.x, §13.x) are that plan's, not the
> PRD's. Phase numbers are the plan's P01–P16.
>
> **Documentation state at the time of writing.** Module READMEs are written
> for the five phases in the table below. P08/P09 (`content-workspace`,
> `writing-style`) and P12 (`website`) were **still landing**: the modules
> exist under `backend/src/modules/` and their controllers are mounted, but
> their READMEs and `docs/API.md` sections are deliberately deferred rather
> than written against a moving target. P10 (`content-calendar`), P13
> (unified AI visibility), P14 (scoring methodology) and the remaining phases
> were likewise still in flight — no state is asserted for them here.

| Module | Maps to | Built | Deferred / gated |
|---|---|---|---|
| `delivery-plan` (P01, P11) | §3.5 client-safe projections, §5.6 needs-your-action, §6.1–6.3 commitments | Commitments whose `agreed` state only an explicit confirmation can reach, progress derived from verified work items (never stored), outcome commitments that cannot complete on closed tasks alone, cycle denominators frozen at commit with append-only scope changes, per-audience allowlist projections, and a needs-your-action queue derived live from other modules' records with no table of its own | — |
| `business-profile` (P02, P04) | §9.1–9.2 business information, §10 target locations | `GET …/overview` keeps `confirmed` / `suggestions` / `gaps` as three separate lists; rejections are keyed by value (`projectId + fieldPath + valueHash`) and read from stored `SiteContext`, never the request body; structured target locations with per-provider support tracing; **the silent ccTLD → default-`US` market fallback is removed** (§10.2) — the market now resolves explicitly or 409s naming the screen that fixes it | — |
| `digital-presence` (P05) | §11 applicability, rejection memory, client projection | Per-platform `relevant / optional / not-relevant` applicability with versioned operator overrides that survive rediscovery (gaps, coverage and the Google sweep all respect it); "not ours" rejection tombstones with a required reason; plain-English portal projection | — |
| `competitors` (P06) | §12.1–12.4 market discovery, frozen comparisons | `POST …/discover/market` — free by default (mines the newest completed AEO verdict + up to 300 stored SERP rows, `queriesRun: 0, costUsd: 0`), ≤6 live queries only on an explicit `collectNew: true`; candidates remain proposals until confirmed; `CompetitorComparisonSnapshot` immutable with its provenance | — |
| `opportunities` (P07, new) | §12.5–12.7 | One `Opportunity` row per idea under a dedup identity that survives re-analysis, a **read-only** keyword-gap engine bounded to the already-captured corpus (`unknown` ≠ `not-observed`, null volume ≠ 0), dismiss-with-reason that no re-run can reopen, and an idempotent convert-to-content contract | `ai-question-gap` / `refresh` / `client-request` origins and the §12.7 "update an existing page" branch are modelled but unreachable / not built (named in the module README) |
| `content-workspace` (P08/P09, new) | §13.1–13.5, §13.8–13.11 | **In flight.** Composes `GrowthAsset`, `ContentBrief`/`ContentRevision`, `ApprovalRequest`/`CheckResult` and `Publication` into one canonical content list with separated state axes; `writing-style` adds a versioned draft→confirm style record owned by content (never a mutation of `PresenceBrandVoice`) | README + `docs/API.md` section |
| `website` (P12, new) | §7.6 unified website read model | **In flight.** Read model over technical checks, Search Console / Analytics snapshots and page-analysis, joined through a shared page identity; read paths serve from storage and never call Google or re-crawl | README + `docs/API.md` section |

Verification for the five documented phases: `backend/smoke/keyword-gaps.smoke.sh`,
`portal-plan.smoke.sh`, `thirty-day-plan.smoke.sh`,
`online-presence-unified.smoke.sh`, `competitors-unified.smoke.sh`,
`target-markets.smoke.sh`. **None was re-run during the documentation pass** —
they are cited as the exit gates that exist, not as a pass claimed here.

### 1.2h Built — client/admin platform layer (never previously tracked in this file)

> These modules were built directly from verbal asks ("we should be able to create clients and
> see their status/progress") rather than through the Wave process above, and were never added
> to this file. `docs/analysis/client-portal.md` (rewritten 2026-09-20) is now the accurate
> spec: it documents what each module below actually does, what decisions were made
> 2026-09-20 about client/admin scope going forward, and the one real gap (§10 of that doc: a
> richer engagement/timeline model, not yet built). Each module's own README also states,
> explicitly, that it bypassed the original `client-portal.md` v0.1 draft's larger plan
> (multi-seat `Account`, `Engagement`/`Phase`/`Milestone`/`Approval`).

| Module | What it does | Status |
|---|---|---|
| `clients` | Admin CRUD for clients + projects, the Day-1 onboarding pipeline orchestrator, client-login creation (temp-password variant), operator-side message thread | ✅ Built 2026-09-13 |
| `client-access` | Client seats + 7-day single-use invite links (public accept-and-set-password), plus the client-scoped delegated-Google-access surface | ✅ Built (HTTP layer 2026-09-16; services pre-existing) |
| `client-portal` | The client-facing read surface: own projects/status, own reports, message thread | ✅ Built 2026-09-13 |
| `organization` | Branding/layout-as-a-pinned-fact for published documents; enforces "no public share links" server-side, not just in the UI | ✅ Built |
| `billing` | Real signature-verified Stripe webhook billing: offers, entitlements, subscriptions, ledger, plus public diagnostic-intake and scorecard-CTA capture | ✅ Built |
| `users` | Admin-only operator account CRUD (login/registration/refresh stay in `auth`) | ✅ Built 2026-08-30, e2e 17/17 |
| `operations` | Operator-only portfolio surface: overview counts, per-client health, paginated work/report/lead lists, saved views | ✅ HTTP layer built 2026-09-16 (service pre-existing) |

### 1.3 Not started (required by PRD / PLAN)

Individual frontend feature UIs beyond the shell (query-set builder, measurement runs, reports with react-pdf, swarm-layer UIs, etc.) — each lands with its module's UI work in `PLAN.md` §3.2 order. No backend module from the PRD/PLAN remains unbuilt.

### 1.4 Frontend

✅ **Dashboard shell built 2026-08-30** (task #12): Next.js 16 App Router + Tailwind. `AppShell` header (dashboard/login/logout), `lib/api.ts` typed fetch client (bearer token in localStorage, `ApiError` normalization), `/login` (login + register flows), `/` dashboard (project list + create, `{projects:[…]}` unwrapping), `/projects/[projectId]` workspace — live Rung-0 scorecard button (fresh audit → score/band → the 3 named problems → nonObvious badge → public share token note) + the module map for the 14 backend modules (feature UIs land module-by-module from here; react-pdf PDF still deferred with the report UI). Verified end-to-end in a real browser (playwright chromium): login → create project → workspace → scorecard run (33/100, 3 problems) → logout. Test rows wiped; `tsc --noEmit` and `next build` green. Caveats: `NEXT_PUBLIC_API_URL` is baked at *build* time (misconfigured target showed up as "Failed to fetch" in the first browser pass — rebuild with the right value); CORS on the backend defaults to `http://localhost:3000` (override `CORS_ORIGIN` when serving the skill on another port); registration is admin-only once the first account exists — the UI's register mode surfaces that error honestly.

---

## 2. PRD coverage matrix (FR → module → status)

| PRD stage | Requirements | Owning module(s) | Status |
|---|---|---|---|
| 6.1 Intake | FR-1.1 to FR-1.5 (form, enrichment, competitor discovery, bulk CSV/API, rate limiting) | `intake` | ⚠️ Built 2026-08-30: domain intake + auto-enrichment + bulk endpoint; full FR-1.5 rate-limit policy and competitor-discovery depth remain open |
| 6.2 Access probe | FR-2.1 to FR-2.6 | `technical-audit` | ✅ Built (all six; FR-2.4 is inferred-confidence by design) |
| 6.3 On-page & schema | FR-3.1, 3.2, 3.5 | `technical-audit` | ✅ Built |
| 6.3 On-page & schema | FR-3.3 (extractability scoring), FR-3.4 (soft 404s, AI-referred 404s) | `page-analysis`, `crawler-monitor` | ⚠️ Both modules built 2026-08-30: `crawler-monitor` (log ingestion + classification) and `page-analysis` (deterministic BLUF/question-H2/format/claims scoring, FR-8.4 spirit — disclosed weights, never renormalized). The 404 sweep automation itself remains open (data feed in place) |
| 6.4 Entity resolution | FR-4.1, 4.2 (model-diff, collision detection) | `entity-audit` | ⚠️ Model-diff execution + Claude judge built 2026-08-30 (honest 503 without keys — live verdicts gated on API keys); collision detection not built |
| 6.4 Entity resolution | FR-4.3 (cross-platform descriptor consistency) | `entity-audit` | ✅ Manual + semi-auto single fetch |
| 6.4 Entity resolution | FR-4.4 (listicle presence check) | `mention-tracking` | ✅ Built 2026-08-30: campaigns/targets/checks with semi-auto single-fetch verification, evidence excerpts, ≥90-day decay view (FR-4.4 specifically = target type `listicle` + manual discovery; reuses the same machinery for review tracking) |
| 6.5 Query-set gen | FR-5.1 to FR-5.4 (100-300 prompts, tagging, versioning, export) | `query-set` | ⚠️ Built 2026-08-30: versioned persona sets, tagging, activation/fork immutability, export. Min-count (100-300) and seeded imports not enforced |
| 6.6 Measurement | FR-6.1 to FR-6.6 (n>=5 runs, multi-geo, Observation schema, surface adapters) | `measurement` | ✅ Built 2026-08-30: n≥5 enforced, Observation schema + extraction, Claude/Perplexity/mock adapters, raw-answer storage, cost governor. Multi-geo egress proxy routing deferred |
| 6.7 Share of voice | FR-7.1 to FR-7.3 | `measurement` (inside) | ✅ Built 2026-08-30: summary.shareOfVoice (subject "(you)" vs named competitors from Project.competitors), mention/citation rates by surface + funnel stage |
| 6.8 Scoring | FR-8.1 to FR-8.4 (0-100 weighted, versioned rubric, evidence-linked) | `scoring` | ✅ Built 2026-08-30: versioned rubrics (v1 auto-seeds PRD 25/25/20/20/10 + PRD bands), evidence-linked sub-scores, honest partials (FR-8.4). Shortlist dimension reads real measurement summary. Reporting refactored onto it |
| 6.9 Findings | FR-9.1, 9.2 (classify, rank, non-obvious guarantee) | `gap-analysis` + `findings` | ✅ Classification + ranking exist; `findings` adds thinRun honest flag + non-obvious evidence threshold |
| 6.9 Findings | FR-9.3 (what/why/fix copy, two registers), FR-9.4 (claims-discipline filter) | `findings`, `claims` | ✅ Built 2026-08-30: constrained-LLM two-register copy (Anthropic, JSON schema), claims-discipline filtered; claims module = deterministic banned-phrase blocker + A/B/C provenance grading + hard approval gate. E2e-verified; live-LLM paths need ANTHROPIC_API_KEY |
| 6.10 Report | FR-10.1 to FR-10.5 (web + PDF, charts, branding, noindex) | `reporting` | ⚠️ Built + now fed by the scoring module (versioned rubric, PRD bands, real measurement inputs). Charts and true PDF rendering deferred |
| 6.11 Delivery & CRM | FR-11.1 to FR-11.4 (email, CRM, CTA logging, Stripe) | `delivery` | ✅ Built 2026-08-30: Plunk email (honest 503 guards), internal Lead CRM + append-only CTA log + CSV export (FR-11.2/11.3), Stripe Checkout ledger with click/complete flows (FR-11.4). Real Stripe SDK webhook with signature verification = documented next iteration |
| 6.12 Monitoring | FR-12.1 to FR-12.4 (scheduled re-runs, deltas, alerts, dashboard) | `monitoring` | ✅ Built 2026-08-30 (scheduled handler + cadence endpoints via BullMQ/Redis: PUT/DELETE need Redis running; snapshot/delta/check/alerts e2e-verified incl. score-drop alert) |
| §12 Cost governor | Per-run budget ceiling | `TA_MAX_COST_PER_RUN` (technical-audit) + `MEASUREMENT_MAX_COST_PER_RUN` (measurement — stops the run and records the reason) | ✅ Per-module caps in place |
| §13 Product ladder | Rung 0 free diagnostic + §17 self-serve question | `scorecard` | ✅ Built 2026-08-30 (engine + operator API; public funnel env-gated per the §17 decision in `docs/analysis/wave-5.md`) |
| §13 Product ladder | Upgrade path free → full/monitoring | `delivery` (Stripe option A) + `pipeline-math` (GTM qualification) | ✅ Built 2026-08-30 |

**Net:** the static diagnostic half is built, the moat (measurement) is built end-to-end, and Waves 2–4 (scoring/claims/findings, crawler-monitor/entity-diff/monitoring, content & outreach tools) landed on 2026-08-30 with e2e verification. Reporting still needs charts + PDF. Remaining on this track: Wave 5 (scorecard / delivery / pipeline-math) + the frontend shell.

---

## 3. Required modules, in build order (the checklist)

Order reconciles `PLAN.md` phases, PRD §16 build sequence, and the dependency graph (`PLAN.md` §10). One module at a time. Each item: analysis doc → approval → build → AGENTS.md post-completion checklist (7 items) before the next.

### Wave 0 — Foundation (blocks everything) — NEXT P0

- [x] **`auth`** — ✅ Built (custom JWT, not Auth0/Clerk). Access + refresh tokens with rotation and reuse detection, roles: admin, delivery-lead, content, technical, outreach, sales. Feeds every module: a global `JwtAuthGuard` + `RolesGuard` now requires a bearer token on every endpoint except `@Public()` routes, client-account tokens are default-deny outside `@ClientPortal()`, and `docs/API.md`'s stale "Auth: not yet implemented" header was corrected on 2026-09-17 (its Auth Module section had documented the real behaviour all along).
- [x] **`projects`** — ✅ Built 2026-08-30. CRUD (domain unique), engagement lifecycle, artifact stats.

### Wave 1 — Core measurement engine (the moat, PLAN Phase 1)

- [x] **`query-set`** — ✅ Built 2026-08-30. Persona prompt-set CRUD, funnel-stage tags, immutable activation (draft→activate→fork), client export. Remaining for full FR-5: 100-300 min-count enforcement, seeded imports, fan-out observation tooling.
- [x] **`reporting` MVP** — ✅ Built 2026-08-30. Branded web report (executive + detailed HTML, §8 weighted score + bands). Remaining: charts, true PDF rendering, real share-of-voice inputs from `measurement`.
- [x] **`measurement`** — ✅ Built 2026-08-30. Run orchestration (n≥5 enforced at DTO + service, geo recorded per run), surface adapters behind one `SurfaceAdapter` interface (`claude` via Anthropic SDK + `web_search_20260209` citations, `perplexity` via sonar, `mock` test-only behind `MEASUREMENT_ALLOW_MOCK=1`), deterministic Observation extraction (name + longest-brand-token / host matching, citation detection with 1-based position for diagnostics only), raw-answer storage, rates + share-of-voice summary (subject "(you)" vs named competitors), per-run cost governor `MEASUREMENT_MAX_COST_PER_RUN`. Completed runs cannot be re-executed; failed runs retry with clean counters. E2e-verified against the mock surface (20 obs, 0 failed, rates + SOV). Remaining: geo egress proxy routing (FR-6.3 multi-geo), Google AIO adapter. **ChatGPT adapter landed 2026-09-10** with `aeo-audit` (`chatgpt-browser`, gated).

### Wave 6 — Audit pipeline completion (in progress)

- [x] **`digital-presence`** — ✅ Built 2026-09-11. Discovers the client's social / listing / app-store accounts from their **own site** (JSON-LD `sameAs` + on-page links), gated by a per-platform signature table that rejects share widgets, intent links, posts and bare hostnames — the false positives a naive host match would report to a client as their account. **Three account states, never two:** `confirmed` / `unverified` / `missing`, where `unverified` means found on the client's site but the platform refused the check (Instagram + Facebook login walls, LinkedIn HTTP 999 to datacentre IPs) and carries the platform's reason verbatim; those hosts are not fetched at all. Operator entry by URL alone (platform + handle derived) outranks the crawler and **survives re-runs**. `GET /presence` also aggregates the wider footprint from `aeo-audit` / `technical-audit` / `google` / `seo-audit` / `intake`, where `not-checked` is kept distinct from `none`. Handles case-folded per platform (`foldCase`), with YouTube `channel/UCxxx` ids carved out as case-sensitive. **Company vs personal (2026-09-12)**: every row carries `entity` — a founder's LinkedIn `/in/`, Google Scholar or ORCID profile is recorded but excluded from `counts.total` and cannot close a gap. Decided from the site's own schema `@type` first (a `sameAs` under `Person` is a person's), then URL shape. On rothenhall.com this is the difference between reporting 3 company profiles and the true 1. **Assessment (stage 2's *analyse* column)**: `headlines` (plain language, worst-first, no score), `coverage` per category (`covered`/`partial`/`absent`/`not-checked`) across the flowchart's five — social, directories, reviews, marketplaces, publishing — and `notMeasured`, naming what the module cannot yet see (social activity, review content, directory completeness) so a gap is never inferred from silence. Expected platforms are keyed on an **inferred business type** (B2B services / B2B software / local services / consumer brand) from the client's own category text, reported alongside the text it was guessed from; before this the social-only list left four of five categories permanently "not checked". **Google sweep (DataForSEO, 2026-09-12; vendor consolidated 2026-09-13)** finds accounts the site does not link, as `candidate` rows only — excluded from every count, unable to close a gap, promoted solely by an operator's yes. Opt-in per run (`searchWeb: true`), queries only still-missing platforms, capped by `PRESENCE_SERP_MAX_QUERIES`; the crawl and the whole smoke harness stay zero-spend. Verified: smoke **50 passed / 0 failed / 1 skipped** (incl. the zero-spend assertion and the invariant that a personal profile never moves the company total), classifier 41/41 + 6 canonicalisation + 6 case-folding cases, live against `hubspot.com` (8 accounts, zero false positives) and `notion.so` (16 candidates from 5 queries; 1 credit when 4 of 5 platforms were already held). Remaining: social **activity** (followers, cadence, engagement) is step 5 via Apify — this module defines the accounts it will enrich. Frontend: `DigitalPresence` card above Audits + `DigitalPresenceWorkspace` (Accounts · Suggested · Gaps · Footprint · Discovery).
- [x] **`trial` matrix tiers** — ✅ Built 2026-09-11. `TIER_SIZES` gains `trial: 5` / `trial-wide: 10` for metered surfaces on a free allowance. Fixed an allocation bug where a per-dimension floor turned a 5-prompt tier into 10 — the tier meant to cap spend would have doubled it.

### Wave 2 — Scoring, findings, claims (make reports honest and defensible) — ✅ complete 2026-08-30

- [x] **`scoring`** — ✅ Built 2026-08-30. Versioned `ScoreRubric` rows (v1 auto-seeds PRD 25/25/20/20/10 + invisible/faint/present/recommended bands), persisted `ScoreRun` records the rubric version, every sub-score carries evidence lines (FR-8.3), missing sources mark dimensions `partial` with a reason (FR-8.4 — never silently zero, never re-normalized up). Shortlist presence reads the real measurement summary (mention rate + SOV). `reporting` refactored onto it; its old proxy scorer and non-PRD bands deleted.
- [x] **`claims`** — ✅ Built 2026-08-30. Deterministic discipline check (banned-phrase list incl. "rank #1"/"guaranteed", ungraded-number detection, single-run-rate blocking), A/B/C provenance grading (A = own n≥5 measurement, B = 2+ independent sources via auto-upgrade on `attachSource`, C = single source), hard approval gate re-checking discipline at approval. E2e-verified: banned copy blocked, C→B on second source, ungraded approval 400 + auto-`blocked`.
- [x] **`findings`** — ✅ Built 2026-08-30. Ranking from open gaps (priorityScore-desc), constrained-LLM what/why/fix in executive + technical registers (Anthropic SDK, strict JSON schema, evidence-only facts), claims-discipline post-check (banned copy regenerated once then skipped), honest `thinRun` flag when evidence < non-obvious threshold (≥2 modules or high severity) or batch < 3 findings. Needs `ANTHROPIC_API_KEY`; 503 without it (e2e-verified guard).

### Wave 3 — Close deferred items and monitoring ✅ Complete (2026-08-30)

- [x] **`crawler-monitor`** — PLAN Phase 2 remainder, SOP-3/4.5. Built: `hits[]` JSON + CLF `logText` ingestion (skip-counted, 400 when nothing parses), 14-bot registry classification (training/search/citation-engine/unknown, longest match), summary roll-up, hit listing with filters. e2e: 3 JSON hits + 3-of-5 CLF lines ingested, `byType {training:3, search:1, citation-engine:1, unknown:1}` correct, `?botType=search` filter, empty ingest 400, `?limit` DTO bug found+fixed.
- [x] **`entity-audit` model-diff completion** — Built on the already-chosen providers (Claude + Perplexity measurement SurfaceAdapters): per-provider ModelDiff rows, Claude judge (`Aligned:`/`Divergent:`) with <2-answer skip and honest `judge-unavailable`/`judge-failed`. e2e: honest **503** guard without keys; list endpoint 200. Live verdicts still gated on API keys (kept open in LEFT-OUT.md §1).
- [x] **`monitoring`** — PRD 6.12. Built: snapshot (404-with-hint when empty), two-latest delta, `POST /check` threshold alerts (score −10/mention −15 pts, escalate −20/−30) persisted as Alert rows, `monitoring` BullMQ scheduled handler (+`scheduled-run-failed`), cadence endpoints. e2e: snapshot 404 → live (25 obs, 6 crawler hits), check `[]` → seeded 95→0 regression → critical score-drop alert + filters + delta `{95→0,change:-95}`. `PUT/DELETE /schedule` documented as Redis-gated (6380 not running in test env).

### Wave 4 — Content & outreach tools (PLAN Phase 3) ✅ Complete (2026-08-30)

- [x] **`page-analysis`** — SOP-6, FR-3.3. Built: strictly deterministic scoring from one fetch — BLUF 30 (SOP-6 40–60-word window with decay), question-H2 25, format 25 (tables/ordered lists/definition blocks), claims 20 (number+noun+timeframe/source; full credit at ≥5 sourced), `structureScore` never renormalized (FR-8.4 spirit); standalone-heading heuristic disclosed per-heading; every analyze persists a row (restructure history); optional `useLlm` Claude notes stored separately and never scored. e2e: example.com → complete (bluf 30/total 30), `useLlm` without key → honest **503** with nothing persisted, rich crafted fixture → **87/100** (bluf 30 / qH2 25 / format 20 / claims 12), localhost URL → honest `fetch-failed` row (SSRF guard by design), `@IsUrl()` localhost DTO bug found+fixed.
- [x] **`mention-tracking`** — SOP-7, FR-4.4. Built: campaigns ("best X" hunt-query anchored) → targets (listicle/community/review/other with outreach lifecycle `new → contacted → replied → placed | rejected`) → MentionCheck ledger; semi-auto single-fetch check (brand token ≥2 chars, ±60-char evidence, fetchedTitle, httpStatus); decay view (STALE_DAYS=90, only evidence-contains-token checks count; never-mentioned = missing-listicle gap, not stale). e2e: honest negative check (mentioned:false, httpStatus 200), short-token 400, bad-status 400, lifecycle flip + `?status` filter with `latestCheck`, correct decay shape.
- [x] **`sleeper-refresh`** — SOP-10. Built: manual entry + pasted GSC CSV/TSV import (upsert by URL, skip-counted `{upserted, skipped}`, 500-row cap); thresholds decline ≥20% AND refs ≥3 → `sleeper | not-sleeper | unproven` sorted by decline; status lifecycle `flagged → brief-sent → in-progress → refreshed | abandoned`; `markRefreshed` stamps `dateModifiedAfter` for the SLA audit; summary byStatus + `dateModifiedMoved`. e2e: correct classifications, import `{upserted:2, skipped:2}`, third-column (refs) parse bug found+fixed mid-e2e, refresh + summary counts, bad-status 400. GSC OAuth pull left out (external prerequisite, recorded in `docs/analysis/wave-4.md`).
- [x] **`data-asset`** — SOP-8, P3 (minimal by design). Built: asset lifecycle tracker (`planned → fielding → published`) with brandAlignment (`brand-named`/`subject-matter`), methodologyNote, surveySize, assetUrl; publish stamps `publishedAt`. e2e: create 201, publish stamps, invalid status 400 — and the PATCH DTO was fixed mid-e2e (it had inherited required `title` from create, breaking partial updates).

### Wave 5 — Ladder, monetization, qualification (PLAN Phase 4, PRD 6.11 + §13) ✅ Complete (2026-08-30)

- [x] **`pipeline-math`** — GTM Playbook arithmetic. Built: one persisted `PipelineMath` row per project; the full qualification chain (revenueTarget ÷ ACV ÷ winRate ÷ meetingToSql ÷ leadToMeeting ÷ visitorToLead) with every stage persisted and ceil-rounded; verdict `feasible | fiction` against a supplied marketSize at the disclosed 1.5× `FICTION_FACTOR`; PATCH what-if recalc (partial inputs keep stored values). e2e: 500k/25k plan → visitors 100,000 verified stage by stage, market 10k → `fiction` (ratio 10), recalc → feasible (ratio 0.08), rate 0 → 400.
- [x] **`scorecard`** — Rung 0, PRD §13 + §17. Analysis resolved §17 as option B (`docs/analysis/wave-5.md` §2): engine + operator API now, public funnel behind `SCORECARD_PUBLIC=1` (a flag, not a rebuild). Built: fresh technical audit (probe failure → partial dimensions with reasons, never blocks the run) → versioned-rubric scoring → exactly **3 named problems** derived deterministically from the run's evidence (no LLM key required — the free funnel never blocks on a paid key) → `nonObvious` flag from probe-only evidence (blocked/render/`schema audit: fail`) → `ScorecardRun` with unguessable public share token. e2e: run 201 (score 33/invisible, 3 named problems), public 403 with flag off → 200 with flag on, bad token 404, list newest-first.
- [x] **`delivery`** — PRD 6.11. Built per analysis choices: Plunk email (pre-approved; 503 `email-unconfigured` / `email-send-failed` guards, subject operator-editable, link-first — react-pdf PDF is frontend scope), internal Lead CRM (sources bulk/api/form/scorecard, `new → reached → booked | won/lost`) with **append-only** CTA event log (`book-call`/`review-ask`/`upgrade-click`) + CSV export for any external CRM (Attio/HubSpot = later), Stripe Checkout ledger (option A): links from `STRIPE_CHECKOUT_URL_*` env, click flips the lead's log, @Public completion = webhook stand-in (SDK + signature verification = documented next iteration). e2e: all guards + click/complete chain + lead event log verified.

### Wave 7 — Client Portal & Admin Console revamp (2026-09-21, C1 + §11.0 cleanup + C3 done, C2/C4-C7 status per their own concurrent passes)

Full decision record: `docs/analysis/client-portal.md` v1.3 (35 sections). Build order,
dependencies, and the required-before-code note on the engagement/timeline model: `docs/PLAN.md`
§11 (phases C1–C7, plus a §11.0 cleanup pass — deprecating the duplicate client-login mechanism,
retiring CP04 as the onboarding gate in favor of the new wizard, and formalizing the
`frontend`/`client-portal` directory removal). Not sequenced into Waves 0–6 above because it's a
separate track (admin/client platform layer, §1.2h) from the engine-pipeline waves — see
`docs/PLAN.md` §11 for its own phase-by-phase checklist.

- [x] **§11.0 cleanup** — four of the five items done (the fifth, `frontend`/`client-portal`
  removal, is deliberately out of scope for this pass — a separate, isolated commit the user
  does themselves):
  - Collapsed to one client-login mechanism: `POST /clients/:clientId/login` (temp-password)
    marked `@deprecated` in both `ClientsController` and `ClientsService` (kept working, not
    removed); its only known caller, `web/.../ops/clients/[clientId]/access/page.tsx`, now shows
    an in-page deprecation banner. `POST /clients/:clientId/invites` (`client-access`) confirmed
    canonical.
  - CP04 (`web/.../welcome/page.tsx`) retained as-is with an inline comment documenting the
    Phase-C2 transition plan (first-visit gate today → post-onboarding "manage connections"
    surface once C2's real wizard ships). No UI restructuring, per the stage's own scope limit.
  - `Project.onboardingStatus`/`onboardingStep` (pipeline-internal) now carry an explicit
    doc-comment safeguard, in both `schema.prisma` and `schema.production.prisma`, against being
    repurposed for the future engagement Phase/Milestone model (Phase C3).
  - `frontend`/`client-portal` directories: untouched, as instructed.
  - `sleeper-refresh`'s GSC-OAuth gap: untouched, as instructed (already flagged in its own Wave-4 row above).
- [x] **C1 — audit trail + onboarding-gate foundation.** Reused the existing `activity` (G15)
  module as the shared admin-action audit log §33 asked for (it already matched the spec —
  actor/action/target/timestamp/redacted metadata, plus admin-only reads/export; no new module
  built) — added `'waived'` as a new `ActivityAction`. Added `Project.onboardingWizardState`
  (`not-started | confirming-details | connecting-gsc | connecting-ga4 | done | waived`), scoped
  per-project per §16, plus `ClientsService.getOnboardingWizardState()`/`waiveOnboardingWizard()`.
  Added `POST /api/clients/:clientId/projects/:projectId/onboarding-wizard/waive`
  (`@Roles('admin')`), writing an `ActivityEvent` on every waive (§15/§33). `waived` is always
  returned as the literal state string, never collapsed to a boolean. e2e-verified against a live
  backend + real Postgres: create client/project → `GET .../onboarding-wizard` → `"not-started"`
  → `POST .../waive` → `"waived"` (persisted, re-read confirmed) → `GET
  /api/activity?action=waived&clientId=...` returned the matching audit row with actorId,
  resourceId and before/after `changes`. `npx tsc --noEmit` clean. Full write-up:
  `backend/src/modules/clients/README.md` (C1 section + PRD alignment table),
  `backend/src/modules/activity/README.md` (C1 addendum), `docs/API.md` (new endpoint reference).
  DB migration note: `prisma migrate dev` fails in this repo today with `P3019` — the migration
  history's `migration_lock.toml` still says `provider = "sqlite"` (pre-existing, from before the
  2026-09-16 Postgres cutover; the migration SQL files themselves are SQLite-dialect too) even
  though `schema.prisma` has said `postgresql` since that cutover. Not this stage's bug to fix —
  used `prisma db push` instead (confirmed schema-in-sync against the running Postgres container),
  matching what a broken `migrate dev` leaves as the only working option today. Flagging here so
  whoever picks up C2+ doesn't hit the same P3019 surprise cold.
- [x] **C3 — engagement/timeline model.** `docs/analysis/engagement-timeline.md`'s initial
  recommendation (Option A, relabel `Cycle` as "Phase") was tried and rejected on inspection:
  `Cycle` is a recurring ~30-day work-period concept (its own README already documented the
  commit/freeze/scope-change semantics that don't map onto a linear four-stage engagement
  narrative), and `plan/page.tsx` already carried a deliberate comment explaining why it renders
  `Cycle` to the client as "work period" for exactly this reason. Built **Option B** instead: a
  new, minimal `Phase` model (`name`, `order`, `status` — a display hint, not a lifecycle) that
  `Cycle`/`Commitment` optionally reference via a nullable `phaseId` (additive; no existing row
  affected). No new approval or lifecycle mechanics — Phase inherits everything `Commitment`/
  `ApprovalRequest` already enforce. Backend: CRUD + assign/unassign under
  `/api/projects/:projectId/phases` (`delivery-plan` module — no new module, per the analysis
  doc's own §4 "module ownership" conclusion), plus a new client-portal route `GET
  /api/portal/projects/:projectId/plan/phases` serving each phase's assigned cycles/commitments
  through the existing `PortalCycleDto`/`PortalCommitmentDto` allowlists (served separately, same
  precedent P11 set for `/plan/commitments`, so `/plan`'s frozen shape is untouched). Frontend:
  a Phases panel + per-cycle phase-assignment dropdown on `(ops)/projects/[projectId]/cycles`, a
  phase-assignment dropdown per commitment on `(ops)/.../roadmap`, and a new "Your engagement"
  section on the client `(client)/.../plan` page — no new nav entry, matching this app's existing
  navigation discipline against duplicate object lists (`web/src/lib/navigation.ts` §3.2). Rothenhall's
  `Diagnose → Build → Operate → Compound` marketing language is offered as an optional,
  renameable prefill suggestion (`SUGGESTED_PHASE_NAMES`) rather than a locked-in enum, per the
  analysis doc's §3.3 caution against making that product-copy call unilaterally. e2e-verified
  live against a real Postgres instance on an isolated port (`:3099`, to avoid another
  concurrently-running instance on the shared default `:3002`): created a client/project, two
  phases (auto-incrementing `order`), a cycle and a commitment, assigned and unassigned both,
  confirmed the both-or-neither-id 409 and the foreign-project 404, and confirmed the client
  portal read-back through a real client login. Caught and fixed a real bug in the same pass:
  `CommitmentDto`'s mapper (`toCommitmentDto`, an explicit field list, unlike `Cycle`'s row-spread
  mapper) never actually mapped the new `phaseId` field despite the type declaring it — `tsc`
  didn't catch it because the type was only updated in one place; the live read-back did. Also
  surfaced (and worked around, not fixed — out of scope) that concurrent agents sharing the one
  dev Postgres container can `prisma db push` each other's in-progress schema changes away
  mid-session; recovered by re-running `db push` from this worktree's own schema. `npx tsc
  --noEmit` clean in both `backend/` and `web/`. Full write-up:
  `backend/src/modules/delivery-plan/README.md` (new "Phases (C3, Option B)" section + updated PRD
  alignment table + a dedicated C3 testing-notes addendum), `docs/API.md` (new endpoints + example
  JSON), `docs/analysis/engagement-timeline.md` (status line updated to reflect Option B shipped).
  No dedicated smoke script added for C3 (left as an honest gap in the README) — the live run above
  covers the same ground once, by hand.

### Standing item (not a module)

- [x] **Frontend dashboard shell** — ✅ Built 2026-08-30 (see §1.4). Nav, login, project list, project workspace with a working Rung-0 scorecard. Individual feature UIs remain per-module work.

---

## 4. Post-module completion gate (apply to every item above)

Copied from `AGENTS.md`, non-negotiable before starting the next module:

- [ ] Module README (purpose, architecture, public API, dependencies, env vars, consumers, PRD alignment table, test notes)
- [ ] Module-level docs in module folder (README, SPEC, REQUIREMENTS, SETUP-STATUS)
- [ ] `docs/API.md` updated with all endpoints + examples
- [ ] PRD alignment table (FR-x.x → ✅/⚠️/❌)
- [ ] `docs/PLAN.md` + this file updated
- [ ] `npx tsc --noEmit` zero errors, no `any`, JSDoc on public methods, `app.module.ts` wired, `.env` + `.env.example` updated
- [ ] One end-to-end test run, results recorded; no temp files, `.env` not committed

---

## 5. Open decisions blocking modules (resolve before or during the relevant wave)

| # | Decision | Blocks | Source |
|---|---|---|---|
| 1 | Auth: custom JWT vs Auth0/Clerk | Wave 0 `auth` | PLAN §6.3 |
| 2 | Measurement surfaces for v1 (Claude + Perplexity only, or + ChatGPT proxy) and proxy/geo-egress vendor | Wave 1 `measurement` | PRD §17, spec |
| 3 | Headless exact-surface capture now vs defer | Wave 1 `measurement` | PRD §17 |
| 4 | Model providers + judge model for entity model-diff, API costs | Wave 3 model-diff completion | spec §3.1, §7.1-7.2 |
| 5 | PDF renderer + charting choices | Wave 1 `reporting` | new |
| 6 | Self-serve public scorecard vs operator-only first, free-run cost ceiling, abuse model | Wave 5 `scorecard` | PRD §17 |
| 7 | CRM: internal pipeline vs Attio/HubSpot; email: Postmark vs Resend | Wave 5 `delivery` | PRD §11 |
| 8 | Deployment target (Vercel + Railway/Render/Fly.io assumed, unconfirmed) | all waves at deploy time | PLAN §6.5 |
| 9 | ~~Product name: PRD still says "working name Beacon", repo and all module docs say Cailyx.~~ ✅ **Resolved 2026-09-20: Cailyx is final.** | `reporting`, `scorecard` | PRD header |
| 10 | ~~White-label branding in the data model now or later~~ ✅ **Resolved 2026-09-20: dropped, single-tenant only.** See `docs/analysis/client-portal.md` §0. | `reporting` schema | PRD §17 |

---

## 6. One-line summary

Waves 0–5 plus the frontend dashboard shell are complete on 2026-08-30 — every PRD/PLAN backend module is built and e2e-verified where runnable (auth + roles, projects, intake, query-set, reporting, `measurement` moat, versioned-rubric `scoring`, `claims` discipline gate, `findings` copy, `crawler-monitor`, entity model-diff + judge, `monitoring` deltas/alerts, the Wave-4 content & outreach tools, and Wave-5 `pipeline-math` / `scorecard` / `delivery`), and the frontend shell was verified in a real browser (login → project → Rung-0 scorecard run → logout). Live-LLM/schedule/GSC/payment/Plunk paths all gated with honest 503s or env flags. Backend typechecks clean, build green, e2e rows wiped to zero. Next: individual frontend feature UIs (module by module; react-pdf for the report PDF).

**2026-09-17:** the `platform_improvement_plan.md` phases are landing on top of that base — see §1.2g. Five of them now have module READMEs (`delivery-plan`, `business-profile`, `digital-presence`, `competitors`, `opportunities`) and `docs/API.md` sections; `content-workspace`, `writing-style` and `website` were still in flight and are documented as such rather than described ahead of their code.
