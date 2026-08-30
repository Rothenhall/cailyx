# Integrations Module

> **Status:** ✅ Built and e2e-verified (2026-08-30, part of `smoke/dashboard.smoke.sh`)
> **Type:** Dashboard aggregation — config inspection only

## Purpose

Reports the connection status of **every external service Cailyx can use**, for
the Okara Terminal's connections panel and connector cards.

Returns booleans + display metadata only — **no secret value ever leaves the
service** (the smoke test asserts the payload contains no key-shaped strings).

## Roster

| key | category | connected when… |
|---|---|---|
| `google-analytics` | analytics | never (OAuth flow not wired — external prerequisite) |
| `google-search-console` | analytics | never (OAuth flow not wired; GSC data is CSV-imported in `sleeper-refresh`) |
| `anthropic` | ai-surface | `ANTHROPIC_API_KEY` set |
| `perplexity` | ai-surface | `PERPLEXITY_API_KEY` set |
| `dataforseo` | serp | `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` set |
| `pagespeed` | performance | `PSI_API_KEY` set |
| `database` | infrastructure | always (the request proves it) |
| `redis` | infrastructure | a 700 ms `PING` to `REDIS_URL` returns `PONG` |
| `stripe` | monetization | `STRIPE_CHECKOUT_URL_FULL` or `_MONITORING` set |
| `plunk` | email | `PLUNK_API_KEY` set |
| `swarm-live` | mode | `SWARM_ALLOW_LIVE=1` |

## API

`GET /api/integrations` → `{ integrations: Integration[], summary: { total, connected } }`
(behind the global `JwtAuthGuard`).

`Integration = { key, name, category, connected, status, detail, configHint, connectUrl, docsPath }`

## Testing

Covered by `bash smoke/dashboard.smoke.sh` — roster returned, GA/GSC/DataForSEO/Anthropic
present, GA reports `not-connected`, **no secret values in the payload**, summary present.
