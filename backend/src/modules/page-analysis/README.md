# Page Analysis (SOP-6, FR-3.3)

Copy-structure analysis for answer-engine extractability. Deterministic by
default; optional LLM refinement is stored separately and never scored.

## Files

```
page-analysis/
├── page-analysis.types.ts      # HeadingInfo, ExtractableClaim, FormatFindings, StructureScore
├── page-analysis.service.ts    # analyze (fetch + analyzeHtml), list, getOne, generateLlmNotes
├── page-analysis.controller.ts # POST analyze, GET list, GET :id
├── dto/page-analysis.dto.ts
├── page-analysis.module.ts
└── README.md
```

## Pipeline (strictly deterministic, disclosed weights, never renormalized)

| Subscore | Weight | What it checks |
|---|---|---|
| BLUF | 30 | First paragraph carries the answer inside the SOP-6 40–60-word window (a crisp short lead scores full; a buried answer decays 5 pts per extra 20 words) |
| questionH2 | 25 | Share of H2s that are question-shaped (question-word start or trailing `?`) |
| format | 25 | Tables (+10), ordered lists (+10 full / +5 partial), definition blocks (+5) |
| claims | 20 | Extractable claims ("number + noun + timeframe/source"): full credit at ≥5 sourced claims (no score for zero claims) |

`structureScore = bluf + questionH2 + format + claims` (0–100). The word-count ↔
citation correlation (0.04) is reported as context (`wordCount` column + PRD
note), never as a score driver.

**Standalone test heuristic:** an H2 is standalone when it is not anaphoric
("It/This/These/Final/Conclusion…") and is either question-shaped or ≥3 words —
a heuristic, disclosed per-heading with its reason in `headingStructure`.

**History is a feature:** every `POST /analyze` persists a row, so a
pre/post-restructure comparison is built in.

`useLlm:true` adds Claude `llmNotes` (BAD-heading verdicts, ≤55-word BLUF
rewrite, claims missing timeframe/source). **503 without `ANTHROPIC_API_KEY`,
and the deterministic row is intentionally NOT persisted then** (the request
returns its population — no half-persisted analysis).

## e2e evidence (2026-08-30, :3111)

1. `https://example.com` → `complete`, fetchStatus 200, title parsed, `bluf 30 / total 30`; `GET` list (2 rows incl. history), `GET :id` 200.
2. `useLlm:true` without key → honest **503**; deterministic row untouched.
3. Rich crafted fixture (run as a direct deterministic unit on the built service): lead 34 words → `bluf 30`, 2/2 question H2s → 25, table + 3 ordered items → `format 20`, 4 claims (3 with timeframe/source) → `claims 12`, `total 87`.
4. `http://localhost:…` URL → **fetch-failed** row persisted by design: the fetcher's SSRF guard blocks private IPs (documented behavior, honest status).
5. DTO fix during e2e: `@IsUrl()` rejected localhost-style URLs — replaced with protocol `Matches` + service-level URL validation.

Test rows wiped; fixture/temp servers killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| FR-3.3 extractability scoring | deterministic subscores + `structureScore` (dup disclosed weights) |
| SOP-6 BLUF | first-paragraph 40–60-window check |
| SOP-6 question H2s + standalone + format | `headingStructure` / `formatFindings` JSON |
| FR-8.4 spirit | disclosed weights; missing-signal subscores contribute 0, no renormalization |
| Scoring input | latest `complete` rows are the extractability evidence source for future rubric runs |