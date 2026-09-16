# `modules/jobs` — durable job ledger, cadence and the queue (G07)

**Purpose.** One durable record of what ran, what it cost, what it produced and
what is scheduled — so a client reload, an API restart or a killed worker
cannot make the app forget a paid run. `design_plan.md` §10.3 is the reason this
exists at all: *"Local memory is not a durable job ledger."*

Contract source: `design_plan.md` Appendix A (G07), line 1635. Build spec:
`docs/analysis/design-plan-implementation.md`. Screen inventory: OP07/PJ11/MO01–MO03/OP13.

## File tree

```
jobs/
├── jobs.module.ts            wiring: queue + ledger + cadence + onboarding
├── pipeline-queue.service.ts BullMQ transport — runs a handler, forgets it
├── jobs.service.ts           the ledger: idempotency, heartbeats, recovery, retry, cancel
├── cadence.service.ts        CadenceRule CRUD + the tick loop
├── onboarding.service.ts     the Day-1 pipeline as a resumable run
├── jobs.controller.ts        /jobs, /onboarding, /cadences
├── jobs.types.ts             status vocabularies, task kinds, onboarding stages
├── lib/coverage.util.ts      status + coverage derived from steps
├── lib/cadence-schedule.util.ts  next-occurrence maths in the rule's timezone
├── dto/jobs.dto.ts           create/cancel/record-step/list DTOs
├── dto/cadence.dto.ts        PUT cadence, run-now
├── dto/onboarding.dto.ts     create/resume
└── README.md
```

Two layers, deliberately separate: **transport** (`PipelineQueueService`) and
**ledger** (`JobsService` and friends). The queue does not depend on the ledger;
`JobsService` registers itself as the queue's `JobRunTracker` on init, and
`PipelineQueueService.enqueue` **asks the tracker for a run before it queues the
job** and merges the returned `jobRunId` into the job's data. So a job enqueued
by a feature module that has never heard of the ledger is tracked anyway, and a
job that arrives carrying its own `jobRunId` (the retry path, `JobsService.enqueueRun`)
keeps it.

### How a feature module's jobs become tracked runs (G07/A7)

The four audit modules enqueue their own jobs and none of them imports the
ledger — deliberately, since the package boundary runs the other way. The queue
therefore attaches the run itself, from the two facts it has: the job **name**
(mapped to a task kind through `JOB_NAME_TASK_KIND`) and the job's **`projectId`**.

| Situation | What happens |
|---|---|
| data already carries a `jobRunId` | kept as-is (`enqueueRun` / `createAndEnqueue` path) |
| job name maps to a task kind, data has a `projectId`, no run in flight | a run is created (`trigger: 'pipeline'`, `input` = the job's parameters, `maxAttempts` = the queue's `attempts`) and the job carries its id |
| another run of that kind is in flight on the project | **untracked**, logged — two jobs must never settle one run |
| no `projectId`, or the name maps to no task kind | untracked, logged at debug |
| the ledger write fails | untracked, logged at warn: a bookkeeping failure never stops the work |
| `PIPELINE_AUTO_TRACK_RUNS=0` | untracked for every job |

