# Cailyx — Architecture & Build Plan

> **Status:** Draft for review and decision
> **Date:** 2026-08-27
> **Source documents:** Rothenhall-Operating-Manual.pdf, GTM-Role-AEO-SEO-Playbook.pdf

---

## 1. What Cailyx Is

Cailyx is a **modular AEO/SEO analysis platform** — a suite of connected API tools that operationalize the Rothenhall Partners methodology. The system takes the manual, human-driven workflows described in the Operating Manual and the GTM Playbook and turns them into repeatable, measurable, automated software.

The major goal: **build the tooling that Rothenhall uses to run AEO/SEO engagements for clients and in-house ventures.** Every SOP in the Operating Manual maps to a Cailyx module. Every measurement standard becomes a software feature. Every report becomes a generated artifact.

---

## 2. The Core Workflow (what the tools must do)

From the documents, the end-to-end workflow of an AEO/SEO engagement is:

```
1. Build Query Set (SOP-1)
   → 100-300 conversational prompts, tagged persona/stage/cluster
   → Sourced from sales calls, support tickets, keyword tools, fan-out observation
   → Version-stamped, never edited in place

2. Baseline Measurement Run (SOP-2)
   → Run each prompt n≥5 times per surface (AI Overviews, AI Mode, ChatGPT, Perplexity)
   → Across ≥2 geographies, fresh sessions
   → Record: mentioned, cited w/ link, cited URL, position, characterization, competitors, metadata

3. Technical Access Audit (SOP-3)
   → robots.txt check for AI bot blocks (GPTBot, OAI-SearchBot, PerplexityBot, etc.)
   → CDN layer check (Cloudflare AI-bot feature silently blocks)
   → JS render test (ChatGPT crawler doesn't execute JS)
   → Core Web Vitals (LCP <2.5s, INP <200ms, CLS <0.1)
   → Hallucinated 404 sweep

4. Entity Consistency Audit (SOP-4)
   → List all entities (brand, products, founders, proprietary metrics)
   → Ask 5 models "what is [entity]?", diff the answers
   → Audit name/descriptor consistency across LinkedIn, G2, Crunchbase, etc.
   → Check Organization/Person schema + sameAs

5. Brand Gap Analysis (SOP-5)
   → Classify every finding into 6 dimensions: visibility, narrative, topic, format, web mentions, demand
   → Prioritize: fix / build / influence

6. Page Restructure (SOP-6)
   → BLUF (answer-first, 40-60 words), question-shaped headings, atomic sections
   → Extractable claims, comparison tables, no cross-section pronoun dependencies
   → Standalone test on every H2

7. Off-site Mention Campaign (SOP-7)
   → Find listicles/comparisons omitting the client
   → Community presence (Reddit, Quora), review generation
   → Monthly mention audit (decay tracking)

8. Original Data Asset (SOP-8)
   → Survey or internal data → publish with visible methodology
   → Named after the client brand

9. Sleeper Page Refresh (SOP-10)
   → Identify declining pages with intact backlink profiles
   → Apply SOP-6, update content, meaningfully update dateModified

10. Monthly Report (SOP-11)
    → Citation rate by cluster/surface vs baseline
    → Mention rate, share of voice, characterization quality
    → Branded search trend, self-reported attribution, crawler activity
    → If a number went down, it goes in the headline
```

---

## 3. Module Architecture

Each module is a self-contained NestJS module (backend) + React feature (frontend), connected via API. Modules can be used independently or as a connected pipeline.

### 3.1 Backend Modules

| Module | Maps to SOP | Purpose | Priority |
|--------|------------|---------|----------|
| `query-set` | SOP-1 | Build, version, tag, and manage prompt sets | P0 — Foundation |
| `measurement` | SOP-2 | Run measurement runs (n≥5, multi-geo, multi-surface), record results | P0 — Core |
| `technical-audit` | SOP-3 | robots.txt, CDN, JS render, Core Web Vitals, 404 sweep | P1 |
| `entity-audit` | SOP-4 | Entity listing, model-diff, consistency check across platforms | P1 |
| `gap-analysis` | SOP-5 | 6-dimension gap classification, fix/build/influence prioritization | P1 |
| `page-analysis` | SOP-6 | Page structure analysis (BLUF check, standalone test, extractability score) | P2 |
| `mention-tracking` | SOP-7 | Off-site mention monitoring, listicle tracking, community presence | P2 |
| `data-asset` | SOP-8 | Survey/data asset management and publication tracking | P3 |
| `sleeper-refresh` | SOP-10 | Identify declining pages, track refresh status | P2 |
| `reporting` | SOP-11 | Auto-generate monthly reports from measurement + audit data | P1 |
| `pipeline-math` | GTM Playbook | Revenue target → ACV → win rate → visitors needed. The qualification arithmetic. | P1 |
| `scorecard` | Rung 0 | Free automated diagnostic — the lead-gen tool | P1 |
| `crawler-monitor` | SOP-3/4.5 | Server log analysis of AI crawler hits by URL | P2 |
| `claims` | Part 7 | Claims discipline — stat grading (A/B/C), banned phrasing checker | P2 |
| `auth` | — | Authentication, user management, role-based access | P0 |
| `projects` | — | Client/venture project management, engagement lifecycle | P0 |
| `config` | — | Global configuration, API keys for external tools | P0 |

