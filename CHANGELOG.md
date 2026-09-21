# Cailyx — Changelog

A running record of what has been built. Newest first. Each entry: what shipped,
how it was verified, and what it left for later.

Keep this current on every meaningful change. Companion docs:
`docs/MODULES-STATUS.md` (module-by-module state), `docs/PRODUCTION-READINESS.md`
(what's needed to go live), `docs/API.md` (endpoint reference).

---

## 2026-09-22 — Discoverability pipeline: Stage 2 competitor-discovery query patterns

Full plan: `docs/analysis/discoverability-pipeline-plan.md` (Stage 2). Extends
`competitors.service.ts::discoverByMarket`'s paid pass (`collectNew: true`) from a
single `"{service} in {market}"` query set into three passes, so discovery seeds
*branded* competitor names (for Stage 3's head-to-head/alternatives buckets) and
diversifies evidence for Stage 4 scoring:

1. **Name-independent SERP (spec §6.4):** adds `best {service} tools for {icp}`,
   `{service} for {industry}`, `{service} vendors {market}` (icp = confirmed ICP
   segment, industry = confirmed category), deduped, bounded.
2. **Comparison SERP (spec §6.1):** one `"<name>" alternatives` per branded name the
   first pass surfaced (`pickComparisonSeeds` — real names, not bare domains), using
   the remaining budget (`MAX_COMPARISON_QUERIES = 2`).
3. **Review-site category pull (spec §6.1):** best-effort G2 `/categories/<slug>` pull
   with a **headless `render()` fallback** when the plain fetch is bot-blocked;
   `looksLikeReviewListing` rejects Cloudflare/JS-shell pages so a block is never
   parsed as data, `parseG2CategoryListing` extracts product names. Bounded by
   `MAX_REVIEW_SITE_PULLS = 2`; never blocks discovery.

Two new `evidenceKind`s (`serp-comparison-search`, `review-site-category`) join the
existing three; the result gains `reviewSitesPulled`. No schema change, no new
dependency (reuses `FetcherService` + `cheerio`).

**Known caveat (plan under-weighted this):** G2/Capterra Cloudflare protection can
defeat even the headless fallback, so `review-site-category` may often be empty in
practice — it's wired end-to-end for when it lands, not a primary source; a paid
G2/Capterra API is the real fix (follow-up).

`npx tsc --noEmit` + `nest build` clean. New pure logic unit-verified 8/8
(`dedupeStrings`, `pickComparisonSeeds`, `looksLikeReviewListing`,
`parseG2CategoryListing`). A full live `discoverByMarket` run was not executed — it
uses the paid DataForSEO SERP path (fixture-only test posture per `SERP_ALLOW_FIXTURE=1`),
and the SERP wiring reuses the already-working `serpForDiscovery` path unchanged.
`backend/src/modules/competitors/README.md` + `docs/API.md` updated.

## 2026-09-22 — Discoverability pipeline: prompt coverage-gap report + cross-bucket dedup (Stage 3 fixes #2–3)

Full plan: `docs/analysis/discoverability-pipeline-plan.md` (Stage 3, steps 2–3).

- **Coverage-gap report (spec §5.3):** `computeCoverageGaps(ctx, cells)` in
  `aeo-matrix.generator.ts` reports the confirmed `services`/`icp`/`markets` that
  reached no generated prompt (whole-word match, so a short market code isn't matched
  inside another word). Surfaced on `GeneratedMatrix.coverageGaps` and persisted into
  the `QuerySet.label` JSON next to `skipped`. The generator only interpolates the
  primary `ctx.geo`, so extra confirmed markets legitimately surface as gaps — the exact
  "geos with zero prompts" signal §5.3 wants.
- **Cross-bucket near-duplicate dedup (spec §3.3):** the existing `seenPrompts` set only
  caught exact-lowercase dupes; added `dedupKey(prompt)` (lowercase, strip punctuation,
  drop stopwords, sort tokens) + a `seenDedupKeys` set so near-identical phrasing across
  dimensions ("downsides of payroll" vs "payroll downsides") collapses to the first
  occurrence.

No schema change. `npx tsc --noEmit` + `nest build` clean. Verified via `generateMatrix`
(pure, 8/8): dedupKey collapses order/stopword variants but keeps distinct content;
coverage flags an un-targeted market but not the used service/ICP; no two generated cells
share a dedupKey. `backend/src/modules/aeo-audit/README.md` updated.

## 2026-09-22 — Discoverability pipeline: objection-trust branding split (Stage 3 fix #1)

Full plan: `docs/analysis/discoverability-pipeline-plan.md` (Stage 3, step 1).

`aeo-matrix.generator.ts` tagged every `objection-trust` cell `branded` via the
per-dimension `DIMENSION_BRANDING` map, but the spec (§3.3) wants that dimension to
carry both a branded variant ("is {client} legit") *and* an unbranded one ("downsides
of {category}"), tagged individually — and one of its own templates was already
unbranded yet mis-tagged. Added an optional per-template `branding` override; the
generation loop now uses `template.branding ?? DIMENSION_BRANDING[dimension]`. Tagged
`objection-trust`'s templates individually (3 branded that name the client, 3 unbranded
category/service framings incl. the spec's canonical "downsides of {category}").
Confirmed the other two branded dimensions (`head-to-head`, `brand-direct`) are
genuinely uniform (every template names the brand), so no per-cell change was needed
there. No schema change (`MatrixCell.meta.branding` was already per-cell).

`npx tsc --noEmit` + `nest build` clean. Verified by calling `generateMatrix` directly
(pure function, no DB): a `standard`-tier matrix produced 3 branded + 3 unbranded
`objection-trust` cells, brand named iff branded, `head-to-head` still all branded.
`backend/src/modules/aeo-audit/README.md` dimension table updated.

## 2026-09-22 — Discoverability pipeline: brand-voice verification-status fix (Step 1)

Full plan: `docs/analysis/discoverability-pipeline-plan.md` (Recommended build order,
step 1). First and most independent fix of the discoverability-pipeline second half.

`digital-presence`'s `socialActivity()` (the paid Apify scrape trigger) filtered
accounts with `state: { not: 'candidate' }`, which scraped `unverified` and
`needs-confirmation` accounts too — not just verified ones. Per the workflow spec's
Brand-Voice Quality Rule #1 ("only scrape channels that cleared identity
verification"), scraping an unverified account risks building a brand voice from a
different company's posts. Changed the query to `state: 'confirmed'` (the only
cleared-verification state — the vocabulary here is `candidate | unverified |
needs-confirmation | confirmed`; no `probable`/`verified` alias). Left the sibling
SERP-sweep "already held" query (`state: { not: 'candidate' }`) untouched — that's a
dedup set of found platforms, where counting an unverified find is correct.

No schema change, no new dependency. `npx tsc --noEmit` clean. Verified live against
the prod DB (Docker was unavailable locally this session, so verification ran against
Supabase prod with the user's approval, service/DB-level not the shell smoke suites —
`smoke@cailyx.test` doesn't exist on prod and a test admin wasn't created there):
seeded a labelled test project with all four account states, confirmed the fixed query
returns only the 1 `confirmed` account vs the old filter's 3. Test data cleaned up.
`backend/src/modules/digital-presence/README.md` updated.

## 2026-09-22 — Site Context Pipeline v2 Phase 1: JSON-LD, fact types/confidence, category consolidation, identity resolution

Full decision record: `docs/analysis/site-context-v2.md`. Reworks
`AeoContextService` (`backend/src/modules/aeo-audit/aeo-context.service.ts`)
so `SiteContext` can become the shared company-context foundation for other
modules (content, personas, keyword research), not just an AEO-audit input —
that consumer migration is tracked as follow-up work, not done here.

No new external tools/vendors — reuses `cheerio`, `FetcherService`, and the
existing `AeoLlmService` (OpenRouter). `npx tsc --noEmit` clean across the
whole backend; Prisma client regenerated for the schema change (`facts`,
`identityType`, `identityConfidence`, `completeness`, `overallCompleteness`,
`socialProfiles` on `SiteContext`; `factType`/`confidence` on
`SiteContextFact`; `jsonLd` on `SiteContextRunPage`; new
`SiteContextCategorySummary` model). Applied identically to `schema.prisma`
and `schema.production.prisma`.

- **JSON-LD/schema.org parsing** — new stage-2 extraction of
  `Organization`/`LocalBusiness`/etc. blocks into cited facts (`legalName`,
  `alternateName`, `foundedYear`, `headquarters`, `contact`, `leadership`,
  `award`).
- **Expanded fact taxonomy** — `FactField` grew from 10 to 25 values; every
  previously-unguided LLM extraction field (`painPoints`, `outcomes`,
  `category`, `vertical`) now has explicit prompt guidance.
- **Fact type + confidence scoring** — every fact carries `factType`
  (explicit/strong-inference/weak-inference/conflicted) and a `confidence`
  computed from factType + citing-page authority + cross-source
  corroboration, never the LLM's bare self-report.
- **Category-level consolidation** — new stage 7, one bounded LLM call
  producing a `SiteContextCategorySummary` per category (facts, conflicts,
  missing fields, confidence).
- **Identity resolution** — flags when a site's declared legal/brand name
  doesn't match the Cailyx project name on record (`identityType`).
- **Digital-presence merge** — confirmed social accounts read into
  `SiteContext.socialProfiles`, read-only, no new coupling.
- **Weighted completeness scoring** — per-category + overall (§22 weights).
- **Broader discovery** — `robots.txt` `Sitemap:` directives, more fallback
  sitemap paths, 5 new page-type classes (leadership/security/press/careers/partner).

**Bug found and fixed along the way**: `AeoLlmService`'s OpenRouter calls had
no `reasoning: { enabled: false }` flag. The current default model
(`deepseek/deepseek-v4.1-flash`) is a reasoning model that can burn its
entire `max_tokens` budget on hidden chain-of-thought before writing any
content, returning empty output that surfaced as "model returned non-JSON."
Confirmed live via a direct OpenRouter call. This predates this work and was
silently degrading any call in the module with a long/hard enough prompt —
fixed unconditionally for every caller, not just the new code.

Verified: live end-to-end run against basecamp.com (real site, real
OpenRouter call) — correctly extracted legal name "37signals LLC",
leadership, business model; correctly flagged `identityType: "subsidiary"`
(a real, accurate catch — Basecamp *is* legally 37signals LLC). All four
affected smoke suites re-run clean: `aeo-context-staged.smoke.sh` (44/44),
`aeo-audit.smoke.sh` (59/59, 1 intentional skip), `competitors.smoke.sh`
(20/20), `competitors-unified.smoke.sh` (33/33). Found and fixed a real
gating bug during this verification: the new consolidation stage initially
ignored `run.refine: false`, which would have broken the "this run never
calls an LLM" guarantee an existing smoke suite depends on.

Left for later: a real Postgres migration (blocked on a pre-existing
`migration_lock.toml` provider drift — still says `sqlite` while both schema
files target Postgres, not introduced by this change); re-running the AEO
stance-judging model benchmark now that the reasoning bug is fixed; Phase 2
(social/external enrichment, bounded research agent, independent verifier);
migrating `persona`/`content`/`growth-execution`/`keyword-research` onto
`BusinessProfileService.getConfirmedProfile()` instead of raw `Project`
columns — the actual "make this the base for everything" step.

---

## 2026-09-22 — Client Portal Phase C6: governance, cost control & security (verified 18/18 against live prod)

Full decision record: `docs/analysis/client-portal.md` §§28/29/31. Build order: `docs/PLAN.md`
§11.6. Full write-up: `backend/src/modules/business-profile/README.md` (§29),
`backend/src/modules/reporting/README.md` (§31), `docs/API.md` (C6 section),
`docs/MODULES-STATUS.md` (Wave 7). Branch `phase-c6-governance` — committed locally, **not merged,
not pushed**.

All three C6 items shipped as code; `npx tsc --noEmit` clean (`backend/`) and `npm run typecheck`
clean (`web/`), Prisma client regenerated for the schema change.

- **§29 — competitor cap** (`business-profile`): the number of competitors a client can directly
  add is now capped per plan tier — `starter` 5 / `growth` 15 / `scale` 50 / `enterprise` unlimited
  (proposed by this build; §29 left the numbers open — all in
  `business-profile/lib/competitor-cap.util.ts`, retunable). `saveDraft` blocks only a save that
  *increases* the count past the cap, reads `Client.planTier` directly, and rejects with a
  `CompetitorCapExceededException` (422, machine-readable body) that the portal renders as an
  upsell. Finished the small preserved skeleton on branch `worktree-agent-a1e4e5fbfd6f6fcbe` rather
  than rebuilding it.
- **§31 — public report-link password** (`reporting`): the token share link already had expiry +
  revocation; added the optional **password** (`ReportShareLink.passwordHash`, bcrypt cost 10).
  Optional `password` on link creation; a public password-prompt page on the token render; a new
  `POST /api/reports/shared/:token/unlock` that verifies the password and sets a 30-min HttpOnly,
  path-scoped, HMAC-`JWT_SECRET`-signed unlock cookie (keeps the password out of URLs; lets the
  `.pdf` download without re-prompting; the PDF route 401s while locked). No new dependency, no new
  env var. Operator UI: password field + "Password" pill on the report review screen. Deliberately
  the token surface, not `scorecard`'s simpler unguessable-only token (per §31).
- **§28 — data-freshness labeling** (`web/` only): a shared `AsOf` component threaded into the
  client Performance panels (Technical / Organic / AI), Competitors (its one-off date formatter
  normalized onto the shared helper), and the read-only Digital Marketing pages (Brand Profile,
  Brand Voice, Ideation). Not applied to the frozen report reader (its figures are "as released",
  not "as of today") or to Dashboard/Results (already carried freshness signals).

**Verification — PASSED 18/18 (2026-09-22), real code, not simulated.** Docker Desktop would not
start headlessly (its WSL engine stayed `Stopped` ~15 min; a first-run instance needs interactive
acceptance), so with the user's explicit approval the run went against the Supabase **prod** Postgres
(pooled URL — the direct/IPv6 URL is unreachable). The app was **not** booted (so no `@Cron` sweeps —
payment-failure, refresh-cadence — could fire against prod); the real compiled `BusinessProfileService`
and `ReportLifecycleService` were instantiated directly against prod, matching C7's "compiled code,
live DB" precedent. §29: 5/5 (422 cap at starter with the exact upsell body, allow 5, block 5→6,
allow decrease, growth lifts the cap). §31: 13/13 (password gate 401 vs dead-link 404, wrong/right
password, peek, unlock-grant sign/verify/tamper/other-id/via-cookie, no-password link, expiry→404,
revoke→404). §28 covered by the passing web production build. Full transcript in each module README.

**Prod drift caught & partly fixed:** the prod DB was behind `main` — missing `Client.planTier` (C7)
and `BusinessProfile.category` (C2), and `planTier` was absent from `schema.production.prisma`
entirely. Added the three columns to prod as idempotent additive `ALTER`s and added `planTier` to
`schema.production.prisma`. A full prod schema reconcile is a separate ops task
(`docs/PRODUCTION-READINESS.md`). Test fixtures were left on prod, labelled `ZZ-C6-VERIFY-*`.

Still open: merge `phase-c6-governance` (not merged, not pushed) and remove the `ZZ-C6-VERIFY-*`
prod test rows.

## 2026-09-21 — Client Portal Phase C3: engagement Phase grouping (Option B)

Full decision record: `docs/analysis/engagement-timeline.md`. Full write-up:
`backend/src/modules/delivery-plan/README.md` ("Phases (C3, Option B)" section, PRD alignment
table, dedicated C3 testing-notes addendum), `docs/API.md`, `docs/MODULES-STATUS.md` (Wave 7).

Option A (relabel `Cycle` client-facing as "Phase") was approved first, then tried and rejected:
`Cycle` is a recurring ~30-day work-period concept — its own README already documents the
commit/freeze/scope-change semantics — not a linear engagement stage, and `plan/page.tsx` already
carried a deliberate comment explaining why the client reads `Cycle` as "work period" for exactly
this reason. Built **Option B** instead:

- **Backend** (`delivery-plan` module — no new module): a new, minimal `Phase` model (`name`,
  `order`, a display-only `status` with no transition table) that `Cycle`/`Commitment` optionally
  reference via a nullable, additive `phaseId`. No new lifecycle or approval mechanics — Phase
  inherits everything `Commitment`/`ApprovalRequest` already enforce. CRUD + assign/unassign under
  `/api/projects/:projectId/phases`; a new client-portal route
  `GET /api/portal/projects/:projectId/plan/phases` serves each phase's assigned cycles/commitments
  through the existing `PortalCycleDto`/`PortalCommitmentDto` allowlists (served separately from
  `/plan`, same precedent P11 set for `/plan/commitments`).
- **Frontend**: a Phases panel + per-cycle phase-assignment dropdown on the operator cycles board,
  a phase-assignment dropdown per commitment on the roadmap's 30-day-plan section, and a new "Your
  engagement" section on the client plan page. No new nav entry (matches this app's existing
  navigation discipline against duplicate object lists). Rothenhall's `Diagnose → Build → Operate →
  Compound` language is offered as an optional, renameable prefill suggestion
  (`SUGGESTED_PHASE_NAMES`), never a locked-in enum.
- **Verified live** against a real Postgres instance on an isolated port (to avoid another
  concurrently-running backend instance on the shared default dev port): created a client/project,
  two phases, a cycle and a commitment; assigned and unassigned both; confirmed the
  both-or-neither-id 409 and the foreign-project 404; confirmed the client-portal read-back through
  a real client login. Caught and fixed a real bug in the same pass: `CommitmentDto`'s mapper never
  actually mapped the new `phaseId` field despite the type declaring it (`Cycle`'s row-spread
  mapper had it automatically) — `tsc` didn't catch it because only the type was updated in the
  first commit; the live read-back did. `npx tsc --noEmit` clean in both `backend/` and `web/`.
- **Left for later**: no dedicated smoke script for Phase yet (the live run above stands in for
  one this pass); a proper Prisma migration file is still blocked on the pre-existing
  `migrate dev` P3019 sqlite/postgres `migration_lock.toml` mismatch (`prisma db push` used
  instead, same workaround C1 already documented).

---

## 2026-09-21 — Client Portal Phase C5 (client lifecycle, payment-failure grace period, ownership transfer, seat permission gap)

Full decision record: `docs/analysis/client-portal.md` §§5/23/27/30/32. Build order:
`docs/PLAN.md` §11.5. Full write-up: `backend/src/modules/clients/README.md` (C5 section, PRD
alignment, testing notes), `backend/src/modules/billing/README.md` (C5 addendum),
`backend/src/modules/approvals/README.md` (C5 addendum), `docs/API.md`, `docs/MODULES-STATUS.md`
(Wave 7). Continued from a prior partial attempt that had only added the `Client.status` doc
comment and `Subscription.pastDueSince` + index (both already merged to `main`, reused as-is).

- **Suspend/reactivate (§5/§23):** `POST /clients/:clientId/suspend` (admin-only) — sets
  `Client.status = "suspended"` and immediately revokes every Google connection reachable through
  any of the client's projects, via the existing `GoogleDelegationService.disconnect()` (real
  revoke at Google + local delete, not just "stop calling"). `POST /clients/:clientId/reactivate`
  flips status back to `active` without restoring Google access — the client reconnects each
  project's GSC/GA4 from scratch, per §23's accepted tradeoff. Both write an `ActivityEvent`
  (`'suspended'`/`'reactivated'`, new `ActivityAction` values).
- **Payment-failure grace period (§30):** `StripeWebhookService.onInvoiceFailed` (already handled
  `invoice.payment_failed`) now stamps `Subscription.pastDueSince` once per grace window (never
  bumped by a retry) and clears it on recovery; `onSubscriptionUpserted` does the same and also
  accepts the literal event `customer.subscription.past_due`. New
  `billing/payment-failure-sweep.service.ts` (`PaymentFailureSweepService`) — an hourly in-process
  cron, same pattern as `publishing`/`seo-audit`'s existing schedulers — auto-suspends any client
  whose subscription has sat past-due longer than `BILLING_GRACE_PERIOD_DAYS` (default 21), via
  the exact same `suspendClient()` path an admin's manual suspend uses. New env vars:
  `BILLING_GRACE_PERIOD_DAYS`, `BILLING_GRACE_PERIOD_SWEEP_ENABLED` (added to `.env.example`).
- **Ownership transfer (§32):** `POST /clients/:clientId/transfer-ownership` (admin-only) —
  reassigns `Client.contactName`/`contactEmail` from an existing client seat or raw contact
  fields, audit-logged (`'ownership-transferred'`, new `ActivityAction` value).
- **Client seat permissions (§27):** audited the existing surface — seat/invite management was
  already `client-admin`-only. The one real gap was `POST /api/portal/approvals/:id/decision`
  (content approval before publish), now gated to `client-admin` seats; `client-collaborator`
  seats keep view access. `approvals.service.ts` itself untouched — the gate lives in the
  controller, via `ClientAccessService.resolveMembership`, the same pattern
  `client-access.controller.ts` already uses for its own client-admin-only routes.

**Verified live** against a real local Postgres (isolated throwaway database, since this
environment runs several concurrent agent sessions against a shared Postgres container and
schema drift from a neighboring session's `prisma db push` had to be worked around) and real HTTP
calls, no mocks: create client/project → insert a fixture Google connection → suspend → confirmed
the connection was actually deleted from Postgres, not status-flipped → audit event present →
reactivate → transfer-ownership (both the raw-contact and the "neither field" `409` path) →
`delivery-lead` token on suspend → `403`. Separately: a real Offer + signed
`checkout.session.completed` webhook (HMAC-SHA256, Stripe's documented header scheme, no SDK) →
signed `invoice.payment_failed` → subscription `past-due`, `pastDueSince` set, entitlement
untouched → a second `invoice.payment_failed` confirmed `pastDueSince` does not move → ran the
sweep directly (`PaymentFailureSweepService.runOnce()`, via a throwaway, not-committed
`NestFactory.createApplicationContext` script) with a near-zero grace period → client auto-suspended,
audit event `actorType: "scheduler"` → a second client's `invoice.paid` after a failure confirmed
`pastDueSince` clears and the client was correctly skipped by the next sweep. Approval gating:
legacy client-admin fallback got `404` on a bogus approval id (passed the role gate); the same
user added as an explicit `client-collaborator` seat got a real `403` on the decision route while
keeping `200` on the read routes. `npx tsc --noEmit` — zero errors.

**Left for later, honestly:** `web/`'s client-portal UI for a suspended account's experience was
out of scope (backend-only phase; `web/` is a separate active track — see project memory note on
`frontend/` vs `web/`). §29 (competitor cap) and §31 (public report-link security) remain unbuilt,
unrelated to this phase.

---
## 2026-09-21 — Client-portal nav restructure: minimal five-item tree reversed to a fuller eight-item tree

Product owner reviewed the client project nav directly and reversed the P16 minimal design
(Overview | Plan | Results | Content | Calendar) back out to: Dashboard, Reports, Performance
(Overview, Technical, Visibility > Organic + AI), Competitors, Digital Marketing (Brand Profile,
Brand Voice, Ideation, Content, Calendar), Business Information, Team Management, Settings.
`PROJECT_NAV` (operator side) is untouched — only `CLIENT_PROJECT_NAV` changed, and
`web/src/lib/navigation.ts`'s doc comment records the reversal and every mapping decision made
for the ambiguous items (Approvals, Team Management scope, the Organic/Technical split, Settings
scope). Full write-up: `docs/MODULES-STATUS.md` (Wave 7 section).

**Built:**
- `web/src/lib/navigation.ts` — new `CLIENT_PROJECT_NAV`; `ClientShell.tsx` now also resolves
  `groups` hrefs (needed for the new "Visibility" sub-heading).
- New pages: `/performance` (new thin landing page), `/performance/technical` +
  `/performance/visibility/organic` (the `website` Results tab split into two components,
  `WebsiteTechnicalPanel`/`WebsiteOrganicPanel` in `results/tab-panels.tsx`; Organic also absorbs
  the former standalone `presence` tab), `/performance/visibility/ai` + `/competitors` (the
  `ai`/`competitors` tabs reused wholesale at new addresses), `/reports` (project-scoped, filters
  the existing account-wide read), `/digital-marketing/brand-profile` + `/brand-voice` (read-only,
  reuse existing portal reads), `/digital-marketing/ideation` (read-only, backed by a **new**
  `OpportunitiesPortalController` — `GET /api/portal/projects/:projectId/opportunities`), `/settings`
  (new, deliberately minimal placeholder).
- The old four-tab `/results` screen and the account-wide `/client/reports` screen are untouched
  and still resolve — nothing that already linked to them broke.

**Verified:** `web` `npm run typecheck` and `npm run build` clean (all new routes in the build's
route table); backend `POST /api/clients/:clientId/login` used to create a real client login
against the shared local Postgres (`docker compose`'s `cailyx-postgres`, :5436); real HTTP
requests against the running backend confirmed `GET .../portal/projects/:id/opportunities` → 200
(honest empty-state data), the same route with another client's project id → 403, and the reused
`business-profile`/`writing-style`/`overview`/`results/website`/`portal/reports` reads all → 200.
Every new client-portal page route curled against a running `next dev` → 200 (no 404s). Full
interactive browser click-through was not performed in this pass (no attached browser session) —
the API-level + route-resolution verification above is the fallback the task allowed.

**Left for later:** the operator-authored score-bucket drilldown links (`bucketDetailHref` in
`web/src/services/overview.ts`) still point client audiences at the old `/results?view=...` screen
rather than the new Performance/Competitors pages — left alone to avoid touching shared drilldown
logic in this pass; the old screen still works, so no link breaks, but it's a mismatch with the
new IA worth revisiting.

---

## 2026-09-21 — Client Portal Phase C2: onboarding wizard, CORRECTED order

Full decision record: `docs/analysis/client-portal.md` §§2/11/12/17/18. Build order:
`docs/PLAN.md` §11.2. Full write-up: `backend/src/modules/client-portal/README.md`,
`backend/src/modules/clients/README.md`, `backend/src/modules/client-access/README.md`,
`backend/src/modules/business-profile/README.md`, `docs/API.md`, `docs/MODULES-STATUS.md`
(Wave 7).

**This corrects the report-vs-Google-connect ordering from two earlier attempts at C2** — one
preserved, uncommitted and never merged, on branch `worktree-agent-aeb71c76ff99ed6d7`. Both
made GSC+GA4 connection a hard gate blocking the Day-1 report and the whole portal. After the
product owner reviewed the actual hand-drawn onboarding flow diagram
(`client-onbaording.excalidraw` at the repo root), the real order was confirmed: confirm
details → the report and rest of the portal are already reachable → connect GSC → connect
GA4 → done — one continuous guided wizard, not "wizard then a separately-unlocked app with a
dismissible nudge." `Project.onboardingWizardState`'s enum values (C1) are unchanged; only what
each state blocks changed.

- **Web gate, corrected:** the new project-level gate
  (`web/src/app/(client)/client/projects/[projectId]/layout.tsx`) blocks ONLY
  `not-started`/`confirming-details` — not `connecting-gsc`/`connecting-ga4`. The `/onboarding`
  page is now a single confirm-details step; it redirects to the project dashboard on success
  instead of continuing into a second/third blocking step. `welcome/page.tsx` gained a banner
  that guides the client through the still-outstanding Google-connect step post-report (reusing
  the existing `connections/page.tsx` OAuth flow), replacing the wrong-order dedicated blocking
  UI.
- **Wizard transition endpoints** (`client-portal.service.ts`/`.controller.ts`): `GET
  .../onboarding-wizard`, `POST .../confirm-details`, `.../connect-gsc-done`,
  `.../connect-ga4-done` — project-scoped (§17), server-re-checked (a confirmed profile must
  exist; a live `GoogleProjectResource` mapping must exist), never advanced on a client click
  alone.
- **Auto-email on Day-1 completion (§2/§18):** fires on success OR honest-partial failure, from
  both the legacy and durable (G07/A7) pipeline completion points, via a new
  `ClientAccessService.createSystemInvite()` (canonical invite-link mechanics, called as a
  service method — never the deprecated temp-password path) + a Plunk "your Cailyx portal is
  ready, click here to log in" email (no PDF, no report attachment). Best-effort throughout.
- **`business-profile` `category` field (§12):** new nullable column, wired through the full
  save/confirm/merge/overview path and both client and ops business-info screens. ICP turned out
  to already be fully wired (no work needed); target markets were already covered by existing
  `markets`/`targets` fields.
- **Salvaged vs. rebuilt** from the preserved branch: the transition-endpoint shapes/gating
  rules and the auto-email hook body were already order-agnostic and reused near-verbatim. The
  gate's blocking condition, the wizard UI (one step instead of three), and the welcome-page
  integration were rebuilt for the corrected order.

**Verified live** against a booted backend + real Postgres: created a client/project → saved +
confirmed a business profile (`category: "SaaS"` round-tripped) → `confirm-details` →
**`GET /api/portal/reports` succeeded while state was still `connecting-gsc`** (the
corrected-order proof) → `connect-gsc-done` 409'd with no mapping, succeeded once a
`GoogleProjectResource` row was inserted (OAuth round trip itself not exercised — no live
Google credentials in this environment) → same pattern for `connect-ga4-done` → `"done"` →
re-verified C1's admin-waive escape hatch unaffected on a separate project → confirmed the
pipeline-completion email hook fires (log shows the attempt immediately after "Day-1 pipeline
completed," non-fatal 401 from the dev Plunk key — best-effort design working as intended) →
§17 project-scoping verified: a brand-new colleague login created after a project reached
`done`, which never itself called any wizard endpoint, read `"done"` on its first call.
`backend: npx tsc --noEmit` clean; `web: npm run typecheck` clean. Not verified: the real Google
OAuth authorize/callback round trip, and a browser click-through of the web UI (verified via the
API and by reading the gate/wizard/banner source for correctness).

---

## 2026-09-21 — Client Portal Phase C7: automatic refresh-cadence

Full decision record: `docs/analysis/client-portal.md` §19. Build order: `docs/PLAN.md` §11.7.
Full write-up (scoping rationale, cadence-per-tier table, verification notes):
`backend/src/modules/refresh-cadence/README.md`. Endpoint reference: `docs/API.md`.

**Scoping decision (required before code per §11.7's own caution):** a scheduled refresh re-runs
only `measurement` (one new run against the project's current active query set, replaying the
most recently used surface+geo) + `scoring` — never the Day-1 flowchart (competitor discovery,
backlinks, tech-stack scan, etc. stay one-time/manual).

**New `refresh-cadence` module:**
- `Client.planTier` (`starter|growth|scale|enterprise`, default `starter`) — new field; nothing
  existing encoded a plan tier (`billing`'s `Offer`/`Entitlement` are price/feature-key tables,
  not a tier label, and `billing` was out of scope to touch for this phase). Settable via the
  existing generic `PATCH /clients/:clientId`.
- Cadence derivation (`cadenceForTier`): starter=weekly, growth/scale=daily. Enterprise mapped to
  daily, **not real-time** — flagged as a known gap (`docs/PLAN.md`'s own architecture notes say
  real-time monitoring is future work; nothing in `docs/analysis/client-portal.md` §19 or
  `docs/PLAN.md` §11.7 actually promises Enterprise real-time).
- Automation: an hourly `@nestjs/schedule` cron reconciles every completed project's cadence
  against its client's current tier, then runs whatever is due — the same architecture pattern
  `technical-audit`/`seo-audit` already use for their own recurring runs, against dedicated
  `ScheduleConfig.refresh*` columns (not the shared `cadence` column those two already collide
  on, and not the BullMQ path, which only `technical-audit`'s own scheduler actually drains under
  this repo's default `SCHEDULING_BACKEND=cron`).
- No cadence-configuration endpoint by design — `GET /api/projects/:projectId/refresh-cadence`
  (read-only status) + `POST .../run-now` (operator/QA override, does not touch the automatic
  schedule).
- `MEASUREMENT_MAX_COST_PER_RUN` is unmodified and unbypassed. A real gap live verification
  caught and fixed: `MeasurementService.executeRun` doesn't throw on an internally-failed run
  (e.g. the cost cap trips) — it just records the reason on the row — so an early version of
  `runScopedRefresh` silently reported success anyway. Fixed to check the executed run's status
  and surface the failure via `refreshLastError`.

**Verification:** `npx tsc --noEmit` and `npx nest build` clean. Live end-to-end against a real
backend process and the shared dev Postgres (`docker-compose`'s `cailyx-postgres`): created a
real `Client`+`Project`, let Day-1 onboarding actually complete, created+activated a real
`QuerySet`, ran a real baseline `MeasurementRun` (mock surface). `PATCH planTier` → cadence
status updated correctly; `POST run-now` → confirmed a real second measurement run + score run
via `GET`; the scheduler's `tick()` invoked directly against the same compiled code and live DB
(an hourly/daily cadence isn't practical to wait out in-session) → confirmed due-row detection,
the scoped refresh, and `nextRunAt`/`lastRunAt` bookkeeping. **Not verified:** the real
`@nestjs/schedule` hourly cron firing unattended over a multi-hour wait — the identical mechanism
is already relied on by `technical-audit`/`seo-audit`, so this is a low-risk, honestly-flagged
gap rather than a claimed pass. All test data deleted afterward.

---

## 2026-09-21 — Client Portal Phase C4: prompt + content request queues

Full decision record: `docs/analysis/client-portal.md` §§13/14/20/22. Build order:
`docs/PLAN.md` §11.4. Full write-up: `backend/src/modules/prompt-requests/README.md`,
`backend/src/modules/content-requests/README.md`, `backend/src/modules/content-workspace/README.md`
(new), `docs/API.md`, `docs/MODULES-STATUS.md` (Wave 7).

**Prompt visibility + add/delete request queue (§13, §20):**
- New `prompt-requests` module. Client-facing `GET /api/portal/projects/:projectId/prompts`
  reuses `QuerySetService.list(projectId, 'active')` directly — the real, active buyer prompts,
  not a summary. `POST .../prompt-requests` proposes an add or flags an existing prompt for
  removal; lands in a queue an admin reads at `GET /api/projects/:projectId/prompt-requests` and
  decides at `POST .../:id/decide`. Deliberately separate from the Approval primitive: this
  module never touches `QuerySet`/`QuerySetItem` — the admin performs the real add/remove through
  `query-set`'s own existing fork → add/remove → activate endpoints, unchanged by this work.
- §20 quota check: every request snapshots the project's active-prompt count against a plan-tier
  limit (Starter 100 / Growth 300 / Scale 1,000 / Enterprise unlimited). No clean `planTier`
  field exists on `Client`/`Subscription` in this codebase — resolved instead from the client's
  most recent `Subscription.offerId` → `Offer.code`/`Offer.name`, defaulting to Starter. Flagged
  as a documented judgment call, not a discovery of an existing field.
  Over-quota is flagged (`overQuota: true`), never rejected — an upsell signal for the admin.

**Structured "request new content" form (§14, §22):**
- New `content-requests` module. `POST /api/portal/projects/:projectId/content-requests`
  (contentType/topic/priority) creates a real `content-workspace` `GrowthAsset` immediately —
  no separate triage inbox. New `GrowthAsset.sourceClientRequestId` field (non-FK, same pattern
  as `sourceGapId`/`sourceOpportunityId`); `content-workspace`'s `source` derivation now reports
  `'client-request'`. `GrowthExecutionService.createFromClientRequest` mirrors the module's
  existing `createFromOpportunity`. The new asset correctly reads `editorialState: 'planned'`
  (no revision yet) and stays absent from the client's own shared-content list until an operator
  explicitly shares a revision — reused existing lifecycle states, nothing new invented.

**Frontend:** Results page (AI tab) gains a Prompts panel — read-only list + "Request a change"
dialog + the client's own request history with status and the over-quota note surfaced as copy.
Content page gains a "Request new content" dialog. Both call the new `services/portal.ts`
adapters. Chosen home for prompts: the AI-visibility results page rather than a 9th top-level nav
item, since that's the page that already shows what these prompts produce.

**Verified end-to-end** against a live backend (`PORT=3091`) + the shared dev Postgres
(`localhost:5436`): created client/project/active query set → client submitted an add and a
remove prompt request, both correctly quota-snapshotted → admin queue listed both → admin forked
the real query set, added the prompt, activated it, then decided both requests (approve/decline)
→ re-decide correctly 409s → client submitted a structured content request → real
`GrowthAsset` created and tagged `source: "client-request"` → confirmed absent from the client's
shared-content list pre-share. `npx tsc --noEmit` (backend) and `npm run typecheck` + `npm run
build` (web) all clean.

**Left for later:** no operator-facing UI for the prompt-request admin queue yet (API-complete).
A shared Postgres container race during this session (another worktree's `prisma db push`
transiently dropped this phase's new tables mid-verification) was resolved by re-running
`prisma db push --accept-data-loss` from this worktree — a known environment quirk with several
concurrent agents on the same dev database, not a defect in this work.

---

## 2026-09-20 — Client Portal Stage 1: §11.0 cleanup + Phase C1 (audit trail + onboarding-gate foundation)

Full decision record: `docs/analysis/client-portal.md` §§15/16/33. Build order: `docs/PLAN.md`
§11.0/§11.1. Full write-up: `backend/src/modules/clients/README.md`,
`backend/src/modules/activity/README.md`, `docs/API.md`, `docs/MODULES-STATUS.md` (Wave 7).

**§11.0 cleanup (four of five items; `frontend`/`client-portal` removal and `sleeper-refresh`'s
GSC gap deliberately left untouched, per the plan):**
- `POST /clients/:clientId/login` (temp-password) marked `@deprecated` — kept working as a
  non-default escape hatch, not removed. `POST /clients/:clientId/invites` (`client-access`,
  invite-link) confirmed canonical. The one known caller
  (`web/.../ops/clients/[clientId]/access/page.tsx`) now shows an in-page deprecation banner.
- CP04 (`web/.../welcome/page.tsx`) left functionally untouched, with an inline comment
  documenting its Phase-C2 transition plan (first-visit gate today → post-onboarding "manage
  connections" surface once C2 ships the real wizard).
- `Project.onboardingStatus`/`onboardingStep` (pipeline-internal) now carry an explicit doc
  comment in `schema.prisma` and `schema.production.prisma` against being repurposed for the
  future engagement Phase/Milestone model (Phase C3).

**Phase C1:**
- **Audit log (§33):** no new module built — `activity` (G15, `ActivityService`) already matched
  the spec (actor/action/target/timestamp/redacted metadata + admin-only reads). Added `'waived'`
  as a new `ActivityAction`.
- **Per-project onboarding-wizard state (§16):** new `Project.onboardingWizardState` column
  (`not-started | confirming-details | connecting-gsc | connecting-ga4 | done | waived`), scoped
  per-project not per-client, plus `ClientsService.getOnboardingWizardState()`/
  `waiveOnboardingWizard()`. `GET /api/clients/:clientId/projects/:projectId/onboarding-wizard`
  reads it.
- **Admin waive action (§15):**
  `POST /api/clients/:clientId/projects/:projectId/onboarding-wizard/waive` (`@Roles('admin')`),
  sets the gate to `"waived"` and writes an audit event. `waived` is always returned as the
  literal state string — never collapsed into a boolean "is onboarded".

**Verified live** against a booted backend (`PORT=3099`) and a real Postgres container
(`localhost:5436`): created a client + project (`onboardingWizardState: "not-started"` on
create) → `GET .../onboarding-wizard` → `{"state":"not-started"}` → `POST .../waive` with a
`reason` → response `onboardingWizardState: "waived"` → re-read confirmed persistence →
`GET /api/activity?action=waived&clientId=...` returned exactly one matching event (actorId =
the admin, resourceId = the project, `changes: {onboardingWizardState: {before:
"not-started", after: "waived"}}`) → confirmed the deprecated `/login` endpoint still returns
201. `npx tsc --noEmit` clean.

**Left for later (out of scope for this stage, by design):** the sequential onboarding-wizard UI
that actually transitions through the non-waived states is Phase C2; `frontend`/`client-portal`
directory removal is a separate commit the user does themselves; `sleeper-refresh`'s GSC-OAuth
gap is untouched (already flagged in `MODULES-STATUS.md`'s Wave-4 row).

**Pre-existing repo issue found, not caused by this change:** `npx prisma migrate dev` fails with
`P3019` — `prisma/migrations/migration_lock.toml` still says `provider = "sqlite"` from before
the 2026-09-16 Postgres cutover (the migration SQL files are SQLite-dialect too), even though
`schema.prisma`/`schema.production.prisma` have said `postgresql` since that cutover. Used
`prisma db push` instead, which is the only thing that currently works against this schema.
Flagged in `docs/MODULES-STATUS.md`'s Wave 7 note so C2+ doesn't hit the same surprise cold; not
fixed here (out of scope for this stage).

---

## 2026-09-20 — Correction: the live app is `web/`, not `frontend/`; two more feedback fixes

Discovered mid-fix-pass: this repo has **three** frontend-ish directories —
`web/` (Next.js, App Router, `(ops)` + `(client)` route groups — auto-deploys to
Vercel on push, last touched today, matches the feedback's reported Railway
URLs like `/projects/:id/research/website` exactly) and `frontend/` (an older
"terminal" console app, last touched 5 days ago, **not linked to any deploy
config found in this repo** and its own routes redirect back to `/` with a
"legacy" comment). AGENTS.md's tree diagram doesn't mention either `web/` or
`client-portal/`, so this wasn't obvious up front. The earlier fix in this
session for the dead Google-connect buttons was made in `frontend/`
(`components/terminal/AnalyticsPane.tsx`) — a real bug fix, but in the
non-deployed app, so it does not address the live feedback. Leaving that fix in
place (it's correct code, just not on the path that matters) and redid the
actual fix in `web/` below. Worth a follow-up conversation with the team on
whether `frontend/` should be archived/deleted to prevent this again.

**Fix: no way to connect Google Analytics / Search Console from `research/website`**
(`web/src/app/(ops)/projects/[projectId]/research/website/page.tsx`, `SearchTab`
and `VisitorsTab`) — both "not connected" messages were plain text with no
link. Added a `Connect Search Console` / `Connect Google Analytics` link to
each, pointing at the existing, working resource-picker page at
`/projects/:id/connections/google/[service]` (`web/src/app/(ops)/.../connections/google/[service]/page.tsx`,
already wired to the real OAuth flow via `getGoogleAuthorizationUrl` — just
unlinked from anywhere on `research/website`).

**Fix: dead-end "(staff)" links reachable by client accounts on `/research/ai`**
(`web/src/app/(ops)/projects/[projectId]/research/ai/page.tsx`) — "Manage
question sets (staff)", "Run administration (staff)", "Open the full run
detail (staff)", and "Open run (staff)" were rendered unconditionally, with no
role check anywhere in the file, even though the page's own design comment
(§8.1/§8.2) calls this a merged **client-facing** destination with those as
staff-only secondary links. Backend RBAC already blocks a client account from
the underlying endpoints (`aeo-audit.controller.ts` and `query-set.controller.ts`
carry no `@ClientPortal()`, and `RolesGuard` default-denies client-type users),
so this was a UX dead-end, not a privilege-escalation gap. Added `useSession()`
+ `isStaff = user?.type !== 'client'` and gated all four links behind it.

**Verified:** `npx tsc --noEmit` and `eslint` clean on both changed files in
`web/`. Did not verify in a browser (no live Chrome extension available in this
session) — confirmed via curl earlier that the Google OAuth endpoints these
links lead to work correctly; did not re-verify session `type` end-to-end for
a client-portal login in this pass.

---

## 2026-09-20 — Fix: "Connect" buttons for Google Analytics / Search Console did nothing

Client feedback (x2): "you are showing, not connected, that is fine, but you need
to show me from where i can connect right?" — the Google Analytics and Search
Console connector cards showed a status dot and a "Connect" button, but the
button had no `onClick` at all; the only working OAuth-connect flow lived in the
unlinked `/v3` preview's Settings panel, unreachable from the live app (`/`, the
terminal — `frontend/src/app/projects/[projectId]/page.tsx` confirms per-project
routes are a legacy redirect back to `/`).

Wired `ConnectorCard` in `frontend/src/components/terminal/AnalyticsPane.tsx` to
call the existing `authorizeGoogle()` helper (already used by `/v3`'s working
flow) and open the real Google consent screen in a popup, resolving once the
popup posts back or closes, then refreshing the integrations list via a new
`refreshIntegrations()` in `frontend/src/app/page.tsx`. No new OAuth
tooling — reused the already-approved `backend/src/modules/google/` module
end-to-end. Also added the same missing action (an "Open connections" button)
to the `/v3` `SeoAuditWorkspace` gate screen, which had the identical dead-end:
text telling the user to "open the connections panel" with nothing to click.

**Verified:** `npx tsc --noEmit` clean. Confirmed via curl against the running
backend that `POST /api/integrations/google/authorize` (now called by the
button) returns a real `accounts.google.com` OAuth URL for both `analytics` and
`search-console`, and that `GET /api/integrations` reports `google-analytics` /
`google-search-console` keys matching the button's service mapping. Could not
click through the actual popup/consent screen in this environment (no live
Chrome extension attached), so the click-through itself is unverified —
the request construction and endpoint are confirmed correct.

---

## 2026-09-20 — Fix: cross-tab refresh race logged users out entirely

Client feedback: "while i am using the app suddenly it is getting logged out and
asking me to login again." Root cause was in `auth.service.ts`'s `refresh()`:
refresh tokens rotate on every use, and presenting an already-rotated (revoked)
token was always treated as theft — it revoked *every* session and refresh token
for that user. Two tabs open on the same account (or two near-simultaneous
requests) would race to `/auth/refresh`; the loser's rotated-away token tripped
that reuse-as-compromise path and force-logged out every tab, with no retry able
to recover since all sessions were now dead server-side.

Added a 15s `ROTATION_GRACE_MS` window (`recentRotations` map in `AuthService`):
a token presented within that window of its own rotation gets the winning
request's new pair handed back instead of triggering the nuke. Reuse outside the
window still revokes everything, unchanged. Frontend (`frontend/src/lib/api.ts`)
also gained a best-effort cross-tab lock via `localStorage` so a second tab waits
briefly for the first tab's in-flight refresh instead of racing it.

**Verified:** `npx tsc --noEmit` clean on both `backend/` and `frontend/`.
Manually reproduced the race with curl — a stale token presented right after
rotation now returns 200 with the winner's pair; the same token presented after
the 15s window still returns 401 and revokes the account's sessions, confirming
the compromise-detection guarantee is unchanged.

---

## 2026-09-20 — Rothenhall brand applied to the Cailyx web app

The Rothenhall Partners Brand Kit **v1.1.0** (`Brand/tokens/brand.css`) is now the
source of Cailyx's visual values. `design_plan.md` §3.1 keeps ownership of the token
*roles*; the kit supplies what they resolve to. Neo-classical editorial replaces the
cool blue workspace: warm paper `#f7f3ea`, ink `#1a1712`, brass and cognac accents,
Jost over Instrument Sans, and 2px corners with pill controls in place of 8/12/16.

