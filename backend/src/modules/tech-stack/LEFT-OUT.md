# Left Out — Tech Stack Module

## 1. Cookie-based signatures

Many fingerprinting tools use `set-cookie` names (e.g. `_shopify_y`,
`wordpress_logged_in_`) as a signal. `FetcherService.fetch()` does not parse
`set-cookie` into a distinct field — it would only appear incidentally inside
`headers['set-cookie']` (comma-joined, unreliable to split). Confirmed by grep:
no cookie jar exists anywhere in `fetcher`, `technical-audit`, `entity-audit`,
`aeo-audit`, or `digital-presence`.

**Why left out rather than half-built:** adding real cookie support means
adding it to `FetcherService` itself (a shared module every audit depends on),
which is a bigger, separate change than this module's scope. The signature
table is header/HTML/script-only for v1; every signature was chosen to have at
least one non-cookie signal, so detection quality is not compromised — just
narrower for stacks that only ever expose themselves via a cookie name.

## 2. JS-rendered / client-injected tags

A tag that a site's own JavaScript injects only in the browser (not present in
the raw HTML fetcher returns) is invisible to this module. `fetcher.render()`
(Playwright) would see it, but D3 explicitly chose the no-headless-render
option ("no new dependency, no per-lookup cost") — adding a render pass here
would reintroduce the cost D3 was written to avoid.

**Future path, if needed:** an optional `deep: true` scan flag that falls back
to `fetcher.render()` when the fast pass finds nothing — not built now.

## 3. Confidence scoring

`TechFinding.confidence` exists in the schema but every signature match is
recorded at `1` today — matches are binary (found the pattern or didn't).
Reserved for a future pass that could, e.g., score a weak single-header match
lower than a script-src + generator double match for the same vendor.
