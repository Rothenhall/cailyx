# Gap Analysis Module

> **Status:** ✅ Built and tested
> **Phase:** 2 — Audits & Analysis (SOP-5)
> **Spec:** `SPEC.md` §4 (`cailyx-audit-modules-spec.md` §4), `docs/analysis/gap-analysis.md`

## Purpose

Auto-classifies findings from `technical-audit` and `entity-audit` into 6 dimensions and a `fix|build|influence` roadmap. Answers: **What do we fix/build/influence, in what order?**

The mapping table itself is the primary build artifact (reviewable constant, tunable via overrides) — most technical findings map to `fix|visibility`, narrative gaps to `fix|influence|narrative`.

## Architecture

```
gap-analysis/
├── gap-analysis.module.ts        # NestJS module
├── gap-analysis.service.ts       # Rules engine, sync, patch, roadmap (CLASSIFICATION_RULES)
├── gap-analysis.controller.ts    # REST API (list/sync/patch/roadmap)
├── gap-analysis.types.ts         # GapDimension/Action/Status/SourceType, ClassificationRule
├── dto/
│   └── gap-analysis.dto.ts       # PatchGapDto (class-validator + @ApiProperty)
├── API.md                        # REST endpoint reference
└── SPEC.md                       # Copy of spec §4
```

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects/:projectId/gap-analysis?dimension=&action=&status=` | List gaps (filterable, sorted `priorityScore` desc nulls last) |
| `GET` | `/api/projects/:projectId/gap-analysis/gaps/:gapId` | Get gap detail (404 if not in project) |
| `POST` | `/api/projects/:projectId/gap-analysis/sync` | Re-run auto-classification against latest findings (idempotent upsert) |
| `PATCH` | `/api/projects/:projectId/gap-analysis/gaps/:gapId` | Override `dimension`/`action`/`status`/`title`/`description` + set `demandPotential`/`credibilityImpact`/`citationLikelihood` 1-5 (recomputes `priorityScore`) |
| `GET` | `/api/projects/:projectId/gap-analysis/roadmap` | Roadmap grouped by `action` (`fix→build→influence`), each sorted `priorityScore` desc |

## Dependencies

| Module | Purpose |
|---|---|
| `DatabaseModule` / `PrismaService` | `GapAnalysis`, `Gap`, plus reads `TechnicalAudit`/`AuditFinding`, `EntityAudit`→`Entity`→`SchemaCheck`/`PlatformRecord`/`ModelDiff` |
| No fetcher, no queue, no external APIs | `POST /sync` is manual, no BullMQ job |

## Prisma Models

| Model | Purpose |
|---|---|
| `GapAnalysis` | Per-project container (`projectId @unique`) |
| `Gap` | Classified gap (`sourceType`/`sourceId` `@unique`, `dimension`/`dimensionAutoAssigned`, `action`/`actionAutoAssigned`, `demandPotential`/`credibilityImpact`/`citationLikelihood` 1-5, `priorityScore = product`, `status`, `title`, `description`, `severity`) |

## Mapping Table (SPEC §4.4 — reviewable constant in `gap-analysis.service.ts`)

| Finding | Dimension | Action |
|---|---|---|
| `robots` / `cdn-inferred` / `js-render` / `cwv` | `visibility` | `fix` |
| `schema` (technical-audit) | `narrative` | `fix` |
| `schema-check` / `sameAs` broken | `narrative` | `fix` |
| `platform-record` mismatch | `narrative` | `influence` |
| `model-diff` high divergence (≥0.5) | `narrative` | `influence` |
| `topic`/`format`/`web-mentions`/`demand` | — | — (future modules) |

`dimensionAutoAssigned`/`actionAutoAssigned` flip to `false` on override; re-sync preserves manual overrides.

## PRD Alignment

| Requirement | Status | Notes |
|---|---|---|
| SOP-5 6-dimension classification (visibility/narrative/topic/format/web-mentions/demand) | ✅ | Rules engine + `dimension` field; `topic`/`format`/`web-mentions`/`demand` remain empty until their source modules exist — mapping is extensible |
| fix/build/influence assignment | ✅ | Mapping table → `action`, overridable |
| Priority ranking `demand × credibility × citation` | ✅ | `demandPotential`/`credibilityImpact`/`citationLikelihood` 1-5 manual inputs (SPEC §4.2), `priorityScore` computed automatically, `null` until all three set |
| `dimensionAutoAssigned`/`actionAutoAssigned` | ✅ | Preserves delivery-lead overrides across re-sync |
| Roadmap grouped by action sorted by priorityScore | ✅ | `GET /roadmap` |
| `GapClassificationRule` DB-backed/tunable per engagement | ⚠️ v2 | Ships as reviewable `CLASSIFICATION_RULES` constant (SPEC §4.4 says "should live in config, not hard-coded permanently"); DB-backed `GapClassificationRule` table is the follow-up |

## Testing

- **E2E (2026-08-29, live DB `cailyx:5436`):** Created `TechnicalAudit` findings (`robots` fail, `cdn-inferred` pass, `schema` fail) + entity-audit `SchemaCheck` fail + `PlatformRecord` mismatch via real services, ran `POST /sync` → 4 gaps created (robots→`visibility/fix`, schema→`narrative/fix`, schema-check→`narrative/fix`, platform→`narrative/influence`); verified `GET ?dimension=visibility` filter (1), `PATCH` priority inputs (`4×5×3=60`), `PATCH` dimension override (`visibility→topic` flips `autoAssigned`), `GET /roadmap` grouping (`fix:3, influence:1`), idempotent re-sync (`created 0`), cross-project `404`, prune on fix (mismatch→`match` → `pruned:1`), race-safe `getOrCreateAnalysis`, `@Type` coercion for `1-5` inputs, cleanup.
- `npx tsc --noEmit` 0 errors, `npx nest build` success.

## Consumers

- **Reporting / frontend board:** `GET /` + `GET /roadmap` drive the gap board (6-dimension filter, 3-column `fix|build|influence` sorted by `priorityScore`).
- **Next:** `measurement` will add topic/format gaps when its data exists.
