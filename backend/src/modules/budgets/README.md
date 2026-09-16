# Budgets — G12 (budget policies, spend reservations, cost audit)

Ceilings at client/project/operation level, money set aside **before** a paid
run starts, and a ledger that separates what was predicted from what was
actually charged.

Contract: `design_plan.md` Appendix A, G12 (line 1665). Screens OP18 / AE02 /
CT03 / PJ11.

## Purpose

Four problems, one module:

1. **Nobody overspends a ceiling, not even under concurrency.** Read-then-write
   cap checks let two simultaneous requests both pass. `ReservationsService`
   makes the check and the hold commit together.
2. **Estimates are not actuals, and both carry units.** `SpendEvent.unit` is
   `usd` or `credits`. Nothing here sums them, and nothing converts between
   them implicitly.
3. **An unknown provider balance is unknown.** Never "fits".
4. **Retries do not double-charge.** Settling is compare-and-swap; a second
   settle is a 409, not a second charge.

### Context you must not lose

The pre-existing AEO estimate (`AeoAuditService.estimateBudget`) is a **Cloro
credit estimate** for one audit's answer-engine sampling. It is *not*
all-provider USD spend and *not* a team budget ledger. This module reports it
with `unit: 'credits'` and `basis: 'cloro-credit-tariff'`; any dollar figure is
a separate, labelled `conversion` at `CLORO_CREDIT_USD` that is never merged
into the credit number.

## File tree

```
budgets/
├── budgets.module.ts         imports MeasurementModule (for CloroClient)
├── budgets.controller.ts     4 controller classes, 10 endpoints
├── budgets.service.ts        policies, evaluation, estimates, ledger
├── reservations.service.ts   reserve / approve / release / settle — the atomic core
├── budgets.types.ts          vocabularies + UnitTotal / UnknownValue / Affordability
├── lib/period.util.ts        timezone-correct period windows (Intl only)
├── dto/budget.dto.ts         policy + estimate DTOs
├── dto/spend.dto.ts          reservation + spend-event DTOs
└── README.md
```

## Endpoints

| # | Method | Path | Roles | What it does |
|---|---|---|---|---|
| 1 | GET | `/api/projects/:projectId/budget` | any operator | Every applicable ceiling, evaluated, with its window and per-unit totals |
| 2 | PUT | `/api/projects/:projectId/budget` | admin, delivery-lead | Create/replace the project-wide or (with `taskKind`) operation ceiling |
| 3 | POST | `/api/projects/:projectId/cost-estimates` | any operator | Pre-flight estimate, per unit, with a disclosed credits→USD conversion |
| 4 | GET | `/api/projects/:projectId/spend` | any operator | The cost-audit ledger: actuals, holds, per-provider breakdown, variance |
| 5 | POST | `/api/projects/:projectId/spend` | any operator | Record an actual that was never reserved (de-duplicated) |
| 6 | GET | `/api/projects/:projectId/budget/reservations` | any operator | Reservations; `?awaitingApprovalOnly=true` is the approval queue |
| 7 | POST | `/api/projects/:projectId/budget/reservations` | any operator | **Reserve before you spend (atomic)** |
| 8 | POST | `/api/projects/:projectId/budget/reservations/:id/approve` | admin, delivery-lead | Approve a soft-ceiling overage |
| 9 | POST | `/api/projects/:projectId/budget/reservations/:id/release` | any operator | Give a hold back without charging |
| 10 | POST | `/api/projects/:projectId/budget/reservations/:id/settle` | any operator | Record the actual charge (exactly once) |

Every handler runs `ScopeValidationService.assertProjectAccess` for the URL's
`:projectId` first, and every reservation id is resolved *within* that project.

## The concurrency guarantee

`ReservationsService.reserve` does the cap check and the insert in **one
`$transaction`**, with three mechanisms layered:

1. **A write lock taken before the first read.** `lockProject` runs
   `UPDATE "Project" SET "updatedAt" = "updatedAt" WHERE "id" = ?` — a no-op
   assignment whose only purpose is the lock it takes. Reading first and
   locking later would leave exactly the window this closes.
2. **An in-process FIFO queue per project** (`withProjectLock`). Without it,
   twenty simultaneous requests inside one Node process open twenty competing
   transactions and time each other out (`P1008`), turning a truthful 409 into
   an opaque 500. The queue is a *throughput* guard — the transaction is still
   the *correctness* guard.