**One file carried the theme.** `web/` was already token-driven — 262 source files
contain exactly one raw hex (an input placeholder) and zero `bg-white`/`text-black`
bypasses, and Recharts reads the same CSS variables through `charts/tokens.ts`, so
charts and reports re-skinned themselves. The kit's `tailwind-theme.css` could not be
pasted in: it is a Tailwind v4 `@theme` block and `web/` is v3.4 with different
utility names, so brand primitives were mapped onto §3.1's roles instead. Triplets
are written to one decimal because integer rounding moves `#f7f3ea` to `#f7f2e9`;
every token round-trips to its source hex and carries it in a comment.

**Three deviations, each measured rather than copied.** The kit's `cognac-soft` focus
ring is 2.97:1 on canvas, under the 3:1 non-text floor, so `--ring` takes
`cognac-deep` (6.14:1). `line-strong` at 1.63:1 cannot carry an input boundary, so
`--border-strong` takes `ink-45` (3.68:1) — which §3.1 already asked for and the kit
itself sanctions by labelling `line` "decorative only, never the sole affordance".
And lining tabular figures stay global: the kit's `onum` old-style figures are a
legibility cost in a table of measurements. Status colours keep their functional
hues, because the kit specifies only an alert colour and these four carry verdicts a
client acts on; `danger` does move to the kit's `#9d3b2f`.