### 3.2 Frontend Feature Areas

Each maps to a backend module and has its own route/page set:

- `/dashboard` — Overview of all projects and active engagements
- `/projects/:id/query-set` — Query set builder and manager
- `/projects/:id/measurement` — Measurement run execution and results
- `/projects/:id/technical-audit` — Technical audit results and recommendations
- `/projects/:id/entity-audit` — Entity consistency audit
- `/projects/:id/gap-analysis` — Gap analysis board (6 dimensions, prioritized)
- `/projects/:id/pages` — Page analysis and restructure tracking
- `/projects/:id/mentions` — Off-site mention tracking
- `/projects/:id/reports` — Monthly report generation and history
- `/scorecard` — Free scorecard tool (public-facing, lead-gen)
- `/pipeline-math` — Pipeline qualification calculator
- `/settings` — API keys, integrations, team management

### 3.3 External Integrations (connected API tools)

These are external services Cailyx connects to. Each is an adapter module:

| Integration | Purpose | Priority |
|------------|---------|----------|
| Google Search Console | Index health, query data, coverage reports | P1 |
| Ahrefs API | Backlink data, referring domains, keyword difficulty, SERP analysis | P1 |
| PageSpeed Insights API | Core Web Vitals, LCP/INP/CLS | P1 |
| AI Surface APIs (where available) | ChatGPT, Perplexity, Google AI Overviews programmatic access | P2 |
| Web scraping (headless browser) | SERP capture, AI answer capture, JS render testing | P0 |
| Server log ingestion | AI crawler activity by URL | P2 |
| G2/Capterra/Crunchbase | Entity consistency data sources | P3 |

---

## 4. Data Model (core entities)

```
Project (client or venture)
  ├── QuerySet (versioned)
  │     └── Prompt (persona, stage, cluster, text)
  │           └── MeasurementRun (surface, geo, run#, date)
  │                 └── RunResult (mentioned, cited, url, position, characterization, competitors)
  ├── TechnicalAudit
  │     └── AuditFinding (type: robots|cdn|js-render|cwv|404, status, detail)
  ├── EntityAudit
  │     └── Entity (name, descriptor, schema, platforms[])
  │           └── ModelDiff (model, answer, divergence)
  ├── GapAnalysis
  │     └── Gap (dimension, action: fix|build|influence, priority, effort)
  ├── PageAnalysis
  │     └── Page (url, structure_score, standalone_test[], extractable_claims[])
  ├── MentionCampaign
  │     └── MentionTarget (url, type: listicle|community|review, status)
  ├── Report (monthly, generated from all above)
  └── PipelineMath (revenue_target, acv, win_rate, conversion_rates, verdict)
```

---

## 5. Build Phases

### Phase 0: Foundation (Weeks 1-2)
**Goal:** Get the base infrastructure working so all modules can be built on top.

- [x] Database selection and setup — **PostgreSQL 17** (`cailyx-postgres:5436`) via Docker (`docker-compose.yml`) + `Prisma @prisma/client@5.22`, `DATABASE_URL` in `.env`/`env.example`
- [x] ORM setup — **Prisma** with `schema.prisma` (10 models: `TechnicalAudit`, `AuditFinding`, `PageMetadata`, `ScheduleConfig`, `FetchLog`, `EntityAudit`, `Entity`, `SchemaCheck`, `PlatformRecord`, `ModelDiff`, `GapAnalysis`, `Gap`) · `prisma db push` + `generate` OK, `PrismaService` plain `PrismaClient` (`backend/src/modules/database/prisma.service.ts:1`)
- [ ] Auth module (JWT-based, role-based: admin, delivery-lead, content, technical, outreach, sales) — **NEXT P0**
- [x] Projects module — ✅ Built 2026-08-30 (CRUD, engagement lifecycle, artifact stats; `docs/API.md` updated)
- [x] Config module — `@nestjs/config` global (`app.module.ts:22` `ConfigModule.forRoot`), `configuration.ts` + `TA_*` thresholds validated
- [x] API documentation baseline — Swagger at `/api/docs`, `@ApiTags/@ApiOperation/@ApiResponse/@ApiProperty` on all 3 built modules, `docs/API.md` (179 lines) covers `Health`, `Fetcher`, `Technical Audit` (5 endpoints), `Entity Audit` (14), `Gap Analysis` (5)
- [ ] Frontend dashboard shell (layout, navigation, project list, project detail page) — **deferred per one-module-at-a-time; backend is source of truth**
- [ ] CI/CD baseline (lint, type-check, build) — `npx tsc --noEmit 0` + `npx nest build 0` verified each module, `backend/.gitignore` + `frontend/` not yet lint-wired

