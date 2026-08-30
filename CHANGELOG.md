# Cailyx — Changelog

A running record of what has been built. Newest first. Each entry: what shipped,
how it was verified, and what it left for later.

Keep this current on every meaningful change. Companion docs:
`docs/MODULES-STATUS.md` (module-by-module state), `docs/PRODUCTION-READINESS.md`
(what's needed to go live), `docs/API.md` (endpoint reference).

---

## 2026-08-31 — Light theme, layout presets, Flywheel

- **Light theme (correct brand use)** — swapped to the real Rothenhall light
  palette: warm-paper canvas (`#efe9dc`), paper cards (`#fbf9f3`) with a soft
  raised-paper shadow, ink text, **brass-deep** as the quiet default accent and
  **cognac** as the single warm spotlight. The Chat card is a dark "night" card
  (BRANDING's "dramatic dark band"). Modal scrims are warm ink, not black.
- **Layout presets** — the top-bar **view** menu now has one-click presets:
  *Overview* (analytics/context/agents/chat), *Research* (big Flywheel + agents +
  chat + context), *Diagnostics* (analytics/agents/gates), *Everything*. Each
  sets card positions + visibility, then frames them.
- **Flywheel card** (Agent-#2 adjacent) — an answerthepublic-style radial of
  buyer search queries for the project, grouped into four awareness-stage wedges
  (problem → solution → product → most aware) in a cream → brass → cognac ramp.
  Click a spoke to drop that query into the Chat card.
  - New backend: `GET /api/projects/:id/journeys/suggestions` — deterministic
    suggestion wheel built from the journey-planner templates + the project's
    personas + queries real journeys produced. No LLM, no spend.
    (`journey.suggestions.ts`; planner `FOLLOWUPS`/`OPENERS` now exported.)
- Verified in-browser: light theme on login + console, presets rearrange +
  frame, Flywheel renders and click-to-chat works. `tsc` + builds green.
  `journey.smoke.sh` +5 assertions (**37**), full harness **8/8 · 198**.

---

## 2026-08-31 — Infinite-canvas console + Gates card + de-browned palette

- **Infinite canvas** — the console is now a pannable / zoomable stage
  (`components/canvas/Canvas.tsx`, `CanvasCard.tsx`; no external library). Cards
  (Analytics · Context · Agents · Chat · Gates) drag by their header, resize
  from the SE corner, hide via ✕ or the top-bar **view** menu. Pan by dragging
  empty space; wheel to zoom toward the cursor; **fit** / **reset view** /
  zoom ± controls. Viewport + card boxes persist in `localStorage['cailyx.canvas']`.
  The old fixed row layout + `Pane.tsx` are gone.
- **Gates card** — a live view of `docs/PRODUCTION-READINESS.md`: "needs a key
  or credential" (from `GET /api/integrations`), "not wired — needs code"
  (GA/GSC OAuth, Redis-backed throttler, deployment artifacts), and "modes"
  (swarm-live, dev flags to disable). `chat` gains a `gates` command.
- **Palette de-browned** — the all-warm dark theme read as a flat brown wash.
  Kept the Rothenhall brass/cognac identity but deepened the stage to a near-black
  `#100e0b`, lifted cards to a warm charcoal `#1c1a15`, brightened text to
  `#f0ece0`, and spread status across brass → cognac → amber → red so states
  separate. The Chat card is a darker "night" variant for contrast.
- Verified in-browser: pan, zoom, fit, card move/resize/hide, all five cards
  render, Gates lists the 7 unconnected integrations. `tsc` + `next build` green.

---

## 2026-08-31 — Brand palette + production-readiness docs

- **`docs/PRODUCTION-READINESS.md`** — the go-live checklist: every secret / API
  key (Anthropic, DataForSEO, PSI, Perplexity, Google OAuth, Stripe, Plunk,
  `JWT_SECRET`), infra (SQLite→Postgres, managed Redis, Playwright browser),
  security hardening, build/deploy sketches, observability + cost control, the
  swarm boundary as policy, a full env-var reference (dev vs prod), and open
  decisions. Commit `10e5c6a`.
- **`CHANGELOG.md`** — this file. `AGENTS.md` + `MODULES-STATUS.md` now point at
  both and instruct keeping them current.
- **Frontend colour re-theme** (`39690f0`) — the console now uses the Rothenhall
  Partners palette (BRANDING.md): Night band backgrounds, brass-soft as the
  quiet default accent, cognac-soft as the warm spotlight, warm-gold caution,
  lifted cognac-deep for critical. Applied purely via `globals.css` CSS
  variables + the tailwind token map. **Fonts unchanged** (terminal monospace).
- `frontend/.env.example` corrected to the real dev API port (3002).

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
