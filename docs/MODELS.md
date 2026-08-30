# Cailyx — Data Models Acquired vs PRD Required

> **Date:** 2026-08-30 · **Source:** `docs/PRD.md §10`, `docs/PLAN.md §4`, `backend/prisma/schema.prisma`
> **Infra:** PostgreSQL `cailyx-postgres:5436` + Prisma `5.22` · **Status:** Phase 0 infra + Phase 2 audits built

---

## 1. Summary

| Area | Total PRD/PLAN tables | Acquired | Missing |
|---|---|---|---|
| **PRD core (`§10`)** | 9 (`subject`, `query_set`, `run`, `observation`, `access_probe`, `finding`, `score`, `report`, `lead`) | 3 mapped (`access_probe`→`AuditFinding+FetchLog`, `finding`→`Gap`, `score` partially via `Gap.priorityScore`) | 6 (`subject`, `query_set`, `run`, `observation`, `score`, `report`, `lead` — full tables) |
| **PLAN 3.1 modules** | 17 modules | 7 infra+feature built (`database`, `fetcher`, `scheduling`, `health`, `technical-audit`, `entity-audit`, `gap-analysis`) | 10 (`auth`, `projects`, `query-set`, `measurement`, `reporting`, `page-analysis`, `mention-tracking`, `scorecard`, `pipeline-math`, `crawler-monitor`…) |
| **Prisma models live** | 12 | 12 ✅ | 0 live missing (but 9+ PRD tables still absent) |

**Counts:** 12 Prisma models across 3 feature modules + 3 infra. Build sequence PRD `§16` expects Probe+Report first — we did `technical-audit→entity-audit→gap-analysis` as the diagnostic slice; `auth/projects/query-set/measurement/reporting` remain for the full loop.

---

## 2. Acquired Models — Checklist (live in `backend/prisma/schema.prisma`)

### Infrastructure

