/**
 * The six deterministic bucket evaluators for the `digital-performance` score
 * family (platform_improvement_plan.md §5.3–§5.4, phase P14).
 *
 * Hard rules this file enforces:
 * - **§5.3 rule 3 — LLM prose never sets a score.** Every value below is an
 *   exact count over stored rows. No evaluator calls a model, and no evaluator
 *   reads a narrative field.
 * - **§5.3 rule 5 — round only the final displayed result.** Submetric values
 *   are exact percentages; a bucket value is the half-up mean of its scored
 *   submetrics; the run total and the coverage figure are the only other
 *   rounding points. `contribution` is deliberately stored unrounded.
 * - **"Unknown" is not zero.** A submetric with a zero denominator is EXCLUDED
 *   and says why. A submetric whose denominator is real and whose numerator is
 *   zero is an observed zero and scores 0 — a different fact, recorded
 *   differently. This is the distinction §5.3's "unknown vs observed zero"
 *   requirement turns on.
 * - **A missing source is never a zero.** The state machine below returns
 *   `not-measured`/`outdated`/`failed` with a reason; `value` stays null.
 *
 * The formulas, their business questions, scopes, curves, sample minima and
 * double-counting analysis are specified in
 * `docs/analysis/digital-performance-score.md`, which is the §5.4 metric design
 * gate for this rubric.
 *
 * @module digital-performance.buckets
 */

import {
  ageInDays,
  meanOfScored,
  percent,
  roundHalfUp,
} from './digital-performance.methodology';
import type {
  AiVisibilitySource,
  ContentQualitySource,
  GoogleVisibilitySource,
  OnlineProfilesSource,
  SocialActivitySource,
  WebsiteHealthSource,
} from './digital-performance.sources';
import type {
  BucketEvaluation,
  BucketState,
  MethodologyBucketConfig,
  MetricInput,
  SourceRef,
} from './digital-performance.types';

// ─── Shared helpers ─────────────────────────────────────────────────────────

