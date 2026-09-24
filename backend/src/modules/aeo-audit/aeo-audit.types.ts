/**
 * AEO Audit Types — answer-engine visibility, ChatGPT first.
 *
 * The module answers one question, across every answer engine a buyer uses:
 * **when a real buyer asks ChatGPT, Perplexity or Gemini the things they would
 * actually ask, does the client get named — and when a competitor is named
 * alongside them, who does the engine put in front?**
 *
 * Two provenance classes run through these types and must never be mixed:
 * - **Counted** — mention rate, citation rate, share of voice. Produced by the
 *   `measurement` module's deterministic extraction over n>=5 repeats.
 * - **Judged** — {@link AeoStance}. Produced by an LLM reading the answer text.
 *   Reported as an opinion with an evidence quote, never as a rate.
 *
 * Analysis + approved decisions: `docs/analysis/aeo-audit.md`.
 *
 * @module aeo-audit.types
 */

import type { FunnelStage, PromptPersona } from '../query-set/query-set.types';

// ─── Prompt categorisation ────────────────────────────────────────────────

/**
 * The ten angles a real buyer comes at an answer engine from. This is the
 * primary category stored on every generated prompt (`QuerySetItem.dimension`)
 * and copied onto every stance row, so results can be sliced by category and
 * curated later without re-deriving anything.
 */
export type PromptDimension =
  /** "who can help me with {service}" — they know the job, not the vendors. */
  | 'service-discovery'
  /** "best {category} companies in {geo}" — shortlist building. */
  | 'category-best-of'
  /** "alternatives to {competitor}" — actively shopping away from someone. */
  | 'competitor-alternatives'
  /** "{client} vs {competitor}" — down to the final two. */
  | 'head-to-head'
  /** "is {client} any good", "{client} reviews" — validating you specifically. */
  | 'brand-direct'
  /** Pain language only, no category words — pre-category demand. */
  | 'problem-framed'
  /** "{category} for a {size} company on a {budget} budget" — qualifiers. */
  | 'buying-criteria'
  /** "is {client} legit", "downsides of {category}" — risk checking. */
  | 'objection-trust'
  /** "how do I get {outcome} without …" — outcome/job-to-be-done language. */
  | 'job-to-be-done'
  /** "{service} agency for {vertical} in {geo}" — local + industry intent. */
  | 'geo-vertical';

export const PROMPT_DIMENSIONS: readonly PromptDimension[] = [
  'service-discovery',
  'category-best-of',
  'competitor-alternatives',
  'head-to-head',
  'brand-direct',
  'problem-framed',
  'buying-criteria',
  'objection-trust',
  'job-to-be-done',
  'geo-vertical',
];

/** Human labels for reports and the matrix UI. */
export const DIMENSION_LABELS: Record<PromptDimension, string> = {
  'service-discovery': 'Service discovery',
  'category-best-of': 'Category / best-of',
  'competitor-alternatives': 'Competitor alternatives',
  'head-to-head': 'Head-to-head comparison',
  'brand-direct': 'Brand direct',
  'problem-framed': 'Problem framed',
  'buying-criteria': 'Buying criteria',
  'objection-trust': 'Objection / trust',
  'job-to-be-done': 'Job to be done',
  'geo-vertical': 'Geo / vertical',
};

/**
 * How the prompt is typed. Real people switch between clipped search-style
 * phrasing and full conversational sentences; both get measured because they
 * do not always return the same answer.
 */
export type PromptRegister = 'terse' | 'conversational';

/**
 * Whether the client's own brand name appears in the prompt. Unbranded prompts
 * are the honest visibility test — branded ones only prove ChatGPT knows the
 * name when handed it. Kept as its own axis so the verdict never averages the
 * two together.
 */
export type PromptBranding = 'branded' | 'unbranded';

/**
 * Everything known about *why* a prompt exists, persisted as
 * `QuerySetItem.meta` JSON. This is the curation surface: filter, group and
 * hand-edit the matrix on these fields after seeing which cells produced signal.
 */
export interface PromptMeta {
  dimension: PromptDimension;
  register: PromptRegister;
  branding: PromptBranding;
  /** Service this cell was built from, when the dimension interpolates one. */
  service?: string;
  /** Competitor this cell targets — set for alternatives / head-to-head. */
  competitor?: string;
  /** ICP segment the prompt is spoken by. */
  icp?: string;
  /** Persona role from the `persona` module, when one seeded the cell. */
  personaRole?: string;
  /** Market the prompt is asked from. */
  geo?: string;
  /** Vertical modifier, for geo-vertical cells. */
  vertical?: string;
  /** Deterministic template id the cell came from — makes runs reproducible. */
  template: string;
  /** True when an LLM rewrote the template output into natural phrasing. */
  refined: boolean;
}

