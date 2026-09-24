/**
 * AEO Prompt-Matrix Generator — deterministic cell builder.
 *
 * Produces the prompts a real buyer would type into an answer engine, across
 * ten {@link PromptDimension}s, from the client's own site context. Deterministic
 * by construction: the same `(projectId, context, tier)` always yields the same
 * cells, so a re-run is comparable to the last one and the smoke harness can
 * assert exact output. The optional LLM pass in `aeo-matrix.service` only
 * rewrites the *phrasing* of these cells — never the taxonomy, never the count.
 *
 * Coverage is the contract. Every dimension that has the inputs it needs gets a
 * proportional share of the tier budget; dimensions whose inputs are missing
 * (no competitors found → no `competitor-alternatives`) are skipped honestly
 * rather than filled with invented values.
 *
 * Two axes exist on every cell and are never averaged together downstream:
 * - `branding`: unbranded prompts are the real visibility test; branded ones
 *   only prove the engine knows the name once you hand it over.
 * - `register`: terse search-style vs conversational — they do not always
 *   return the same answer, so both get measured.
 *
 * @module aeo-matrix.generator
 */

import { rngFromSeed, seededPick } from '../../common/utils/prng';
import type { FunnelStage, PromptPersona } from '../query-set/query-set.types';
import type {
  MatrixCell,
  MatrixTier,
  PromptBranding,
  PromptDimension,
  PromptRegister,
  SiteContextData,
} from './aeo-audit.types';
import { PROMPT_DIMENSIONS, TIER_SIZES } from './aeo-audit.types';

/** Relative budget weight per dimension. Higher = more prompts at a given tier. */
const DIMENSION_WEIGHTS: Record<PromptDimension, number> = {
  'service-discovery': 14,
  'category-best-of': 12,
  'competitor-alternatives': 14, // explicitly requested emphasis
  'head-to-head': 12, // explicitly requested emphasis
  'brand-direct': 8,
  'problem-framed': 10,
  'buying-criteria': 8,
  'objection-trust': 6,
  'job-to-be-done': 8,
  'geo-vertical': 8,
};

/** Funnel stage each dimension sits at (PRD FR-5.2 tagging). */
const DIMENSION_STAGE: Record<PromptDimension, FunnelStage> = {
  'service-discovery': 'solution-aware',
  'category-best-of': 'solution-aware',
  'competitor-alternatives': 'product-aware',
  'head-to-head': 'most-aware',
  'brand-direct': 'most-aware',
  'problem-framed': 'problem-aware',
  'buying-criteria': 'product-aware',
  'objection-trust': 'most-aware',
  'job-to-be-done': 'problem-aware',
  'geo-vertical': 'solution-aware',
};

/** Persona bucket each dimension is spoken by, mirroring the query-set taxonomy. */
const DIMENSION_PERSONA: Record<PromptDimension, PromptPersona> = {
  'service-discovery': 'solution-aware',
  'category-best-of': 'solution-aware',
  'competitor-alternatives': 'product-aware',
  'head-to-head': 'most-aware',
  'brand-direct': 'most-aware',
  'problem-framed': 'problem-aware',
  'buying-criteria': 'product-aware',
  'objection-trust': 'most-aware',
  'job-to-be-done': 'problem-aware',
  'geo-vertical': 'solution-aware',
};

/** Is the client's own name in the prompt? Only three dimensions name them. */
const DIMENSION_BRANDING: Record<PromptDimension, PromptBranding> = {
  'service-discovery': 'unbranded',
  'category-best-of': 'unbranded',
  'competitor-alternatives': 'unbranded',
  'head-to-head': 'branded',
  'brand-direct': 'branded',
  'problem-framed': 'unbranded',
  'buying-criteria': 'unbranded',
  'objection-trust': 'branded',
  'job-to-be-done': 'unbranded',
  'geo-vertical': 'unbranded',
};

/** A template: an id (for reproducibility) and the phrasing function. */
interface Template {
  id: string;
  register: PromptRegister;
  build: (v: Vars) => string;
  /**
   * Per-template branding override for an *inherently mixed* dimension whose
   * cells are not uniformly branded/unbranded (spec §3.3: `objection-trust`
   * wants both "is {brand} legit" and "downsides of {category}"). When unset
   * the cell inherits {@link DIMENSION_BRANDING} for its dimension, which is
   * still correct for every dimension whose templates are uniform.
   */
  branding?: PromptBranding;
}

