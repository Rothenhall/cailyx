# Cailyx — Technical Audit: External Requirements & Tools

> **Date:** 2026-08-28
> **Scope:** Everything needed outside of code to build and run the `technical-audit` module. APIs, keys, infrastructure, and tools — with and without Monid.

---

## 1. Requirements at a glance

| # | Need | What it's for | With Monid? | Without Monid (DIY) | Cost | Status |
|---|---|---|---|---|---|---|
| 1 | **fetcher module** | All HTTP/browser/AI fetching | N/A — internal | Build it (Phase 0) | Dev time | Spec written, not built |
| 2 | **Node.js + NestJS** | Backend framework | N/A | Already installed (Node 22 via Volta) | Free | ✅ Ready |
| 3 | **Redis** | Cache + rate-limit + job queue | N/A | Install locally or use cloud | Free (local) | ❌ Not installed |
| 4 | **BullMQ** | Job queue for scheduling | N/A | `npm install bullmq` | Free | ❌ Not installed |
| 5 | **Playwright** | Headless browser for JS render diff | N/A | `npm install playwright` + browser download | Free | ❌ Not installed |
| 6 | **Google PageSpeed Insights API key** | Core Web Vitals check (LCP, INP, CLS) | Monid may have a PSI endpoint — check `monid discover -q "pagespeed insights"` | Google Cloud project + enable PSI API | Free tier: 25,000 req/day | ❌ Not acquired |
| 7 | **AI crawler user-agent list** | Access probe — send requests with each UA | N/A — hardcoded in fetcher | Maintain the list manually | Free | ✅ Known (in fetcher spec) |
| 8 | **Outbound HTTP egress** | Probe client sites without being blocked | Monid's proxy endpoints may help | Your laptop IP (single-geo) or proxy service | Free (laptop) / paid (proxy) | ⚠️ Single-geo only |
| 9 | **Monid API key** (optional) | Access Monid's 100s of tools (scraping, search, data enrichment) | Required for Monid | Not needed if DIY | Pay-per-use (Monid balance) | ❌ Not acquired |

---

## 2. Detailed breakdown per check

### Check 1: robots.txt AI-bot blocks

**What it needs:**
- `fetcher.fetch("https://client.com/robots.txt")` — one HTTP GET
- Parse the text for `Disallow:` rules against each AI user-agent

**External dependencies:** NONE. Just HTTP.

**With Monid:** Not needed — this is a simple HTTP fetch.

**Without Monid:** `fetcher` does it with axios. Zero cost.

**Status:** ✅ Can build immediately once `fetcher` has `http.client.ts`.

---

### Check 2: CDN AI-bot blocking (header-sniff probe)

**What it needs:**
- `fetcher.probe(url, { userAgent: "GPTBot" })` → records HTTP status
- `fetcher.probe(url, { userAgent: "Browser" })` → records HTTP status
- Compare: if AI-bot gets 403/challenge and browser gets 200 → CDN block
- Repeat 3x for determinism

**External dependencies:**
- **Clean egress IP** — some WAFs block based on IP reputation, not just UA. Your laptop IP may work for most sites but could be flagged by aggressive WAFs (Cloudflare, Akamai).
- **Multiple user-agents** — the list lives in `fetcher` config, not external.

**With Monid:** Monid may have proxy/fetch endpoints that route through clean IPs. Check:
```bash
monid discover -q "fetch url with custom user agent"
monid discover -q "website accessibility check"
```

**Without Monid:**
- Start with your laptop IP (single-geo). Works for most sites.
- If you hit WAF blocks on your own IP, consider a rotating proxy service:
  - Bright Data, Smartproxy, or similar (~$50-100/mo for residential proxies)
  - Or a simple cloud VM (AWS/GCP) with a clean IP (~$5/mo)

**Status:** ⚠️ Can build now with single-geo. Multi-geo is a later improvement.

---

### Check 3: JS render dependency (Playwright)

**What it needs:**
- `fetcher.render(url, { jsDisabled: true })` → get HTML without JS
- `fetcher.render(url, { jsDisabled: false })` → get HTML with JS
- Diff the text content — if empty without JS, the site is JS-dependent

**External dependencies:**
- **Playwright** (headless browser engine)
- Chromium browser binary (Playwright downloads it)

**With Monid:** Monid might have a render/screenshot endpoint. Check:
```bash
monid discover -q "render webpage javascript"
monid discover -q "screenshot website"
```

**Without Monid:**
```bash
npm install playwright
npx playwright install chromium
```
- Disk: ~200MB for Chromium binary
- RAM: ~100-300MB per browser instance
- Can run 1-2 concurrent renders on a laptop

**Status:** ❌ Playwright not installed yet. One command to install.

---

### Check 4: Core Web Vitals (Google PSI API)

**What it needs:**
- `fetcher.callApi("psi", { url: "https://client.com/" })` → LCP, INP, CLS scores
- Google PageSpeed Insights API returns real-world + lab data

**External dependencies:**
- **Google Cloud project with PSI API enabled**
- **API key** (not OAuth — just a simple API key)

**With Monid:** Monid may have a PageSpeed or CWV endpoint. Check:
```bash
monid discover -q "google pagespeed insights"
monid discover -q "core web vitals"
```

