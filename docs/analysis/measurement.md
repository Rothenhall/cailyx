# Analysis — `measurement` module (Wave 1, PRD §6.6–6.7, SOP-2)

> **Date:** 2026-08-30 · **Status: approved (user picked surfaces 2026-08-30)**
> Decision made: **Claude + Perplexity for v1.** ChatGPT/Google AIO deferred behind the same adapter interface.

## What the module must do (PRD)

- Run each prompt of an **active** query set **n ≥ 5 times per surface per geo** — hard block below 5 (DESIGN PRINCIPLE 2)
- Fresh, clean context per observation (every API call is stateless — satisfied by design)
- Record per observation: `mentioned`, `cited` (with URL), `position`, `characterization` (v1: present/absent), `competitors` seen alongside, raw answer, cost, latency, model
- Aggregate: mention rate, citation rate (by surface / funnel stage / persona), **share of voice vs named competitors**
- Cost governor: per-run ceiling, env-configurable

## Surfaces v1 + tool choices

| Surface | Integration | Notes |
|---|---|---|
| `claude` | `@anthropic-ai/sdk`, model via `MEASUREMENT_CLAUDE_MODEL` (default `claude-opus-5`), server-tool `web_search_20260209` | Citations come straight from `web_search_tool_result` blocks — deterministic, no scraping |
| `perplexity` | raw HTTP to `https://api.perplexity.ai/chat/completions`, model `sonar` (env `MEASUREMENT_PERPLEXITY_MODEL`) | OpenAI-compatible endpoint; `citations[]` in response. No SDK needed |
| `mock` | deterministic pseudo answers | **Test-only**; refuses to run unless `MEASUREMENT_ALLOW_MOCK=1` |

Rejected for v1 (recorded, revisit in Wave 3): headless ChatGPT capture (ToS-gray, fragile), Google AIO via SERP providers (per-query cost × 12 surfaces is steep until rates are proven).

## Options considered (adapter pattern is the same for all)
- **API adapters (chosen):** clean data, citable URLs, cheap (~$0.004–0.02/observation w/ Opus pricing; sonar pennies). Con: measures API models, not browser UI surfaces exactly.
- **Headless capture (Playwright+residential proxies):** true surface fidelity; brittle, expensive, ToS-gray. Defer.

## Entities

- `MeasurementRun` — projectId, querySetId, surface, geo, runCount, status, counters, costTotal, error, timestamps
- `Observation` — runId, itemId, runNumber, prompt, mentioned, cited, citedUrl, position, competitors (JSON string), characterization, rawAnswer, costUsd, latencyMs, model

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects/:projectId/measurement/runs` | Create run (requires ACTIVE query set; runCount ≥ 5 enforced) |
| `POST` | `/api/projects/:projectId/measurement/runs/:runId/execute` | Execute all observations sequentially, cost-capped |
| `GET` | `/api/projects/:projectId/measurement/runs` | List runs |
| `GET` | `/api/projects/:projectId/measurement/runs/:runId` | Run + observations |
| `GET` | `/api/projects/:projectId/measurement/summary` | Rates + share of voice across runs (optional `?runId=` to scope) |

## Env vars

`ANTHROPIC_API_KEY`, `MEASUREMENT_CLAUDE_MODEL` (default claude-opus-5) · `PERPLEXITY_API_KEY`, `MEASUREMENT_PERPLEXITY_MODEL` (default sonar) · `MEASUREMENT_MAX_COST_PER_RUN` (default 5.00) · `MEASUREMENT_ALLOW_MOCK` (unset by default — test only).