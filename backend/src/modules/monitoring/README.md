# Monitoring (PRD 6.12, FR-12.1–12.4)

Scheduled re-run checks, before/after deltas, and regression alerts for the
visibility pipeline. Reads only what other modules already produced — no new
measurement — so the monitoring surface stays cheap and honest.

## Files

```
monitoring/
├── monitoring.types.ts      # MonitorSnapshot, MonitorDelta, AlertKind
├── monitoring.service.ts    # snapshot / delta / checkDeltas / alerts + scheduled handler
├── monitoring.controller.ts # REST surface
├── dto/monitoring.dto.ts    # ListAlertsQueryDto
├── monitoring.module.ts
└── README.md
```

## What it does

| Piece | Behavior |
|---|---|
| `GET /snapshot` | One point-in-time read: latest score run (total/band), latest **completed** measurement run (mention/citation rates + observation count), total crawler hits. 404 with a hint when nothing has run yet. |
| `GET /delta` | Two-latest score runs → `{before, after, change}` (null until 2 runs); two-latest completed measurement runs → observation-count trend. |
| `POST /check` | Compares the two latest runs against thresholds and **persists Alert rows** for regressions; returns the alerts raised (possibly `[]`). |
| `GET /alerts` | Newest-first, filterable `?kind=` `?severity=` `?limit=` (default 50, max 200). |
| `PUT /schedule` | Registers the `monitoring` repeatable job via SchedulingService — the handler registered in the service constructor re-runs `checkDeltas` on cadence and raises a `scheduled-run-failed` alert if it errors (FR-12.1). |
| `GET/DELETE /schedule` | Read / remove the monitoring cadence. |

### Alert thresholds

| Kind | Trigger | Severity |
|---|---|---|
| `score-drop` | newest total ≥ 10 points **below** previous | `critical` ≥ 20pt drop, else `warning` |
| `mention-drop` | mention rate falls ≥ 15 points (absolute) between the two latest completed runs | `critical` ≥ 30pt drop, else `warning` |
| `scheduled-run-failed` | the scheduled check handler throws | always `critical` |

Thresholds are module constants (`SCORE_DROP_THRESHOLD`, `MENTION_DROP_THRESHOLD`) — no silent renormalization; a partial run still produces a comparable count.

## e2e evidence (2026-08-30, :3111, `dist/main.js`)

1. Snapshot with no score/measurement data → **404** `Nothing to monitor yet — run scoring or measurement first`; delta → `{score: null, measurement: null}`.
2. After a completed 25-observation mock measurement run: snapshot → `mentionRate 0, citationRate 0, observations 25, crawlerHits 6`; `POST /check` → `[]` (no regressions).
3. First scoring run persisted (total 0, band invisible, partial). The run was then re-dated −8 days and set to 95 points to simulate a regression; second `POST /scoring/run` → total 0.
4. `POST /monitoring/check` → `[{"kind":"score-drop","severity":"critical","message":"Visibility score dropped 95 points: 95 → 0"}]`; `GET /alerts` → 1 row; `?severity=info` filter → 0 rows; `GET /delta` → `{"before":95,"after":0,"change":-95}`.
5. `GET /schedule` → `{"cadence":"manual-only","nextRunAt":null,"active":false}`.
6. Log line confirms handler registration: `Registered handler for task: monitoring`.

Test data wiped afterward (alerts, crawlerHits, modelDiffs, observations, runs, scoreRuns/rubrics, query sets, project, users); server killed.

## Dependencies / notes

- `SchedulingModule` (BullMQ + **Redis on `REDIS_URL` / `localhost:6380`**) — `PUT/DELETE /schedule` require a running Redis; without it the request has nowhere to enqueue (same constraint as the technical-audit schedule endpoints). `GET /schedule` works Redis-free (DB only).
- `CrawlerMonitorModule` supplies the crawler-hit count in the snapshot.
- **Known limitation:** `ScheduleConfig` is one row per project, so the monitoring cadence and the technical-audit cadence share that row — setting one overwrites the other's cadence value (the repeatable BullMQ jobs remain distinct via the `taskName` key).

## PRD alignment

| PRD ref | Implementation |
|---|---|
| FR-12.1 scheduled re-runs | `monitoring` task handler + `PUT /schedule` (weekly/monthly/manual-only) |
| FR-12.2 before/after | `GET /delta` |
| FR-12.3 regression alerts | `POST /check` + Alert rows (score-drop / mention-drop) |
| FR-12.4 monitoring surface | `GET /snapshot` |