/** Interpolation values available to a template. */
interface Vars {
  brand: string;
  category: string;
  service: string;
  competitor: string;
  icp: string;
  /**
   * The ICP with its article already attached — "a fund", "an operator",
   * or bare "lean teams" when the segment is plural. Templates that need
   * "for {icp}" must use this instead of writing "a {icp}" themselves:
   * extracted segments are commonly plural ("funds", "lean teams") and
   * "for a funds" is not a query any human types.
   */
  anIcp: string;
  /** The ICP as a plural — "funds", "operators". Never double-pluralised. */
  icpPlural: string;
  geo: string;
  vertical: string;
  /**
   * The pain as a mid-sentence clause (lowercased sentence case, no terminal
   * punctuation). Only valid after a colon or similar break — extracted pains
   * are a mix of noun phrases ("fragmented revenue infrastructure") and full
   * clauses ("buyers no longer search"), and only a colon reads correctly for
   * both. Never write "a problem with {pain}": that needs a noun phrase and
   * half the corpus is not one.
   */
  pain: string;
  /** The pain as its own sentence-cased statement, for sentence-initial slots. */
  painSentence: string;
  outcome: string;
}

/**
 * Template pools per dimension. Each pool mixes terse (search-style) and
 * conversational registers, because buyers use both and answer engines do not
 * always respond identically to them.
 */
