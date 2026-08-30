# Auth Module

> **Status:** ✅ Built and tested
> **Phase:** 0 (PLAN Phase 0 — foundation; Wave 0 of `docs/MODULES-STATUS.md`)
> **PRD:** §6.3 architectural decision (auth); unblocks protecting every other module
> **Decision:** custom JWT with passport — `docs/analysis/auth.md` (approved 2026-08-30, "use passport")

## Purpose

Operator authentication and role-based access control. Registers the global `JwtAuthGuard` + `RolesGuard` via `APP_GUARD`, so every existing and future endpoint requires a valid bearer access token unless marked `@Public()`.

## Architecture

```
auth/
├── auth.module.ts             # NestJS module; registers global APP_GUARDs
├── auth.service.ts            # register/login/refresh-rotation/logout/me
├── auth.controller.ts         # REST API (/api/auth/*)
├── auth.types.ts              # Role union, token claims, SafeUserDto
├── strategies/
│   └── jwt.strategy.ts        # passport-jwt bearer verification + user-existence recheck
├── dto/
│   └── auth.dto.ts            # Register/Login/Refresh DTOs
└── README.md

cross-cutting (used by ALL modules):
├── src/common/guards/jwt-auth.guard.ts    # global guard; @Public() opt-out
├── src/common/guards/roles.guard.ts       # @Roles() enforcement; admin passes all
└── src/common/decorators/                 # @Public(), @Roles(), @CurrentUser()
```

## Public API

| Method | Endpoint | Rate Limit | Auth | Description |
|---|---|---|---|---|
| `POST` | `/api/auth/register` | 5/60s | open→admin-gated | First account bootstraps to admin; afterwards requires an admin bearer token |
| `POST` | `/api/auth/login` | 10/60s | public | Email+password → access+refresh tokens |
| `POST` | `/api/auth/refresh` | 20/60s | public (token auth) | Rotate refresh token → new pair |
| `POST` | `/api/auth/logout` | — | public (token auth) | Revoke refresh token (idempotent) |
| `GET` | `/api/auth/me` | 100/60s | bearer | Current operator profile |

## Security properties

- bcryptjs password hashing (cost 10; pure JS — no native build on Windows)
- Access token: HS256 JWT, `JWT_ACCESS_TTL` (default 15m), claims `{sub, email, role}`
- Refresh token: opaque 96-hex random; only SHA-256 hash stored; **rotation on refresh**; **reuse detection revokes the user's whole session family**; expired rows pruned on issuance
- Identical error for unknown email and bad password (no user enumeration)
- Login/refresh failures are 401, never 4xx detail leaks; throttle rates cap brute force

## Roles

`admin` · `delivery-lead` · `content` · `technical` · `outreach` · `sales`

Enforce per route with `@Roles('content', ...)`. Admin passes every check. Guards are global; add `@Public()` only where genuinely unauthenticated (health check, register/login/refresh/logout, future public scorecard).

## Dependencies

- npm: `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`, `bcryptjs` (+`@types/passport-jwt` dev) — approved in `docs/analysis/auth.md`
- Modules: `database` (PrismaService)
- Models: `User`, `RefreshToken`

## Environment variables

| Var | Default | Description |
|---|---|---|
| `JWT_SECRET` | — (required) | HS256 signing secret; use a long random value in production |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `JWT_REFRESH_TTL_DAYS` | `30` | Refresh token lifetime in days |

## Consumers

Every module (global guards). Projects service uses `@CurrentUser()` for ownership (Wave 0 wiring).

## PRD alignment

| PRD Requirement | Status | Notes |
|---|---|---|
| PLAN §6.3 auth decision | ✅ | Custom JWT, approved by user (passport variant) |
| Operating Manual roles (6) | ✅ | Role union + RolesGuard |
| Protect all endpoints | ✅ | Global JwtAuthGuard; health + auth routes `@Public()` |
| Project ownership scoping | ⚠️ | `Project.userId` + list scoping done this wave; per-module artifact ownership inherits the project |

## Testing notes

`npx tsc --noEmit` 0 errors · `nest build` passes · end-to-end (live server, real DB, 2026-08-30): unauthenticated `/api/projects` → 401 · public health → 200 · first register → role `admin` · bad password → 401 · `/auth/me` → profile · authenticated `/api/projects` → 200 · re-register without token → 401, with admin token → role honored · refresh rotation → 200 · **refresh reuse → 401 + whole family revoked** (third reuse also 401). Test users + tokens removed after the run; test server killed.