### Phase 1: The Core Measurement Engine (Weeks 3-6)
**Goal:** The heart of the system — the thing nobody else does properly.

- [ ] `query-set` module — ✅ **Built 2026-08-30** (persona/version CRUD, draft→activate→fork immutability, client export; `backend/src/modules/query-set/`) — remaining below:
  - [x] Prompt CRUD with tagging (persona, funnel stage)
  - [x] Versioning (never edit in place — fork to next version)
  - [ ] Import from sales calls / support tickets (structured input)
  - [ ] Fan-out observation tooling (run prompts through AI surfaces, capture sub-queries)
  - [x] Export to client (JSON; CSV/Excel conversion at the UI layer)

- [ ] `measurement` module
  - Run orchestration: n≥5 per prompt per surface per geo
  - AI surface scrapers (headless browser — Playwright/Puppeteer):
    - Google AI Overviews
    - Google AI Mode
    - ChatGPT (with search)
    - Perplexity
  - Result recording: mentioned, cited w/ link, cited URL, position, characterization, competitors
  - Rate computation: citation rate, mention rate by cluster/surface
  - Share of voice calculation vs named competitors
  - Run comparison (this period vs baseline vs last period)
  - Dashboard: rates by cluster, surface, over time

- [ ] `reporting` module (MVP) — ✅ **Built 2026-08-30** (branded HTML executive+detail report, §8 weighted score + bands, Handlebars template, `backend/src/modules/reporting/`) — remaining below:
  - [ ] Generate SOP-11 format report from measurement data (current version renders from technical-audit/entity-audit/gap-analysis; measurement inputs pending)
  - Citation rate by cluster/surface, mention rate, share of voice
  - Characterization quality, inaccuracy flags
  - "If it went down, it goes in the headline" logic
  - PDF/export generation

### Phase 2: Audits & Analysis (Weeks 7-10)
**Goal:** The diagnostic capabilities that feed the roadmap.

- [x] `technical-audit` module — ✅ **Built end-to-end** `backend/src/modules/technical-audit/` (`technical-audit.service.ts:1` 5 checks) · `POST /run` (3/60s, 5 checks + `observability`+`PageMetadata`, `npx prisma db push` OK) · `GET /`, `GET /:auditId` from DB (owner-checked) · `PUT/GET /schedule` via `SchedulingModule` (BullMQ+Redis `6380` + `ScheduleConfig`) · `Analysis: docs/analysis/technical-audit.md` · `API: backend/src/modules/technical-audit/API.md` + `docs/API.md:112`
  - robots.txt fetch+parse (custom parser, `User-agent` groups, `Allow` override, `*` expansion)
  - CDN layer detection (header-sniff + 20+ bot probes ×3 `fetcher.probe`, `layer:cdn-waf` `inferred`, `isBlockedStatus`)
  - JS render test (`playwright` on/off diff, `ConfigService` thresholds `70%`/`30%`)
  - Core Web Vitals (`fetcher.callPsiApi` via `PsiAdapter`, cached 24h, `PSI_API_KEY`)
  - Hallucinated 404 sweep — **deferred** (needs `crawler-monitor` logs) — placeholder `type: 404-hallucinated` reserved
  - Audit findings with severity + `recommendedFix` + `reproductionCommands` (`curl -A UA`)

- [x] `entity-audit` module — ✅ **Built end-to-end** `backend/src/modules/entity-audit/` (`entity-audit.service.ts:1` + `@graph`/array `sameAs` + `fetcher.verifyUrl` ≤10) · `POST/GET/PATCH/DELETE /entities` (owner-checked, cascade, ordered), `POST .../schema-check/run` `5/60s` + `GET .../schema-checks?limit`, `POST .../platform-record` (`verifySource` single-fetch semi-auto `fetchedTitle` low ToS risk) + `PATCH/DELETE .../platform-records/:rid`, `GET .../platform-consistency`, `GET /` summary, `GET .../model-diffs` + `POST .../model-diff/run` `501` stub · `ModelDiff` table (schema ready, execution deferred per SPEC §3.1) + `Analysis: docs/analysis/entity-audit.md` · `API: backend/src/modules/entity-audit/API.md` + `docs/API.md:125`
  - Entity CRUD (brand/products/founders/metrics) — full CRUD verified + cross-project `404`
  - Model-diff — **schema built, execution deferred** (needs `OPENAI|ANTHROPIC|PERPLEXITY|GOOGLE_API_KEY`, no hard-coded 5 models, `Ollama llama3.2:1b` pulled but not wired) — `LEFT-OUT.md:1` + `ModelDiff` table + `GET .../model-diffs`
  - Platform consistency — manual + `verifySource` single-fetch (SPEC §3.3 ToS risk addressed; full crawl deferred)
  - Schema checker — `Organization|Person|LocalBusiness`, `@graph` flatten, `sameAs` `resolves`+`identityMatch` (title substring)

