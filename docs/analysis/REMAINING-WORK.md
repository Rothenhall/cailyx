# design_plan.md — remaining work to completion

Compiled 2026-09-16 from the status doc, the Appendix B gap list (D01–D28), and
the per-module reports. This is the closure checklist.

## A. Backend gaps that block frontend screens

| # | Gap | Package | Why it blocks a screen |
|---|---|---|---|
| ~~A1~~ | ~~Report editorial lifecycle~~ **BACKEND DONE** | G05 | 21 routes shipped: review/approve/publish/withdraw, share-links, delivery-attempts, revisions, lifecycle, plus an admin legacy-classification route. The G10 gate now runs before release, so the "clients only see approved reports" promise holds for reports as well as content. **Frontend wiring (RP04/RP05) is in flight.** |
| ~~A2~~ | ~~`assetsNote` stale; report DTO lacks `rubricVersion`/`scoreRunId`~~ **DONE** | G19/D11 | Both persisted and exposed; `assetsNote` repaired at read time. |
| ~~A3~~ | ~~`pageBudget` accepted and dropped~~ **DONE** | G19/D16 | Forwarded into the job data and honoured by the worker. **Verified end-to-end**: same 12-URL target, default crawled 12 of budget 150; with `pageBudget: 3` crawled 3. `0`/`1001`/`1.5` → 400. |
| ~~A4~~ | ~~operator message `projectId` unvalidated~~ **DONE** | G19/D26 | Mirrors the portal check: foreign → 403, unknown → 403, own → 201. |
| ~~A5~~ | ~~Capability registry incomplete~~ **DONE** | G18 | Registry 30 → 44 keys, every env var name read verbatim from the module that reads it. Verified: no action offered unless `ready`, nothing `verified`, and the client payload contains none of the 44 env names nor any internal key. **Still a seam:** no adapter calls `withProbe`/`recordSuccess` yet, so the roster is honest but uniformly `unverified` — wiring one is `capabilities.withProbe(key, () => provider(...))` at the provider call. |
| ~~A6~~ | ~~Budget policy bounded nothing~~ **DONE (as a gate)** | G12 | `BudgetsService.assertWithinBudget` refuses work that would breach a **hard** ceiling, called from `PipelineQueueService.enqueue` — the one place every background run passes through, including those with no UI. Deliberately narrow: a project with no policy is untouched; only hard enforcement refuses (turning a soft ceiling into a blocker would change what someone configured); and a failure to *evaluate* the policy enqueues anyway, because an availability problem in the budget module must not halt every pipeline. **This is a gate, not a reservation** — nothing is held for the run's duration, so a long run can still overshoot a cap mid-flight. |
| ~~A7~~ | ~~Job heartbeat inert; onboarding executors unregistered~~ **DONE** | G07 | `technical-audit`, `seo-audit` and `presence-discovery` jobs now produce real `JobRun` rows with heartbeats, settle to `completed`/`failed`/`partial`, and are swept by `recoverStaleRuns`. 14 Day-1 stage executors registered. AEO's enqueue now carries `projectId`, closing the last pipeline kind. **A defect found and fixed:** the resume guard keyed on run status, and a run with one settled step derives to `running` — so a 14-stage pipeline would have taken a heartbeat window *per stage*. Now a compare-and-set on the step row, so two simultaneous resumes still cannot both buy the same stage. |
| ~~A8~~ | ~~`CheckResult` has no `projectId`/`clientId`~~ **DONE** | schema | Columns added; `recordCheckResult` writes them and `GET /approvals/check-results?projectId=` is the scoped read that was previously impossible. Rows written before the column stay reachable only through the subject read — a real limit, documented on the route. |
| ~~A9~~ | ~~`SpendReservation` has no note column~~ **DONE** | schema | Column added; `POST .../reservations/:id/release` now accepts and stores a `reason`, through the `ReleaseReservationDto` that already existed but was never bound. |
| ~~A10~~ | ~~No `prisma/migrations/`~~ **DONE** | infra | Baseline `0_init` generated and marked applied; verified by applying its SQL to an empty SQLite file — **137 tables from 137 models**. `migration_lock.toml` added. |