**Without Monid (DIY):**
1. Go to https://console.cloud.google.com
2. Create a new project (or use existing)
3. Enable "PageSpeed Insights API"
4. Create an API key (APIs & Services → Credentials → Create Credentials → API Key)
5. Restrict the key to the PSI API only
6. Paste the key into Cailyx config

**Cost:** Free tier = 25,000 requests/day. Rate-limited per 100 seconds. Batch accordingly.

**Status:** ❌ Not acquired. This is the only hard external dependency for a check.

---

### Check 5: Scheduling/cadence

**What it needs:**
- BullMQ (job queue) running on Redis
- Per-project schedule config (weekly, monthly, manual)
- Manual "run now" trigger

**External dependencies:**
- **Redis** — local or cloud

**With Monid:** Not relevant — this is internal infrastructure.

**Without Monid:**
```bash
# Option A: Local Redis (Docker)
docker run -d --name cailyx-redis -p 6379:6379 redis:alpine

# Option B: Cloud Redis (Upstash free tier)
# https://upstash.com — free 10,000 commands/day
```

**Status:** ❌ Redis not running. Need Docker or cloud Redis.

---

## 3. Infrastructure checklist

| Item | Install command | Size | Required for | Status |
|---|---|---|---|---|
| Playwright + Chromium | `npm install playwright && npx playwright install chromium` | ~200MB | Check 3 (JS render) | ❌ |
| Redis | `docker run -d -p 6379:6379 redis:alpine` | ~40MB | Scheduling, caching | ❌ |
| BullMQ | `npm install bullmq` | npm package | Scheduling | ❌ (install with module) |
| Google PSI API key | Cloud Console setup | n/a | Check 4 (CWV) | ❌ |
| Monid API key | https://app.monid.ai/access/api-keys | n/a | Optional tool discovery | ❌ |

---

## 4. Two paths: with Monid vs without Monid

### Path A: Without Monid (pure DIY)

```
fetcher module (build first)
  ├── http.client.ts        → axios (installed with project)
  ├── browser.client.ts     → Playwright (need to install)
  ├── cache.service.ts      → Redis (need to install)
  ├── rate-limiter.ts       → Redis (same)
  ├── retry.service.ts      → no external dep
  ├── cost-tracker.ts       → no external dep
  └── adapters/
      └── psi.adapter.ts    → Google PSI API key (need to acquire)

External things to get:
  1. Install Playwright + Chromium     ← 1 command
  2. Install Redis (Docker)           ← 1 command
  3. Google PSI API key                ← 15 min in Google Cloud Console

That's it. Three things. Checks 1-3 work with just #1. Check 4 needs #3. Scheduling needs #2.
```

### Path B: With Monid (fills gaps)

```
fetcher module (build first, but some calls go through Monid)
  ├── http.client.ts        → axios (direct, no Monid needed)
  ├── browser.client.ts    → Monid render endpoint? (check discover)
  ├── cache.service.ts      → Redis (still needed locally)
  ├── adapters/
      ├── psi.adapter.ts    → Monid PSI endpoint? or direct Google API
      └── monid.adapter.ts  → NEW: routes requests through Monid when beneficial

External things to get:
  1. Monid API key                    ← 5 min at app.monid.ai
  2. Redis (Docker)                   ← 1 command
  3. Google PSI API key               ← only if Monid doesn't have a PSI endpoint
  4. Playwright                       ← only if Monid doesn't have a render endpoint

Monid's value: instead of building 5 different integrations, discover what Monid already
has and route through it. You might not need Playwright at all if Monid can render pages.
You might not need a PSI key if Monid has a CWV endpoint. You don't know until you search.
```

---

## 5. Recommended next steps

### Immediate (can do right now, no external deps):
1. ✅ SKILL.md saved to `.config`
2. ✅ Monid CLI installed (v0.1.6)
3. ⬜ Get Monid API key → `monid keys add -k <key> -l main`
4. ⬜ Run `monid discover -q "website audit"` to see what tools exist
5. ⬜ Run `monid discover -q "render webpage javascript"` — does Monid replace Playwright?
6. ⬜ Run `monid discover -q "pagespeed insights"` — does Monid replace the PSI key?

### Before coding technical-audit:
7. ⬜ Install Playwright + Chromium (if Monid doesn't have render)
8. ⬜ Install Redis via Docker (for scheduling)
9. ⬜ Get Google PSI API key (if Monid doesn't have CWV)
10. ⬜ Build `fetcher` module (Phase 0)

### Then:
11. ⬜ Build `technical-audit` module (calls fetcher, produces AuditFindings)

---

## 6. Decision needed from you

**Option 1 — Get Monid key first, discover what exists, then decide:**
- Get the key → run `monid discover` for each check → see which external deps Monid covers → only acquire/install what Monid doesn't have
- Advantage: might save you from installing Playwright or getting a PSI key
- Cost: Monid runs cost balance (pay-per-use)

**Option 2 — Skip Monid, install everything directly:**
- Install Playwright + Redis, get PSI key, build fetcher
- Advantage: no per-run costs, full control
- Cost: more setup, more maintenance

**My recommendation:** Option 1. Get the Monid key, spend 5 minutes discovering what exists. If Monid has render + CWV endpoints, you skip two setup steps. If it doesn't, you fall back to DIY. Either way you learn what's available before building.