# Technical Audit Module — API Reference

## Base Path

All endpoints are prefixed with `/api/projects/:projectId/technical-audit`

## Authentication

Not yet implemented (planned: JWT-based). All endpoints are currently public.

## Rate Limiting

| Endpoint | Rate Limit | Reason |
|---|---|---|
| `POST /run` | **3 per 60s per IP** | Expensive: 20+ probes + Playwright + PSI API per call |
| All other endpoints | 100 per 60s per IP (global default) | Standard protection |

---

## Endpoints

### POST /run

Run a full technical audit for a target URL. Executes all 5 checks:
1. robots.txt AI-bot blocks
2. CDN AI-bot blocking probe (20+ bots, 3x each)
3. JS render dependency (Playwright)
4. Core Web Vitals (Google PSI API)
5. Schema audit (JSON-LD, sameAs verification)

**Rate limit:** 3 per 60s per IP

**Request body:**
```json
{
  "targetUrl": "https://example.com"
}
```

**Validation:**
- `targetUrl` — required, must be a valid `http://` or `https://` URL (prevents SSRF)

**Response — 200 OK:**
```json
{
  "id": "audit_1787926162720",
  "projectId": "test-project-1",
  "triggeredBy": "manual",
  "createdAt": "2026-08-28T13:40:07.000Z",
  "targetUrl": "https://example.com",
  "pageMetadata": {
    "title": "Example Domain",
    "metaDescription": "",
    "headings": [
      { "level": 1, "text": "Example Domain" }
    ],
    "positioningCopy": "This domain is for use in documentation examples...",
    "capturedAt": "2026-08-28T13:40:07.000Z"
  },
  "findings": [
    {
      "type": "robots",
      "status": "fail",
      "severity": "low",
      "confidence": "confirmed",
      "detail": {
        "robotsUrl": "https://example.com/robots.txt",
        "statusCode": 404,
        "layer": "robots.txt",
        "robotsTxtFound": false,
        "missingRobotsTxt": true,
        "blockedBots": [],
        "blockedTraining": [],
        "blockedSearch": [],
        "blockedLiveFetch": [],
        "rules": [],
        "rawContent": ""
      },
      "recommendedFix": "No robots.txt found. Create one with explicit Allow rules...",
      "reproductionCommands": [
        {
          "bot": "Browser (control)",
          "command": "curl -sI -A \"Mozilla/5.0 ...\" https://example.com",
          "expectedResult": "HTTP 200 — site accessible to normal browsers"
        },
        {
          "bot": "robots.txt",
          "command": "curl -s https://example.com/robots.txt",
          "expectedResult": "robots.txt content — check for Disallow rules targeting AI bots"
        }
      ]
    },
    {
      "type": "cdn-inferred",
      "status": "pass",
      "severity": "low",
      "confidence": "inferred",
      "detail": {
        "cdnVendor": "Cloudflare",
        "layer": "cdn-waf",
        "silentBlockDetected": false,
        "blockedBots": [],
        "probeCount": 20,
        "probes": [
          {
            "botName": "GPTBot",
            "category": "training",
            "status": 200,
            "blocked": false,
            "latencyMs": 45,
            "inconsistent": false,
            "layer": "cdn-waf"
          }
        ]
      },
      "recommendedFix": "No CDN-level AI bot blocking detected...",
      "reproductionCommands": [...]
    },
    {
      "type": "js-render",
      "status": "pass",
      "severity": "low",
      "confidence": "confirmed",
      "detail": {
        "textLengthWithoutJs": 1200,
        "textLengthWithJs": 1200,
        "isJsDependent": false,
        "contentLossPercent": 0
      },
      "recommendedFix": "The page is well server-rendered..."
    },
    {
      "type": "cwv",
      "status": "pass",
      "severity": "low",
      "confidence": "confirmed",
      "detail": {
        "lcp": 760,
        "cls": 0,
        "inp": -1,
        "performanceScore": 100,
        "lcpStatus": "good",
        "clsStatus": "good",
        "inpStatus": "good"
      },
      "recommendedFix": "Core Web Vitals are all good..."
    },
    {
      "type": "schema",
      "status": "fail",
      "severity": "medium",
      "confidence": "confirmed",
      "detail": {
        "schemasFound": false,
        "schemaTypes": [],
        "hasOrganization": false,
        "hasPerson": false,
        "sameAsCount": 0,
        "sameAsUrls": [],
        "missingFields": [],
        "sameAsVerification": []
      },
      "recommendedFix": "No JSON-LD structured data found..."
    }
  ]
}
```

