# Cailyx — Production Readiness

> **Purpose:** the single checklist for taking Cailyx from "dev-complete on one
> laptop" to "running for real users." Every secret, every integration, every
> piece of infrastructure, every hardening step.
>
> **Status legend:** ✅ done · ⚠️ works but needs prod config · ❌ not wired ·
> 🔑 needs a secret/account
>
> **Last updated:** 2026-08-31 · Keep this current — see `CHANGELOG.md`.

---

## 0. Where we are today

| Layer | State |
|---|---|
| Backend (NestJS) | ✅ All PRD/PLAN modules + the swarm layer + dashboard aggregation + user admin are built and e2e-verified (`backend/smoke/` — 8 scripts, 193 assertions, deterministic/zero-key). `tsc` clean, `nest build` green. |
| Frontend (Next.js — the Cailyx console) | ✅ Dark operator console: movable/resizable panes, agents feed, connections + user-management modals. `next build` green. |
| Database | ⚠️ **SQLite** (`backend/prisma/dev.db`). Fine for dev; **must move to PostgreSQL for prod** (§4). |
| External integrations | ⚠️/❌ All gated behind env keys with honest `503`s. Nothing live is wired to a real account yet (§2, §3). |
| Deployment | ❌ No Dockerfiles, no CI, no hosting. (§6) |
| Security hardening | ⚠️ JWT + rate-limit + validation in place; secrets/CORS/Swagger/HTTPS need prod config (§5). |

**Nothing is a stub in the "fake data" sense** — every external path is real
code that returns `503` until its key/account is provided. This doc is the list
of those keys/accounts plus the infra and hardening around them.

---

## 1. TL;DR pre-launch checklist

Minimum to run a real engagement in production:

- [ ] 🔑 `JWT_SECRET` — 64+ random chars, from a secrets manager (§5.1)
- [ ] 🔑 `ANTHROPIC_API_KEY` — the moat; measurement + all LLM paths (§2)
- [ ] 🔑 `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` — SERP + authority discovery (§2)
- [ ] 🔑 `PSI_API_KEY` — Core Web Vitals in the technical audit (§2)
- [ ] ⚙️ `SWARM_ALLOW_LIVE=1` — only once budgets + monitoring are in place (§8)
- [ ] 🗄️ PostgreSQL provisioned; schema `provider` switched; migration run (§4)
- [ ] 🗄️ Managed Redis provisioned; `REDIS_URL` set (§4.2)
- [ ] 🌐 `CORS_ORIGIN` = the real frontend URL; `NEXT_PUBLIC_API_URL` = the real API URL (§5.3)
- [ ] 🎭 `npx playwright install chromium` in the backend build/image (§4.3)
- [ ] 🔒 Swagger disabled or auth-gated in prod (§5.4)
- [ ] 🔒 `helmet` + `compression` added to `main.ts` (§5.5)
- [ ] 📦 Backend + frontend Dockerfiles; CI running `tsc` + `nest build` + `next build` + smoke (§6)
- [ ] 👁️ Error tracking (Sentry) + structured logs + cost dashboard (§7)
- [ ] 💾 Postgres automated backups + a tested restore (§4.1)
- [ ] 🧪 First operator account created; `MEASUREMENT_ALLOW_MOCK` / `*_ALLOW_FIXTURE` **unset** (§5.6)

Optional / later: `PERPLEXITY_API_KEY`, Google OAuth for GA/GSC, Stripe, Plunk (§3).

---

## 2. Secrets & API keys — REQUIRED for a real engagement