3. **Retry on write conflict** (`withWriteRetry`), on `P2034` and `P1008`. A
   retry re-reads committed state, so it can only make the check stricter,
   never looser.

**Verified:** 20 concurrent `$1` reservations against a `$10` ceiling produced
exactly 10 holds totalling exactly `$10`; the other 10 came back as 409s. No
run has ever observed a total above the ceiling.

## Ceiling semantics

- **All applicable ceilings bind.** A client ceiling, a project ceiling and an
  operation ceiling are all checked — each is a commitment somebody made. The
  tightest is named in `bindingCeilings` but does not switch the others off.
- **Holds vs actuals.** `SpendReservation` (status `held`, not expired)
  contributes `reservedHeld`; `SpendEvent` contributes `settled`. A *settled*
  reservation is **not** also summed from its `settledUsd` — settling writes
  the event that carries it, so adding both would double-count. `released` and
  `expired` contribute nothing.
- **Hard vs soft.** `hard` refuses the reservation outright and is never
  approvable. `soft` creates the hold **unapproved** (`approvedBy: null`): it
  still counts against the ceiling, and `settle` refuses it until an approving
  role calls approve. That is what makes `approve` load-bearing rather than
  decorative, and it is the approval queue OP18 asks for.
- **Per-run cap** is checked against the high estimate, regardless of
  enforcement, and is never approvable.
- **Windows resolve in the project's timezone** (`Project.timezone`), via
  `lib/period.util.ts` using only `Intl`. A `cycle`-period policy with no live
  G06 cycle reports `resolved: 'unresolved'` and a reservation against it
  **fails closed** rather than charging against a guessed window.
- **Unbounded is reported as unbounded.** A unit no policy caps appears in
  `unboundedUnits`, with a note. It is never presented as "within budget".

## Units

| Unit | Means | Never |
|---|---|---|
| `usd` | Dollars | Summed with credits |
| `credits` | Provider credits (Cloro today) | Converted into a `usd` ceiling implicitly |

`UnitTotal` always carries its own `unit`. The ledger's `totals` array has one
entry per unit and there is no blended total field. Credits→dollars appears
only as `CostEstimate.conversion`, with `rateEnvVar` and a caveat naming that
on a free tier the cash spend is `$0` — a valuation, not a charge.

## Unknown balances

`ProviderBalance` is `{ state: 'known', unit, value, source, readAt }` or
`{ state: 'unknown', reason }`. There is no boolean `fits`, because a boolean
cannot distinguish "the balance covers it" from "we could not read the
balance".

- `POST .../cost-estimates` makes **no network call** unless
  `checkProviderBalance: true`.
- Only Cloro has a wired probe (`GET /v1/credits`). Everything else returns
  `unknown` with a reason naming that no probe exists — never a guess.
- `Affordability` has `unknown` as a first-class outcome, and an unreadable
  balance never resolves to `affordable`.
- `GET .../spend` never probes; it returns `balanceProbe: { performed: false,
  reason }`.

## Retry and cache-hit safety

- **Settle is compare-and-swap:** `updateMany({ where: { status: 'held' } })`
  then assert exactly one row changed. A second settle is a 409 whose message
  says it would record a second charge. Verified with 5 concurrent settles →
  exactly 1 success, exactly 1 `SpendEvent`.
- **`POST .../spend` requires a `reservationId` or a `jobRunId`.** Without one
  the row cannot be de-duplicated against a retry, and a ledger that
  double-counts is worse than one with a gap. A repeat of the same
  `(reservationId|jobRunId, provider)` returns the existing event.
- **Lapsed holds are swept** (`expireStale`) on every read and inside the
  reserve transaction, so a crashed run stops blocking the next one.

## Dependencies

| Depends on | Why |
|---|---|
| `PrismaService` (global) | All persistence |
| `ScopeValidationService` (global) | G03 project-scope enforcement |
| `ConfigService` (global) | Tariff/cap env vars |
| `MeasurementModule` → `CloroClient` | The only provider balance this codebase can actually read |
| `jobs.types` `TASK_KINDS` | `taskKind` is shared with the G07 ledger — one vocabulary, not two |
| `measurement/adapters/cloro.adapter` `CLORO_BASE_CREDITS` | The tariff table, so a price change lands in one place |

Exports `BudgetsService` and `ReservationsService`. Any module that pays a
provider should reserve first, then settle.

## Env vars

Read, never written. Full provenance is in `.env.example`.