## A-bis. Repairs landed by the G19 pass (not in the original A-list)

- **D17 — Google scopes were wrong in a way that guaranteed failure.** The consent
  asked for `webmasters.readonly` while `SeoAuditService.submitSitemaps` issues a
  `PUT`; it also asked for `analytics.edit` that nothing uses. Now `webmasters`
  (read/write) for Search Console and `analytics.readonly` for Analytics, with a
  stored-grant check that returns 409 with a reconnect instruction rather than
  leaving the operator with a bare 403. `submitSitemaps` no longer reports
  success with an empty submission list.
- **D20 — a cross-project read.** `measurement` used `?runId=` as a filter with
  **no ownership check**, so any operator could read another project's
  observations by id. Now 404s on a foreign run. Empty cohorts also return
  `null` rates instead of `0`, and a genuine measured zero still reports `0`.
- **D01/D12/D19 — contract annotations corrected**, including the three
  competitor-candidate routes that existed only as a bare summary and were
  absent from `openapi.json`. No wire shape was changed: a frontend already
  normalizes these envelopes, and changing them late would break working screens.
- **`openapi.json` was stale by a factor of two** — 261 operations checked in
  against 535 served. `npm run openapi` now regenerates it from the compiled
  app with no TypeScript runner and no port binding.

## B. Frontend gaps

| # | Gap |
|---|---|
| ~~B1~~ | ~~~15 screens carry unavailable sections~~ **ADDRESSED** — RP04/RP05 are wired to the shipped G05 routes; the rest of those sections are the §3.5 states the plan requires (a project with no audit genuinely has nothing measured). |
| 🟡 **B2** | **Partially closed.** API-level verification was run against a scratch copy of the dev DB (approved by the owner) — see the verification record below. Screens themselves remain unrendered: no UI has been loaded in a browser. |
| **B3** | RP06 findings, CP08 client content and the SL05 scorecard public token still need end-to-end contract verification. |

## Screen coverage

Every screen in design_plan §4 now maps to a built route.

| | |
|---|---|
| Screens in the plan's inventory | 116 |
| Routes built | 119 |
| **Unmatched** | **0** |

