# Gap Analysis — Requirements

> **Module:** `gap-analysis` (SOP-5)
> **Date:** 2026-08-29

## External Tools / APIs / Services

| Tool / Service | Purpose | Required? | Status | Notes |
|---|---|---|---|---|
| **PostgreSQL** (`cailyx-postgres:5436`) | `GapAnalysis` + `Gap` | Yes | ✅ | `prisma db push` done |
| **Prisma** | Reads `TechnicalAudit`/`AuditFinding`, `EntityAudit`→`Entity`→`SchemaCheck`/`PlatformRecord`/`ModelDiff` | Yes | ✅ | No new models beyond `Gap*` |
| **No fetcher / no queue / no external APIs** | `POST /sync` is manual, mapping is local | No | — | BullMQ available but not used |

## Database Entities (new)

- `GapAnalysis` (`projectId @unique`)
- `Gap` (`sourceType`,`sourceId` `@unique`, `dimension`/`dimensionAutoAssigned`, `action`/`actionAutoAssigned`, `demandPotential`/`credibilityImpact`/`citationLikelihood` 1-5, `priorityScore` product, `status`, `title`/`description`/`severity`)

## API Endpoints

`GET /` (filterable), `POST /sync`, `PATCH /gaps/:gapId`, `GET /gaps/:gapId`, `GET /roadmap`.

## Decisions Open

- DB-backed `GapClassificationRule` table per engagement tuning — shipped as `CLASSIFICATION_RULES` constant for v1 (SPEC §4.4 follow-up).