`enqueue` returns `{ jobId, jobRunId }` — the run id is there for a caller that
wants to link to it (the Day-1 technical-audit stage records it as an artifact),
and existing callers that destructure only `{ jobId }` are unaffected.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/projects/:projectId/jobs` | `?taskKind=` `?status=` `?limit=`. Each run carries steps, coverage, and the actions the server will accept. |
| `GET` | `/api/projects/:projectId/jobs/:jobId` | Scoped: a run id from another project 404s. |
| `POST` | `/api/projects/:projectId/jobs` | Create-or-return-existing. **201** created, **200** the idempotency key already existed, **409** another run of that kind is in flight. |
| `POST` | `/api/projects/:projectId/jobs/:jobId/retry` | Bounded, keeps succeeded steps. **409** while running or out of budget. |
| `POST` | `/api/projects/:projectId/jobs/:jobId/cancel` | Returns spend, reversibility, `refunded: false` and the sentence to display. **409** if already finished. |
| `POST` | `/api/projects/:projectId/jobs/:jobId/steps` | Record a step outcome; re-derives the run status. |
| `GET` | `/api/projects/:projectId/onboarding` | The current run, the next stage, and whether this process can run it. `run: null` when there is none — not a 404. |
| `POST` | `/api/projects/:projectId/onboarding` | Create-or-return-existing (**201**/**200**). Default key `onboarding:<projectId>`. |
| `GET` | `/api/projects/:projectId/onboarding/:runId` | One run. |
| `POST` | `/api/projects/:projectId/onboarding/:runId/resume` | Advance to the first stage that did not succeed. |
| `GET` | `/api/projects/:projectId/cadences` | Every supported task kind; unconfigured kinds are `configured: false` with the defaults. |
| `GET` | `/api/projects/:projectId/cadences/:taskKind` | One rule (or its defaults). |
| `PUT` | `/api/projects/:projectId/cadences/:taskKind` | `@Roles('admin','delivery-lead')`. Validates anchors + timezone, recomputes `nextRunAt`. |
| `POST` | `/api/projects/:projectId/cadences/:taskKind/run-now` | `@Roles('admin','delivery-lead')`. Out-of-band tick: same rules minus the clock. |

Every handler calls `ScopeValidationService.assertProjectAccess` first, and
every service method resolves the child row **within** its project.

Supported `taskKind`: `technical-audit`, `seo-audit`, `aeo-audit`, `presence`,
`serp`, `mentions`, `backlinks`, `gap`, `score`, `report`,
`content-generation`, `onboarding`.

## The non-negotiables, and where they live

### 1. Idempotency (`JobsService.createRun`)

A run created with an `idempotencyKey` that already exists returns **that run**
(`outcome: 'existing'`); the caller must not enqueue anything, and the HTTP
layer returns 200 rather than 201. This is the behaviour that stops a duplicate
scheduler tick from buying the same data twice.

It is safe under concurrent callers because the **database** is the arbiter:

1. look the key up — a hit returns immediately;
2. otherwise insert; a `P2002` on `JobRun.idempotencyKey` means another caller
   won, so re-read the winner (with a short retry, in case the winner's commit
   is not yet visible) and return it.

A *different* run of the same task kind that is still in flight is a separate
thing and is reported as `outcome: 'locked'` → **409**, not silently merged.
The lock is bounded (`JOB_LOCK_WINDOW_MS`, default 1h) and refreshed by
heartbeats, so a run nobody is working on cannot block the schedule forever.

### 2. Heartbeats and recovery (`JobsService.recoverStaleRuns`, `PipelineQueueService.runHandler`)

The BullMQ worker calls the ledger on three edges: `onStart` (mark running,
record the attempt), a 30-second `onHeartbeat` interval, and `onSettled` (the
handler returned or threw). All three are best-effort — bookkeeping must never
fail a job that otherwise succeeded, and never changes what a handler returns.

**This is now live for real work**, not just for a job that asks for it: every
`technical-audit`, `seo-audit` and `presence-discovery` job is attached to a run
by the queue (see the table above), so the worker heartbeats a real ledger row
and a killed worker leaves a run the sweep can reconcile.

A worker that is *killed* cannot report anything, which is what the sweep is
for: runs still claiming `status = 'running'` whose heartbeat is older than
`JOB_HEARTBEAT_STALE_MS` (default 5 min) are reconciled **on their own row** —
marked `failed` with an explicit "Interrupted" reason, and any step they left
mid-flight marked failed too. **No replacement run is created, ever**, and a
second sweep immediately after finds nothing: a worker restart yields exactly
one recoverable run. Restarting the work is an explicit `POST .../retry`, never
automatic — §10.3: *"Never blindly retry … paid generation."*

A worker that is *restarted* while a job is queued is the other half: the run
keeps its row and its `attempt`, and the next attempt picks it up.

### 3. Honest cancellation (`JobsService.cancel`)

The response carries `spentUsd`, `spentCredits`, `reversible`,
`hasUnrecoverableWork`, the steps that were interrupted, `refunded: false`, and
a `statement` that says in plain words what is already spent and whether it can
still be undone. Cancelling is **cooperative**: the ledger flips immediately so
the job list is truthful, and a handler that checks `JobsService.assertActive`
at its step boundaries stops at the next one. A handler that never checks keeps
running — and nothing in the response claims otherwise.

### 4. `partial` is a real status (`lib/coverage.util.ts`)

Run status is derived from the steps, not from the handler's mood:

| Steps | Status |
|---|---|
| any still running, or pending behind a settled step | `running` |
| nothing started | `queued` |
| every step skipped | `failed` — the run produced *nothing*, and calling that `completed` would be a lie |
| no failures, all succeeded | `completed` |
| nothing succeeded | `failed` |
| otherwise | **`partial`** |

Three of five engines answering is `partial`, with
`coverage.disclosure` saying so in words ("3 of 5 steps succeeded, 2 failed …
4 of 6 items returned a result"), because `JobStep.attempted` vs `succeeded` is
the coverage disclosure and it is not averaged into a single number.

`settle()` never downgrades a run to `queued`/`running` on the strength of steps
that were never reported: silence from the steps is not evidence of absence.

### 5. Cadence (`CadenceService`)

DB-driven, not a Redis repeatable job: a client's schedule is a commitment, and
`CadenceRule.nextRunAt` survives a Redis restart in a way a repeatable job does
not.

- **Pause.** A rule with `pausedAt` does not tick, and neither does a rule whose
  funding engagement is paused (G06 pauses that engagement for exactly this
  reason). `run-now` refuses a paused rule with 409 rather than quietly billing
  a paused client.
- **Prerequisites.** `prerequisites` is a list of `CapabilityStatus.key`s. A
  tick whose prerequisites are not ready is **skipped with the reason recorded
  in `lastError`** — never a nightly failure. Readiness is conservative: a key
  with no `CapabilityStatus` row is *unknown*, and unknown is not ready; mock
  mode is not ready either.
- **Timezone.** `nextRunAt` is computed in the rule's own `timezone` and
  re-derived from the rule every time rather than incremented from `lastRunAt`,
  so a late tick or a DST change does not drift the schedule. Weekly/biweekly
  need `dayOfWeek`, monthly/quarterly need `dayOfMonth` (clamped into short
  months), and an unknown IANA zone is a 400.
- **Duplicate ticks.** The idempotency key is `cadence:<ruleId>:<dueInstant>`,
  derived from the schedule slot rather than from the moment the sweep happened
  to run — so two sweeps over the same overdue rule produce one run, and the
  second records `lastStatus: 'duplicate'` with the reason.

### 6. Alerts

Triage lives in `modules/monitoring` (`AlertsService`, `AlertsController`) —
see that module's README. Deduplication is by a stable
`sha256(kind + project + subject)`, so the same condition re-firing updates one
`AlertLifecycle` row (`occurrences`, `lastSeenAt`, worst severity seen, latest
message) instead of appending a new alert every night.

## Onboarding runs

An onboarding run is a `JobRun` with `taskKind: 'onboarding'` and one `JobStep`
per Day-1 stage, in the order `ONBOARDING_STAGES` declares. Resuming continues
from the **first stage that did not succeed**; stages that already succeeded are
not re-run, so a retry never re-buys work that produced a result.

### The stage executors are registered (G07/A7 — this seam is closed)

`ClientsOnboardingExecutors`
(`modules/clients/clients.onboarding-executors.ts`) registers one executor per
stage with `OnboardingService.registerStageExecutor`, so `modules/jobs` still
does not import the pipeline body. All **14** stages are registered: the ten
always-on ones (`enrichment`, `entity-audit`, `technical-audit`,
`digital-presence`, `tech-stack`, `competitors`, `gap-analysis`, `strategy`,
`findings`, `report`) and the four opt-in ones (`keyword-research`,
`growth-execution`, `aeo-audit`, `backlinks`), which run only when the run's
input asks for them — the same rule the add-client checkboxes apply.

Three things about the executors are load-bearing:

- **A stage that produced nothing is recorded as failed, never as a success
  with zero coverage** — `JobStep.attempted`/`succeeded` is the coverage
  disclosure, and a run whose steps all read `succeeded` is `completed`, so
  swallowing a dead stage would make a partial run look whole. Worst case, a
  failed stage is retried by the next resume (bounded by `maxAttempts`), and
  `POST /jobs/:jobId/retry` resets it deliberately.
- **A stage that was enqueued and did not finish is re-checked, not re-bought.**
  The queued stages (technical audit, digital presence) write the job/run id
  they started into the run's `artifacts`; a later resume finds that id and
  polls *it* rather than queueing a second paid run. Only a job that is gone or
  dead is replaced.
- **A stage the run did not ask for reports `attempted: 0, succeeded: 0`** — a
  statement that nothing was attempted, not a claim that something was.

`resume` also had to change with them: "is this run already going?" is now
**"is a step `running`?"**, claimed with a compare-and-set on the step row, so
two simultaneous resumes cannot both buy the same stage. The old guard (run
status plus heartbeat freshness) refused the *next* stage for
`JOB_HEARTBEAT_STALE_MS` after every stage that completed — a fourteen-stage
pipeline would have taken a heartbeat window per stage — because a run with one
settled step and thirteen pending derives to `running` by the coverage rules.

`GET /onboarding` still returns the pre-G07 `Project.onboardingStatus`/
`onboardingStep` fields, labelled `legacy`, and the executors keep those columns
in step as they advance, so the two records can be compared during the
transition instead of silently disagreeing.

**What is still a seam here.** `ClientsService.createProject` still starts the
legacy `runDayOnePipeline` in the background, not a durable run — creating a
run for it as well would run every stage twice. Moving Day-1 onto the ledger is
a deliberate follow-up (start the run in `createProject` and drive `resume`
until it settles), not something to do while both paths exist.

## Dependencies and configuration

- `PrismaService` — global (`DatabaseModule`). `ScopeValidationService` —
  global (`ScopeValidationModule`, activated in `AuthModule`).
- Redis (`REDIS_URL`, default `redis://localhost:6380`) for the queue worker.
  An absent Redis is logged and ignored, exactly as before G07 — the ledger,
  the cadence loop and every endpoint above work without it; a job simply is
  not picked up.