/** One generated matrix cell, before it becomes a `QuerySetItem`. */
export interface MatrixCell {
  prompt: string;
  dimension: PromptDimension;
  funnelStage: FunnelStage;
  persona: PromptPersona;
  meta: PromptMeta;
}

/**
 * Matrix sizing tiers (D6). Calls = prompts x runCount x engines, so this is the
 * single biggest cost lever in the module.
 *
 * `trial` and `trial-wide` exist for metered measurement surfaces on a free
 * allowance (wave 6, D6). They are deliberately smaller than the dimension count
 * — see {@link TIER_SIZES} — which means the generator spends the budget on the
 * highest-value angles rather than one thin prompt per dimension.
 */
export type MatrixTier = 'trial' | 'trial-wide' | 'scorecard' | 'standard' | 'full';

/**
 * Prompts per tier.
 *
 * `trial` (5) is narrow on purpose: it buys **one prompt on each of the five
 * heaviest-weighted dimensions**, across all three engines. That answers "which
 * engine is failing us" — the comparison nothing else in the stack produces.
 * `trial-wide` (10) spends the same budget on breadth instead, one prompt per
 * dimension on a single engine. Neither is a substitute for `scorecard`+ on a
 * paid allowance; both are honest about being a probe, not a verdict.
 */
export const TIER_SIZES: Record<MatrixTier, number> = {
  trial: 5,
  'trial-wide': 10,
  scorecard: 25,
  standard: 100,
  full: 300,
};

export const MATRIX_TIERS: readonly MatrixTier[] = ['trial', 'trial-wide', 'scorecard', 'standard', 'full'];

// ─── Site context ─────────────────────────────────────────────────────────

/**
 * What the client actually does, read off their own site. Every matrix cell
 * interpolates values from here, so a prompt can never reference a service the
 * client does not sell.
 */
export interface SiteContextData {
  domain: string;
  brand: string;
  category: string | null;
  /** The industry the client sells *into* (not their own category). */
  vertical: string | null;
  description: string | null;
  /** Primary market, ISO-3166 alpha-2 code (from the site's ccTLD — a weak signal). */
  geo: string | null;
  /** Service areas the site names, ranked, ISO-3166 alpha-2 codes (wave-6 D8) — LLM-only, `[]` without synthesis. */
  markets: string[];
  services: string[];
  icp: string[];
  valueProps: string[];
  /** Problems a buyer arrives with — seeds the problem-framed dimension. */
  painPoints: string[];
  /** Jobs-to-be-done / outcomes — seeds the job-to-be-done dimension. */
  outcomes: string[];
  competitors: Array<{ name: string; domain: string | null }>;
  pagesFetched: number;
  pageUrls: string[];
  extraction: 'deterministic' | 'llm-synthesized';
  llmModel: string | null;
  costUsd: number;
  /** Site-context-v2 — is this URL the actual company, or something else? Undefined on pre-v2 rows. */
  identityType?:
    | 'company'
    | 'product-microsite'
    | 'subsidiary'
    | 'franchise'
    | 'regional-site'
    | 'personal-brand'
    | 'marketplace-listing'
    | 'unknown';
  identityConfidence?: number | null;
  /** Per-category completeness (0-1), keyed by SiteContextCategorySummary.category. */
  completeness?: Record<string, number>;
  overallCompleteness?: number;
  /** Confirmed digital-presence accounts, merged in read-only at compile time. */
  socialProfiles?: Array<{ platform: string; url: string; state: string }>;
  /**
   * Every site-context-v2 field beyond the pre-v2 top-level ones (legalName,
   * alternateName, foundedYear, headquarters, officeLocation, languages,
   * pricingModel, differentiator, leadership, certification, award, partner,
   * technology, businessModel, contact) — deduped validated values, keyed by
   * field name. A generic bag rather than 15 more named properties.
   */
  facts?: Record<string, string[]>;
}

// ─── Stance (judged, never counted) ───────────────────────────────────────

/**
 * How ChatGPT positioned the client in one answer.
 *
 * `recommended-primary` — named as the lead recommendation.
 * `recommended-alternative` — named as a credible option among others.
 * `mentioned-neutral` — named, no endorsement either way.
 * `mentioned-negative` — named with a caveat, warning, or as the weaker choice.
 * `absent` — not named at all (the competitors, if any, were).
 */
