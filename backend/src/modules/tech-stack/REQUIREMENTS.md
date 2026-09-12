# Requirements — Tech Stack Module

## External tools / APIs

None. Detection is a deterministic in-repo signature table — no vendor
account, no API key, no per-lookup cost.

## Infrastructure

None beyond what every other module already needs:

- The existing Postgres database (via `PrismaService`, global).
- `FetcherService` (existing) for the one HTTP fetch per scan.

## npm packages

None new. `cheerio` (already a backend dependency, used by five other
modules) is the only library this module touches.

## Environment variables

None.