- `CadenceService`'s tick loop is **in-process**, which assumes a single API
  instance (the same assumption `SchedulingService` already makes). The rules
  themselves are already safe to tick concurrently — the idempotency key is what
  makes that true — so moving the loop behind the existing BullMQ repeatable-job
  path later is a scheduling change, not a data one.

| Env var | Default | Meaning |
|---|---|---|
| `PIPELINE_AUTO_TRACK_RUNS` | `1` (on) | Whether `enqueue` attaches a durable run to the jobs it queues. `0`/`false`/`off` disables it. |
| `JOB_HEARTBEAT_INTERVAL_MS` | `30000` | Queue worker heartbeat cadence |
| `JOB_HEARTBEAT_STALE_MS` | `300000` | Age at which a `running` run is treated as a dead worker |
| `JOB_RECOVERY_SWEEP_MS` | `60000` | Recovery sweep period; `0` disables it |
| `JOB_LOCK_WINDOW_MS` | `3600000` | How long an in-flight run holds the per-project lock |
| `CADENCE_TICK_MS` | `60000` | Cadence tick period; `0` disables the loop (run-now still works) |

## Unblocking G03

`PipelineQueueService.getStatus(jobId)` now returns the job's `projectId`
(and only that — the job's full `data` can carry a `userId` and run parameters
that are nobody else's business). That is the field
`ScopeValidationService.assertJobBelongsToProject` was written against and had
nothing to read. The two handlers that need it are named in
`common/guards/README.md` and live outside this package (see the change report).

## What each audit module still has to do (G07/A7)

`technical-audit`, `seo-audit` and `presence-discovery` need **nothing**: their
`enqueue` calls already carry a `projectId`, so every job they queue now
produces a tracked run, without either module changing a line.

Two adoptions remain, both outside this package:

| Module | Change | Why |
|---|---|---|
| `aeo-audit` (`aeo-audit.service.ts`, `runFullAsync`) | add `projectId` to the enqueue data: `{ auditId: audit.id, input }` → `{ auditId: audit.id, projectId, input }` | it is the one pipeline job whose data carries no `projectId`, so the queue cannot scope a run to it — AEO runs are the one pipeline-kind that stays out of the ledger, and `getStatus` returns no `projectId` for G03's scope check either |
| any handler that wants step-level coverage | call `JobsService.recordStep(data.jobRunId, …)` at its own step boundaries | an auto-created run has **no steps**, so it can only ever settle `completed`/`failed` — it makes no claim about 3-of-5 engines, because it observed nothing at that grain. Only the handler knows its own steps; the run id is already in the job data it is handed. |

Step-level coverage matters most for AEO, where "3 of 5 engines answered" is the
normal case: as things stand that job leaves a `completed` run with no coverage
detail. Recording a step per surface (or a final `partial` verdict) is what makes
`partial` visible for it.

## PRD alignment

| Contract line | Implementation |
|---|---|
| Scoped `GET /jobs`, `GET /jobs/:jobId` | `JobsController` + `JobsService.listRuns/getRun` |
| `POST /jobs/:jobId/retry`, `/cancel` where safe | `JobsService.retry` (bounded, keeps succeeded steps) / `cancel` (spend + reversibility disclosure) |
| Onboarding run create/read/resume | `OnboardingService` + `OnboardingController` |
| `GET/PUT /cadences/:taskKind` | `CadenceService` + `CadencesController` |
| Alert detail/acknowledge/assign/resolve | `modules/monitoring/alerts.*` |
| AEO, SERP, mentions, backlinks, gap/score/report task kinds | `TASK_KINDS` |
| Idempotency keys, per-project run locks, heartbeats, bounded retries | `createRun`, `findInFlightRun`, `heartbeat`, `recoverStaleRuns`, `retry` |
| Cancellation says what is unrecoverable | `CancelResult.statement` / `refunded: false` |
| Restart recovery, duplicate-tick safety, pause semantics | `recoverStaleRuns`, cadence idempotency key, `pausedAt` + engagement pause |

## What was verified

Run against the dev SQLite DB, using a throwaway project id so no real
project's rows were touched; every row the check created was deleted
afterwards (verified: `runs=0 alerts=0`). Two harnesses, both driving the
compiled `dist` output of the real services, not a mock:

- **56/56 service checks** — idempotency (repeat, and two concurrent callers),
  the per-project lock, `partial` from 3-of-5 steps, coverage counts and
  disclosure, cancel spend/reversibility/`refunded:false`, cancel-twice 409,
  retry (attempt increment, succeeded steps preserved, no silent no-op),
  retry budget 409, stale-heartbeat recovery (finds it, is idempotent, leaves
  exactly one row, marks the in-flight step), a live heartbeat is left alone,
  cross-project 404s, `nextRunAt` in `Europe/London` (weekly 06:00 local and a
  DST-safe daily), unknown timezone 400, missing anchor 400, pause skip,
  unmet-prerequisite skip with the reason in `lastError`, ready-prerequisite
  start, duplicate tick → `duplicate` with one run, alert dedupe (one row, two
  occurrences, severity escalation), the full triage transition set, terminal
  409s, and a re-opened episode.
- **12/12 queue checks** — a tracked job marks its run `running` and heartbeats
  mid-flight, completes on return, records `finishedAt`, fails with the
  handler's message, stays `queued` when another attempt is pending, and a run
  cancelled before its job starts is skipped without spending.
- **HTTP, through the real controllers** (a partial app booting only
  `DatabaseModule` + `ScopeValidationModule` + `JobsModule` +
  `MonitoringModule`, because other packages' modules were mid-edit at the
  time): 201-then-200 idempotency, 409 lock, 200 step recording → `partial`,
  list filters, 404 for a foreign run id, 400 for an unknown status filter,
  retry, cancel disclosure, onboarding 201/200 + read + resume-with-no-executor,
  cadence list/PUT/400s/409/run-now/pause, alerts list + status filter + detail
  + acknowledge/assign/resolve + terminal 409s + unknown-assignee 404.

Not verified end-to-end: a real audit module's *handler* reporting steps (none
does yet — see the adoption table above), and `ClientsService.createProject`
driving a durable run instead of the legacy background pipeline (it still drives
the legacy one; create-with-`POST /onboarding` plus resume is verified).

