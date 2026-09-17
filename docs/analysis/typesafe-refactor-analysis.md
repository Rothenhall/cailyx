# TypeSafe Refactor Analysis — Fragile Semantic Logic in Cailyx

**Date:** 2026-09-17
**Status:** Proposal — no code changed. Per AGENTS.md, nothing here may be built (and no
`typesafe-sdk` dependency installed) until the user approves the tool choice and per-module
analysis docs are written.
**Scope:** Cross-cutting audit of `backend/src/` and `web/src/` for logic that fakes
"common sense" with substring matching, regex chains, word-count thresholds, and
prompt-and-parse LLM calls — mapped to TypeSafe's [cookbooks](https://docs.typesafe.ai/llms.txt)
and [patterns](https://docs.typesafe.ai/patterns.md).

All line numbers below were read from source at commit `b459005` + working tree.

---

## 1. The pattern we're refactoring against

Cailyx already has one disciplined LLM trust boundary —
`backend/src/common/llm/llm.service.ts` (`json()` → parse → caller validator) — but on
both sides of it, the app repeatedly re-invents five semantic judgments in brittle
deterministic or prompt-and-parse form:

| # | Judgment faked | Reinvented at (minimum) |
|---|---|---|
| a | "Is this brand/entity mentioned or cited here?" | `common/utils/subject-match.ts:44–92`, `measurement.service.ts:442–468`, `mention-tracking.service.ts:167–188`, `intake.service.ts`, `serp-analyzer` |
| b | "Are these two names/domains/URLs the same thing?" | 4 name matchers (`entity-audit.consistency.ts:20–122`, `presence.serp.service.ts:241–256`, intake, business-profile) + 2 divergent domain normalizers (`intake.service.ts:331–333` vs `business-profile/lib/domain.util.ts`) |
| c | "What kind of thing is this?" (category, platform, failure kind, source type) | `presence.types.ts:231–243`, `gap-analysis.service.ts:150–161`, `authority.discovery.ts:33–45`, `aeo-audit.service.ts:1278–1293`, `intake.service.ts:51–90` |
| d | "Is this LLM output valid/complete/on-policy?" | `content.service.ts:832–844` (length/word-count gates), `claims.service.ts:203–212` (banned-phrase `indexOf`), ~20 `catch → null/{}` sites that conflate malformed-with-absent |
| e | "How severe/important/relevant is this?" | `council.engine.ts:22–88,149–170` (bias tables), `seo-rubric.ts` deduction weights, `authority.discovery.ts:47–54` (+0.2/+0.15 magic increments), `monitoring.service.ts:28–31` thresholds |

TypeSafe's System One primitives (`Choice`, `Noul`, `Score`) return typed answers with
calibrated probabilities and confidence — which is exactly the shape these five judgment
classes need, and exactly what `LlmService.json()` currently has to approximate with
prompt text plus defensive parsing.

**Design rule taken from the skill/docs:** keep the deterministic substring versions as
*fast paths*, ask TypeSafe only when the fast path is ambiguous, and keep exact rules,
calculations, and execution in code. This aligns with the codebase's own
"counted vs judged" provenance discipline (`aeo-audit`).

---

## 2. Hotspot → cookbook map (ordered by leverage)

### H1. Brand mention / citation / competitor detection — the moat metric is `includes()`

**Code:** `backend/src/common/utils/subject-match.ts:44–92` (docblock: "string/host
matching only, no LLM, fully reproducible") and its near-verbatim twin
`backend/src/modules/measurement/measurement.service.ts:442–468`. Verified fragilities:

- Mention: `textLower.includes(nameLower)` — no word boundary on the primary path;
  fallback tests only the single longest ≥4-char token, so multi-word brands match the
  wrong entity.
- Citation: `hostOf(url).endsWith(subjectHost)` — `evilnotexample.com` ends with
  `example.com` and counts as a citation of the client.
- Competitors: bare `includes()` with no boundary guard at all — "Air" matches "repair".
- Mention ≠ endorsement: a "…but avoid BrandX" mention scores as presence.
- Every downstream rate (mention rate, citation rate, SOV) inherits these errors, and
  two copies must not drift.

**Cookbooks:**

- **[Knowledge graph entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md)** —
  the canonical "are these two things the same entity?" pattern. Its shape maps 1:1:
  one `Score` with three levels that *are* the three actions (different /
  needs-a-human / same), plus per-field `Noul`s riding in the same request. For
  subject-match: candidates are the detected spans; questions are "same company as
  subject?", "same registrable domain as the citation host?"; the middle level routes to
  a per-project review queue instead of silently polluting metrics.
- **[Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md)** —
  the `find`+`pick` pair: keep the cheap regex as the recall-tuned candidate finder
  (it's good at finding *possible* mentions), then a `Choice` whose options are the
  found spans (verbatim, cannot hallucinate) decides which are genuinely the subject /
  each competitor, with a `none` escape hatch.
- **Pattern: [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md)** —
  whole-name exact match stays a fast path (no call needed); only boundary-ambiguous,
  multi-word, or negation-flavored hits get judged. Bounds cost on high-volume
  measurement runs.

**Also worth stealing:** a `Noul` "is this a mention that endorses or at least presents
the brand?" turns the mention metric into *quality-of-presence*, which is closer to what
AEO reporting claims.

---

### H2. AEO stance judge — magic-string coercion silently outputs the worst verdict

**Code:** `backend/src/modules/aeo-audit/aeo-stance.service.ts:248–298` — a large
interleaved prompt (stance definitions, 7 output fields, quoting rules) parsed through
`LlmService.json()`; `asStance` (agent-verified at :385–387) coerces any unrecognized
string to `'absent'` — the *worst possible* verdict — and `parseArray` swallows JSON
errors to `[]`. `otherNamesSeen` flows unfiltered into the competitor candidate queue.

**Cookbooks:**

- **[Classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)** —
  stance is a `Choice` over the 5 defined labels (criteria text already written — it
  lifts out of the prompt nearly verbatim). The cookbook's core lesson applies exactly:
  a forced label looks identical for easy and hard cases; `confidence` separates them.
  Replace "coerce to absent" with "low confidence → hold for review / report one level
  up (mentioned vs absent)".
- **[SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md)** — the stance
  record is structured extraction from (question, answer, subject) — precisely the
  cascade's problem. Today: one expensive model call whose output is trusted with
  length checks. Cascade shape: cheap model extracts, per-field `Noul`s
  ("is `evidenceQuote` absent from the answer text?", "is `rankAmongBrands` inconsistent
  with `brandsNamed` order?") verify at ~$0.042/1M input tokens, and only fired fields
  escalate. The current prompt already demands verbatim quotes because it can't verify
  them — the verify rung lets you stop asking and start checking.
- `evidenceQuote` itself → **pre-parsed value extraction**: hand the judge candidate
  spans, let `Choice` pick one; verbatim-ness becomes structural, not prompted.

---

### H3. `inferBusinessProfile` and every "what kind of thing is this" chain

**Code (verified):** `backend/src/modules/digital-presence/presence.types.ts:231–243` —
ordered first-match-wins regex buckets ("local software company" → `b2b-saas`, silent
`default`); its own docblock admits "never a claim". Same shape in
`gap-analysis.service.ts:150–161` (bidirectional `includes()` against ~60 hand-ranked
rules — table order silently decides the class), `authority.discovery.ts:33–45` (four
hint-substring lists, catch-all `'publication'`; LLM fallback stamps every candidate a
flat `relevance: 0.6`), `intake.service.ts:51–90` (`deriveCategory` word-count windows —
and that string seeds *paid* DataForSEO queries), `aeo-audit.service.ts:1278–1293`
(`classifyFailure` by provider error-string `includes`).

**Cookbooks:**

- **[Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md)** —
  where label sets are large or grouped (gap-analysis dimensions × actions, authority
  source types, platform signatures), traverse a taxonomy with parallel beam search
  instead of a flat Choice. Bonus per the cookbook: observability — you learn *which
  node* misclassifies, impossible with a 60-entry `includes()` table.
- **[Classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)** —
  the flat case (`inferBusinessProfile`: 4 profiles + explicit "not identified"): one
  `Choice`, and the low-confidence branch reports the broad label or flags the
  assessment — the code already prints the applied profile "so a wrong guess is visible
  and arguable"; confidence makes that visibility principled.
- **[Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md)** — for
  `classifyFailure`-style dispatch: error text → which typed handler, as a closed-set
  `Choice` with an explicit `unknown` option instead of provider-wording `includes()`.

Note: `inferBusinessProfile` runs once per onboarding — negligible cost; this is the
"pure complexity reduction" end of the portfolio (also deletes the synonym lists).

---

### H4. LLM-output validators are length checks; banned-phrase compliance is `indexOf`

**Code:** `content.service.ts:832–844` (`title.length < 5`, `bodyMarkdown` word count
`< 150` = "real article"; uncaught `JSON.parse` of stored brief columns at :543,707,709
while sibling parsers swallow to `{}` — a corrupt `mustInclude` silently drops mandated
constraints); `growth-execution.service.ts:438–453` (ad char limits exist *only* as
prompt prose, never validated); `findings.service.ts:207–233` (six strings ≥5 chars =
valid copy); `claims.service.ts:203–212` (`BANNED_PHRASES` exact substring — the prompt
demands synonym avoidance and unhyphenated "world class" slips through);
`audit-narrative.service.ts:103–159` (narrative sections trusted by shape, previous
narrative fed back as unverified prose); `council.service.ts` `parseDebate` silently
falls back to the deterministic engine — users can't tell which produced an answer.

**Cookbooks:**

- **[Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md)** —
  screens *outputs* as well as inputs with one request: a battery of `Noul`s
  ("does this reply contain a banned claim type?", "does it actually include all
  mandated topics?") + a severity `Score`, thresholded in code to
  pass/review/block. This replaces both the `indexOf` phrase list (which can't catch
  paraphrase — its own prompt admits synonyms will occur) and the word-count "quality"
  gates, with a per-claim judgment that is itself typed data.
- **[SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md)** for the
  generate→verify→escalate loop on content/copy/findings, including the
  char-limit validation that currently doesn't happen at all.
- **[Citation check](https://docs.typesafe.ai/cookbooks/citation_check.md)** where
  generated content carries claims sourced from findings (audit narratives quoting
  scores — "numbers aren't hallucinated" is currently unverified faith).

---

### H5. Council "consensus" and every magic-number severity table

**Code:** `council.engine.ts:22–88` (ROLE_BIAS if/else voting), :149–170
(`expectedImpact = effortImpact[dimension] + evidenceBreadth*6`, `confidence =
cons >= 0.66 …` — arithmetic dressed as reasoning); `seo-rubric.ts:25–80` (100 − hand
deductions); `gap-analysis.service.ts` impact/effort 1–5 hardcoded per rule + rating
cliffs (3.5/4.5/20 reviews) + `computeQuadrant` (impact≥3, effort≤2);
`monitoring.service.ts:28–31,140–178` regression thresholds (≥10/≥20 pts, 0.15/0.3).

**Patterns (not cookbooks, but the skill's designated pages):**

- **[Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md)** —
  replace the lookup tables with atomic `Score` questions per candidate
  ("how much AI-visibility impact would fixing this have?" with ordered descriptive
  levels), then let *code* keep owning weights, thresholds, and quadrant math. The
  cookbook's point maps directly: changing a weight or re-sorting a report must not
  re-run inference; raw judgments stay reusable across gap-analysis, council, and
  reports from one batch call.
- **[Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md)** —
  council's `cons` value becomes a real inter-judge statistic instead of a bias-table
  artifact; disagreement routes to the LLM debate path explicitly (and the
  deterministic-fallback silence in `parseDebate` becomes a visible provenance bit, not
  a hidden mode switch).
- **[Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)** —
  the economic keystone for all of H1–H5 on high-volume data: one request, N questions
  over the same state, measured 12.2× cheaper / 10× faster with identical answers. A
  single measurement answer judged for mention+citation+endorsement+stance+competitor-
  presence is exactly the GDPR-style document-dominated batch.

---

### H6. Prose round-tripped through regexes (mostly frontend + cross-module protocols)

**Code:** backend appends structured events into `WorkItem.description` prose
(`delivery-plan.service.ts:568–575,823–828`) and the frontend reimplements the format
*twice, in two dialects* (`web/src/services/portal-plan.ts:188–219` vs
`web/src/app/(ops)/.../work/[workId]/page.tsx:1022–1032`); `gap-analysis.service.ts:562–563`
decides a risk exists by `divergence.startsWith('divergent')` on free-text LLM prose
produced two files away (`entity-audit.service.ts:632–657`); provenance by
`source.startsWith('serp'|'llm'|'citation')` duplicated in
`web/src/services/authority.ts:367–380` + opportunities page; onboarding blockers
classified as "access requests" by `/access|connect|google|…/` against a human-readable
title (`connections/page.tsx:261–263`); `parseCompetitorEntry` regex-recovers
`{name,domain}` from "Name (domain)" *display text* (`business-info/page.tsx:428–432`);
destructive-offboarding intent check is exact string equality
(`offboarding.service.ts:257–261`).

**Assessment — an honest boundary:** most of H6 is *not* a TypeSafe problem; it's a data
modeling problem. Structured events stored as structured JSON remove the need for any
judge; the fix is a schema, not a model. TypeSafe applies only at the edges where text
genuinely enters:

- **[Structure recovery (autoformat)](https://docs.typesafe.ai/cookbooks/autoformat.md)** —
  where legacy prose must be parsed (existing `description` activity logs): classify
  every block with companion questions read only when relevant — this is the
  migration story for the evidence-log regexes without a data backfill.
- **`Choice`/`Noul`** for the few true intent checks: "does this confirmation express
  intent to delete the client's data?" (offboarding) and "is this blocker an access
  request requiring a human?" — one `Choice` at creation time on the backend, replacing
  the client-side regex zoo.
- **[Line-by-line semantic find](https://docs.typesafe.ai/cookbooks/semantic_find.md)** —
  where code must locate the relevant span inside stored prose (scores one request
  against many line ids, with a presence `Noul` that admits "no answer here").

---

### H7. URL/platform/entity identity (supporting cast)

**Code:** `presence.signatures.ts:61–229` host+path regexes decide "real account? which
platform? company or person?"; `fetcher.service.ts:244–249` `identityMatch =
title.includes(expectedName)` is the ground truth that entity-audit and presence pass/fail
verdicts build on; `presence.serp.service.ts:241–256` similarity ratio cliffs
(0.6/0.45/0.4/0.35) drive a query-stopping branch; `tech-stack.signatures.ts` ~72
fingerprints with hardcoded `confidence: 1`.

**Cookbook:** **[entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md)**
(merge/curator/different as Score levels — a direct replacement for the 4 parallel
name-matchers and the similarity cliffs) and
**[reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)** where candidates
must be *ordered by relevance* to a query (authority prospects, internal-link topic
relatedness currently computed as 8-keyword Jaccard where "plumbing" vs "plumber" = 0) —
BM25/Jaccard stays as the cheap shortlister; TypeSafe promotes from the shortlist
(top-1 5%→18%, top-10 38%→62% in the legal-queries case study).

---

## 3. What stays in code (do not refactor)

TypeSafe replaces the judgment, not the system. Explicitly out of scope:

- Exact calculations, thresholds applied *after* typed judgments, dedupe by exact key,
  domain/URL syntactic normalization (the *merge of two divergent normalizers* is a
  plain code task worth doing regardless), regexes as *candidate finders* (the
  `find`/`pick` split keeps them, deliberately over-tuned for recall).
- Deterministic fast paths: exact whole-string host/name matches short-circuit before
  any call is made (confidence-gated routing).
- Reproducibility requirements: `subject-match.ts`'s "fully reproducible" property is a
  feature for audits. Mitigation: persist raw per-question probabilities with each
  verdict (the codebase's "counted vs judged" provenance pattern generalized), so a
  judged result is explainable and re-runnable, and re-scoring a stored answer never
  silently changes history.

## 4. Integration notes (for the eventual approved module)

- **SDK:** `typesafe-sdk` JS client ([docs](https://docs.typesafe.ai/sdk/javascript.md))
  or plain HTTP ([API ref](https://docs.typesafe.ai/api.md)); NestJS service wrapping it
  server-side only, mirroring the existing `LlmService` shape (it already centralizes
  model choice, cost recording, and validators). Requires a decision whether it joins
  `common/llm` or stands as its own module — per AGENTS.md rules 3/4, an approved
  `docs/analysis/typesafe-integration.md` must precede any install.
- **Env:** `TYPESAFE_API_KEY` in `backend/.env` + `.env.example` only; never in `web/`.
- **Cost model:** jev pricing cited in cookbooks is ~$0.042/1M input, $0 output —
  document-dominated batches are the cheap case; measurement runs at
  answers × projects scale still warrant the fast-path gate and per-module
  allow/budget flags (the `SWARM_ALLOW_LIVE` precedent fits).
- **Fallback:** where `LlmService` already falls back OpenRouter→Anthropic, TypeSafe
  judgments have no substring fallback that preserves meaning — failure modes should be
  explicit `unjudged` provenance states, not silent coercion (the H2 `'absent'` bug is
  the cautionary tale).

## 5. Recommended sequencing

1. **H2 stance judge** — highest credibility-per-effort: the metric pipeline's output is
   already LLM-generated (so cost exists today), the `asStance` → `'absent'` bug actively
   misreports clients, and the stance text lifts almost verbatim into `Choice` criteria.
2. **H1 subject-match mention/citation** — the moat metric; needs the entity-alignment +
   pre-parsed-extraction pair plus the probability-persistence design above. Biggest
   payoff, biggest validation effort (re-benchmark against existing counted data).
3. **H3 classification chains** (`inferBusinessProfile`, `deriveCategory`,
   `classifyFailure`, gap `classify`) — cheap calls, deletes the most dead-fragile code.
4. **H4 output validators/guardrails** — protects generated content quality with real
   checks instead of word counts.
5. **H5 composite scoring in council/gap** — only after 1–3, since the raw per-dimension
   judgments feed it.
6. **H6 prose round-trips** — fix with schema changes; TypeSafe only for the two or
   three true intent questions.

Each numbered step is a separate module-scoped change: analysis doc → user approval →
build → post-completion checklist, per AGENTS.md.

---

### Appendix: cookbook pages consulted

entity_alignment · pre_parsed_value_extraction_cookbook · sde_cascade ·
hierarchical_classification · classification_using_confidence · llm_guardrails ·
parallel_questions · citation_check · semantic_find · autoformat · function_calling ·
rerank_typesafe · date_extraction · skill_suggestion · patterns/composite-scoring ·
patterns/confidence-routing · patterns/fan-out · patterns/intent-routing
(all under https://docs.typesafe.ai/; fetched 2026-09-17).