const TEMPLATES: Record<PromptDimension, Template[]> = {
  'service-discovery': [
    { id: 'sd1', register: 'terse', build: (v) => `who provides ${v.service}` },
    { id: 'sd2', register: 'terse', build: (v) => `${v.service} providers for ${v.icp}` },
    { id: 'sd3', register: 'conversational', build: (v) => `Who can help me with ${v.service}? I run ${v.anIcp}.` },
    { id: 'sd4', register: 'conversational', build: (v) => `I need someone to handle ${v.service} — who should I be talking to?` },
    { id: 'sd5', register: 'terse', build: (v) => `companies that do ${v.service}` },
    { id: 'sd6', register: 'conversational', build: (v) => `We're looking to outsource ${v.service}. Which firms are worth shortlisting?` },
    { id: 'sd7', register: 'terse', build: (v) => `${v.service} specialists ${v.geo}` },
  ],
  'category-best-of': [
    { id: 'cb1', register: 'terse', build: (v) => `best ${v.category} companies` },
    { id: 'cb2', register: 'terse', build: (v) => `top ${v.category} providers ${v.geo}` },
    { id: 'cb3', register: 'conversational', build: (v) => `What are the best ${v.category} options right now?` },
    { id: 'cb4', register: 'conversational', build: (v) => `Can you give me a shortlist of the leading ${v.category} companies for ${v.anIcp}?` },
    { id: 'cb5', register: 'terse', build: (v) => `most recommended ${v.category} 2026` },
    { id: 'cb6', register: 'conversational', build: (v) => `Who are the top players in ${v.category} and what makes each one different?` },
  ],
  'competitor-alternatives': [
    { id: 'ca1', register: 'terse', build: (v) => `alternatives to ${v.competitor}` },
    { id: 'ca2', register: 'terse', build: (v) => `${v.competitor} competitors` },
    { id: 'ca3', register: 'conversational', build: (v) => `We're currently using ${v.competitor} and it isn't working out. What else should we look at?` },
    { id: 'ca4', register: 'conversational', build: (v) => `What are the best alternatives to ${v.competitor} for ${v.anIcp}?` },
    { id: 'ca5', register: 'terse', build: (v) => `companies like ${v.competitor}` },
    { id: 'ca6', register: 'conversational', build: (v) => `${v.competitor} is out of our budget. Who does something similar for less?` },
    { id: 'ca7', register: 'terse', build: (v) => `${v.competitor} vs other ${v.category} providers` },
  ],
  'head-to-head': [
    { id: 'hh1', register: 'terse', build: (v) => `${v.brand} vs ${v.competitor}` },
    { id: 'hh2', register: 'conversational', build: (v) => `${v.brand} or ${v.competitor} — which is better for ${v.anIcp}?` },
    { id: 'hh3', register: 'conversational', build: (v) => `How does ${v.brand} compare to ${v.competitor} for ${v.service}?` },
    { id: 'hh4', register: 'terse', build: (v) => `${v.brand} vs ${v.competitor} pricing` },
    { id: 'hh5', register: 'conversational', build: (v) => `We're deciding between ${v.brand} and ${v.competitor}. What are the trade-offs?` },
  ],
  'brand-direct': [
    { id: 'bd1', register: 'terse', build: (v) => `${v.brand} reviews` },
    { id: 'bd2', register: 'conversational', build: (v) => `Is ${v.brand} any good?` },
    { id: 'bd3', register: 'conversational', build: (v) => `What does ${v.brand} actually do?` },
    { id: 'bd4', register: 'terse', build: (v) => `${v.brand} pricing` },
    { id: 'bd5', register: 'conversational', build: (v) => `Would you recommend ${v.brand} for ${v.service}?` },
    { id: 'bd6', register: 'terse', build: (v) => `${v.brand} ${v.category}` },
  ],
  'problem-framed': [
    // Every slot here is either sentence-initial (painSentence) or follows a
    // colon/dash (pain), so both noun-phrase and clause-shaped pains read.
    { id: 'pf1', register: 'conversational', build: (v) => `Our problem: ${v.pain}. What are my options?` },
    { id: 'pf2', register: 'conversational', build: (v) => `We keep running into this: ${v.pain}. How do other ${v.icpPlural} deal with it?` },
    { id: 'pf3', register: 'terse', build: (v) => `${v.pain}` },
    { id: 'pf4', register: 'conversational', build: (v) => `${v.painSentence} — is there a service for this, or do we need to hire?` },
    { id: 'pf5', register: 'conversational', build: (v) => `${v.painSentence} — who usually fixes this?` },
  ],
  'buying-criteria': [
    { id: 'bc1', register: 'terse', build: (v) => `${v.category} for ${v.icp}` },
    { id: 'bc2', register: 'conversational', build: (v) => `What should I look for when choosing a ${v.category} provider?` },
    { id: 'bc3', register: 'conversational', build: (v) => `Which ${v.category} companies work well with ${v.anIcp} on a limited budget?` },
    { id: 'bc4', register: 'terse', build: (v) => `affordable ${v.service} ${v.geo}` },
    { id: 'bc5', register: 'conversational', build: (v) => `We need ${v.service} but we're a small team. Who handles clients our size?` },
  ],
  // Inherently mixed (spec §3.3): a buyer's trust/objection questions come in a
  // branded form (vetting *this* company) AND an unbranded form (doubting the
  // *category* itself). Both are generated and each cell is tagged individually
  // via the per-template `branding` override — DIMENSION_BRANDING below is only
  // the default for the branded majority.
  'objection-trust': [
    { id: 'ot1', register: 'terse', branding: 'branded', build: (v) => `is ${v.brand} legit` },
    { id: 'ot2', register: 'conversational', branding: 'branded', build: (v) => `Are there any complaints about ${v.brand}?` },
    { id: 'ot3', register: 'conversational', branding: 'branded', build: (v) => `What are the downsides of working with a ${v.category} provider like ${v.brand}?` },
    // Unbranded: the same objection aimed at the category, never naming the client.
    { id: 'ot4', register: 'terse', branding: 'unbranded', build: (v) => `downsides of ${v.category}` },
    { id: 'ot5', register: 'conversational', branding: 'unbranded', build: (v) => `Is ${v.service} actually worth paying for, or is it overhyped?` },
    { id: 'ot6', register: 'conversational', branding: 'unbranded', build: (v) => `What are the risks of hiring a ${v.category} provider?` },
  ],
  'job-to-be-done': [
    { id: 'jd1', register: 'conversational', build: (v) => `How do I ${v.outcome} without hiring a full team?` },
    { id: 'jd2', register: 'terse', build: (v) => `how to ${v.outcome}` },
    { id: 'jd3', register: 'conversational', build: (v) => `What's the fastest way to ${v.outcome} for ${v.anIcp}?` },
    { id: 'jd4', register: 'conversational', build: (v) => `We want to ${v.outcome} this quarter. Should we do it in-house or bring someone in?` },
    { id: 'jd5', register: 'terse', build: (v) => `best way to ${v.outcome} ${v.geo}` },
  ],
  'geo-vertical': [
    { id: 'gv1', register: 'terse', build: (v) => `${v.service} ${v.geo}` },
    { id: 'gv2', register: 'terse', build: (v) => `${v.category} for ${v.vertical}` },
    { id: 'gv3', register: 'conversational', build: (v) => `Who does ${v.service} for ${v.vertical} companies in ${v.geo}?` },
    { id: 'gv4', register: 'conversational', build: (v) => `Are there ${v.category} providers that specialise in ${v.vertical}?` },
    { id: 'gv5', register: 'terse', build: (v) => `best ${v.category} ${v.geo}` },
  ],
};

/**
 * Consumer-facing (B2C) vs. professional-services (B2B) framing. The default
 * templates above assume a buyer is procuring a service for their business
 * ("outsource X", "hire a provider", "handles clients our size") — correct
 * for an agency/SaaS/consultancy, nonsense for a retailer or app a shopper
 * uses directly ("we're looking to outsource Trending Brands" is not a
 * question anyone types). Only the dimensions whose default phrasing assumes
 * B2B procurement get a consumer-framed alternative pool; the rest (category
 * best-of, competitor-alternatives, head-to-head, brand-direct, problem-framed,
 * geo-vertical) are neutral enough to read naturally either way.
 */
