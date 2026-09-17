/**
 * The versioned methodology for the `digital-performance` score family
 * (platform_improvement_plan.md §5.2–§5.4, phase P14).
 *
 * Weights, thresholds, sample minima and maximum source ages live HERE, as
 * configuration on a versioned `ScoreMethodology` row — not as constants in an
 * evaluator. §5.4 requires thresholds to be "configurable per metric version",
 * and §22 D01 keeps the six-bucket weighting an open product decision: a later
 * approved change is therefore a new methodology version, not a code rewrite.
 *
 * ⚠ The weights in `v1` are the PLAN'S PROPOSAL (§5.2's table), not a validated
 * universal score. §5.2: "These weights are a decision proposal, not a
 * scientifically validated universal score. Do not activate them until metric
 * definitions, feasible inputs, normalization curves, and sample thresholds are
 * approved." Activation is tracked by `WEIGHTS_ARE_APPROVED` below and surfaced
 * by the API, so no consumer can present an unapproved weighting as settled.
 *
 * The metric design gate that precedes this rubric — every submetric's business
 * question, formula, scope, curve, minimum sample, double-counting analysis and
 * versioned fixtures — is `docs/analysis/digital-performance-score.md`.
 *
 * @module digital-performance.methodology
 */

import type { MethodologyBucketConfig, MethodologyConfig } from './digital-performance.types';

/**
 * §22 D01 ("Score buckets and weighting") is still `Required before scoring
 * implementation/activation`. This flag is the single place that records that
 * fact in code; it is surfaced on every read model and never gates a write,
 * because the user asked for this work to be completed end to end.
 */
export const WEIGHTS_ARE_APPROVED = false;

/** Header text shown with the flag when the weights are still a proposal. */
export const WEIGHTS_APPROVAL_NOTE =
  'Bucket weights are the §5.2 proposal and remain a product decision (plan §22 D01). ' +
  'They are held as versioned configuration, so an approved change is a new methodology version.';

/**
 * Methodology v1 — the six-bucket proposal with the arithmetic from
 * docs/analysis/digital-performance-score.md.
 *
 * Social cadence is per channel on purpose: §5.3 "Social cadence must reflect
 * an agreed cadence per channel; a B2B business must not be penalized for not
 * posting daily on TikTok."
 */
const V1_BUCKETS: MethodologyBucketConfig[] = [
  {
    key: 'website-health',
    label: 'Website health',
    weight: 25,
    metricVersion: 'website-health/1',
    maxAgeDays: 30,
    minSample: 3,
    detailPath: '/results/website',
    detailQuery: null as unknown as string,
    scope: {
      property: 'the project domain as crawled by the technical audit',
      pages: 'every sitemap URL the newest crawl fetched',
      excludes: 'Google visitor volume — that belongs to Analytics, not to page retrievability',
    },
    thresholds: { pageStatus: 200, pageScoreFloor: 60 },
  },
  {
    key: 'google-visibility',
    label: 'Google visibility',
    weight: 20,
    metricVersion: 'google-visibility/1',
    maxAgeDays: 30,
    minSample: 5,
    detailPath: '/results/website',
    detailQuery: 'tab=google',
    scope: {
      service: 'search-console',
      kind: 'page-query-date',
      querySource: 'all-queries-in-window',
      excludes: 'paid/advertiser competition — Search Console rows are organic only',
    },
    thresholds: { positionTarget: 20, minImpressions: 1 },
  },
  {
    key: 'ai-visibility',
    label: 'AI visibility',
    weight: 20,
    metricVersion: 'ai-visibility/1',
    maxAgeDays: 30,
    minSample: 5,
    detailPath: '/results/ai-visibility',
    detailQuery: null as unknown as string,
    scope: {
      surfaces: 'every surface of the newest completed audit',
      questions: 'the audit\'s own question sample (QuerySet source="aeo-matrix")',
      excludes: 'a promise of ranking in every AI system — this is the measured sample, not the category',
    },
    thresholds: {
      mentionStances: [
        'recommended-primary',
        'recommended-alternative',
        'mentioned-neutral',
        'mentioned-negative',
      ],
      recommendationStances: ['recommended-primary', 'recommended-alternative'],
    },
  },
  {
    key: 'online-profiles',
    label: 'Online profiles',
    weight: 15,
    metricVersion: 'online-profiles/1',
    maxAgeDays: 90,
    minSample: 1,
    detailPath: '/results/online-presence',
    detailQuery: null as unknown as string,
    scope: {
      entity: 'company',
      countedStates: ['confirmed', 'unverified', 'missing'],
      excludes: 'candidate rows (an unanswered question, not an account) and a raw count of platforms',
    },
    thresholds: { verifiedStatusCode: 200 },
  },
  {
    key: 'social-activity',
    label: 'Social activity',
    weight: 10,
    metricVersion: 'social-activity/1',
    maxAgeDays: 30,
    minSample: 1,
    detailPath: '/results/online-presence',
    detailQuery: 'tab=social',
    scope: {
      channels: 'confirmed company accounts whose platform has an agreed cadence below',
      windowDays: 28,
      excludes: 'raw follower count as a success score; engagement is recorded but not scored',
    },
    thresholds: {
      windowDays: 28,
      /** Default cadence when a platform has no explicit entry. */
      defaultPostsPerWeek: 1,
      /**
       * Agreed cadence per channel. §5.3: configurable per metric version. A
       * B2B business on LinkedIn is not held to an Instagram consumer cadence.
       */
      channelPostsPerWeek: {
        linkedin: 2,
        instagram: 3,
        facebook: 1,
        twitter: 1,
        youtube: 1,
        tiktok: 1,
      },
    },
  },
  {
    key: 'content-quality',
    label: 'Content quality',
    weight: 10,
    metricVersion: 'content-quality/1',
    maxAgeDays: 180,
    minSample: 1,
    detailPath: '/results/content',
    detailQuery: null as unknown as string,
    scope: {
      sample: 'approved content briefs — the agreed important content for this project',
      revisions: 'the latest saved revision of each content asset',
      excludes: 'the mere count of drafts generated',
    },
    thresholds: { wordTargetFloor: 0.8 },
  },
];

