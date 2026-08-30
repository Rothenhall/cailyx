# Wave 5 — Scorecard, Delivery, Pipeline-Math (analysis + decisions)

Per `AGENTS.md` §2: options per tool before code. This documents the remaining
Wave-5 builds (PLAN Phase 4, PRD §6.11 + §13 + §17). As in Waves 2/4, choices
below are marked approved-by-default — **veto any of them and I build the
alternative instead.** Plunk for email is NOT re-opened (pre-approved earlier).

## 1. `pipeline-math` — GTM qualification arithmetic (standalone, P1)

The chain from `PLAN §5 Phase 4`: revenue target → ÷ ACV → ÷ win rate → ÷
meeting-to-SQL → ÷ lead-to-meeting → ÷ visitor-to-lead; compare the required
visitors against the addressable market; verdict `feasible | fiction`.
`docs/MODELS.md` #13 prescribes `PipelineMath(id, projectId @unique,
revenueTarget, acv, winRate, conversionRates Json, verdict)`.

| Option | Description | Verdict |
|---|---|---|
| **A — Stateless calculator** | Compute on every request, never persist. Simplest, but no history and no "compare this quarter to last" audit trail | ❌ |
| **B — Persisted per-project row (recommended)** | One `PipelineMath` row per project (unique), recomputed on `PUT`; store inputs + all intermediate stages + verdict with the threshold ratio; PATCH-recalculate; GET returns the model | ✅ **chosen** |
| **C — Frontend-only calculator** | No backend at all — contradicts the PRD module list and the API-first architecture | ❌ |

Arithmetic: `deals = revenueTarget / acv`; `sqls = deals / winRate`;
`meetings = sqls / meetingToSql`; `leads = meetings / leadToMeeting`;
`visitors = leads / visitorToLead`. If `marketSize` is given and `visitors >
marketSize × 1.5` → verdict `fiction` (documented threshold), else `feasible`.
Missing input > 0 validation on every field.

## 2. `scorecard` — Rung 0 free diagnostic (PRD §13 Free, PRD §17 open Q3)

PRD: automated probe checks + entity check + low-depth query-set runs + score +
3 named specific problems, the non-obvious guarantee, findings never gated
behind a call. `MODELS.md` #12: reuse `TechnicalAudit` + `EntityAudit` → `Gap`
+ `Score`, no new data model beyond a `ScorecardRun(id, projectId, score…)`.

**The §17 question this analysis resolves:** "Self-serve public free tier from
day one, or operator-only outbound first to protect quality and cost?" The PRD
cannot answer it on its own — §17 also flags the un-built abuse model and
per-cost ceilings. Decision: build the **engine + operator-invokable API now**;
the public form becomes a flag, not a rebuild.

| Option | Description | Verdict |
|---|---|---|
| **A — Fully public self-serve day one** | Public unauthenticated form → full free diagnostic per submission. Highest funnel value but exposes unbounded model/probe cost and needs an abuse model §17 explicitly lists as an open question | ❌ for this wave |
| **B — Engine now, public via flag (recommended)** | `scorecard` runs the real low-depth pipeline (technical-audit access probe + entity check + representative mock/query-set measurement + scoring rubric v1) and persists a `ScorecardRun` (score + band + top-3 findings + `nonObvious` flag). Endpoints are role-guarded like every other module; a thin `POST /scorecard/public` (rate-limited ×N/IP, cost-capped, env-gated `SCORECARD_PUBLIC=1`) reuses the same service so the public launch is configuration, not code | ✅ **chosen** |
| **C — Operator-only forever** | Protects cost, but the PRD names the free tier "the trigger generator" — a funnel that requires a human operator per lead contradicts §13 and FR-11.4 | ❌ |

Depth controls (all env-overridable): free tier uses n≥3 runs (PRD: "low run
count") on a representative prompt subset (first 5 of the set), surfaces =
`mock`/`claude` depending on keys, cost governed by the existing
`MEASUREMENT_MAX_COST_PER_RUN`. Output contract: `score`, `band`,
exactly **3** named findings ranked most-specific-first, `nonObvious` boolean
(the SOP guarantee), and a stable `publicToken` so the branded report can be
shared without auth (FR-10 visibility `public`, opt-in `noindex`).

## 3. `delivery` — Email + Lead CRM + CTA logging + Stripe upgrades (FR-11.1–11.4)

### 3.1 Transactional email (FR-11.1) — Plunk

Pre-approved earlier (wave-0). **Not re-opened.** Adapter posture same as the
measurement surfaces: `PlunkEmailAdapter` behind an interface, env
`PLUNK_API_KEY` + `PLUNK_SENDER_EMAIL` + sender name; without the key the
send endpoint returns an honest **503 `email-unconfigured`** and persists
nothing half-way (consistent with findings/page-analysis guards). Report link +
PDF attachment path: link-first (react-pdf PDF is task #12 frontend scope;
the adapter accepts a URL) — disclosed in the module README.

### 3.2 Lead/pipeline capture + CTA logging (FR-11.2, 11.3)

| Option | Description | Verdict |
|---|---|---|
| **A — Internal `Lead` table (recommended)** | `MODELS.md` #15 shape: `Lead(id, projectId FK, email, source bulk|api|form|scorecard, status new|reached|booked|won|lost, ctaEvents Json[])` + booking-CTA click endpoint appending typed events. CSV export for whatever CRM the operator actually uses | ✅ **chosen** |
| **B — Attio direct** | Premium CRM, pushes happen automatically — but external OAuth + record-schema lock-in before the funnel even exists | ⏸ later (now = plain webhook-style export) |
| **C — HubSpot OAuth** | Free tier exists, but this deployment has one operator; adds no value yet and drags in OAuth scopes | ❌ |

### 3.3 Monetization / Stripe (FR-11.4)

| Option | Description | Verdict |
|---|---|---|
| **A — Stripe Checkout link + ledger table (recommended)** | `Upgrade(id, projectId? , tier full|monitoring, status created|clicked|completed, stripeSessionUrl?, stripeSessionId?)` — the operator/generator issues a Checkout link with a price/URL from env vars (`STRIPE_CHECKOUT_URL_FULL`, `STRIPE_CHECKOUT_URL_MONITORING`); clicks log against the Lead; a webhook route flips `completed`.AccountId can come later without changing the table | ✅ **chosen** |
| **B — Full Stripe Billing SDK integration** | Products/Prices API + subscriptions + customer portal. Correct for the monitoring retainer eventually, but premature before the first paying customer; B's Checkout links convert to B without schema churn | ⏸ next iteration |
| **C — "Contact sales" only** | No self-serve upgrade at all — contradicts FR-11.4 | ❌ |

In the e2e environment (no Stripe account) the upgrade link is returned from
env config and `clicked`/`webhook-completed` flows are driven by the test
callers with an honest `payment-simulator` note in the README, the same way
mock/honest-503 guards were used in Waves 1–4.

## 4. New deps

| Dep | Where | Note |
|---|---|---|
| none required | pipeline-math, scorecard, delivery (except Plunk) | scorecard orchestrates **existing** modules; delivery uses raw fetch against the Plunk HTTP API (adapter pattern, no SDK needed); Stripe option A needs no SDK from our side |

## 5. Build order

1. **`pipeline-math`** — zero dependencies, unblocks nothing but is quick.
2. **`scorecard`** — the §17-decision module; depends on existing waves only.
3. **`delivery`** — Lead + CTA + email + upgrades, can link scorecard runs as lead source.
4. Frontend shell remains task #12 (after Wave 5).