function isConsumerFacing(ctx: SiteContextData): boolean {
  const CONSUMER_SIGNAL =
    /\b(consumer|b2c|shopper|shoppers|shopping|retail|e-?commerce|marketplace|storefront|subscription box|d2c|direct[- ]to[- ]consumer|gift cards?|online store)\b/i;
  const B2B_SIGNAL = /\b(b2b|enterprise|agenc(y|ies)|saas|software vendor|consult(ing|ancy)|professional services|firms?)\b/i;
  const text = [ctx.category, ctx.description, ...(ctx.facts?.businessModel ?? [])].filter(Boolean).join(' ');
  if (CONSUMER_SIGNAL.test(text)) return true;
  if (B2B_SIGNAL.test(text)) return false;
  // No named buyer segment and no B2B signal is itself a weak consumer signal —
  // a B2B site almost always names who it sells to; a consumer site rarely does.
  return ctx.icp.length === 0;
}

const CONSUMER_TEMPLATES: Partial<Record<PromptDimension, Template[]>> = {
  'service-discovery': [
    { id: 'sd1', register: 'terse', build: (v) => `where to get ${v.service}` },
    { id: 'sd2', register: 'terse', build: (v) => `best place for ${v.service}` },
    { id: 'sd3', register: 'conversational', build: (v) => `Where can I find ${v.service}?` },
    { id: 'sd4', register: 'conversational', build: (v) => `I'm looking for ${v.service} — any recommendations?` },
    { id: 'sd5', register: 'terse', build: (v) => `sites that offer ${v.service}` },
    { id: 'sd6', register: 'conversational', build: (v) => `What's a good app or site for ${v.service}?` },
    { id: 'sd7', register: 'terse', build: (v) => `${v.service} near me` },
  ],
  'buying-criteria': [
    { id: 'bc1', register: 'terse', build: (v) => `best ${v.category} for everyday use` },
    { id: 'bc2', register: 'conversational', build: (v) => `What should I look for in a good ${v.category}?` },
    { id: 'bc3', register: 'conversational', build: (v) => `Which ${v.category} is worth it if I'm on a budget?` },
    { id: 'bc4', register: 'terse', build: (v) => `cheapest ${v.service} ${v.geo}` },
    { id: 'bc5', register: 'conversational', build: (v) => `Is it worth signing up for ${v.service}, or is it a hassle?` },
  ],
  'objection-trust': [
    { id: 'ot1', register: 'terse', branding: 'branded', build: (v) => `is ${v.brand} legit` },
    { id: 'ot2', register: 'conversational', branding: 'branded', build: (v) => `Are there any complaints about ${v.brand}?` },
    { id: 'ot3', register: 'conversational', branding: 'branded', build: (v) => `Is ${v.brand} safe to use, or are there horror stories?` },
    { id: 'ot4', register: 'terse', branding: 'unbranded', build: (v) => `downsides of ${v.category}` },
    { id: 'ot5', register: 'conversational', branding: 'unbranded', build: (v) => `Is ${v.service} actually worth it, or is it overhyped?` },
    { id: 'ot6', register: 'conversational', branding: 'unbranded', build: (v) => `What are the risks of using a ${v.category}?` },
  ],
  'job-to-be-done': [
    { id: 'jd1', register: 'conversational', build: (v) => `How do I ${v.outcome} without getting scammed?` },
    { id: 'jd2', register: 'terse', build: (v) => `how to ${v.outcome}` },
    { id: 'jd3', register: 'conversational', build: (v) => `What's the easiest way to ${v.outcome}?` },
    { id: 'jd4', register: 'conversational', build: (v) => `I want to ${v.outcome} — what's the catch, if any?` },
    { id: 'jd5', register: 'terse', build: (v) => `best way to ${v.outcome} ${v.geo}` },
  ],
};

function templatesFor(dimension: PromptDimension, consumer: boolean): Template[] {
  if (consumer) return CONSUMER_TEMPLATES[dimension] ?? TEMPLATES[dimension];
  return TEMPLATES[dimension];
}

/**
 * Fallbacks used only when the site context is thin.
 *
 * There is deliberately **no placeholder for category or service**. Filling a
 * `{category}` slot with wording like "this kind of service" produces prompts no
 * buyer would ever type ("what should I look for when choosing a this kind of
 * service provider?") and quietly corrupts the measurement. When a real value is
 * missing the slot stays empty and {@link hasUnfilledSlot} drops the cell, which
 * is then reported in `skipped` with the reason.
 *
 * `icp` is the one exception: "small business" is a phrase buyers really type,
 * and it is generic by intent rather than a stand-in for a missing fact.
 */
const FALLBACK = {
  icp: 'small business',
  geo: '',
  vertical: '',
  pain: '',
  outcome: '',
};

