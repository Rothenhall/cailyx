# Cailyx — Detailed Module Spec: Technical Audit, Entity Audit, Gap Analysis

> **Status:** Draft for review
> **Date:** 2026-08-27
> **Scope:** Replaces the corresponding sections of the main Cailyx build plan for `technical-audit`, `entity-audit`, and `gap-analysis` only. All other modules remain as specified in the main plan.
> **Decisions incorporated:** see §6 (Decisions Log)

---

## 1. Module Purpose (recap)

| Module | Maps to SOP | Purpose |
|---|---|---|
| `technical-audit` | SOP-3 | Detect AI-crawler access blockers and performance issues that prevent a site from being crawled/cited |
| `entity-audit` | SOP-4 | Detect inconsistency in how AI models and third-party platforms describe/name the client entity |
| `gap-analysis` | SOP-5 | Auto-classify findings from the above (plus other audits) into 6 dimensions and a fix/build/influence roadmap |

These three form a pipeline: `technical-audit` + `entity-audit` → `gap-analysis`. Both audit modules are designed as independent producers of a common `Finding` shape that `gap-analysis` consumes.

---

## 2. `technical-audit` Module

### 2.1 Checks in scope

| Check | Method | Notes |
|---|---|---|
| robots.txt AI-bot blocks | Fetch + parse `robots.txt`, check for `Disallow` rules against GPTBot, OAI-SearchBot, PerplexityBot, Google-Extended, ClaudeBot, etc. | No auth needed |
| CDN AI-bot blocking | **Header-sniffing only** — inspect response headers (`server`, `cf-ray`, `via`, etc.) to detect CDN vendor, and probe with an AI-bot user-agent vs a normal one to see if response differs (403/challenge page vs 200) | No Cloudflare API token/OAuth required. This is a heuristic, not a definitive read of the client's CDN bot-management config — findings should be labeled "inferred," not "confirmed" |
| JS render dependency | Headless browser fetch with JS disabled vs enabled (Playwright), diff the rendered content | Reuses Playwright infra from `measurement` module |
| Core Web Vitals | PageSpeed Insights API — LCP, INP, CLS thresholds | **Requires a Google PageSpeed Insights API key** — see §2.4 prerequisite |
| Hallucinated 404 sweep | **Deferred.** Not built in this phase. | Needs either (a) AI-referral URL data from server logs, which depends on the `crawler-monitor` module (later phase), or (b) a manual URL list paste-in. Revisit once one of those sources exists. Placeholder left in data model (§2.3) so it slots in later without a schema change. |

### 2.2 Scheduling / cadence

Per decision, this module supports scheduled recurring audits from the start (not deferred to Phase 5):

- Configurable cadence per project (e.g. weekly, monthly, manual-only)
- Job queue (e.g. BullMQ on Redis) to run scheduled audits async
- Each scheduled run creates a new `TechnicalAudit` record (never overwrites) so trend-over-time is possible
- Manual "run now" trigger always available regardless of schedule
- Failure/retry handling for unreachable sites (timeouts, WAF blocks) — a failed check should not silently disappear; it should log as a distinct finding status (`error`, not `pass`/`fail`)

### 2.3 Data model

```
TechnicalAudit
  ├── id, project_id, triggered_by (manual|scheduled), created_at
  ├── schedule_config (cadence, next_run_at, active) — one per project, not per-run
  └── AuditFinding
        ├── type: robots | cdn-inferred | js-render | cwv | 404-hallucinated (reserved, unused for now)
        ├── status: pass | fail | error | not-run
        ├── detail (JSON — raw check output)
        ├── severity: low | medium | high
        ├── confidence: confirmed | inferred   (used for cdn-inferred; everything else defaults to confirmed)
        └── recommended_fix (text)
```

### 2.4 Prerequisite tasks (new — added to Phase 0/2 build list)

- [ ] Obtain a **Google PageSpeed Insights API key** (Google Cloud project + API enabled) — blocking dependency for the CWV check
- [ ] Confirm PSI API quota is sufficient for expected audit volume (free tier: 25,000 requests/day, but rate-limited per 100s — batch accordingly)

### 2.5 API endpoints (indicative)

```
POST   /projects/:id/technical-audit/run           → trigger manual audit
GET    /projects/:id/technical-audit                → list audit runs
GET    /projects/:id/technical-audit/:auditId       → audit detail + findings
PUT    /projects/:id/technical-audit/schedule       → set/update cadence
GET    /projects/:id/technical-audit/schedule       → get current schedule config
```

---

## 3. `entity-audit` Module

### 3.1 Model-diff (the "ask 5 models" check)

