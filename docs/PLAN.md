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