### A7 verification (the wiring this README used to call inert)

Two harnesses over the compiled `dist` of the real services, against the dev
SQLite DB and the live Redis on :6380. Throwaway project ids only; every row and
every job the harnesses created was deleted afterwards (`leftovers=0`). Jobs are
enqueued with an hour's delay so no other process's worker on the shared queue
can pick them up and run a real audit; the worker path is driven through
`PipelineQueueService.runHandler` with the job data BullMQ actually stored,
which is what the worker hands a handler.

**41/41 queue + ledger checks:** a tracked `enqueue` creates a `queued` run
(project-scoped, `trigger: pipeline`, `maxAttempts` from the queue's attempts,
input = the job's parameters), the job's stored data carries the `jobRunId`
alongside its own parameters and `projectId`, the worker marks it `running` and
writes a heartbeat, the 30-second heartbeat advances mid-flight, a handler that
reports 3-of-4 steps settles the run **`partial`** with the coverage sentence,
its failed step keeps its error, recorded cost and `reversible: false` land on
the run, a second concurrent job of the same kind is left untracked (no second
run), a job with no `projectId` (the AEO shape) creates no run, a cancelled run
is skipped before the handler is paid and stays cancelled, the stale-heartbeat
sweep reconciles a dead worker's run exactly once, and `PIPELINE_AUTO_TRACK_RUNS=0`
attaches nothing.

**47/47 onboarding + capability checks** (real `AppModule`, so every module's
own registration ran): all 14 Day-1 stages have an executor; a run is created
with 14 steps; `resume` runs the real `enrichment` executor (its `company`/
`category`/`competitorCandidates` artifacts merge into the run) and leaves the
run `running` with stages pending; the next `resume` advances to `entity-audit`
without touching the succeeded stage (its `finishedAt` and `attempted` sentinel
are unchanged) and the real entity-audit executor records an entity id plus the
schema-check verdict; two simultaneous resumes advance exactly one stage and the
other is refused with "Stage … is in flight"; and the A5 checks below.

Also verified: the app boots on `PORT=3099` with no DI errors, logging
"Registered job run tracker" and "Registered 14 Day-1 onboarding stage
executors".
