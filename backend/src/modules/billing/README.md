# Billing module (G16 — public intake, sales handoff, verified billing)

Purpose: make "this client paid for it" a fact the server established, not
something a browser asserted. One path creates an entitlement — a
signature-verified provider webhook — and nothing else in the system can, which
is what design_plan §11.2 case 16 asks for:

> Checkout-return visit or replayed unsigned event cannot grant an entitlement.

The module also carries G16's public half: an abuse-protected diagnostic request
(PB03) with consent and a background receipt, and a token-scoped scorecard CTA
capture (PB02) that works without an operator session.

## File tree

```
billing/
  billing.controller.ts          operator surface — offers, entitlements, subscriptions, ledger, capability
  billing-webhooks.controller.ts POST /api/billing/webhooks/stripe (public, raw body, no DTO)
  billing-public.controller.ts   public — checkout status, diagnostic challenge/request, scorecard CTA
  billing-portal.controller.ts   @ClientPortal() reads — subscriptions, entitlements, invoices, portal state
  billing.service.ts             the ledger: offers, grants, revocations, subscriptions, checkout status, capability
  stripe-webhook.service.ts      signature verification, replay guard, event dispatch
  payment-failure-sweep.service.ts  C5 — hourly grace-period sweep, auto-suspend via ClientsService
  diagnostic-intake.service.ts   public intake: challenge, consent, receipt, scorecard CTA
  billing.types.ts               status vocabularies + view shapes
  lib/stripe-signature.util.ts   HMAC-SHA256 + timingSafeEqual + timestamp tolerance (pure)
  lib/provider-event.util.ts     defensive reads of a payload (pure)
  lib/challenge.util.ts          signed single-use challenge + SHA-256 proof of work (pure)
  lib/domain.util.ts             domain normalization + admission (pure)
  dto/billing.dto.ts             request DTOs
```

## Endpoints

### Operator (`@ApiBearerAuth`, JWT)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/api/billing/capability` | any operator | configured/unconfigured state for the webhook, checkout, raw-body capture and the intake, each with the env var **name** that is missing |
| GET | `/api/billing/offers` | any operator | `?active=true\|false&code=` |
| GET | `/api/billing/offers/:code` | any operator | one price mapping |
| POST | `/api/billing/offers` | admin | create the price mapping (amount, currency, provider price id, entitlement keys) |
| PATCH | `/api/billing/offers/:id` | admin | edit; `active: false` is the supported removal |
| GET | `/api/billing/entitlements` | admin, delivery-lead | `?clientId=&key=&status=`; each row names its authorizing event |
| POST | `/api/billing/entitlements/:id/revoke` | admin | the operator action for a refund/contract decision |
| GET | `/api/billing/subscriptions` | admin, delivery-lead | `?clientId=&status=` |
| GET | `/api/billing/subscriptions/:id` | admin, delivery-lead | one row |
| GET | `/api/billing/events` | admin | the ledger, `?status=&clientId=&providerEventId=&limit=`. **No raw payload** — `payloadKeys` summarises its shape |
| GET | `/api/billing/events/:id` | admin | the payload verbatim (customer name/email/address live in it) |
| GET | `/api/billing/invoices` | admin, delivery-lead | ledger-derived lines + `providerInvoices.configured: false` and why |

### Public (no session)

| Method | Path | Limit | Notes |
|---|---|---|---|
| POST | `/api/billing/webhooks/stripe` | 600/min | signed delivery; 200 handled/duplicate, 400 rejected, 500 retry me, 503 unconfigured |
| GET | `/api/public/checkout/status` | 15/min | `?sessionId=`; grants nothing, ever |
| GET | `/api/public/diagnostic-challenge` | 30/min | issues the signed challenge + proof-of-work difficulty |
| POST | `/api/public/diagnostic-request` | 5/min | requires a solved challenge and `consent: true` |
| POST | `/api/public/scorecard/:publicToken/cta` | 30/min | token-scoped CTA capture; gated by `SCORECARD_PUBLIC` |

### Client portal (`@ClientPortal()` — operators are refused)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/portal/billing/subscriptions` | this client's subscriptions |
| GET | `/api/portal/billing/entitlements` | what this client may use |
| GET | `/api/portal/billing/invoices` | same ledger + disclosure as the operator route |
| GET | `/api/portal/billing/customer-portal` | `{available: false, reason}` rather than a URL that does not work |

**Endpoint count: 21** (12 operator, 5 public, 4 client-portal).

## The webhook, step by step