| Env var | Powers | Where to get it | Cost | Without it |
|---|---|---|---|---|
| `JWT_SECRET` | Signs operator access tokens | Generate: `openssl rand -base64 48` | free | Auth is insecure (default placeholder string). |
| `ANTHROPIC_API_KEY` | **Measurement moat** (Claude answer surface), findings copy, and every `useLlm` path (persona refine, journey/council/authority LLM modes), entity model-diff | console.anthropic.com | usage — Opus ≈ $5/$25 per MTok; governed per-run | Measurement + all LLM features `503`. Deterministic paths still work. |
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | SERP Intelligence (`serp-intelligence`), Authority discovery via SERP listicles (`authority`) | dataforseo.com → dashboard | ~$0.002–0.02 per keyword (live/advanced) | SERP capture + SERP-based authority discovery `503`. Citation-based authority still works. |
| `PSI_API_KEY` | Core Web Vitals in the technical audit | console.cloud.google.com → enable "PageSpeed Insights API" → create API key | free (25k/day) | CWV check returns a `LOW` "unconfigured" finding; audit still runs the other 4 checks. |
| `SWARM_ALLOW_LIVE` | Master switch. `=1` lets journeys/campaigns/SERP capture spend real money on live surfaces. Anything else = deterministic adapters only. | you set it | — | Swarm runs on `mock`/`fixture` only — safe, no spend, no live data. |

> **Order of operations:** provision the keys, verify each shows **connected**
> in the console's Connections panel (`GET /api/integrations`), *then* flip
> `SWARM_ALLOW_LIVE=1`.

---

## 3. Secrets & API keys — OPTIONAL (features degrade gracefully without them)

| Env var(s) | Powers | Get it | Without it |
|---|---|---|---|
| `PERPLEXITY_API_KEY` | Perplexity (`sonar`) as a second answer surface in `measurement` / journeys | perplexity.ai/settings/api | Perplexity surface unavailable; Claude surface still works. |
| **Google OAuth** (client id/secret/redirect) for **Google Analytics** + **Search Console** | The two "Connect" cards in the console's Analytics pane; would feed real traffic/impression data into `sleeper-refresh` and the dashboard | console.cloud.google.com → OAuth consent screen + credentials; enable GA4 Data API + Search Console API | **❌ OAuth flow is not built.** Today GSC data is imported by pasting a CSV export into `sleeper-refresh`. GA has no fallback. See §3.1. |
| `STRIPE_CHECKOUT_URL_FULL`, `STRIPE_CHECKOUT_URL_MONITORING` | Upgrade checkout links in the `delivery` module + the console's "Hire" banner | dashboard.stripe.com → Payment Links | `delivery/upgrades` returns `payment-unconfigured` 503. No billing. |
| `PLUNK_API_KEY` | Transactional email — report delivery + testimonial asks (`delivery`) | useplunk.com | `delivery/send` returns `email-unconfigured` 503. Reports are still viewable by link. |
| `SCORECARD_PUBLIC=1` | Exposes the public Rung-0 scorecard route (`GET /scorecard/public/:token`, `@Public`) | you set it | Public scorecard link `404`s; operator-only scorecard still works. |
| `REPORT_BRAND_NAME`, `REPORT_BRAND_TAGLINE` | White-labels the generated report | you set it | Falls back to "Cailyx" branding. |
| `AEO_ALLOW_BROWSER_SURFACE=1` + `AEO_CHATGPT_SESSION_PATH` / `AEO_PERPLEXITY_SESSION_PATH` / `AEO_GEMINI_SESSION_PATH` | The three answer engines `aeo-audit` measures — the consumer ChatGPT, Perplexity and Gemini products | You supply them: sign in to each manually once, save the Playwright `storageState`. **⚠️ See §5.9 before enabling.** | Each engine without a session fails closed (`surface-disabled` / `no-session`) and is reported as "not measured". Other engines still run; context + matrix generation are unaffected. |
| `OPENROUTER_API_KEY` (+ optional `AEO_LLM_MODEL`) | **All three `aeo-audit` analysis passes** — context synthesis (services/ICP/pains/outcomes), natural prompt phrasing, and competitive stance judging | openrouter.ai → Keys. Lives in `backend/.env`. Default model `deepseek/deepseek-v4.1-flash` — see `docs/analysis/aeo-audit.md` §11.2 before changing it | Falls back to `ANTHROPIC_API_KEY`; with neither, context falls back to deterministic extraction, the matrix keeps template phrasing, and the stance pass returns 503. **Counted metrics are unaffected** — rates never depended on an LLM. Measured cost: ~$0.02 per 500-observation audit. |
| `AEO_STANCE_JUDGE_MODEL` (uses `ANTHROPIC_API_KEY`) | The Anthropic **fallback** path for the same three passes, used only when `OPENROUTER_API_KEY` is absent | Already have the key | See above — the OpenRouter path is preferred and much cheaper. |