- [x] `gap-analysis` module — ✅ **Built end-to-end** `backend/src/modules/gap-analysis/` (`gap-analysis.service.ts:20` `CLASSIFICATION_RULES` 9 rules reviewable, `docs/analysis/gap-analysis.md`) · `GET /?dimension=&action=&status=`, `GET /gaps/:gapId`, `POST /sync` (idempotent + `pruned` orphan cleanup, `getOrCreateAnalysis` `P2002` race fix, `@Type` on `1-5` inputs), `PATCH /gaps/:gapId` (flip `*_autoAssigned` + `priorityScore = demand×credibility×citation`), `GET /roadmap` (`fix→build→influence` `priorityScore` desc nulls last) · `Prisma GapAnalysis`+`Gap` (`sourceType`,`sourceId` `@unique`) · `API: backend/src/modules/gap-analysis/API.md` + `docs/API.md:148`
  - 6-dimension classification (`visibility|narrative|topic|format|web-mentions|demand`) — `topic/format/...` empty until source modules exist, mapping extensible
  - Fix/build/influence assignment — mapping + override
  - Priority ranking — manual `1-5` (`demandPotential`/`credibilityImpact`/`citationLikelihood`) × computed
  - Roadmap generation — grouped by `action`

- [ ] `crawler-monitor` module **(NEXT Phase 2)**
  - Server log ingestion (AI crawler hits by URL)
  - Bot type classification (training vs search/citation)
  - Crawler activity reports

### Phase 3: Content & Outreach Tools (Weeks 11-14)
**Goal:** The production-direction tools.

- [ ] `page-analysis` module
  - URL input → analyze page structure
  - BLUF check (is the answer in the first 40-60 words?)
  - Question-shaped heading detection
  - Standalone test (can each H2 be read out of context?)
  - Extractable claims detection (number + noun + time + source pattern)
  - Format analysis (comparison tables, numbered steps, definition blocks)
  - Word count vs citation reminder (0.04 correlation)

- [ ] `mention-tracking` module
  - Listicle finder: "best X" / "X vs Y" pages omitting the client
  - Mention monitoring (volume, decay, sentiment)
  - Outreach target management (status tracking)
  - Review generation tracking (G2, Capterra, Clutch)

- [ ] `sleeper-refresh` module
  - Pull pages sorted by traffic decline (GSC integration)
  - Filter by referring-domain count
  - Track refresh status and dateModified updates

### Phase 4: Sales & Qualification Tools (Weeks 15-16)
**Goal:** The lead-gen and qualification engine.

- [ ] `scorecard` module (Rung 0)
  - Public-facing free diagnostic tool
  - Automated: check robots.txt, AI bot access, JS render, entity consistency
  - Score + 3 named specific problems
  - Must contain a finding the prospect couldn't know without us
  - Never gate the finding behind a call

- [ ] `pipeline-math` module
  - Revenue target → ÷ ACV → ÷ win rate → ÷ meeting-to-SQL → ÷ lead-to-meeting → ÷ visitor-to-lead
  - Compare result to addressable market size
  - Verdict: plan is feasible or fiction
  - Live calculation in discovery calls

- [ ] `claims` module
  - Stat database with grading (A/B/C)
  - Banned phrasing checker (scan reports/proposals for forbidden language)
  - Source attribution enforcement

### Phase 5: Polish & Scale (Weeks 17+)
- [ ] Multi-tenant architecture (if selling Cailyx to other agencies)
- [ ] Automated scheduling (measurement runs on cadence)
- [ ] Alerting (inaccuracy detected → immediate notification)
- [ ] White-label reports
- [ ] Team collaboration features
- [ ] Integration marketplace
- [ ] Advanced analytics and benchmarking across projects

---

## 6. Key Architectural Decisions to Make

### 6.1 Database
**Recommendation:** PostgreSQL + Prisma ORM
- Relational data (prompts → runs → results)
- Versioning requires careful schema design
- JSON columns for flexible metadata (run metadata, characterization)
- Audit trails are mandatory

**Decision needed:** PostgreSQL (recommended) vs other?

### 6.2 AI Surface Scraping
**Recommendation:** Playwright (headless browser)
- Must handle JS-heavy surfaces (ChatGPT, Perplexity)
- Must test with/without JS for the render check
- Proxy support for geo-targeting (2+ geographies)
- Session management (fresh sessions per run)

**Decision needed:** Playwright (recommended) vs Puppeteer? How to handle geo-targeting (residential proxies)?

### 6.3 Authentication
**Recommendation:** JWT + refresh tokens, role-based access
- Roles from the Operating Manual: delivery-lead, content, technical, outreach, sales, admin
- Future: multi-tenant if Cailyx is sold as SaaS

**Decision needed:** Auth0/Clerk (managed) vs custom JWT (more control)?

### 6.4 External API Keys
The system needs API keys for: Ahrefs, Google Search Console, PageSpeed Insights, potentially AI surface APIs.
**Decision needed:** Which integrations are in-scope for Phase 1 vs later?

### 6.5 Deployment
**Recommendation:** Docker + a cloud provider (Vercel for frontend, Railway/Render/Fly.io for backend)
**Decision needed:** Where will this be deployed? Self-hosted vs cloud?

