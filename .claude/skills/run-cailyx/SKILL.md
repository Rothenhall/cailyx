---
name: run-cailyx
description: >-
  Launch and drive the Cailyx app — the NestJS backend (:3002) and Next.js
  frontend (:3000) — to see a change working in the real UI or via the API.
  Use when asked to run, start, or screenshot the app, or to confirm a change
  works end-to-end (not just tests). Covers the exact env vars, the Redis noise
  to ignore, the shared login, and how to drive the infinite-canvas dashboard.
---

# Run Cailyx

Monorepo: `backend/` (NestJS 11 + Prisma/SQLite) and `frontend/` (Next.js 16,
App Router, Turbopack). Dev DB is **SQLite** at `backend/prisma/dev.db` — the
`DATABASE_URL=postgresql://…` line in `backend/.env` is ignored (the schema
hard-codes `provider = "sqlite"`).

## 1. One-time setup (skip if `node_modules` already present)

```bash
cd backend
npm install --ignore-scripts   # better-sqlite3's native build breaks on Windows / Node 24; it's unused
npx prisma generate
npx prisma db push             # only if prisma/dev.db is missing or the schema changed
```

```bash
cd frontend
npm install
```

## 2. Start both servers (background them)

**Backend** — must pass the three dev fixture flags or the deterministic
adapters 503 and journey/dashboard/link-graph/serp paths fail:

```bash
cd backend && MEASUREMENT_ALLOW_MOCK=1 INTERNAL_LINK_ALLOW_FIXTURE=1 SERP_ALLOW_FIXTURE=1 npm run start:dev
```

- Listens on **:3002**. Health: `curl http://localhost:3002/api/health` → `200`.
- It logs a flood of `connect ECONNREFUSED …:6380` — that is **Redis, which is
  not required**. It only powers scheduled re-runs and the BullMQ campaign
  queue. Startup still succeeds; confirm with the health check, not the log.
  A one-off exit-4 on boot is a transient Redis race — just start it again.
- Takes ~10–30s to compile on a cold start.

**Frontend**:

```bash
cd frontend && npm run dev
```

- Listens on **:3000**. `curl -o /dev/null -w '%{http_code}' http://localhost:3000` → `200`.
- Warns about "multiple lockfiles" (root + `frontend/`) — harmless.

## 3. Drive it

### Login (shared smoke account)

`smoke@cailyx.test` / `smoke-cailyx-pw-1234567890`

The first account created on a fresh `dev.db` auto-bootstraps as **admin** via
`POST /api/auth/register` (`{email,password,name}`). After that,
`POST /api/auth/login` (`{email,password}`) — returns **HTTP 200** (not 201)
with `{ accessToken, refreshToken, user }`.

### API smoke (fast path)

```bash
TOK=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@cailyx.test","password":"smoke-cailyx-pw-1234567890"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')
curl -s http://localhost:3002/api/projects -H "Authorization: Bearer $TOK"
```

Expected: `{ "projects": [ … ] }` (the demo DB carries `rothenhall.com`,
`day1tech.com`, …). Per-project data: `GET /api/projects/:id`,
`/agents`, `/journeys/suggestions` (the Flywheel), `/technical-audit`, etc.

### Browser (see the UI)

Open `http://localhost:3000` → land on `/login` → log in → the dashboard is an
**infinite pan/zoom canvas** of cards (Analytics · Context · Agents · Chat ·
Gates · Flywheel). To verify a change: switch project via the top-left
switcher, watch the skeletons, read the card that your change touched.

Canvas driving caveats:
- At low zoom, coordinate clicks on card inputs miss. Zoom to ~100% (the `+`
  control, bottom-left) or target elements by ref.
- Wheel-scroll over a card scrolls that card; scroll over empty canvas zooms.
- Layout + last project persist in `localStorage` (`cailyx.canvas`,
  `cailyx.lastProject`, `cailyx.cache.*`). Clear those keys for a cold render.

## 4. Smoke harness (optional, backend only)

```bash
cd backend && MEASUREMENT_ALLOW_MOCK=1 INTERNAL_LINK_ALLOW_FIXTURE=1 SERP_ALLOW_FIXTURE=1 bash smoke/run-all.sh
```

8 scripts, ~204 assertions, all against the running backend on :3002. The
`users` script can report `new password login failed` when the whole harness
runs back-to-back — that's the `/auth/login` throttle, not a regression; wait
~60s and run `bash smoke/users.smoke.sh` on its own to confirm.

## Notes

- Ports: AGENTS.md says the backend is on `:3001` — stale. `backend/.env` sets
  `PORT=3002`; that is the real port.
- Shell here is Git Bash on Windows. Kill a stuck backend by PID:
  `netstat -ano | grep :3002` → `taskkill //F //PID <pid>`.
- Never run `npm run build` in `backend/` while `start:dev` is watching — both
  write `dist/` and the race corrupts it (`Cannot find module dist/main`).
