# Gap Analysis — Tool & Technology Analysis

> **Module:** `gap-analysis` (SOP-5)
> **Date:** 2026-08-29
> **Status:** Approved to build — user requested end-to-end completion

## What the module does (SOP-5)

Auto-classifies findings from `technical-audit` (AuditFinding: robots/cdn/js-render/cwv/schema) and `entity-audit` (SchemaCheck, PlatformRecord, future ModelDiff) into 6 dimensions (`visibility|narrative|topic|format|web-mentions|demand`) + `action` (`fix|build|influence`) via a mapping table, computes `priority_score = demand × credibility × citation_likelihood` (manual 1-5 inputs, math automated), allows delivery-lead overrides (`*_auto_assigned` flag), and exposes a roadmap grouped by `action` sorted by `priority_score`. The mapping table itself is the primary build artifact and must be reviewable/tunable (SPEC §4.4 says config-driven, not permanently hard-coded).

## External tools / APIs / services

| Need | Options | Recommendation |
|---|---|---|
| **Persistence** | 1. PostgreSQL via Prisma (existing `cailyx-postgres:5436`) <br>2. SQLite file <br>3. No DB (in-memory) | **1. Prisma on PostgreSQL** — consistent with `technical-audit`/`entity-audit` (already `GapAnalysis`/`Gap` models go there). No new infra. |
| **Rules engine / mapping table** | 1. Hard-coded `const MAPPING: Record<string, {dimension, action}>` in service (simple, reviewable) <br>2. DB-backed `GapClassificationRule` table (fully tunable per engagement without code change, SPEC §4.4 intent) <br>3. External rules engine lib (json-rules-engine, node-rules) — heavyweight for ~8 rules | **1 for v1 + 2 as follow-up:** ship `1` now (mapping constant + exported for review, easy to make DB-backed later), add `GapClassificationRule` table in a follow-up when tuning demand emerges. Choosing `1` avoids over-engineering 8 static rules; choosing `2` would add CRUD for rules before any tuning need is proven. |
| **Job queue / scheduling** | 1. BullMQ on Redis (`cailyx-redis:6380`, existing `SchedulingModule`) <br>2. DB polling / cron <br>3. No auto — manual `POST /sync` only | **3 for v1:** gap-analysis `POST /sync` is manual re-run on demand (SPEC §4.5). No recurring job needed. BullMQ stays available via `SchedulingModule` if cadence is added later. |

**No new npm packages required.** All dependencies are already in `backend/package.json` (`@nestjs/*`, `@prisma/client`, `class-validator`, etc.).

## Database entities (new)

```
GapAnalysis
  ├── id, projectId, createdAt
  └── Gap[]
        ├── sourceType: technical-finding | schema-check | platform-record | model-diff
        ├── sourceId (string — FK to AuditFinding | SchemaCheck | PlatformRecord | ModelDiff, not enforced as strict DB FK to avoid polymorphic FK complexity)
        ├── dimension: visibility|narrative|topic|format|web-mentions|demand + dimensionAutoAssigned bool
        ├── action: fix|build|influence + actionAutoAssigned bool
        ├── demandPotential (Int? 1-5), credibilityImpact (Int? 1-5), citationLikelihood (Int? 1-5)
        ├── priorityScore (Int? — product, null until all three set)
        ├── status: open|in-progress|resolved
        ├── title, description (denormalized from source finding for display without joins)
        └── createdAt, updatedAt
@@unique([sourceType, sourceId]) — prevents duplicate gaps on re-sync
@@index([gapAnalysisId, dimension, action, status])
```

`GapAnalysis` is the per-project container (mirrors `EntityAudit` pattern). `SPEC §4.3` fields preserved; `projectId` reached via `GapAnalysis`.

## API endpoints (SPEC §4.5 + missing explicit list)

```
GET    /projects/:projectId/gap-analysis                    → all gaps, filterable ?dimension=&action=&status=  (returns GapAnalysis + gaps[])
POST   /projects/:projectId/gap-analysis/sync               → re-run auto-classification against latest findings (idempotent)
PATCH  /projects/:projectId/gap-analysis/gaps/:gapId        → override dimension/action/status + set 1-5 inputs (recomputes priorityScore)
GET    /projects/:projectId/gap-analysis/roadmap            → gaps grouped by action, sorted by priorityScore desc (nulls last)
```

Plus `GET /projects/:projectId/gap-analysis/gaps/:gapId` for detail (useful, not in spec but trivial).

## Frontend

Phase-2 board: 6-dimension filter + 3-column roadmap (fix/build/influence) sorted by `priorityScore`. Deferred per AGENTS one-module-at-a-time — backend + docs ship first; frontend consumes the same REST API when built.

## Decisions confirmed with user

- Mapping table ships as reviewable constant in `gap-analysis.service.ts` (not DB-backed yet) — matches SPEC §4.4 "should live in config (DB-backed, editable), not hard-coded permanently" as a v2 follow-up after first engagement tunes it.
- `POST /sync` manual only (no BullMQ job).
- No new external APIs, no new packages.