### 6.6 Frontend State Management
**Recommendation:** React Query (server state) + Zustand (client state)
- Most state is server-derived (measurement results, audit findings)
- Minimal client state needed

---

## 7. Design Principles (from the documents, encoded into software)

1. **Rates, never positions.** The system never reports "we rank #3 in ChatGPT." It reports "cited in 3 of 5 runs (60%)."
2. **n≥5, no exceptions.** The measurement engine hard-enforces minimum 5 runs per prompt per surface per geo. Below this is blocked.
3. **Version-stamped, never edited in place.** Query sets are immutable once versioned. Changes create a new version.
4. **Name the surface.** Every metric is tagged with the specific surface (AI Overviews, AI Mode, ChatGPT, Perplexity). "AI visibility improved" is banned in the UI.
5. **If it went down, it goes in the headline.** Reports auto-flag declining metrics and place them prominently.
6. **Claims discipline.** Stats are graded A/B/C. Grade C stats cannot be used in reports without explicit attribution and caveat. Banned phrasings are flagged.
7. **Undercount disclaimer.** Every report includes the standing attribution undercount disclaimer automatically.
8. **The query set is the asset.** The query set module exports cleanly. The client owns it. This is stated in the UI.

---

## 8. What This Plan Defers (future decisions)

- **Multi-tenancy:** Phase 1 is single-org. Multi-tenant (selling Cailyx to other agencies) is Phase 5.
- **Real-time monitoring:** Phase 1 is batch runs on cadence. Continuous/real-time monitoring is future.
- **AI surface APIs:** If Google/ChatGPT/Perplexity open programmatic APIs for their answer features, adapter modules can replace or supplement scraping. Architecture should make this swappable.
- **LLM integration:** Using LLMs to assist with entity-diff analysis, characterization classification, and gap detection is possible but deferred — the measurement must be empirical first.
- **Pricing/monetization of Cailyx itself:** Not addressed here. Cailyx is a tool for Rothenhall first.

---

## 9. Immediate Next Steps (once plan is approved)

1. Set up the database (PostgreSQL) and Prisma in the backend
2. Build the `auth` and `projects` modules (Phase 0)
3. Build the `query-set` module (Phase 1 start)
4. Build the AI surface scraper infrastructure (Playwright + proxy)
5. Build the `measurement` module core
6. Wire up the frontend dashboard and query-set UI

---

## 10. Module Dependency Graph

```
auth ──→ projects ──→ query-set ──→ measurement ──→ reporting
                         │                │
                         │                ├──→ gap-analysis
                         │                ├──→ scorecard
                         │
                         ├──→ technical-audit ──→ gap-analysis
                         ├──→ entity-audit ──→ gap-analysis
                         ├──→ page-analysis
                         ├──→ mention-tracking
                         ├──→ sleeper-refresh
                         ├──→ crawler-monitor
                         ├──→ pipeline-math
                         └──→ claims

External integrations:
  GSC API ──→ technical-audit, reporting
  Ahrefs API ──→ page-analysis, sleeper-refresh, mention-tracking
  PageSpeed API ──→ technical-audit
  Playwright ──→ measurement, technical-audit
  Log ingestion ──→ crawler-monitor
```

---

## 11. Client Portal & Admin Console — Implementation / Revamp Plan (2026-09-20)

> **Status as of 2026-09-22: §11.0 cleanup, C1, C2, C3, C4, C5, C7 done and merged to `main`. C6
> now DONE and VERIFIED (all three items §29/§31/§28) — typecheck-clean on `backend/` and `web/`,
> and 18/18 live assertions passed against the Supabase prod Postgres — on branch
> `phase-c6-governance`, committed locally but NOT yet merged or pushed.** A client-nav restructure
> (not a lettered phase) also shipped and is merged. See §11.9 for what remains (merge the branch;
> clean up the prod test rows).
>
> Everything below is sequencing on top of decisions already made and recorded in
> `docs/analysis/client-portal.md` v1.3 (35 sections) — that doc is the *what and why*; this
> section is the *build order*. Section references below (`§N`) point into that doc, not this
> one. No new external vendor/tool is needed anywhere in this plan (Stripe, DataForSEO, and
> Google OAuth are all already-approved, already-integrated services) — so the `AGENTS.md`
> "2-3 tool options" ceremony doesn't apply to any phase here, **except** the engagement/timeline
> model (C3 below), which still needs its own focused analysis pass for DB shape and module
> ownership before code, per `client-portal.md` §10's own instruction.
>
> Same discipline as Waves 0–5 above: **one phase at a time**, each phase gets the full
> `AGENTS.md` post-completion checklist (module README, `docs/API.md`, PRD alignment, `tsc`
> clean, e2e test) before the next phase starts.

### 11.0 Cleanup first — reconcile partial/duplicate work before adding anything new — ✅ DONE (4 of 5 items; frontend/client-portal removal deliberately left to the user)

