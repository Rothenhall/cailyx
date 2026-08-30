# Wave 4 — Analysis: page-analysis, mention-tracking, sleeper-refresh, data-asset

> **Date:** 2026-08-30 · **Status:** Approved-by-default (standing directive: complete the full PRD; user may veto any choice here)
> **Scope:** PLAN Phase 3 content & outreach tools — SOP-6 (page-analysis), SOP-7 (mention-tracking), SOP-10 (sleeper-refresh), SOP-8 (data-asset, P3)

No new vendor tools in this wave — every option below reuses already-installed dependencies
(cheerio, the Fetcher module, the Anthropic SDK, Prisma/SQLite). Dependency count stays at zero new installs.

---

## 1. `page-analysis` (SOP-6, closes FR-3.3)

Analyze a URL's copy structure for answer-engine extractability: BLUF (answer in
the first 40–60 words), question-shaped H2s, standalone-section test, extractable
claims ("number + noun + time + source"), format analysis (tables / numbered
steps / definitions), word-count note (0.04 citation correlation — reported as
context, never as a score driver).

**Option A — Deterministic rules only.** HTML fetch (FetcherModule) → cheerio DOM
→ regex/structure heuristics. Reproducible, free, no API key. The standalone test
("can this H2 section be read out of context?") is inherently fuzzy, so a pure
rules version is a heuristic, flagged as such.
**Option B — LLM-only (Claude reads the page text).** Better standalone/BLUF
judgment, but non-reproducible (3× determinism requirement), costs per page, and
gates the module on `ANTHROPIC_API_KEY`.
**Option C — Hybrid (chosen): deterministic default, optional LLM refinement.**
`POST /analyze` runs the deterministic pipeline always and persists it; a
`useLlm:true` request body flag adds a Claude-generated `llmNotes` (standalone
verdicts + BLUF rewrite suggestion) stored on the analysis row when
`ANTHROPIC_API_KEY` is set — 503 with honest messaging when the flag is on but no
key. Scores come only from the deterministic path, so score runs stay reproducible.

Scoring is disclosed, never renormalized: `structureScore = bluf (30) +
questionH2Share (25) + format (25) + extractableClaims (20)`, each subscore with
its evidence; word-count correlation is a note, not a subscore (PRD FR-8.4 spirit).

## 2. `mention-tracking` (SOP-7, closes FR-4.4)

Listicle finder ("best X" pages omitting the client), mention ledger with decay,
outreach target status flow, review-platform tracking.

**Option A — Automated listicle discovery (Perplexity "search the web" sweep).**
Self-serve discovery, but the Perplexity adapter is a measurement surface; using
it as a crawler conflates responsibilities and burns measurement budget.
**Option B — Manual entry with semi-auto verification (chosen).** Operator pastes
candidate URLs (`type: listicle | community | review | other`); a check endpoint
fetches the page once (FetcherModule — same low-ToS posture as entity-audit
semi-auto) and records `mentionsClient` + snapshot. Discovery stays manual in v1.
**Option C — Poll external backlink APIs (Ahrefs etc.)** — new paid dependency +
key management; explicitly out of scope per AGENTS.md no-unapproved-deps.

Decay: each check appends a `MentionCheck` row (timestamped); `latest` view
derives decay ("not seen in N days since first check") for stale mentions.
Outreach: `status` pipeline `new → contacted → replied → placed → rejected`
on each target.

## 3. `sleeper-refresh` (SOP-10)

Sleeper pages = declining traffic + intact backlinks → refresh candidates
(SOP-10: BLUF rewrite + dateModified bump). True ranking needs the **Google
Search Console API** (OAuth, query data, per-property grants) — a new
external integration with credential acquisition that is *not* installable here.

**Option A — GSC OAuth integration now.** Blocked: needs a Google Cloud project,
refresh tokens, per-project GSC property grants — cannot be provisioned in this
session; spec already flags it as an external prerequisite.
**Option B — Manual page list + tracked refreshes (chosen).** Operator records
pages (URL, optional `trafficDeclinePct`, `referringDomains`) or imports GSC CSV
exports (pasted text / structured rows) as the evidence; the module computes
sleeper status from those inputs and tracks the refresh lifecycle
(`flagged → brief-sent → in-progress → refreshed`→ `abandoned`) with
`dateModifiedBefore/After` so the SLA ("refresh actually shipped") is auditable.
**Option C — Defer wholesale.** Loses the CSV-import middle ground; B delivers
the SOP-10 workflow minus only the automated data pull.

## 4. `data-asset` (SOP-8, P3 — lowest priority)

Original-data assets ("named after the client brand" study), per SOP-8.

**Chosen:** minimal tracker — `DataAsset(id, projectId, title, brandAlignment
(brand-named|subject-matter), methodologyNote, surveySize?, status
`planned|fielding|published`, publishedAt?, assetUrl?)` with lifecycle transitions
and PRD-alignment guidance (why a data asset earns AI citations/links). No
external tooling; CRUD + transition endpoint only. It is P3; scope stays minimal
by design.

---

## Execution order (one module at a time, AGENTS.md gate per module)

1. `page-analysis` (closes FR-3.3; inputs feed scoring `On-page extractability`)
2. `mention-tracking` (FR-4.4; targets feed outreach in Wave 5 `delivery`)
3. `sleeper-refresh` (manual/CSV posture)
4. `data-asset` (P3, minimal)

Each: Prisma model(s) → service/controller/module → `tsc --noEmit` + build →
e2e on :3111 → README + docs/API.md + MODULES-STATUS.md → wipe e2e rows.