/** What a dimension needs before it may produce cells. */
const REQUIREMENTS: Record<PromptDimension, (ctx: SiteContextData) => boolean> = {
  'service-discovery': (c) => c.services.length > 0,
  'category-best-of': (c) => Boolean(c.category) || c.services.length > 0,
  'competitor-alternatives': (c) => c.competitors.length > 0,
  'head-to-head': (c) => c.competitors.length > 0,
  'brand-direct': (c) => Boolean(c.brand),
  'problem-framed': (c) => c.painPoints.length > 0,
  'buying-criteria': (c) => Boolean(c.category) || c.services.length > 0,
  'objection-trust': (c) => Boolean(c.brand),
  'job-to-be-done': (c) => c.outcomes.length > 0,
  'geo-vertical': (c) => Boolean(c.geo) || Boolean(c.vertical),
};

/** Why a dimension produced nothing — surfaced so gaps are explained, not hidden. */
export interface SkippedDimension {
  dimension: PromptDimension;
  reason: string;
}

/**
 * Measured search demand, keyed on the keyword, valued by monthly volume.
 * Built from the project's latest `KeywordSet` (wave-6 step 4); absent when no
 * keyword research has been run, in which case generation is unchanged.
 */
export type DemandIndex = Map<string, number>;

export interface GeneratedMatrix {
  cells: MatrixCell[];
  skipped: SkippedDimension[];
  /** Requested tier size vs what the available context could actually fill. */
  requested: number;
  produced: number;
  /**
   * Whether search demand reordered the services, and what it ranked. Recorded
   * so a matrix that looks oddly ordered can be traced to the volumes that
   * ordered it, instead of looking arbitrary.
   */
  demand: { applied: boolean; ranked: Array<{ service: string; volume: number }> };
  /** Confirmed inputs that reached no prompt (spec §5.3). */
  coverageGaps: CoverageGaps;
}

/**
 * Which confirmed inputs never made it into a single generated prompt (spec
 * §5.3 coverage validation). A non-empty list is a real signal — either the
 * budget was too small to reach that input, or every dimension that would use
 * it was skipped for missing prerequisites.
 */
export interface CoverageGaps {
  /** Confirmed services that appear in no generated prompt. */
  services: string[];
  /** Confirmed ICP segments that appear in no generated prompt. */
  icpSegments: string[];
  /** Confirmed target markets that appear in no generated prompt (the generator only interpolates the primary `geo`). */
  markets: string[];
}

/**
 * Build the matrix.
 *
 * @param projectId Seeds the PRNG — same project + context + tier ⇒ same matrix.
 * @param ctx Site context. Nothing is interpolated that is not in here.
 * @param tier Size tier (D6); `standard` = 100 prompts.
 * @returns Cells plus an honest account of which dimensions were skipped and why.
 */
