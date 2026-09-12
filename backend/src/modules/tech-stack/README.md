# Tech Stack Module

> **Status:** ✅ Built
> **Wave:** 6, step 3 (`docs/analysis/wave-6-audit-pipeline.md` §D3/§4)
> **Spec:** [docs/analysis/tech-stack.md](../../../../docs/analysis/tech-stack.md), [LEFT-OUT.md](LEFT-OUT.md)

## Purpose

Detects the marketing/tech stack a domain runs — analytics, ads/tracking, CRM,
chat widgets, CMS, hosting, CDN, ecommerce platform, tag managers, A/B testing
tools — from data already available in one page fetch. Answers: **what is this
site built on, and what is it tracking with?**

Decision D3 (approved): a deterministic in-repo signature table beats a vendor
API here — no per-lookup cost, fully auditable, and it runs against *any*
domain, which is what lets wave-6 step 6 (competitors) reuse it unchanged.

## Architecture

```
tech-stack/
├── tech-stack.module.ts        # NestJS module — imports FetcherModule
├── tech-stack.service.ts       # resolveDomain, scanDomain, getLatest, detect()
├── tech-stack.controller.ts    # POST scan, GET latest
├── tech-stack.signatures.ts    # ~90-entry signature table, 10 categories
├── dto/tech-stack.dto.ts       # RunTechStackScanDto
├── README.md                   # This file
└── LEFT-OUT.md                 # Deferred scope
```

## How detection works

1. `FetcherService.fetch()` gets the domain's homepage — headers + raw HTML.
   One fetch, no headless render (D3's "no new dependency" boundary).
2. `cheerio` extracts: every `<script src>` URL, `<meta name="generator">`,
   plus the raw HTML text and every response header value.
3. Each `TechSignature` in `tech-stack.signatures.ts` is tested against
   whichever of those four signals it defines a pattern for. Any match records
   a `TechFinding` with the literal matched string as `evidence`.
4. Persisted as one `TechStackScan` (+ its `TechFinding[]`), keyed by
   `(projectId, domain)` — a domain override lets the same scan profile a
   competitor without a project of its own.

A fetch that is blocked, times out, or 4xx/5xxs is **not** an error response —
it's stored as `status: 'failed'` with `error` set. A site that blocks bots is
a real, reportable finding, not a crash.

## Built Features

| Feature | Status | Notes |
|---|---|---|
| Signature table | ✅ | ~90 signatures across analytics, ads, CRM, chat, CMS, hosting, CDN, ecommerce, tag-manager, A/B testing |
| Header matching | ✅ | Every response header value tested, not one named key — CDN identity varies by header |
| HTML/script/generator matching | ✅ | Script `src`, inline-page HTML, `<meta name="generator">` |
| Domain override | ✅ | `scanDomain`/`getLatest` accept any domain, not just the project's own — ready for step 6 |
| Failed-scan reporting | ✅ | Blocked/unreachable fetch stored as `status: 'failed'`, HTTP 200, never a 500 |
| Cookie-based signatures | ❌ Deferred | `FetcherService` does not parse `set-cookie` — see LEFT-OUT.md |
| JS-rendered tag detection | ❌ Deferred | Would need `fetcher.render()` (Playwright) — see LEFT-OUT.md |

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/projects/:id/tech-stack/scan` | 10/60s | Scan a domain (body: optional `domain`, defaults to project's own). Returns the result directly — no job/poll |
| `GET` | `/projects/:id/tech-stack?domain=` | 100/60s | `{ scan }` — latest stored scan for a domain (defaults to project's own), `scan: null` if none has run yet |

## Dependencies

- `FetcherModule` — the one HTTP fetch per scan.
- `cheerio` — already a backend dependency (used by aeo-audit, digital-presence, intake, technical-audit, page-analysis, mention-tracking).

No new npm packages, no env vars, no vendor credentials.

## Consumers

None yet. Wave-6 step 6 (`competitors` module, not yet built) is expected to
call `TechStackService.scanDomain(projectId, competitorDomain)` directly
(module exports it for that reason).

## Testing notes

See `backend/smoke/tech-stack.smoke.sh` for the automated check (throwaway
project, live scan against a real public domain, asserts on response shape
and at least one finding).
