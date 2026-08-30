Rothenhall · Product Requirements
AI Visibility Diagnostic · v0.1 draft

Context
Summary
1. Why now
2. The workflow we ran
3. Vision & principles
4. Users
5. Domain model
The engine
6. Pipeline overview
6.1 Intake
6.2 Access probe
6.3 On-page & schema
6.4 Entity resolution
6.5 Query-set gen
6.6 Measurement
6.7 Share of voice
6.8 Scoring
6.9 Findings
6.10 Report
6.11 Delivery & CRM
6.12 Monitoring
Standards
7. Measurement standard
8. Scoring model
Build
9. Architecture
10. Data model
11. Integrations
12. Non-functional
Business
13. Ladder & pricing
14. Success metrics
15. Risks
16. Build sequence
17. Open questions

Product Requirements Document

# The AI Visibility Diagnostic Engine

Automate what we just ran by hand for Napkin: take a company and its domain, measure how it appears to the AI assistants where buyers now build their shortlist, score it, and return a branded, defensible report that opens a sale. Working name: Beacon.

Owner Kunal, Rothenhall Partners
Status Draft v0.1
Basis The Napkin manual run
Scope Full product, not a gated demo

## 00 Summary

Buyers increasingly form their shortlist inside an AI assistant before they touch a website or a search page. Ranking in Google no longer guarantees being recommended. Companies cannot see whether an assistant names them, mischaracterises them, or cannot read their site at all. There is no self-serve tool that measures this rigorously and returns a credible report.

We built exactly that report for Napkin by hand across one session: crawler-access probe, schema and rendering audit, entity-collision check, a nine-question buyer test across ChatGPT and Claude, a five-dimension score, three findings, and a branded web page and PDF. This PRD turns that repeatable manual process into a product that runs it automatically, at scale, and monetises it through the Rothenhall service ladder.

The product is not a lead-magnet gimmick with a locked report. Every check we ran manually becomes a first-class automated capability. The free tier is a genuine, complete public-footprint diagnostic. Depth, history, competitor tracking, and the full multi-run measurement are where paid tiers earn their price, because they cost real compute, not because we withhold the obvious.

## 01 Why now

- The overlap between a top-ten Google ranking and an AI citation has fallen from roughly 76% to somewhere in the 17 to 46% range depending on the study, and it is still falling. Ranking and being recommended are now two separate problems.

- Grounded assistants (ChatGPT search, Claude, Perplexity, Google AI Overviews and AI Mode, Gemini) build answers from live retrieval plus model weights. A company can be strong and still be invisible to all of them, as Napkin was.

- Almost nobody measures this properly. Single-run screenshots are the norm. Rigorous, repeated, distribution-based measurement against a defined query set is the differentiator, and it is hard enough that it is defensible.

- The manual diagnostic takes hours of expert time per prospect. Automation turns a bespoke service into a self-serve top of funnel that also feeds the paid ladder.

The wedge

The free automated diagnostic is a trigger generator. It does not guess that a prospect has a problem, it shows them, with at least one finding they could not have known without us. That is what converts a cold domain into a booked call.

## 02 The workflow we ran, step by step

This is the ground truth the engine automates. Every step below we performed manually for Napkin.

| 
| Step | What we did (manual) | Signal produced | Automates to

| Intake | Read the diagnostic form: company, website, email, phone, one-line description. | Target domain + category context. | `6.1`

| Access probe | Fetched robots.txt (404, none). Ran curl with a rotating set of AI user-agents (GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Google-Extended, Googlebot, browser). Recorded HTTP status per agent, twice, for determinism. | napkin.ie returns 403 to Perplexity, ChatGPT-User, ClaudeBot, GPTBot; 200 to browser, Googlebot, OAI-SearchBot. A silent CDN AI-bot block. | `6.2`

| On-page audit | Fetched the homepage with a browser UA. Measured server-rendered text volume (JS-render test). Grepped for JSON-LD, schema.org, Organization/Person schema. Pulled title, meta description, headings, positioning copy. | Server-rendered (good). Zero structured data. Unsourced 94/6 stat. Full positioning captured. | `6.3`