export function generateMatrix(
  projectId: string,
  ctx: SiteContextData,
  tier: MatrixTier,
  demand?: DemandIndex,
): GeneratedMatrix {
  const target = TIER_SIZES[tier];
  const skipped: SkippedDimension[] = [];

  // Demand weighting (wave-6 step 4). Real search volume decides which of the
  // client's services get asked about first. It matters most exactly where the
  // budget is tightest: a 5-prompt `trial` that spends its one service-discovery
  // cell on the offering nobody searches for has wasted the run.
  //
  // Ordering only. No prompt is invented, dropped or rewritten because of a
  // volume number — the cells are still built from the client's own context, so
  // a wrong or stale keyword set can reorder the matrix but can never put a
  // service in it that the client does not sell.
  const demandOrder = demand ? orderServicesByDemand(ctx.services, demand) : null;
  if (demandOrder) ctx = { ...ctx, services: demandOrder.services };

  const consumerFacing = isConsumerFacing(ctx);

  const eligible = PROMPT_DIMENSIONS.filter((d) => {
    if (REQUIREMENTS[d](ctx)) return true;
    skipped.push({ dimension: d, reason: missingReason(d, ctx) });
    return false;
  });

  if (eligible.length === 0) {
    // Nothing eligible → every confirmed input is, trivially, a coverage gap.
    return {
      cells: [],
      skipped,
      requested: target,
      produced: 0,
      demand: { applied: false, ranked: [] },
      coverageGaps: computeCoverageGaps(ctx, []),
    };
  }

  // Heaviest first; ties broken by declaration order so the split is stable.
  const byWeight = [...eligible].sort(
    (a, b) =>
      DIMENSION_WEIGHTS[b] - DIMENSION_WEIGHTS[a] ||
      PROMPT_DIMENSIONS.indexOf(a) - PROMPT_DIMENSIONS.indexOf(b),
  );

  const quota = new Map<PromptDimension, number>();
  let funded: PromptDimension[];

  if (target < eligible.length) {
    // Scarce budget (the `trial` tiers). Weighting cannot help here — one prompt
    // each is the only split available — so spend it on the heaviest dimensions
    // and say plainly which angles went unmeasured. A thin prompt on all ten
    // would look like full coverage while being five coin flips.
    funded = byWeight.slice(0, target);
    for (const d of funded) quota.set(d, 1);
    for (const d of byWeight.slice(target)) {
      skipped.push({
        dimension: d,
        reason: `the ${target}-prompt tier only covers the ${target} heaviest-weighted dimensions`,
      });
    }
  } else {
    // Split the tier budget across eligible dimensions by weight.
    funded = eligible as PromptDimension[];
    const totalWeight = eligible.reduce((sum, d) => sum + DIMENSION_WEIGHTS[d], 0);
    let allocated = 0;
    for (const d of eligible) {
      const n = Math.max(1, Math.round((DIMENSION_WEIGHTS[d] / totalWeight) * target));
      quota.set(d, n);
      allocated += n;
    }
    // Trim/extend the rounding drift on the highest-weighted dimension.
    const heaviest = byWeight[0];
    quota.set(heaviest, Math.max(1, (quota.get(heaviest) ?? 1) + (target - allocated)));
  }

  const cells: MatrixCell[] = [];
  const seenPrompts = new Set<string>();
  // Cross-bucket near-duplicate guard (spec §3.3): two dimensions can converge
  // on the same wording in different word order / with different filler words
  // ("downsides of payroll" vs "payroll downsides"). `seenPrompts` only catches
  // exact matches; this collapses semantic duplicates, first occurrence winning.
  const seenDedupKeys = new Set<string>();

  for (const dimension of funded) {
    const want = quota.get(dimension) ?? 0;
    const rng = rngFromSeed(`${projectId}:${dimension}:${tier}`);
    const templates = templatesFor(dimension, consumerFacing);
    let produced = 0;

    // Walk templates round-robin so both registers are always represented,
    // rotating the interpolated values underneath them.
    for (let i = 0; produced < want && i < want * 6; i++) {
      const template = templates[i % templates.length];
      const vars = pickVars(ctx, rng, i, consumerFacing);
      const prompt = normalize(template.build(vars));

      if (!prompt || prompt.length < 6) continue;
      if (hasUnfilledSlot(prompt)) continue; // a required value was missing
      const key = prompt.toLowerCase();
      if (seenPrompts.has(key)) continue;
      const dkey = dedupKey(prompt);
      if (dkey && seenDedupKeys.has(dkey)) continue; // cross-bucket near-duplicate
      seenPrompts.add(key);
      if (dkey) seenDedupKeys.add(dkey);

      cells.push({
        prompt,
        dimension,
        funnelStage: DIMENSION_STAGE[dimension],
        persona: DIMENSION_PERSONA[dimension],
        meta: {
          dimension,
          register: template.register,
          // Per-template override for inherently-mixed dimensions (objection-trust);
          // every other dimension's templates are uniform, so the default holds.
          branding: template.branding ?? DIMENSION_BRANDING[dimension],
          service: interpolated(prompt, vars.service),
          competitor: interpolated(prompt, vars.competitor),
          icp: interpolated(prompt, vars.icp),
          geo: interpolated(prompt, vars.geo),
          vertical: interpolated(prompt, vars.vertical),
          template: template.id,
          refined: false,
        },
      });
      produced++;
    }

    if (produced < want) {
      skipped.push({
        dimension,
        reason:
          `only ${produced} of ${want} prompts could be built — the site context has ` +
          `${describeInputs(dimension, ctx)} to vary`,
      });
    }
  }

  return {
    cells,
    skipped,
    requested: target,
    produced: cells.length,
    demand: demandOrder ? { applied: true, ranked: demandOrder.ranked } : { applied: false, ranked: [] },
    coverageGaps: computeCoverageGaps(ctx, cells),
  };
}

/** Stopwords stripped before near-duplicate comparison — filler that carries no topic. */
const DEDUP_STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'of', 'for', 'in', 'to', 'with', 'is', 'are', 'do', 'does', 'i', 'we', 'my',
  'our', 'that', 'this', 'any', 'and', 'or', 'on', 'at', 'vs', 'how', 'what', 'which', 'who',
  'can', 'you', 'be', 'it', 'me', 'us', 'so', 'as', 'by', 'from', 'about',
]);

/**
 * Canonical key for cross-bucket near-duplicate detection: lowercase, strip
 * punctuation, drop stopwords, sort the remaining topic tokens. Two prompts
 * that say the same thing in a different order collapse to one key. Deterministic.
 */
export function dedupKey(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !DEDUP_STOPWORDS.has(t))
    .sort()
    .join(' ');
}

/**
 * spec §5.3 — which confirmed inputs reached no generated prompt. A value is
 * "covered" when it appears as a whole word/phrase in at least one cell's
 * prompt (word-boundary match, so a short market code like "US" is not matched
 * inside "business").
 */
