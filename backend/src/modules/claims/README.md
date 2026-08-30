# Claims Module (Wave 2 — FR-9.4, the hard guardrail)

Claims discipline: **every numeric claim carries a source and a grade; banned
phrasings are blocked at generation; single-run results are never phrased as
rates.** Deterministic (no LLM on the gate itself) so results are reproducible.

## Grades

| Grade | Meaning |
|---|---|
| **A** | Number came from this project's own measurement engine (n≥5) |
| **B** | Backed by ≥ 2 independent external sources (auto-raised by `attachSource`) |
| **C** | Single external source (usable, must stay attributed) |

## Discipline check (deterministic)

`ClaimsService.checkCopy(copy)` returns a `CheckReport`: banned hits, numeric
statements, rate-without-provenance flag, and violations. Banned list seeded
from FR-9.4 ("rank #1", "guaranteed", plus close variants — see
`claims.types.ts` `BANNED_PHRASES`).

## Hard approval gate

`POST /claims/:id/approve` throws 400 when:
- the claim hit a banned phrase or states a rate without n≥5 provenance (stored `blocked`; never approvable)
- the claim carries numbers with no grade (also auto-marks the claim `blocked`, checkResult `ungraded-number`)

Re-checked at approval time, so even claims edited earlier can't sneak through.

## Endpoints

| Method | Path | Limits |
|---|---|---|
| POST | `/api/projects/:projectId/claims/check` | 30/60s — discipline-check any copy (used by findings + reporting) |
| POST | `/api/projects/:projectId/claims` | 20/60s — register claim (auto-checked; banned → `blocked`) |
| GET | `/api/projects/:projectId/claims?status=` | 100/60s |
| GET | `/api/projects/:projectId/claims/:claimId` | 100/60s — full check report + attached sources |
| POST | `/api/projects/:projectId/claims/:claimId/approve` | 100/60s — hard gate |
| POST | `/api/projects/:projectId/claims/:claimId/sources` | 100/60s — attach source (2 independent → auto-B) |

## PRD alignment

| PRD item | Status |
|---|---|
| FR-9.4 banned phrasings blocked at generation | ✅ deterministic list + findings post-check |
| FR-9.4 numeric claims carry source + grade | ✅ approval gate requires grade; sources tracked |
| FR-9.4 single-run results never phrased as rates | ✅ `single-run-rate` check blocks percentage copy without provenance |

## Verified e2e (2026-08-30)

- "We guarantee you will rank #1 with our industry-leading tool" → `banned-phrase` (3 hits)
- "Our extraction score is 85% across the audit" → `single-run-rate`, stored `blocked`, approve → 400
- Grade C + 2 independent sources → auto-raised to B with reason "Backed by 2 independent sources" → approved
- Ungraded numeric claim → approve 400, claim auto-marked `blocked`/`ungraded-number`