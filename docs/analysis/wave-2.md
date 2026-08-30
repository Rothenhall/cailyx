# Analysis: Wave 2 — Scoring, Claims, Findings

Date: 2026-08-30 · Status: approved-by-default (proceeds on standing "complete the PRD" directive; flag anything you want changed)

## 1. Scoring (PRD §8, FR-8.1–8.4)

**What exists:** `reporting.service.ts` has a private `computeScore` — §8 weights (25/25/20/20/10) but: no versioned rubric, no persistence, shortlist dimension scores *audit coverage* as a proxy, bands are `critical/moderate/strong` instead of the PRD bands, and a failed stage silently scores 0 (violates FR-8.4).

**Options considered:**
1. **Separate `scoring` module (chosen)** — owns the rubric, bands, and score runs; reporting consumes it as a library. Matches PRD ("the run records the rubric version it used") and lets monitoring/future modules score without generating a report.
2. Keep expanding the private method inside reporting — rejected: no rubric versioning surface, hidden from API consumers, unverifiable standalone.
3. Full pluggable-rubric DSL (custom formula functions) — rejected for v1: over-engineering; weights + band thresholds as JSON covers FR-8.2.

**Design:**
- `ScoreRubric` — versioned rows; weights JSON (5 dimensions), band thresholds JSON. v1 seeded with PRD defaults: machine access 25, entity clarity 25, shortlist presence 20, extractability 20, authority 10; bands 0–40 `invisible`, 41–60 `faint`, 61–80 `present`, 81–100 `recommended`.
- `ScoreRun` — projectId, rubricVersion, total, band, status, subScores JSON where every entry carries `evidence[]` (FR-8.3), `partial` + `partialReason` when its evidence source is missing or a stage failed (FR-8.4 — partial never silently zero; partial dimensions still contribute what evidence exists).
- Inputs now real: shortlist presence reads the **measurement summary** (mention rate + share of voice) instead of the audit-coverage proxy. Machine access / entity / extractability / authority read the technical + entity audits as today.
- Reports: `reporting` refactored to call `ScoringService.scoreProject()` — its private scorer and proxy wording are deleted. Report stores rubricVersion.

## 2. Claims (FR-9.4 — hard guardrail)

**Options for stat grading:**
1. **Deterministic rules + Claude-assisted grade (chosen)** — grade A = number came from this project's own measurement (n≥5), B ≥ 2 independent external sources, C = single source. Rules decide mechanically when provenance is on the claim; Claude assesses source counts when provenance is vague. Determinism first, LLM only to classify sources.
2. Pure deterministic — rejected: real claim sources are messy; a naive rule misgrades.
3. Pure LLM grading — rejected: non-deterministic grades on a compliance gate.

**Banned-phrase blocker:** deterministic match against a seeded versioned list ("rank #1", "guaranteed", plus variants) — hard 422/400 at claim-approval and at findings-copy generation. Single-run results phrased as rates are also blocked (FR-9.4 third clause).

**Design:** `Claim` rows with statement/sourceUrl/sourceName/grade/gradeReason/status; `POST …/claims/check` endpoint runs the discipline filter for arbitrary copy (used by findings + reporting).

## 3. Findings (FR-9.1–9.3)

**Options for what/why/fix copy:**
1. **Constrained-LLM via Anthropic SDK (chosen)** — reuse the approved Claude surface; strict JSON output schema, short context (gap + evidence only), two registers (executive, technical), then the claims-discipline filter post-check. Raw request cost-capped like measurement.
2. Deterministic templates — rejected: FR-9.3 explicitly wants LLM copy; templates read canned.
3. Free-form LLM with prompt-only constraints — rejected: claims discipline must be enforceable post-hoc, not promised in-prompt.

**Design:** `Finding` rows linked to a gap; generation selects ranked gaps, generates copy per finding, flags `thinRun` when the evidence set is below the non-obvious threshold (FR-9.1 degrades honestly instead of inventing).