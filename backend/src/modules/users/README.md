# Users Module

> **Status:** ✅ Built and e2e-verified (2026-08-30, `smoke/users.smoke.sh` — 17/17)
> **Type:** Operator administration — **admin only** (`@Roles('admin')` + global RolesGuard)

## Purpose

The CRUD surface behind the dashboard's **User Management** UI. Login,
registration, and refresh-token rotation stay in `auth` — this module only
administers accounts.

- Never returns `passwordHash` or token hashes (only `SafeUserDto`).
- Guard rails: the **last `admin` cannot be demoted or deleted**, and an operator
  **cannot delete their own account** here.
- A password reset **revokes all of that operator's refresh tokens**.

## API

`@Controller('users')` — every route `@Roles('admin')`.

| Method | Route | Notes |
|---|---|---|
| GET | `/` | `{ users: SafeUser[] }`, newest first |
| GET | `/roles` | `{ roles }` — `admin · delivery-lead · content · technical · outreach · sales` |
| POST | `/` | `{ email, password (≥10), name, role }` → SafeUser (409 dup email) |
| GET | `/:id` | one operator (404) |
| PATCH | `/:id` | `{ name?, role? }` — 409 if it would demote the last admin |
| POST | `/:id/password` | `{ password (≥10) }` → `{ id, sessionsRevoked }` |
| DELETE | `/:id` | 400 self-delete · 409 last admin |

## Testing

`bash smoke/users.smoke.sh` — **17/17**: role catalogue, list, create (no secret
in response), new operator can log in but is **403** on `/users`, update role +
name, invalid role → 400, password reset + login with new password + short pw →
400, self-delete → **400**, demote-last-admin → **409**, delete → 200 then 404.