- **API access not yet in place.** Add as an explicit prerequisite task — do **not** hard-code which 5 models until access is confirmed and cost is understood.
- **Diff analysis will use LLM integration** — this is an explicit exception to the main plan's general deferral of LLM-assisted analysis. Rationale: comparing free-text "what is X?" answers for divergence is not practically rule-based; an LLM-as-judge pass is needed to detect factual/descriptor drift, not just string diff.
- Flow: send the same "what is [entity]?" prompt to each configured model → store raw answers → run an LLM-judge pass that outputs structured divergence (field-level: name, category, founders, key facts) → surface divergence score + specific mismatches.

### 3.2 Prerequisite tasks (new)

- [ ] Determine and acquire **API access for the model set** used in model-diff (which providers, pricing, rate limits — a follow-up decision once access is being set up, not resolved in this document)
- [ ] Decide the LLM-judge model/prompt for divergence scoring (can reuse one of the same providers, or a separate model — open decision, flagged not resolved)

### 3.3 Platform consistency checker (LinkedIn, G2, Crunchbase, etc.)

**⚠️ Flagged risk — not resolved in this plan:**
Scraping these platforms directly is fragile and carries ToS risk (LinkedIn and Crunchbase both actively restrict scraping; G2 has anti-bot measures). This needs a deliberate decision before building, likely one of:
- Manual data entry (delivery lead pastes current name/descriptor per platform)
- Semi-automated (user pastes a URL, tool does a one-time fetch of that single page — lower risk than crawling)
- Official APIs where available (Crunchbase has a paid API; LinkedIn/G2 largely don't for this use case)

This section of the module should be built **last** within Phase 2, after the above is decided, and the build should not assume scraping is viable.

### 3.4 Schema checker

- Fetch page, extract JSON-LD (`Organization`, `Person` schema types)
- Validate required/recommended fields present
- **`sameAs` verification (expanded per decision):** for each URL listed in `sameAs`, fetch it and confirm (a) it resolves (not 404/redirect-to-unrelated-page) and (b) the page's own identity signals (title, og:title, or its own JSON-LD `name`) plausibly match the entity name — flagging stale or broken `sameAs` links as findings, not just missing ones.

### 3.5 Data model

```
EntityAudit
  ├── id, project_id, created_at
  └── Entity
        ├── name, descriptor, type (brand|product|founder|metric)
        ├── ModelDiff
        │     ├── model, raw_answer, captured_at
        │     └── divergence (JSON: LLM-judge structured output — field-level mismatches, score)
        ├── PlatformRecord   (manual/semi-automated per §3.3)
        │     ├── platform (linkedin|g2|crunchbase|other)
        │     ├── recorded_name, recorded_descriptor, source_url
        │     └── consistency_status: match | mismatch | not-checked
        └── SchemaCheck
              ├── schema_type, fields_present (JSON), fields_missing (JSON)
              └── SameAsLink
                    ├── url, resolves (bool), identity_match (bool), checked_at
```

### 3.6 API endpoints (indicative)

```
POST   /projects/:id/entity-audit/entities          → add entity
POST   /projects/:id/entity-audit/entities/:eid/model-diff/run   → trigger model-diff
POST   /projects/:id/entity-audit/entities/:eid/platform-record  → manual/semi-auto platform entry
POST   /projects/:id/entity-audit/entities/:eid/schema-check/run → trigger schema + sameAs check
GET    /projects/:id/entity-audit                    → full audit summary
```

---

## 4. `gap-analysis` Module

### 4.1 Automation approach

Per decision, this is built **mostly automated**, not a manual workboard:

- A rules engine ingests `AuditFinding` records (from `technical-audit`) and `Entity`/`ModelDiff`/`SchemaCheck`/`PlatformRecord` records (from `entity-audit`), and auto-generates `Gap` records with:
  - **dimension** auto-assigned via a mapping table (e.g. `robots`-block → visibility; `sameAs` mismatch → narrative; schema missing → narrative; JS-render dependency → visibility; etc.) — this mapping table is itself the main build artifact and should be reviewed/tunable, not hard-coded permanently
  - **action** (fix|build|influence) auto-assigned via the same mapping (most technical findings → "fix"; most entity narrative gaps → "influence" or "build" depending on severity)
- Delivery lead can **override** any auto-assigned dimension/action — auto-classification is a starting point, not a lock

### 4.2 Priority ranking

**No scoring data exists today**, so priority ranking is **not** auto-computed in this phase:

- Each `Gap` gets a **manual 1–5 input per factor** (demand potential, credibility impact, citation likelihood) set by the delivery lead in the UI
- The composite priority score (`demand × credibility × citation likelihood`) is still calculated automatically **once those three manual inputs exist** — only the inputs are manual, not the math
- Flagged as a future improvement: once measurement/entity-audit data matures, these three factors could be auto-suggested (e.g. citation likelihood informed by `measurement` citation rates for the related cluster) — deferred, not built now

### 4.3 Data model

```
GapAnalysis
  ├── id, project_id, created_at
  └── Gap
        ├── source_type: technical-finding | entity-finding
        ├── source_id (FK to AuditFinding, ModelDiff, SchemaCheck, or PlatformRecord)
        ├── dimension: visibility | narrative | topic | format | web-mentions | demand
        ├── dimension_auto_assigned (bool) — true until manually overridden
        ├── action: fix | build | influence
        ├── action_auto_assigned (bool)
        ├── demand_potential (1-5, manual)
        ├── credibility_impact (1-5, manual)
        ├── citation_likelihood (1-5, manual)
        ├── priority_score (computed: product of the three, null until all three are set)
        └── status: open | in-progress | resolved
```

### 4.4 Classification mapping table (build artifact)

A configurable table drives auto-classification, roughly:

| Finding type | Dimension | Default action |
|---|---|---|
| robots.txt block | visibility | fix |
| CDN inferred block | visibility | fix |
| JS-render dependency | visibility | fix |
| CWV failure | visibility | fix |
| Model-diff high divergence | narrative | influence |
| Platform name/descriptor mismatch | narrative | influence |
| Schema missing/incomplete | narrative | fix |
| sameAs broken/stale | narrative | fix |

This table should live in config (DB-backed, editable), not hard-coded in application logic, since the mapping will likely need tuning per engagement.

### 4.5 API endpoints (indicative)

```
GET    /projects/:id/gap-analysis                    → all gaps, filterable by dimension/action/status
POST   /projects/:id/gap-analysis/sync                → re-run auto-classification against latest findings
PATCH  /projects/:id/gap-analysis/gaps/:gapId         → override dimension/action, set priority inputs
GET    /projects/:id/gap-analysis/roadmap             → gaps grouped by action, sorted by priority_score
```

---

## 5. Revised Phase 2 Build Checklist

**Phase 2: Audits & Analysis**

- [ ] Obtain PageSpeed Insights API key (prerequisite)
- [ ] `technical-audit`: robots.txt check
- [ ] `technical-audit`: CDN header-sniffing check (inferred-confidence only)
- [ ] `technical-audit`: JS render diff (Playwright)
- [ ] `technical-audit`: Core Web Vitals via PSI API
- [ ] `technical-audit`: scheduling/cadence system (job queue, per-project config, manual trigger)
- [ ] `technical-audit`: skip hallucinated 404 sweep (deferred — schema placeholder only)
- [ ] Determine model set + acquire API access for entity model-diff (prerequisite)
- [ ] `entity-audit`: entity CRUD
- [ ] `entity-audit`: model-diff pipeline with LLM-judge divergence scoring
- [ ] `entity-audit`: schema checker incl. sameAs resolve + identity-match verification
- [ ] `entity-audit`: platform consistency — **decide approach (manual/semi-auto/API) before building**; build last in this phase
- [ ] `gap-analysis`: classification mapping table (config-driven)
- [ ] `gap-analysis`: auto-classification engine (dimension + action)
- [ ] `gap-analysis`: manual priority-input UI + computed priority score
- [ ] `gap-analysis`: override UI, roadmap view

---

## 6. Decisions Log (from this review)

| # | Topic | Decision |
|---|---|---|
| 1 | PSI API key | Include as a plan task |
| 2 | CDN detection | Header-sniffing only, no CDN vendor API/OAuth |
| 3 | Hallucinated 404 sweep | Deferred; leave a schema placeholder |
| 4 | Technical audit scheduling | Build cadence/scheduling now, not Phase 5 |
| 5 | Model-diff model selection | Not decided yet — add "acquire API access" as a task instead of naming models |
| 6 | Model-diff analysis method | LLM-assisted (exception to general LLM-deferral rule) |
| 7 | Platform consistency data source | Flagged as an open risk/decision (scraping ToS concerns); not resolved, build last |
| 8 | Schema checker sameAs | Also verify links resolve and identity matches |
| 9 | Gap-analysis automation | Mostly automated (rules-engine classification, manual override) |
| 10 | Priority scoring inputs | Manual 1–5 sliders for now; math still automated once inputs exist |

---

## 7. Open Items Still Needing a Decision

1. Which model providers for entity model-diff, and what's the expected API cost/volume?
2. Which model (or same set) performs the LLM-judge divergence scoring?
3. Platform consistency data source: manual entry vs semi-automated single-page fetch vs paid API (Crunchbase) — needs a decision before that sub-feature is built.
4. Job queue technology for scheduling (BullMQ/Redis assumed above — confirm or propose alternative).