| Entity check | Web search for the brand. Compared what the web and the assistants associate with the name. | Name collides with napkin.ai, a US visual-AI tool with far larger footprint. Napkin.ie is entity-ambiguous. | `6.4`

| Query-set build | Wrote nine buyer questions across the funnel, in natural language, for the company's category. | A defined, versioned query set. | `6.5`

| Measurement | Ran the questions through ChatGPT (one observed run). Verified Claude's crawler is blocked. Recorded who was recommended and whether Napkin appeared. | Napkin named in 0 of 9. 15+ rivals named. Claude cannot read the site at all. | `6.6`

| Share of voice | Extracted the competitor set the assistant named and ranked prominence. | Braind, Howl, Digital One, Deloitte, PwC, Agentica, plus a long tail. | `6.7`

| Listicle check | Searched category listicles ("best AI agency Ireland"). Checked presence. | Competitors present, Napkin absent. Off-site corpus gap. | `6.4 / 6.7`

| Scoring | Applied a five-dimension rubric with weights. | 43 / 100, band "Faint". | `6.8`

| Findings | Synthesised three named problems, each with what / why / fix and honest caveats, under claims discipline (ranges, sources, no guarantees). | Three findings, one non-obvious. | `6.9`

| Report | Generated a Rothenhall-branded executive one-pager, interactive web version and a print PDF, with charts. | Shareable deliverable. | `6.10`

| Delivery | Hosted at rothenhall.com/reports/napkin. Drafted the delivery email with a call CTA and a review ask. | Lead captured, call offered. | `6.11`

The honesty constraint carries into the product

We refused to present an unmeasured Claude rate as if measured. The product must encode the same discipline: never report a single run as a distribution, always attach source and caveat, never claim a rank, never promise placement. This is a hard product guardrail, not copy. See Section 7.

## 03 Vision and product principles

One company, one domain, one honest answer to: *when a buyer asks an AI about firms like you, what happens, and why.*

- No artificial gating. The free diagnostic is complete for what it claims to be: a public-footprint read. Paid tiers add depth that genuinely costs more to produce (repeated multi-surface runs, history, competitor tracking, monitoring), not access to findings we are hiding.

- Measurement integrity is the moat. Distributions, not positions. Multi-run, multi-geo. Every number sourced and caveated. If we cannot measure it, we do not claim it.

- Show, do not guess. Every report must contain at least one specific, verifiable finding the owner could not have known without the tool.

- Reproducible. Every technical claim ships with the method to reproduce it. Trust is the product.

- Branded and embeddable. Reports are first-class web pages and PDFs, brandable for Rothenhall and, later, for white-label partners.

- Ladder-native. Every diagnostic ends in a next step: book a call, upgrade to the paid diagnostic, start monitoring.

## 04 Users and personas

#### The prospect

A founder or marketing lead who submits a domain and wants to know why AI does not recommend them. Wants a clear, non-technical answer and a fix path.

#### The operator

Rothenhall delivery and sales. Runs diagnostics in bulk for outbound, reviews findings before send, converts to paid work.

#### The admin

Configures scoring weights, query-set templates, surfaces, branding, pricing, and claims-discipline rules. Owns methodology.

A later persona is the white-label partner: an agency that runs the engine under its own brand. Architecture should not preclude multi-tenant branding.

## 05 Core concepts (domain model)

| 
| Concept | Definition

| Subject | The company being diagnosed: canonical name, domain, category, description, known competitors, entities (sub-brands, products, founders).

| Diagnostic run | One execution of the pipeline against a Subject at a point in time. Immutable once complete. Versioned.

| Query set | A versioned, date-stamped list of buyer prompts, tagged by persona and funnel stage, with the Subject's brand and named competitors embedded.

| Surface | An AI answer engine: ChatGPT, Claude, Perplexity, Google AI Overviews, Google AI Mode, Gemini, Copilot.

| Observation | One recorded result for one prompt, one surface, one run: mentioned, cited, position, characterization, competitors present, metadata (geo, timestamp, run index).

