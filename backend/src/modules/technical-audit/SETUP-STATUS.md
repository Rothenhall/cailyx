# Cailyx — Technical Audit: Setup Status

> **Date:** 2026-08-28
> **Status:** ALL INFRASTRUCTURE READY. Zero blocking dependencies.

---

## ✅ Everything is installed, configured, and verified

| # | Component | Version | Verified | Used for |
|---|---|---|---|---|
| 1 | Node.js | v22.22.2 | ✅ | Backend runtime |
| 2 | NestJS CLI | v11.0.24 | ✅ | Module scaffolding |
| 3 | Playwright + Chromium | v1.62.1 | ✅ | JS render diff check |
| 4 | axios | v1.20.0 | ✅ | HTTP fetches (fetcher) |
| 5 | ioredis | v6.0.0 | ✅ | Redis client (cache/rate-limit) |
| 6 | @nestjs/schedule | installed | ✅ | Cron scheduling |
| 7 | Docker | v29.7.2 | ✅ Running | Redis container |
| 8 | Redis (cailyx-redis) | port 6380 | ✅ PING → PONG | Caching, job queue, scheduling |
| 9 | Google PSI API key | configured in .env | ✅ LCP/CLS/Score returned | Core Web Vitals check |
| 10 | .env | fully configured | ✅ | All env vars set |
| 11 | .env.example | clean template | ✅ | Team sharing |
| 12 | docker-compose.yml | at Cailyx root | ✅ | Team: `docker compose up -d` |

---

## All 5 technical-audit checks — ready to build

| Check | External deps | Status |
|---|---|---|
| 1. robots.txt AI-bot blocks | None | ✅ Ready to build |
| 2. CDN AI-bot blocking probe | None | ✅ Ready to build |
| 3. JS render dependency | Playwright installed | ✅ Ready to build |
| 4. Core Web Vitals | PSI API key verified | ✅ Ready to build |
| 5. Scheduling/cadence | Redis running | ✅ Ready to build |

---

## Team setup (for when you share the repo)

```bash
git clone <repo>
cd Cailyx
docker compose up -d          # starts Redis on port 6380
cd backend
cp .env.example .env          # copy template
# Fill in PSI_API_KEY in .env
npm install
npm run start:dev
```

---

## What to build next

1. `fetcher` module (Phase 0 — all other modules depend on it)
2. `technical-audit` module (Phase 1 — first audit module)