export type Stance =
  | 'recommended-primary'
  | 'recommended-alternative'
  | 'mentioned-neutral'
  | 'mentioned-negative'
  | 'absent';

export const STANCES: readonly Stance[] = [
  'recommended-primary',
  'recommended-alternative',
  'mentioned-neutral',
  'mentioned-negative',
  'absent',
];

/** One judged observation. Opinion + the quote it was drawn from. */
export interface StanceVerdict {
  observationId: string;
  /** Engine whose answer this judged — null on rows written before multi-surface. */
  surface: string | null;
  dimension: PromptDimension | null;
  stance: Stance;
  /** 1-based position of the client among the brands the answer named. */
  rankAmongBrands: number | null;
  /** Every brand named in the answer, in the order the answer named them. */
  brandsNamed: string[];
  /** Competitors the answer placed the client above. */
  recommendedOver: string[];
  /** Competitors the answer placed above the client. */
  losesTo: string[];
  /** Brands named that were NOT already in the recorded competitor list — raw
   * LLM output, unfiltered by knownOnly(). Surfaced so a new rival mentioned by
   * the AI isn't silently discarded; never trusted directly (see Competitor.status). */
  otherNamesSeen: string[];
  /** Verbatim, <=280 chars — what the judge based the call on. */
  evidenceQuote: string | null;
  rationale: string | null;
}

// ─── Verdict ──────────────────────────────────────────────────────────────

/** Counted metrics for one slice of the matrix. */
export interface SliceMetrics {
  prompts: number;
  observations: number;
  /** Share of observations where the client was named. Counted. */
  mentionRate: number;
  /** Share of observations citing the client's domain. Counted. */
  citationRate: number;
}

/** Per-dimension roll-up — counted metrics plus the judged stance spread. */
export interface DimensionResult extends SliceMetrics {
  dimension: PromptDimension;
  label: string;
  /** Judged. Counts per stance, `absent` included. */
  stanceCounts: Record<Stance, number>;
}

/**
 * Per-market roll-up — counted metrics across every surface measured in that
 * market (wave-6 D8). ISO-3166 alpha-2 code, e.g. `"US"`.
 */
export interface MarketResult extends SliceMetrics {
  market: string;
}

/**
 * One **market × engine** cell — the finding neither axis can produce alone.
 *
 * `byMarket` says "we are weaker in GB". `bySurface` says "we are weaker on
 * Gemini". Only the cross tells you *Gemini in GB* is the hole, which is the
 * one an operator can act on. Kept unaggregated for exactly that reason: an
 * average across markets hides the market that is failing, and an average
 * across engines hides the engine that is failing.
 */
export interface MarketSurfaceResult extends SliceMetrics {
  market: string;
  surface: AeoSurface;
  label: string;
  status: SurfaceRunStatus;
  /** Unbranded only — the honest visibility number for this cell. */
  unbrandedMentionRate: number;
}

/** How one competitor fared against the client across the whole run. */
export interface CompetitorStanding {
  name: string;
  /** Observations naming this competitor. Counted. */
  observations: number;
  /** Share of all observations naming them. Counted. */
  mentionRate: number;
  /** Judged: answers putting the client above this competitor. */
  clientAheadCount: number;
  /** Judged: answers putting this competitor above the client. */
  clientBehindCount: number;
  /** Observations naming the competitor while the client was absent. Counted. */
  wonWhileClientAbsent: number;
}

/**
 * Competitor standings **within one market** — the flowchart's stage 6
 * "Competitors by Area / Market" leaf.
 *
 * `counted.competitors` answers "who beats us"; this answers "who beats us
 * *there*". They are not the same question and the aggregate actively hides
 * the second: a rival dominant in GB and absent in the US averages into a
 * middling global row that describes neither market. Market entry and market
 * defence are decided per market, so the standings have to be readable that
 * way too.
 *
 * One entry per market actually measured. On a single-market audit the one
 * entry carries the same standings as `counted.competitors` — same numbers,
 * now keyed by the market they were measured in, so a consumer never has to
 * special-case the single-market shape.
 */
export interface MarketCompetitorStandings {
  market: string;
  competitors: CompetitorStanding[];
}