| Finding | A synthesised problem with dimension, severity, evidence, business impact, fix path, and a claims-discipline grade.

| Score | A weighted roll-up across dimensions into a 0 to 100 value and a band.

| Report | A rendered artifact (web + PDF) built from a run. Brandable, shareable, versioned.

## 06 The pipeline

A Diagnostic run is a queue-driven pipeline of independent stages. Stages write Observations and artifacts to the run; a failed stage degrades the score gracefully rather than failing the whole run.

6.1IntakeDomain + context in.
6.2Access probeWho can read the site.
6.3On-pageSchema, render, copy.
6.4EntityWho the models think you are.
6.5Query setBuyer prompts.
6.6MeasureRun across surfaces.
6.7Share of voiceCompetitor graph.
6.8ScoreWeighted roll-up.
6.9FindingsSynthesise problems.
6.10ReportWeb + PDF.
6.11DeliverEmail, CRM, CTA.

### 6.1 Intake

Accept a Subject via a public form, an authenticated operator console, a bulk CSV, or an API. Minimum input is a domain. Enrich automatically: fetch homepage, infer category and description, detect country, discover named competitors and the Subject's own entities (products, founders) from the site and search.

| 
| ID | Requirement | Priority

| FR-1.1 | Public form accepts domain, name, email, and optional description; validates and normalises the domain. | P0

| FR-1.2 | Auto-enrichment infers category, country, and a canonical one-line descriptor from the homepage and search. | P0

| FR-1.3 | Competitor discovery proposes 3 to 8 named competitors for the query set; operator can edit. | P1

| FR-1.4 | Bulk intake via CSV and a REST API for outbound campaigns. | P1

| FR-1.5 | Rate limiting and abuse protection on the public form (one free run per domain per window). | P0

### 6.2 Crawler access probe

The highest-value, most reproducible check. Determine, per AI crawler, whether the site serves or refuses it, at both the robots.txt and network (CDN/WAF) layers.

| 
| ID | Requirement | Priority

| FR-2.1 | Fetch and parse robots.txt; record directives for every known AI user-agent; flag a missing (404) robots.txt. | P0

| FR-2.2 | Send live requests using the real UA string of each AI crawler (GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, ClaudeBot, Claude-User, Claude-SearchBot, Google-Extended, Googlebot, plus a control browser). Record HTTP status and latency. | P0

| FR-2.3 | Repeat each probe N times (default 3) to distinguish a deterministic block from a rate-based one. Report the stable result and note flapping. | P0

| FR-2.4 | Detect the CDN/WAF (Cloudflare, Akamai, Fastly) and, where possible, identify a managed AI-bot rule as the likely cause. | P1

| FR-2.5 | Distinguish training bots from search/citation bots in the report, since the business impact differs. | P1

| FR-2.6 | Emit the exact reproduction commands into the report appendix. | P1

Fidelity note
UA spoofing proves a UA-triggered block. Some WAFs also gate on verified bot IP ranges. Probes should run from clean egress IPs and, ideally, more than one geography; where a block is IP-verified we cannot fully reproduce it and must say so.

### 6.3 On-page and schema audit

| 
| ID | Requirement | Priority

| FR-3.1 | Render test: fetch with JS disabled vs enabled (headless), compare visible text volume, flag client-only rendering that AI crawlers without JS cannot read. | P0

| FR-3.2 | Structured-data audit: detect JSON-LD, Organization and Person schema, sameAs completeness; flag absence. | P0

| FR-3.3 | Extractability scoring: heading structure, answer-first patterns, presence of tables/lists/definitions, entity density, unsourced numeric claims. | P1

| FR-3.4 | Core Web Vitals and index-health signals (LCP, INP, CLS, canonical, soft 404s, AI-referred 404s). | P2

| FR-3.5 | Capture title, meta, and positioning copy for downstream entity and findings stages. | P0

### 6.4 Entity resolution

Answer "who do the models think this company is?" and detect collisions like napkin.ie vs napkin.ai.

| 
| ID | Requirement | Priority

