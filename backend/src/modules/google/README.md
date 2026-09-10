# Google Module — Search Console + Analytics

3-legged OAuth per operator. Read-only. Inert until the OAuth client id +
secret are set — every write path returns a clean `503`, `GET /connections`
reports everything not-connected. **Nothing else changes when you add them.**

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
- Scopes are read-only for data (`webmasters.readonly`,
  `analytics.readonly`); `analytics.edit` is requested only so the property
  picker (`accountSummaries`) works.
- Disconnect calls Google's revoke endpoint, then deletes locally.

No `googleapis` dependency — the flow is plain `fetch` against the token,
Search Console, Analytics Admin and Analytics Data REST endpoints.