**A latent bug surfaced on the way.** All 25 opacity-modifier classes in `web/src`
were compiling to nothing — an `hsl(var(--x))` mapping cannot take a `/30` modifier
in Tailwind v3 without the `<alpha-value>` placeholder. Every tinted status border
(`border-danger/30`, `border-warning/40`), every alpha hover state, and the old
button's `hover:bg-primary/90` have been silently absent until all 45 mappings were
rewritten as `hsl(var(--x) / <alpha-value>)`. The new modal scrim is what exposed it:
`bg-night/80` rendered no background at all.

**Identity rule closed.** The kit requires that Cailyx never appear without
Rothenhall in the same view; no surface previously mentioned Rothenhall. An
`AppShell` `Wordmark` now carries "A Rothenhall product" in the desktop nav and the
mobile drawer, `PublicShell`'s footer credits Rothenhall with a link, and the sign-in
page — which owns its own wordmark — carries the credit in both its form and its
Suspense fallback.

Verified: `npx tsc --noEmit` clean; `npm run build` clean, with `next/font`
self-hosting both faces; and in Chrome via Playwright, computed body background
`rgb(247,243,234)` = `#f7f3ea` exactly, headings `Jost`, body `Instrument Sans`,
primary button `rgb(26,23,18)` at `border-radius: 9999px`, cards `2px`, both faces
present in `document.fonts`. Every text pairing measures AA (16.14:1 body text down
to 5.4:1 warning on its fill). Analysis: `docs/analysis/rothenhall-brand.md`.

Left for later: heading weight renders 600 where components set `font-semibold`
against the kit's Jost 400 (a component sweep, not a token change); `web/` still has
no `public/` directory or favicon, blocked on the kit having no SVG of any mark;
`/ops` and `/client` were not visually verified because the local schema is freshly
pushed and empty; G20's `primaryColor` is still stored but never applied to the DOM;
and nothing yet enforces that these triplets keep matching the kit, whose own
governance notes its token files do not auto-sync.

---

## 2026-09-17 — P15: Overview / Results / report adoption

`platform_improvement_plan.md` §5.1, §5.5–§5.7, §14.5–§14.6 and the P15 row of
§20.2. The Overview becomes one composed page instead of a dashboard of
counters; the client Results screen becomes §3.3's four tabs; and a released
report is now visibly, structurally a different number from the live score.

**The Overview is composed on the server, not assembled by the page.**
`GET /portal/projects/:id/overview` (client) and `GET /projects/:id/overview`
(staff) return five panels — score, actions, upcoming content, plan, report —
each in its own `ok|empty|unavailable` envelope (§4.5), plus `teamAttention` on
the staff read only (the key does not exist on the client payload). §5.1's
limits are applied at the source: one total, applicable buckets only, ≤3 action
cards, ≤5 upcoming items, and the **true** count whenever it exceeds what is
shown. Both screens render the same components
(`web/src/components/patterns/OverviewPanels.tsx`, `ScoreSummary.tsx`), so the
client's page and the operator's cannot drift into describing the same number
differently. The staff page puts "Team attention" below the client-equivalent
information, as §5.1 asks.

**Reading starts nothing (§5.7).** Every panel is a pure storage read. The
presence tab reuses P05's `portalInventory()`; the website tab reuses the
website overview's idempotent reconcile and discloses it; the competitor gap
service is deliberately *not* called (it scans live). "Build a score" remains an
explicit POST, as before.

**The client Results screen is §3.3's four tabs** — Website, AI visibility,
Online presence, Competitors — reading the existing portal read models through
client-safe projections. The fourth tab needed a route that did not exist
(`GET /portal/projects/:id/results/presence`); it adds **no projection of its
own**, projecting P05's inventory verbatim, because a second read path for one
fact is how two screens start disagreeing. A bucket card's drilldown is the
**stored** `detailPath`/`detailQuery`/`period` (§5.5) — a sub-view becomes a URL
fragment, the period is preserved through `from`/`to`, and the content bucket
lands on the calendar. "How this score works" is a plain-English sheet with no
"rubric" or "methodology version" in its headlines; the version is a details
line, and staff can inspect the full stored calculation on demand
(`GET /projects/:id/scores/:runId`) from the same sheet.

**Frozen report sections (the exit gate).** A released report now carries the
score family and the 30-day plan progress *from `ReportRevision.snapshot`* —
written once at review-lock, never recomputed at read time — rendered by
`web/src/components/patterns/FrozenReportSections.tsx`. The live screen says
"Live score, updated <date>"; the report says "As released in the <Month>
report", and a report released in September keeps saying September after a new
live run and after a newer private draft revision. `ReportData` and
`ReportRevisionSnapshot` in `web/src/services/reports.ts` gained these fields,
optional by design: `undefined` means the route does not serve the section,
`null` means the revision predates it — never "zero".

**Verified.** `npx tsc --noEmit -p tsconfig.json` and `npx nest build` clean;
`npx tsc --noEmit` and `npx next lint` clean on the web. New
`backend/smoke/overview-results.smoke.sh` drives the real HTTP surface against a
booted dev server — **138 checks, 0 failures** — proving (a) live/report
separation after the mutable `Report` columns are seeded to *wrong* values, the
live score moves to a second run and a newer private draft is opened;
(b) the full draft → review → approve → release journey; (c) an incomplete run
renders no numeric total while still listing every bucket; (d) one panel's
source failing leaves the other four intact on a 200; plus §5.7 read purity by
row-count comparison, the §5.1/§5.6 limits, the four tabs, and tenant isolation
on every new route.