| FR-4.1 | Ask each surface "what is [entity]?" for the brand and each sub-entity; diff the answers; detect when the dominant answer is a different company. | P0

| FR-4.2 | Collision detection: compare returned descriptor, domain, and category against the Subject; score entity clarity. | P0

| FR-4.3 | Cross-platform consistency of the one-line descriptor across own site, LinkedIn, Crunchbase, directories; Wikidata/Wikipedia eligibility check. | P1

| FR-4.4 | Off-site presence: category listicles and "best X" pages that name competitors but not the Subject. | P1

### 6.5 Query-set generation

| 
| ID | Requirement | Priority

| FR-5.1 | Generate 100 to 300 prompts (free tier uses a smaller representative set) tagged by persona and funnel stage: problem-aware, solution-aware, product-aware, most-aware. | P0

| FR-5.2 | Write prompts in natural buyer language, not keywords; embed the Subject's brand in the most-aware cluster and named competitors in the product-aware cluster. | P0

| FR-5.3 | Version and date-stamp every set; never edit in place; the Subject owns and can export it. | P0

| FR-5.4 | Seed from real sources where available (the Subject's own sales questions, support tickets) in paid tiers. | P2

### 6.6 Measurement engine

The core and the hardest part. For each prompt, each enabled surface, run the query and record a structured Observation. This is where the moat lives and where the engineering risk concentrates.

| 
| ID | Requirement | Priority

| FR-6.1 | Run each prompt N times per surface (default 5, free tier 1 to 2, clearly labelled) in fresh, unpersonalised contexts. | P0

| FR-6.2 | Support at least two geographies per run where the Subject sells cross-border. | P1

| FR-6.3 | Per Observation record: mentioned (bool), cited-with-link (bool), cited URL, position (first/middle/buried), characterization (accurate-positive/neutral/inaccurate/negative), competitors present (list), run metadata (surface, geo, timestamp, run index). | P0

| FR-6.4 | Parse the assistant's answer into the above via a structured extraction model with a fixed schema; store the raw answer for audit. | P0

| FR-6.5 | Surface adapters abstract each engine behind one interface (see the adapter table below). | P0

| FR-6.6 | Flag any inaccurate or negative characterization immediately as a high-priority finding. | P1

#### Surface adapters

| 
| Surface | Preferred method | Fidelity / caveat

| Claude | Anthropic API with the web-search tool. | High. Grounded answers with citations. Closest first-party path.

| Perplexity | Perplexity API (sonar models). | High. Returns answer + citations directly.

| ChatGPT | OpenAI API (web-search tool) as a proxy; headless ChatGPT for exact-surface fidelity. | Medium. API answer approximates but is not identical to the consumer surface. Label which was used.

| Google AI Overviews / AI Mode | SERP data provider that returns the AIO block; or headless. | Medium. Provider coverage and freshness vary.

| Gemini | Gemini API with grounding. | Medium to high.

| Copilot | Headless automation or defer. | Low. No clean API. Optional.

The central risk, stated plainly
Some consumer surfaces have no API that returns exactly what a user sees. Options are: (a) official APIs with grounding as a faithful proxy, labelled as such; (b) licensed SERP/answer-data providers; (c) headless-browser automation, which is fragile and may violate provider terms. The product decision is to default to APIs and data providers, treat headless as an opt-in higher-fidelity mode, and always record and disclose the method per Observation. Never present a proxy as the consumer surface.

### 6.7 Share of voice and competitor graph

| 
| ID | Requirement | Priority

| FR-7.1 | Aggregate competitor mentions across all Observations into a ranked share-of-voice per surface and overall. | P0

| FR-7.2 | Compute the Subject's mention rate and citation rate by cluster and surface, with confidence reflecting run count. | P0

| FR-7.3 | Track the competitor set over time so a Subject can see rivals gaining or losing share (monitoring tier). | P1

### 6.8 Scoring engine

Deterministic, transparent, and reproducible. See Section 8 for the rubric. Scores must be explainable down to the contributing Observations.

| 
| ID | Requirement | Priority

| FR-8.1 | Compute a 0 to 100 score across weighted dimensions; expose sub-scores and the band. | P0

| FR-8.2 | Weights and thresholds are admin-configurable and versioned; a run records the rubric version it used. | P0

| FR-8.3 | Every sub-score links to its evidence; no black-box numbers. | P0

| FR-8.4 | Degrade gracefully: if a stage failed, mark the dimension as partial rather than scoring it zero. | P1

### 6.9 Findings synthesis

| 
| ID | Requirement | Priority

| FR-9.1 | Classify each detected issue into a dimension (visibility, narrative, topic, format, web mentions, demand) and an action type (fix / build / influence). | P0

| FR-9.2 | Rank by severity and prominence; guarantee at least one non-obvious finding per report or flag the run as thin. | P0

| FR-9.3 | Generate plain-language what / why / fix copy from templates plus a constrained LLM pass, with an executive and a technical register. | P1

| FR-9.4 | Claims-discipline filter: every numeric claim carries a source and grade; banned phrasings ("rank #1", "guaranteed") are blocked at generation; single-run results are never phrased as rates. | P0

### 6.10 Report generator

| 
| ID | Requirement | Priority

| FR-10.1 | Render a branded, responsive web report at a stable URL (e.g. /reports/[slug]) plus a one-page print PDF, both theme-aware. | P0

| FR-10.2 | Charts: score dial, share-of-voice bars, the built-vs-visible gap, per-surface comparison. | P0

| FR-10.3 | Executive and detailed views; the executive one-pager is the default share. | P1

| FR-10.4 | Configurable branding (logo, palette, tagline) for Rothenhall and white-label partners. | P1

| FR-10.5 | noindex by default for client-specific reports; per-report visibility control. | P1

### 6.11 Delivery, CRM and monetization

| 
| ID | Requirement | Priority

| FR-11.1 | Send a delivery email (report link + PDF) from a configured sender; templated, editable before send in operator mode. | P0

| FR-11.2 | Capture the lead and run into a CRM/pipeline with status; log booking-CTA clicks. | P1

| FR-11.3 | Every report carries a next-step CTA (book a call) and an optional review/testimonial ask. | P1

| FR-11.4 | Upgrade path: from the free report, purchase the full multi-run diagnostic or start monitoring (Stripe). | P1

### 6.12 Monitoring and re-baseline

The recurring-revenue product. AI citation sets churn fast, so a single measurement decays within days. Monitoring re-runs on a schedule and tracks deltas.

| 
| ID | Requirement | Priority

| FR-12.1 | Schedule recurring runs (weekly/fortnightly/monthly) and store the time series. | P1

| FR-12.2 | Delta reporting: mention rate, share of voice, characterization, and crawler status vs baseline and last period. | P1

| FR-12.3 | Alerts on regressions: a new block, a new mischaracterization, a competitor overtaking. | P2

| FR-12.4 | A live dashboard the Subject can log into, owning their query set and history. | P2

## 07 The measurement standard

This is the product's defensible core and its ethical guardrail, lifted directly from the Rothenhall operating manual.

- No measurement without a defined query set. If we cannot name the prompts, we do not claim a result.

- N runs, multi-geo. Default five runs per prompt per surface, at least two geographies for cross-border sellers. Single-run data is noise.

- Distributions, never positions. "Appears in 60% of runs" is a measurement. "Ranks #1 in ChatGPT" is not a coherent statement and is blocked.

- Source and caveat on every number. Enforced by the claims-discipline filter at generation time.

- Disclose method and undercount. Every Observation records how it was gathered; referral figures always carry an undercount disclaimer.

Product implication
Free tier runs fewer repeats to control cost, so its numbers must be labelled as indicative, and the report must state that a locked rate requires the full multi-run pass. This is honest and it is also the upsell.

## 08 Scoring model

The default rubric, matching the Napkin report. Weights are configurable and versioned.

| 
| Dimension | Weight | Measures | Fed by

| Machine access | 25 | Can AI crawlers fetch the site (robots + CDN, per bot). | 6.2

| Entity clarity | 25 | Does a model resolve the right company; structured-data presence. | 6.3, 6.4

| Shortlist presence | 20 | Mention and share of voice on category queries and off-site lists. | 6.6, 6.7

| On-page extractability | 20 | Server rendering, chunk structure, extractable claims. | 6.3

| Authority signal | 10 | Real-world proof: founders, press, partners, reviews. | 6.3, 6.4

Bands: 0 to 40 invisible, 41 to 60 faint, 61 to 80 present, 81 to 100 recommended. Napkin scored 43. The score is a communication device; the Observations are the truth.

## 09 Architecture

- API + web app. The existing TanStack/React stack for the console and report rendering, deployed on Vercel; reports served as branded pages under the site.

- Job queue + workers. A durable queue orchestrates the pipeline. Each stage is an idempotent worker writing Observations to the run. Long-running measurement fans out per prompt/surface with concurrency caps and retries.

- Probe service. Server-side HTTP client with UA rotation and clean, ideally multi-geo, egress for FR-2. A headless-browser pool (Playwright) for render tests and optional high-fidelity surface capture.

- LLM orchestration. Adapters for Anthropic, OpenAI, Perplexity, Gemini, and SERP providers behind one Surface interface; structured extraction with a fixed schema; full raw-response storage for audit.

- Datastore. Postgres for Subjects, runs, query sets, Observations, findings, scores; object storage for raw answers and rendered PDFs.

- Report renderer. A templated renderer producing the web report and, via headless Chrome, the print PDF.

- Billing + CRM. Stripe for upgrades and subscriptions; a lightweight pipeline store or an external CRM integration.

- Cost governor. Per-run token/credit budgeting and a hard ceiling, since a full 300-prompt, 5-run, multi-surface run is thousands of model calls.

## 10 Data model (core tables)

| 
| Table | Key fields

| `subject` | id, canonical_name, domain, country, category, descriptor, competitors[], entities[]

| `query_set` | id, subject_id, version, created_at, prompts[] (text, persona, stage, cluster)

| `run` | id, subject_id, query_set_version, rubric_version, tier, status, started_at, finished_at

| `observation` | id, run_id, prompt_id, surface, geo, run_index, mentioned, cited, cited_url, position, characterization, competitors[], method, raw_ref

| `access_probe` | id, run_id, agent, layer, status_code, blocked, attempts, cdn

| `finding` | id, run_id, dimension, action_type, severity, title, evidence_ref, impact, fix, claim_grade

| `score` | id, run_id, dimension, sub_score, weight, total, band

| `report` | id, run_id, slug, brand, visibility, web_url, pdf_ref, version

| `lead` | id, subject_id, email, source, status, cta_events[]

## 11 Integrations

- Model APIs: Anthropic, OpenAI, Perplexity, Google Gemini.

- Search / SERP / AI-answer data: a provider for Google AI Overviews and organic listicle checks.

- Headless browser: Playwright pool for render tests and optional surface capture.

- Email: a transactional sender (Postmark/Resend) with the configured from-address.

- Billing: Stripe for one-off upgrades and monitoring subscriptions.

- CRM: internal pipeline or HubSpot/Attio sync.

- Analytics + WAF/CDN detection libraries for the probe stage.

## 12 Non-functional requirements

| 
| Area | Requirement

| Accuracy | No false positives in findings. A wrong claim kills trust and the ladder. Findings gate on evidence.

| Reproducibility | Every technical finding ships with a reproduction method; raw answers retained for audit.

| Latency | Free public-footprint run returns in minutes. Full multi-run diagnostic is async with progress and email-on-complete.

| Cost | Per-run budget enforced; free tier bounded; full-run cost modelled and priced above it.

| Determinism handling | Non-determinism is the default; never report a single run as a rate; store all runs.

| Compliance | Respect provider terms; prefer APIs; document any headless use; GDPR-aware handling of captured business data.

| Observability | Every stage and model call logged with cost and timing; runs are debuggable end to end.

## 13 Product ladder and pricing

Free
#### Public-footprint diagnostic

Access probe, on-page and schema audit, entity check, a representative query set at low run count, score and three findings, branded report. Complete for what it claims. The trigger generator.

Paid
#### Full diagnostic

100 to 300 prompt query set, five-run multi-geo measurement across all surfaces, full share of voice, prioritised roadmap. Fixed fee. The client owns the query set.

Sprint
#### 90-day execution

Human-led remediation using the roadmap, with re-measurement runs to show delta. Service, powered by the engine.

Monitoring
#### Retainer subscription

Scheduled re-runs, delta reports, regression alerts, competitor tracking, a live dashboard. The recurring-revenue core.

The gating principle from Section 3 holds: tiers differ by run depth, breadth, history, and human involvement, all of which cost more to produce, never by hiding a finding the free run already computed.

## 14 Success metrics

- Activation: free diagnostics completed; share with at least one non-obvious finding.

- Conversion: free to booked call; call to paid diagnostic; diagnostic to sprint or monitoring.

- Quality: false-positive rate on findings (target near zero); operator edit rate before send.

- Retention: monitoring subscription retention and re-baseline cadence adherence.

- Unit economics: model/probe cost per run vs price; margin per tier.

## 15 Risks and mitigations

| 
| Risk | Mitigation

| No faithful API for a consumer surface (esp. ChatGPT UI, Copilot). | Default to grounded APIs and licensed data providers as labelled proxies; offer headless as opt-in high-fidelity; always disclose method.

| Headless automation against provider terms / anti-bot. | Prefer sanctioned APIs; isolate headless behind clear consent and rate limits; never make it the default.

| Non-determinism produces unstable scores. | Multi-run distributions, confidence bands tied to run count, never single-run rates.

| A false positive kills a prospect's trust. | Evidence-gated findings, reproduction shipped, human review before outbound send in operator mode.

| Cost per full run is high. | Cost governor, tiered run counts, caching of stable signals (access, schema) between runs.

| WAF IP-verified blocks not reproducible by UA spoof. | Multi-geo clean egress; disclose the limit; recommend the client verify at their CDN.

| Providers change surfaces/APIs. | Adapter isolation so one surface change is contained; version the methodology.

## 16 Build sequence

Sequence for build order, not feature-gating. Each phase is shippable and each earns the next.

| 
| Phase | Ships | Why first

| 1. Probe + report | Intake, access probe (6.2), on-page/schema (6.3), scoring skeleton, branded report + PDF, manual query set. | The access probe alone is the highest-value, most reproducible, cheapest finding. Ships a real report immediately.

| 2. Entity + measurement | Entity resolution (6.4), query-set gen (6.5), measurement engine (6.6) on the two cleanest surfaces (Claude, Perplexity), share of voice (6.7). | Adds the differentiator once the report scaffold exists. Start with API-clean surfaces.

| 3. Surfaces + findings | ChatGPT and Google AIO adapters, full findings synthesis (6.9) with claims discipline, executive/technical registers. | Broadens coverage and hardens the narrative quality.

| 4. Monetise | Delivery + CRM (6.11), Stripe upgrades, operator console, bulk intake. | Turn diagnostics into pipeline and revenue.

| 5. Monitor | Scheduling, deltas, alerts, dashboard (6.12), white-label branding. | The recurring-revenue engine and partner channel.

## 17 Open questions

- Which surfaces are in the v1 free tier: Claude + Perplexity only (clean APIs), or also a ChatGPT proxy?

- Headless fidelity mode: build it now for exact-surface capture, or defer and rely on APIs plus SERP providers?

- Self-serve public free tier from day one, or operator-only outbound first to protect quality and cost?

- Product name: Beacon, or something else. Trademark and domain check needed.

- White-label: in the core data model now, or a later concern?

- Cost ceiling per free run, and the abuse model for the public form.

AI Visibility Diagnostic PRD · working name Beacon · Rothenhall Partners · draft v0.1, August 2026. Grounded in the manual diagnostic run performed for Napkin. Methodology follows the Rothenhall operating manual and its claims-discipline standard.