The user's own framing for this plan was that some of what exists is "unnecessarily
implemented or partially implemented" — these are real, and doing them first means new work in
C1–C7 below is built on a clean base instead of layering on top of ambiguity.

- [ ] **Collapse to one client-login mechanism.** Two exist today: `POST
  /clients/:clientId/login` (temp-password, plaintext-in-email) and `POST
  /clients/:clientId/invites` (invite-link, client sets own password). The invite-link flow is
  canonical per every decision in this conversation (§2). Deprecate the temp-password endpoint
  — either remove it outright or leave it as an internal escape hatch clearly marked
  not-for-normal-use, but stop treating it as a live parallel path. Small, no schema change.
- [ ] **Retire CP04 as the onboarding gate.** Today's single-page welcome checklist
  (`web/.../welcome/page.tsx`) is superseded by the new sequential wizard (C2 below) as the
  *first-visit* experience. Don't delete it — repurpose it as the post-onboarding "manage your
  connections / account" surface (§11's own open note flagged this exact question). Doing this
  as a rename/repurpose rather than a parallel build avoids ending up with two Google-connect
  UIs live at once.
- [ ] **Keep the Day-1 pipeline's internal stages and the new client-facing Phase/Milestone
  concept (§10) in separate namespaces.** `Project.onboardingStatus`/`onboardingStep` describe
  the one-time bootstrapping pipeline (technical-audit → digital-presence → ... → reporting) —
  that's plumbing, not a client-facing "Phase." When C3 is built, it must not repurpose or
  overload these fields; conflating "which Day-1 stage is running" with "which engagement Phase
  the client is in" is exactly the kind of partial/confusing state this cleanup pass exists to
  prevent.
