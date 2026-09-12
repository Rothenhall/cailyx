# Requirements — Keyword Research Module

## External tools / APIs

**DataForSEO Keywords Data** (decision D5, `docs/analysis/wave-6-audit-pipeline.md`)
— same vendor account already wired for `serp-intelligence`, no new
integration to approve.

| Endpoint | Used for |
|---|---|
| `POST /v3/keywords_data/google_ads/search_volume/live` | Exact volume/competition/CPC for the operator's own seed keywords (up to 1000/request; this module caps requests at 200) |
| `POST /v3/keywords_data/google_ads/keywords_for_keywords/live` | Related/long-tail keyword ideas for the seeds (DataForSEO caps this endpoint at 20 seeds/request) |

Auth: HTTP Basic (`DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`), identical to
`serp-intelligence`'s `DataForSeoProvider`. All HTTP goes through
`FetcherService` — no new outbound-request path.

## Infrastructure

None beyond what every other module already needs:

- The existing SQLite/Postgres database (via `PrismaService`, global).
- `FetcherService` (existing) for the vendor HTTP calls.

## npm packages

None new. No library was added for this module — plain `fetch` via
`FetcherService`, same as `serp-intelligence`.

## Environment variables

Already documented in `backend/.env.example` for `serp-intelligence` and
reused verbatim here — no new lines needed, only the master-switch/credential
gate is shared:

| Var | Required | Notes |
|---|---|---|
| `SWARM_ALLOW_LIVE` | Yes (`=1`) | Paid-call master switch, shared with `serp-intelligence` |
| `DATAFORSEO_LOGIN` | Yes | Same DataForSEO account as `serp-intelligence` |
| `DATAFORSEO_PASSWORD` | Yes | Same DataForSEO account as `serp-intelligence` |

Neither is set in this repo's `backend/.env` today — live calls fail closed
with a `503` naming exactly what to set. See `SETUP-STATUS.md`.
