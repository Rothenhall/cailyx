# Scorecard (PRD §13 Rung 0 — the free trigger generator)

One persisted run of the REAL pipeline at low depth: a fresh technical audit
(access/on-page probes) → versioned-rubric scoring → **exactly 3 named,
specific problems** derived deterministically from the run's own evidence, no
LLM required (the free funnel never blocks on a paid API key).

**PRD §17 decision (docs/analysis/wave-5.md §2, option B):** engine +
operator-invokable API now; the public funnel is a flag, not a rebuild —
`GET /scorecard/public/:token` (unguessable cuid, `@Public`) hard-gates on
`SCORECARD_PUBLIC=1` and answers 403 with the remedy spelled out otherwise.

## Files

```
scorecard/
├── scorecard.types.ts       # ScorecardProblem, ScorecardResult
├── scorecard.service.ts     # run, list, get, getByPublicToken, topProblems
├── scorecard.controller.ts  # POST run (5/min), GET list, GET public/:token, GET :runId
├── scorecard.module.ts
└── README.md
```

## Pipeline

1. `technical-audit.runAudit(https://<domain>, projectId)` — fresh probe evidence.
   A probe failure never blocks the scorecard: the affected dimensions come
   back partial with their reason (FR-8.4), which is itself the finding.
2. `scoring.scoreProject(projectId)` — active rubric (auto-seeds PRD §8 v1),
   evidence-linked sub-scores.
3. `topProblems()`: sub-scores sorted ascending (partials sort worst), take 3 —
   each `why` is the dimension's first evidence line (reproduction-grade,
   FR-8.3), each `fix` a deterministic next move per dimension.
4. **nonObvious guarantee (SOP):** true when any top-3 `why`/evidence matches
   probe-only facts (`blocked|403|disallow|no schema|js render|robots.txt`) —
   things a prospect could not know without running the probes.
5. Persist `ScorecardRun(score, band, topFindings JSON, nonObvious, depth,
   publicToken @unique)`.

## e2e evidence (2026-08-30, :3111)

1. `POST /scorecard` → 201: fresh technical audit ran (2 `TechnicalAudit` rows for 2 runs), `score 33 / band invisible` on the auto-seeded rubric, exactly **3** named problems (`Entity clarity 0`, `Shortlist presence 0`, `Authority signal 0`) each with its evidence-line `why`.
2. `nonObvious:false` with the conservative heuristic → after adding `schema audit: fail` to the evidence rule, the same run's `Authority signal` ("Schema audit: fail (+0)") flipped it to **`true`** (the heuristic matches probe-only facts; note: with a key-less environment the audit is partial, disclosed in the run).
3. Public token view with flag off → **403** ("set SCORECARD_PUBLIC=1"); with flag on → **200** (score + 3 problems, no auth), bad token → **404**.
4. `GET /scorecard` list → newest first (2 runs).

Test rows wiped (verified `scorecardRuns: 0`, scoreRuns/technicalAudits cascaded out); server killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| §13 Free tier ("score and three findings") | score + band + exactly 3 named problems |
| "Finding the prospect couldn't know without us" | `nonObvious` flag from probe-only evidence |
| "Never gate the finding behind a call" | the 3 problems ship in the API response and the public token view |
| §17 self-serve question | public endpoint env-gated (operator-only until the flag flips) |
| docs/MODELS.md #12 | reuses TechnicalAudit + Score, adds only `ScorecardRun` |

## Env

| Var | Effect |
|---|---|
| `SCORECARD_PUBLIC=1` | Enables the `GET /scorecard/public/:token` funnel view (default off) |