# Entity Audit — Left Out Items

> **Date:** 2026-08-29
> **Module:** entity-audit
> **Reason:** These items are intentionally deferred from the initial build. Each has a specific blocker or decision that must be resolved first.

---

## 1. Model-Diff (The "ask N models" check) — ✅ BUILT 2026-08-30 (Wave 3)

### Status
**Implemented.** `POST /entities/:entityId/model-diff/run` now executes for real:

1. Builds the surface list from configured keys: `ANTHROPIC_API_KEY` → Claude
   (via `AnthropicSurfaceAdapter`), `PERPLEXITY_API_KEY` → Perplexity (via
   `PerplexitySurfaceAdapter`, both reused from the measurement module).
2. Asks every keyed surface "What is {entity}?" (custom prompt optional), storing
   one `ModelDiff` row per provider (rawAnswer, citations JSON, costUsd, latencyMs).
3. Runs the **Claude judge** across ≥2 successful answers — a 2–3 sentence verdict
   starting `Aligned:` or `Divergent:` — stored on the anchor row's `divergence`.
4. Surfaces without a key are reported as skipped; the judge gracefully reports
   `judge-unavailable` / `judge-failed` instead of guessing.

### Honest guard (verified e2e)
Without any keys the endpoint returns **503**:
`No surface API keys configured — set ANTHROPIC_API_KEY and/or PERPLEXITY_API_KEY (see LEFT-OUT.md section 1)`.
`GET .../model-diffs` lists persisted history (works today, verified 200).

### Still gated on keys (live behavior)
The e2e verification covered the guard + list paths. Full live-path verification
(an actual judged divergence verdict) needs `ANTHROPIC_API_KEY`/`PERPLEXITY_API_KEY`
in the environment — the code path follows the same adapters proven by the
measurement module's live mode.

### What remains left out from the original spec
- OpenAI/Gemini adapters (measurement chose Claude + Perplexity for v1; the
  adapter interface makes adding more surfaces a `SurfaceAdapter` implementation).
- Ollama local backing model (not wired — the mock surface covers dev).

---

## 2. Platform Consistency Checker (LinkedIn, G2, Crunchbase)

### What it does
Checks how third-party platforms describe the client entity — detects name/descriptor mismatches across LinkedIn, G2, Crunchbase, etc.

### Why it's left out
- **Scraping ToS risk** — LinkedIn and Crunchbase actively restrict scraping; G2 has anti-bot measures
- **No decision made on data source** — spec §3.3 lists three options, none decided:
  1. Manual data entry (delivery lead pastes current name/descriptor per platform)
  2. Semi-automated (user pastes a URL, tool does a one-time fetch — lower risk than crawling)
  3. Official APIs where available (Crunchbase has a paid API; LinkedIn/G2 largely don't)
- **Spec says build last** within Phase 2, after the above is decided

### What's needed to build it
1. Decide data source approach (manual / semi-auto / paid API)
2. If semi-auto: `fetcher.fetch()` + `fetcher.verifyUrl()` are ready for single-page fetches
3. If paid API: acquire Crunchbase API key, build adapter
4. If manual: build frontend form for delivery lead to enter platform records

### What's already built (ready for when this is added)
- `PlatformRecord` is in the Prisma schema (manual/semi-auto entry supported)
- `POST /api/projects/:id/entity-audit/entities/:eid/platform-record` endpoint exists for manual entry
- `fetcher.fetch()` and `fetcher.verifyUrl()` are ready for semi-automated single-page checks
- The `PlatformConsistency` type is in `entity-audit.types.ts`

### Where it plugs in
Platform records are created via:
```
POST /api/projects/:id/entity-audit/entities/:eid/platform-record
```
Manual entry works now. Auto-scraping is added when the data source decision is made.

---

## 3. LLM-Judge Divergence Scoring — ✅ BUILT 2026-08-30 (with model-diff)

### Status
**Implemented** as `judgeDivergence()` inside the model-diff run: with ≥2
successful answers the anchor row's producer sends the anonymized answer set to
Claude with a system prompt that forces a 2–3 sentence verdict starting
`Aligned:` / `Divergent:`. With <2 answers the judge is skipped (null); API
failures become explicit `judge-unavailable` / `judge-failed` strings — never a
fabricated verdict. Live validation waits on API keys, same as #1.

---

## Summary — Build Order When Resuming These

```
1. Acquire AI API keys (OpenAI + Anthropic minimum)
2. Build AI adapters in fetcher/adapters/ (openai.adapter.ts, anthropic.adapter.ts)
3. Implement model-diff pipeline (send prompt → store answers → run LLM-judge → score divergence)
4. Decide platform data source (manual recommended for v1)
5. Build platform consistency checker (manual entry → semi-auto later)
6. Design and implement LLM-judge prompt + divergence scoring
```

All infrastructure is ready — fetcher, database, scheduling, cost tracking. Only the API keys and the adapter implementations are missing.