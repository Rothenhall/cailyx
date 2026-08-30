# Scoring Module (Wave 2 — PRD §8, FR-8.1–8.4)

The PRD §8 weighted visibility roll-up as a versioned, evidence-linked,
persisted module. Replaced the private `computeScore` inside `reporting` —
reports now call `ScoringService.scoreProject()` and record the rubric version.

## Rubric (FR-8.2)

Versioned `ScoreRubric` rows (weights JSON + band thresholds JSON). Rubric v1
auto-seeds on first score with PRD defaults:

| Dimension | Weight |
|---|---|
| Machine access | 25 |
| Entity clarity | 25 |
| Shortlist presence | 20 |
| On-page extractability | 20 |
| Authority signal | 10 |

Bands (PRD §8): 0–40 `invisible`, 41–60 `faint`, 61–80 `present`, 81–100
`recommended`. Create further versions with `POST /api/rubrics`
(weights must sum to 100; `activate:true` switches).

## Honest partials (FR-8.4)

A missing evidence source (no audit run, no measurements, no schema checks)
marks the dimension `partial: true` with a reason — it contributes 0 but the
run's `status` is `partial`. Never inflated by re-normalizing: the score is a
floor when sources are missing.

## Real inputs

Shortlist presence reads the **measurement summary** (mention rate 50% +
subject share of voice 50%) — the audit-coverage proxy was deleted. Machine
access / extractability / authority read the technical audit; entity clarity
reads schema checks.

## Endpoints

| Method | Path | Limits |
|---|---|---|
| POST | `/api/projects/:projectId/scoring/run` | 10/60s |
| GET | `/api/projects/:projectId/scoring` | 100/60s |
| GET | `/api/projects/:projectId/scoring/latest` | 100/60s |
| GET | `/api/projects/:projectId/scoring/:runId` | 100/60s |
| GET | `/api/rubrics` | 100/60s |
| POST | `/api/rubrics` | 5/60s |

## PRD alignment

| PRD item | Status |
|---|---|
| FR-8.1 0–100 weighted score, sub-scores + band | ✅ |
| FR-8.2 versioned weights/thresholds, run records rubric version | ✅ |
| FR-8.3 evidence-linked sub-scores (no black-box numbers) | ✅ every sub-score carries evidence lines |
| FR-8.4 graceful degradation (partial, not silent zero) | ✅ |

## Verified e2e (2026-08-30)

- Fresh project → auto-seeded rubric v1 → all 5 dims `partial`, band `invisible`, status `partial`
- After a mock measurement run: shortlist flipped to `partial=false` with real evidence ("Mention rate 0.0% over 10 observations", "Share of voice (you): 0.0%", surfaces)
- `GET /api/rubrics` → v1 active