### 3.1 What "wire up Google Analytics / Search Console" actually means

The console shows **Connect** buttons and the backend reports them
`not-connected`. Making them real requires **new work**, not just a key:

1. Register an OAuth app in Google Cloud (consent screen, scopes:
   `analytics.readonly`, `webmasters.readonly`).
2. Build the 3-legged OAuth flow in the backend (`/api/integrations/google/connect`
   → Google → callback → store refresh token per project/org).
3. Add a `GoogleTokens` model + encrypted-at-rest storage for the refresh tokens.
4. Add GA4 Data API + Search Console API clients (through `FetcherService`).
5. Feed the data into `sleeper-refresh` (replacing the CSV paste) and into the
   Analytics pane's GEO/Links tabs.

**Estimate:** ~1 module's worth of work (analysis doc → build → smoke), per
`AGENTS.md`. Until then the CSV-paste path in `sleeper-refresh` is the supported
way to get GSC data in.

---

## 4. Infrastructure

### 4.1 Database — SQLite → PostgreSQL (**required for prod**)

Current: `backend/prisma/schema.prisma` has `provider = "sqlite"`, `url = "file:./dev.db"`.
SQLite has no concurrent writers, no network access, no managed backups — unfit
for a multi-user server.

**Migration steps:**

1. Provision managed Postgres (Neon, Supabase, RDS, Railway, Fly Postgres…).
2. In `schema.prisma`: `provider = "postgresql"`, `url = env("DATABASE_URL")`.
3. Set `DATABASE_URL` to the managed connection string (with `?sslmode=require`).
4. **JSON columns:** the schema currently stores arrays/objects as `String`
   (SQLite has no JSON type) — e.g. `Persona.painPoints`, `Journey`/`JourneyStep`
   JSON fields, `topDomains`, `competitorsSeen`, `evidenceRefs`, etc. These keep
   working on Postgres as `text`. Optionally migrate the hottest ones to `Json`
   later for indexability — **not required to ship**, and it's a breaking schema
   change, so do it deliberately.
5. Replace `prisma db push` with real migrations: `npx prisma migrate dev`
   locally to generate `prisma/migrations/`, commit them, run
   `npx prisma migrate deploy` in the release pipeline.
   > **2026-09-20 finding:** this is currently blocked, not just pending. The
   > datasource in `schema.prisma`/`schema.production.prisma` was switched to
   > `postgresql` on 2026-09-16, but `prisma/migrations/migration_lock.toml`
   > still says `provider = "sqlite"` and the existing migration `.sql` files
   > are SQLite-dialect (`DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`, etc.).
   > `npx prisma migrate dev` fails immediately with **P3019** ("provider
   > mismatch"). Every schema change since the cutover (including this stage's
   > C1 work — `docs/analysis/client-portal.md` §§15/16/33) has had to use
   > `prisma db push` instead, which works but keeps no migration history.
   > Fixing this for real means regenerating the migration history against
   > Postgres (likely `prisma migrate diff`/reset against a scratch DB, or
   > deleting `prisma/migrations/` and re-baselining) — a deliberate,
   > reviewed action, not a side effect of an unrelated schema change, so it
   > was left for whoever does the real §4 migration-run item.
6. Backups: enable automated daily snapshots + PITR on the managed instance.
   **Test a restore before launch.**

> `better-sqlite3`, `@prisma/adapter-better-sqlite3`, `@prisma/adapter-pg` are in
> `package.json` but unused by the code (standard Prisma client). They can be
> dropped; `better-sqlite3` needs a C++ toolchain to build on Windows (why dev
> installs used `--ignore-scripts`).

### 4.2 Redis — required (managed instance)

Used by `scheduling` (BullMQ) for recurring audits/monitoring and by
`fetcher` rate-limiting/caching.

- Provision managed Redis (Upstash, Redis Cloud, ElastiCache, Railway…).
- Set `REDIS_URL` (with TLS: `rediss://…`).
- Without it: swarm campaign queueing is offline; the Connections panel shows
  Redis `not-connected`; the app still boots (the `scheduling` service logs
  connection errors but doesn't crash — and now closes its worker +
  connections cleanly on shutdown).
