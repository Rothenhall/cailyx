# Google Module — Search Console + Analytics

3-legged OAuth per operator. Reads Search Console and Analytics data, and —
for Search Console only — re-submits the property's sitemaps, which is a
write. Inert until the OAuth client id + secret are set — every write path
returns a clean `503`, `GET /connections` reports everything not-connected.
**Nothing else changes when you add them.**

## Turning it on (the only steps)

1. Google Cloud Console → a project with these APIs **enabled**:
   - Google Search Console API
   - Google Analytics Admin API
   - Google Analytics Data API
2. Create an **OAuth 2.0 Client ID** (type: Web application). Under
   *Authorised redirect URIs* add exactly:
   `http://localhost:3002/api/integrations/google/callback`
   (or whatever you set `GOOGLE_OAUTH_REDIRECT_URI` to).
3. Put the values in `backend/.env`:

   ```
   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3002/api/integrations/google/callback
   GOOGLE_OAUTH_SUCCESS_REDIRECT=http://localhost:3000/v2
   GOOGLE_TOKEN_ENC_KEY=          # optional in dev; `openssl rand -hex 32` for prod
   ```
4. Restart the backend. In the console → Connections panel →
   *Google · Search Console & Analytics* → **connect** each service, then map a
   GSC site / GA4 property to the project.

While the app is unverified in Google's eyes, add each operator's Google
account as a *Test user* on the OAuth consent screen.

## Storage

| table | row |
|---|---|
| `GoogleConnection` | one per `(userId, service)` — encrypted access + refresh token, scope, expiry |
| `GoogleProjectResource` | one per `(projectId, service)` — which GSC `siteUrl` / GA4 `properties/NNN` the project reads |

Tokens are **AES-256-GCM** encrypted at rest (`crypto.util.ts`). The key is
`GOOGLE_TOKEN_ENC_KEY`; with none set, a dev key is derived from `JWT_SECRET`
(logged once). Decrypted values never leave `GoogleConnectionService` —
callers get a string from `accessTokenFor()`, which refreshes transparently
within 60 s of expiry.

## API (all under the global `JwtAuthGuard` except the callback)

| route | purpose |
|---|---|
| `GET  /integrations/google/status` | `{ configured }` — client id/secret present? |
| `POST /integrations/google/authorize` `{service, projectId?}` | → `{ url }` to open |
| `GET  /integrations/google/callback` `@Public` | Google lands here → 302 back to `…/v2?google=<service>&status=connected` |
| `GET  /integrations/google/connections` | per-service state, **no tokens** |
| `DELETE /integrations/google/connections/:service` | revoke at Google + delete |
| `GET  /integrations/google/resources?service=&projectId=` | sites / properties + current map |
| `PUT  /integrations/google/resources` `{service, projectId, resourceId, resourceLabel?}` | map project → resource |
| `GET  /integrations/google/search-console/summary?projectId=&days=` | clicks / impressions / CTR / position + top queries & pages |
| `GET  /integrations/google/analytics/summary?projectId=&days=` | sessions / users / views / engagement + channels & top pages |

## Security notes

- The SPA is bearer-token only, so the callback (hit by Google, no cookie)
  can't read the session. The `authorize` request mints an **HMAC-signed
  `state`** (`google-oauth.service.ts`) carrying `userId` / `projectId` /
  `service`, 10-minute expiry, random nonce; the callback verifies the
  signature with `JWT_SECRET` and trusts what's inside.
- `access_type=offline` + `prompt=consent` — we require a refresh token;
  `saveAuthorization` refuses a grant that returns none.
- **Scopes requested, and why** (`google.types.ts` — these are the strings on
  the consent screen; `GET /connections` returns whatever Google actually
  granted, which is the authoritative record):

  | service | scope | why |
  |---|---|---|
  | search-console | `https://www.googleapis.com/auth/webmasters` | read/write. The reads (`searchanalytics`, `sitemaps.list`, URL Inspection) need only read, but `SeoAuditService.submitSitemaps` does `PUT /sites/{site}/sitemaps/{feedpath}` — `sitemaps.submit` — and `webmasters.readonly` cannot call it. One scope covers both; `webmasters` is a superset of `webmasters.readonly`. |
  | analytics | `https://www.googleapis.com/auth/analytics.readonly` | read only. `accountSummaries.list` (the property picker) accepts this scope, and the Data API `runReport` is a read. Nothing in this module writes to Google Analytics, so no edit scope is requested. |

  Both are joined with `openid email` (the connected-account address).

- **Write-scope enforcement.** `GoogleConnectionService.hasGrantedScope`
  compares the *stored* granted scopes against `GSC_SCOPE_READWRITE` before a
  sitemap submit. A connection made before the write scope was requested holds
  only `webmasters.readonly`; that request is answered with a `409` naming the
  fix (reconnect Search Console and accept write access) instead of letting
  Google answer `403`/`401` where the remedy is not derivable from the status.
  `GET /connections` returns `scope` per service for exactly this diagnosis.
- Disconnect calls Google's revoke endpoint, then deletes locally.

No `googleapis` dependency — the flow is plain `fetch` against the token,
Search Console, Analytics Admin and Analytics Data REST endpoints.

## G19/D17 — scopes repaired to match what the module actually does (2026-09-16)

The requested scopes did not match the calls being made, in both directions:

| | before | after |
|---|---|---|
| Search Console | `webmasters.readonly` | `webmasters` (read/write) |
| Analytics | `analytics.readonly` + `analytics.edit` | `analytics.readonly` |
| `openid email` | unchanged | unchanged |

**Search Console was requesting a read scope while an endpoint writes.**
`SeoAuditService.submitSitemaps` issues `PUT /sites/{site}/sitemaps/{feedpath}`
(`sitemaps.submit`), which `webmasters.readonly` cannot call — the endpoint
could not succeed with the grant Cailyx asked for. `webmasters` is a superset
and covers the existing reads (`searchanalytics.query`, `sitemaps.list`, URL
Inspection), so it is now the single Search Console scope.

**Analytics was requesting a write scope it never used.** `analytics.edit`
grants write access to the whole Admin API; this module only calls
`accountSummaries.list` (a read that accepts `analytics.readonly`) and the Data
API `runReport`. The over-broad scope has been dropped, which also makes the
consent screen honest about what is being granted.

**A grant already stored is not retroactively fixed.** `GoogleConnection.scope`
holds what Google returned at consent time, and the OAuth flow only re-consents
on a new connection. `GoogleConnectionService.hasGrantedScope(userId, service,
scope)` now answers "what did this operator actually grant", and
`SearchConsoleService.submitSitemap` checks it against `GSC_SCOPE_READWRITE`
*before* issuing the request. A pre-repair connection therefore gets:

```
409  The connected Search Console grant is read-only, so Cailyx cannot submit
     sitemaps. Reconnect Search Console from this project's connections screen
     to grant write access.
```

instead of a Google 401/403 whose remedy the operator cannot derive.
`GET /integrations/google/connections` returns `scope` per service, which is
the value to check when diagnosing this.

**Verified:** `npx tsc --noEmit` clean for this module. The OAuth flow was not
exercised against Google in this pass — no live consent was performed, so the
granted-scope strings are asserted against Google's documented requirements,
not against a fresh token response.
