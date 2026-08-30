# Findings Module (Wave 2 — PRD FR-9.1–9.3)

Turns open gap-analysis rows into **what/why/fix copy in two registers**
(executive + technical) via a constrained LLM, filtered through claims
discipline before storage.

## Copy generation (FR-9.3)

- Anthropic SDK (`FINDINGS_MODEL`, default `claude-opus-5`) with a strict JSON
  output schema (`whatExecutive/whatTechnical/whyExecutive/whyTechnical/fixExecutive/fixTechnical`)
- The prompt hands only the gap + recorded evidence — the model may not state
  numbers not in the evidence
- Generated copy runs through `ClaimsService.checkCopy` (FR-9.4): banned
  phrases → one constrained regeneration → still violating → finding skipped
  (never stored)
- Requires `ANTHROPIC_API_KEY` (503 without it); `FINDINGS_MODEL` env override

## Non-obvious honesty (FR-9.1)

A finding earns its place if evidence spans ≥ 2 modules (technical audit /
measurement / entity audit) or severity is high/critical. Gaps below the
threshold still generate but are stored `thinRun: true` with a `disclosedGap`
saying exactly which evidence is missing. A batch with fewer than
`MIN_FINDINGS` (3) results is flagged `thinRun` at the batch level.

## Endpoints

| Method | Path | Limits |
|---|---|---|
| POST | `/api/projects/:projectId/findings/generate` | 3/60s — body `{limit?}` (1–10, default 5) |
| GET | `/api/projects/:projectId/findings` | 100/60s |
| GET | `/api/projects/:projectId/findings/:findingId` | 100/60s |

## PRD alignment

| PRD item | Status |
|---|---|
| FR-9.1 classify, rank, non-obvious guarantee | ✅ gap ranking + thinRun honest flag |
| FR-9.2 ranking | ✅ priorityScore-desc gap selection |
| FR-9.3 what/why/fix, executive + technical registers | ✅ constrained Anthropic generation |

## Verified e2e (2026-08-30, without API key)

- `POST .../generate` without `ANTHROPIC_API_KEY` → 503 (honest unavailability)
- `GET .../findings` on empty project → `{findings: [], thinRun: true}`
- Live-LLM path is code-reviewed and compile-verified; run it once a key is set (same constraint as measurement's Claude adapter)