```
1. signing secret set?          no  -> 503, nothing stored, nothing trusted
2. verify HMAC + tolerance      bad -> store {signatureValid:false, status:"rejected"}, 400, never acted on
3. providerEventId seen before?      -> 200 {duplicate:true}, no re-grant
4. act                           -> status "processed" | "ignored"
```

- **Verification** is plain `crypto`: `HMAC-SHA256(secret, "<t>.<raw body>")`
  compared with `timingSafeEqual`, every `v1` candidate compared (no early
  return), timestamp tolerance 300 s (`STRIPE_WEBHOOK_TOLERANCE_SECONDS`).
  `v0` (deprecated Connect scheme) is never accepted. No Stripe SDK.
- **Stale** means outside the tolerance window. A captured, correctly-signed
  event cannot be replayed later.
- **Replay** is answered by `PaymentEvent.providerEventId` being `@unique`.
- **A forged event cannot poison the replay guard.** A rejected delivery is
  stored (the ledger should show the attempt), so an attacker who guessed a
  *real* event id could otherwise occupy the unique key and block the genuine
  delivery forever. A later delivery with a valid signature **supersedes** a
  rejected row with the same id — only rows that were actually processed count
  as duplicates. (Verified: see "Verified" below.)
- **`rejected` vs `ignored`.** `rejected` = we could not trust it. `ignored` =
  we trusted it and deliberately did not act (no offer matched, the amount
  exceeded the offer, `payment_status` was not paid, no client resolved, an
  unhandled event type). The distinction is visible in the ledger and in the
  checkout-status read.
- **Raw body.** The HMAC must cover the exact bytes. The app does not currently
  enable `rawBody` (a one-line `main.ts` change: `NestFactory.create(AppModule,
  { rawBody: true })`), so the handler uses `req.rawBody` when present and
  otherwise verifies over a canonical re-serialization of the parsed body. That
  still cannot be forged without the secret; the failure mode is a *rejection*
  of a payload the re-serialization altered, never an acceptance. The response
  reports `bodyIntegrity: "raw" | "reserialized"` per delivery, and
  `/api/billing/capability` reports the mode last observed.

## Where the money is decided

- `Offer` is the only price authority: `amountCents`, `currency`, `interval`
  and the `entitlements` keys. A payload may name an offer (`metadata.offerCode`)
  or a provider price id (`Offer.providerPriceId`) — nothing else identifies a
  purchase, and the amount is never used to guess one.
- `evaluateAmount` accepts a payment **below** list price (coupons and discounts
  are legitimate), refuses one **above** it (the offer authorizes a price, not a
  range), and refuses a currency mismatch outright — this module has no FX
  rates and will not invent one.
- `BillingService.grantEntitlements` throws if `event.signatureValid` is false.
  That is the last line of defence behind the webhook's own check: reaching the
  table by another route still cannot grant.
- Cancellation rules: a subscription that reaches `canceled` (or
  `incomplete_expired`) revokes its entitlements; `cancel_at_period_end` does
  **not** (the period was paid for). A failed payment marks `past-due` and cuts
  nothing — the grace policy is an operator decision. A refund is recorded and
  does **not** auto-revoke, because a partial refund is not a cancellation; the
  admin revoke route is that decision.

## The public intake

- **Challenge**: `GET /api/public/diagnostic-challenge` mints a random nonce and
  returns it signed with HMAC-SHA256 plus an expiry (900 s) and a difficulty.
  The submitter must find an `answer` whose `SHA-256(token + ":" + answer)` has
  at least `PUBLIC_INTAKE_CHALLENGE_BITS` leading zero bits (default 16, clamped
  to 8–24). No third-party CAPTCHA: a field nothing verifies would be theatre,
  and no verification dependency is approved for this build. Proof of work is
  one of three gates, not a substitute for the other two.
- **Single use**: the challenge nonce is the job run's idempotency key, so
  redeeming a token twice returns the first receipt instead of recording the
  person twice.
- **Rate limits**: `@Throttle` per IP *and* a per-domain cap (3 per 24 h) in the
  service, because an IP limit alone is defeated by a botnet while the domain is
  what an abuser actually wants. The counter is the project's own intake leads —
  the canonical domain is the project (`Project.domain` is unique) — because a
  repeat request for a domain whose run is still queued takes the run-lock path
  and creates no new run, so counting runs would let that path bypass the cap.
  (It did, in the first acceptance run; that is why the counter moved.)
- **Consent**: `consent` must be exactly `true`; the recorded statement is
  `CONSENT_STATEMENT`, stored verbatim on the run so the agreement is
  reconstructable.