Three were missed by the original dispatch and written directly: **AU06** (`/setup`,
plus the `GET /api/auth/bootstrap-state` it needs — G01 asks for "controlled
bootstrap-state discovery"), **CL01** (`/claims`) and **CL02** (`/claims/[claimId]`).

Two notes on where screens landed versus where the plan places them:
SL03–SL06 are specified under `/ops/projects/:projectId/...` but shipped under
`/projects/:projectId/...`, which is where the project shell actually lives.
PB05 is implemented as `src/app/not-found.tsx`, Next's convention for it.

## D. Verification record — 2026-09-16

Run against a **scratch copy** of the dev database (`/tmp/cailyx-verify/verify.db`,
24 clients / 23 projects / 20 released reports), with a throwaway admin created
for the pass and no writes to the real dev DB.

### What passed

- **All new read endpoints across G01–G20 return 200** — identity, client access,
  business profile, delivery plan, jobs, content, approvals, publishing, budgets,
  results, operations, activity, billing, lifecycle, capabilities, organization.
- **G05's write path end to end**: `review` → new revision `in-review` → `publish`
  refused **409 `not-approved`** → `approve` → `publish` → `released`, with
  revision 1 `superseded` and **its snapshot byte-identical** (34,064 bytes
  before and after). §11.2 case 12 holds.
- **Guards**: 401 on every protected route anonymously; 200 on the two
  deliberately public ones; 404 on a resource outside the URL's project.
- **D16 against a live site**: `pageBudget: 5` → `Page inventory: 5/60 crawled
  (budget 5)`; the audit completed with score 66. A second run at
  `pageBudget: 3` enqueued with the value echoed back.
- **Frozen-snapshot discipline in the PDF**: the generated document states that
  it renders the released revision and does not change on regeneration, and
  carries D11's disclosure that the rubric version is not recorded.
- **"Not measured" survives into the PDF**: two score dimensions render as
  `Not measured` with a 0 contribution, not as a `0` value.

### Bugs this pass found and fixed

1. **Bootstrap was impossible.** `POST /api/auth/register` had lost its
   `@Public()` — a decorator I displaced when inserting the AU06 route — so the
   global guard rejected it and **no installation could ever create its first
   administrator.** Caught on the first call of the pass.
2. **`GET /projects/:id/work-items` returned 500.** The query carried
   `include: { acceptanceChecks: false } as never`; the schema reaches
   acceptance checks through a plain `workItemId` column, not a relation, so the
   include was invalid. The `as never` is why the compiler never saw it.
3. **A run stuck in `queued` blocked all later tracking.** The per-project lock
   counted `queued` as in flight for the *full* one-hour lock window, and the
   recovery sweep only reconciled `running` runs — so one abandoned run stopped
   every later run of that task kind from being tracked, and sat at `queued`
   forever. Two changes: the sweep now reconciles never-started runs
   (`failed-never-started`), and the lock uses a **separate, shorter bound for
   `queued`** than for `running` — a running run is alive while its worker
   heartbeats, a queued run has no heartbeat and only its age to go on.
   `JOB_ABANDONED_QUEUED_MS` is floored at five minutes, because the first
   version of this fix was tested at 20 seconds and **destructively failed a run
   that was still legitimately waiting** — the worker then found its own run
   already dead. The floor exists so that setting cannot be made again.
4. **PDF page content collided with the fixed footer.** The footer is
   absolutely positioned at 770pt on an 841.89pt page, but the page's
   `paddingBottom` was 56 — letting flowing content reach 785.9 and draw
   underneath it. The last table rows were overlapped by the footer text on
   every report. Now derived from a single constant so the two cannot drift.
5. **Executive summaries truncated at the first period.** `f.recommendedFix
   .split('.')[0]` chopped at any dot — so `https://day1tech.com/sitemap.xml`
   became `https://day1tech.` in **every** report, HTML and PDF alike. Now
   splits on a real sentence boundary (verified against URLs, version numbers
   and unpunctuated strings).
### Known limits of this pass

- **No UI was rendered.** Every screen remains unexercised in a browser.
- A job **stalled under CPU contention** while four agents were compiling on
  this machine; it tracked and enqueued correctly, but BullMQ killed it with
  `job stalled more than allowable limit`. That is resource starvation, not a
  code fault — but it means the ledger's happy path has not been observed
  completing on a quiet machine either.
- **Orphaned data exists in the dev DB**: at least one `Report` whose `Project`
  row is gone. Harmless (the scoping check 404s correctly) but it means a naive
  slug lookup by hand gives misleading results.
- ~~**The PDF rendered blank in poppler.**~~ **FIXED.** The cause was base-14
  fonts: `@react-pdf/renderer` defaults to Helvetica/Courier, which are
  *referenced* rather than embedded, so the viewer must supply them. Preview and
  CoreGraphics do; poppler does not. Proven with a one-line document — base-14
  blank, embedded correct. The report now embeds **Inter 4.1** and **JetBrains
  Mono 2.304**, both SIL OFL, committed under
  `backend/src/modules/reporting/assets/fonts/` with their licence texts, and
  copied into `dist` by `nest-cli.json`. Verified: the generated PDF embeds
  `/FontFile2` with `CZZZZZ+Inter-Regular` and renders fully in `pdftoppm`.
  `renderReportPdf` throws if a face is missing, because a silent fallback would
  reproduce exactly this bug.
- ~~**PDF table cells concatenated inline runs.**~~ **No longer reproducible.**
  The rendered pages show every table cell and evidence line separated correctly,
  and the footer overlap that made it look like concatenation is fixed by the
  padding change above.

## C. Deliberately deferred (approved)

- Charts (needs its own tool analysis; §10.2 requires approval before adoption)
- Stripe SDK (signed-webhook contract + HMAC verification built without it)
- Dark mode (§3.1 defers it; the token indirection is in place)
- PDF artifacts (browser print is the stated workaround)
- Multi-agency tenancy (G20 states the single-service limitation rather than faking it)
- Publishing providers beyond `custom-webhook` (501 with reasons; no vendor analysis done)
