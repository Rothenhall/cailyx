# Tech Stack — technology fingerprinting

> **Status:** ✅ Built (2026-09-12)
> **Wave:** 6, step 3
> **Decision:** already approved as D3 in
> [`wave-6-audit-pipeline.md`](wave-6-audit-pipeline.md) — option A, a
> deterministic in-repo fingerprinter. This doc records the build, not a new
> decision.

## What this is

Stage 3 of the delivery flow ("technology & marketing stack") had zero
coverage before this. This module answers: **what is this site built on, and
what is it tracking visitors with?** — CMS, ecommerce platform, hosting/CDN,
analytics, ads pixels, CRM/lead capture, chat widgets, tag managers, A/B
testing tools.

## Why in-repo, not a vendor (recap of D3)

Wappalyzer's API is paid per lookup and its open-source core was relicensed;
the `wappalyzer` npm package drags in an unmaintained fork and a heavy
Playwright dependency for something that does not need one. A signature table
over data `fetcher` already retrieves (headers, HTML, script tags) costs
nothing per lookup, is fully auditable (every finding carries the literal
matched string as evidence), and runs against any domain — which is what lets
the not-yet-built `competitors` module (wave-6 step 6) reuse it unchanged.

## Build notes (verified against the codebase, not assumed)

- `FetcherService.fetch()` returns headers and raw HTML but **does not parse
  `set-cookie`** into a distinct field — no cookie jar exists anywhere in the
  codebase. Cookie-based signatures (a common fingerprinting signal elsewhere)
  are out of scope for v1; see the module's `LEFT-OUT.md`.
- Script tags, inline script text and `<meta name="generator">` are not
  extracted by `fetcher` itself — every consumer (`aeo-context.service.ts`,
  `intake.service.ts`, `page-analysis.service.ts`) loads `res.body` into
  `cheerio` and parses it there; this module does the same rather than
  changing `fetcher`'s contract.
- `technical-audit.service.ts` already has header-based CDN detection
  (`detectCdnVendor`/`getCdnHeaderSignals`), but as **private methods** — not
  exported. Rather than refactor a module this one doesn't otherwise touch,
  `tech-stack.signatures.ts` carries its own small CDN/hosting header set in
  the same spirit.
- Verified live against `cloudflare.com` (own-homepage Cloudflare header
  detection) and an unresolvable domain (the honest-failure path) — see
  `backend/smoke/tech-stack.smoke.sh`.

## Left out

See `backend/src/modules/tech-stack/LEFT-OUT.md`: cookie-based signatures,
JS-rendered/client-injected tags (would need a Playwright render, which D3
rules out), and confidence weighting beyond a binary match.