| # | Model | Status | PRD/PLAN ref | Module `backend/src/modules/*` | Key fields | Notes |
|---|---|---|---|---|---|---|
| 1 | `TechnicalAudit` | ✅ | `PLAN 4` `TechnicalAudit` + `PRD 10` `run` (pipeline run slice) | `technical-audit` `technical-audit.service.ts:77` | `id @id`, `projectId` (→ `subject`), `targetUrl`, `triggeredBy manual|scheduled`, `createdAt` | Per-run container. Immutable once `runAudit()` returns. `projectId` is `subject` surrogate until `projects` module builds `Project`. |
| 2 | `AuditFinding` | ✅ | `PRD 10` `access_probe` + `finding` | `technical-audit` | `id cuid()`, `auditId FK cascade`, `type robots|cdn-inferred|js-render|cwv|schema|404-hallucinated`, `status pass|fail|error`, `severity low|medium|high`, `confidence confirmed|inferred`, `detail Json (layer robots.txt|cdn-waf)`, `recommendedFix`, `reproductionCommands Json? {bot, command, expectedResult}` | Each probe finding = `access_probe` row + `finding` row collapsed. `reproductionCommands` implements PRD `FR-2.6`/`FR-3.5`. |
| 3 | `ScheduleConfig` | ✅ | `PRD 6.12 FR-12.1` | `scheduling` `scheduling.service.ts:1` | `projectId @unique`, `cadence manual-only|weekly|monthly`, `nextRunAt`, `active` | BullMQ repeatable job backing. Handler `technical-audit.service.ts:57 registerHandler`. |
| 4 | `PageMetadata` | ✅ | `PRD 6.3 FR-3.5` | `technical-audit` `technical-audit.service.ts:129` | `auditId @unique FK`, `title`, `metaDescription`, `headings Json[{level,text}]`, `positioningCopy`, `capturedAt` | Captured via `cheerio` `extractTitle/Headings/PositioningCopy` for downstream `entity-audit`. |
| 5 | `FetchLog` | ✅ | `PRD 12 observability` | `fetcher` `fetcher.service.ts:385` | `runId?`, `calledBy`, `method fetch|probe|render|psi|verify`, `url`, `userAgent`, `httpStatus`, `latencyMs`, `cost 0`, `cached`, `retryCount`, `timestamp` | Per-run audit trail. `getLogsByRun(runId)` + `getRunCost(runId)` → `TechnicalAudit.observability`. |
| 6 | `EntityAudit` | ✅ | `PLAN 4` `EntityAudit` + `PRD 6.4` | `entity-audit` `entity-audit.service.ts:35` | `projectId`, `createdAt` | Per-project container. Mirrors `GapAnalysis` pattern. 1 per `projectId`. |
| 7 | `Entity` | ✅ | `PRD 10` `subject.entities[]` + `PLAN 4` `Entity(name,descriptor,schema,platforms[])` | `entity-audit` | `entityAuditId FK cascade`, `name`, `descriptor?`, `type brand|product|founder|metric @default brand` | Full CRUD (`POST/GET/PATCH/DELETE /entities`) owner-checked `entity.entityAudit.projectId` → `404` cross-project. |
| 8 | `SchemaCheck` | ✅ | `PRD 6.3 FR-3.2` | `entity-audit` `entity-audit.service.ts:100` | `entityId FK`, `schemaType?`, `fieldsPresent? Json`, `fieldsMissing? Json`, `sameAsCount`, `sameAsUrls? Json`, `sameAsVerification? Json[{url,resolves,identityMatch,title,statusCode}]`, `status pass|fail|error` | `fetcher.fetchSchema()` + `@graph` flatten + `fetcher.verifyUrl` ≤10 (`extractSameAs`). History `GET .../schema-checks?limit`. |
| 9 | `PlatformRecord` | ✅ | `PRD 6.4 FR-4.3` + `PLAN 4` `Entity.platforms[]` | `entity-audit` | `entityId FK`, `platform linkedin|g2|crunchbase|other`, `recordedName?`, `recordedDescriptor?`, `sourceUrl?`, `consistencyStatus match|mismatch|not-checked` | Manual entry + semi-auto `verifySource:true` → single `fetcher.verifyUrl` → auto `match|mismatch` + `fetchedTitle` (low ToS risk — not crawling). |
| 10 | `ModelDiff` | ✅ schema · ⚠️ execution deferred | `PRD 6.4 FR-4.1/FR-4.2` + `PLAN 4` `ModelDiff(model,answer,divergence)` | `entity-audit` `entity-audit.service.ts:229` | `entityId FK`, `prompt`, `provider openai|anthropic|perplexity|google|ollama`, `model?`, `rawAnswer? @db.Text`, `citations? Json`, `divergence? Json {score,fieldMismatches}`, `status not-run|running|completed|error|deferred`, `costUsd`, `latencyMs` | Table + `GET .../model-diffs` live; `POST .../model-diff/run` is `501` until `OPENAI|ANTHROPIC|…_API_KEY` chosen (SPEC §3.1 no hard-coded 5 models, `Ollama llama3.2:1b` pulled but not wired) — `LEFT-OUT.md:1`. |
| 11 | `GapAnalysis` | ✅ | `PRD 10` `finding` container | `gap-analysis` `gap-analysis.service.ts:63` | `projectId @unique`, `createdAt`, `updatedAt`, `gaps[]` | Per-project container (`getOrCreateAnalysis` race `P2002`). |
| 12 | `Gap` | ✅ | `PRD 10` `finding(dim,action_type,severity,title,evidence,fix,claim_grade)` + `PRD 6.9 FR-9` + `PLAN SOP-5` | `gap-analysis` `gap-analysis.service.ts:213` | `gapAnalysisId FK`, `sourceType technical-finding|schema-check|platform-record|model-diff`, `sourceId @unique([sourceType,sourceId])`, `dimension visibility|narrative|topic|format|web-mentions|demand`, `dimensionAutoAssigned`, `action fix|build|influence`, `actionAutoAssigned`, `demandPotential? 1-5`, `credibilityImpact? 1-5`, `citationLikelihood? 1-5`, `priorityScore? product null until all three`, `status open|in-progress|resolved`, `title`, `description @db.Text`, `severity?` | `CLASSIFICATION_RULES:20` 9 rules (`robots/cdn/js/cwv→visibility/fix`, `schema→narrative/fix`, `platform→narrative/influence`, `model-diff≥0.5→narrative/influence`); `POST /sync` idempotent + `pruned` orphan cleanup; `PATCH` flips `*_autoAssigned` + `@Type` coercion. |