/** The report object. Counted and judged blocks are kept separate on purpose. */
export interface AeoVerdict {
  /**
   * The audit this verdict was computed from. Lets a consumer holding only a
   * snapshot (a report's AEO section) name its audit exactly — e.g. to pair
   * it with that audit's progress review. Optional: verdicts stored before
   * this field existed do not carry it.
   */
  auditId?: string;
  /** Primary surface, kept for single-surface callers. */
  surface: string;
  /** Every engine this audit measured, with per-engine status and failures. */
  surfaceRuns: SurfaceRunResult[];
  runCount: number;
  generatedAt: string;

  /** COUNTED — deterministic extraction over n>=5 repeats. */
  counted: {
    overall: SliceMetrics;
    /** Unbranded prompts only — the honest visibility number. */
    unbranded: SliceMetrics;
    branded: SliceMetrics;
    byDimension: DimensionResult[];
    byFunnelStage: Array<SliceMetrics & { funnelStage: FunnelStage }>;
    /** Client first, then every competitor seen. */
    shareOfVoice: Array<{ name: string; share: number }>;
    competitors: CompetitorStanding[];
    /**
     * The same matrix, engine by engine. This is the comparison the whole
     * multi-surface run exists to produce — "named on Perplexity, invisible on
     * ChatGPT" is a finding a single-surface audit cannot make.
     */
    bySurface: SurfaceComparison[];
    /**
     * Per-market roll-up (wave-6 D8) — one entry per distinct market actually
     * measured. A single-market audit gets a one-item array, never a
     * duplicate of `overall`; the per-(surface, market) cell detail is on
     * `surfaceRuns` (each row already carries its own `market`).
     */
    byMarket: MarketResult[];
    /**
     * The same numbers split by market **and** engine. Present only when more
     * than one market was measured — on a single-market audit it would just be
     * `bySurface` with a redundant column.
     */
    byMarketSurface: MarketSurfaceResult[];
    /**
     * Competitor standings per market (stage 6, "Competitors by Area /
     * Market") — one entry per market measured. See
     * {@link MarketCompetitorStandings}.
     */
    byMarketCompetitors: MarketCompetitorStandings[];
  };

  /** JUDGED — LLM opinion over the same answers. Never a rate. */
  judged: {
    available: boolean;
    /** Why the judge did not run, when `available` is false. */
    unavailableReason?: string;
    judgeModel?: string;
    observationsJudged: number;
    stanceCounts: Record<Stance, number>;
    /** Prompts where ChatGPT put a competitor in front, worst first. */
    losingPrompts: Array<{
      prompt: string;
      dimension: PromptDimension | null;
      losesTo: string[];
      evidenceQuote: string | null;
    }>;
    /** Prompts where ChatGPT led with the client. */
    winningPrompts: Array<{
      prompt: string;
      dimension: PromptDimension | null;
      recommendedOver: string[];
      evidenceQuote: string | null;
    }>;
  };

  /** Plain-language read of the two blocks above. Facts only, no adjectives. */
  headlines: string[];

  /**
   * Persuasive-but-grounded reframing of `headlines`, generated by a separate
   * explicit pass (`AeoNarrativeService`) — never computed inline by
   * `buildVerdict`. Absent until that pass has run at least once for this
   * audit; `headlines` remains the fallback for any consumer that does not
   * read this field.
   */
  narrative?: NarrativeBlock;
}

/**
 * Customer-facing framing of the same facts already in `headlines` — an LLM
 * rewording, never a new source of numbers. Optional and additive: absence
 * means "not generated yet" or "no provider configured", and any consumer
 * that only knows about `headlines` is unaffected.
 */
export interface NarrativeBlock {
  /** Same brevity/line-count budget as `headlines` — framed, not re-derived. */
  headlines: string[];
  /** True when no prior completed audit exists for this project. */
  isFirstAudit: boolean;
  /** False when a prior audit exists but is not safely comparable (question-set/version change). */
  comparable: boolean;
  /** The prior audit actually compared against, when `comparable` is true. */
  comparedToAuditId?: string;
  generatedAt: string;
  model: string;
}

// ─── Pre-flight budget ────────────────────────────────────────────────────

/**
 * What a run will cost, answered **before** the operator presses run.
 *
 * The run-time guard (`cloroFitsBudget`) already refuses a run that cannot
 * finish inside the allowance — but refusing after the click is the wrong place
 * to learn it. On a metered surface the operator needs to see "needs 375, 500
 * left" while they are still choosing the tier, which is what step 0 deferred
 * until a credit concept existed.
 *
 * `remaining` is null when the balance could not be read (no key, API down).
 * `fits` is then null too — never `true`, because an unknown balance is not a
 * sufficient one, and never `false`, because we did not find it lacking.
 */
