# Monitoring (PRD 6.12, FR-12.1–12.4) + alert triage (G07)

Scheduled re-run checks, before/after deltas, and regression alerts for the
visibility pipeline. Reads only what other modules already produced — no new
measurement — so the monitoring surface stays cheap and honest.

G07 added the **triage** half: `AlertLifecycle` rows, de-duplication, and
acknowledge / assign / resolve under `/api/projects/:projectId/alerts`.
Generation and triage stay in separate files — this service discovers
regressions, `AlertsService` records what a human decided about them.

## Files

```
monitoring/
├── monitoring.types.ts      # MonitorSnapshot, MonitorDelta, AlertKind, triage vocabulary
├── monitoring.service.ts    # snapshot / delta / checkDeltas / alerts + scheduled handler
├── monitoring.controller.ts # generation + schedule surface (PRD 6.12)
├── alerts.service.ts        # G07 — lifecycle, dedupe, triage transitions
├── alerts.controller.ts     # G07 — /api/projects/:projectId/alerts
├── dto/monitoring.dto.ts    # ListAlertsQueryDto, AssignAlertDto, ResolveAlertDto
├── monitoring.module.ts
└── README.md
```

## What it does

| Piece | Behavior |
|---|---|
| `GET /monitoring/snapshot` | One point-in-time read: latest score run (total/band), latest **completed** measurement run (mention/citation rates + observation count), total crawler hits. 404 with a hint when nothing has run yet. |
| `GET /monitoring/delta` | Two-latest score runs → `{before, after, change}` (null until 2 runs); two-latest completed measurement runs → observation-count trend. |
| `POST /monitoring/check` | Compares the two latest runs against thresholds and records alerts for regressions. Returns the regressions **found** (possibly `[]`) — a condition already open for the same subject is folded into its existing alert, not inserted twice. |
| `GET /monitoring/alerts` | Raw `Alert` rows, newest-first, filterable `?kind=` `?severity=` `?limit=` (default 50, max 200). The pre-G07 shape; triage state is on `/alerts`. |
| `PUT /monitoring/schedule` | Registers the `monitoring` repeatable job via SchedulingService — the handler registered in the service constructor re-runs `checkDeltas` on cadence and raises a `scheduled-run-failed` alert if it errors (FR-12.1). |
| `GET`/`DELETE /monitoring/schedule` | Read / remove the monitoring cadence. |
| `GET /alerts` | Alerts **with triage state**, ordered by when the condition was last seen (so a still-firing nightly regression stays at the top), filterable `?status=` `?kind=` `?severity=` `?limit=`. |
| `GET /alerts/:alertId` | One alert + lifecycle + the actions the server will currently accept. Scoped: another project's alert id 404s. |
| `POST /alerts/:alertId/acknowledge` | Records who saw it and when. Idempotent for the same operator, 409 for a different one. |
| `POST /alerts/:alertId/assign` | Assign to a non-disabled **operator** account. Re-assignment replaces the previous assignee. |
| `POST /alerts/:alertId/resolve` | Requires resolution text; optionally links a `workItemId` that must belong to the same project. Terminal for this episode. |

### Alert thresholds

| Kind | Trigger | Severity |
|---|---|---|
| `score-drop` | newest total ≥ 10 points **below** previous | `critical` ≥ 20pt drop, else `warning` |
| `mention-drop` | mention rate falls ≥ 15 points (absolute) between the two latest completed runs | `critical` ≥ 30pt drop, else `warning` |
| `scheduled-run-failed` | the scheduled check handler throws | always `critical` |

Thresholds are module constants (`SCORE_DROP_THRESHOLD`, `MENTION_DROP_THRESHOLD`) — no silent renormalization; a partial run still produces a comparable count.

Each alert now also records the two runs it compared (`beforeRunId`/`afterRunId`
in `payload`), so an alert can be traced back to the exact measurements instead
of only to a sentence.

## Alert de-duplication (G07)

`Alert` stays append-only. The dedupe key is a stable hash of
**kind + project + subject**, where the subject defaults per kind
(`visibility-score`, `mention-rate`, `scheduled-monitoring-check`) and can be
overridden with `payload.subject`:

- the condition re-fires while its alert is **open** (new / acknowledged /
  assigned) → one row updates: `occurrences + 1`, `lastSeenAt` refreshed,
  severity escalated to the worst seen, message replaced with the latest
  firing's numbers. **No new feed row.**
- it re-fires after being **resolved/dismissed** → a new episode: a new `Alert`
  row, and the same lifecycle row re-pointed at it with the triage fields
  cleared and `occurrences` reset to 1. The record of what was done to the
  previous episode survives, because it was closed deliberately.

An alert raised before `AlertLifecycle` existed has no row yet: it reads as
`status: 'new'` with `tracked: false`, and a triage **write** creates the row
(never a read — a GET has no side effects).

> `dedupeKey` is indexed but not unique (the schema is frozen, and G07 may not
> edit it), so two simultaneous *first* firings of the same condition could in
> principle both insert. The nightly check is single-threaded, so this is
> theoretical; `occurrences` makes the intent explicit either way.

Triage is a **decision record, not a verification**: `scopeNote` on every alert
says so, because monitoring re-reads numbers other modules produced and an
alert being "resolved" does not mean a fix was measured (design_plan G07:
"no full-chain claim from the current monitoring check").

## Access control

Every route in both controllers now calls
`ScopeValidationService.assertProjectAccess` before touching a row, and every
alert is resolved with `findFirst({ id, projectId })` — an alert id from another
project 404s rather than resolving. Before G07 these routes were project-scoped
in the URL but only auth-guarded, i.e. any authenticated operator could read any
project's alerts, scores and crawler data; scores and alerts are client-visible
material. Alert *triage* additionally validates that an assignee is a
non-disabled operator account and that a linked work item belongs to the same
project.


