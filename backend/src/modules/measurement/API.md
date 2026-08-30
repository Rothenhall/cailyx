# Measurement API

All routes require `Authorization: Bearer <accessToken>`. Base: `/api/projects/:projectId/measurement`.

## POST /runs

Create a measurement run. `runCount` defaults to 5; **below 5 is a 400** (n≥5, no
exceptions). The target query set must belong to the project, be non-empty, and
be `active`.

```json
{
  "querySetId": "cmd...2r",
  "surface": "claude | perplexity | mock",
  "geo": "US",
  "runCount": 5
}
```

→ `201` run (status `pending`) · `400` n<5 / unknown surface / empty set · `404` · `409` set not active

## POST /runs/:runId/execute

Execute: every prompt × runCount, sequential, per-observation error isolation
(failed calls increment `failedRequests`, run continues). Cost-capped via
`MEASUREMENT_MAX_COST_PER_RUN` — exceeded → run `failed` with `error` set.
Returns run + observations. `completed` runs cannot be re-executed (409);
`failed` runs retry after wiping their partial observations.

## GET /runs[?surface=]

List runs, newest first.

## GET /runs/:runId

Run with observations ordered by prompt + runNumber. Observation fields:
`prompt`, `runNumber`, `mentioned`, `cited`, `citedUrl`, `position`,
`competitors` (JSON array of seen competitor names), `characterization`
(`present`|`absent`), `rawAnswer`, `costUsd`, `latencyMs`, `model`.

## GET /summary[?runId=]

```json
{
  "runs": 2,
  "observations": 40,
  "mentionRate": 0.5,
  "citationRate": 1,
  "bySurface":   [{ "surface": "mock", "observations": 40, "mentionRate": 0.5, "citationRate": 1 }],
  "byFunnelStage": [{ "funnelStage": "solution-aware", "observations": 20, "mentionRate": 0.5, "citationRate": 1 }],
  "shareOfVoice": [{ "name": "SampleCo (you)", "share": 0.8 }, { "name": "CompetitorA", "share": 0.2 }]
}
```

`shareOfVoice` = presence share of the subject ("(you)") vs every named
competitor seen in the same observations, subject first. Rates, never positions.