**Verified:** `npx tsc --noEmit 0`, `npx nest build 0`, `npx prisma db push` in sync (`cailyx:5436`), `docker ps` `cailyx-postgres`/`cailyx-redis` `Up`, E2E live `technical-audit` (`robots`/`cdn`×3/`js-render`/`cwv`/`schema` → `observability`), `entity-audit` (CRUD+`verifySource`+`schema-check` history), `gap-analysis` (`sync` 4→1 after `prune`, `priority 4×5×3=60`).

---

## 3. Required but Not Yet Acquired — Checklist

Derived from `docs/PRD.md:434` §10 + `docs/PLAN.md:76` §3.1 + `docs/PRD.md:546` §16 Build Sequence.

| # | PRD/PLAN entity | Status | Maps to | Module to build | Tables to create | PRD FR | Priority | Doc to read |
|---|---|---|---|---|---|---|---|---|
| — | **Phase 0 Foundation** | | | | | | | |
| 1 | `Project` / `Subject` | ❌ | `PRD 10` `subject(id, canonical_name, domain, country, category, descriptor, competitors[], entities[])` | `auth` → `projects` | `Project(id, canonicalName, domain @unique, country?, category?, descriptor?, competitors Json, ownerId FK, createdAt)` + `ProjectMember` if multi-user | §6.1 FR-1 | **P0** | `PLAN §5 Phase 0`, `AGENTS.md §2/3` |
| 2 | `User` / `Auth` | ❌ | JWT roles `admin|delivery-lead|content|technical|outreach|sales` | `auth` | `User(id,email,hash,role,createdAt)` + `Session` | `PLAN 6.3` | P0 | `PLAN §6.3` |
| 3 | `Config` admin | ⚠️ partial | `ConfigModule` exists but no validated schema UI | `config` | — | §8, §6.8 FR-8.2 | P0 | `PLAN §6.4` |
| — | **Phase 1 Core Measurement Engine** | | | | | | | |
| 4 | `QuerySet` + `Prompt` | ❌ | `PRD 10` `query_set(id,subject_id,version,created_at,prompts[])` + `prompt(text,persona,stage,cluster)` | `query-set` (SOP-1) | `QuerySet(id, projectId FK, version Int, createdAt, prompts Json? or normalized `Prompt(id, querySetId FK, text, persona, stage, cluster, taggedAt)`)` | §6.5 FR-5 | **P0** | `PLAN §5 Phase 1`, `PRD §6.5` |
| 5 | `Run` / `MeasurementRun` + `Observation` | ❌ | `PRD 10` `run(id,subject_id,query_set_version,rubric_version,tier,status,started_at,finished_at)` + `observation(id,run_id,prompt_id,surface,geo,run_index,mentioned,cited,cited_url,position,characterization,competitors[],method,raw_ref)` | `measurement` (SOP-2) | `MeasurementRun(id, querySetId FK, projectId, tier free|paid, surface ChatGPT|Claude|Perplexity|GoogleAIO|…, geo, runIndex 1..5, status queued|running|completed|error, startedAt)` + `Observation(id, runId FK, promptId FK, surface, geo, runIndex, mentioned Bool, cited Bool, citedUrl?, position first|middle|buried?, characterization accurate-positive|neutral|inaccurate|negative?, competitors Json[], method api|scrape|headless, rawAnswer @db.Text, latencyMs, costUsd)` | §6.6 FR-6, §6.7 FR-7, §7 (n≥5, multi-geo, distributions) | **P0 Core** | `PRD §6.6-6.7`, `PLAN §5` |
| 6 | `Score` | ❌ | `PRD 10` `score(id,run_id,dimension,sub_score,weight,total,band)` + §8 rubric | `measurement` + `reporting` | `Score(id, runId FK unique? or per-dimension, dimension machineAccess|entityClarity|shortlist|extractability|authority, subScore 0-100, weight, total 0-100, band invisible|faint|present|recommended, rubricVersion)` | §6.8 FR-8, §8 | P0 | `PRD §8` |
| 7 | `Report` (web+PDF) | ❌ | `PRD 10` `report(id,run_id,slug,brand,visibility,web_url,pdf_ref,version)` | `reporting` (SOP-11) | `Report(id, projectId, runId FK? or gapAnalysisId, slug @unique, brand, visibility public|noindex, webUrl?, pdfRef?, version, createdAt)` | §6.10 FR-10 | P1 | `PRD §6.10` |
| — | **Phase 2 remaining** | | | | | | | |
| 8 | `CrawlerMonitor` / `AccessProbe` split | ⚠️ partial | `PRD 10` `access_probe(id,run_id,agent,layer,status_code,blocked,attempts,cdn)` — now collapsed into `AuditFinding.detail.layer` | `crawler-monitor` | Optional: `CrawlerHit(id, projectId, url, agent, layer, statusCode, timestamp, rawLogRef)` if log ingestion built | §6.2 FR-2, §6.12 | P2 | `PLAN §5 Phase 2` |
| — | **Phase 3 Content** | | | | | | | |
| 9 | `PageAnalysis` / `Page` | ❌ | `PLAN 4` `PageAnalysis → Page(url, structure_score, standalone_test[], extractable_claims[])` | `page-analysis` (SOP-6) | `PageAnalysis(id, projectId) → Page(id, pageAnalysisId FK, url, blufScore?, headingStructure Json, standaloneTests Json, extractableClaims Json, formatScore?)` | §6.3 FR-3.3 | P2 | `PLAN §5 Phase 3` |
| 10 | `MentionCampaign` / `MentionTarget` | ❌ | `PLAN 4` `MentionCampaign → MentionTarget(url,type:listicle|community|review,status)` | `mention-tracking` (SOP-7) | `MentionCampaign(id, projectId) → MentionTarget(id, campaignId FK, url, type, status)` | §6.4 FR-4.4 | P2 | `PLAN §5` |
| 11 | `SleeperRefresh` | ❌ | `PLAN` Sleeper pages | `sleeper-refresh` (SOP-10) | `SleeperPage(id, projectId, url, trafficDecline?, referringDomains, status, dateModified)` | SOP-10 | P2 | `PLAN §5` |
| — | **Phase 4 Sales** | | | | | | | |
| 12 | `Scorecard` (Rung 0) | ❌ | Free diagnostic `Score + 3 named problems` | `scorecard` | Reuses `TechnicalAudit`+`EntityAudit`→`Gap`+`Score` (no new table, but `ScorecardRun(id, projectId, score, findingsCount)`) | §13 Free | P1 | `PLAN §5 Phase 4`, `PRD §13` |
| 13 | `PipelineMath` | ❌ | `PLAN 4` `PipelineMath(revenue_target, acv, win_rate, conversion_rates, verdict)` | `pipeline-math` | `PipelineMath(id, projectId @unique, revenueTarget, acv, winRate, conversionRates Json, verdict feasible|fiction)` | GTM Playbook | P1 | `PLAN §3.1` |
| 14 | `Claims` / `StatGrade` | ❌ | Claims discipline `stat grading A/B/C`, banned phrasing | `claims` | `Claim(id, stat, grade A|B|C, source, bannedPhrase?)` | Part 7 | P2 | `PLAN §3.1` |
| 15 | `Lead` / `Delivery` | ❌ | `PRD 10` `lead(id,subject_id,email,source,status,cta_events[])` + §6.11 | `reporting`/`intake` | `Lead(id, projectId FK, email, source bulk|api|form, status, ctaEvents Json)` | §6.11 FR-11 | P1 | `PRD §6.11` |
| — | **Phase 5** | | | | | | | |
| 16 | `DataAsset` | ❌ | Survey/data asset `named after client brand` | `data-asset` (SOP-8) | `DataAsset(id, projectId, methodology, publishedAt)` | SOP-8 | P3 | `PLAN §3.1` |
| 17 | Multi-tenant / white-label | ❌ | WS branding | future | `Tenant`, `BrandTheme` | §6.10 FR-10.4 | P5 | `PLAN §8` |