## e2e evidence (2026-08-30, :3111, `dist/main.js`)

1. Snapshot with no score/measurement data → **404** `Nothing to monitor yet — run scoring or measurement first`; delta → `{score: null, measurement: null}`.
2. After a completed 25-observation mock measurement run: snapshot → `mentionRate 0, citationRate 0, observations 25, crawlerHits 6`; `POST /check` → `[]` (no regressions).
3. First scoring run persisted (total 0, band invisible, partial). The run was then re-dated −8 days and set to 95 points to simulate a regression; second `POST /scoring/run` → total 0.
4. `POST /monitoring/check` → `[{"kind":"score-drop","severity":"critical","message":"Visibility score dropped 95 points: 95 → 0"}]`; `GET /alerts` → 1 row; `?severity=info` filter → 0 rows; `GET /delta` → `{"before":95,"after":0,"change":-95}`.
5. `GET /schedule` → `{"cadence":"manual-only","nextRunAt":null,"active":false}`.
6. Log line confirms handler registration: `Registered handler for task: monitoring`.

Test data wiped afterward (alerts, crawlerHits, modelDiffs, observations, runs, scoreRuns/rubrics, query sets, project, users); server killed.

## G07 triage evidence (2026-09-16, :3011, `dist/main.js` + a partial app boot)

Exercised through the real controllers over HTTP (the full app could not boot —
other packages' modules were mid-edit — so the harness booted only
`DatabaseModule` + `ScopeValidationModule` + `JobsModule` + `MonitoringModule`
with an injected admin request user). All rows created were deleted afterwards:

1. `GET /alerts` → the alert with `tracked: false`, `status: new`,
   `occurrences: 1`, all three actions available, and the scope note.
   `?status=acknowledged` → 0 (it is not acknowledged).
2. `GET /alerts/:id` → 200; `GET /alerts/does-not-exist` → **404**.
3. Acknowledge → `status: acknowledged`, `acknowledgedBy` = the caller.
   Assign → `assigned` with the assignee. Resolve with text → `resolved` with
   the resolution stored.
4. Re-resolve → **409**; assign to an unknown user → **404**; empty resolution →
   **400**; `?status=nonsense` → **400**.
5. Deduplication: two `record()` calls for the same kind+project+subject → the
   **same alert id**, `occurrences: 2`, and exactly **one** `Alert` row.

Service-level checks (56 total, all passing) covered the rest: severity
escalation on a re-firing, re-acknowledge idempotency, a different operator
being refused, and a resolved condition re-firing as a **new episode** (new
alert row, one lifecycle row for the condition).

## Dependencies / notes

- `SchedulingModule` (BullMQ + **Redis on `REDIS_URL` / `localhost:6380`**) — `PUT/DELETE /schedule` require a running Redis; without it the request has nowhere to enqueue (same constraint as the technical-audit schedule endpoints). `GET /schedule` works Redis-free (DB only).
- `CrawlerMonitorModule` supplies the crawler-hit count in the snapshot.
- `ScopeValidationService` comes from the global `ScopeValidationModule`
  (activated in `AuthModule`) — no import needed here.
- **Known limitation:** `ScheduleConfig` is one row per project, so the monitoring cadence and the technical-audit cadence share that row — setting one overwrites the other's cadence value (the repeatable BullMQ jobs remain distinct via the `taskName` key). G07's `CadenceRule` is deliberately a separate, per-task-kind row and does not share this limitation; the two systems coexist until the `monitoring` task moves onto the cadence tick.
- **Deliberate gap:** there is no `dismiss` route. `AlertLifecycle.status` carries the value and the transition table marks it terminal, but the G07 contract lists four actions (detail / acknowledge / assign / resolve), so this package does not invent a fifth surface. Un-triaged means `new`, not dismissed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| FR-12.1 scheduled re-runs | `monitoring` task handler + `PUT /schedule` (weekly/monthly/manual-only) |
| FR-12.2 before/after | `GET /delta` |
| FR-12.3 regression alerts | `POST /check` + Alert rows (score-drop / mention-drop) |
| FR-12.4 monitoring surface | `GET /snapshot` |
| G07 alert detail/acknowledge/assign/resolve | `alerts.controller.ts` + `alerts.service.ts` |
| G07 alert deduplication | `AlertsService.record` (dedupe key = kind + project + subject) |

## G19/D19 — assessed, no behaviour change (2026-09-16)

Appendix B D19: *"Monitoring service compares stored results; current delta
exposes score change and observation counts, not a complete period series."*
**That is an accurate description of the source, and it is the intended
behaviour** — so nothing about the computation changed. What changed is that the
contract now says it out loud, so a dependent screen cannot read more into
`/delta` than it holds:

- `GET /monitoring/delta` is a **two-point** comparison of the two latest stored
  score runs, with no `from`/`to` window, no per-period rows, and no collection:
  nothing on this route triggers a run, so a delta can only exist once two runs
  are already stored. The route now says so, and points at the modules that do
  own a series (`technical-audit/trend/history`, `seo-audit/trend/history`, the
  AEO verdict) for a real trend.
- `MonitorDelta` (in `monitoring.types.ts`) documents the same thing at the
  type level, and states that `measurement` counts **observations**, not
  mentions — the mention-rate comparison lives in `checkDeltas`, which is what
  raises the alert.
- `score.change` is a point difference, and is `null` until a previous run
  exists to subtract. Documented rather than left as a bare `number | null`.

Monitoring is still not fresh AEO collection and not a monthly outcome engine;
the README's own endpoint table already described the real shape, and now the
served contract agrees with it.

**Verified:** `npx tsc --noEmit` clean for this module; `/delta` maps on a
booted instance.