function computeCoverageGaps(ctx: SiteContextData, cells: MatrixCell[]): CoverageGaps {
  const prompts = cells.map((c) => c.prompt.toLowerCase());
  const uncovered = (values: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
      const value = (raw ?? '').trim();
      if (!value) continue;
      const dedupe = value.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const re = new RegExp(`\\b${escapeRegExp(dedupe)}\\b`, 'i');
      if (!prompts.some((p) => re.test(p))) out.push(value);
    }
    return out;
  };
  return {
    services: uncovered(ctx.services),
    icpSegments: uncovered(ctx.icp),
    markets: uncovered(ctx.markets),
  };
}

/** Escape a value for safe insertion into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sort the client's services by measured search demand, highest first.
 *
 * Matching is deliberately blunt — a keyword and a service match when either
 * contains the other, normalised. Anything cleverer (stemming, fuzzy distance)
 * would start pairing things a human would not, and the cost of a wrong pairing
 * here is a matrix that emphasises the wrong offering.
 *
 * Services with no matching keyword keep their original relative order and sit
 * after the matched ones — absence of a volume figure is not evidence of low
 * demand, so they are held back, never dropped.
 */
function orderServicesByDemand(
  services: string[],
  demand: DemandIndex,
): { services: string[]; ranked: Array<{ service: string; volume: number }> } {
  const scored = services.map((service, i) => ({ service, i, volume: demandFor(service, demand) }));

  const sorted = [...scored].sort((a, b) => b.volume - a.volume || a.i - b.i);

  return {
    services: sorted.map((r) => r.service),
    ranked: sorted.filter((r) => r.volume > 0).map((r) => ({ service: r.service, volume: r.volume })),
  };
}

/** Highest volume among keywords that match this service. 0 when none do. */
function demandFor(service: string, demand: DemandIndex): number {
  const s = normalizeTerm(service);
  if (!s) return 0;
  let best = 0;
  for (const [keyword, volume] of demand) {
    const k = normalizeTerm(keyword);
    if (!k) continue;
    if (k === s || k.includes(s) || s.includes(k)) best = Math.max(best, volume);
  }
  return best;
}

/** Lowercase, strip punctuation, collapse whitespace. */
function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Turn an extracted pain/outcome into a clause that can sit inside a sentence.
 *
 * Two things to undo. Extracted text is a sentence fragment that may carry its
 * own terminal punctuation ("...they ask —"), which doubles up against the
 * template's own. And it is sentence-cased, which reads wrong mid-sentence:
 * "a service that solves No single owner of outcome". An initial capital is
 * lowered only when it is an ordinary sentence-initial one — an all-caps first
 * word ("AI visibility") or an internal capital ("RevOps gaps") is left alone,
 * because those are names, not sentence case.
 */
function asClause(text: string): string {
  const trimmed = text.replace(/[\s—–\-.,;:!?]+$/u, '').trim();
  if (!trimmed) return '';
  const [first] = trimmed.split(/\s+/);
  const ordinarySentenceCase = /^[A-Z][a-z]+$/.test(first);
  return ordinarySentenceCase ? trimmed[0].toLowerCase() + trimmed.slice(1) : trimmed;
}

/** The same text as a standalone statement: trimmed, with a leading capital. */
function asSentence(text: string): string {
  const trimmed = text.replace(/[\s—–\-.,;:!?]+$/u, '').trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : '';
}

/** Is this segment already plural? Shared by {@link withArticle} and {@link pluralize}. */
function isPlural(icp: string): boolean {
  const last = icp.trim().split(/\s+/).pop()!.toLowerCase();
  return /s$/.test(last) && !/(ss|us|is)$/.test(last);
}

/**
 * Pluralise an ICP segment for templates that talk about a group ("how do
 * other {icpPlural} deal with it"). Already-plural segments are returned
 * unchanged — appending an s produced "portfolio companiess".
 */
function pluralize(icp: string): string {
  if (!icp) return '';
  if (isPlural(icp)) return icp;
  return /(s|x|z|ch|sh)$/i.test(icp) ? icp + 'es' : icp + 's';
}

/**
 * Attach the right article to an ICP segment, or none when it is plural.
 * "a fund" / "an operator" / "lean teams" — never "a lean teams".
 */
function withArticle(icp: string): string {
  if (!icp) return '';
  if (isPlural(icp)) return icp;
  const head = icp.trim().split(/\s+/)[0].toLowerCase();
  return (/^[aeiou]/.test(head) ? 'an ' : 'a ') + icp;
}