- **Scheduled re-runs specifically do NOT need Redis under the default
  `SCHEDULING_BACKEND=cron`** (unset defaults to `cron`, not `bullmq`):
  `technical-audit`, `seo-audit`, and (C7, 2026-09-21) `refresh-cadence` all
  run their own in-process `@nestjs/schedule` hourly poll against
  `ScheduleConfig` instead, specifically so a scheduling feature doesn't
  silently go dark whenever Redis is down (see
  `technical-audit/audit-scheduler.service.ts`'s own doc comment). `monitoring`
  is the one exception — its cadence handler is only registered against
  `SchedulingService`'s BullMQ path, so it genuinely needs
  `SCHEDULING_BACKEND=bullmq` + Redis to actually fire on cadence (see
  `monitoring/README.md`'s "Known limitation").

### 4.3 Playwright browser — required for the full technical audit

The `js-render` audit check launches headless Chromium.

- Add to the backend build / Docker image: `npx playwright install --with-deps chromium`.
- Without it: `js-render` returns a `LOW` "Executable doesn't exist" finding
  (seen in dev). The other 4 audit checks still run.

### 4.4 Node / build

- Pin Node in `package.json` `engines` (dev used Node 24; CI/image should match).
- `backend/package.json` has `"postinstall": "prisma skills sync || exit 0"` —
  harmless (`|| exit 0`) but noisy; consider replacing with `prisma generate`.
- Frontend: multiple lockfiles warning — set `turbopack.root` in `next.config.ts`
  or remove the stray root `package-lock.json`.

---

## 5. Security hardening

### 5.1 Secrets management
- **Never** commit real secrets. `.env` is gitignored; keep it that way.
- Use the platform's secret store (Fly secrets, Railway variables, AWS Secrets
  Manager, Doppler, 1Password Connect…). Inject at runtime, not baked into images.
- Rotate `JWT_SECRET` on a schedule (rotating it invalidates all sessions — expected).
- The `users` module already: hashes with bcrypt (cost 10), stores only SHA-256
  of refresh tokens, revokes sessions on password reset, never returns hashes.

### 5.2 Bootstrap the first admin safely
`POST /api/auth/register` — the **first** account becomes `admin`; afterwards it's
admin-gated. Register the real admin immediately after first deploy, then create
the rest via the console's **User Management** modal.

### 5.3 CORS
`main.ts` reads `CORS_ORIGIN` (default `http://localhost:3000`). Set it to the
exact prod frontend origin (comma-splitting isn't implemented — add it if you
need multiple). Set `NEXT_PUBLIC_API_URL` (frontend) to the real API URL.

### 5.4 Swagger / API docs
`SwaggerModule.setup('api/docs', …)` runs unconditionally. In prod either:
- guard it behind basic auth / an admin check, or
- `if (process.env.NODE_ENV !== 'production') { SwaggerModule.setup(...) }`.

### 5.5 Missing middleware (add to `main.ts`)
- `helmet()` — security headers (not installed).
- `compression()` — gzip responses (not installed).
- Consider `app.set('trust proxy', 1)` behind a load balancer so rate-limiting
  sees real client IPs.
- Body size limit (`express.json({ limit: '1mb' })`) — DTOs are bounded but set a
  hard cap.

### 5.6 Turn OFF test escape hatches in prod
These must be **unset** in the prod environment:
- `MEASUREMENT_ALLOW_MOCK` — deterministic fake answer surface
- `INTERNAL_LINK_ALLOW_FIXTURE` — offline canned crawl site
- `SERP_ALLOW_FIXTURE` — offline canned SERPs

### 5.7 Rate limiting
Global `ThrottlerModule`: 100 req / 60s / IP, plus per-route `@Throttle`
overrides. Review the numbers against expected operator concurrency; the
in-memory store is per-instance — for multiple backend instances, back the
throttler with Redis (`@nest-lab/throttler-storage-redis`).

### 5.8 Transport
Terminate TLS at the load balancer / platform. Force HTTPS. HSTS via `helmet`.

---

### 5.9 ⚠️ The browser answer-engine surfaces — decide before enabling in prod

`aeo-audit` measures the **consumer ChatGPT, Perplexity and Gemini products** by
driving them in Playwright with sessions the operator supplies (decision D1-B,
`docs/analysis/aeo-audit.md`). Before turning this on in production:

- **Automating these products is against their Terms of Use** — OpenAI,
  Perplexity and Google alike. The risk — account suspension, IP blocks — sits
  with whoever supplies the session. Point them only at accounts you control and
  have accepted that risk for. **Never a client's account.**
- **They are fragile by design.** Each breaks whenever its vendor changes the UI.
  Budget for the selectors in `SURFACE_PROFILES` (`browser-surface.adapter.ts`)
  needing maintenance. An engine that drifts reports `selector-drift` and names
  the constant to update; re-run with `AEO_BROWSER_HEADLESS=0` to see the page.
- **None of them has been run against a live session yet.** The Perplexity and
  Gemini selectors especially are unconfirmed. Do a `scorecard`-tier run, one
  engine at a time, with `AEO_BROWSER_HEADLESS=0`, before trusting a full run.
- The adapters contain **no CAPTCHA solving, no stealth/anti-detection layer, and
  no credential handling** — by design. On a challenge, block or rate limit they
  fail the observation with a typed reason and stop. Do not add bypass machinery.
- Keep each `*_MIN_GAP_MS` at 8s or higher. It is politeness, and it is also what
  keeps a long run from looking like an attack.
- **Budget wall clock, not just money.** Calls = `prompts × runCount × engines`.
  Three engines at the `standard` tier is 1,500 questions — several hours at an
  8s gap. The workspace shows this estimate before a run starts.

**One engine failing does not void the audit** — each is measured independently,
and the report names the engines that produced nothing rather than silently
averaging over a gap.

**The ToS-clean alternative** is an API adapter per vendor (decision D1-A), which
slots in behind the same `SurfaceAdapter` interface without touching the
orchestrator. If these surfaces become a liability, that is the swap.

### 5.10 Digital presence discovery — outbound fetches, and what it deliberately does not do

`digital-presence` reads the **client's own site** and then makes at most one
request per discovered profile URL. It needs no keys and no env vars, but it does
reach out, so:

- **Walled platforms are never fetched.** Instagram, Facebook, LinkedIn, X, TikTok
  and Threads serve a login wall or refuse datacentre IPs, so the module records
  `unverified` with the reason **without making the request**. Spending a request
  to be told "log in" produces the same answer more slowly while looking like a
  scraping attempt. Do not "fix" this by adding sessions or proxies — the value of
  the row is the URL, not the fetch.
- **`unverified` is not a defect.** Anyone reading these rows — or building a
  client report from them — must keep it distinct from `missing`. Collapsing the
  two reports a working account as an absent one. See the module README.
- **Verification results are cached 24h** by the fetcher (`verifyUrl`), so a
  re-scan is cheap and does not hammer the listing sites that *are* fetchable.
- The classifier's reject patterns (`presence.signatures.ts`) are what stop a
  share button being reported as a client's account. If a platform changes its
  URL shapes, the failure mode is a **missing** account, not a wrong one — which
  is the correct direction to fail in.
- **The Google sweep is the one billed path** (DataForSEO, the same funded
  account as `serp-intelligence` and `keyword-research`, one query per platform
  still missing). It is **opt-in per run** — `POST /discover` with
  `{"searchWeb": true}` — precisely so a default scan, a scheduled job, or the
  smoke harness can never bill by accident, and it is additionally gated behind
  `SWARM_ALLOW_LIVE=1`. `PRESENCE_SERP_MAX_QUERIES` (default 5) caps any single
  run; responses cache seven days, and a cache hit is not counted as spend. The
  real charge is recorded per run as `serpCostUsd`, read off DataForSEO's
  response envelope — never estimated. Credits are prepaid and finite: watch the
  balance if you wire the sweep into anything automatic.
- **Never auto-promote a `candidate`.** Search cannot tell a client's profile
  from a similarly named stranger's, and the name-similarity score is an ordering
  hint with no code branching on it. A confirmation step that some future caller
  "helpfully" skips would put another company's account in a client's report.

## 6. Build, package, deploy

Nothing exists yet. Needed:

### 6.1 Backend Dockerfile (sketch)
```
FROM node:22-slim AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npx prisma generate && npm run build

FROM node:22-slim
RUN npx -y playwright@1.62 install --with-deps chromium
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
ENV NODE_ENV=production
CMD ["sh","-c","npx prisma migrate deploy && node dist/main"]
```

### 6.2 Frontend
`next build` → deploy to Vercel/Netlify/Node. Set `NEXT_PUBLIC_API_URL` at build
time. If self-hosting: `next start` behind the same TLS/CDN.

### 6.3 CI (`.github/workflows/ci.yml`)
On PR + main:
- backend: `npm ci` · `npx prisma generate` · `npx tsc --noEmit` · `npm run build` · `npm run lint`
- frontend: `npm ci` · `npx tsc --noEmit` · `npm run build`
- optional: spin Postgres + Redis services, run `backend/smoke/run-all.sh`
  against a built backend (all deterministic, no keys needed).

### 6.4 Release
- `npx prisma migrate deploy` as a pre-start step (idempotent).
- Health check: `GET /api/health` (already exists) for the platform's probe.
- Add a **readiness** check that also pings Postgres + Redis before serving.
- Zero-downtime: run migrations that are backward-compatible with the previous
  release.

---

## 7. Observability & cost control

| Concern | Today | Prod need |
|---|---|---|
| Logs | NestJS `Logger` → stdout | Ship to a log aggregator; JSON format; request ids. |
| Errors | thrown → 500 | Sentry (or similar) on backend + frontend. |
| Metrics | none | Request rate/latency, queue depth, LLM/SERP spend per day per project. |
| **Cost** | per-run / per-campaign USD governors exist (`*_MAX_COST_*`, `budgetUsd`) | A dashboard summing `FetchLog.cost` + observation `costUsd` + journey/campaign spend. Alert on daily spend threshold. Consider a global monthly ceiling env. |
| Uptime | none | External uptime check on `/api/health` + the frontend. |
| Audit trail | `Logger.log` lines for user CRUD, runs | Persist an events table if compliance needs it. |

---

## 8. The swarm boundary (operational policy)

The swarm layer is **research/measurement only** — it must never impersonate a
real human to generate artificial Google/AI traffic, clicks, impressions, or
rankings. Enforced in code (`docs/analysis/swarm-layer.md`):

- `SWARM_ALLOW_LIVE` gates every live AI-surface / paid-SERP call.
- SERP data comes from the **licensed** DataForSEO feed — no headless-browser
  scraping of Google, no user-simulated queries.
- `authority` discovers targets and creates human to-dos — **no automated
  outreach, posting, or account creation.**
- `internal-link` only crawls the **client's own** domain, rate-limited via
  `FetcherService`.

Before enabling live mode: confirm the DataForSEO ToS covers your use, set
per-campaign `budgetUsd` conservatively, and keep the cost dashboard (§7) in view.

---

## 9. Full environment variable reference

### Backend (`backend/.env`) — prod values

| Var | Dev | Prod | Notes |
|---|---|---|---|
| `PORT` | 3002 | platform-assigned | |
| `NODE_ENV` | — | `production` | gates Swagger (§5.4) once you add the check |
| `CORS_ORIGIN` | `http://localhost:3000` | real frontend URL | |
| `DATABASE_URL` | `file:./dev.db` (implicit) | Postgres URL + `sslmode=require` | §4.1 |
| `REDIS_URL` | `redis://localhost:6380` | `rediss://…` managed | §4.2 |
| `JWT_SECRET` | placeholder | 64+ random chars | §5.1 |
| `JWT_ACCESS_TTL` | `15m` | `15m` | |
| `JWT_REFRESH_TTL_DAYS` | `30` | `7`–`30` | |
| `ANTHROPIC_API_KEY` | unset | 🔑 set | §2 |
| `PERPLEXITY_API_KEY` | unset | optional | §3 |
| `PSI_API_KEY` | unset | 🔑 set | §2 |
| `DATAFORSEO_LOGIN` / `_PASSWORD` | unset | 🔑 set | §2 |
| `SWARM_ALLOW_LIVE` | `0` | `1` **after** budgets+monitoring | §2, §8 |
| `MEASUREMENT_ALLOW_MOCK` | `1` (dev/smoke) | **unset** | §5.6 |
| `INTERNAL_LINK_ALLOW_FIXTURE` | `1` (smoke) | **unset** | §5.6 |
| `SERP_ALLOW_FIXTURE` | `1` (smoke) | **unset** | §5.6 |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | set (dev) | set — shared by serp-intelligence, keyword-research and the presence sweep | §5.10 |
| `MEASUREMENT_MAX_COST_PER_RUN` | `5.00` | tune | cost governor |
| `JOURNEY_MAX_COST_PER_RUN` | `2.00` | tune | |
| `SERP_MAX_COST_PER_CAPTURE` | `5.00` | tune | |
| `PERSONA_MAX_COST_PER_GENERATE` | `1.00` | tune | |
| `COUNCIL_MAX_COST_PER_RUN` | `1.00` | tune | |
| `AUTHORITY_MAX_COST_PER_SCAN` | `1.50` | tune | |
| `PERSONA_MAX_PER_PROJECT` | `100` | tune | fan-out cap |
| `INTERNAL_LINK_MAX_PAGES` | `50` | tune | crawl cap |
| `*_LLM_MODEL` (persona/journey/council/authority/measurement/findings) | `claude-opus-5` | pick model | see `docs/MODELS.md` |
| `TA_*` thresholds, `FETCHER_*` | defaults | keep or tune | |
| `STRIPE_CHECKOUT_URL_FULL` / `_MONITORING` | unset | optional | §3 |
| `PLUNK_API_KEY` | unset | optional | §3 |
| `SCORECARD_PUBLIC` | unset | `1` if using public scorecards | §3 |
| `REPORT_BRAND_NAME` / `_TAGLINE` | unset | optional white-label | §3 |
| `STRIPE_WEBHOOK_SECRET` | unset | 🔑 **required** to accept real Stripe billing events (webhook is `503` without it — nothing is trusted or stored) | `billing` module; also gap-flagged in `backend/src/modules/billing/README.md` (`.env.example` needed updating even before C5) |
| `BILLING_GRACE_PERIOD_DAYS` | unset (defaults 21) | tune, or leave default | C5/§30 — days a subscription may sit `past-due` before the hourly sweep auto-suspends its client (revokes Google tokens too, §23) |
| `BILLING_GRACE_PERIOD_SWEEP_ENABLED` | unset (defaults true) | set `false` on any non-primary backend instance to avoid double-suspending | C5/§30 — same "one dispatcher" caution as `PUBLISHING_SCHEDULER_ENABLED` below |

### Frontend (`frontend/.env`)

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | real backend URL (e.g. `https://api.cailyx.com`) | baked at build time; the committed example still says `:3001` — dev uses `:3002` |

---

## 10. Open product decisions (carried from `docs/MODULES-STATUS.md` §5)

These affect prod but are product calls, not blockers:

| # | Decision |
|---|---|
| 2 | Measurement surfaces for v1 — Claude + Perplexity only, or add a ChatGPT proxy? Proxy/geo-egress vendor for multi-geo (`FR-6.3`). |
| 3 | Headless exact-surface capture now vs. defer. |
| 4 | Model providers + judge model for entity model-diff; per-model cost table. |
| 7 | CRM — internal `Lead` table vs. Attio/HubSpot; email — Plunk vs. Postmark/Resend. |
| 8 | Deployment target (Vercel + Railway/Render/Fly assumed, unconfirmed). |
| 9 | Product name — PRD still says "Beacon"; code + UI say **Cailyx**. Confirm. |
| 10 | White-label branding in the data model now or later. |
| new | Build the Google Analytics / Search Console OAuth flow (§3.1). |
| new | Redis-backed throttler storage for multi-instance backends (§5.7). |

---

## 11. Quick "is it production-safe right now?" answer

**Not yet — by design.** In its current state Cailyx:
- has an insecure default `JWT_SECRET`,
- stores data in a single-file SQLite DB,
- exposes Swagger openly,
- has test escape-hatch flags available,
- has no deployment artifacts or CI.

All of that is intentional dev posture. Work §1's checklist top-to-bottom and it
becomes deployable. Nothing in the checklist is a rewrite — it's configuration,
one OAuth module (GA/GSC), and standard ops plumbing.