**Legend:** ✅ acquired/live (12), ⚠️ partial (2), ❌ not yet (≥12).

---

## 4. Next Plan — Build Order (per `PRD §16` + `AGENTS.md §2 One at a time`)

> `AGENTS.md:52` requires `docs/analysis/<module>.md` (2-3 options per tool, pricing, recommendation) **before** code; user approves then build. Never install unapproved deps.

| Step | Module | Why now | Analysis doc needed | Key decisions to make |
|---|---|---|---|---|
| **1** | `auth` | P0 — unblocks `projects` ownership (today `projectId` is a free string, no JWT) | `docs/analysis/auth.md` — `JWT @nestjs/jwt` vs `Auth0/Clerk` (cost, control) | Roles `admin|delivery-lead|content|technical|outreach|sales`, refresh tokens, `APP_GUARD JwtAuthGuard` |
| **2** | `projects` | P0 — `Project` is the FK for all future `QuerySet`/`Run`/`Report` | `docs/analysis/projects.md` — lifecycle `scorecard→diagnostic→sprint→retainer` | `Project` fields above + `ProjectMember` if multi-user |
| **3** | `query-set` | P0 SOP-1 — required before `measurement` can run | `docs/analysis/query-set.md` — `persona/stage/cluster` taxonomy, versioning strategy, fan-out observation, CSV export | `Prompt` table vs JSON, `version` bump rule |
| **4** | `measurement` | **P0 Core** — the moat (n≥5 × surfaces × geos → `Observation`) | `docs/analysis/measurement.md` — surface adapters (Anthropic `claude+web_search` vs Perplexity `sonar` vs OpenAI proxy vs Google AIO SERP vs headless) — PRD §6.6 surface table; cost governor `TA_MAX_COST_PER_RUN` pattern | `MeasurementRun` + `Observation` + `share-of-voice` agg |
| **5** | `reporting` | P1 — closes the probe+measure→report loop | `docs/analysis/reporting.md` — web renderer + headless PDF (`playwright` reuse), chart lib (`recharts` vs `chart.js`) | `Report` + `Score` band `invisible|faint|present|recommended` (§8) |
| **6** | `crawler-monitor` | P2 — unlocks hallucinated `404` (deferred in `technical-audit`) | `docs/analysis/crawler-monitor.md` — log ingestion (`Filebeat` vs `S3` vs manual paste) | `CrawlerHit` |
| **7** | `page-analysis` | P2 SOP-6 | `docs/analysis/page-analysis.md` — BLUF/extraction heuristics | `PageAnalysis/Page` |
| **8** | `scorecard` + `pipeline-math` + `claims` | P1/P2 quick wins — reuse audits | respective analysis docs | Minimal new tables |

Current `docs/analysis/` contains `technical-audit.md:1`, `entity-audit.md:1`, `gap-analysis.md:1` — next is `auth.md`.

---

## 5. Checklist — What to do before next `Build`

- [ ] Create `docs/analysis/<next>.md` with 2-3 options per tool (AGENTS §3)
- [ ] Add new env vars to `backend/.env` + `backend/.env.example` (AGENTS §6)
- [ ] `Prisma` new model(s) → `npx prisma db push` + `generate` (verify `cailyx:5436`)
- [ ] NestJS module under `backend/src/modules/<name>/` (dto `class-validator` + `@ApiProperty`, service `JSDoc`, controller `Swagger` + `Throttler`, `app.module.ts` import)
- [ ] Update `docs/API.md` (method/path/body/response) + `docs/PLAN.md` checkboxes
- [ ] Verify `npx tsc --noEmit 0` + `npx nest build 0` + E2E `prisma.*` + `docker ps` `cailyx-*:Up`
- [ ] No `*.js`/`test-*.js`/`dist`/`.env` committed (`.gitignore`)

All 12 live models are read by `GapAnalysis` for the `visibility|narrative` roadmap — ready for `query-set`→`measurement` to feed `topic|format|web-mentions|demand` gaps.