- **What an accepted request does**: normalizes and admits the domain (IP
  literals, `localhost`, single-label and internal suffixes are refused), creates
  an **unenriched** project stub, writes a `Lead` with the contact, and queues a
  `diagnostic-request` `JobRun` — the background receipt. Operators see the run
  and the lead.
- **What it deliberately does not do**: run the expensive intake.
  `POST /api/intake/subject` (site fetch, schema extraction, competitor seeding)
  stays behind the operator JWT. The run reports
  `"no queue entry point — the run was reset in the ledger and will not start
  itself"`, which is true: no worker handler exists for this task kind, and
  pretending otherwise would be a lie.

## Dependencies

- `PrismaService` — global (`DatabaseModule`).
- `JobsService` (`JobsModule`) — the durable receipt run.
- `ActivityService` (`ActivityModule`) — grants, revocations, rejected
  deliveries (G15 names all three).
- No FetcherModule import: this module makes no outbound request.

## Env vars

| Name | Required | Purpose |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | **yes** for the webhook | HMAC signing secret. Unset ⇒ every delivery is refused with 503, nothing is read or stored |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | no (300) | how far the `t=` timestamp may drift |
| `PUBLIC_INTAKE_CHALLENGE_SECRET` | **yes** for the public intake | signs the challenge token. Unset ⇒ the intake is closed with 503 and says so |
| `PUBLIC_INTAKE_CHALLENGE_BITS` | no (16) | proof-of-work difficulty, clamped to 8–24 |
| `SCORECARD_PUBLIC` | read | the scorecard funnel flag; `1` enables the public scorecard CTA capture |

