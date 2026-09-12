# Setup Status — Competitors Module

| Item | Status |
|---|---|
| `Competitor` / `CompetitorProfile` Prisma models | ✅ Added to `schema.prisma`, pushed via `npx prisma db push`, client regenerated |
| `TechStackScan` / `TechFinding` Prisma models | ✅ Also added — this worktree's base commit predates the `tech-stack` module; copied in as a dependency (see README) |
| Minimal `AeoAudit` mirror | ✅ Added, read-only, scalar-only (see README/SPEC — delete once the real relational model lands) |
| Module registered in `app.module.ts` | ✅ `TechStackModule` then `CompetitorsModule`, under "Wave 6 step 3" / "Wave 6 step 6" comments |
| `npx tsc --noEmit` | ✅ Clean, no `any` |
| Env vars | None needed |
| Vendor credentials | None needed |
| Smoke test (`backend/smoke/competitors.smoke.sh`) | ✅ Added, wired into `run-all.sh` (auto-discovered) |
| Live end-to-end verification (real backend, real domains) | See README "Testing notes" |