**Left for later, deliberately.** The operator's project page no longer carries
audit counts, a run-history chart, a calendar preview or "not available yet"
rows (§5.1's list; each figure now links to the screen that owns it) — the
removed rows had also gone stale, since the priorities/cycles/approvals surfaces
they called missing now exist. `ContentCalendarPreview` in
`components/patterns/ContentCalendar.tsx` is now unused outside that file; it
was left in place rather than deleted because the calendar module was being
edited concurrently. P16's nav copy rollout and the P10 calendar work in the
same tree were not touched.

---

## 2026-09-17 — Module documentation for the platform improvement phases (P01–P11)

Documentation-only pass over the `platform_improvement_plan.md` phases that had
settled enough to describe. No application code, schema, dependency or
configuration was changed, and no `.ts`/`.tsx` source file was edited.

**READMEs written.** `opportunities/` (P07, §12.5–12.7 — the observed-corpus
keyword-gap engine, dedup identity, dismiss-with-reason, the idempotent
convert-to-content contract) and `delivery-plan/` (P01/P11 — §3.5 client-safe
projections, §5.6 needs-your-action, §6.1–6.3 commitments). Both get their
first written spec: purpose, the rules the module exists to enforce, endpoint
tables, dependencies, plan-alignment table, and an explicit "what was
verified, and what was not".

**READMEs extended.** `business-profile/` (P02/P04 — `confirmed` /
`suggestions` / `gaps` as three lists that are never merged, value-keyed
rejections read from stored `SiteContext`, structured target locations, and
the removal of the silent ccTLD → default-`US` market fallback, §10.2);
`digital-presence/` (P05 — applicability `relevant`/`optional`/`not-relevant`,
"not ours" rejection tombstones with a required reason, the client projection);
`competitors/` (P06 — free-by-default market discovery with `queriesRun: 0`,
`collectNew` as the only paid path, immutable comparison snapshots with
provenance).

**Repo-level.** `docs/MODULES-STATUS.md` gains §1.2g — the platform phases, with
the three still-in-flight modules recorded as such — and loses a stale Wave-0
claim that all endpoints were unauthenticated (the `auth` checklist item is now
checked, describing what actually ships). `docs/API.md` gains sections for the
P01–P11 surfaces (business profile, digital presence applicability/rejections,
competitor market discovery + snapshots, opportunities, the delivery plan and
its portal routes), and its header no longer says "Auth: Not yet implemented" —
a statement its own Auth Module section had contradicted since the auth module
landed. Following that file's existing convention, the new material is appended
as dated sections; the file is hand-maintained, not generated.

**Not done, on purpose.** No README and no `docs/API.md` section for
`content-workspace`, `writing-style` or `website` (P08/P09/P12 were still
landing while this pass ran), nor a staged-context section for `aeo-audit`
(P13 in flight). A moving target documented once is wrong twice; each is
recorded as deferred in `docs/MODULES-STATUS.md` §1.2g instead.

**Discrepancies found and left standing** (documented in the module READMEs,
not fixed, because they are their owning phases' calls): `competitors/SPEC.md`,
`REQUIREMENTS.md` and `SETUP-STATUS.md` still describe the worktree-era minimal
`AeoAudit` mirror the current module no longer is; `opportunities.types.ts`
documents an `editorial-idea` origin that no code path writes; the
`digital-presence` portal inventory carries a no-op filter
(`.filter((a) => a.state !== 'unverified' || true)`); and a client reading
another client's project gets a 404 from `delivery-plan`'s portal routes but a
403 from the shared `ScopeValidationService` used by other modules — both
disclose nothing, but they are not the same answer.

**Verified:** nothing at runtime. Every smoke suite named in the new documents
(`keyword-gaps`, `portal-plan`, `thirty-day-plan`, `online-presence-unified`,
`competitors-unified`, `target-markets`) is cited as the exit gate that exists
— **none was re-run during this pass**, because other agents were mid-flight on
shared source and the dev database and a result could not have been attributed
cleanly. The assertions described in each "What was verified" section are read
from the scripts; they are not a claim that the suites pass today.

## 2026-09-16 — Platform improvement plan for the current web and backend

Added `platform_improvement_plan.md`, a detailed implementation specification
for the 36 changes from the two product discussions. It covers client-friendly
navigation and copy, affected screens and route migration, the new Cailyx score,
business understanding and corrections, market-aware discovery and measurement,
unified Website/AI/Presence experiences, competitor keyword opportunities,
content/style/generation, one content calendar, client-safe APIs, team cadence,
reports, data migrations, sequence diagrams, and sequential rollout/acceptance
tests. The original `design_plan.md` remains unchanged.

Source inspection distinguishes already implemented capabilities from required
extensions and new contracts; supporting findings are recorded in
`docs/analysis/platform-change-contract-research.md`. Pending product decisions
and unsupported automated publishing channels remain explicit rather than
being represented as implemented features.

**Verified:** static comparison with current source/controller/schema/OpenAPI
contracts, local Markdown-link checks, requirement coverage, balanced code
fences, and JSON-example parsing. No application code, dependencies, database,
credentials, live jobs, or external publications changed; no runtime or build
verification claimed for this documentation-only task. Implementation and
module-specific tool-choice approvals remain for the subsequent build phases.

## 2026-09-16 — G05 report editorial lifecycle, client release and share policy (+ D11)

The largest remaining backend gap: until now a generated report was immediately
readable in the client's portal, and `visibility` (public link on/off) was the
only report-state control in the API. "Clients only ever see approved reports"
was unenforced. Package: `backend/src/modules/reporting/` (README + API.md
rewritten).

**Two axes, now separate columns.** `Report.visibility` stays "may anyone with
the URL read the HTML"; `Report.status` + `releasedRevision` is the editorial
state. Revoking a public link never un-releases a report; releasing never mints
a public link; `visibility` is never used as a QA state.

**Lifecycle.** `POST :slug/review` locks a revision and freezes its snapshot,
`/approve` records the QA decision, `/publish` releases to the client, and
`/withdraw` pulls it back with a reason. A published revision is immutable — new
data opens a new revision and the old one is superseded with its snapshot
byte-identical (verified by sha256 on the stored column). `Report.status` is
sticky once released, so preparing v2 does not take v1 away from the client.

**Release gate.** `publish()` calls G10's `assertReadyToPublish` before writing
anything (`artifactType "report"` / `revisionType "report-revision"`), and
`review()` invalidates stale approval requests. G10's README and the publishing
README both claimed report release was ungated; both are corrected.

**Portal reads are release-gated.** `GET /api/portal/reports[/:slug]` now serve
only `status="released"` content at `releasedRevision`, from the frozen snapshot
rather than the live row; drafts, in-review, approved-but-unreleased and
withdrawn reports 404. `client-portal.service` delegates to the new
`ReportLifecycleService` (three small edits outside the reporting directory,
disclosed in that module's README).

**Share links + delivery ledger.** Expiring/revocable public links stored as
sha256 with a token-only render route (always noindex, never serves a superseded
or unapproved revision), and `ReportDeliveryAttempt` records send attempts as a
separate fact — a failed email cannot roll back a release, and `sent` is never
presented as inbox delivery.

**Migration.** `POST /api/reports/classify-legacy` (admin, idempotent,
dry-runnable) classified the 24 pre-G05 reports as *released at their existing
content*: they were already visible to their clients, so hiding them would
retract delivered work, while `decision="grandfathered"` and a note record that
no review took place (`reviewedBy` stays null). Policy is written down in the
module README.

**D11.** `rubricVersion`/`scoreRunId` are persisted through the G13 evidence
manifest (existing `EvidenceManifest` columns — no schema change) and exposed on
operator and client reads and frozen into revisions. `assetsNote`'s claim that
stage 11 "has no module yet" was still in every report and is no longer true —
the generated text now reports real growth-asset counts, and legacy snapshots
are repaired **on read** with an `assetsNoteCorrected` flag rather than rewritten.

**Verified:** 175/175 checks against a live server on :3098 with an operator and
a client-portal token, covering §11.2 cases 11 and 12 end to end (draft hidden;
released report frozen across out-of-band row mutation and supersession; foreign
project/slug pairs denied; revocation independent of release). `tsc --noEmit` 0
errors, `nest build` clean, boot with no DI errors and all routes mapped.
Remaining: share links render HTML only (no unauthenticated JSON read); a
`changes-requested` decision re-locks the same revision number rather than
opening a new one.

## 2026-09-16 — Design-plan closure: G05 lifecycle, Appendix B repairs, schema and migration gaps

Closes the gaps listed in `docs/analysis/REMAINING-WORK.md`. Every item below was
verified against a running backend, not inferred from a green typecheck.

### G05 — report editorial lifecycle (the last P0)

21 routes: `review` / `approve` / `publish` / `withdraw`, share links, delivery
attempts, revisions, `GET :slug/lifecycle`, an admin legacy-classification route,
and a token-only public HTML render. The G10 gate (`assertReadyToPublish`) now
runs before release, so "clients only see approved reports" holds for reports as
well as content — it previously held only for content, and the approvals README
claimed otherwise.

Public sharing and editorial release are separate axes with no shared code path.
Released revisions are frozen (verified by sha256 across an out-of-band row
rewrite and across supersession). Share tokens are stored as sha256 and the raw
token is returned once. A failed email never rolls back a release.

**A serious bug was caught during verification:** `buildRevisionSnapshot` is
`async` and both call sites omitted `await`. `JSON.stringify(promise)` is `"{}"`,
so 23 migrated reports were frozen **empty** with a clean typecheck. Fixed, the
empty rows purged and the migration re-run, and an `assertUsableSnapshot` guard
added so it cannot recur silently. Verified after: 20 revisions, none empty,
smallest snapshot 28 KB.

### G19 — Appendix B repairs

- **D16** `pageBudget` was validated then dropped. Now forwarded and honoured:
  proven on the same 12-URL target — default crawled 12 of a 150 budget; with
  `pageBudget: 3` it crawled exactly 3. `0`/`1001`/`1.5` → 400.
- **D17** the Google consent requested `webmasters.readonly` while `submitSitemaps`
  issues a `PUT` — a permission mismatch that guaranteed failure. Now requests
  `webmasters` and checks the *stored* grant, returning 409 with a reconnect
  instruction rather than a bare 403. `submitSitemaps` no longer reports success
  with an empty submission list.
- **D20** `measurement` used `?runId=` as a filter with **no ownership check** —
  any operator could read another project's observations by id. Now 404s.
  Empty cohorts return `null` rates instead of `0`; a measured zero still returns `0`.
- **D26** operator message writes now validate the project belongs to the client,
  matching the check the portal path already had.
- **D01/D12/D19** contract annotations corrected, including three competitor
  routes that existed only as a bare summary. **No wire shape was changed** — a
  frontend already normalizes those envelopes and changing them late would break
  working screens.

### G07/G18 — adoption and breadth

Job heartbeats are real: `technical-audit`, `seo-audit` and `presence-discovery`
jobs now produce `JobRun` rows that settle to `completed`/`failed`/`partial` and
are swept by `recoverStaleRuns`. 14 Day-1 stage executors are registered, and
AEO's enqueue now carries `projectId`, closing the last untracked pipeline kind.

**A defect found and fixed:** the resume guard keyed on run status, and a run with
one settled step derives to `running` — so a 14-stage pipeline would have taken a
heartbeat window *per stage*, making the executors unusable. Now a compare-and-set
on the step row.

Capability registry grew 30 → 44 keys, each naming env vars read verbatim from the
module that reads them.

### Schema, migrations, and the budget gate

- `CheckResult` gained `projectId`/`clientId` (denormalized, because the subject
  is polymorphic and the owning project could otherwise only be guessed from a
  subjectType→table mapping). `GET /approvals/check-results?projectId=` is the
  read that was previously impossible.
- `SpendReservation` gained `note`; `release` now records a reason.
- **`prisma/migrations/` now exists.** Baseline `0_init` generated and marked
  applied; verified by applying its SQL to an empty SQLite file — 137 tables from
  137 models. This was the item blocking any shared deployment.
- **Budget policies now bound something.** `assertWithinBudget` refuses work that
  would breach a hard ceiling, called from the queue — the one place every
  background run passes through. Narrow by design: no policy means no change,
  only hard enforcement refuses, and a failure to *evaluate* the policy enqueues
  anyway so a budget-module outage cannot halt every pipeline. This is a gate,
  not a reservation: nothing is held for the run's duration.

### Screen coverage closed

Three screens were missed by the original dispatch and written directly, taking
**every screen in design_plan §4 to a built route — 116 of 116, zero unmatched**:

- **AU06** `/setup` — bootstrap administration. The plan's §5.1 step 6 is explicit
  that this "is not a public SaaS signup path", so the screen asks the server
  whether an administrator exists and, once one does, renders **no form at all**
  rather than a form that would 403. It re-checks at submit time, because two
  people can open it at once and the second must get "someone else completed
  setup" rather than a puzzling failure. Required a new
  `GET /api/auth/bootstrap-state` — G01 asks for exactly this "controlled
  bootstrap-state discovery", and `hasUsers()` had no route exposing it. It
  answers one boolean and nothing else.
- **CL01** `/claims` and **CL02** `/claims/[claimId]` — claim library and check.
  A claim's discipline result is a **refusal, not a warning**: `banned-phrase`,
  `ungraded-number` and `single-run-rate` can never be approved, so the approve
  control is *absent* in those states with the reason stated, never present and
  returning 400. An ungraded claim is likewise not approvable — approving an
  unevidenced assertion is the thing the module exists to prevent.

Where screens landed differs from the plan in two places, both deliberate:
SL03–SL06 are specified under `/ops/projects/:projectId/...` but shipped under
`/projects/:projectId/...`, where the project shell actually lives; and PB05 is
implemented as `src/app/not-found.tsx`, Next's convention for it.

### Live verification against a scratch database

Run against a copy of the dev DB (`/tmp/cailyx-verify/verify.db`) with a
throwaway admin — approved by the owner — so no writes touched the real dev
database. The Prisma datasource now reads `DATABASE_URL` rather than a hardcoded
path, which is what made an isolated verification possible without editing the
schema between runs.

**Passed:** every new read endpoint across G01–G20 returns 200; G05's full write
path (`review` → `publish` refused 409 `not-approved` → `approve` → `publish` →
released, revision 1 superseded with its **34,064-byte snapshot byte-identical**);
401 on every protected route anonymously; 404 on a resource outside the URL's
project; and **`pageBudget` honoured against a live site** — `5/60 crawled
(budget 5)`, audit completed at score 66.

### Five more bugs, found only by running it

1. **Bootstrap was impossible.** `POST /api/auth/register` had lost its
   `@Public()` — a decorator displaced when the AU06 route was inserted — so the
   global guard rejected it and **no installation could ever create its first
   administrator.** Caught on the first call of the pass.
2. **`GET /projects/:id/work-items` returned 500.** The query carried
   `include: { acceptanceChecks: false } as never`; the schema reaches acceptance
   checks through a plain `workItemId` column, not a relation. The `as never` is
   exactly why the compiler never saw it.
3. **One abandoned run blocked all later tracking.** The per-project lock counted
   `queued` as in flight for the full hour-long lock window. The lock now uses a
   separate, shorter bound for `queued` than for `running`, and the sweep
   reconciles never-started runs. `JOB_ABANDONED_QUEUED_MS` is floored at five
   minutes — the first version of this fix was tested at 20 seconds and
   **destructively failed a run that was still legitimately waiting.**
4. **PDF content collided with the fixed footer** on every report: the footer sits
   at 770pt on an 841.89pt page while `paddingBottom: 56` let content reach 785.9.
   Now derived from one constant.
5. **Executive summaries truncated at the first period.** `split('.')[0]` turned
   `https://day1tech.com/sitemap.xml` into `https://day1tech.` in **every** report,
   HTML and PDF alike.

### Charts and PDF (owner-approved)

Recharts 3.10 for charts — score history, GSC daily clicks/impressions, and
per-surface AI rates, each with an **always-visible table carrying the same
numbers** (§3.4) and nulls drawn as gaps, never as zero. `@react-pdf/renderer`
4.9 for report PDFs, driven from the same snapshot the HTML render uses so the
two can differ only in presentation.

**PDF fonts are now embedded, which fixes a blank-render bug.** `@react-pdf`
defaults to the base-14 fonts (Helvetica/Courier), which are *referenced*, not
embedded — the viewer has to supply them. Preview and CoreGraphics do; **poppler
does not**, so the PDF rendered as boxes and rules with no text in `pdftoppm` and
anything built on it, including much server-side PDF tooling. Proven with a
one-line document: base-14 blank, embedded correct. The report now embeds
**Inter 4.1** and **JetBrains Mono 2.304**, both SIL OFL, committed with their
licence texts under `backend/src/modules/reporting/assets/fonts/` and copied into
`dist` by `nest-cli.json`. `renderReportPdf` throws if a face is missing, because
a silent fallback would reproduce exactly this bug.

**Also fixed in the PDF:** content was drawn underneath the fixed footer. The
footer sits at 770pt on an 841.89pt page while `paddingBottom: 56` let content
reach 785.9, so the last table rows were overlapped on every report. The padding
is now derived from the footer constant so the two cannot drift.

### OpenAPI

The checked-in spec had drifted to **261 operations against 535 served**, and no
generator existed — which is why it drifted. `npm run openapi` now regenerates it
from the compiled app with no TypeScript runner and no port binding.

### Verified

- `backend` `tsc --noEmit` 0 errors; `nest build` clean; boots at **536 routes**
  with no DI errors, logging the budget gate, job ledger and stage executors
- `web` `tsc --noEmit` 0 errors; `npm run build` clean at 121 route entries
- `prisma migrate status` → "Database schema is up to date"
- Probe artifacts left by verification runs removed; dev DB left consistent
  (20 released reports, 0 empty snapshots)

## 2026-09-16 — Design-plan implementation: new `web/` app + backend G01–G20

Implements the design plan rather than describing it. Two deliverables: a new
frontend at `web/`, and the backend work packages the plan's Appendix A
specifies. `frontend/` and `client-portal/` are untouched.

### New frontend — `web/` (Next.js 15 App Router, TypeScript, Tailwind)

25 routes across three route groups: `(ops)` operator workspace, `(client)`
portal, `(public)` shared/recovery surfaces.

Three-layer component architecture, enforced rather than suggested:
- `components/ui/` — 30 shadcn/ui primitives (generated, never hand-edited)
- `components/patterns/` — 19 shared components implementing design_plan §3.3,
  composed from `ui/`
- `components/layouts/` — 4 shells (§3.2 page anatomy, §2.3 navigation model)

Design tokens from §3.1 live as CSS custom properties in `globals.css`; every
component consumes them, so no component contains a raw hex value.

**Session boundary.** The browser never talks to NestJS directly.
`app/api/[...path]/route.ts` is a server-side authenticating proxy that reads
the HttpOnly session cookie, attaches the Bearer token, and owns the §10.3
refresh race (one rotation, one replay — not a cascade). Tokens are never
reachable from page JavaScript.

Screens: sign-in, recovery, three error surfaces, operator Today / Clients /
Client overview / Add client / All projects / My Work / Report center, the
project overview / Connections / Run center / Report reader / AI visibility,
and client Home / Approvals / Reports / Messages.

### Backend — G01–G20

**234 new endpoints** across 17 modules. The Prisma schema gained ~46 models
(G01–G20) and is pushed and generated.

| Pkg | Endpoints | Pkg | Endpoints |
|---|---|---|---|
| G01 Identity | 11 | G12 Budgets | 10 |
| G02 Client access | 26 | G13 Results | 14 |
| G04 Business profile | 18 | G14 Operations | 9 |
| G06 Delivery plan | 36 | G15 Activity | 5 |
| G07 Jobs/cadence | 21 | G16 Billing | 12 |
| G08 Notifications | 4 | G17 Lifecycle | 22 |
| G09 Content | 12 | G18 Capabilities | 3 |
| G10 Approvals | 9 | G20 Organization | 17 |
| G11 Publishing | 16 | | |

G03 (enforced scoping) is a shared `@Global` guard service now injected across
the app. G05 editorial states and G19 contract repair are partial.

### Bugs found and fixed

Each was reproduced against a running backend before being fixed:

1. `activity` query DTO — `limit` had `@IsInt()` with no `@Type(() => Number)`,
   so every request carrying it was rejected with 400. Same defect found in
   `approvals`, `notifications` and `digital-presence` query DTOs; all fixed.
2. `CreateSavedViewDto.filters` had no validator, so the global
   `whitelist` + `forbidNonWhitelisted` pipe rejected every request carrying it —
   **saved views were silently inert**. Fixed with `@IsObject()`.
3. Route collision: `PATCH .../growth-execution/assets/:assetId` already
   existed, so the G09 handler would have been dead code. Content writes moved
   to `.../assets/:assetId/content`. The pre-existing PATCH has no `@Roles` at
   all and should be reviewed separately.
4. `RunStatus` (§3.3) had no `cancelled` member, so a deliberately stopped run
   was unrepresentable and read as a fault. Added to the union, label map, tone
   map and icon set.
5. `/ops/work` used the `no-results` empty copy — telling readers to "clear the
   filters" on a page with no filters. Added a `no-work` variant.

### Flagged, not fixed

- `CheckResult` has no `projectId`/`clientId` column, so `listCheckResults`
  cannot be project-scoped without inventing a subjectType→table mapping. The
  route is operator-only as a compensating control.
- `SpendReservation` has no note/rationale column, so `release` takes no body
  rather than accepting a reason it would drop.
- `JobsModule` registers `projects/:projectId/onboarding` with `@Get(':runId')`
  before `BusinessProfileModule`; a sibling literal route added under that
  prefix later would be silently swallowed. A live hazard for future modules,
  not a current bug.
- Budget enforcement only applies where a pipeline calls `reserve`. G12's
  transaction is correct and concurrency-proven, but wiring it into the
  existing audit pipelines is per-module work still outstanding.
- G20's branding/template pinning is built and exported, but `reporting/` does
  not call `getReleaseSnapshot()` yet, so no delivered report actually pins a
  version.

### Frontend screens (second wave)

Dispatched eight agents against non-overlapping route trees; **94 screens landed**,
taking `web/` from 25 routes to **116**, with 32 typed service adapters and ~92k
lines excluding the shadcn primitives.

Families completed: content (CT01–CT09), authority (AT01–AT05), monitoring
(MO01–MO03), research hubs (TA01–TA03, SE01–SE03, AE02–AE05), research library
(QS, EN, DP, CO, KW, SP, JO — 19 screens), client portal (CP02–CP08, CP10,
CP12, CP14–CP16), ops work planning (OP05–OP08, OP12–OP13, PJ02, PJ04–PJ10),
ops admin + sales (OP15–OP21, SL01–SL06), reports (RP01–RP06), public (PB01–PB04)
and the remaining auth screens (AU02, AU04, AU05).

### Bugs the screen agents found — seven real breakages, all fixed

Every one of these was found by an agent binding a screen to source rather than
guessing, and every one would have shipped as a runtime failure:

| # | Bug | Effect |
|---|---|---|
| 1 | `services/operations.ts` sent `cursor`/`limit`; the API whitelists `page`/`pageSize` under `forbidNonWhitelisted` | `/ops/work` and `/ops/reports` **400 on load** |
| 2 | `services/integrations.ts` read `{authorizationUrl}`; the route returns `{url}` | "Connect Google account" navigated to `/undefined` |
| 3 | `services/approvals.ts` omitted `revision`, which `DecideApprovalDto` requires | CP09's approve/request-changes **400'd on every decision** |
| 4 | `services/types.ts` `PortalProject` declared `status`/`score`/`band`, none of which the route sends | CP01 always showed "Not measured yet" |
| 5 | `services/jobs.ts` had two same-named `CadenceRule` shapes, the stale one declaring `stored` where the API returns `configured` | A trap for any later caller |
| 6 | `GET /api/portal/activity` returned `actorId`/`actorLabel` to clients | Operator identity leaked onto a client surface |
| 7 | `GET /api/portal/me` was never registered | The client shell resolved **every authenticated client as signed out** |

Also closed: the `@Public()` upgrade-completion stand-in is now `@Roles('admin')`.
It let anyone reachable on the API mark an upgrade paid.

### Coordination problems worth recording

1. **Eight agents each ran `npm run build` in the same tree.** Next deletes
   `.next` at the start of a build, so concurrent runs corrupted each other's
   manifests (`ENOENT … pages-manifest.json`). Two agents stalled on the 10-minute
   watchdog as a result, and several reported build failures that were not theirs.
   Their work was unaffected — every assigned route landed. The fix for next time
   is to have agents run `tsc --noEmit` only and serialize builds centrally.
2. **Two service adapters disagreed with the real API.** `integrations.ts` was
   written against an assumed envelope (`{authorizationUrl}` for a route that
   returns `{url}`), and `clients.ts` used `category`/`runPipeline` for a DTO that
   takes `runAeoAudit`/`runKeywordResearch`/etc. Agents found both against source.
3. **`services/jobs.ts` carried two same-named `CadenceRule` shapes.** The stale
   one (mine) declared `stored` where the API returns `configured`; the correct one
   was added alongside it. The stale interface was removed.

### Verified

- `backend` `npx tsc --noEmit` → 0 errors; `npx nest build` → clean
- `backend` boots: 520 routes mapped, no DI errors
- `web` `npx tsc --noEmit` → 0 errors; `npm run build` → 25 routes, 0 warnings

### Left for later

- ~100 of 123 screens; research/content/authority surfaces outstanding
- G05 editorial lifecycle enforcement; G19's remaining Appendix B repairs
- Charts (deferred pending an approved tool analysis, per §10.2)
- **No `prisma/migrations/` directory** — DB state comes from `db push`. A
  migration baseline is required before any shared deployment.
- No automated test suite; verification was live endpoint calls plus typecheck
  and build.

See `docs/analysis/design-plan-status.md` for the per-package state and the
remaining work.

## 2026-09-16 — Fresh backend-grounded frontend design plan

Added [design_plan.md](design_plan.md): a from-scratch client/operator design
covering 123 screens, complete user journeys, visual/interaction specifications,
report contents and metrics, team cadence, 17 sequence diagrams, sequential
implementation phases, and 20 prioritized backend gap groups with proposed
contracts and acceptance criteria. Existing frontend code and design flows were
excluded from the review.

Verified all 261 OpenAPI operations against backend controller routes and included
three additional competitor-candidate operations found in source: 264 mapped
operations total. Checked endpoint uniqueness/coverage, screen and gap references,
source links, Markdown tables and diagram fences. Recorded documentation/source
differences affecting authentication, onboarding, report visibility, generation,
scheduling, permissions and payment handling. This was static documentation work;
no live API calls, application builds, dependencies or environment changes.
Implementation and tool selections remain subject to module analysis/approval.

## 2026-09-13 — One SERP vendor, and the cache bug that was waiting for Redis

Cailyx was paying two vendors for the same search. `serp-intelligence` and
`keyword-research` used DataForSEO; `digital-presence` used Serper.dev to find
unlinked social profiles. Serper is gone.

**The economics were never in Serper's favour.** DataForSEO Standard is
**$0.0006** per query and Live **$0.002**, against Serper's ~$0.001 — on an
account that is already funded. Two vendors also meant two auth paths, two cost
models, and two places for a bug to hide.

There is now one `DataForSeoSerpService`, exported from `serp-intelligence` and
consumed by `digital-presence`. The candidate-classification logic that made the
sweep trustworthy — the signature table, the share-widget rejection, the
name-variant search — is untouched; only the transport changed.

**The bug found on the way, which matters more than the consolidation.**
`FetcherService`'s cache key was `(url, userAgent)` — **with no request body**.
Every DataForSEO call posts to the *same* URL with the keyword in the body, and
the default TTL for that path is 30 minutes.

So in `serp-intelligence`, every SERP call inside a half-hour window returned
**the first keyword's results**. A ten-keyword tracker would store the same SERP
ten times: wrong rankings, indistinguishable from right ones, with no error
anywhere.

It had never fired, because `CacheService` short-circuits when Redis is down and
Redis was not running. It would have activated **silently** the moment anyone
started Redis — which happened later the same day. The key now includes a SHA-1
of method+body; a plain GET keeps its original key, so no existing entry is
orphaned. Verified against live Redis: two different query bodies produce
distinct keys and read back their own results.

**Credit discipline**, in order of effect:

1. **Seven-day cache.** The largest saving by far, and only safe because of the
   key fix above. A `site:instagram.com "Acme"` result does not move hour to hour.
2. **Cache hits are not counted as spend.** Counting them would tell the operator
   credits went out when none did — and the budget guard, which prices the next
   run off that number, would refuse runs that are actually free.
3. **`depth: 10`, fixed.** DataForSEO bills per ten results; asking for twenty
   doubles the charge and nothing here reads a second page.
4. **Opt-in per run**, and only platforms still missing after the free crawl are
   searched at all.
5. **Real cost recorded.** `PresenceDiscovery.serpCostUsd`, read off the response
   envelope — the same discipline the OpenRouter and Cloro paths follow. Never
   estimated.

**Credentials.** Verified live against `/v3/appendix/user_data`, which is free —
account `office@rothenhall.com`, balance $51. They had been added as
`DATA_FOR_SEO_API_LOGIN` / `_PASSWORD`, while every module reads
`DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`; as written they would have done
nothing at all. Renamed.

**Verified end to end at zero spend.** A presence discovery with
`searchWeb: true` returns `SWARM_ALLOW_LIVE=1 is required before any paid SERP
call` — the exact string from `DataForSeoSerpService.availability()`, which
proves the new path is the live one and the Serper path is gone. That master
switch stays off; turning it on is an operator decision, not a code one.

**Also fixed: the backend's repeated death.** `jobs/pipeline-queue.service.ts`
created its ioredis client with no `error` listener. An `error` event with no
listener is fatal in Node, and with `maxRetriesPerRequest: null` it retried
forever — so a Redis that simply was not running took the API process down in a
loop. Both the main and the `duplicate()`d worker connection now log at warn
instead. The queue is optional infrastructure and must never be able to kill the
API.

**Two smoke failures, neither a code regression.** The full harness reported
11/13 scripts. `authority` failed at project creation with a 429 — global
throttle (100 req/60s per IP), tripped only because thirteen suites run
back-to-back from one address; it passes 22/22 in isolation. `digital-presence`
failed one assertion the same way, but that one reproduced alone: `POST
/social-activity` is throttled at **2 per 60s**, deliberately tight because a
call that got through would spend real Apify credit, and the script makes three
calls in a row. The third was guaranteed a 429 on every run, which read like a
validation regression and was not one. The endpoint is right; the script now
waits out the throttle's own TTL before the third call. `digital-presence` is
**61 passed / 0 failed / 1 skipped**.

**Not done:** DataForSEO also sells an **AI Optimization API** — LLM Scraper at
$0.004 per results page returns real ChatGPT and Gemini responses, which is the
job Cloro does today on a separate trial account. Same "why two vendors"
question, different decision, not taken here.

---

## 2026-09-12 — External presence: DataForSEO business data + Apify social activity (wave 6, step 5)

Closed the two gaps `digital-presence`'s own `assessment.notMeasured` named
since it shipped: "social activity" and "review content and ratings" (decisions
D2/D7, `docs/analysis/wave-6-audit-pipeline.md`). Extended the existing
`digital-presence` module rather than adding a new one, per its own doc's
framing ("ahead of the Apify step").

**Business profile + reviews (D2).** `PresenceDataForSeoService` calls
DataForSEO Business Data → Google My Business Info (profile, hours,
categories, rating) and Google/Trustpilot/Yelp Reviews (rating + count
only — no sentiment is invented over review text), reusing
`serp-intelligence`'s Basic-Auth convention (`DATAFORSEO_LOGIN`/
`DATAFORSEO_PASSWORD`, gated on `SWARM_ALLOW_LIVE=1`). New
`POST /projects/:id/presence/business-profile`; new `PresenceProfile` /
`PresenceReview` models, append-only (a business profile drifts, so each pull
is a new snapshot, never an upsert). Neither credential is set in this
environment — verified the honest 503 end-to-end against a live local
backend, naming exactly what is missing, never a fabricated empty profile.

**Social activity (D7).** `PresenceApifyService` runs the actors D7 selected
per platform (LinkedIn, Instagram, Facebook, X/Twitter by default; YouTube/
TikTok configured but off), async-only (`POST .../actors/{id}/runs` → poll →
`GET .../datasets/{id}/items`, never the 300s sync variant), normalising each
actor's very different raw output into one `PresencePost` shape at the
adapter boundary. `APIFY_API_KEY` is a real key with real spend attached
(`FREE` plan, $5/month), so `POST /projects/:id/presence/social-activity`
requires an explicit `confirmSpend: true` — checked before the project is
even looked up — mirroring the module's existing `searchWeb` opt-in on
`/discover`. **No live Apify call was made at any point building or testing
this** — the adapter is built and reviewed strictly against D7's documented
request/response shapes; only the opt-in refusal path is exercised by the
smoke suite, by design, since a positive-path assertion would have to spend
real credit to pass.

`GET /presence`'s inventory now returns `businessProfile`, `reviews[]` and a
per-platform `socialActivity[]` cadence/engagement summary (derived purely
from stored rows — reading the inventory never triggers a pull or spends
anything), and `assessment.notMeasured` changed shape from a bare string list
to `{ label, state, note }[]`, three-valued the same way `PresenceAccount.state`
already is: `not-built` (no code yet — e.g. directory-listing completeness),
`not-configured` (built, credentials absent here), `not-run` (built and
configured, nobody has pulled it for this project yet). An entry disappears
entirely only once all three are satisfied.

`backend/smoke/digital-presence.smoke.sh` extended (not duplicated): asserts
the 503 for the DataForSEO path and that the Apify endpoint refuses to run
(and stores nothing) without a genuine `confirmSpend: true`, with an unknown
platform also rejected by validation — zero-spend, as the harness's header
comment already promises. `npx tsc --noEmit` clean, no `any`.

## 2026-09-12 — Competitors: first-class rows + light profile + gap comparison (wave 6, step 6)

New `competitors` module (decision D4, `docs/analysis/wave-6-audit-pipeline.md`):
promotes `Project.competitors` (JSON `{name,domain}[]`) into first-class
`Competitor` rows and builds a light profile for each — a homepage tech-stack
scan (reusing wave-6 step 3's `TechStackService.scanDomain` unchanged), a
schema.org/JSON-LD read (`FetcherService.fetchSchema`), and whatever SERP/AEO
presence already exists for that competitor, attached by reference (never a
fresh SERP or AEO run — this module only reads what `serp-intelligence` and
`aeo-audit` have already measured). Explicitly **not** in scope per D4:
running the full `technical-audit` module per competitor. `Project.competitors`
stays populated and readable — additive, not a migration.

`POST /projects/:id/competitors/discover` (merges an optional explicit list
with the JSON column, upserts + profiles), `GET /projects/:id/competitors/profiles`
(latest profile per competitor), `GET /projects/:id/competitors/gap` (a plain
tech/schema presence diff plus each competitor's AEO/SERP status — no
invented composite score).

**Routing note:** the wave-6 doc's API table lists the list endpoint as bare
`GET /projects/:id/competitors`, but that exact path is already owned by
`ProjectsController` (the named-competitor list + SERP-discovered candidates
the RivalsPanel frontend reads). Adding an identical route would have silently
shadowed it, so this module's list endpoint lives one segment deeper
(`/competitors/profiles`) instead of touching a live, frontend-consumed
response shape.

Verified end-to-end against a live local backend with real domains
(cloudflare.com, stripe.com): `backend/smoke/competitors.smoke.sh`, 20/20
passed — promotion (JSON + explicit merge), a completed profile with a
`TechStackScan` reference, honest `"unknown"` AEO/SERP attachment on a fresh
project (no prior audit/tracker to attach), a domain-less competitor's
profile correctly `"skipped"` rather than crashing, and the gap diff
correctly attributing Cloudflare's CDN signature to `competitorsOnly` once
the client's own (deliberately unresolvable) domain scan fails honestly.
`npx tsc --noEmit` clean, no `any`. Left out for v1: crawling high-signal
pages beyond the homepage — see the module's `LEFT-OUT.md` for why (the
fetcher's schema helper doesn't surface HTTP status, so a multi-page crawl
couldn't yet distinguish "no JSON-LD here" from "this page didn't load"
without doubling the request count).

## 2026-09-12 — The console gets navigation, and the backend gets read

An audit of what the frontend actually reaches found the real problem, and it was
not styling: **39 modules, 231 endpoints, the frontend touching about 40 routes.**
The console was a *launcher* for work whose results were then invisible. Ten of
twelve agent cards could only run things — a form, a button, a one-line toast —
while the output went into the database unread.

**A navigation rail (`NavRail`).** The console had no navigation at all: a fixed
three-band canvas plus four full-screen workspaces, each reached from inside an
unrelated surface. Competitors sat four clicks deep behind an agent card, tech
stack was the fifth section of the Technical audit, keyword research had no route
whatsoever. Seven destinations now, one click each. The rail never hides — the
responsive cliff that drops the Audits card below 1000px is survivable because
those figures exist elsewhere, but losing the only route to a section is not.

It is deliberately a router, not a dashboard: no counts, no badges. A nav that
reports state has to be kept in sync with that state, and a stale badge is worse
than none.

**`AgentReports` — one component, config per module.** The instinct is a bespoke
workspace each; that is exactly how four workspaces ended up behind four
unrelated doors, and repeating it eight more times makes navigation worse, not
better. Each module supplies ~15 lines mapping its own shape onto a common row.
Six modules read today — authority, SERP, mentions, council, journeys, personas —
and `notMeasured` is **mandatory** in every config, because the costliest failure
in this product is a reader taking an absence for a finding. A failed fetch is
rendered as a failed fetch, never as a result of zero.

**`KeywordsWorkspace`** — the module that had endpoints and no UI. One rule
shapes it: DataForSEO returns Google Ads *advertiser* competition, so the column
is **"Ad competition"**, never "Difficulty". Relabelling it would have an SEO lead
planning against a number that means something else.

**`DeliverablesWorkspace`** — `reporting` and `scorecard` had no UI at all, which
meant the thing the business sells was the one thing the console could not
produce. Visibility is stated on every row and never inferred: a control that
quietly defaults to public is a data leak with a nice animation. Reports show
when they were generated, because they snapshot findings rather than tracking
them — without the date an operator sends a client a report that predates the fix
they just shipped.

**`AuditsSection`** — splits the old card's two contradictory jobs. The card keeps
the summary on Overview; this section owns launching. One job each.

**Four shape mismatches caught by checking rather than assuming:** `/tech-stack`
returns `{ scan }` wrapped, scorecard's list returns a bare array, report
visibility is `PUT` not `PATCH`, and the keyword `GET` is enveloped as `{ sets }`.
All four would have compiled and failed at runtime.

**A layout bug the first paint caught.** The Flywheel is `absolute left-0` with a
`-50%` translate — half of it *deliberately* hangs off its container's left edge.
That container used to be the window, so the wheel emerged from the window edge.
With the rail in front of it, the same overflow rendered the wheel **on top of the
navigation**. The canvas is now clipped, so the rail becomes the wall the wheel is
welded to. (The Context drawer is flush `right-0` and never protrudes, so nothing
else is affected by the clip.)

**Monitoring joins `AgentReports`** — the only module returning a single object
rather than a list. Rather than bend it into a fake list of one, its figures
*become* the rows, which is what a snapshot actually is. No tone colouring on
them: a score is not a pass or a fail without a target, and colouring it as one
would invent a threshold nobody set.

**Verified:** `tsc` and eslint clean across both sides; the rail confirmed
rendering in the real canvas. **Not verified:** the populated states — the browser
session expired mid-pass and I do not enter credentials, so every section's
with-data rendering is unconfirmed. Plan: `docs/analysis/ui-ux-refinement.md`.

---

## 2026-09-12 — Competitors workspace + tech stack in the UI (wave 6, step 8)

The last step in the wave. Three modules had working backends and no way to reach
them from the console; two of them now do.

**Competitors workspace** — five tabs (Overview / Presence / Tech / Schema /
Rivals), matching the AEO and Presence pattern. Reached from `RivalsPanel`, which
was already "the competitive surface", rather than as a fifth tile on the Audits
card — that card is a list of *disciplines*, and competitors is not one, so
adding it there would have made the card stop meaning what it means.

Three rules the layout enforces:

- **`unknown` is not `absent`.** A rival whose `aeoStatus` is `unknown` means no
  completed audit exists to attach — nobody has looked. Rendering that as "not
  present" would report an unasked question as a negative finding, which is the
  same error the presence module's `not-checked` state exists to prevent.
- **`competitorsOnly` leads every diff.** What rivals have and the client does
  not is the half a client acts on; `clientOnly` is reassurance and sits last.
  The order *is* the argument.
- **An empty client side is called out explicitly.** With nothing recorded on the
  client's own side, every rival signature shows as a gap — the view says so
  rather than letting a missing scan read as a competitive deficit.

**Tech stack on the Technical audit** — a new `stack` section beside Structure.
Deliberately **not** folded into the audit score: a CMS is not a defect, and
scoring "uses WordPress" would turn a fact into a judgement the rubric cannot
defend. Each row prints the evidence that triggered it, because a detection you
cannot check is indistinguishable from a guess. A failed scan says so as a *fetch*
problem, not as a finding about the stack.

**This also closed the one item left unverified from the previous round.** The
per-competitor presence crawl (step 6) had compiled but never been seen working —
I had killed its probe by restarting the backend underneath it. Run properly
against `rothenhall.com` and its three real rivals, all three profiled, and the
gap produced an actual finding:

```
client platforms: linkedin
they have, you do not:  x        <- Athena, Peec AI
                        youtube  <- Peec AI
shared:                 linkedin
```

**Left:** `keyword-research` still has no UI — outside this step's bullet, but it
leaves that module reachable only by API. `tsc` and eslint clean on both sides;
all three endpoint shapes the new UI consumes verified live.

---

## 2026-09-12 — Image/alt coverage + duplicate content (wave 6, step 7)

Stage 4's residue, and the last backend step in the wave. Thin content already
existed; these are the two that did not.

**Image/alt coverage** — new `images-missing-alt` code. The distinction the whole
check turns on: **a missing `alt` attribute is the fault; `alt=""` is not.** An
empty alt is the correct, deliberate marker for a decorative image. Flagging it
would tell a client to "fix" markup that is already right — and worse, train them
to stuff junk text into an attribute whose emptiness was the point. The extractor
drops anything the author marked decorative (`alt=""`, `aria-hidden="true"`,
`role="presentation"`, 1x1 tracking pixels) before counting, so the denominator is
images that were *supposed* to describe something.

Band is 25% missing, not zero: one undescribed image out of twenty is a typo, and
flagging it would bury the page where half of them are undescribed. A page where
**every** image lacks alt trips regardless of ratio.

**Duplicate content** — new `duplicate-content` code, applied run-level after the
crawl, because a single page cannot know it is a duplicate. Exact matches only,
on a whitespace-normalised fingerprint. Near-duplicate detection needs a
similarity threshold, and a threshold is a number this module would have to
invent and then defend to a client; an exact match is a fact — these two URLs
serve the same copy.

**Every** page in a duplicate group is flagged, not just the later ones. Without
knowing which URL the client treats as canonical, nominating one as "the
original" would be a guess dressed as a finding. Errored pages are skipped —
they carry no copy to duplicate, and are already reported as `page-error`.

`AuditPage` gains `imageCount`, `imagesMissingAlt` and `contentHash`. The hash is
compared **within** a run only; across runs, a site-wide copy change would make
every page look newly duplicated.

**The checks also had to be *reported*, not just stored.** `summarisePages` had
named roll-ups for JSON-LD, titles and meta and nothing for alt, duplicates or
even thin content — so the new codes sat in the generic `issueCounts` map for
someone to notice. Added `pagesThin`, `pagesWithMissingAlt`,
`pagesWithDuplicateContent`, and site-wide `imagesTotal` / `imagesMissingAlt`
summed over **every** crawled page rather than only flagged ones: "31 of 212
content images have no alt text" is a work item, where a list of flagged URLs is
just a diagnosis. The `page-inventory` finding now says so in prose, each clause
appearing only when there is something to say — a clean site should not read as a
list of zeros.

**Verified:** 10/10 rule cases — band edges (5-of-20 clean, 6-of-20 flagged),
all-missing regardless of ratio, errored pages reporting only `page-error`, null
hashes not grouped with each other, whitespace normalisation — plus the extractor
over real markup: 4 content images / 2 missing from a sample containing an empty
alt, an `aria-hidden`, a `role="presentation"` and a tracking pixel; and the roll-ups over a mixed page
set (1 alt-flagged, 2 duplicates, 1 thin, 36 images / 13 missing), confirming
null image counts on errored pages are ignored rather than summed as zero-width
holes. `tsc` clean.

---

## 2026-09-12 — Closing the remaining gaps in steps 0–6

A bullet-by-bullet re-audit of steps 0–6 found six items that had been written
down but not built. Four are now done; one is blocked on credentials and one is
a deliberate, documented deviation.

**Competitor presence (step 6's biggest gap).** The plan says step 6 orchestrates
*steps 3–5* per rival; it ran step 3 and attached existing SERP/AEO, but never
step 5 — so the gap report compared **tech stacks and nothing else**. Each
competitor's own site is now crawled with `PresenceDiscoveryService.crawl`,
reused unchanged (it already took a bare domain, so it was competitor-ready),
and `GET /competitors/gap` gained a **`presence` diff** beside tech and schema.
"Three of your four rivals are on Clutch and you are not" is a decision a client
acts on; a tech-stack diff is trivia. Company profiles only — a rival founder's
personal LinkedIn is not their company's footprint, and counting it would inflate
the very comparison this feeds. Crawl only: DataForSEO/Apify spend real money per
entity, and silently multiplying that by the competitor count is not a cost
anyone asked for.

**`byMarketSurface` (step 2).** Existed only as a word in a code comment.
`byMarket` alone says "weaker in GB"; `bySurface` alone says "weaker on Gemini";
only the cross says *Gemini in GB* is the hole — and that is the one an operator
can act on. Populated only when more than one market was measured, since on a
single-market audit it would just repeat `bySurface` with a redundant column.
Each cell carries **its own** run status, so an engine that failed in one market
but worked in another cannot inherit the aggregate and vanish.

**Consistency rules shared, not duplicated (step 5).** The plan said reuse
`entity-audit`'s descriptor logic; `digital-presence` had no consistency check at
all. The rules are now extracted into `entity-audit.consistency.ts` (pure, no
Nest, no Prisma) and **both** modules import it — two modules disagreeing about
what a name match is would be worse than either rule alone, since the same client
would read as consistent on one screen and inconsistent on the next.

Two rules, because a recorded name and a fetched page title are not the same
evidence. `namesMatchExactly` is strict: an operator typing "Acme" against "Acme
Ltd" is a real inconsistency, and fuzzy-matching it away hides exactly what the
check exists to find. `titleIdentifies` is containment, matching what
`fetcher.verifyUrl` already does — platforms pad titles ("Acme Ltd | LinkedIn"),
so equality there would mark every genuine profile a mismatch. Accounts now carry
`nameConsistency`; no title (every walled platform) stays `not-checked` rather
than defaulting to a verdict.

**Cloro concurrency is now a contract, not an accident (step 1).** The executor
runs prompts sequentially, so concurrency was 1 by coincidence. `CloroClient`
now enforces it with an in-flight gate and FIFO queue read from
`CLORO_MAX_CONCURRENCY` (default 1), so nothing upstream parallelising can
silently exceed the plan and start getting tasks rejected mid-run. Slots release
in a `finally` — a thrown task must not permanently shrink the pool.

**Left, honestly:** DataForSEO Business Data and per-competitor keyword research
both need `DATAFORSEO_LOGIN`/`PASSWORD`, still unset — blocked on credentials,
not on code. And Cloro submission still uses `/v1/async/task` rather than the
planned `/v1/async/task/batch`: the adapter's own docstring records that the
batch schema was never confirmed, and guessing at it without a live call would
trade a working path for an unverified one. Same cost, more round-trips.

---

## 2026-09-12 — Closing the two deferred bullets in steps 0–6

A sweep back over steps 0–6 found everything structurally present, and exactly
two things that had been written down as deferred rather than done.

**1. Pre-flight budget (step 0's deferred bullet).** Step 0 shipped without the
credits-vs-allowance display because credits had no meaning until the Cloro
adapter existed. It does now. `GET /projects/:id/aeo/budget?surfaces=&tier=&runCount=&markets=`
prices a configuration before it runs, and the AEO workspace shows it live while
the operator is still choosing.

The run-time guard already refused an unaffordable run — but learning it *after*
the click is the wrong place. Browser surfaces report **0** credits, because a
subscription pays for them and a fabricated per-call price would corrupt the
total. When the balance cannot be read, `remaining` and `fits` are **null** with
the reason stated: an unknown balance is neither sufficient nor insufficient, and
a reassuring tick on a guess is worse than no tick.

The first live call earned its keep: **228 credits remaining, `trial` × 3 engines
needs 325** — a run that would have been refused mid-flight, now visible before
pressing anything.

**2. Demand weighting (step 4's unbuilt bullet).** `generateMatrix` now takes an
optional `DemandIndex` — keyword → monthly search volume, read from the project's
latest `KeywordSet` — and orders the client's services by measured demand.

This matters most where the budget is tightest. Verified on a synthetic context
whose services were deliberately ordered worst-first: the `trial` tier's single
service-discovery prompt moved from *"who provides driver onboarding"* (no
demand) to *"who provides dispatch automation"* (9,900/mo). Same prompt count,
deterministic across repeat runs, and an empty index is byte-identical to no
index at all.

**Ordering only.** No prompt is invented, dropped or rewritten because of a
volume number — cells are still built from the client's own context, so a stale
or wrong keyword set can reorder the matrix but can never put a service in it
that the client does not sell. Services with no matching keyword keep their
original order and sit *after* the matched ones: absence of a volume figure is
not evidence of low demand. Keyword matching is deliberately blunt (either term
containing the other, normalised) — fuzzy matching would start pairing things a
human would not, and a wrong pairing here emphasises the wrong offering.
`GeneratedMatrix.demand` records what was applied, so an oddly-ordered matrix can
be traced to the volumes that ordered it instead of looking arbitrary.

Both are additive and gated: no Cloro key → the budget line hides; no keyword
research → the matrix generates exactly as before.

---

## 2026-09-12 — Keyword research (wave 6, step 4)

New `keyword-research` module: search volume, competition/CPC, and
related/long-tail suggestions for operator-supplied seed keywords, via
DataForSEO Keywords Data — the same vendor account already wired for
`serp-intelligence` (decision D5, `docs/analysis/wave-6-audit-pipeline.md`,
stage 10 pulled forward). `POST /projects/:id/keyword-research` (body:
`keywords[]`, optional `locationName`/`languageCode`/`includeRelated`) and
`GET /projects/:id/keyword-research?setId=&minVolume=` run synchronously, no
job queue. "Difficulty" is reported honestly as DataForSEO's Google Ads
advertiser-competition fields (`competition`/`competitionIndex`) rather than
relabelled into an organic-SEO metric this vendor endpoint doesn't provide.
Gated on `SWARM_ALLOW_LIVE=1` + `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`,
neither of which is set in this repo's `.env` — verified the honest 503 path
(no `KeywordSet` row written) end-to-end against a live local backend, plus
input validation and 404 ownership checks: `backend/smoke/keyword-research.smoke.sh`,
8/8 passed. A real paid DataForSEO call was out of scope for this pass (no
credentials in this environment). Left out for now: automatic seed
derivation from `SiteContext.services` (explicit `keywords[]` input only in
v1) and feeding the AEO matrix generator a demand weighting — an optional
stretch goal, not attempted — see the module's `LEFT-OUT.md`.

## 2026-09-12 — Markets picker/tab, and Cloro surfaces reachable from the UI (wave 6, steps 1-2 leftovers)

Two frontend gaps closed after a status pass over wave-6 steps 0-3.

**Markets (step 2).** The AEO workspace had zero market/geo UI even though the
backend has fully supported multi-market runs since D8. Added a Markets
toggle group to the run-config bar (sourced from the site's own ranked
`context.markets`, capped at 5, empty selection lets the backend apply its
own top-ranked default) and a Markets results tab, shown only when an audit
actually measured more than one market. Verified end-to-end against the real
`rothenhall.com` demo project: a mock-surface run with `markets: ["US","GB"]`
produced the exact `counted.byMarket` shape the new UI expects.

**Cloro surfaces (step 1).** The frontend's `AeoSurface` type and engine
picker only ever listed the three `-browser` surfaces — the five `cloro-*`
surfaces built in step 1, which wave-6 D1 calls *the default path* (no
session file, no ToS exposure), were impossible to select from the UI at
all. Added them to the type and the engine picker (offered first; the
`-browser` trio remains, both for operators with a session configured and as
Cloro's automatic fallback).

## 2026-09-12 — Tech-stack fingerprinting (wave 6, step 3)

New `tech-stack` module: deterministic technology detection (CMS, ecommerce,
hosting/CDN, analytics, ads, CRM, chat, tag managers, A/B testing) from a
single fetch's headers, HTML and scripts — no vendor, no API key, no
per-lookup cost (decision D3, `docs/analysis/wave-6-audit-pipeline.md`).
`POST /projects/:id/tech-stack/scan` (optional `domain` override, defaults to
the project's own) and `GET /projects/:id/tech-stack` run synchronously, no
job queue. A blocked/unreachable domain is stored as `status: "failed"`, HTTP
200, never a 500. Verified live: real Cloudflare detection against
`cloudflare.com`, honest failure against an unresolvable domain — see
`backend/smoke/tech-stack.smoke.sh`. Left out for now: cookie-based
signatures (fetcher doesn't parse `set-cookie`) and JS-rendered tags (would
need a Playwright render) — see the module's `LEFT-OUT.md`.

## 2026-09-12 — The company footprint, not the founder's; and stage 2 gets its *analyse* half

Two corrections after reading the delivery flowchart properly. Both were mine.

**1. I let a founder into a company audit.** Yesterday's fix kept a declared
`sameAs` profile that had been silently dropped — a Google Scholar page. Keeping
it was right; *counting it as company presence* was not. `rothenhall.com` declares
an `Organization` (company LinkedIn) and a `Person` (personal LinkedIn + Scholar).
Reported flat, that reads as **3 company profiles**. The truth is **1**.

Every row now carries `entity` — `company` | `personal` | `unknown` — decided by
**the site's own schema `@type`** first (a `sameAs` under `Person` is a person's),
then the URL shape (`/company/` vs `/in/`, and Scholar/ORCID as always personal).
Personal rows are excluded from every count, cannot close a gap, and render in a
separate section. The SERP sweep now searches `site:linkedin.com/company` for the
same reason.

**2. Stage 2 is five discover/analyse pairs; I had built only the discover half.**
The flowchart's "External Presence & Reputation" asks for Social Profiles,
Industry Directories, Business Profiles, Marketplaces and Review Platforms — each
with an *Analyze* step beside it. The module produced an inventory and no
analysis.

`GET /presence` now returns an `assessment`: `headlines` (plain language, worst
first, no score), `coverage` per category (`covered`/`partial`/`absent`/
`not-checked`), and **`notMeasured`** — what the module cannot see yet, named
explicitly rather than implied by silence. The workspace leads with an **Analysis**
tab.

**The bug that made stage 2 structurally impossible.** The expected-platform list
was social-only, so directories, reviews and marketplaces could never be a gap —
four of five categories read "not checked" forever. Expected platforms are now
keyed on an inferred business type (B2B services / B2B software / local services /
consumer brand), taken from the client's own category text. The assessment prints
the type *and* the text it was inferred from, so a wrong guess is arguable instead
of invisible.

On `rothenhall.com` — read as "B2B services / consultancy" from *"b2b growth
operating partner"* — this turns a bare account list into findings:

```
1 company profile found across 1 category.
Industry & business directories: none found.   (Clutch, Crunchbase)
Review platforms: none found.                  (Glassdoor)
Social media profiles: X / Twitter missing.
2 personal profiles recorded separately and excluded from the counts above.
```

**Verified:** `digital-presence.smoke.sh` **50 passed, 0 failed, 1 skipped**,
including the invariant that adding a personal profile does not move the company
total. `tsc` clean both sides.

---

## 2026-09-12 — Declared `sameAs` profiles are no longer silently dropped

Chasing "why does rothenhall.com only show LinkedIn?". The answer to the question
as asked is **the site only links LinkedIn** — two URLs, both LinkedIn, and the
module reported that correctly. But the investigation found a real defect beside
it.

`rothenhall.com` declares this in its schema markup:

```json
"sameAs": ["https://www.linkedin.com/in/kunalachintyareddy/",
           "https://scholar.google.com/citations?user=8ajuQHEAAAAJ&hl=en"]
```

The Google Scholar profile matched no signature, so it was **discarded without a
trace** — a client's own declared identity, lost to a missing regex, in a module
whose entire job is "show everything we found".

**The rule that was wrong:** the classifier was applied identically to page links
and to `sameAs`. Those are not the same kind of evidence. For a page link, no
match means *"probably a share widget"* and dropping it is right. For `sameAs`,
the site's author has asserted ownership — there is no ambiguity to protect
against, only a gap in our table. Unrecognised `sameAs` URLs are now kept as
`platform: 'other'` ("Declared profile"); self-references are still skipped.

rothenhall.com went 2 accounts → **3**, with the Scholar profile `confirmed`
(it resolves, unlike the walled LinkedIn pages).

**And the actual footprint question**, answered by running the opt-in sweep: 4
queries surfaced one candidate, `instagram.com/rothenhall.partners` (60% name
match), awaiting confirmation. Facebook, X and YouTube returned nothing — which is
a finding, not a failure.

**Verified:** `digital-presence.smoke.sh` 42/42, `tsc` clean both sides.

---

## 2026-09-12 — Google account discovery, as candidates; PageSpeed off the connectors list

**PageSpeed Insights removed from the connectors panel.** `PSI_API_KEY` is a
server-side key consumed by `technical-audit` for Core Web Vitals, not something
an operator connects per workspace, so it no longer sits in the Google block
pretending to be one. The roster went 11 → 10. **The capability is untouched** —
CWV still runs; what is gone is the connector row and, with it, the only UI that
warned when the key was unset.

**SERP account discovery — the half I deferred, now done.** The site crawl only
ever finds what a client chose to link; plenty of real accounts are not linked at
all. I had skipped search purely on cost. With a Serper.dev key that objection is
gone — but the *accuracy* objection never was, and the live data is emphatic:

```
site:instagram.com "HubSpot"
  instagram.com/hubspot/           theirs
  instagram.com/hubspotlife/       theirs
  instagram.com/hubspotacademy/    theirs
  instagram.com/reel/DWVj-HrjmeU/  a reel — classifier rejects it
  instagram.com/hubshotspodcast/   a different company entirely
```

And for Notion the **top** name match (`instagram.com/notion`, 100%) is *not* the
official account — `@notionhq` at 75% is, while `@ivanhzhao` and `@simonlast` are
the founders. Any threshold would have picked wrong. So similarity is an ordering
hint and **nothing branches on it**.

Search results therefore land as `state: 'candidate'`, `source: 'serp'`: excluded
from every count, unable to close a gap, and promoted only by an operator's
explicit yes via `POST /accounts/:id/confirm` — after which they are `manual` and
survive re-runs. The workspace gets a **Suggested** tab with "Yes, this is us" /
"Not us".

**Cost control, three layers.** The sweep is **opt-in per run** (`searchWeb:
true`); it queries **only platforms still missing** after the crawl; and
`PRESENCE_SERP_MAX_QUERIES` (default 5) caps a single run. Verified: a client
holding 4 of 5 platforms spent **1** credit, not 5.

**A zero-spend violation, caught and fixed.** The first working version swept on
every discovery, and the smoke run duly burned 3 real Serper credits — in a
harness documented as zero-spend by contract. A harness that quietly bills is
worse than one that skips, so the sweep became opt-in and the smoke now *asserts*
that a default run spends nothing and states why it did not search.

**Two dedupe bugs the live runs exposed.** A Notion sweep first returned **20 rows
for 16 accounts**:
- LinkedIn's handle pattern was not end-anchored, so `/company/notionhq/life`,
  `/jobs` and `/about` each stored as a separate URL. Canonicalisation now
  truncates to the matched profile prefix.
- Google returns `linkedin.com`, `do.linkedin.com` and `ar.linkedin.com` for the
  same page; locale subdomains now collapse onto the base host. (Substack, where
  the subdomain *is* the account, is resolved earlier and unaffected.)
- Separately, YouTube's pattern *was* end-anchored, so `/channel/UC…/videos` was
  dropped entirely rather than collapsed — a whole class of real channels missed.

**Verified:** classifier 41/41 with no regression, plus 6 canonicalisation and 6
case-folding cases; `digital-presence.smoke.sh` **41/41**; full suite **10/10
scripts, 296 passed, 0 failed, 2 skipped**, with zero search credits spent.

**Left for later:** `SERPER_API_KEY` is stored in `backend/.env` (gitignored) and
placeholdered in `.env.example`. The UI for the paid sweep lives in the workspace's
Suggested tab, where the credit cost is printed on the button rather than hidden.

---

## 2026-09-11 — Digital presence: discovery, gaps, and operator-supplied accounts

A new module and a new card **above** the Audits card, answering the question
that comes before any score: **where does this client exist online, and what do
we actually know about them?**

**Discovery costs nothing external.** `intake` was already parsing every outbound
link on a client's homepage and classifying `instagram.com`, `facebook.com`,
`linkedin.com` as "not a competitor" — then throwing them away. Those are the
accounts. This module keeps them, plus JSON-LD `sameAs`, which is where a site
declares its profiles machine-readably.

**Two design rules, both load-bearing:**

1. **Three account states, never two.** A logged-out fetch *cannot* verify most
   social profiles — Instagram and Facebook serve login walls, LinkedIn answers
   datacentre IPs with `999`. So a profile linked from the client's own footer
   that we fail to fetch is `unverified`, **not** `missing`, and carries the
   platform's own reason verbatim. Collapsing the two would report a working
   account as absent and send an operator to fix something that is fine. Walled
   platforms are not fetched at all: being told "log in" is the same answer as
   not asking, more slowly, while looking like scraping.
2. **Most links to a social host are not accounts.** `facebook.com/sharer.php`,
   `twitter.com/intent/tweet`, `pinterest.com/pin/create/` and bare hostnames all
   pass a naive host match, and each would be shown to a client as their account.
   A candidate must clear host match, reject-pattern, *and* a platform-shaped
   handle. 41/41 classifier cases pass, including every share-widget rejection.

**The manual path is first-class, not a fallback.** When discovery finds nothing —
common, and not an error — the operator pastes a URL. Platform and handle are
derived from it, because they already encoded both when they copied the link. A
later re-scan re-verifies operator rows but **never** downgrades their provenance.

**Beyond social:** `GET /presence` also assembles identity, owned properties,
connected data, answer-engine coverage and competitors from the five modules that
own those facts, each line labelled with its source. Footprint rows are
three-valued too — **`not-checked` is not `none`**; a module that never ran and a
module that found nothing are different answers.

**A bug the live test caught.** Against `hubspot.com` the first run reported **9**
accounts, two of them TikTok: `@HubSpot` from JSON-LD and `@hubspot` from the
footer. Handles are case-insensitive on these platforms, so one account was being
stored and reported as two. Added `foldCase` per platform, with
`caseSensitivePath` carving out YouTube's `channel/UCxxx` ids, which are *not*
case-insensitive and would break if lowercased. Re-run: **8 accounts**, TikTok
deduped, JSON-LD provenance correctly winning the tie.

**Verified:** `digital-presence.smoke.sh` — **35 passed, 0 failed**, including the
re-scan-preserves-operator-input rule and six false-positive rejections. Live
against `hubspot.com`: 4 pages, 8 accounts, 5 JSON-LD / 3 page-link, zero false
positives on a site full of share buttons.

**Left for later:** social *activity* (followers, cadence, engagement) is wave-6
step 5 via Apify — this module defines the accounts that step will enrich, which
is why it landed first. Client-facing wording for `unverified` is still open (see
the analysis doc §9): internally honest, but "found, not verifiable" may read as
our failure rather than the platform's refusal.

---

## 2026-09-11 — `trial` matrix tiers (wave 6, step 0)

Two small tiers for measuring on a **metered surface with a free allowance**,
where the credit budget — not the analysis — is the binding constraint.

- `TIER_SIZES` gains **`trial: 5`** and **`trial-wide: 10`**, joining scorecard /
  standard / full. `MATRIX_TIERS` is now exported and the DTO enums read from it,
  so the tier list exists in exactly one place.
- **Approved sizing: `trial` = 5 prompts × 3 engines.** Cross-engine comparison is
  the thing this audit does that nothing else does, so a scarce budget buys that
  before it buys breadth. `trial-wide` (10 × 1 engine) answers the breadth
  question instead.

**The bug this exposed.** The generator floored *every* eligible dimension at one
prompt before weighting, so a 5-prompt tier produced **10** — the tier meant to cap
spend would have doubled it, quietly. When `target < eligible.length` the budget
now goes to the `target` heaviest-weighted dimensions, one prompt each, and every
unfunded angle is recorded in `skipped` with the reason. Ties break on declaration
order so the split stays deterministic.

**Verified** against a synthetic context: `trial` → 5 prompts / 5 categories,
`trial-wide` → 10 / 10, identical across repeat runs, and `competitor-alternatives`
and `head-to-head` both survive the cut. Smoke coverage added for all of it,
including the "did the brief's two must-have categories survive" assertion.

**Frontend:** the workspace defaults to `trial` and labels any sub-10 tier
**"probe only — covers 5 of 10 angles"**. A five-prompt result must not be able to
read as full coverage.

**Also fixed: the smoke harness had an invisible dependency.** `run-all.sh` claims
zero-spend via deterministic adapters, but three of those adapters are gated by env
vars that lived only in a developer's shell — not in `backend/.env`, not in the
harness. Starting the backend the documented way produced **5/9**, with four
scripts failing on gate errors that read exactly like code regressions. The gates
(`MEASUREMENT_ALLOW_MOCK`, `INTERNAL_LINK_ALLOW_FIXTURE`, `SERP_ALLOW_FIXTURE`) are
now in `backend/.env` and named in the `run-all.sh` header. Verified: **9/9 scripts,
255 passed, 0 failed, 2 skipped.**

**Left for later:** the size selector shows calls and wall-clock, not
credits-against-allowance. There is no credit concept until the Cloro adapter lands
in step 1 — a number invented here would be a guess presented as a budget.

---

## 2026-09-11 — Three answer engines + the customer-facing AEO workspace

**Perplexity and Gemini join ChatGPT**, and the audit now runs the *same* prompt
matrix on each so they can be compared directly. That comparison is the point:
"named on Perplexity, invisible on ChatGPT" is a finding a single-engine audit
cannot produce.

**Search stays in the browser; analysis stays on OpenRouter.** An API answer is
not what a buyer sees, so every engine is the vendor's consumer product driven in
headless Chromium with an operator-supplied session. (An OpenRouter-backed
search adapter was built and then removed once that boundary was set.)

- `browser-surface.adapter.ts` generalises the old ChatGPT-only adapter into one
  base class plus a `SURFACE_PROFILES` table — only the per-site selectors,
  block signals and own-host patterns differ. `chatgpt-browser`,
  `perplexity-browser` and `gemini-browser` are thin subclasses.
- Same contract as before, now across three vendors: **no CAPTCHA solving, no
  stealth layer, no credential handling.** A challenge, block, rate limit or
  signed-out session fails the observation with a typed reason and stops.
- New typed reason `selector-drift`, which names the constant to update — the
  failure mode most likely to bite, since each engine breaks whenever its vendor
  changes the UI.

**A failed engine no longer voids the audit.** New `AeoSurfaceRun` rows track
each engine independently: status, observations, cost, and a `failureKind`. If
Gemini is blocked while ChatGPT and Perplexity answer, the audit still completes,
and the verdict's headline *names the engines absent from every number above*
rather than quietly reporting a two-engine average as if it were three.

**Schema.** New `AeoSurfaceRun`; `AeoAudit.surfaces` (JSON array, primary kept in
`surface` for compatibility); `AeoStance.surface` so stance rolls up per engine
without a join. All additive.

**Verdict.** `counted.bySurface` gives per-engine mention / unbranded / citation
rates, stance spread and rival-ahead counts. Share of voice deliberately stays
single-engine — averaging SOV across engines would invent a number no engine
produced.

**Frontend — `AeoAuditWorkspace`**, a sibling of the SEO and Technical audit
workspaces, wired to the existing AEO tile and the command palette. Five tabs:

| tab | shows |
|---|---|
| Overview | unbranded visibility gauge, branded-vs-unbranded (never averaged), engine comparison, plain-language headlines |
| Engines | one card per engine — including failures, in plain English |
| Categories | the ten buyer intents ranked worst-first: the gap map |
| Rivals | share of voice, and who gets named while you are absent |
| Prompts | the losing/winning questions with verbatim answer quotes, plus the full matrix |

Two UI decisions worth recording. **Counted and judged are visually separated
everywhere** — every block carries a `counted` or `judged` tag with a tooltip
explaining which numbers are safe to quote, so a reader cannot mistake an LLM
opinion for a measured rate. And the run controls show engine choice, tier and a
**wall-clock estimate** up front, because three engines at the standard tier is
1,500 questions and several hours — the UI treats a run as a job, with a staged
progress view and polling, not as a button that returns a result.

**Verified.** `aeo-audit` smoke **44 passed / 0 failed / 1 skipped**, including
six new multi-engine assertions: three engines recorded, a comparison row each,
typed failure reasons on the gated ones, a dead engine not voiding the working
one, and the headline naming what was not measured. Frontend `tsc` and
`next build` clean; the workspace was driven in a real browser across all five
tabs against live data.

**Still unverified:** none of the three browser adapters has been run against a
live signed-in session. The Perplexity and Gemini selectors in particular are
written from their current DOM conventions and have **not** been confirmed — the
first live run should use `AEO_BROWSER_HEADLESS=0` at `scorecard` tier, one
engine at a time.

## 2026-09-11 — `aeo-audit` analysis passes moved to OpenRouter (cheap model)

The module's three LLM passes — context synthesis, matrix phrasing, stance
judging — now run through a shared `AeoLlmService` that prefers **OpenRouter**
and falls back to Anthropic. These are extraction and classification jobs, not
writing jobs; a frontier model was wasted on them.

**Model chosen by benchmark, not by price.** Candidates were run against the
module's real stance task (four cases: subject absent / led / placed behind /
warned about):

| model | cases | avg latency | $/Mtok in → out |
|---|---|---|---|
| **`qwen/qwen3-30b-a3b-instruct-2507`** | **4/4** | **1.5s** | 0.048 → 0.193 |
| `openai/gpt-oss-120b` | 4/4 | 7.7s | 0.037 → 0.170 |
| `google/gemini-2.5-flash-lite` | 3/4 | 1.1s | 0.100 → 0.400 |
| `openai/gpt-5-nano` | 0/4 | 16s | 0.050 → 0.400 |

The cheapest passing model was not the right one: `gemini-2.5-flash-lite` failed
the **absent** case, calling an answer that never named the subject
`mentioned-neutral`. That single error class turns "you are invisible" into "you
were mentioned" — the headline the audit exists to produce. `gpt-5-nano` burns
its budget on reasoning tokens and truncates the JSON.

**Cost comes from OpenRouter's reported `usage.cost`** — the real charge per call,
not an estimate from a local price table that would drift — so the audit's cost
governor is fed a true number.

**Verified live, end to end:**
- context synthesis: **$0.0006**, `extraction=llm-synthesized`
- stance pass: **125 judgements, 0 failures, $0.0058, ~1.8s each**
  (extrapolates to ~$0.02 / ~15 min for the 500-observation `standard` tier)

**Four real bugs found by running it for real:**

1. **Synthesis result was being unioned with the deterministic list**, which put
   back exactly what the model had been asked to drop — `services[]` contained
   "One accountable owner" and a founder's name alongside real offerings, and
   every junk entry becomes a prompt like "companies that do <person>". A
   successful synthesis now **replaces** that field; the deterministic list is
   only used where the model returned nothing. Result on a real site: 19 noisy
   candidates → **6 real offerings**, and `painPoints`/`outcomes` went from empty
   to populated, which unblocked the `problem-framed` and `job-to-be-done`
   categories that had been skipped entirely.
2. **The verdict named the wrong judge model.** `judged.judgeModel` was read from
   the Anthropic fallback env var, so a report said `claude-opus-5` when qwen had
   actually run. Now read back from the `AeoStance` rows — the model that really
   produced those judgements.
3. **The phrasing pass bled the "terse" rule onto conversational prompts**,
   flattening "Who can help me with RevOps? I run a fund." into "who can help me
   with revops i run a fund". Fixed in the instruction *and* backstopped in code:
   a conversational rewrite that lost its sentence case or terminal punctuation
   is discarded and the template phrasing kept.
4. **Grammar from placeholder interpolation** — "for a funds", "portfolio
   companiess", "a service that solves No single owner of outcome". ICP values
   now carry their own article and pluralisation, and pain/outcome fragments are
   normalised into clauses. The `problem-framed` templates were reworked so every
   slot is grammatical for both noun-phrase and clause-shaped pains.

**Config.** `OPENROUTER_API_KEY` is read from the monorepo root `.env` (the
backend already loads `['.env', '../.env']`). New: `AEO_LLM_MODEL`,
`AEO_LLM_TIMEOUT_MS`, `AEO_LLM_REFERER`. `AEO_STANCE_JUDGE_MODEL` now applies
only to the Anthropic fallback path. Removed the triplicated Anthropic client
code from the three services.

**No new npm dependencies** — OpenRouter is called over raw `fetch`, the same way
`perplexity.adapter.ts` works.

**Smoke.** Two assertions in `aeo-audit.smoke.sh` asserted "no key → 503", which
is wrong in an environment that *has* a provider. They now branch on what the
server actually reports, and the keyed branch is **skipped rather than exercised**
— judging observations is real spend, and the harness is zero-spend by contract.

## 2026-09-10 — smoke harness: stop `users.smoke.sh` poisoning the shared DB

Three harness bugs found while verifying `aeo-audit` against the full suite. All
three made *other* modules look broken; none were product defects.

**1. `users.smoke.sh` demoted the shared smoke operator (the bad one).**
The "cannot demote the last admin → 409" assertion demoted `smoke@cailyx.test`
itself, assuming it was the only admin. On any dev.db with a second admin the
demote **succeeds** (the service guard is correct — `adminCount() <= 1`), the
assertion fails, and the operator every other script logs in as is left as
`content`. Everything downstream then failed with `Role 'content' cannot access
this resource`. Observed: a full run dropping to **6/9 scripts passed**, and it
re-poisoned the DB on every subsequent run.
Fixed by never touching the shared operator's role: the script now creates a
throwaway admin and demotes *that*, asserting `200` (a non-last admin *can* be
demoted — the guard must not over-trigger). The `409` branch needs a sole-admin
database that cannot be manufactured without demoting the operator's real
admins, so it is now an explicit `SKIP` with the reason rather than a
false-failing assertion. Added a `trap EXIT` tripwire that reports loudly if the
operator is ever left non-admin, and throwaway accounts are cleaned up on every
exit path.

**2. `serp-intelligence.smoke.sh` could not recover from its own leftovers.**
Its domain is fixed (the fixture SERPs reference `acme-serp.example`), so a run
that died before its cleanup trap fired left the project behind and the next
create 409'd. It had a reuse fallback, but the fallback read `GET /projects` as
a bare array when the endpoint returns `{projects:[…]}` — so it silently yielded
nothing and the script hard-exited. Now parses both shapes and says when it
reused a stale row.

**3. `dashboard.smoke.sh` — a `|` inside a `node -e` body.**
The journeys assertion built `a.headline+" | "+(a.metric||"")`. On Windows,
Volta's node shim re-parses the command line and treats the bare `|` as a shell
pipe: node never starts ("The system cannot find the path specified.") and the
assertion compares against an empty string, regardless of the payload — which is
correct and well-formed. Reproduced with no backend running. Separator changed to
`" - "`; `||` is unaffected.

Both rules are now documented at the top of `smoke/_common.sh` so they do not
recur: never change the shared operator's role, never put a bare `|` in a
`node -e` body.

**Verified.** `smoke/run-all.sh` twice back to back against the same dev.db:
**9/9 scripts both runs, zero failures, exit 0 both times** (was 6/9 before these
fixes). Afterwards `smoke@cailyx.test` is still `admin`, with no throwaway
accounts and no orphan `acme-serp.example` project left behind.

Per-module, second run: aeo-audit 39/0, authority 22/0, council 22/0,
dashboard 28/0 (was 27/1), internal-link 23/0, journey 43/0, persona 24/0,
serp-intelligence 25/0, users 18/0 + 1 skip.

**Not covered:** the sole-admin `409` branch takes the skip path on any database
with more than one admin, which includes this one. It runs on a fresh dev.db,
where the shared operator is the only admin — the environment the harness is
designed for.

## 2026-09-10 — `aeo-audit` module (ChatGPT-first answer-engine visibility)

**What shipped.** A new `aeo-audit` module that takes a client URL and answers two
questions: does ChatGPT name them when a real buyer asks, and when a competitor is
named alongside them, which one does ChatGPT put in front.

Pipeline: site context → prompt matrix → measurement (n≥5) → stance → verdict.

**Built as an orchestrator, not a rewrite.** Most of the pipeline already existed:
`fetcher` (crawl), `query-set` (versioned prompt storage), `measurement` (run
orchestration, n≥5 floor, `SurfaceAdapter` registry, mention extraction). Genuinely
new: the ChatGPT surface adapter, a deeper site-context extractor, the dimensional
matrix generator, stance analysis, and the orchestrator/verdict.

- **Site context** (`aeo-context.service.ts`) — crawls the client's own site
  (homepage + sitemap-guided service/pricing/about pages), extracts services, ICP,
  pains and outcomes. Deterministic layer always runs; one constrained-LLM synthesis
  pass organises it when `ANTHROPIC_API_KEY` is set, and the row records which.
- **Prompt matrix** (`aeo-matrix.generator.ts` + `.service.ts`) — ten buyer
  categories including the two called out explicitly, competitor-alternatives and
  head-to-head. Deterministic cells define coverage; an optional LLM pass rewrites
  only the phrasing, and a rewrite that drops the named entity the cell exists to
  test is rejected. Stored as a versioned `QuerySet` (`source="aeo-matrix"`), so it
  inherits immutability-on-activation, versioning and client export.
- **Prompt categorisation is persisted** — `QuerySetItem.dimension` (indexed) plus a
  `meta` JSON carrying register, branded/unbranded, the service or competitor the
  cell targets, and the template id. `AeoStance.dimension` copies it so results roll
  up per category without a join. This is the curation surface: filter by category,
  see which cells produced signal, hand-edit the rest.
- **ChatGPT surface** (`measurement/adapters/chatgpt-browser.adapter.ts`) — drives
  chatgpt.com in Playwright with an operator-supplied session. Added behind the
  existing `SurfaceAdapter` interface, exactly where `measurement.types.ts` said a
  ChatGPT adapter would go.
- **Stance analysis** (`aeo-stance.service.ts`) — judges how each answer positioned
  the client (`recommended-primary` … `absent`), which competitors it placed above or
  below them, with a verbatim quote.
- **Verdict** — `counted` and `judged` in separate blocks and separate tables.

**Counted vs judged.** Every rate (mention, citation, share of voice) comes from
deterministic counting over n≥5 repeats. Stance is an LLM opinion, stored apart,
evidence-quoted, and never expressed as a rate — the `claims` module's provenance
discipline applied to this module's output.

**ToS note on the surface choice.** Decision D1-B: the operator chose the browser
surface over the OpenAI API after reviewing the trade-offs. Automating chatgpt.com is
against OpenAI's Terms of Use and the risk sits with whoever supplies the session. The
adapter contains **no CAPTCHA solving, no stealth/anti-detection layer, and no
credential handling** — when ChatGPT challenges, blocks or rate-limits, it fails the
observation with a typed reason and stops. Off by default
(`AEO_ALLOW_BROWSER_SURFACE=1` + a session file). The API adapter remains available to
add later behind the same interface.

**Schema.** New: `SiteContext`, `AeoAudit`, `AeoStance`. Modified (nullable-only, no
data migration): `QuerySetItem.dimension`, `QuerySetItem.meta`, plus two indexes.
`Surface` union widened with `chatgpt-browser`.

**Dependencies.** No new npm packages, no new paid services.

**Verified.** `backend/smoke/aeo-audit.smoke.sh` — 39/39 assertions, zero API keys,
zero spend: context → matrix → 125 observations on the mock surface at n=5 → verdict,
plus honest-gate checks (no key → `extraction=deterministic`, `refined=false`,
`judged.available=false` with a reason, stance → 503; `runCount=3` → 400; completed
audit re-run → 409; disabled browser surface → audit marked `failed`, never an empty
verdict). `npx tsc --noEmit` and `nest build` clean.

Also exercised against a real site (rothenhall.com), which surfaced and fixed three
real extractor bugs: marketing sentences being captured as service names, a SPA
catch-all inflating `pagesFetched` (8 phantom pages → 5 real ones, now content
fingerprinted), and a `"this kind of service"` placeholder leaking into prompts —
category now falls back to a real extracted service, or the cell is dropped and
reported in `skipped`. Also tightened service extraction (single-word pricing
tiers and process steps rejected, team/testimonial blocks excluded, a/an article
fixed): 19 candidates → 10 on that site. Produced 90 clean prompts across 7
categories.

**Known limitation, documented not papered over.** Deterministic extraction is
heading-based, so a site's values and team names can still land in `services[]`
("One accountable owner", a founder's name) and get interpolated into prompts.
The LLM synthesis pass is what resolves this — set `ANTHROPIC_API_KEY` for any
client-facing run, and review `services[]` before activating a matrix built
without it. Deliberately not chased with more heuristics: telling a value apart
from a service without reading meaning is guesswork, and a wrong guess silently
corrupts the matrix.

**Left for later.** The browser surface has not been run against a live ChatGPT
session — its selectors are written against the current UI but unverified end-to-end.
First live run should use `AEO_CHATGPT_HEADLESS=0` and a `scorecard` tier to confirm
the selectors before spending a full run. Multi-geo is recorded but not steered (no
proxy egress). Frontend page not built.


## 2026-08-31 — Project switching: skeletons, no stale flash, competitors show

- **Cards no longer blank (or show stale data) when you switch project or add a
  new one.** New `CardSkeleton` (shimmer, `prefers-reduced-motion` aware) fills
  Analytics / Context / Agents / Flywheel while a project with no cached copy
  loads. Cards with a cached copy still paint it instantly, then refresh.
- **`GET /projects/:id` was silently dropping `competitors`** — `toDto()` never
  copied the field, so the Context card always read "none set" even when intake
  had found competitors. Added it to `ProjectDto` + `toDto()`; Rothenhall now
  shows Profound / Peec AI, day1tech shows DayOneX.
- **Stale-response guard** — `activeIdRef` means a slow `getProject` /
  `getSuggestions` that resolves after you've switched away no longer paints the
  wrong project's data. AnalyticsPane is also keyed on the project id so a
  switch remounts it clean instead of flashing the previous audit.
- **New project** seeds its cache + state on create, so the name / domain /
  category you just typed render immediately while stats and agents load in.
- Full smoke harness 8/8 · 204. Both builds green.

## 2026-08-31 — Live-fire pipeline check (day1tech.com) + intake / link-graph fixes

Ran the full pipeline against a real domain through the public API (intake →
audit → personas → journeys → link graph → authority → council → Flywheel →
agents/dashboard): **14/14 calls OK, 0 errors, 0 unexpected 503s.** Full smoke
harness still **8/8 · 204**. The run exposed three real defects, now fixed:

- **Intake stored `name = "null"`** — `String(org.fields['name'] || null)` produced
  the literal string `"null"`, which is truthy, so `name: company || domain`
  never fell through. Added a `clean()` guard (rejects `""`, `"null"`,
  `"undefined"`); brand now falls back og:site_name → shorter `<title>` segment →
  domain-derived.
- **Intake used the H1 hero headline as `category`** — day1tech's became
  *"Technology Execution Has Been Commoditized.Operating Accountability Has
  Not."*, which then poisoned authority-scan SERP queries. New `deriveCategory()`
  prefers a specific JSON-LD `@type`, then the non-brand `<title>` segment
  (→ *"technology operating partner"*), then the first meta-description clause —
  never a raw headline. No more `'General'` filler; category can be null.
- **Link-graph emitted 49 bogus "add link" recs** when a JS-rendered nav meant
  the crawl parsed 0 internal links across 50 pages (every page flagged an
  orphan, `overlap 1.00`, `priority 149`). Now: a crawl with `edges === 0 &&
  pages ≥ 3` is treated as *degraded* — orphan/under-linked analysis is skipped
  and the graph records the real cause ("navigation is JS-rendered; static
  crawlers and AI retrievers can't follow it"). The Flywheel turns that note
  into one honest `Content` boost instead of the noise.
- Also tightened intake competitor extraction: deny-list social / docs / booking
  hosts, drop CTA-phrase anchors ("Let's talk", "Careers"), skip the subject's
  own subdomains.

## 2026-08-31 — Personalised Flywheel + AEO/GEO boosts, all from real data

- **The wheel is now built entirely from the project's own data.**
  `journey.suggestions.ts` rewritten: `deriveSignals()` pulls the category,
  competitor names, and the dominant persona role / company stage; the query
  templates fill those slots, so a stage reads `rothenhall partners vs profound`,
  `is ai visibility gtm a real problem for a cmo`, `aeo vs seo for ai visibility
  gtm` — not `{cat}` placeholders. Folded in alongside: real persona
  **vocabulary**, **objections** (→ most-aware queries) and **buying triggers**,
  plus the queries real journeys already ran. Denser, too — up to 6 themes /
  stage, ~70 leaves (was ~30).
- **New second layer — `boosts`: concrete AEO/GEO actions for the site.** Each
  `{ id, lane, title, why, action, evidence, effort }` is derived from a real
  artefact: failed/warned **technical-audit findings** (Technical lane),
  top **internal-link recommendations** + **orphan pages** (Content),
  **authority-scan candidates** (Authority), unanswered **persona objections**
  (Content), and measurement gaps — no completed journey, missing AI-surface /
  SERP keys (Measurement / GEO). Two clearly-labelled `Best practice` baselines
  round it out. `error`-status audit findings are reframed as
  "audit incomplete — check didn't run", never as a site defect, and their raw
  error blobs are flattened to one readable line.
- `journey.service.suggestionWheel()` now also loads the latest audit findings,
  link-graph recommendations + orphans, and authority candidates, and passes
  three integration-connectivity flags (env-checked, no secret values).
- **Flywheel card** gained a `buyer queries · AEO / GEO boosts (N)` switch; the
  boosts view lists each with a lane chip, the why, a click-to-Chat action, and
  an `evidence · effort` footer.
- **Fixes:** wheel-scroll over any card now scrolls that card instead of zooming
  the canvas (`Canvas` mirrors the pan handler's `[data-card]` guard). The
  Analytics *Issues* list flattens raw error blobs and shows `error` findings as
  "check couldn't run / no result" (shared `lib/text.ts#cleanFindingText`).
- `journey.smoke.sh` +5 boost assertions (array shape, count, per-boost fields,
  deterministic ids, best-practice presence) → **43**. Full harness **8/8 · 204**.
- Verified in-browser: logout → login restores the session (token + refresh) and
  every card repaints from cache; the Flywheel shows the personalised sunburst
  and the 13 Rothenhall-specific boosts.

## 2026-08-31 — Dashboard data persistence + transparent token refresh

- **Cards no longer go blank on view / preset switches or reload.** Every fetched
  payload (`me`, `projects`, `integrations`, `project.<id>`, `agents.<id>`,
  `wheel.<id>`) is now mirrored to `localStorage['cailyx.cache.*']` on success and
  re-hydrated instantly on mount, so the UI paints last-known-good data first and
  swaps in the fresh copy when it arrives.
- **Flywheel disappearing bug fixed.** Its fetch effect depended on
  `layout.hidden`, so every preset/view change re-ran it and any transient error
  nulled the wheel (the "select a project" flash). Effect now keys on `activeId`
  only, seeds from cache, and `.catch` leaves the last wheel in place instead of
  clearing it. Empty-state copy is `building suggestions… / no suggestions loaded
  yet` (no more misleading "select a project").
- **Transparent refresh-token rotation.** `lib/api.ts` split into `raw` / `apiFetch`;
  a 401 on any non-`/auth/` call triggers one `POST /api/auth/refresh`
  (singleton in-flight guard) and a single retry, so a session survives well past
  the 15-min access-token TTL. New `setSession` / `getRefreshToken` helpers;
  login now stores the refresh token; `AuthResponse.refreshToken?` typed.
- Verified in-browser: Overview→Everything preset cycle keeps the Flywheel's
  layered sunburst populated; full page reload paints all cards (incl. Flywheel)
  from cache with no blank frame. `npm run build` green.

## 2026-08-31 — Layered Flywheel (pain point + suggestion per query)

- The Flywheel is now a **layered** sunburst: hub → awareness stage → **theme**
  → query, with outer tick marks showing query density per theme (coloured by
  source: library / persona / journey).
- **Every query carries the buyer PAIN POINT it maps to and the SUGGESTION
  Cailyx would make.** These render in full, unrotated, readable text in a
  detail panel below the wheel — click a stage or theme wedge to filter it,
  click a query row to send it to Chat.
- Backend `journey.suggestions.ts` rewritten around a `LIBRARY` of
  `{theme, query, painPoint, suggestion}` entries per stage (AI-visibility /
  GTM specific), folded together with persona vocabulary and real journey
  queries. Response shape: `{ hub, stages:[{ themes:[{ queries:[{ text,
  source, painPoint, suggestion }] }] }] }`. Still deterministic, no LLM.
- `journey.smoke.sh` suggestion assertions updated for the layered shape +
  pain/suggestion presence (**38**). Full harness **8/8 · 199**.

## 2026-08-31 — Light theme, layout presets, Flywheel

- **Light theme (correct brand use)** — swapped to the real Rothenhall light
  palette: warm-paper canvas (`#efe9dc`), paper cards (`#fbf9f3`) with a soft
  raised-paper shadow, ink text, **brass-deep** as the quiet default accent and
  **cognac** as the single warm spotlight. The Chat card is a dark "night" card
  (BRANDING's "dramatic dark band"). Modal scrims are warm ink, not black.
- **Layout presets** — the top-bar **view** menu now has one-click presets:
  *Overview* (analytics/context/agents/chat), *Research* (big Flywheel + agents +
  chat + context), *Diagnostics* (analytics/agents/gates), *Everything*. Each
  sets card positions + visibility, then frames them.
- **Flywheel card** (Agent-#2 adjacent) — an answerthepublic-style radial of
  buyer search queries for the project, grouped into four awareness-stage wedges
  (problem → solution → product → most aware) in a cream → brass → cognac ramp.
  Click a spoke to drop that query into the Chat card.
  - New backend: `GET /api/projects/:id/journeys/suggestions` — deterministic
    suggestion wheel built from the journey-planner templates + the project's
    personas + queries real journeys produced. No LLM, no spend.
    (`journey.suggestions.ts`; planner `FOLLOWUPS`/`OPENERS` now exported.)
- Verified in-browser: light theme on login + console, presets rearrange +
  frame, Flywheel renders and click-to-chat works. `tsc` + builds green.
  `journey.smoke.sh` +5 assertions (**37**), full harness **8/8 · 198**.

---

## 2026-08-31 — Infinite-canvas console + Gates card + de-browned palette

- **Infinite canvas** — the console is now a pannable / zoomable stage
  (`components/canvas/Canvas.tsx`, `CanvasCard.tsx`; no external library). Cards
  (Analytics · Context · Agents · Chat · Gates) drag by their header, resize
  from the SE corner, hide via ✕ or the top-bar **view** menu. Pan by dragging
  empty space; wheel to zoom toward the cursor; **fit** / **reset view** /
  zoom ± controls. Viewport + card boxes persist in `localStorage['cailyx.canvas']`.
  The old fixed row layout + `Pane.tsx` are gone.
- **Gates card** — a live view of `docs/PRODUCTION-READINESS.md`: "needs a key
  or credential" (from `GET /api/integrations`), "not wired — needs code"
  (GA/GSC OAuth, Redis-backed throttler, deployment artifacts), and "modes"
  (swarm-live, dev flags to disable). `chat` gains a `gates` command.
- **Palette de-browned** — the all-warm dark theme read as a flat brown wash.
  Kept the Rothenhall brass/cognac identity but deepened the stage to a near-black
  `#100e0b`, lifted cards to a warm charcoal `#1c1a15`, brightened text to
  `#f0ece0`, and spread status across brass → cognac → amber → red so states
  separate. The Chat card is a darker "night" variant for contrast.
- Verified in-browser: pan, zoom, fit, card move/resize/hide, all five cards
  render, Gates lists the 7 unconnected integrations. `tsc` + `next build` green.

---

## 2026-08-31 — Brand palette + production-readiness docs

- **`docs/PRODUCTION-READINESS.md`** — the go-live checklist: every secret / API
  key (Anthropic, DataForSEO, PSI, Perplexity, Google OAuth, Stripe, Plunk,
  `JWT_SECRET`), infra (SQLite→Postgres, managed Redis, Playwright browser),
  security hardening, build/deploy sketches, observability + cost control, the
  swarm boundary as policy, a full env-var reference (dev vs prod), and open
  decisions. Commit `10e5c6a`.
- **`CHANGELOG.md`** — this file. `AGENTS.md` + `MODULES-STATUS.md` now point at
  both and instruct keeping them current.
- **Frontend colour re-theme** (`39690f0`) — the console now uses the Rothenhall
  Partners palette (BRANDING.md): Night band backgrounds, brass-soft as the
  quiet default accent, cognac-soft as the warm spotlight, warm-gold caution,
  lifted cognac-deep for critical. Applied purely via `globals.css` CSS
  variables + the tailwind token map. **Fonts unchanged** (terminal monospace).
- `frontend/.env.example` corrected to the real dev API port (3002).

---

## 2026-08-30 — Swarm layer, dashboard aggregation, user management, Cailyx console

Commit `8e70574`. 101 files, +11,708 / −384.

### Backend — swarm layer (synthetic-buyer research agents)

Analysis + boundary: `docs/analysis/swarm-layer.md`. **No new npm dependencies.**
New external service: DataForSEO (SERP data — user-approved). Every live path
gated behind `SWARM_ALLOW_LIVE` + the relevant key, with an honest `503`
otherwise; deterministic + `fixture` adapters back the tests.

| Module | Agent | What it does |
|---|---|---|
| `persona` | #1 | Deterministic 10-role buyer-persona generator (seeded, reproducible) + optional LLM refinement. `PERSONA_MAX_PER_PROJECT` fan-out cap. draft→active→archived. |
| `journey` | #2 | Branching multi-step search-journey planner; executor over the `measurement` surface adapters. `JourneyCampaign` fan-out under one `budgetUsd`; per-journey `maxCostUsd` cap; `SWARM_ALLOW_LIVE` master switch. |
| `internal-link` | #8 | Crawls the client's own site (FetcherService + sitemap seed), builds the internal link graph, finds orphans / under-linked hubs, emits ranked "add link A→B" recommendations. |
| `council` | #10 | Six role-agents × rounds debate over existing artefacts (gap-analysis, link graph, journeys, measurement, audits) + a synthesizer that ranks interventions and records dissent. Proposes no new measurement. |
| `serp-intelligence` | #3 | DataForSEO `live/advanced` provider + offline fixture. Per-query subject rank, AI-Overview presence/mention, competitors, top domains, source spread. `SERP_MAX_COST_PER_CAPTURE` governor. |
| `authority` | #6 | Discovers legitimate mention targets (SERP listicles + AI-answer citations + optional LLM), excludes client/competitors/junk, promotes chosen ones into the `mention-tracking` ledger. No automated outreach. |

Shared infra: `common/utils/prng.ts` (deterministic PRNG),
`common/utils/subject-match.ts` (subject/competitor scoring, parity with the
`measurement` moat).

### Backend — dashboard aggregation + admin

| Module | Endpoint | Purpose |
|---|---|---|
| `integrations` | `GET /api/integrations` | Connection status for every external service (GA/GSC OAuth stubs, Anthropic, Perplexity, DataForSEO, PageSpeed, Redis live-ping, Database, Stripe, Plunk, swarm mode). Booleans + metadata only — **no secret values**. |
| `agents` | `GET /api/projects/:id/agents` | The Agents Feed — one card per capability with a live status/headline/activity derived from real artefacts. |
| `users` | `/api/users` CRUD | **Admin-only** operator administration (list / create with role / re-role / rename / reset-password / delete). Guard rails: last admin can't be demoted or deleted; can't delete your own account. Never returns hashes. |

### Backend — fixes

- `scheduling.service.ts` now implements `OnModuleDestroy` — closes the BullMQ
  worker + both ioredis connections it leaked on every `--watch` reload / test boot.

### Frontend — rebuilt as the Cailyx operator console

Replaced the light "operator dashboard shell" with a dark, terminal-styled console.

- **Movable / resizable / hideable panes** — Analytics · Context · Agents Feed ·
  Chat. Each pane header has reorder (◄ ►) and hide (✕); a drag handle resizes
  it; a "layout" menu toggles panes + resets. Layout persisted per browser
  (`localStorage['cailyx.layout']`).
- **Analytics pane** — SEO / Links / Technical / GEO tabs, Google Analytics +
  Search Console connector cards, signal table (meta title/desc/H1/checks),
  on-page issues list, "run audit".
- **Context pane** — editable name + description (PATCH `/projects`), the
  context-artefact list, competitors.
- **Agents Feed** — expandable cards showing what each agent is doing.
- **Chat pane** — deterministic terminal assistant over already-loaded data
  (`status`, `issues`, `visibility`, `attention`, `connections`, `context`,
  `help`); no LLM. Plus the "Hire your full-time CMO" banner.
- **Connections modal** — the full `GET /api/integrations` roster, grouped.
- **User Management modal** — admin-only; drives the `users` module.
- Login screen restyled; the legacy `/projects/:id` route redirects to the
  console with the project preselected.

### Verification

- `backend/smoke/` harness — **8 scripts, 193 assertions**, all deterministic /
  zero-key / zero-spend: `persona` 24, `journey` 32, `internal-link` 23,
  `council` 22, `serp-intelligence` 25, `authority` 22, `dashboard` 28, `users` 17.
- `tsc --noEmit` clean (backend + frontend). `nest build` + `next build` green.
- Browser-driven: login → console → agent expand → chat commands → connections
  modal → user-management modal → live technical audit (Analytics pane populated
  from `rothenhall.com`).
- Installed Playwright chromium so the audit's `js-render` check runs.

### Docs

`docs/MODULES-STATUS.md` §1.2e, `docs/API.md` (swarm + dashboard + users
sections), `docs/analysis/swarm-layer.md`, per-module READMEs.

### Left for later

- Google Analytics / Search Console **OAuth flow is not built** — the Connect
  buttons report `not-connected`; GSC data is CSV-imported via `sleeper-refresh`.
  See `docs/PRODUCTION-READINESS.md` §3.1.
- SQLite → PostgreSQL migration for prod.
- Deployment artifacts (Dockerfiles, CI) — none yet.
- Live-path verification for the keyed integrations (LLM refine/debate,
  DataForSEO real payload parsing, campaign budget-hit branch) — runs on first
  keyed use.

---

## 2026-08-30 — Cailyx foundation (Waves 0–5 + frontend shell)

Commit `8e72952`. The initial engine.

- **Wave 0** — `auth` (custom JWT + passport, roles), `projects`, `intake`,
  `config`, `database` (Prisma), `fetcher` (all outbound HTTP, rate-limited),
  `scheduling` (BullMQ), `health`.
- **Wave 1** — `query-set` (versioned buyer prompt sets), `measurement`
  (**the moat** — n≥5 per prompt per surface, Claude + Perplexity + mock
  adapters, mention/citation/SOV), `reporting` (branded report + PDF).
- **Wave 2** — `scoring` (versioned rubric, honest partials), `claims`
  (banned-phrase + single-run-rate gate, A/B/C grading), `findings`
  (two-register what/why/fix copy).
- **Wave 3** — `crawler-monitor` (AI-crawler log ingestion), `monitoring`
  (deltas + regression alerts), entity model-diff + judge.
- **Wave 4** — `page-analysis`, `mention-tracking`, `sleeper-refresh`,
  `data-asset`.
- **Wave 5** — `pipeline-math`, `scorecard` (Rung-0 free diagnostic), `delivery`
  (Plunk email, Lead CRM, Stripe Checkout links).
- **Frontend shell** — Next.js: nav, login, project list, project workspace with
  a working Rung-0 scorecard.

Everything e2e-verified where runnable; live LLM / schedule / GSC / payment /
email paths gated with honest `503`s or env flags. Backend `tsc` clean, build
green.