| Var | Used for |
|---|---|
| `CLORO_API_KEY` | Whether the Cloro balance probe can run at all |
| `CLORO_CREDIT_USD` | The **disclosed** credits→USD conversion rate (default `0.0004`) |
| `CLORO_MAX_CONCURRENCY` | Reported in `limits` for AEO capabilities |
| `AEO_SURFACES`, `AEO_MATRIX_TIER` | Default engine set / prompt count when the estimate request omits them |
| `AEO_MAX_COST_PER_AUDIT` | Reported as the AEO run ceiling in the capability registry |

No new env vars. No new dependencies.

## PRD alignment

| design_plan G12 requirement | Where |
|---|---|
| `GET/PUT /api/projects/:projectId/budget` | Endpoints 1–2 |
| `POST .../cost-estimates` | Endpoint 3 |
| `GET .../spend` | Endpoint 4 |
| Budget-approval actions | Endpoints 6–9 (approval queue via `?awaitingApprovalOnly=true`) |
| Provider, unit, estimate range, requested configuration | `SpendEvent.provider/unit`, `CostEstimate.rates` + `requestedConfiguration` echo, `reservation.estimate` |
| Per-call cap | `BudgetPolicy.perRunCapUsd` + `findPerRunBreach` |
| Reservation, actual settlement | Endpoints 7 and 10 |
| Remaining and unknown-balance reason | `UnitTotal.remaining`, `ProviderBalance.reason` |
| Persist policies/reservations/events/approvals at project/client/service levels | `BudgetPolicy.scopeType` client/project/operation; `approvedBy` |
| **Concurrent requests cannot overspend cap** | The transaction + lock + retry; verified at 20-way concurrency |
| **Retry/cache hits handled correctly** | Settle CAS, spend-event de-duplication, hold expiry |
| **Unknown balance not "fits"** | `ProviderBalance` / `Affordability` — `unknown` is first-class |
| **Estimates differ from actual and carry units** | `reservation.estimate` vs `actual` + `variance`; `UnitTotal.unit` |
| Existing AEO estimate is a Cloro credit estimate | `basis: 'cloro-credit-tariff'`, `unit: 'credits'`, separate `conversion` |

## What this module does not do

- **No money moves.** It records ceilings and charges; nothing calls a payment
  provider. G16 owns verified billing.
- **No client-scoped spend view.** OP18 is an operator screen; a client-facing
  cost view was not in the package and is not built.
- **No free-text rationale on release or approval.** `SpendReservation` has no
  note column, so `release` takes **no body** rather than accepting a reason
  that would be silently dropped. `settle` *does* accept a `note`, because
  `SpendEvent.note` exists. A rationale column is the right home for the
  others; G15's activity trail is the alternative.
- **No automatic enforcement at the provider call site.** `assertReady`-style
  gating is G18's; a module that wants a hard stop before spending should call
  `ReservationsService.reserve` and refuse to proceed on a 409. Wiring that
  into the existing audit pipelines is per-module work and was not done here.

## What was verified, and how

A harness (`/tmp/cailyx-g12-g18-verify.js`) instantiates the compiled services
directly against the dev database and exercises the semantics above. **96
assertions, 0 failures.** The load-bearing ones:

- 20 concurrent `$1` reservations against a `$10` hard ceiling → exactly 10
  succeed, exactly `$10` committed, all 10 refusals are `ConflictException`.
- 5 concurrent settles of one reservation → exactly 1 succeeds, exactly 1
  spend event written; a later settle → 409 and still 1 event.
- A `$40` credit reservation consumes a 100-credit ceiling and leaves the same
  policy's dollar total at 0.
- A dry estimate reports the balance `unknown` with a reason; an unestimated
  task kind reports `available: false` with empty ranges and affordability
  `unknown`.
- A soft overage is created unapproved, cannot be settled, becomes settleable
  after a delivery lead approves, and a second approval is a 409.
- A hard overage is refused with "not approvable"; the per-run cap is checked
  against the high estimate.
- A lapsed hold is swept to `expired` and stops blocking.
- A `cycle` policy with no live cycle is unresolved and refuses the
  reservation.
- A project with no policy reports `unboundedUnits`, not "within budget".

Also verified end-to-end over HTTP on a booted server: all 10 routes serve,
`PUT budget` / `POST cost-estimates` / `POST reservations` return 200/200/201,
and all 10 appear in the generated OpenAPI document.
