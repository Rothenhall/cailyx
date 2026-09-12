# Requirements — Competitors Module

## External tools / APIs

None new. This module only calls services already in the backend:

- `TechStackService.scanDomain` — deterministic in-repo signature matching,
  no vendor account, no API key (wave-6 step 3).
- `FetcherService.fetchSchema` — already existed, used by other modules.
- Reads (never writes) `AeoAudit` and `SerpTracker`/`SerpResult` rows that
  the `aeo-audit` and `serp-intelligence` modules already produce.

## Infrastructure

None beyond what every other module already needs:

- The existing database (via `PrismaService`, global).
- `FetcherModule` (existing) — the schema/JSON-LD read.
- `TechStackModule` (wave-6 step 3) — the per-competitor tech scan.

## npm packages

None new.

## Environment variables

None.

## Schema note (this worktree only)

This worktree's `schema.prisma` also carries a minimal, non-relational
`AeoAudit` mirror (see README/SPEC) because the full `aeo-audit` module had
not landed in this branch's base commit at build time. No new dependency —
just a schema addition that should be deleted once the real model lands.
