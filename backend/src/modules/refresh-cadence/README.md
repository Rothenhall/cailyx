# Refresh-Cadence Module (C7, `docs/analysis/client-portal.md` §19, `docs/PLAN.md` §11.7)

> **Status:** ✅ Built and live-verified against a real Postgres+backend process
> (details below). Not verified: an actual multi-hour wait for the real hourly
> `@nestjs/schedule` cron tick to fire on its own — see "What was NOT verified".

Automatic, plan-tier-driven re-measurement and re-scoring. No operator ever
configures a project's cadence — it is derived from `Client.planTier` and kept
in sync by an hourly reconcile-and-run poller, the same architecture pattern
`technical-audit` and `seo-audit` already use for their own recurring runs.

## Scoping decision (required write-up, done first per the task brief)

**What re-runs on cadence: `measurement` + `scoring`. Nothing else.**

`docs/PLAN.md` §11.7 explicitly warns that re-running the full Day-1
flowchart (competitor discovery, backlinks, tech-stack scan, entity audit,
gap analysis, strategy, report generation) on every cadence tick "is likely
wasteful." Those stages are one-time or infrequent by nature — a
competitor's tech stack does not change daily, and re-discovering
competitors on a timer would silently drift a project's competitive set
without anyone deciding to change it. Only two things are genuinely
time-sensitive and cheap enough to run on a cadence:

- **`measurement`** — one new `MeasurementRun` against the project's
  *current* **active** query set (querySet.status must be `active`;
  `createRun` 409s otherwise, same rule the manual endpoint enforces),
  replaying the **surface + geo of the project's most recently completed
  run**. This is the one genuinely time-sensitive signal a client is paying
  to watch: does the brand still get mentioned/cited today.
- **`scoring`** — `ScoringService.scoreProject()` afterwards, so the score
  reflects the fresh measurement summary immediately (shortlist-presence
  reads the measurement summary, per `scoring/README.md`).

This mirrors `monitoring`'s own shape more than it first looks: monitoring's
README says its checks are cheap because they "read only what other modules
already produced — no new measurement." This module is the one exception
that principle explicitly allows for — the "other module" producing fresh
measurement data on a schedule has to be *something*, and re-running the
narrowest possible slice (one run, the already-proven surface/geo pair, the
current active set) is the smallest new-measurement surface that still
answers "did visibility change."

**Explicitly NOT re-run:** `clients.onboarding-executors.ts`'s Day-1 pipeline
(competitor discovery, backlinks, tech-stack scan, entity audit, gap
analysis, strategy, report). `Project.onboardingStatus`/`onboardingStep` are
read (to gate cadence until Day-1 finishes) but never written by this
module — matching the explicit safeguard in `clients.onboarding-executors.ts`
that those fields describe the one-time bootstrap run only.

