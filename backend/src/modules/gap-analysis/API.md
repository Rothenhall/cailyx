# Gap Analysis Module — API Reference

## Base Path

All endpoints are prefixed with `/api/projects/:projectId/gap-analysis`.

---

## Endpoints

### GET /

List gaps for a project — filterable by `dimension`, `action`, `status`. Sorted by `priorityScore` desc (nulls last), then `createdAt` desc.

**Query params (all optional):**

| Param | Values |
|---|---|
| `dimension` | `visibility` \| `narrative` \| `topic` \| `format` \| `web-mentions` \| `demand` |
| `action` | `fix` \| `build` \| `influence` |
| `status` | `open` \| `in-progress` \| `resolved` |

**Response — 200 OK:**
```json
{
  "id": "cm...",
  "projectId": "proj-1",
  "gaps": [
    {
      "id": "cm...",
      "sourceType": "technical-finding",
      "sourceId": "cl...",
      "dimension": "visibility",
      "dimensionAutoAssigned": true,
      "action": "fix",
      "actionAutoAssigned": true,
      "demandPotential": 4,
      "credibilityImpact": 5,
      "citationLikelihood": 3,
      "priorityScore": 60,
      "status": "open",
      "title": "robots.txt blocks AI crawlers (robots)",
      "description": "Remove Disallow rules for GPTBot...",
      "severity": "high",
      "createdAt": "2026-08-29T02:30:00.000Z",
      "updatedAt": "2026-08-29T02:30:00.000Z"
    }
  ],
  "count": 1
}
```

---

### POST /sync

Re-run auto-classification against the latest findings. Idempotent — upserts by `(sourceType, sourceId)`; does not duplicate gaps on re-sync. Updates `title/description/severity` on auto-assigned gaps; manual overrides (`dimensionAutoAssigned=false`) are preserved.

**Sources ingested:**

- `AuditFinding` where `status` in `fail|error` (all audits for the project)
- `SchemaCheck` where `status` in `fail|error` (entity-audit, scoped to project's entities)
- `PlatformRecord` where `consistencyStatus = mismatch`
- `ModelDiff` where `status = completed` and `divergence.score >= 0.5` (deferred — usually zero rows until LLM feature built)

Each finding is classified via `CLASSIFICATION_RULES` in `gap-analysis.service.ts` (see `SPEC §4.4` mapping table) into `dimension` + `action`.

**Response — 200 OK:**
```json
{
  "id": "cm...",
  "projectId": "proj-1",
  "created": 5,
  "updated": 2,
  "pruned": 1,
  "gaps": [...],
  "count": 7
}
```

`pruned` is the count of stale gaps removed where the source no longer qualifies (finding now passes/deleted, platform now `match`, etc.). Re-sync is idempotent and also prunes.

---

### GET /gaps/:gapId

Get a single gap. 404 if gap not in this project.

**Response — 200 OK:** `Gap` object.

---

### PATCH /gaps/:gapId

Override auto-assigned fields and set priority inputs. Setting `dimension` or `action` flips `*_auto_assigned` to `false`. Setting any of `demandPotential`/`credibilityImpact`/`citationLikelihood` (integers `1-5`) recomputes `priorityScore = product` (or `null` until all three are set).

**Request body (all optional):**
```json
{
  "dimension": "narrative",
  "action": "influence",
  "status": "in-progress",
  "demandPotential": 4,
  "credibilityImpact": 5,
  "citationLikelihood": 3,
  "title": "Custom title",
  "description": "Custom description"
}
```

**Response — 200 OK:** Updated `Gap`.

---

### GET /roadmap

Roadmap grouped by `action`, each group sorted by `priorityScore` desc (nulls last). Group order is `fix` → `build` → `influence`.

**Response — 200 OK:**
```json
{
  "projectId": "proj-1",
  "groups": [
    { "action": "fix", "gaps": [{ "priorityScore": 60, ... }], "count": 3 },
    { "action": "build", "gaps": [], "count": 0 },
    { "action": "influence", "gaps": [{ "priorityScore": null, ... }], "count": 1 }
  ],
  "total": 4
}
```

---

## Data Model

```
GapAnalysis { id, projectId @unique, createdAt, updatedAt, gaps[] }
Gap {
  id, gapAnalysisId, sourceType, sourceId @unique([sourceType,sourceId]),
  dimension, dimensionAutoAssigned,
  action, actionAutoAssigned,
  demandPotential Int? 1-5, credibilityImpact 1-5, citationLikelihood 1-5,
  priorityScore Int? (= product, null until all three),
  status, title, description, severity, createdAt, updatedAt
}
```

## Mapping Table (reviewable constant)

See `gap-analysis.service.ts` `CLASSIFICATION_RULES` — derived from `SPEC §4.4`. Tuning per engagement is done via PATCH overrides; a DB-backed `GapClassificationRule` table is the planned v2 evolution.

## Error Responses

- `404 Not Found` — `Gap ${gapId} not found in project ${projectId}` (ownership-checked).