export interface AeoBudgetEstimate {
  /** Credits this configuration needs. 0 when no metered surface is selected. */
  required: number;
  /** Remaining allowance, or null when it could not be read. */
  remaining: number | null;
  /** null when `remaining` is unknown — see the note above. */
  fits: boolean | null;
  /** Why the balance is unknown. Null when it was read successfully. */
  unavailableReason: string | null;
  /** Per-surface breakdown, so a costly engine is identifiable at a glance. */
  perSurface: Array<{
    surface: AeoSurface;
    label: string;
    /** 0 for the browser surfaces — they are paid for by a subscription. */
    credits: number;
    metered: boolean;
  }>;
  /** prompts × runCount × surfaces × markets. The wall-clock driver. */
  calls: number;
  prompts: number;
  runCount: number;
  markets: number;
}

// ─── Audit lifecycle ──────────────────────────────────────────────────────

export type AeoAuditStatus =
  | 'pending'
  | 'context'
  | 'matrix'
  | 'running'
  | 'judging'
  | 'completed'
  | 'failed';

/**
 * Answer engines this module measures. `cloro-*` surfaces query the vendors'
 * consumer products through Cloro's API (decision D1, `docs/analysis/wave-6-audit-pipeline.md`)
 * and are the default path; `*-browser` surfaces drive the same products
 * directly in Playwright and are Cloro's automatic fallback (see the fallback
 * chain in `aeo-audit.service.ts`). `mock` is the test-only deterministic surface.
 */
export type AeoSurface =
  | 'chatgpt-browser'
  | 'perplexity-browser'
  | 'gemini-browser'
  | 'cloro-chatgpt'
  | 'cloro-perplexity'
  | 'cloro-gemini'
  | 'cloro-ai-overview'
  | 'cloro-ai-mode'
  | 'mock';

export const AEO_SURFACES: readonly AeoSurface[] = [
  'chatgpt-browser',
  'perplexity-browser',
  'gemini-browser',
  'cloro-chatgpt',
  'cloro-perplexity',
  'cloro-gemini',
  'cloro-ai-overview',
  'cloro-ai-mode',
  'mock',
];

/** What each surface is called in a report. */
export const SURFACE_LABELS: Record<AeoSurface, string> = {
  'chatgpt-browser': 'ChatGPT (browser)',
  'perplexity-browser': 'Perplexity (browser)',
  'gemini-browser': 'Gemini (browser)',
  'cloro-chatgpt': 'ChatGPT',
  'cloro-perplexity': 'Perplexity',
  'cloro-gemini': 'Gemini',
  'cloro-ai-overview': 'Google AI Overview',
  'cloro-ai-mode': 'Google AI Mode',
  mock: 'Mock (test)',
};

/** Lifecycle of one surface within an audit. */
export type SurfaceRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * One measured engine inside an audit.
 *
 * A failed surface is reported, not hidden: an audit where Gemini was blocked
 * and the other two answered is still a useful audit, and saying which engine
 * produced nothing is part of the finding.
 */
export interface SurfaceRunResult {
  surface: AeoSurface;
  label: string;
  /** ISO-3166 alpha-2 market this row measured — null on rows not yet resolved. */
  market: string | null;
  status: SurfaceRunStatus;
  runId: string | null;
  observations: number;
  stanceJudged: number;
  costUsd: number;
  /** Typed adapter reason — `blocked`, `rate-limited`, `selector-drift`, `cost-capped-partial`, … */
  failureKind: string | null;
  error: string | null;
  /**
   * The surface that ACTUALLY answered, when it differs from `surface` — set
   * when a failed `cloro-*` surface falls back to its `*-browser` equivalent
   * (wave-6 D1). Equal to `surface` on every normal run. Reading only
   * `surface` here would report a browser-fallback answer as if it were a
   * genuine Cloro measurement — the one thing this design explicitly forbids.
   */
  attemptedVia: AeoSurface | null;
}

/** Per-surface slice of the counted metrics, for the comparison view. */
export interface SurfaceComparison extends SliceMetrics {
  surface: AeoSurface;
  label: string;
  status: SurfaceRunStatus;
  /** Unbranded only — the honest visibility number for this engine. */
  unbrandedMentionRate: number;
  /** The answers `unbrandedMentionRate` is computed over. Absent on verdicts stored before it was recorded. */
  unbrandedObservations?: number;
  /** Judged stance spread on this engine. */
  stanceCounts: Record<Stance, number>;
  /** Competitors named on this engine while the client was not. Counted. */
  rivalsAheadCount: number;
}