**Single surface, not a fan-out across every surface ever used.** A project
that has measured on multiple surfaces only gets its most-recently-completed
surface replayed per tick, not one run per surface. This was a deliberate
cost-containment choice (the task brief's "cost governors... so an automatic
scheduled trigger can't runaway-spend"): fanning out across N surfaces would
multiply real spend by N per tick with no explicit approval for that in the
approved scope. A future enhancement (replay every surface with an active
history) is a real option but needs its own decision, not an assumption
baked in here.

## Cadence-per-tier

| `Client.planTier` | Cadence | Why |
|---|---|---|
| `starter` | weekly | §19: "Starter weekly" |
| `growth` | daily | §19: "Growth/Scale daily" |
| `scale` | daily | §19: "Growth/Scale daily" |
| `enterprise` | daily | **Known gap — see below.** No literal real-time cadence exists in this codebase's scheduling infrastructure today. |
| none / unrecognized | `manual-only` | Never guess a spend-incurring cadence for an unset tier. |

### Known gap: Enterprise is not literally real-time

The task brief for this phase mentions "Enterprise real-time," but nothing in
this repo — not `docs/analysis/client-portal.md` §19 (which only writes
"Starter weekly, Growth/Scale daily" and stops there), not `docs/PLAN.md`
§11.7's own scope bullet (same two tiers, no Enterprise line) — actually
promises Enterprise a real-time cadence. The opposite is written down:
`docs/PLAN.md`'s architecture notes say plainly *"Real-time monitoring:
Phase 1 is batch runs on cadence. Continuous/real-time monitoring is
future."* So Enterprise is mapped to `daily` — the tightest cadence this
module's infrastructure (an hourly poll) can honestly support — rather than
inventing a real-time mechanism this phase was never asked to build and the
plan explicitly defers. If Enterprise real-time is actually wanted, that is
new scope: a push/streaming re-run trigger, not a variant of this cadence
poller.

### `Client.planTier` — a new field, because nothing already encoded a tier

`docs/analysis/client-portal.md` §5 says client-lifecycle "set plan/tier" is
"✅ already built" — that turned out not to hold up under a direct check
(the same kind of gap this repo's own audit culture keeps finding, e.g. §4's
"needs a direct check before assuming it's done"). `Client` had no tier
field, and `billing`'s `Offer`/`Entitlement` tables encode arbitrary price
mappings and feature keys, not a `starter`/`growth`/`scale`/`enterprise`
label. Per this phase's explicit "don't touch billing" instruction, this
module does not derive tier from the billing ledger. Instead: `Client.planTier`
(prisma/schema.prisma), default `"starter"`, settable via the existing
generic `PATCH /clients/:clientId` (`clients` module — not excluded from this
phase's scope, and the only touch made there: DTO field + type + service
passthrough, nothing pipeline-related).

## How the automation actually runs

Same architecture as `technical-audit/audit-scheduler.service.ts` and
`seo-audit/seo-audit-scheduler.service.ts` — an in-process `@nestjs/schedule`
`@Cron(EVERY_HOUR)` poll against the database, **not** the BullMQ path. This
was a direct decision, not an oversight: `technical-audit`'s own scheduler
polls `ScheduleConfig` rows **without** filtering by task name, so it is the
only task type that actually executes under the default
`SCHEDULING_BACKEND=cron`. Under that default, `monitoring`'s BullMQ handler
registration (`SchedulingService.registerHandler('monitoring', ...)`) never
actually fires, because the BullMQ worker itself is only constructed when
`SCHEDULING_BACKEND=bullmq` (see `monitoring/README.md`'s own "Known
limitation" note on `ScheduleConfig` collisions). Reusing that same shared
`cadence`/`active`/`nextRunAt` columns for a *third* task would only make
that collision worse. So, matching `seo-audit`'s solution to the exact same
problem: **dedicated columns** —
`ScheduleConfig.refreshCadence` / `refreshNextRunAt` / `refreshActive` /
`refreshLastRunAt` / `refreshLastError` — polled by this module's own
scheduler, with zero risk of colliding with technical-audit's or
monitoring's cadence.

```
refresh-cadence/
├── refresh-cadence.types.ts             # PlanTier, RefreshCadence, status/result DTOs
├── refresh-cadence.service.ts           # cadenceForTier, syncProjectCadence, reconcileAll, runScopedRefresh, getStatus
├── refresh-cadence-scheduler.service.ts # hourly @Cron: reconcileAll() then runs due refreshes
├── refresh-cadence.controller.ts        # GET status + POST run-now (no config route — see below)
├── refresh-cadence.module.ts
└── README.md
```

Each hourly tick:
1. **Reconcile** — `reconcileAll()` walks every project with
   `onboardingStatus: 'completed'` and a `clientId`, and calls
   `syncProjectCadence(projectId)` for each: resolves the client's
   `planTier`, maps it to a cadence, and upserts the `ScheduleConfig.refresh*`
   row if it doesn't already match. Idempotent — a no-op for a project
   already in sync. This is what makes a plan-tier change (or a project
   just finishing Day-1) take effect within the hour, with **no event hook
   wired into `clients.service.ts`** — the reconcile loop is the only place
   this module reads `Client`/`Project`, keeping the coupling one-directional
   (this module reads their tables; neither of those modules imports this
   one).
2. **Run what's due** — `scheduleConfig.findMany({ refreshActive: true,
   refreshCadence: in ['daily','weekly'], refreshNextRunAt: <= now+60s })`,
   sequentially (a scoped refresh calls a real measurement surface — real
   spend per call — so no parallel fan-out).

`onboardingStatus !== 'completed'` gates cadence sync entirely (§ "Day-1
pipeline not finished yet — nothing to refresh yet"): a project still mid
Day-1 bootstrap has no active query set and no prior completed run, so
`runScopedRefresh` would just skip anyway; gating earlier avoids marking a
schedule `active` before there is anything to activate.

## Endpoints

There is deliberately **no cadence-configuration route**. Cadence is derived,
not operator-set — that is the whole point of "genuinely automatic" per the
task brief.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/:projectId/refresh-cadence` | Read-only: plan tier, derived cadence, active/next/last run, last error. `ScopeValidationService.assertProjectAccess` gates it (same pattern as `monitoring`'s controller). |
| POST | `/api/projects/:projectId/refresh-cadence/run-now` | Operator/QA override — runs the same scoped refresh the scheduler would run on cadence, immediately. Does **not** touch `refreshLastRunAt`/`refreshNextRunAt` (those are the scheduler's own bookkeeping) — this is a side-channel manual trigger, not a schedule mutation. |

Both require an authenticated operator with project access; no client-portal
route was added (this is an internal delivery mechanism, not something a
client configures).

## Cost governor — respected, not bypassed

`MeasurementService.executeRun` already enforces
`MEASUREMENT_MAX_COST_PER_RUN` per run (per-observation check, stops and
marks the run `failed` with the reason once the running total exceeds the
cap). This module calls `executeRun` exactly as the manual measurement
endpoint does — no separate cap, no override, no bypass. One thing this
module *adds*: `executeRun` does not throw when a run ends `status: 'failed'`
(it just records the reason on the row), so `runScopedRefresh` explicitly
checks the executed run's status and throws if it is `'failed'` — otherwise
a cost-cap trip would silently score off stale data and report success. The
scheduler's `mark()` then records that failure in `refreshLastError`, so an
operator reading `GET /refresh-cadence` sees it. (Found and fixed during live
verification below — see the git history for the exact before/after.)

## Dependencies

- `PrismaService` (global `DatabaseModule`) — reads `Client.planTier`,
  `Project`, `QuerySet`, `MeasurementRun`, writes `ScheduleConfig.refresh*`.
- `MeasurementModule` (`MeasurementService.createRun`/`executeRun`).
- `ScoringModule` (`ScoringService.scoreProject`).
- `@nestjs/schedule`'s `ScheduleModule` — already registered globally in
  `app.module.ts` (`ScheduleModule.forRoot()`), used by the sibling
  schedulers.
- **Does NOT import** `ClientsModule` or `BillingModule` — see the doc
  comment on `refresh-cadence.module.ts` for why.

## Environment variables

None added. Cadence derivation is pure code (`cadenceForTier`), and the
default `SCHEDULING_BACKEND=cron` execution path needs no Redis — same as
`technical-audit`'s and `seo-audit`'s schedulers. `MEASUREMENT_MAX_COST_PER_RUN`
(already documented in `measurement/README.md`) is read by `MeasurementService`
itself, not by this module.

## PRD / spec alignment

| Ref | Status | Notes |
|---|---|---|
| `docs/analysis/client-portal.md` §19 — fully automatic, plan-tier-derived cadence | ✅ | No operator configures a project's cadence; `reconcileAll()` derives it from `Client.planTier` every hour. |
| §19 — Starter weekly, Growth/Scale daily | ✅ | `cadenceForTier` |
| §19 — reuse `scheduling`/`monitoring`'s existing cadence infra | ✅ (adapted) | Reuses the `ScheduleConfig` table + the established hourly-cron-poll pattern (`technical-audit`/`seo-audit`), not the BullMQ path — see "How the automation actually runs" for why that's the more faithful reuse under this repo's actual default backend. |
| `docs/PLAN.md` §11.7 — own scoping pass on which stages re-run | ✅ | This README's "Scoping decision" section. |
| §11.7 — do not bypass `MEASUREMENT_MAX_COST_PER_RUN` | ✅ | Unmodified; a cap trip is now also surfaced as a refresh failure (see "Cost governor"). |
| "Enterprise real-time" (task brief) | ❌ | Not promised anywhere in `docs/analysis/client-portal.md` or `docs/PLAN.md` §11.7 — the opposite is written (`docs/PLAN.md`: "Real-time monitoring... is future"). Mapped to `daily` instead; flagged as a known gap above rather than invented. |

## Testing notes — what was verified live, and what was not

Verified live (2026-09-21, real backend process on `:3002`, real Postgres via
`docker-compose`'s `cailyx-postgres` on `:5436`, `MEASUREMENT_ALLOW_MOCK=1`,
mock surface — no external API calls):

1. `npx prisma db push` — schema (new `Client.planTier` +
   `ScheduleConfig.refresh*` columns) applied cleanly against the live,
   shared dev Postgres. (One interruption: a concurrent worktree's own
   `db push` raced and dropped these columns mid-session — re-pushing
   restored them. This is a property of sharing one dev Postgres across
   parallel worktree sessions, not a bug in this module; noted here so it
   isn't mistaken for one.)
2. `npx tsc --noEmit` — zero errors, both before and after the fix below.
3. `npx nest build` — clean.
4. Created a real `Client` (`POST /api/clients` with `planTier: "growth"`)
   and a real `Project` under it (`POST /api/clients/:id/projects`), let the
   Day-1 pipeline actually run to completion (`onboardingStatus: "completed"`,
   real technical-audit/gap-analysis/report against the fixture domain —
   confirmed via server logs and `GET /api/clients/:clientId`).
5. `GET /projects/:id/refresh-cadence` before Day-1 finished →
   `cadence: "manual-only", active: false` (correctly gated). After PATCHing
   the client's `planTier` to `"growth"` and manually invoking
   `syncProjectCadence` (see below for why manually) →
   `cadence: "daily", active: true, nextRunAt: <+1 day>`.
6. Created + activated a real `QuerySet`, ran a real baseline
   `MeasurementRun` (mock surface, n=5) to completion.
7. `POST /projects/:id/refresh-cadence/run-now` → `{ran: true,
   measurementRunId, scoreRunId}` — confirmed via `GET
   /measurement/runs` (a second `completed` run, same surface `mock`) and
   `GET /scoring/:scoreRunId` (a fresh `ScoreRun`, band `invisible`,
   total `33`, matching the measurement-summary-fed shortlist dimension).
8. Forced a `ScheduleConfig` row "due" (`refreshNextRunAt` in the past) and
   invoked `RefreshCadenceSchedulerService.tick()` directly (see below) —
   confirmed it reconciles, finds the due row, runs the scoped refresh
   (third completed `MeasurementRun` + new `ScoreRun`), and advances
   `refreshNextRunAt`/`refreshLastRunAt` with `refreshLastError: null`.
9. **The bug this caught**: an early version of `runScopedRefresh` did not
   check the executed run's final status, so a run that failed internally
   (first pass through this harness, caused by an incomplete test stub —
   see below) still reported `ran: true` with no error surfaced. Fixed by
   checking `executed.status === 'failed'` and throwing, so the scheduler's
   `mark()` now correctly records `refreshLastError`.

**Why steps 5 and 8 used a direct service call instead of only HTTP**: this
module's automation is designed to run on an **hourly** cron tick and a
**daily/weekly** cadence — neither is practical to wait out in a
verification session. Rather than fake that with a shortened test-only
interval (which would verify a different code path than production runs),
steps 5/8 instantiated `RefreshCadenceService`/`RefreshCadenceSchedulerService`
directly against the same compiled `dist/` code and the same live database
the HTTP server was using, and called the exact same public methods
(`syncProjectCadence`, `tick`) the real hourly cron invokes. This exercises
the real logic, not a mock of it — only the *wall-clock wait* was skipped,
not the code path.

**What was NOT verified**: the real `@nestjs/schedule` `@Cron(EVERY_HOUR)`
decorator actually firing unattended over a full hour, and a `planTier`
change being picked up by that real unattended tick rather than a manually
invoked one. `technical-audit`'s and `seo-audit`'s schedulers use the
identical `@Cron(CronExpression.EVERY_HOUR, { name: ... })` mechanism and
are both documented as working in this codebase, so this is a low-risk gap,
but it is an honest one — a multi-hour unattended wait was not run in this
session.

All test data (the throwaway `Client`/`Project`/`QuerySet`/`MeasurementRun`/
`ScoreRun`/`ScheduleConfig` rows) was deleted afterward; no scratch scripts
were left in the repo (they lived in the session's scratchpad directory,
outside the working tree).