- [ ] **Decide the fate of `frontend/` and `client-portal/`.** Both are confirmed-deprecated
  dead code (superseded by `web/`), currently sitting as an uncommitted local deletion (per this
  session's incident and your decision to leave them deleted). Formalize that: commit their
  removal from the repo as its own clean, clearly-labeled commit — not bundled into any of the
  phases below, so a `git blame` on C1–C7's commits never has to explain 211 unrelated deletions.
- [ ] **Flag, don't fix yet: `sleeper-refresh` still ignores the `google` module.** It only takes
  manual/CSV GSC import despite the real OAuth integration now existing elsewhere. Not part of
  any phase below (nobody asked for it), but worth a line in `MODULES-STATUS.md`'s open-items so
  it doesn't get lost — closing it later is a small, self-contained follow-up.

### 11.1 Phase C1 — Audit trail + onboarding-gate foundation — ✅ DONE, merged to main

**Why first:** almost every later phase (C2's gate, C5's suspend/waive actions, C6's overrides)
produces or checks an audit-worthy event or a gate state. Building the shared primitive once,
first, avoids five bespoke one-off implementations.

- [ ] Shared admin-action audit log (actor, action, target, timestamp, metadata) — §33.
- [ ] Per-project onboarding-wizard state model: `not-started / confirming-details /
  connecting-gsc / connecting-ga4 / done / waived`, scoped to `Project` not `Client` — §16.
- [ ] Admin "waive Google-connect for this client" action, writing to the audit log above,
  visibly distinct from a real connection everywhere it's read — §15.

### 11.2 Phase C2 — Auto-email + the sequential onboarding wizard — ✅ DONE, merged to main (corrected order: report before Google-connect, per client-onbaording.excalidraw)

**Why second:** this is the literal front door to the portal once C1's gate model exists to hang
it on. Depends on C1.

- [ ] Day-1 pipeline completion → auto-send invite-link email ("your portal is ready"), honoring
  honest partial results on a degraded run (no PDF, no blocking on a clean run) — §2, §18.
- [ ] New sequential wizard UI: confirm/edit details → connect GSC → connect GA4 → done, gated
  per C1's project-scoped state, with the C1 waive path as the documented bypass — §2, §11.
- [ ] Wizard-gate check keyed on **project** state so an already-onboarded colleague accepting a
  seat invite skips straight in — §17.
- [ ] Verify (then close the gap if real) whether category and target-markets are already
  client-editable the same way description/competitors are — §12.

### 11.3 Phase C3 — Engagement/timeline model (needs its own analysis pass first) — ✅ DONE, merged to main (Option B — see docs/analysis/engagement-timeline.md)

**Why gated separately:** this is the one piece explicitly called out in `client-portal.md` §10
as needing its own follow-up analysis doc — DB shape, which module owns it, whether
`Diagnose → Build → Operate → Compound` are the real Phase names — before any code. **Do not
skip straight to implementation for this phase**; write `docs/analysis/engagement-timeline.md`,
get it confirmed, then build.

- [ ] Analysis pass: Phase/Milestone/Approval schema, module ownership (`clients`?
  `client-portal`? new `engagement` module?), migration shape.
- [ ] Build `Phase` + `Milestone` (admin-authored, admin marks complete, no client approval
  needed on milestones) — §10.
- [ ] Build the `Approval` primitive, scoped to content-before-publish only (not competitors/
  facts, which are direct-edit per C2/§12, and not prompts, which are C4's separate request
  queue) — §9, §10.
- [ ] Baseline-report concept: pin the post-onboarding Day-1 report, report later runs as delta
  against it, not against the previous run only — §25. Depends on C2 (the wizard is what
  produces "post-onboarding" as a real moment) and reuses `reporting`'s existing delta machinery
  built for `monitoring`.

### 11.4 Phase C4 — Request queues (prompts + content) — ✅ DONE, merged to main

**Why here:** independent of C3 — deliberately a *different, lighter* mechanism than the
Approval primitive (§9), so it doesn't need to wait on C3's schema work. Can run in parallel
with C3 if capacity allows.

- [ ] Client-facing read-only prompt list (the real active query set, not a summary) — §13.
- [ ] Lightweight prompt add/delete request queue, admin acts directly (not a diff-review flow)
  — §13.
- [ ] Quota check against the plan's tracked-prompt limit at request time, flagged as an upsell
  moment rather than a silent failure over the limit — §20.
- [ ] Structured content-request form on the client content tab, landing directly in
  `content-workspace` as a client-tagged item (reuses existing pipeline, no new triage inbox) —
  §14, §22.

### 11.5 Phase C5 — Lifecycle & billing hardening — ✅ DONE, merged to main

**Why here:** these close real, currently-open gaps in admin control (§5 flagged "suspend" as
unverified) and billing robustness (§7 already found billing more built than assumed — this
phase extends what its webhook handling reacts to, not the verification pipeline itself).
Depends on C1's audit log.

- [ ] Close the "suspend" gap: a real suspend/offboard action on `Client`, wired to immediately
  revoke Google tokens (not just stop calling them) — §5, §23.
- [ ] Payment-failure handling: consume `invoice.payment_failed`/`customer.subscription.
  past_due` Stripe webhook events (extends the already-verified `billing` webhook intake),
  grace period, then auto-suspend via the action above — §30.
- [ ] Account-ownership transfer: admin action to reassign a `Client`'s primary contact — §32.
- [ ] Client seat permission differentiation: gate billing/seat-management/content-approval
  endpoints to `client-admin` only, `client-collaborator` gets view + request access — §27.

### 11.6 Phase C6 — Governance, cost control & security — ✅ DONE, verified against live prod Postgres (branch `phase-c6-governance`, NOT yet merged; see §11.9)

**Why here:** lower urgency than C1–C5 (nothing here is currently a live risk the way the
Google-gate lockout or unaudited suspend was), but each is a small, mostly independent slice —
good fill-in work, no strict internal ordering required.

- [x] Competitor-cap enforcement tied to plan tier — §29. Done in code (2026-09-21): per-tier caps
  `starter` 5 / `growth` 15 / `scale` 50 / `enterprise` unlimited (proposed by this build, in
  `business-profile/lib/competitor-cap.util.ts`), enforced in `saveDraft` with a 422
  `CompetitorCapExceededException` + client-portal upsell. Finished the preserved-branch skeleton.
- [x] Public report-share link: expiry (already existed) + optional password — §31. Done in code
  (2026-09-21): `ReportShareLink.passwordHash` (bcrypt), public password-prompt + `POST
  .../unlock` with a signed HttpOnly unlock cookie, operator UI. Token surface, not `scorecard`'s.
- [x] Data-freshness ("as of [date]") labeling — §28. Done in code (2026-09-21): shared `AsOf`
  component threaded through the client Performance / Competitors / Digital-Marketing panels.

> **Verification gate PASSED (2026-09-22): 18/18** against the live Supabase prod Postgres using the
> real compiled service code (Docker wouldn't start headlessly; ran against prod with the user's
> approval, app not booted so no crons fired). Drift caught & fixed: prod was missing
> `Client.planTier` (C7) and `BusinessProfile.category` (C2), and `planTier` was absent from
> `schema.production.prisma`. Full transcript + drift notes in each module README + `MODULES-STATUS.md`
> Wave 7. Remaining: merge `phase-c6-governance`, and clean up the `ZZ-C6-VERIFY-*` prod test rows.

### 11.7 Phase C7 — Refresh-cadence automation — ✅ DONE, merged to main

**Why last:** the most infrastructural, least dependent piece — can be built any time after the
foundation exists, but has no urgent dependents. Reuses `scheduling`/`monitoring`'s existing
BullMQ cadence infrastructure; needs its own short scoping pass on exactly which pipeline stages
re-run on cadence (probably not the full Day-1 flowchart every time) before implementation.

- [x] Scheduled job, keyed to each client's plan tier (Starter weekly, Growth/Scale daily),
  triggering the appropriate subset of the measurement/scoring pipeline automatically — §19.
  Done 2026-09-21: new `refresh-cadence` module. Scoping pass landed on measurement + scoring
  only (not the full Day-1 flowchart), reusing an hourly cron-poll pattern already established by
  `technical-audit`/`seo-audit` (own `ScheduleConfig.refresh*` columns, not the BullMQ path or
  the shared `cadence` column). Enterprise mapped to daily, not real-time — flagged as a known
  gap rather than invented (see `backend/src/modules/refresh-cadence/README.md`). Full write-up,
  scoping rationale and live-verification notes there; `docs/MODULES-STATUS.md` Wave 7 and
  `docs/API.md` updated.

### 11.8 Suggested order and why

```
11.0 Cleanup ──────────────────────────────────┐
                                                 ▼
C1 (audit log + gate model) ──→ C2 (wizard + auto-email) ──→ C3 (engagement/timeline)*
                                     │                              │
                                     ▼                              ▼
                              C4 (request queues)             C5 (lifecycle/billing)
                                     │                              │
                                     └──────────┬───────────────────┘
                                                ▼
                                    C6 (governance/security)
                                                │
                                                ▼
                                    C7 (refresh automation)
```
`*` C3 needs its own analysis doc before code — see 11.3. C4 and C6 have no hard dependency on
C3 and can be reordered ahead of it if the engagement-timeline analysis pass takes a while to
land.

### 11.9 Current status & resume point (updated 2026-09-21)

**Done and merged to `main`:** §11.0 cleanup (4/5 items — `frontend`/`client-portal` removal
deliberately left for the user to do separately, as its own isolated commit), C1, C2, C3, C4,
C5, C7, and a client-nav restructure (not a lettered phase — see `CHANGELOG.md`). Every merge
was verified with a real `npx tsc --noEmit` (backend) and `npm run typecheck` (web) pass
afterward, regenerating the Prisma client where a schema change required it.

**C6 (§11.6 — governance, cost control & security): DONE and VERIFIED, on branch
`phase-c6-governance` (committed locally, NOT yet merged, NOT pushed).** Updated 2026-09-22: a later
session finished all three items on top of `main`, reusing the small preserved skeleton from
`worktree-agent-a1e4e5fbfd6f6fcbe` (the `competitor-cap.util.ts` + `business-profile.service.ts`
edit) rather than rebuilding it, and verified them 18/18 against the live prod Postgres.
- §29 competitor cap — per-tier caps enforced in `business-profile` `saveDraft` (422 + upsell).
- §31 public report-link — optional password on `ReportShareLink` (bcrypt), public prompt +
  `POST .../unlock` + signed HttpOnly unlock cookie, operator UI. Expiry/revocation already existed.
- §28 data-freshness — shared `AsOf` component across the client Performance / Competitors /
  Digital-Marketing panels.

Both `backend/` (`npx tsc --noEmit`) and `web/` (`npm run typecheck`) are clean, and the live
verification **PASSED 18/18** against the real Supabase prod Postgres (Docker wouldn't start
headlessly; ran against prod with the user's approval, app not booted so no crons fired — real
compiled service code, real DB). Drift caught & fixed along the way: prod was missing
`Client.planTier` (C7) and `BusinessProfile.category` (C2), and `planTier` was absent from
`schema.production.prisma`. **What remains: (1) merge `phase-c6-governance` (not yet merged, not
pushed), and (2) clean up the `ZZ-C6-VERIFY-*` test rows left on prod.** A full prod schema reconcile
(prod DB is behind `main` beyond just these columns' declarations) is a separate ops task.

**A worked example worth reading before starting C6:** Phase C4 was built on an old base (before
C2/C3/C5/C7 and the nav restructure existed) and needed real merge-conflict resolution plus a
follow-up reconciliation once merged — its own plan-tier derivation logic had to be switched over
to use `Client.planTier`, a field C7 added after C4 started. If C6 hits something similar
(`Client.planTier` should already exist on `main` by the time C6 starts fresh, so this specific
gotcha shouldn't recur, but the general pattern — check `main` for a field/module that didn't
exist when a phase's own plan was written — is worth watching for).

#### Prompt for a new Claude Code session to resume this work

```
Read AGENTS.md, then docs/PLAN.md §11 (especially §11.9), docs/analysis/client-portal.md v1.3,
and docs/MODULES-STATUS.md's Wave 7 section, in that order, before doing anything else.

Phases C1, C2, C3, C4, C5, C7 of the client-portal/admin-console revamp plan (docs/PLAN.md §11)
are done and merged to main. Phase C6 (§11.6 — governance, cost control & security: a
per-plan-tier competitor cap §29, public report-link expiry+password §31, and data-freshness
"as of [date]" labeling §28) is barely started — a small amount of preserved, uncommitted-to-main
work sits on git branch worktree-agent-a1e4e5fbfd6f6fcbe (check it before rebuilding from
scratch, since some of it may be reusable).

Finish Phase C6: read docs/PLAN.md §11.6 for the full task description, check the preserved
branch for reusable work, then build all three items (§29/§31/§28), following the same discipline
already established in this plan — module READMEs, docs/API.md updates, tsc clean on both
backend/ and web/, real end-to-end verification against a live backend + Postgres (not simulated
requests), and a docs/MODULES-STATUS.md Wave 7 update when done. Commit locally as you go; ask
before pushing to any remote.
```
