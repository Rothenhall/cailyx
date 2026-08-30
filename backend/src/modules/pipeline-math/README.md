# Pipeline Math (GTM Playbook, PLAN Phase 4)

The qualification arithmetic for discovery calls: revenue target → ÷ ACV → ÷
win rate → ÷ meeting-to-SQL → ÷ lead-to-meeting → ÷ visitor-to-lead → visitors
needed, compared against the addressable market → verdict `feasible | fiction`
(DECISION B from docs/analysis/wave-5.md §1: one persisted row per project).

## Files

```
pipeline-math/
├── pipeline-math.types.ts      # PipelineStages, PipelineVerdict, FICTION_FACTOR
├── pipeline-math.service.ts    # computeStages, verdictFor, save/recalc/get
├── pipeline-math.controller.ts # PUT, GET, PATCH under /projects/:id/pipeline-math
├── dto/pipeline-math.dto.ts
├── pipeline-math.module.ts
└── README.md
```

## Model

`PipelineMath(id, projectId @unique, revenueTarget, acv, winRate,
meetingToSql, leadToMeeting, visitorToLead, marketSize?, stages JSON,
verdict)` — every intermediate stage persisted, not just the verdict, so the
arithmetic is auditable months later.

| Route | Notes |
|---|---|
| `PUT /pipeline-math` | Create or replace (upsert). Rates are fractions in (0,1] — 400 otherwise |
| `GET /pipeline-math` | Current model + stages + `fictionFactor`; 404 with a PUT hint when never computed |
| `PATCH /pipeline-math` | What-If recalc: patch any subset of inputs, the rest keep their stored value |

**Verdict rule (disclosed, FR-8.4 spirit):** with `marketSize` supplied,
required visitors > 1.5 × market («FICTION_FACTOR = 1.5», returned in every
response) → `fiction`; without a market size the verdict is `feasible` with
`ratio: null` — absence of a market claim is not a pass for fiction either
(no market given ⇒ no verdict against one).

Stages are ceil-rounded to whole units — you cannot win 0.3 of a deal.

## e2e evidence (2026-08-30, :3111)

1. `PUT` plan (500k / 25k ACV / 20% / 50% / 10% / 2%) → `{deals:20, sqls:100, meetings:200, leads:2000, visitors:100000}` — the division chain verified stage by stage.
2. Same plan + `marketSize:10000` → `verdict:"fiction"`, `ratio:10` (100k needed vs 10k market ≫ 1.5×).
3. `PATCH {"winRate":0.5, "marketSize":500000}` → only those inputs changed, stages recomputed (40 SQLs / 80 meetings / 40k visitors), `ratio:0.08` → `feasible`.
4. `winRate:0` → **400** (rate floor 0.001).
5. `GET` after never-computing → 404 with the PUT hint (pre-upsert case not hit in this run — GET verified post-save).

Test rows wiped (verified `pipelineMath: 0`); server killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| PLAN Phase 4 chain | the 5-stage division exactly as prescribed |
| "Verdict: feasible or fiction" | verdict + disclosed 1.5× threshold + ratio |
| "Live calculation in discovery calls" | PATCH what-if recalc |
| docs/MODELS.md #13 | same columns, `stages` carries the intermediates |