**`.env.example` needs updating** (it currently contains none of these):
`STRIPE_WEBHOOK_SECRET`, `PUBLIC_INTAKE_CHALLENGE_SECRET`,
`PUBLIC_INTAKE_CHALLENGE_BITS`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS`, and
`SCORECARD_PUBLIC` — which the scorecard module already reads and which is
therefore undocumented for its own users too. The publishing module adds
`PUBLISHING_SCHEDULER_ENABLED` and the `PUBLISH_CREDENTIAL_<REF>` convention.
Names only — no credential is invented or committed here.

## PRD alignment (design_plan.md Appendix A, G16)

| Requirement | Status |
|---|---|
| Abuse-protected public diagnostic request with contact consent, challenge/rate limits and background receipt/job ID | ✅ challenge (signed + proof of work) + 5/min + per-domain cap + `Lead` + `JobRun` receipt |
| Keep the expensive operator intake protected | ✅ untouched; `POST /api/intake/subject` is still 401 without a token (verified) |
| Signed `POST /api/billing/webhooks/stripe` | ✅ real HMAC-SHA256, `timingSafeEqual`, timestamp tolerance, no SDK |
| Verified checkout-status read | ✅ answered from the signature-verified ledger; a return-page visit writes and grants nothing (verified) |
| Subscription / entitlement / invoice / customer-portal reads | ✅ operator + client-portal routes; invoices are explicitly ledger-derived with `configured: false` for provider invoices |
| Do not accept user-supplied paid status or amount as authority | ✅ no such field exists on any public DTO; the offer and the amount come from `Offer` |
| Persist offer/price mapping, payment event ledger, idempotency, entitlements | ✅ `Offer` / `PaymentEvent` (unique `providerEventId`) / `Entitlement.grantedByEventId` |
| Disable/replace the unsigned upgrade completion stand-in | ❌ **not in this module's file set** — see the report; it lives in `delivery` |
| Public scorecard CTA capture via a token-scoped endpoint | ✅ `POST /api/public/scorecard/:publicToken/cta`, gated by `SCORECARD_PUBLIC` |
| Lifecycle-aware handoff to G04 | ❌ not implemented — G04 owns `OnboardingRequest`; see the report |
| Offer/entitlement admin reads | ✅ plus admin writes for offers and entitlement revoke |
| Cancellation/refund rules | ✅ defined and documented above (auto-revoke on subscription end; refund recorded, revocation is an operator action) |
| Webhook delay shown pending | ✅ `status: "pending"`, `purchaseVerified: false`, `onRecord: false`, and a `nextAction` that says the provider may still be delivering |

## Reported upstream (not editable from this package)

- **The unsigned upgrade-completion stand-in is still live.**
  `backend/src/modules/delivery/delivery.controller.ts:94-102` exposes
  `@Public() POST /api/projects/:projectId/delivery/upgrades/:upgradeId/complete`
  ("Webhook stand-in: mark an upgrade completed"), served by
  `backend/src/modules/delivery/delivery.service.ts:226` (`markCompleted`). It
  marks an `Upgrade` row completed with no signature, no idempotency key and no
  entitlement. G16 requires it be disabled or replaced for production commerce;
  the endpoint and the row are in the `delivery` module's lane, so this pass
  reports it rather than editing it. Note that it never granted an entitlement —
  G16's `Entitlement` table is new — so the exposure is a falsified upgrade
  ledger entry, not access.
- **`main.ts` does not set `rawBody: true`** (`NestFactory.create(AppModule)`),
  so webhook signatures are verified over a canonical re-serialization when raw
  bytes are unavailable. Fail-closed, but the exact-byte path is the correct
  configuration and is a one-line change.
- **`TASK_KINDS` (`jobs/jobs.types.ts:37`) has no `diagnostic-request` entry**,
  so `GET /projects/:id/jobs?taskKind=diagnostic-request` is rejected by that
  route's DTO validation even though the run appears in an unfiltered list.
- **`.env.example` is missing this module's names** (and `SCORECARD_PUBLIC`,
  which the scorecard module already reads): see the table above.
- **G04's lifecycle handoff is not implemented.** An accepted public request
  creates a project stub, a lead and a queued run; the G04 handoff
  (`OnboardingRequest`, the checklist and the client-facing onboarding view) is
  in the `business-profile`/`client-access` lane.

## What is deliberately not built

- **No provider API client.** No Stripe SDK, no direct API reads. "Verified"
  means signature-verified against the webhook ledger; a live API confirmation
  would need a provider client and that is a decision, not a default.
- **No entitlement expiry sweep.** A subscription-backed entitlement carries
  `expiresAt: null` and lives until the subscription ends (which revokes it).
  Period-end expiry and a grace policy are unbuilt; the subscription row carries
  the dates.
- **No self-service purchase.** Checkout links are issued operator-side by the
  `delivery` module from env-configured URLs; `/api/billing/capability` reports
  that as `checkout.configured: false` with the reason.
- **No client-portal mutations.** A client cannot buy, cancel or revoke here.

## Verified (2026-09-16, live on :3097, private build, operator token)

Four runs against a real server process with the dev database, a throwaway
operator login and no mocks: **`45/45`** in the billing run, **`25/25`** in the
intake run, **`5/5`** against a second instance started *without*
`STRIPE_WEBHOOK_SECRET` and `PUBLIC_INTAKE_CHALLENGE_SECRET`, and a focused
four-request run for the per-domain cap. The scripts are throwaway files under
`/tmp`, not part of the repo, and all fixtures were deleted afterwards. What was
exercised:

- **Signature paths**: unsigned → 400 `missing-header`; wrong secret → 400
  `no-matching-signature`; a correctly-signed but two-hour-old delivery → 400
  `timestamp-out-of-tolerance`; all three stored as
  `{status:"rejected", signatureValid:false}` with no entitlement granted.
- **Supersede**: after the three forgeries, the genuine delivery with the same
  `providerEventId` processed (`duplicate: false`) and granted exactly one
  entitlement.
- **Case 16**: the checkout-status read before the webhook returned
  `status:"pending"`, `purchaseVerified:false`; entitlement count unchanged
  across repeated visits; after the signed event the same read returned
  `verified` with the offer from the `Offer` table and the granted key.
- **Replay**: the same event delivered twice → `200 {duplicate:true}`, one
  entitlement row, same `grantedByEventId`.
- **Authority**: `amount_total` above the offer → `ignored`
  ("exceeds the offer's price"); `payment_status: "unpaid"` → `ignored`; no
  resolvable client → `ignored`; no offer named → `ignored`; a price-id match
  with a *discounted* amount → processed.
- **Lifecycle**: subscription `canceled` → entitlement `revoked`, subscription
  row `canceled`.
- **Ledger**: list omits the raw payload and returns `payloadKeys`; the
  single-event route returns it; invoices disclose
  `providerInvoices.configured: false`.
- **Intake**: challenge issued and solvable; `consent:false` refused; an
  unsolved answer refused; a self-minted token refused (`bad-signature`); an
  IP-literal domain refused; an accepted request produced a receipt with
  project/lead/job-run ids and the exact consent statement in the run's input;
  a replay returned the original receipt and created no second lead; the
  per-domain cap returned 429; the operator intake is still 401.
- **The cap bug the run found.** The first version counted `JobRun` rows per
  domain, and the acceptance run showed a repeat request sailing past it: a
  request whose run is still queued takes the run-lock path and creates no run,
  so the counter never moved. The cap now counts the project's intake leads, and
  a focused four-request run confirms 3 accepted / 4th `429
  domain-cap-reached`.
- **Portal**: operator token on a `@ClientPortal()` route → 403.
- **Unconfigured** (a second instance with no secrets): the webhook returned
  `503 webhook-unconfigured`, named `STRIPE_WEBHOOK_SECRET`, said nothing was
  stored, and never read the payload's claimed event id; the challenge route and
  the intake both returned `503 intake-challenge-unconfigured` rather than
  accepting an unverifiable submission.

Not verified here: anything requiring a real Stripe account (a genuine provider
payload's byte-exact raw body, live API reads) and any check on a client-type
JWT — the dev database still has no `type: "client"` user.

## C5 addendum (2026-09-21) — payment-failure grace period → auto-suspend

`docs/analysis/client-portal.md` §30. Extends `stripe-webhook.service.ts` and adds one new file;
does not touch signature verification or the replay guard (both untouched, per the task scope).

- **`StripeWebhookService.onInvoiceFailed`** (already existed, handling `invoice.payment_failed`)
  now also stamps `Subscription.pastDueSince` — **once**, on the transition into past-due, never
  bumped by a later retry of the same still-unresolved failure (Stripe's Smart Retries can fire
  several `invoice.payment_failed` events for one grace window). `onSubscriptionUpserted` (already
  handling `customer.subscription.created`/`updated`) now does the same when a status transition
  lands on `past-due`, and additionally accepts the literal event type
  `customer.subscription.past_due` — not an event Stripe actually sends (the real delivery is
  `customer.subscription.updated` with `status: "past_due"`, already covered), but the task named
  it explicitly, so it is routed through the identical path rather than left unhandled.
  `onInvoicePaid`/a subscription seen `active`/`trialing` clears `pastDueSince` back to `null`.
  `BillingService.upsertSubscriptionFromProvider` gained an optional `pastDueSince` parameter
  (`undefined` = leave untouched, `null` = clear, a `Date` = set) — the caller decides, this method
  never infers it from `status` on its own.
- **New: `payment-failure-sweep.service.ts` (`PaymentFailureSweepService`)** — an in-process
  `@Cron(CronExpression.EVERY_HOUR)` job, the same pattern `PublicationSchedulerService`
  (`publishing`) and `SeoAuditSchedulerService` (`seo-audit`) already use (no Redis/BullMQ needed;
  the schedule lives in the database via `pastDueSince`, so it survives a restart). Each tick reads
  `BillingService.listPastDueBeyondGracePeriod(graceDays)` (new read method: `status: "past-due"`
  AND `pastDueSince <= now - graceDays`) and suspends each subscription's `Client` via
  `ClientsService.suspendClient(clientId, {type: 'scheduler', label: 'billing-grace-period-sweep'},
  reason)` — the identical path an admin's manual `POST /clients/:clientId/suspend` uses, so
  Google-token revocation (§23) and the audit trail (§33) both happen exactly the same way either
  time. Already-suspended clients are skipped (idempotent). `runOnce()` is exposed separately from
  the `@Cron` `tick()` so a script can trigger exactly one sweep pass on demand (used for
  verification — see `clients/README.md`'s C5 testing notes for the full live run).
- **New env vars**: `BILLING_GRACE_PERIOD_DAYS` (default 21 — Stripe's own Smart Retries window,
  per §30, not a bespoke schedule) and `BILLING_GRACE_PERIOD_SWEEP_ENABLED` (default true, stands
  the cron down for a second instance). Both added to `.env.example`.
- **`BillingModule` now imports `ClientsModule`** for `ClientsService`. No circular dependency:
  `ClientsModule` (and everything it in turn imports — `JobsModule`, `ActivityModule`,
  `ClientAccessModule`, etc.) does not import `BillingModule`.
- **`SubscriptionView`/`SubscriptionRow` gained `pastDueSince: string | null` / `Date | null`** —
  now returned by every existing subscription read (`GET /api/billing/subscriptions`,
  `GET /api/portal/billing/subscriptions`, etc.), no new endpoint needed for visibility.

Verified live against a real signed webhook sequence (HMAC-SHA256, Stripe's documented header
scheme, no SDK) — see `clients/README.md`'s C5 testing notes for the full run
(checkout → payment-failed → grace-period sweep → auto-suspend → audit event with
`actorType: "scheduler"`; a second retry confirmed `pastDueSince` does not get bumped; a recovered
subscription confirmed `pastDueSince` clears on `invoice.paid`).
