# Cailyx — Changelog

A running record of what has been built. Newest first. Each entry: what shipped,
how it was verified, and what it left for later.

Keep this current on every meaningful change. Companion docs:
`docs/MODULES-STATUS.md` (module-by-module state), `docs/PRODUCTION-READINESS.md`
(what's needed to go live), `docs/API.md` (endpoint reference).

---

## 2026-08-31 — Project switching: skeletons, no stale flash, competitors show

- **Cards no longer blank (or show stale data) when you switch project or add a
  new one.** New `CardSkeleton` (shimmer, `prefers-reduced-motion` aware) fills
  Analytics / Context / Agents / Flywheel while a project with no cached copy
  loads. Cards with a cached copy still paint it instantly, then refresh.
- **`GET /projects/:id` was silently dropping `competitors`** — `toDto()` never
  copied the field, so the Context card always read "none set" even when intake
  had found competitors. Added it to `ProjectDto` + `toDto()`; Rothenhall now
  shows Profound / Peec AI, day1tech shows DayOneX.
- **Stale-response guard** — `activeIdRef` means a slow `getProject` /
  `getSuggestions` that resolves after you've switched away no longer paints the
  wrong project's data. AnalyticsPane is also keyed on the project id so a
  switch remounts it clean instead of flashing the previous audit.
- **New project** seeds its cache + state on create, so the name / domain /
  category you just typed render immediately while stats and agents load in.
- Full smoke harness 8/8 · 204. Both builds green.

## 2026-08-31 — Live-fire pipeline check (day1tech.com) + intake / link-graph fixes

Ran the full pipeline against a real domain through the public API (intake →
audit → personas → journeys → link graph → authority → council → Flywheel →
agents/dashboard): **14/14 calls OK, 0 errors, 0 unexpected 503s.** Full smoke
harness still **8/8 · 204**. The run exposed three real defects, now fixed:

- **Intake stored `name = "null"`** — `String(org.fields['name'] || null)` produced
  the literal string `"null"`, which is truthy, so `name: company || domain`
  never fell through. Added a `clean()` guard (rejects `""`, `"null"`,
  `"undefined"`); brand now falls back og:site_name → shorter `<title>` segment →
  domain-derived.
- **Intake used the H1 hero headline as `category`** — day1tech's became
  *"Technology Execution Has Been Commoditized.Operating Accountability Has
  Not."*, which then poisoned authority-scan SERP queries. New `deriveCategory()`
  prefers a specific JSON-LD `@type`, then the non-brand `<title>` segment
  (→ *"technology operating partner"*), then the first meta-description clause —
  never a raw headline. No more `'General'` filler; category can be null.
- **Link-graph emitted 49 bogus "add link" recs** when a JS-rendered nav meant
  the crawl parsed 0 internal links across 50 pages (every page flagged an
  orphan, `overlap 1.00`, `priority 149`). Now: a crawl with `edges === 0 &&
  pages ≥ 3` is treated as *degraded* — orphan/under-linked analysis is skipped
  and the graph records the real cause ("navigation is JS-rendered; static
  crawlers and AI retrievers can't follow it"). The Flywheel turns that note
  into one honest `Content` boost instead of the noise.
- Also tightened intake competitor extraction: deny-list social / docs / booking
  hosts, drop CTA-phrase anchors ("Let's talk", "Careers"), skip the subject's
  own subdomains.

## 2026-08-31 — Personalised Flywheel + AEO/GEO boosts, all from real data

- **The wheel is now built entirely from the project's own data.**
  `journey.suggestions.ts` rewritten: `deriveSignals()` pulls the category,
  competitor names, and the dominant persona role / company stage; the query
  templates fill those slots, so a stage reads `rothenhall partners vs profound`,
  `is ai visibility gtm a real problem for a cmo`, `aeo vs seo for ai visibility
  gtm` — not `{cat}` placeholders. Folded in alongside: real persona
  **vocabulary**, **objections** (→ most-aware queries) and **buying triggers**,
  plus the queries real journeys already ran. Denser, too — up to 6 themes /
  stage, ~70 leaves (was ~30).
- **New second layer — `boosts`: concrete AEO/GEO actions for the site.** Each
  `{ id, lane, title, why, action, evidence, effort }` is derived from a real
  artefact: failed/warned **technical-audit findings** (Technical lane),
  top **internal-link recommendations** + **orphan pages** (Content),
  **authority-scan candidates** (Authority), unanswered **persona objections**
  (Content), and measurement gaps — no completed journey, missing AI-surface /
  SERP keys (Measurement / GEO). Two clearly-labelled `Best practice` baselines
  round it out. `error`-status audit findings are reframed as
  "audit incomplete — check didn't run", never as a site defect, and their raw
  error blobs are flattened to one readable line.
- `journey.service.suggestionWheel()` now also loads the latest audit findings,
  link-graph recommendations + orphans, and authority candidates, and passes
  three integration-connectivity flags (env-checked, no secret values).
- **Flywheel card** gained a `buyer queries · AEO / GEO boosts (N)` switch; the
  boosts view lists each with a lane chip, the why, a click-to-Chat action, and
  an `evidence · effort` footer.
- **Fixes:** wheel-scroll over any card now scrolls that card instead of zooming
  the canvas (`Canvas` mirrors the pan handler's `[data-card]` guard). The
  Analytics *Issues* list flattens raw error blobs and shows `error` findings as
  "check couldn't run / no result" (shared `lib/text.ts#cleanFindingText`).
- `journey.smoke.sh` +5 boost assertions (array shape, count, per-boost fields,
  deterministic ids, best-practice presence) → **43**. Full harness **8/8 · 204**.
- Verified in-browser: logout → login restores the session (token + refresh) and
  every card repaints from cache; the Flywheel shows the personalised sunburst
  and the 13 Rothenhall-specific boosts.

## 2026-08-31 — Dashboard data persistence + transparent token refresh

- **Cards no longer go blank on view / preset switches or reload.** Every fetched
  payload (`me`, `projects`, `integrations`, `project.<id>`, `agents.<id>`,
  `wheel.<id>`) is now mirrored to `localStorage['cailyx.cache.*']` on success and
  re-hydrated instantly on mount, so the UI paints last-known-good data first and
  swaps in the fresh copy when it arrives.
- **Flywheel disappearing bug fixed.** Its fetch effect depended on
  `layout.hidden`, so every preset/view change re-ran it and any transient error
  nulled the wheel (the "select a project" flash). Effect now keys on `activeId`
  only, seeds from cache, and `.catch` leaves the last wheel in place instead of
  clearing it. Empty-state copy is `building suggestions… / no suggestions loaded
  yet` (no more misleading "select a project").
- **Transparent refresh-token rotation.** `lib/api.ts` split into `raw` / `apiFetch`;
  a 401 on any non-`/auth/` call triggers one `POST /api/auth/refresh`
  (singleton in-flight guard) and a single retry, so a session survives well past
  the 15-min access-token TTL. New `setSession` / `getRefreshToken` helpers;
  login now stores the refresh token; `AuthResponse.refreshToken?` typed.
- Verified in-browser: Overview→Everything preset cycle keeps the Flywheel's
  layered sunburst populated; full page reload paints all cards (incl. Flywheel)
  from cache with no blank frame. `npm run build` green.

## 2026-08-31 — Layered Flywheel (pain point + suggestion per query)

- The Flywheel is now a **layered** sunburst: hub → awareness stage → **theme**
  → query, with outer tick marks showing query density per theme (coloured by
  source: library / persona / journey).
- **Every query carries the buyer PAIN POINT it maps to and the SUGGESTION
  Cailyx would make.** These render in full, unrotated, readable text in a
  detail panel below the wheel — click a stage or theme wedge to filter it,
  click a query row to send it to Chat.
- Backend `journey.suggestions.ts` rewritten around a `LIBRARY` of
  `{theme, query, painPoint, suggestion}` entries per stage (AI-visibility /
  GTM specific), folded together with persona vocabulary and real journey
  queries. Response shape: `{ hub, stages:[{ themes:[{ queries:[{ text,
  source, painPoint, suggestion }] }] }] }`. Still deterministic, no LLM.
- `journey.smoke.sh` suggestion assertions updated for the layered shape +
  pain/suggestion presence (**38**). Full harness **8/8 · 199**.

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
