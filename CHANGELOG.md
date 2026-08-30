# Cailyx — Changelog

A running record of what has been built. Newest first. Each entry: what shipped,
how it was verified, and what it left for later.

Keep this current on every meaningful change. Companion docs:
`docs/MODULES-STATUS.md` (module-by-module state), `docs/PRODUCTION-READINESS.md`
(what's needed to go live), `docs/API.md` (endpoint reference).

---

## 2026-08-30 — Swarm layer, dashboard aggregation, user management, Cailyx console

Commit `8e70574`. 101 files, +11,708 / −384.

### Backend — swarm layer (synthetic-buyer research agents)

Analysis + boundary: `docs/analysis/swarm-layer.md`. **No new npm dependencies.**
New external service: DataForSEO (SERP data — user-approved). Every live path
gated behind `SWARM_ALLOW_LIVE` + the relevant key, with an honest `503`
otherwise; deterministic + `fixture` adapters back the tests.

| Module | Agent | What it does |
|---|---|---|
| `persona` | #1 | Deterministic 10-role buyer-persona generator (seeded, reproducible) + optional LLM refinement. `PERSONA_MAX_PER_PROJECT` fan-out cap. draft→active→archived. |
| `journey` | #2 | Branching multi-step search-journey planner; executor over the `measurement` surface adapters. `JourneyCampaign` fan-out under one `budgetUsd`; per-journey `maxCostUsd` cap; `SWARM_ALLOW_LIVE` master switch. |
| `internal-link` | #8 | Crawls the client's own site (FetcherService + sitemap seed), builds the internal link graph, finds orphans / under-linked hubs, emits ranked "add link A→B" recommendations. |
| `council` | #10 | Six role-agents × rounds debate over existing artefacts (gap-analysis, link graph, journeys, measurement, audits) + a synthesizer that ranks interventions and records dissent. Proposes no new measurement. |
| `serp-intelligence` | #3 | DataForSEO `live/advanced` provider + offline fixture. Per-query subject rank, AI-Overview presence/mention, competitors, top domains, source spread. `SERP_MAX_COST_PER_CAPTURE` governor. |
| `authority` | #6 | Discovers legitimate mention targets (SERP listicles + AI-answer citations + optional LLM), excludes client/competitors/junk, promotes chosen ones into the `mention-tracking` ledger. No automated outreach. |

Shared infra: `common/utils/prng.ts` (deterministic PRNG),
`common/utils/subject-match.ts` (subject/competitor scoring, parity with the
`measurement` moat).

### Backend — dashboard aggregation + admin

| Module | Endpoint | Purpose |
|---|---|---|
| `integrations` | `GET /api/integrations` | Connection status for every external service (GA/GSC OAuth stubs, Anthropic, Perplexity, DataForSEO, PageSpeed, Redis live-ping, Database, Stripe, Plunk, swarm mode). Booleans + metadata only — **no secret values**. |
| `agents` | `GET /api/projects/:id/agents` | The Agents Feed — one card per capability with a live status/headline/activity derived from real artefacts. |
| `users` | `/api/users` CRUD | **Admin-only** operator administration (list / create with role / re-role / rename / reset-password / delete). Guard rails: last admin can't be demoted or deleted; can't delete your own account. Never returns hashes. |

### Backend — fixes

- `scheduling.service.ts` now implements `OnModuleDestroy` — closes the BullMQ
  worker + both ioredis connections it leaked on every `--watch` reload / test boot.

### Frontend — rebuilt as the Cailyx operator console

Replaced the light "operator dashboard shell" with a dark, terminal-styled console.

- **Movable / resizable / hideable panes** — Analytics · Context · Agents Feed ·
  Chat. Each pane header has reorder (◄ ►) and hide (✕); a drag handle resizes
  it; a "layout" menu toggles panes + resets. Layout persisted per browser
  (`localStorage['cailyx.layout']`).
- **Analytics pane** — SEO / Links / Technical / GEO tabs, Google Analytics +
  Search Console connector cards, signal table (meta title/desc/H1/checks),
  on-page issues list, "run audit".
- **Context pane** — editable name + description (PATCH `/projects`), the
  context-artefact list, competitors.
- **Agents Feed** — expandable cards showing what each agent is doing.
- **Chat pane** — deterministic terminal assistant over already-loaded data
  (`status`, `issues`, `visibility`, `attention`, `connections`, `context`,
  `help`); no LLM. Plus the "Hire your full-time CMO" banner.
- **Connections modal** — the full `GET /api/integrations` roster, grouped.
- **User Management modal** — admin-only; drives the `users` module.
- Login screen restyled; the legacy `/projects/:id` route redirects to the
  console with the project preselected.

### Verification

- `backend/smoke/` harness — **8 scripts, 193 assertions**, all deterministic /
  zero-key / zero-spend: `persona` 24, `journey` 32, `internal-link` 23,
  `council` 22, `serp-intelligence` 25, `authority` 22, `dashboard` 28, `users` 17.
- `tsc --noEmit` clean (backend + frontend). `nest build` + `next build` green.
- Browser-driven: login → console → agent expand → chat commands → connections
  modal → user-management modal → live technical audit (Analytics pane populated
  from `rothenhall.com`).
- Installed Playwright chromium so the audit's `js-render` check runs.

### Docs

`docs/MODULES-STATUS.md` §1.2e, `docs/API.md` (swarm + dashboard + users
sections), `docs/analysis/swarm-layer.md`, per-module READMEs.

### Left for later

- Google Analytics / Search Console **OAuth flow is not built** — the Connect
  buttons report `not-connected`; GSC data is CSV-imported via `sleeper-refresh`.
  See `docs/PRODUCTION-READINESS.md` §3.1.
- SQLite → PostgreSQL migration for prod.
- Deployment artifacts (Dockerfiles, CI) — none yet.
- Live-path verification for the keyed integrations (LLM refine/debate,
  DataForSEO real payload parsing, campaign budget-hit branch) — runs on first
  keyed use.

---

## 2026-08-30 — Cailyx foundation (Waves 0–5 + frontend shell)

Commit `8e72952`. The initial engine.

- **Wave 0** — `auth` (custom JWT + passport, roles), `projects`, `intake`,
  `config`, `database` (Prisma), `fetcher` (all outbound HTTP, rate-limited),
  `scheduling` (BullMQ), `health`.
- **Wave 1** — `query-set` (versioned buyer prompt sets), `measurement`
  (**the moat** — n≥5 per prompt per surface, Claude + Perplexity + mock
  adapters, mention/citation/SOV), `reporting` (branded report + PDF).
- **Wave 2** — `scoring` (versioned rubric, honest partials), `claims`
  (banned-phrase + single-run-rate gate, A/B/C grading), `findings`
  (two-register what/why/fix copy).
- **Wave 3** — `crawler-monitor` (AI-crawler log ingestion), `monitoring`
  (deltas + regression alerts), entity model-diff + judge.
- **Wave 4** — `page-analysis`, `mention-tracking`, `sleeper-refresh`,
  `data-asset`.
- **Wave 5** — `pipeline-math`, `scorecard` (Rung-0 free diagnostic), `delivery`
  (Plunk email, Lead CRM, Stripe Checkout links).
- **Frontend shell** — Next.js: nav, login, project list, project workspace with
  a working Rung-0 scorecard.

Everything e2e-verified where runnable; live LLM / schedule / GSC / payment /
email paths gated with honest `503`s or env flags. Backend `tsc` clean, build
green.