**Error Responses:**
- `400 Bad Request` — `targetUrl` is missing, not a URL, or is a private/internal IP (SSRF guard)
- `429 Too Many Requests` — Rate limit exceeded (3 per 60s). Response includes `Retry-After` header.

**Finding types:**

| Type | Description | Confidence | Layer |
|---|---|---|---|
| `robots` | robots.txt analysis — AI bot disallow rules | confirmed | robots.txt |
| `cdn-inferred` | CDN/WAF AI-bot blocking probe | inferred | cdn-waf |
| `js-render` | JS render dependency check | confirmed | n/a |
| `cwv` | Core Web Vitals (LCP, CLS, INP) | confirmed | n/a |
| `schema` | JSON-LD structured data audit + sameAs verification | confirmed | n/a |

**Finding status:**

| Status | Meaning |
|---|---|
| `pass` | Check passed — no issues found |
| `fail` | Check failed — issue detected |
| `error` | Check could not run — error occurred (see detail.error) |

**Severity levels:**

| Severity | When |
|---|---|
| `high` | Search crawler blocked (de-indexing) or >70% JS content loss or poor CWV |
| `medium` | Training crawler blocked or 30-70% JS loss or needs-improvement CWV or no schema |
| `low` | No issues, or live-fetch agent blocked, or missing robots.txt |

**Reproduction commands (FR-2.6):**

robots.txt and CDN findings include `reproductionCommands` — exact curl commands to verify findings:
```json
{
  "bot": "GPTBot",
  "command": "curl -sI -A \"GPTBot/1.2...\" https://example.com",
  "expectedResult": "HTTP 403 — blocked by CDN/WAF"
}
```

**Page metadata (FR-3.5):**

The response includes `pageMetadata` with title, meta description, headings, and positioning copy — captured for downstream entity-audit and findings stages.

---

### GET /

List all audit runs for a project — persisted in PostgreSQL.

**Response — 200 OK:**
```json
{
  "audits": [
    {
      "id": "audit_1787926162720",
      "projectId": "test-project-1",
      "targetUrl": "https://example.com",
      "triggeredBy": "manual",
      "createdAt": "2026-08-28T13:40:07.000Z",
      "findings": [{ "id": "...", "type": "robots", "status": "fail", "severity": "low" }]
    }
  ]
}
```

Ordered by `createdAt` desc. Each audit includes a findings summary (`id`, `type`, `status`, `severity`).

---

### GET /:auditId

Get a specific audit run with all findings, reproduction commands, and page metadata — persisted in PostgreSQL.

**Response — 200 OK:**
```json
{
  "id": "audit_1787926162720",
  "projectId": "test-project-1",
  "targetUrl": "https://example.com",
  "triggeredBy": "manual",
  "createdAt": "2026-08-28T13:40:07.000Z",
  "findings": [{ "type": "robots", "status": "fail", "severity": "low", "detail": { "layer": "robots.txt" }, "reproductionCommands": [...] }],
  "pageMetadata": { "title": "Example Domain", "headings": [...] }
}
```

**Error Responses:**
- `404 Not Found` — audit ID does not exist or not in this project (`findFirst({ id, projectId })`)

---

### PUT /schedule

Set or update the scheduling cadence for recurring audits — persisted via BullMQ + PostgreSQL.

Uses `PrismaService` to look up the latest `targetUrl` for the project, then delegates to `SchedulingService.setSchedule()` which creates a BullMQ repeatable job and upserts `ScheduleConfig`.

**Request body:**
```json
{
  "cadence": "weekly"
}
```

**Validation:**
- `cadence` — required, must be one of: `weekly`, `monthly`, `manual-only`

**Response — 200 OK:**
```json
{
  "cadence": "weekly",
  "nextRunAt": "2026-09-04T13:40:07.000Z",
  "active": true
}
```

If no `targetUrl` exists yet and `cadence !== 'manual-only'`, returns `active: false` + `error: 'Run a manual audit first.'`.

**Error Responses:**
- `400 Bad Request` — invalid cadence value

---

### GET /schedule

Get the current schedule config for a project — from `ScheduleConfig` in PostgreSQL via `SchedulingService.getSchedule()`.

**Response — 200 OK:**
```json
{
  "cadence": "manual-only",
  "nextRunAt": null,
  "active": false
}
```

```json
{
  "cadence": "weekly",
  "nextRunAt": "2026-09-04T13:40:07.000Z",
  "active": true
}
```

---

## Swagger / OpenAPI

Interactive API docs are available at `/api/docs` when the server is running. All endpoints are documented with `@ApiTags`, `@ApiOperation`, `@ApiResponse`, and `@ApiBody` decorators.