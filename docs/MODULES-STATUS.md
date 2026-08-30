# Cailyx — Module Status & Required-Modules Plan

> **Status:** Living document, updated per module completion
> **Date:** 2026-08-29
> **Sources:** `docs/PRD.md` (AI Visibility Diagnostic, working name Beacon), `docs/PLAN.md`, `docs/cailyx-audit-modules-spec.md`, module READMEs in `backend/src/modules/`
> **Rule reminder:** One module at a time. Analysis doc (`docs/analysis/<module>.md`) with 2-3 tool options per dependency, user approval, then code. See `AGENTS.md`.

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

- [ ] **`auth`** — JWT + refresh, roles: admin, delivery-lead, content, technical, outreach, sales. Analysis must present: custom JWT vs Auth0 vs Clerk (2-3 options, pricing). Feeds every module (currently all endpoints are unauthenticated, `docs/API.md` notes "Auth: not yet implemented").
- [x] **`projects`** — ✅ Built 2026-08-30. CRUD (domain unique), engagement lifecycle, artifact stats.

### Wave 1 — Core measurement engine (the moat, PLAN Phase 1)

- [x] **`query-set`** — ✅ Built 2026-08-30. Persona prompt-set CRUD, funnel-stage tags, immutable activation (draft→activate→fork), client export. Remaining for full FR-5: 100-300 min-count enforcement, seeded imports, fan-out observation tooling.
- [x] **`reporting` MVP** — ✅ Built 2026-08-30. Branded web report (executive + detailed HTML, §8 weighted score + bands). Remaining: charts, true PDF rendering, real share-of-voice inputs from `measurement`.
- [x] **`measurement`** — ✅ Built 2026-08-30. Run orchestration (n≥5 enforced at DTO + service, geo recorded per run), surface adapters behind one `SurfaceAdapter` interface (`claude` via Anthropic SDK + `web_search_20260209` citations, `perplexity` via sonar, `mock` test-only behind `MEASUREMENT_ALLOW_MOCK=1`), deterministic Observation extraction (name + longest-brand-token / host matching, citation detection with 1-based position for diagnostics only), raw-answer storage, rates + share-of-voice summary (subject "(you)" vs named competitors), per-run cost governor `MEASUREMENT_MAX_COST_PER_RUN`. Completed runs cannot be re-executed; failed runs retry with clean counters. E2e-verified against the mock surface (20 obs, 0 failed, rates + SOV). Remaining: geo egress proxy routing (FR-6.3 multi-geo), ChatGPT/Google AIO adapters.

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
| 9 | Product name: PRD still says "working name Beacon", repo and all module docs say Cailyx. Confirm Cailyx is final so reports/branding are consistent | `reporting`, `scorecard` | PRD header |
| 10 | White-label branding in the data model now or later | `reporting` schema | PRD §17 |

---

## 6. One-line summary

Waves 0–5 plus the frontend dashboard shell are complete on 2026-08-30 — every PRD/PLAN backend module is built and e2e-verified where runnable (auth + roles, projects, intake, query-set, reporting, `measurement` moat, versioned-rubric `scoring`, `claims` discipline gate, `findings` copy, `crawler-monitor`, entity model-diff + judge, `monitoring` deltas/alerts, the Wave-4 content & outreach tools, and Wave-5 `pipeline-math` / `scorecard` / `delivery`), and the frontend shell was verified in a real browser (login → project → Rung-0 scorecard run → logout). Live-LLM/schedule/GSC/payment/Plunk paths all gated with honest 503s or env flags. Backend typechecks clean, build green, e2e rows wiped to zero. Next: individual frontend feature UIs (module by module; react-pdf for the report PDF).