/** Methodology v1 config, as seeded on first use. */
export const DIGITAL_PERFORMANCE_V1: MethodologyConfig = {
  rounding: 'half-up at the final displayed total and the evidence-coverage figure only',
  buckets: V1_BUCKETS,
};

/** Build a copy of the v1 config for seeding (callers may adjust then persist). */
export function defaultMethodologyConfig(): MethodologyConfig {
  return JSON.parse(JSON.stringify(DIGITAL_PERFORMANCE_V1)) as MethodologyConfig;
}

/**
 * Parse a stored methodology `config` JSON column defensively. A malformed or
 * shape-less config throws rather than silently falling back to defaults: a run
 * calculated against thresholds nobody wrote would be a fabricated number.
 */
export function parseMethodologyConfig(raw: string): MethodologyConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Score methodology config is not valid JSON: ' + (e as Error).message);
  }
  const config = parsed as MethodologyConfig;
  if (!config || typeof config !== 'object' || !Array.isArray(config.buckets) || config.buckets.length === 0) {
    throw new Error('Score methodology config has no buckets');
  }
  const seen = new Set<string>();
  for (const bucket of config.buckets) {
    if (!bucket || typeof bucket.key !== 'string' || typeof bucket.weight !== 'number') {
      throw new Error('Score methodology config has a bucket without key/weight');
    }
    if (seen.has(bucket.key)) throw new Error('Score methodology config repeats bucket ' + bucket.key);
    seen.add(bucket.key);
    if (typeof bucket.metricVersion !== 'string' || typeof bucket.maxAgeDays !== 'number' || typeof bucket.minSample !== 'number') {
      throw new Error('Score methodology bucket ' + bucket.key + ' is missing metricVersion/maxAgeDays/minSample');
    }
  }
  const weightSum = config.buckets.reduce((sum, b) => sum + b.weight, 0);
  if (weightSum !== 100) {
    throw new Error('Score methodology bucket weights must sum to 100 — got ' + weightSum);
  }
  return config;
}

// ─── Deterministic arithmetic helpers ────────────────────────────────────────
// Shared by every evaluator so "how do you round?" has exactly one answer.

/**
 * Round half-up. §5.3 rule 5: "round only the final displayed result", so this
 * is applied to a bucket's own submetric values, to the bucket mean, and to the
 * run total and coverage — never to an intermediate contribution.
 *
 * `Math.round` is already half-up for positive numbers; it is spelled out here
 * so the intent survives a future refactor and so the negative case (which
 * never occurs — every metric here is non-negative) is explicit rather than
 * inherited.
 */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

/** Exact percentage 0-100, half-up. Returns null when the denominator is 0 — never a 0 standing in for "unknown". */
export function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return roundHalfUp((numerator / denominator) * 100);
}

/** Mean of the submetrics that actually produced a value, half-up. Null when none did. */
export function meanOfScored(values: Array<number | null>): number | null {
  const scored = values.filter((v): v is number => v !== null);
  if (scored.length === 0) return null;
  return roundHalfUp(scored.reduce((a, b) => a + b, 0) / scored.length);
}

/** Whole days between two instants, floored — used for source ages and staleness. */
export function ageInDays(observedAt: Date | null, now: Date): number | null {
  if (!observedAt) return null;
  return Math.floor((now.getTime() - observedAt.getTime()) / 86_400_000);
}