/** Rotate through context values so cells vary without repeating. */
function pickVars(ctx: SiteContextData, rng: () => number, i: number, consumerFacing: boolean): Vars {
  const rotate = (pool: string[], fallback: string): string =>
    pool.length > 0 ? pool[i % pool.length] : fallback;

  // Category falls back to a real extracted service before it falls back to
  // nothing — a concrete offering the client actually sells is always a better
  // stand-in for their category than invented filler.
  const category = ctx.category || ctx.services[0] || '';
  // "small business" is a phrase B2B buyers really type; a B2C shopper never
  // says it about themselves, so a consumer-facing site falls back to a
  // segment phrase that actually reads naturally in "for {icp}"/"for a {icp}".
  const icpFallback = consumerFacing ? 'everyday shoppers' : FALLBACK.icp;
  const icp = ctx.icp.length > 0 ? ctx.icp[i % ctx.icp.length] : seededPick([icpFallback], rng);

  return {
    brand: ctx.brand,
    category,
    service: rotate(ctx.services, category),
    competitor: ctx.competitors.length > 0 ? ctx.competitors[i % ctx.competitors.length].name : '',
    icp,
    anIcp: withArticle(icp),
    icpPlural: pluralize(icp),
    geo: ctx.geo || FALLBACK.geo,
    vertical: ctx.vertical || FALLBACK.vertical,
    // Pains/outcomes are always interpolated mid-sentence, so they are
    // normalised into clauses (see asClause).
    pain: asClause(rotate(ctx.painPoints, FALLBACK.pain)),
    painSentence: asSentence(rotate(ctx.painPoints, FALLBACK.pain)),
    outcome: asClause(rotate(ctx.outcomes, FALLBACK.outcome)),
  };
}

/**
 * Record a variable on the cell's meta only when it actually landed in the
 * rendered prompt. Checking the output (rather than the template source) keeps
 * the categorisation truthful under bundling/minification.
 */
function interpolated(prompt: string, value: string): string | undefined {
  if (!value) return undefined;
  return prompt.toLowerCase().includes(value.toLowerCase()) ? value : undefined;
}

/**
 * A prompt with a collapsed empty slot ("who does  for  companies") means a
 * required value was missing. Dropped rather than shipped half-formed.
 */
function hasUnfilledSlot(prompt: string): boolean {
  return /\s{2,}/.test(prompt) || /\b(for|in|to|with|like|than|vs)\s*[?.]?$/i.test(prompt.trim());
}

/**
 * Collapse whitespace, tidy punctuation left by an empty interpolation, and fix
 * the article when an interpolated value starts with a vowel sound ("a AI
 * Visibility provider" → "an AI Visibility provider"). The LLM phrasing pass
 * would catch this too, but the template output has to read correctly on its
 * own — it is what ships when no key is configured.
 */
function normalize(prompt: string): string {
  return prompt
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.,!])/g, '$1')
    .replace(/\s+—\s+$/, '')
    .replace(/\ba (?=[aeiouAEIOU])/g, (match, offset: number, full: string) => {
      // "a European", "a user", "a one-off" keep "a" — those start with a
      // consonant sound despite the vowel letter.
      const rest = full.slice(offset + 2);
      return /^(eu|ur?i|use|user|uni|one|u[bcdfghjklmnpqrstvwxyz]|U[BCDFGHJKLMNPQRSTVWXYZ])/.test(rest) ? match : 'an ';
    })
    .trim();
}

/** Human explanation of why a dimension had nothing to work with. */
function missingReason(dimension: PromptDimension, ctx: SiteContextData): string {
  switch (dimension) {
    case 'service-discovery':
      return 'no services were extracted from the site';
    case 'category-best-of':
      return 'no category descriptor and no services were extracted';
    case 'competitor-alternatives':
    case 'head-to-head':
      return 'no competitors are recorded — add them to the project or re-run intake';
    case 'problem-framed':
      return 'no pain points were extracted (needs the LLM synthesis pass)';
    case 'job-to-be-done':
      return 'no outcomes were extracted (needs the LLM synthesis pass)';
    case 'geo-vertical':
      return 'neither a geo nor a vertical is known for the project';
    case 'buying-criteria':
      return 'neither a category nor any service was extracted';
    default:
      return 'required context is missing';
  }
}

/** What the dimension varies over, for the partial-fill message. */
function describeInputs(dimension: PromptDimension, ctx: SiteContextData): string {
  switch (dimension) {
    case 'competitor-alternatives':
    case 'head-to-head':
      return `only ${ctx.competitors.length} competitor(s)`;
    case 'service-discovery':
    case 'geo-vertical':
      return `only ${ctx.services.length} service(s)`;
    case 'problem-framed':
      return `only ${ctx.painPoints.length} pain point(s)`;
    case 'job-to-be-done':
      return `only ${ctx.outcomes.length} outcome(s)`;
    default:
      return 'too few distinct values';
  }
}