function num(thresholds: Record<string, unknown>, key: string, fallback: number): number {
  const v = thresholds[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strArray(thresholds: Record<string, unknown>, key: string): string[] {
  const v = thresholds[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function maxDate(dates: Array<Date | null | undefined>): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d.getTime() > out.getTime())) out = d;
  return out;
}

function sourceRef(kind: string, ref: string, observedAt: Date | null, now: Date): SourceRef {
  return {
    kind,
    ref,
    observedAt: observedAt ? observedAt.toISOString() : null,
    ageDays: ageInDays(observedAt, now),
  };
}

/**
 * §5.3's five distinct bucket states, resolved in one documented order.
 *
 * Precedence (and why):
 *  1. `failed` — a required source reported its own failure on an attempt newer
 *     than its last success. This outranks staleness because "we tried and it
 *     broke" needs a human, and because silently falling back to a stale number
 *     while the refresh is broken is exactly the smoothing §5.3 rule 4 forbids.
 *  2. `not-measured` — no successful source record at all.
 *  3. `outdated` — a successful record exists but is older than `maxAgeDays`.
 *  4. `not-measured` — the source is present and fresh but its denominator is
 *     below `minSample` (too small a sample to score without inventing one).
 *  5. `measured`.
 *
 * `not-applicable` is decided BEFORE evaluation (see the service): it comes
 * from a recorded decision with a reason, never from this function.
 */
export function resolveState(
  evaluation: BucketEvaluation,
  bucket: MethodologyBucketConfig,
  now: Date,
): { state: BucketState; value: number | null; missingReasons: string[] } {
  const missingReasons = [...evaluation.missingReasons];

  const attemptIsNewer =
    evaluation.latestAttemptAt !== null &&
    (evaluation.latestSuccessAt === null ||
      evaluation.latestAttemptAt.getTime() > evaluation.latestSuccessAt.getTime());

  if (evaluation.latestAttemptFailed && attemptIsNewer) {
    return {
      state: 'failed',
      value: null,
      missingReasons: [
        evaluation.failureReason ?? 'The source reported a failure on its most recent attempt',
        ...missingReasons,
      ],
    };
  }

  if (!evaluation.hasSource || evaluation.latestSuccessAt === null) {
    return {
      state: 'not-measured',
      value: null,
      missingReasons: [evaluation.absentReason ?? 'No stored source data for this bucket yet', ...missingReasons],
    };
  }

  const age = ageInDays(evaluation.latestSuccessAt, now) ?? 0;
  if (age > bucket.maxAgeDays) {
    return {
      state: 'outdated',
      value: null,
      missingReasons: [
        'The newest source data is ' +
          age +
          ' days old, past the ' +
          bucket.maxAgeDays +
          '-day maximum age for ' +
          bucket.metricVersion +
          '. A stale number is not shown as if it were current.',
        ...missingReasons,
      ],
    };
  }

  if (evaluation.sample < bucket.minSample) {
    return {
      state: 'not-measured',
      value: null,
      missingReasons: [
        'Only ' +
          evaluation.sample +
          ' usable observation(s); ' +
          bucket.metricVersion +
          ' needs at least ' +
          bucket.minSample +
          ' to score. Below that the bucket is unmeasured, not zero.',
        ...missingReasons,
      ],
    };
  }

  const value = meanOfScored(evaluation.submetrics.filter((s) => s.scored).map((s) => s.value));
  if (value === null) {
    return {
      state: 'not-measured',
      value: null,
      missingReasons: ['Source data was present but no submetric produced a value', ...missingReasons],
    };
  }

  return { state: 'measured', value, missingReasons };
}

// ─── 1. Website health (weight 25) ──────────────────────────────────────────

export function evaluateWebsiteHealth(
  source: WebsiteHealthSource,
  bucket: MethodologyBucketConfig,
  now: Date,
): BucketEvaluation {
  const pageStatus = num(bucket.thresholds, 'pageStatus', 200);
  const pageScoreFloor = num(bucket.thresholds, 'pageScoreFloor', 60);

  const totalPages = source.pages.length;
  const retrieved = source.pages.filter((p) => p.status === pageStatus);
  const scored = retrieved.filter((p) => p.score !== null && p.score >= pageScoreFloor);

  const submetrics: MetricInput[] = [
    {
      id: 'page-retrievability',
      question: "Of the pages the site's own sitemap lists, how many can actually be fetched?",
      scored: true,
      numerator: retrieved.length,
      denominator: totalPages,
      units: 'percent of sitemap pages fetched with HTTP ' + pageStatus,
      rounding: 'half-up to a whole percent',
      value: percent(retrieved.length, totalPages),
      ...(totalPages === 0
        ? { excluded: 'the crawl stored no pages, so there is no denominator' }
        : {}),
    },
    {
      id: 'page-quality',
      question: 'Of the pages that load, how many clear the per-page quality floor?',
      scored: true,
      numerator: scored.length,
      denominator: retrieved.length,
      units: 'percent of retrievable pages scoring at least ' + pageScoreFloor + '/100',
      rounding: 'half-up to a whole percent',
      value: percent(scored.length, retrieved.length),
      ...(retrieved.length === 0
        ? { excluded: 'no page could be fetched, so page quality has no denominator — this is unknown, not zero' }
        : {}),
      facts: { pageScoreFloor, pagesCrawled: totalPages, pagesRetrieved: retrieved.length },
    },
  ];

  return {
    hasSource: source.auditId !== null,
    latestSuccessAt: source.crawledAt,
    latestAttemptAt: source.crawledAt,
    latestAttemptFailed: false,
    absentReason:
      'No technical audit has been run for this project, so no page has been observed. Website health cannot be scored.',
    submetrics,
    sources: source.auditId
      ? [sourceRef('TechnicalAudit', source.auditId, source.crawledAt, now), sourceRef('AuditPage', String(totalPages) + ' pages', source.crawledAt, now)]
      : [],
    notes: [
      'Measured from the newest crawl: whether pages can be reached and whether each clears a fixed per-page quality floor.',
      'Google visitor volume is deliberately NOT part of this bucket — page traffic belongs to Analytics and would double-count Google visibility.',
    ],
    missingReasons: [],
    sample: totalPages,
    windowStart: source.crawledAt,
    windowEnd: source.crawledAt,
  };
}

// ─── 2. Google visibility (weight 20) ───────────────────────────────────────

export function evaluateGoogleVisibility(
  source: GoogleVisibilitySource,
  bucket: MethodologyBucketConfig,
  now: Date,
): BucketEvaluation {
  const positionTarget = num(bucket.thresholds, 'positionTarget', 20);
  const minImpressions = num(bucket.thresholds, 'minImpressions', 1);

  // Aggregate to query grain: the stored facts are page/query/date/country/device
  // rows, and a query's position is its impression-weighted average across them.
  const byQuery = new Map<string, { impressions: number; weightedPosition: number }>();
  for (const f of source.facts) {
    const agg = byQuery.get(f.query) ?? { impressions: 0, weightedPosition: 0 };
    agg.impressions += f.impressions;
    agg.weightedPosition += f.impressions * f.position;
    byQuery.set(f.query, agg);
  }

  const measured = [...byQuery.values()].filter((q) => q.impressions >= minImpressions);
  const onTarget = measured.filter(
    (q) => q.impressions > 0 && q.weightedPosition / q.impressions <= positionTarget,
  );

  const submetrics: MetricInput[] = [
    {
      id: 'queries-on-target',
      question:
        'Of the searches this site is actually visible for, how many show up at position ' +
        positionTarget +
        ' or better?',
      scored: true,
      numerator: onTarget.length,
      denominator: measured.length,
      units: 'percent of measured queries whose impression-weighted position is at most ' + positionTarget,
      rounding: 'half-up to a whole percent',
      value: percent(onTarget.length, measured.length),
      ...(measured.length === 0
        ? { excluded: 'no stored query had any impressions, so there is no denominator' }
        : {}),
      facts: { positionTarget, minImpressions, storedRows: source.rowCount },
    },
  ];

  const notes = [
    'Measured from the organic Search Console snapshot only — paid/advertiser competition is never mixed into organic position.',
    'A query\'s position is its impression-weighted average across every stored page/date/country/device row for that query.',
  ];
  if (source.snapshotId && !source.complete) {
    notes.push(
      'The stored Search Console snapshot is a partial fetch: the provider reported more rows than were stored, so the measured query set is the rows that were fetched, not the property\'s whole query list.',
    );
  }
  notes.push(
    'Scope for this version is every query with at least one impression in the stored window. Narrowing to an operator-approved query set is a documented v1 limitation (see the scoring analysis document), not an unstated assumption.',
  );

  return {
    hasSource: source.snapshotId !== null,
    latestSuccessAt: source.fetchedAt,
    latestAttemptAt: source.fetchedAt,
    // A Search Console sync that fails writes no snapshot at all, so there is no
    // failure record at this grain to read — the honest state for that is
    // `not-measured` ("we have no stored data"), never a fabricated failure.
    latestAttemptFailed: false,
    absentReason:
      'No stored Search Console data for this project. Either the property is not connected or the explicit Website sync has not been run — the score reads stored facts and never calls Google itself.',
    submetrics,
    sources: source.snapshotId
      ? [
          sourceRef('GoogleDataSnapshot:search-console:page-query-date', source.snapshotId, source.fetchedAt, now),
          sourceRef(
            'GSC window',
            (source.windowStart ?? '?') + ' to ' + (source.windowEnd ?? '?') + ' (' + (source.timezoneNote ?? 'timezone not recorded') + ')',
            source.fetchedAt,
            now,
          ),
        ]
      : [],
    notes,
    missingReasons: [],
    sample: measured.length,
    windowStart: parseGscDate(source.windowStart),
    windowEnd: parseGscDate(source.windowEnd) ?? source.fetchedAt,
  };
}

/** GSC reports date-only Pacific strings; they are stored as UTC midnights and never relabeled as another zone. */
function parseGscDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ─── 3. AI visibility (weight 20) ───────────────────────────────────────────

export function evaluateAiVisibility(
  source: AiVisibilitySource,
  bucket: MethodologyBucketConfig,
  now: Date,
): BucketEvaluation {
  const mentionStances = strArray(bucket.thresholds, 'mentionStances');
  const recommendationStances = strArray(bucket.thresholds, 'recommendationStances');

  const total = source.stances.length;
  const mentioned = source.stances.filter((s) => mentionStances.includes(s.stance));
  const recommended = source.stances.filter((s) => recommendationStances.includes(s.stance));

  const submetrics: MetricInput[] = [
    {
      id: 'mention-rate',
      question: 'In the agreed customer-question sample, how often is the business named at all?',
      scored: true,
      numerator: mentioned.length,
      denominator: total,
      units: 'percent of judged answers that name the business',
      rounding: 'half-up to a whole percent',
      value: percent(mentioned.length, total),
      ...(total === 0 ? { excluded: 'no answer has been judged yet, so there is no denominator' } : {}),
    },
    {
      id: 'recommendation-rate',
      question: 'In the same sample, how often is the business recommended rather than only mentioned?',
      scored: true,
      numerator: recommended.length,
      denominator: total,
      units: 'percent of judged answers that recommend the business',
      rounding: 'half-up to a whole percent',
      value: percent(recommended.length, total),
      ...(total === 0 ? { excluded: 'no answer has been judged yet, so there is no denominator' } : {}),
      facts: { mentionStances: mentionStances.join(', '), recommendationStances: recommendationStances.join(', ') },
    },
  ];

  const latestSuccessAt = source.latestCompleted?.finishedAt ?? null;
  const failed = source.status === 'failed';

  return {
    hasSource: source.latestCompleted !== null,
    latestSuccessAt,
    latestAttemptAt: source.attemptedAt,
    latestAttemptFailed: failed,
    failureReason: failed
      ? 'The most recent AI-visibility audit reported failure' +
        (source.error ? ': ' + source.error : '') +
        '. Its answers were never measured, so this bucket is failed rather than scored from an older sample.'
      : undefined,
    absentReason:
      'No completed AI-visibility audit for this project, so no customer question has been measured.',
    submetrics,
    sources: source.latestCompleted
      ? [
          sourceRef('AeoAudit', source.latestCompleted.id, latestSuccessAt, now),
          sourceRef('AeoStance', String(total) + ' judged answers', latestSuccessAt, now),
          sourceRef('surfaces measured', source.surfaces.join(', ') || 'none recorded', latestSuccessAt, now),
        ]
      : [],
    notes: [
      'Counts of stored judged answers only. The judging model wrote the stance label that is counted; no model output sets this score.',
      'This measures the agreed sample of customer questions on the surfaces that were actually run. It is not a promise of ranking in every AI system.',
      ...(source.markets.length > 0 ? ['Markets measured: ' + source.markets.join(', ') + '.'] : []),
    ],
    missingReasons: [],
    sample: total,
    windowStart: latestSuccessAt,
    windowEnd: latestSuccessAt,
  };
}

// ─── 4. Online profiles (weight 15) ─────────────────────────────────────────

export function evaluateOnlineProfiles(
  source: OnlineProfilesSource,
  bucket: MethodologyBucketConfig,
  now: Date,
): BucketEvaluation {
  const verifiedStatusCode = num(bucket.thresholds, 'verifiedStatusCode', 200);

  const accounts = source.accounts;
  const confirmed = accounts.filter((a) => a.state === 'confirmed');
  const withEvidence = confirmed.filter((a) => a.verifiedAt !== null && a.statusCode === verifiedStatusCode);
  const newest = maxDate(accounts.map((a) => a.updatedAt));

  const submetrics: MetricInput[] = [
    {
      id: 'confirmed-share',
      question: 'Of the accounts we know about, how many has someone actually confirmed are yours?',
      scored: true,
      numerator: confirmed.length,
      denominator: accounts.length,
      units: 'percent of known company accounts in state confirmed',
      rounding: 'half-up to a whole percent',
      value: percent(confirmed.length, accounts.length),
      ...(accounts.length === 0 ? { excluded: 'no account has been inventoried, so there is no denominator' } : {}),
      facts: {
        confirmed: confirmed.length,
        unverified: accounts.filter((a) => a.state === 'unverified').length,
        missing: accounts.filter((a) => a.state === 'missing').length,
      },
    },
    {
      id: 'verification-evidence',
      question: 'Of the accounts we call confirmed, how many carry the evidence that confirmed them?',
      scored: true,
      numerator: withEvidence.length,
      denominator: confirmed.length,
      units: 'percent of confirmed accounts holding a verification timestamp and a HTTP ' + verifiedStatusCode + ' read',
      rounding: 'half-up to a whole percent',
      value: percent(withEvidence.length, confirmed.length),
      ...(confirmed.length === 0
        ? { excluded: 'nothing is confirmed yet, so there is no confirmed account whose evidence could be missing' }
        : {}),
    },
  ];

  const failed = source.discoveryFailedAt !== null && (newest === null || source.discoveryFailedAt.getTime() > newest.getTime());

  return {
    hasSource: accounts.length > 0,
    latestSuccessAt: newest,
    latestAttemptAt: source.discoveryFailedAt ?? newest,
    latestAttemptFailed: failed,
    failureReason: failed
      ? 'The most recent account discovery run reported failure' +
        (source.discoveryError ? ': ' + source.discoveryError : '') +
        '. The inventory has not been refreshed, so this bucket is failed rather than scored from an older inventory.'
      : undefined,
    absentReason:
      'No company accounts have been inventoried for this project yet. A missing inventory is unknown, not zero accounts.',
    submetrics,
    sources: [
      sourceRef('PresenceAccount', String(accounts.length) + ' known company accounts', newest, now),
      ...(confirmed.length > 0
        ? [sourceRef('PresenceAccount:confirmed', String(confirmed.length) + ' confirmed', maxDate(confirmed.map((a) => a.verifiedAt)), now)]
        : []),
    ],
    notes: [
      'Counts confirmed accounts and whether the confirmation carries evidence. It is deliberately not a count of platforms: more listings is not a better business.',
      'Candidate rows are excluded — an unconfirmed candidate is a question, not an account.',
    ],
    missingReasons: [],
    sample: accounts.length,
    windowStart: null,
    windowEnd: newest,
  };
}

// ─── 5. Social activity (weight 10) ─────────────────────────────────────────

export function evaluateSocialActivity(
  source: SocialActivitySource,
  bucket: MethodologyBucketConfig,
  now: Date,
): BucketEvaluation {
  const windowDays = num(bucket.thresholds, 'windowDays', 28);
  const defaultCadence = num(bucket.thresholds, 'defaultPostsPerWeek', 1);
  const rawCadence = bucket.thresholds['channelPostsPerWeek'];
  const channelCadence: Record<string, number> =
    rawCadence && typeof rawCadence === 'object' ? (rawCadence as Record<string, number>) : {};

  const cadenceFor = (platform: string): number => {
    const v = channelCadence[platform];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : defaultCadence;
  };

  // Scope: only confirmed company accounts define a channel, and only channels
  // with an agreed cadence are scored.
  const channels = new Map<string, { accountId: string; agreedPerWeek: number }>();
  for (const c of source.channels) {
    if (!channels.has(c.platform)) channels.set(c.platform, { accountId: c.accountId, agreedPerWeek: cadenceFor(c.platform) });
  }

  const windowEnd = maxDate(source.posts.map((p) => p.fetchedAt));
  const windowStart = windowEnd ? new Date(windowEnd.getTime() - windowDays * 86_400_000) : null;

  const submetrics: MetricInput[] = [];
  const unobserved: string[] = [];
  let observedChannels = 0;

  for (const [platform, channel] of [...channels.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = source.posts.filter((p) => p.platform === platform && p.fetchedAt !== null);
    if (rows.length === 0) {
      unobserved.push(platform);
      continue;
    }
    observedChannels += 1;

    const channelEnd = maxDate(rows.map((p) => p.fetchedAt)) as Date;
    const channelStart = new Date(channelEnd.getTime() - windowDays * 86_400_000);
    const posts = rows.filter(
      (p) => p.kind === 'post' && p.postedAt !== null && p.postedAt >= channelStart && p.postedAt <= channelEnd,
    );
    const perWeek = posts.length / (windowDays / 7);
    // Capped at 100: posting past the agreed cadence is not extra credit.
    const value = Math.min(100, roundHalfUp((perWeek / channel.agreedPerWeek) * 100));

    submetrics.push({
      id: 'cadence:' + platform,
      question:
        'Does the business post on ' + platform + ' at least as often as the cadence agreed for that channel?',
      scored: true,
      numerator: posts.length,
      denominator: roundHalfUp(channel.agreedPerWeek * (windowDays / 7)),
      units: 'observed posts in the last ' + windowDays + ' days against an agreed ' + channel.agreedPerWeek + '/week',
      rounding: 'half-up to a whole percent, capped at 100',
      value,
      facts: {
        postsPerWeek: Number(perWeek.toFixed(3)),
        agreedPostsPerWeek: channel.agreedPerWeek,
        windowStart: channelStart.toISOString(),
        windowEnd: channelEnd.toISOString(),
      },
    });
  }

  // Facts that are recorded but deliberately NOT scored: §5.2 rules out raw
  // follower count as a success score, and no defensible comparison dataset
  // exists to turn engagement into a score (see the analysis document).
  const windowPosts = source.posts.filter(
    (p) => p.kind === 'post' && p.postedAt !== null && windowStart !== null && windowEnd !== null && p.postedAt >= windowStart && p.postedAt <= windowEnd,
  );
  const likes = windowPosts.map((p) => p.likeCount).filter((v): v is number => v !== null);
  const comments = windowPosts.map((p) => p.commentCount).filter((v): v is number => v !== null);
  const followers = source.posts.map((p) => p.followerCount).filter((v): v is number => v !== null);
  submetrics.push({
    id: 'engagement-facts',
    question: 'How much engagement did the observed posts actually receive?',
    scored: false,
    numerator: windowPosts.length,
    denominator: null,
    units: 'recorded counts, not scored',
    rounding: 'not applicable — this submetric is never scored',
    value: null,
    excluded:
      'Recorded for the reader and deliberately NOT scored: no defensible comparison dataset exists for engagement, and raw follower count is explicitly not a success score (§5.2).',
    facts: {
      postsInWindow: windowPosts.length,
      medianLikes: median(likes),
      medianComments: median(comments),
      maxFollowersSeen: followers.length > 0 ? Math.max(...followers) : null,
    },
  });

  const notes = [
    'Cadence is compared against an agreed per-channel figure from the methodology version, not a single global target — a B2B account on LinkedIn is not held to an Instagram consumer cadence.',
    'Posting beyond the agreed cadence does not earn extra credit; the submetric is capped at 100.',
    'Engagement counts are recorded as facts and are not scored.',
  ];
  if (unobserved.length > 0) {
    notes.push(
      'Not fetched in this window, so excluded from the average rather than scored as zero: ' +
        unobserved.join(', ') +
        '. Their activity is unknown, not absent.',
    );
  }
  notes.push('Raw follower count is never used as a score.');

  return {
    hasSource: observedChannels > 0,
    latestSuccessAt: windowEnd,
    latestAttemptAt: source.discoveryFailedAt ?? windowEnd,
    latestAttemptFailed:
      source.discoveryFailedAt !== null && (windowEnd === null || source.discoveryFailedAt.getTime() > windowEnd.getTime()),
    failureReason:
      source.discoveryFailedAt !== null
        ? 'The most recent social-activity collection reported failure' +
          (source.discoveryError ? ': ' + source.discoveryError : '') +
          '. This bucket is failed rather than scored from an older pull.'
        : undefined,
    absentReason:
      channels.size === 0
        ? 'No confirmed company account on a channel with an agreed cadence, so there is no agreed social channel to measure.'
        : 'No social-activity data has been collected for the channels in scope, so their cadence is unknown rather than zero.',
    submetrics,
    sources: [
      sourceRef(
        'channels in scope',
        channels.size === 0 ? 'none' : [...channels.keys()].sort().join(', '),
        windowEnd,
        now,
      ),
      sourceRef('PresencePost', String(source.posts.length) + ' stored rows', windowEnd, now),
    ],
    notes,
    missingReasons: [],
    sample: observedChannels,
    windowStart,
    windowEnd,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : roundHalfUp((sorted[mid - 1] + sorted[mid]) / 2);
}

// ─── 6. Content quality (weight 10) ─────────────────────────────────────────

export function evaluateContentQuality(
  source: ContentQualitySource,
  bucket: MethodologyBucketConfig,
  now: Date,
): BucketEvaluation {
  const wordTargetFloor = num(bucket.thresholds, 'wordTargetFloor', 0.8);

  const briefs = source.briefs;
  const briefById = new Map(briefs.map((b) => [b.id, b]));
  const covered = new Set(source.revisions.map((r) => r.briefId).filter((id): id is string => id !== null));

  const withTarget = source.revisions.filter((r) => {
    const brief = r.briefId ? briefById.get(r.briefId) : undefined;
    return brief !== undefined && brief.wordTarget !== null && brief.wordTarget > 0;
  });
  const met = withTarget.filter((r) => {
    const brief = briefById.get(r.briefId as string);
    return brief !== undefined && brief.wordTarget !== null && r.wordCount >= wordTargetFloor * brief.wordTarget;
  });

  const newest = maxDate(briefs.map((b) => b.updatedAt));
  const submetrics: MetricInput[] = [
    {
      id: 'brief-coverage',
      question: 'Of the pieces the client agreed to produce, how many have written content against them?',
      scored: true,
      numerator: briefs.filter((b) => covered.has(b.id)).length,
      denominator: briefs.length,
      units: 'percent of approved briefs with at least one saved revision',
      rounding: 'half-up to a whole percent',
      value: percent(briefs.filter((b) => covered.has(b.id)).length, briefs.length),
      ...(briefs.length === 0 ? { excluded: 'no approved brief, so there is no agreed content set to cover' } : {}),
      facts: { approvedBriefs: briefs.length },
    },
    {
      id: 'brief-target-met',
      question: 'Of the written pieces with an agreed length, how many reached that length?',
      scored: true,
      numerator: met.length,
      denominator: withTarget.length,
      units: 'percent of the latest revisions reaching ' + wordTargetFloor + ' × the brief word target',
      rounding: 'half-up to a whole percent',
      value: percent(met.length, withTarget.length),
      ...(withTarget.length === 0
        ? { excluded: 'no brief carried a word target, so there is nothing to hold the writing to' }
        : {}),
      facts: { wordTargetFloor, revisionsWithTarget: withTarget.length },
    },
  ];

  return {
    hasSource: briefs.length > 0,
    latestSuccessAt: newest,
    latestAttemptAt: newest,
    latestAttemptFailed: false,
    absentReason:
      'No content brief has been approved for this project, so there is no agreed important-content set to measure. A content score without an agreed set would only measure how much was drafted.',
    submetrics,
    sources: [
      sourceRef('ContentBrief:approved', String(briefs.length) + ' approved briefs', newest, now),
      sourceRef('ContentRevision', String(source.revisions.length) + ' latest revisions', maxDate(source.revisions.map((r) => r.createdAt)), now),
    ],
    notes: [
      'Measured against the agreed brief set and each brief\'s own word target — the client\'s target, not an industry benchmark invented here.',
      'The number of drafts generated is deliberately NOT scored (§5.2).',
      'Only the latest revision of each content asset is counted: an earlier draft\'s word count is not the delivered content.',
    ],
    missingReasons: [],
    sample: briefs.length,
    windowStart: null,
    windowEnd: newest,
  };
}
