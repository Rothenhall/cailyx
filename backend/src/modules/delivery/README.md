# Delivery (PRD §6.11 — FR-11.1 to FR-11.4)

Transactional email (Plunk, pre-approved), the Lead CRM with CTA logging, and
the Stripe Checkout upgrade ledger. DECISIONS from docs/analysis/wave-5.md §3:
email = Plunk (not re-opened), CRM = internal Lead table + CSV export (Attio /
HubSpot later), monetization = Stripe Checkout links (option A; full Billing
SDK = option B is the next iteration, no schema churn to get there).

## Files

```
delivery/
├── delivery.types.ts        # sources, statuses, CTA types, tiers, CHECKOUT_URL_ENV
├── delivery.service.ts      # sendReport, leads, logCta, exportLeadsCsv, upgrades
├── delivery.controller.ts   # 12 routes under /projects/:id/delivery
├── dto/delivery.dto.ts, dto/upgrade.dto.ts
├── delivery.module.ts
└── README.md
```

## Routes

| Route | Notes |
|---|---|
| `POST /send` | Plunk report-link email (`reportUrl` + booking CTA + optional testimonial ask); subject operator-editable (FR-11.1) |
| `POST` / `GET` / `PATCH` `/leads` | Capture / list (?status=) / pipeline status `new → reached → booked → won \| lost` (FR-11.2) |
| `GET /leads/:leadId` | One lead with its parsed CTA event log |
| `POST /leads/:leadId/cta` | Append a CTA event (`book-call \| review-ask \| upgrade-click`) — appended, never overwritten (FR-11.3) |
| `GET /leads/export` | CSV export for any external CRM |
| `POST /upgrades` | Checkout link from `STRIPE_CHECKOUT_URL_FULL` / `STRIPE_CHECKOUT_URL_MONITORING` (FR-11.4) |
| `GET /upgrades` / `POST /upgrades/:id/click` | Ledger + click log (flips the lead's event log too) |
| `@Public POST /upgrades/:id/complete` | Webhook **stand-in** until the real Stripe SDK (signature verification is left out, disclosed) |

## Honest guards

- Email without `PLUNK_API_KEY` → **503 `email-unconfigured`**, nothing sent.
- Plunk non-2xx or transport error → **503 `email-send-failed`** (never a
  silent loss).
- Upgrades without the tier's checkout URL env → **503
  `payment-unconfigured`**, nothing persisted (a funnel step that cannot
  proceed is not recorded).

## Env

| Var | Purpose |
|---|---|
| `PLUNK_API_KEY` | Enables the send path (https://api.useplunk.com/v1/send) |
| `PLUNK_SENDER_EMAIL` | Verified Plunk sender (claimed in the adapter docs) |
| `STRIPE_CHECKOUT_URL_FULL` / `STRIPE_CHECKOUT_URL_MONITORING` | Pricing-page Checkout links per tier |

## e2e evidence (2026-08-30, :3111)

1. `POST /send` without `PLUNK_API_KEY` → honest **503 `email-unconfigured`**.
2. Lead (source `scorecard`, `scorecardRunId` linked) → 201; `book-call` CTA appended; `type:"bogus"` → **400** (append-only log preserved); PATCH → `status:"booked"`.
3. `GET /leads/export` → CSV with header `email,name,source,status,ctaEvents,createdAt`.
4. `POST /upgrades {"tier":"full"}` without env → honest **503 `payment-unconfigured`**, nothing persisted; `tier:"nope"` → **400**.
5. With `STRIPE_CHECKOUT_URL_FULL` set → upgrade `created` with the env checkout URL; `/click` → `clicked` **and the lead's event log gained `upgrade-click`** (2 events total); `/complete` (unauthenticated webhook stand-in) → `completed` with `cs_test_abc123` session id; ledger shows `completed`.

Test rows wiped (verified `leads:0, upgrades:0`); server killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| FR-11.1 delivery email | Plunk adapter, templated + subject-editable, link-first (react-pdf PDF is frontend scope) |
| FR-11.2 lead capture + pipeline | `Lead` table + status lifecycle + CSV export |
| FR-11.3 CTA logging | append-only `ctaEvents` (book-call / review-ask / upgrade-click) |
| FR-11.4 upgrade path | Checkout ledger full + monitoring tiers, click + completion events |
| docs/MODELS.md #15 | same shape (`Lead`, `ctaEvents Json`) |