# Left Out — Competitors Module

## 1. High-signal pages beyond the homepage

D4 says "crawl homepage + high-signal pages." v1 crawls the homepage only,
for both the tech scan (`TechStackService.scanDomain` is homepage-only by
design, wave-6 step 3) and the schema read (`FetcherService.fetchSchema`).

**Why left out rather than half-built:** `fetchSchema` does not surface the
underlying HTTP status, so a multi-page crawl cannot honestly distinguish "no
JSON-LD on this page" from "this page didn't load" without a second,
separate fetch per page — doubling the request count for a v1 that D4 already
scoped as "light now, structured to deepen later." The tech-stack scan's
`status`/`error` already gives an honest reachability signal for the
homepage, which the profile surfaces; extending that same honesty to
additional pages is exactly the kind of "deepen later" work the first-class
`CompetitorProfile` row exists to make easy — add a `pagesFetched: string[]`
loop against `/about`, `/pricing`, etc., without changing the storage shape.

## 2. Full `technical-audit` per competitor

Explicitly out of scope per D4. `technical-audit` is project-scoped
(sitemap crawl, Core Web Vitals via PageSpeed Insights, per-page findings);
making it domain-scoped so it could run against a competitor's site is a
larger refactor and its own future decision, not a side effect of this
module.

## 3. Triggering new SERP/AEO runs

This module only attaches SERP/AEO data that `serp-intelligence` and
`aeo-audit` have already produced. A competitor with no prior SERP tracker
or completed AEO audit for the project reports `serpStatus`/`aeoStatus:
"unknown"` — it never calls into either module to produce fresh data.

## 4. `AeoAudit`'s full relational shape

See README "A note on this worktree's `AeoAudit` model." This worktree adds
a scalar-only mirror of `AeoAudit` sufficient to read `verdict` back; the
real module's `SiteContext`/`AeoStance`/`AeoSurfaceRun` relations are not
reproduced here since nothing in this module reads them.

## 5. Confidence / ranking on the gap diff

`GapDiffLine` is a plain presence list (who has this tech/schema signature).
No weighting, scoring, or "how much this matters" ranking — D4 asks for an
honest comparison table, not an invented composite score.
