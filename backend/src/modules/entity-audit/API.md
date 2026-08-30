# Entity Audit Module — API Reference

## Base Path

All endpoints are prefixed with `/api/projects/:projectId/entity-audit`. Every `:entityId`-scoped route verifies that the entity belongs to `:projectId` (404 otherwise).

---

## Endpoints

### POST /entities

Add a new entity to track for a project.

**Request body:**
```json
{
  "name": "Rothenhall Partners",
  "type": "brand",
  "descriptor": "AI visibility consultancy"
}
```

**Validation:** `name` required (≤200), `type` in `brand|product|founder|metric`, `descriptor` optional (≤500).

**Response — 201 Created:** `{ id, entityAuditId, name, type, descriptor, createdAt }`

---

### GET /entities

List all entities for a project with schema checks (desc), platform records, and model diffs (desc).

**Response — 200 OK:** `{ entities: [{ id, name, type, descriptor, schemaChecks[], platformRecords[], modelDiffs[] }] }`.

---

### GET /entities/:entityId

Get a specific entity with all data. 404 if cross-project.

**Response — 200 OK:** Entity with `schemaChecks` (desc), `platformRecords`, `modelDiffs`.

---

### PATCH /entities/:entityId

Partial update of `name`, `descriptor`, `type`. Ownership-checked.

**Request body (all optional):**
```json
{ "name": "Rothenhall Partners Ltd", "descriptor": "AI visibility consultancy", "type": "brand" }
```

**Response — 200 OK:** Updated entity.

---

### DELETE /entities/:entityId

Delete entity and cascade to schema checks, platform records, model diffs.

**Response — 200 OK:** `{ deleted: true, entityId }`

---

### POST /entities/:entityId/schema-check/run

Run a schema check on a URL — extract JSON-LD (handles `@graph`, string/array `sameAs`), validate `name/url/description/logo/sameAs`, and verify each `sameAs` link resolves + title identity match.

**Rate limit:** 5 per 60s per IP

**Request body:**
```json
{ "url": "https://rothenhall.com" }
```

**Response — 200 OK:**
```json
{
  "entityId": "clxyz...",
  "schemaType": "Organization",
  "fieldsPresent": ["name", "url", "description", "sameAs"],
  "fieldsMissing": ["logo"],
  "sameAsCount": 3,
  "sameAsUrls": ["https://linkedin.com/company/rothenhall"],
  "sameAsVerification": [{ "url": "...", "resolves": true, "identityMatch": true, "title": "...", "statusCode": 200 }],
  "status": "pass",
  "checkedAt": "2026-08-29T00:00:00.000Z",
  "recommendedFix": "..."
}
```

---

### GET /entities/:entityId/schema-checks?limit=20

Schema-check history, newest first. `limit` 1..50 (default 20).

**Response — 200 OK:** `{ entityId, checks: SchemaCheck[], count }`

---

### POST /entities/:entityId/platform-record

Add a platform record (manual entry). With `verifySource: true` and `sourceUrl`, does a single-page `verifyUrl` fetch (semi-auto, low ToS risk) and auto-infers `match/mismatch`, returning `fetchedTitle`.

**Request body:**
```json
{
  "platform": "linkedin",
  "recordedName": "Rothenhall Partners",
  "recordedDescriptor": "AI Visibility Consultancy",
  "sourceUrl": "https://linkedin.com/company/rothenhall",
  "consistencyStatus": "match",
  "verifySource": true
}
```

**Response — 201 Created:** Platform record (plus `fetchedTitle` when `verifySource` was true).

---

### PATCH /entities/:entityId/platform-records/:recordId

Update a platform record. Ownership-checked (record must belong to entity which must belong to project).

**Response — 200 OK:** Updated record.

---

### DELETE /entities/:entityId/platform-records/:recordId

Delete a platform record.

**Response — 200 OK:** `{ deleted: true, recordId }`

---

### GET /entities/:entityId/platform-consistency

Check platform consistency — normalized name compare with `entity.name`, respecting stored `mismatch`/`match` and falling back to computed `not-checked`.

**Response — 200 OK:** `{ entityId, checks: [{ platform, recordedName, entityName, consistencyStatus, sourceUrl }] }`

---

### GET /

Get the full entity audit summary for a project (entities ordered by `createdAt`, each with checks/records/diffs).

**Response — 200 OK:** `{ id, projectId, createdAt, entities }`

---

### GET /entities/:entityId/model-diffs

List persisted model-diffs for an entity (empty until LLM integration is built; schema exists as `ModelDiff` table).

**Response — 200 OK:** `{ entityId, diffs: ModelDiff[], count }`

---

### POST /entities/:entityId/model-diff/run

**DEFERRED** — returns 200 with `not-implemented` + `requiredKeys`. See [LEFT-OUT.md](LEFT-OUT.md). `ModelDiff` table and `GET .../model-diffs` already exist; execution needs `OPENAI_API_KEY` etc. and the LLM-judge prompt (SPEC §3.1, §7).
