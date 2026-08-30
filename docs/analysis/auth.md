# Analysis — `auth` module (Wave 0, PRD-required)

> **Date:** 2026-08-30 · **Status: decision requested**
> Blocks: every module (all endpoints currently unauthenticated — `docs/API.md` notes "Auth: not yet implemented")

## What the module must do

- Register + login (operator accounts only — Cailyx is an internal B2B tool, not public-facing)
- Access token + refresh token (access short-lived, refresh long-lived)
- Role-based access control with the Operating Manual roles: `admin`, `delivery-lead`, `content`, `technical`, `outreach`, `sales`
- Guards on every existing and future module (`JwtAuthGuard` global; `@Public()` where needed)
- Project ownership: users see only projects they are assigned to (admin sees all)
- Password hashing (bcrypt), rate-limited login, failure lockout-resistant design

## Tool options

### Option A — Custom JWT (recommended)

- **Packages:** `@nestjs/jwt`, `bcrypt` (or `argon2`), `passport`/`passport-jwt` + `@nestjs/passport`, `class-validator` (already present)
- **Pros:** zero recurring cost; no external dependency/latency; full control of role model and claims; codebase stays self-contained; works with SQLite + Prisma already in place; no vendor lock-in for an internal tool with ~10 operators
- **Cons:** we own security hygiene (secret rotation, refresh-token revocation, hashing settings); no SSO/MFA out of the box
- **Pricing:** $0. Effort: ~1 module build.

### Option B — Auth0

- **Pros:** managed identity, MFA/SSO bundled, fast; production-hardened
- **Cons:** pricing scales badly past free tier (free 25k MAU is generous but ties the core product identity to a vendor); roles need mapping via auth0 APIs; adds an external dependency to every dev flow; overkill for an internal operator tool at this stage
- **Pricing:** $0 up to 25k MAU, then $35/mo per tier (2026 published rates; verify at build time)

### Option C — Clerk

- **Pros:** nicest prebuilt UI components (if/when the frontend needs them), fast to wire in Next.js
- **Cons:** NestJS backend integration is second-class (needs its own verification adapter); per-MAU pricing; vendor lock-in for the same reasons as Auth0; designed for end-user SaaS, not 6-role internal teams
- **Pricing:** $0.70/mo per MAU after free tier (verify)

## Recommendation

**Option A.** Six internal roles, zero budget, NestJS-native guard model, no user-facing auth UX requirement until the scorecard funnel (which is per-domain, not per-account). Revisit managed identity only if Cailyx is sold as multi-tenant SaaS (PLAN Phase 5).

## Endpoints to expose

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create operator (admin-only after the first account) |
| `POST` | `/api/auth/login` | Email + password → access + refresh |
| `POST` | `/api/auth/refresh` | Refresh → new access token |
| `POST` | `/api/auth/logout` | Revoke refresh token |
| `GET` | `/api/auth/me` | Current user + role + projects |

## DB entities

- `User` (email unique, passwordHash, role, name)
- `RefreshToken` (hashed token, userId, expiresAt, revokedAt — rotation + revocation)

## Env vars

`JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL` (default 15m), `JWT_REFRESH_TTL_DAYS` (default 30).