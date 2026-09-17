/**
 * DigitalPerformanceService — the Cailyx `digital-performance` score family
 * (platform_improvement_plan.md §5.2–§5.5, phase P14).
 *
 * This is a SEPARATE family from the five-dimension `ScoringService` roll-up.
 * §5.2: "Introduce an explicit score family and methodology version, for example
 * `digital-performance / 1`, while preserving existing `ScoreRun` history and
 * rubric versions. … Old reports retain their old score name/methodology; no
 * historical record is rewritten." Nothing in this file touches `ScoreRun`,
 * `ScoreRubric`, `ScoringService` or any report row.
 *
 * The §5.3 calculation contract, in order:
 *  1. Applicability comes from a confirmed business profile plus the project's
 *     recorded scoring configuration. "Not relevant" is a recorded decision with
 *     a reason, never inferred from missing data.
 *  2. Each applicable bucket is checked for the required sources, fresh enough
 *     evidence, a minimum sample and a valid metric version.
 *  3. Each valid bucket is calculated with its deterministic submetric formula.
 *     LLM prose never sets a score.
 *  4. If ANY applicable bucket is unmeasured or invalid, the run is `incomplete`
 *     with NO numeric total, while the valid bucket values are still shown.
 *  5. Only when every applicable bucket is valid: total =
 *     sum(weight × bucketScore) / sum(applicableWeights), rounded once.
 *  6. Weighted evidence coverage is returned independently — coverage, not
 *     confidence and not business performance.
 *  7. A previous complete run stays visible as "Last complete score" and its
 *     total is never blended into a new incomplete run.
 *
 * Runs are immutable. This service has no update or delete path for
 * `ScoreFamilyRun`/`ScoreBucketRun`; a new calculation always writes new rows.
 *
 * @module digital-performance.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { DigitalPerformanceSources } from './digital-performance.sources';
import {
  evaluateAiVisibility,
  evaluateContentQuality,
  evaluateGoogleVisibility,
  evaluateOnlineProfiles,
  evaluateSocialActivity,
  evaluateWebsiteHealth,
  resolveState,
} from './digital-performance.buckets';
import {
  defaultMethodologyConfig,
  parseMethodologyConfig,
  roundHalfUp,
  WEIGHTS_APPROVAL_NOTE,
  WEIGHTS_ARE_APPROVED,
} from './digital-performance.methodology';
import {
  BUCKET_STATE_LABEL,
  DIGITAL_PERFORMANCE_BUCKETS,
  DIGITAL_PERFORMANCE_FAMILY,
  sourceKindLabel,
} from './digital-performance.types';
import type {
  Applicability,
  BucketEvaluation,
  BucketState,
  ClientSafeScoreRun,
  ClientSafeScoreView,
  ComparisonSegment,
  ComparisonState,
  DigitalPerformanceBucket,
  MethodologyBucketConfig,
  MethodologyConfig,
  ResolvedBucket,
  RunStatus,
  ScoreExplanation,
} from './digital-performance.types';

/** The §5.3 calculation contract's own description, returned with every run so a reader never has to guess. */
const COVERAGE_MEANING =
  'Weighted evidence coverage: the share of applicable bucket weight that was actually measured. ' +
  'It describes coverage only — it is not statistical confidence and not business performance.';

@Injectable()
export class DigitalPerformanceService {
  private readonly logger = new Logger(DigitalPerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: DigitalPerformanceSources,
  ) {}

  // ─── Methodology (versioned configuration) ─────────────────────────────────

  /**
   * The methodology the next run will use, seeded with the §5.2 proposal on
   * first use. Seeding never marks the weights approved — §22 D01 stays open and
   * is reported by `weightsApproved: false`.
   */
  async activeMethodology() {
    let methodology = await this.prisma.scoreMethodology.findFirst({
      where: { family: DIGITAL_PERFORMANCE_FAMILY, active: true },
      orderBy: { version: 'desc' },
    });
    if (methodology) return methodology;

    const any = await this.prisma.scoreMethodology.findFirst({
      where: { family: DIGITAL_PERFORMANCE_FAMILY },
      orderBy: { version: 'desc' },
    });
    if (any) {
      methodology = await this.prisma.scoreMethodology.update({ where: { id: any.id }, data: { active: true } });
      return methodology;
    }

    this.logger.log('No digital-performance methodology yet — seeding version 1 (the §5.2 six-bucket proposal)');
    methodology = await this.prisma.scoreMethodology.create({
      data: {
        family: DIGITAL_PERFORMANCE_FAMILY,
        version: 1,
        label: 'Cailyx digital performance',
        config: JSON.stringify(defaultMethodologyConfig()),
        active: true,
        note:
          'Seeded from the §5.2 six-bucket proposal. Weights are a product decision (plan §22 D01) and are NOT validated; ' +
          'change them by creating a new methodology version, never by editing this row.',
      },
    });
    return methodology;
  }

  /** List methodology versions, newest first. */
  async listMethodologies() {
    return this.prisma.scoreMethodology.findMany({ orderBy: [{ family: 'asc' }, { version: 'desc' }] });
  }

  /**
   * Create a new methodology version. A later approved weighting change is a new
   * version — the existing rows are never edited, so runs keep the thresholds
   * they were actually calculated with.
   */
  async createMethodology(input: {
    family?: string;
    version?: number;
    label?: string;
    /** Free-form on purpose: `normaliseConfig` is the single validator, so the DTO and the service cannot disagree about the shape. */
    config?: unknown;
    activate?: boolean;
    note?: string;
  }) {
    const family = input.family ?? DIGITAL_PERFORMANCE_FAMILY;
    const config = input.config ? normaliseConfig(input.config) : defaultMethodologyConfig();

    let version = input.version;
    if (version === undefined) {
      const latest = await this.prisma.scoreMethodology.findFirst({
        where: { family },
        orderBy: { version: 'desc' },
      });
      version = (latest?.version ?? 0) + 1;
    }
    if (version < 1) throw new BadRequestException('Methodology version must be >= 1');

    const existing = await this.prisma.scoreMethodology.findFirst({ where: { family, version } });
    if (existing) throw new BadRequestException('Methodology ' + family + ' v' + version + ' already exists');

    const anyActive = (await this.prisma.scoreMethodology.count({ where: { family, active: true } })) > 0;
    const activate = input.activate === true || !anyActive;
    if (activate && anyActive) {
      await this.prisma.scoreMethodology.updateMany({ where: { family, active: true }, data: { active: false } });
    }

    return this.prisma.scoreMethodology.create({
      data: {
        family,
        version,
        label: input.label ?? 'Cailyx digital performance',
        config: JSON.stringify(config),
        active: activate,
        note: input.note ?? null,
      },
    });
  }

  // ─── Applicability (§5.3 rule 1) ───────────────────────────────────────────

  /** The latest applicability decision per bucket, plus the effective applicability. */
  async getApplicability(projectId: string) {
    await this.requireProject(projectId);
    const methodology = await this.activeMethodology();
    const config = parseMethodologyConfig(methodology.config);
    const decisions = await this.latestDecisions(projectId);

    return {
      family: DIGITAL_PERFORMANCE_FAMILY,
      methodologyVersion: methodology.version,
      note:
        'A bucket is applicable unless a decision below says otherwise. A bucket that could not be measured stays applicable and ' +
        'reads "not-measured" — that is a different fact from "not relevant", and it redistributes no weight.',
      buckets: config.buckets.map((b) => {
        const decision = decisions.get(b.key);
        return {
          key: b.key,
          label: b.label,
          weight: b.weight,
          applicability: (decision?.decision ?? 'applicable') as Applicability,
          reason: decision?.reason ?? null,
          decidedAt: decision?.createdAt.toISOString() ?? null,
          decidedBy: decision?.actorEmail ?? null,
          origin: decision ? ('decision' as const) : ('default' as const),
        };
      }),
    };
  }

  /**
   * Record an applicability decision. A `not-applicable` decision REQUIRES a
   * reason: §5.3 rule 1 makes "not relevant" a recorded decision, not an absence
   * of data, so a reasonless exclusion would be exactly the inference the rule
   * forbids. Superseding writes a new row; history is never deleted.
   */
  async setApplicability(
    projectId: string,
    input: { bucketKey: string; applicable: boolean; reason?: string },
    actorEmail: string | null,
  ) {
    await this.requireProject(projectId);
    const methodology = await this.activeMethodology();
    const config = parseMethodologyConfig(methodology.config);
    const bucket = config.buckets.find((b) => b.key === input.bucketKey);
    if (!bucket) {
      throw new BadRequestException(
        'Unknown bucket "' + input.bucketKey + '". Known buckets: ' + config.buckets.map((b) => b.key).join(', '),
      );
    }
    const reason = (input.reason ?? '').trim();
    if (!input.applicable && reason.length < 3) {
      throw new BadRequestException(
        'Marking "' + bucket.key + '" not applicable requires a reason — "not relevant" is a recorded decision, not an absence of data',
      );
    }
    if (reason.length === 0) {
      throw new BadRequestException('An applicability decision requires a reason');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.scoreApplicabilityDecision.updateMany({
        where: { projectId, bucketKey: bucket.key, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      await tx.scoreApplicabilityDecision.create({
        data: {
          projectId,
          bucketKey: bucket.key,
          decision: input.applicable ? 'applicable' : 'not-applicable',
          reason,
          actorEmail,
          methodologyVersion: methodology.version,
        },
      });
    });

    return this.getApplicability(projectId);
  }

  private async latestDecisions(projectId: string) {
    const rows = await this.prisma.scoreApplicabilityDecision.findMany({
      where: { projectId, supersededAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const out = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!out.has(row.bucketKey)) out.set(row.bucketKey, row);
    return out;
  }

  // ─── The calculation (§5.3) ────────────────────────────────────────────────

  /**
   * Build a run and persist it. This is the ONLY writer of a run, it never
   * updates an existing run, and it is only ever called from an explicit
   * request — never from a GET (§5.7: "Loading this page must never start an
   * audit, refresh a paid provider, build a score, or create a job").
   */
  async run(projectId: string) {
    await this.requireProject(projectId);
    const methodology = await this.activeMethodology();
    const config = parseMethodologyConfig(methodology.config);
    const now = new Date();

    // Every read below is a bounded read of rows that already exist. Sources are
    // gathered up front so a slow one cannot interleave with scoring.
    const [websiteHealth, googleVisibility, aiVisibility, onlineProfiles, socialActivity, contentQuality, market] =
      await Promise.all([
        this.sources.websiteHealth(projectId),
        this.sources.googleVisibility(projectId),
        this.sources.aiVisibility(projectId),
        this.sources.onlineProfiles(projectId),
        this.sources.socialActivity(projectId),
        this.sources.contentQuality(projectId),
        this.sources.marketSet(projectId),
      ]);

    const decisions = await this.latestDecisions(projectId);
    const applicabilitySnapshot: Record<string, unknown> = {};
    for (const bucket of config.buckets) {
      const decision = decisions.get(bucket.key);
      applicabilitySnapshot[bucket.key] = {
        applicable: decision ? decision.decision === 'applicable' : true,
        reason: decision?.reason ?? null,
        decidedBy: decision?.actorEmail ?? null,
        decidedAt: decision?.createdAt.toISOString() ?? null,
        origin: decision ? 'decision' : 'default',
      };
    }

    const evaluate = (bucket: MethodologyBucketConfig): ResolvedBucket => {
      const decision = decisions.get(bucket.key);
      const applicable: Applicability = decision && decision.decision === 'not-applicable' ? 'not-applicable' : 'applicable';
      if (applicable === 'not-applicable') {
        return {
          key: bucket.key,
          label: bucket.label,
          weight: bucket.weight,
          applicability: applicable,
          applicabilityReason: decision?.reason,
          state: 'not-applicable',
          value: null,
          weightedPoints: 0,
          // Zero ONLY because this bucket was explicitly recorded as not
          // relevant. This is the only path that ever redistributes weight.
          effectiveWeight: 0,
          contribution: 0,
          windowStart: null,
          windowEnd: null,
          metricVersion: bucket.metricVersion,
          metricInputs: [],
          thresholds: bucket.thresholds,
          sources: [],
          maxAgeDays: bucket.maxAgeDays,
          minSample: bucket.minSample,
          missingReasons: [],
          notes: ['Recorded as not relevant for this project: ' + (decision?.reason ?? '')],
          detailPath: bucket.detailPath,
          detailQuery: bucket.detailQuery ?? null,
        };
      }

      let evaluation: BucketEvaluation;
      try {
        evaluation = this.evaluateBucket(bucket.key, {
          websiteHealth,
          googleVisibility,
          aiVisibility,
          onlineProfiles,
          socialActivity,
          contentQuality,
        }, bucket, now);
      } catch (e) {
        // An evaluator that throws is a failure, not a zero. The bucket keeps
        // its full effective weight, so the run cannot total up without it.
        evaluation = {
          hasSource: false,
          latestSuccessAt: null,
          latestAttemptAt: now,
          latestAttemptFailed: true,
          failureReason: 'The ' + bucket.metricVersion + ' calculation failed: ' + (e as Error).message,
          submetrics: [],
          sources: [],
          notes: [],
          missingReasons: [],
          sample: 0,
          windowStart: null,
          windowEnd: null,
        };
      }

      const resolved = resolveState(evaluation, bucket, now);
      const weightedPoints = resolved.value === null ? 0 : bucket.weight * resolved.value;
      return {
        key: bucket.key,
        label: bucket.label,
        weight: bucket.weight,
        applicability: 'applicable',
        state: resolved.state,
        value: resolved.value,
        weightedPoints,
        effectiveWeight: bucket.weight,
        contribution: 0, // filled in once the applicable weight total is known
        windowStart: evaluation.windowStart,
        windowEnd: evaluation.windowEnd,
        metricVersion: bucket.metricVersion,
        metricInputs: evaluation.submetrics,
        thresholds: bucket.thresholds,
        sources: evaluation.sources,
        maxAgeDays: bucket.maxAgeDays,
        minSample: bucket.minSample,
        missingReasons: resolved.missingReasons,
        notes: evaluation.notes,
        detailPath: bucket.detailPath,
        detailQuery: bucket.detailQuery ?? null,
      };
    };

    const buckets = config.buckets.map(evaluate);

    // ── The roll-up, exactly as §5.3 rules 4–6 describe it ──────────────────
    const applicable = buckets.filter((b) => b.applicability === 'applicable');
    const applicableWeightTotal = applicable.reduce((sum, b) => sum + b.effectiveWeight, 0);
    const unmeasured = applicable.filter((b) => b.state !== 'measured');
    const measuredWeight = applicable.filter((b) => b.state === 'measured').reduce((sum, b) => sum + b.effectiveWeight, 0);

    const complete = unmeasured.length === 0 && applicableWeightTotal > 0;
    const weightedPointsTotal = complete ? applicable.reduce((sum, b) => sum + b.weightedPoints, 0) : null;
    const total =
      complete && weightedPointsTotal !== null && applicableWeightTotal > 0
        ? roundHalfUp(weightedPointsTotal / applicableWeightTotal)
        : null;

    const evidenceCoverage =
      applicableWeightTotal > 0 ? roundHalfUp((measuredWeight / applicableWeightTotal) * 100) : 0;

    for (const bucket of buckets) {
      bucket.contribution = applicableWeightTotal > 0 ? bucket.weightedPoints / applicableWeightTotal : 0;
    }

    const bands = config.bands && config.bands.length > 0 ? config.bands : null;
    const band = total === null || !bands ? null : bandFor(total, bands);

    const scope = {
      marketSet: market.markets,
      businessProfileVersion: market.profileVersion,
      sourceDefinitions: Object.fromEntries(config.buckets.map((b) => [b.key, 'metricVersion ' + b.metricVersion])),
      windowDefinitions: Object.fromEntries(
        config.buckets.map((b) => [b.key, typeof b.thresholds['windowDays'] === 'number' ? { windowDays: b.thresholds['windowDays'] } : { maxAgeDays: b.maxAgeDays }]),
      ),
      querySource: config.buckets.find((b) => b.key === 'google-visibility')?.scope['querySource'] ?? null,
      contentBriefStatus: config.buckets.find((b) => b.key === 'content-quality')?.scope['briefStatus'] ?? 'approved',
    };

    // §5.5: two runs may be compared only when family, methodology version,
    // applicability, market set, source definitions and window definitions all
    // match. Concrete window DATES are deliberately not in the key — a comparison
    // must not break merely because a day passed.
    const comparisonKey = sha256(
      JSON.stringify({
        family: DIGITAL_PERFORMANCE_FAMILY,
        methodologyVersion: methodology.version,
        applicability: buckets
          .map((b) => [b.key, b.applicability] as [string, string])
          .sort((a, b) => a[0].localeCompare(b[0])),
        marketSet: [...market.markets].sort(),
        metricVersions: config.buckets.map((b) => [b.key, b.metricVersion]).sort((a, b) => a[0].localeCompare(b[0])),
        windowDefinitions: scope.windowDefinitions,
        querySource: scope.querySource,
        contentBriefStatus: scope.contentBriefStatus,
      }),
    );

    const previous = await this.prisma.scoreFamilyRun.findFirst({
      where: { projectId, family: DIGITAL_PERFORMANCE_FAMILY },
      orderBy: { createdAt: 'desc' },
    });
    let segmentIndex = 1;
    let comparisonState: ComparisonState = 'new-segment';
    if (previous) {
      if (previous.comparisonKey === comparisonKey) {
        segmentIndex = previous.segmentIndex;
        comparisonState = 'comparable';
      } else {
        segmentIndex = previous.segmentIndex + 1;
        comparisonState = 'scoring-changed';
      }
    }

    const status: RunStatus = complete ? 'complete' : 'incomplete';

    const fingerprint = sha256(
      JSON.stringify({
        projectId,
        family: DIGITAL_PERFORMANCE_FAMILY,
        methodologyVersion: methodology.version,
        status,
        total,
        applicableWeightTotal,
        weightedPointsTotal,
        evidenceCoverage,
        comparisonKey,
        segmentIndex,
        comparisonState,
        previousRunId: previous?.id ?? null,
        scope,
        applicabilitySnapshot,
        buckets: buckets.map((b) => ({
          key: b.key,
          weight: b.weight,
          applicability: b.applicability,
          state: b.state,
          value: b.value,
          weightedPoints: b.weightedPoints,
          effectiveWeight: b.effectiveWeight,
        })),
      }),
    );

    const created = await this.prisma.scoreFamilyRun.create({
      data: {
        projectId,
        family: DIGITAL_PERFORMANCE_FAMILY,
        methodologyVersion: methodology.version,
        status,
        total,
        band,
        applicableWeightTotal,
        weightedPointsTotal,
        evidenceCoverage,
        comparisonKey,
        segmentIndex,
        comparisonState,
        previousRunId: previous?.id ?? null,
        fingerprint,
        scope: JSON.stringify(scope),
        applicabilitySnapshot: JSON.stringify(applicabilitySnapshot),
        buckets: {
          create: buckets.map((b) => ({
            key: b.key,
            label: b.label,
            weight: b.weight,
            applicability: b.applicability,
            applicabilityReason: b.applicabilityReason ?? null,
            state: b.state,
            value: b.value,
            weightedPoints: b.weightedPoints,
            effectiveWeight: b.effectiveWeight,
            contribution: b.contribution,
            windowStart: b.windowStart,
            windowEnd: b.windowEnd,
            methodologyVersion: methodology.version,
            metricVersion: b.metricVersion,
            metricInputs: JSON.stringify(b.metricInputs),
            thresholds: JSON.stringify(b.thresholds),
            sources: JSON.stringify(b.sources),
            maxAgeDays: b.maxAgeDays,
            minSample: b.minSample,
            missingReasons: JSON.stringify(b.missingReasons),
            notes: JSON.stringify(b.notes),
            detailPath: b.detailPath,
            detailQuery: b.detailQuery,
          })),
        },
      },
      include: { buckets: true },
    });

    this.logger.log(
      'Digital-performance run for ' +
        projectId +
        ': ' +
        (total === null ? 'incomplete (no total)' : total + '/100') +
        ' coverage ' +
        evidenceCoverage +
        '% on methodology v' +
        methodology.version +
        ' [' +
        comparisonState +
        ']',
    );

    return this.toRunView(created, previous);
  }

  private evaluateBucket(
    key: DigitalPerformanceBucket,
    sources: {
      websiteHealth: Awaited<ReturnType<DigitalPerformanceSources['websiteHealth']>>;
      googleVisibility: Awaited<ReturnType<DigitalPerformanceSources['googleVisibility']>>;
      aiVisibility: Awaited<ReturnType<DigitalPerformanceSources['aiVisibility']>>;
      onlineProfiles: Awaited<ReturnType<DigitalPerformanceSources['onlineProfiles']>>;
      socialActivity: Awaited<ReturnType<DigitalPerformanceSources['socialActivity']>>;
      contentQuality: Awaited<ReturnType<DigitalPerformanceSources['contentQuality']>>;
    },
    bucket: MethodologyBucketConfig,
    now: Date,
  ): BucketEvaluation {
    switch (key) {
      case 'website-health':
        return evaluateWebsiteHealth(sources.websiteHealth, bucket, now);
      case 'google-visibility':
        return evaluateGoogleVisibility(sources.googleVisibility, bucket, now);
      case 'ai-visibility':
        return evaluateAiVisibility(sources.aiVisibility, bucket, now);
      case 'online-profiles':
        return evaluateOnlineProfiles(sources.onlineProfiles, bucket, now);
      case 'social-activity':
        return evaluateSocialActivity(sources.socialActivity, bucket, now);
      case 'content-quality':
        return evaluateContentQuality(sources.contentQuality, bucket, now);
      default:
        throw new Error('No evaluator for bucket ' + String(key));
    }
  }

  // ─── Reads (§5.7: a read is a read) ────────────────────────────────────────

  /**
   * The latest run plus, separately, the latest COMPLETE run. §5.3 rule 7: an
   * old complete snapshot stays visible as "Last complete score — [date]" while
   * a new update is incomplete, and its total is never combined with newly
   * measured buckets as if they came from one run. Returning them as two
   * distinct objects with distinct ids is what makes blending impossible.
   */
  async getLatest(projectId: string) {
    await this.requireProject(projectId);
    const methodology = await this.activeMethodology();
    const [latest, lastComplete] = await Promise.all([
      this.prisma.scoreFamilyRun.findFirst({
        where: { projectId, family: DIGITAL_PERFORMANCE_FAMILY },
        orderBy: { createdAt: 'desc' },
        include: { buckets: true },
      }),
      this.prisma.scoreFamilyRun.findFirst({
        where: { projectId, family: DIGITAL_PERFORMANCE_FAMILY, status: 'complete' },
        orderBy: { createdAt: 'desc' },
        include: { buckets: true },
      }),
    ]);

    const previousOfLatest = latest?.previousRunId
      ? await this.prisma.scoreFamilyRun.findUnique({ where: { id: latest.previousRunId }, include: { buckets: true } })
      : null;

    return {
      family: DIGITAL_PERFORMANCE_FAMILY,
      scoreName: 'Cailyx digital performance',
      methodology: {
        family: methodology.family,
        version: methodology.version,
        label: methodology.label,
        active: methodology.active,
        weightsApproved: WEIGHTS_ARE_APPROVED,
        approvalNote: WEIGHTS_APPROVAL_NOTE,
      },
      coverageMeaning: COVERAGE_MEANING,
      latest: latest ? this.toRunView(latest, previousOfLatest) : null,
      lastComplete: lastComplete ? this.toRunView(lastComplete, null) : null,
      /** True when the latest run IS the last complete one — so a reader does not show the same run twice. */
      lastCompleteIsLatest: Boolean(latest && lastComplete && latest.id === lastComplete.id),
      note:
        latest && latest.status === 'incomplete'
          ? 'The latest run is incomplete and has no total. The last complete score is shown separately and is never blended with newly measured buckets.'
          : null,
    };
  }

  /**
   * The **client-safe** read of the score family (§3.5 safe projection; §4.6's
   * "client-visible details can include source names, dates, counts checked,
   * what was missing, and why a comparison is unavailable. Staff-only detail can
   * include run IDs, model versions, raw samples, source joins…").
   *
   * This is a projection of the same stored run `getLatest()` reads — not a
   * second calculation, and not a second read path to a different number. It
   * removes the internal handles (`fingerprint`, `scope`, `applicabilitySnapshot`,
   * `weightedPoints`/`effectiveWeight`/`contribution`, `thresholds`, `minSample`,
   * `maxAgeDays`, `metricInputs`, and every `SourceRef.ref`) and replaces the raw
   * state strings with plain labels. Nothing is recomputed and nothing is
   * rounded twice: the totals are the stored totals.
   *
   * §5.3 rule 7 survives the projection: `latest` and `lastComplete` stay two
   * objects with distinct ids, so there is no shape in which an old complete
   * total could be combined with freshly measured buckets.
   */
  async getClientSafe(projectId: string): Promise<{
    score: ClientSafeScoreView;
    explanation: ScoreExplanation;
  }> {
    const view = await this.getLatest(projectId);
    const methodology = await this.activeMethodology();
    const config = parseMethodologyConfig(methodology.config);

    const toRun = (run: (typeof view)['latest']): ClientSafeScoreRun | null => {
      if (!run) return null;
      return {
        id: run.id,
        createdAt: run.createdAt,
        status: run.status,
        statusLabel: run.status === 'complete' ? 'Complete' : 'Being prepared',
        total: run.total,
        evidenceCoverage: run.evidenceCoverage,
        coverageMeaning: run.coverageMeaning,
        comparison: {
          state: run.comparison.state as ComparisonState,
          segmentIndex: run.comparison.segmentIndex,
          scoringChanged: run.comparison.scoringChanged,
          changeInTotal: run.comparison.changeInTotal,
          changeUnavailableReason: run.comparison.changeUnavailableReason,
        },
        buckets: run.buckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          weight: bucket.weight,
          applicability: bucket.applicability as Applicability,
          applicabilityReason: bucket.applicabilityReason,
          state: bucket.state as BucketState,
          stateLabel: BUCKET_STATE_LABEL[bucket.state as BucketState] ?? humaniseState(bucket.state),
          value: bucket.value,
          windowStart: bucket.windowStart,
          windowEnd: bucket.windowEnd,
          missingReasons: bucket.missingReasons,
          notes: bucket.notes,
          // §5.4's "business question and exact formula" — the question is the
          // plain-English half and is safe to show; the numerator, denominator,
          // units and rounding stay on the staff read.
          questions: uniq(
            (bucket.metricInputs as Array<{ question?: unknown; scored?: unknown }>)
              .filter((input) => input && input.scored !== false && typeof input.question === 'string')
              .map((input) => input.question as string),
          ),
          // The `ref` is dropped deliberately: it is an audit id, a snapshot id
          // or a storage row count — a record handle, not a fact about the
          // business (§4.6).
          sources: (bucket.sources as Array<{ kind: string; observedAt: string | null; ageDays: number | null }>).map(
            (source) => ({
              kind: source.kind,
              label: sourceKindLabel(source.kind),
              observedAt: source.observedAt,
              ageDays: source.ageDays,
            }),
          ),
          detail: bucket.detail,
        })),
      };
    };

    const score: ClientSafeScoreView = {
      family: view.family,
      scoreName: view.scoreName,
      methodology: {
        version: view.methodology.version,
        label: view.methodology.label,
        weightsApproved: view.methodology.weightsApproved,
        approvalNote: view.methodology.approvalNote,
      },
      latest: toRun(view.latest),
      lastComplete: toRun(view.lastComplete),
      lastCompleteIsLatest: view.lastCompleteIsLatest,
      note: view.note,
    };

    // §5.5's "How this score works" sheet. Every sentence below is drawn from
    // stored configuration or from the run's own recorded disclosures — none of
    // it is invented here, and the version number lives in this detail sheet
    // rather than in a headline (§4.3).
    const latestBuckets = view.latest?.buckets ?? [];
    const explanation: ScoreExplanation = {
      headline: 'We check several areas of your online performance and combine the ones that could be measured.',
      missingDataRule:
        'If any area that applies to your business could not be measured, we show no overall number at all. ' +
        'We would rather show you the areas we did measure than an average that quietly treats missing results as zero.',
      totalRule:
        'The overall number is each area’s result multiplied by its share of the score, added up and divided by the shares of the areas that apply. ' +
        'It is rounded once, at the end. An area recorded as not relevant to your business is the only reason the remaining shares are re-weighted.',
      coverageRule:
        'Alongside the score we report how much of the applicable score we managed to measure. That describes coverage only — it is not a confidence level and not a measure of how your business is doing.',
      comparisonRule:
        'We only show a change between two results when they checked the same things the same way. When that changes, we say so and start again rather than showing a percentage that would mislead.',
      buckets: config.buckets.map((bucket) => {
        const runBucket = latestBuckets.find((b) => b.key === bucket.key);
        const excludes = (bucket.scope as Record<string, unknown>)?.excludes;
        return {
          key: bucket.key,
          label: bucket.label,
          weight: bucket.weight,
          covers: runBucket ? (runBucket.notes as string[]) : [],
          excludes: typeof excludes === 'string' ? [excludes] : [],
        };
      }),
      methodologyVersion: methodology.version,
    };

    return { score, explanation };
  }

  /** One run with its buckets, project-ownership checked. Immutable, so this can be cached freely. */
  async getRun(projectId: string, runId: string) {
    await this.requireProject(projectId);
    const run = await this.prisma.scoreFamilyRun.findFirst({
      where: { id: runId, projectId },
      include: { buckets: true },
    });
    if (!run) throw new NotFoundException('Score run not found in this project: ' + runId);
    const previous = run.previousRunId
      ? await this.prisma.scoreFamilyRun.findUnique({ where: { id: run.previousRunId }, include: { buckets: true } })
      : null;
    return this.toRunView(run, previous);
  }

  /**
   * §5.5 trends. Runs are grouped into comparison segments by their comparison
   * key; a change is reported only inside a segment, and a new segment is
   * announced as "Scoring changed". Scores are never averaged across segments —
   * there is no code path here that combines two segments' numbers.
   */
  async getTrend(projectId: string) {
    await this.requireProject(projectId);
    const runs = await this.prisma.scoreFamilyRun.findMany({
      where: { projectId, family: DIGITAL_PERFORMANCE_FAMILY },
      orderBy: { createdAt: 'asc' },
      include: { buckets: true },
    });

    const segments: ComparisonSegment[] = [];
    for (const run of runs) {
      const last = segments[segments.length - 1];
      const bucketValues: Record<string, number | null> = {};
      for (const b of run.buckets) bucketValues[b.key] = b.value;
      const row = {
        id: run.id,
        createdAt: run.createdAt.toISOString(),
        status: run.status as RunStatus,
        total: run.total,
        evidenceCoverage: run.evidenceCoverage,
        bucketValues,
      };
      if (!last || last.comparisonKey !== run.comparisonKey) {
        segments.push({
          index: run.segmentIndex,
          comparisonKey: run.comparisonKey,
          runs: [row],
          scoringChangedAt: segments.length === 0 ? null : run.createdAt.toISOString(),
        });
      } else {
        last.runs.push(row);
      }
    }

    const changes = segments.flatMap((segment) =>
      segment.runs.slice(1).map((to, i) => {
        const from = segment.runs[i];
        const comparable = from.status === 'complete' && to.status === 'complete';
        return {
          fromRunId: from.id,
          toRunId: to.id,
          delta: comparable && from.total !== null && to.total !== null ? to.total - from.total : null,
          comparable,
          reason: comparable
            ? null
            : 'No change is shown: a change is only meaningful between two runs that both produced a total. ' +
              (from.status === 'incomplete' || to.status === 'incomplete'
                ? 'One of them is incomplete, so it has no total to subtract from.'
                : 'The runs are not comparable.'),
        };
      }),
    );

    return {
      family: DIGITAL_PERFORMANCE_FAMILY,
      scoreName: 'Cailyx digital performance',
      segments,
      changes,
      note:
        'Change is shown only between runs with the same methodology version, applicability decisions, market set, source definitions and window definitions. ' +
        'When any of those change, a new segment starts and the reader is told "Scoring changed". Scores are never averaged across segments.',
    };
  }

  // ─── Shared plumbing ───────────────────────────────────────────────────────

  private async requireProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return project;
  }

  /** Serialise a stored run for the API, computing the comparison display without inventing a number. */
  private toRunView(
    run: {
      id: string;
      projectId: string;
      family: string;
      methodologyVersion: number;
      status: string;
      total: number | null;
      band: string | null;
      applicableWeightTotal: number;
      weightedPointsTotal: number | null;
      evidenceCoverage: number;
      comparisonKey: string;
      segmentIndex: number;
      comparisonState: string;
      previousRunId: string | null;
      fingerprint: string;
      scope: string;
      applicabilitySnapshot: string;
      createdAt: Date;
      buckets: Array<{
        key: string;
        label: string;
        weight: number;
        applicability: string;
        applicabilityReason: string | null;
        state: string;
        value: number | null;
        weightedPoints: number;
        effectiveWeight: number;
        contribution: number;
        windowStart: Date | null;
        windowEnd: Date | null;
        methodologyVersion: number;
        metricVersion: string;
        metricInputs: string;
        thresholds: string;
        sources: string;
        maxAgeDays: number;
        minSample: number;
        missingReasons: string;
        notes: string;
        detailPath: string | null;
        detailQuery: string | null;
      }>;
    },
    previous: { id: string; status: string; total: number | null } | null,
  ) {
    const sameKey = previous !== null && previous.id === run.previousRunId && run.comparisonState === 'comparable';
    const comparable = sameKey && previous.status === 'complete' && run.status === 'complete' && previous.total !== null && run.total !== null;

    return {
      id: run.id,
      projectId: run.projectId,
      family: run.family,
      methodologyVersion: run.methodologyVersion,
      createdAt: run.createdAt.toISOString(),
      status: run.status as RunStatus,
      /** null whenever the run is incomplete — §5.3 rule 4. Never a floor, never a partial sum. */
      total: run.total,
      band: run.band,
      applicableWeightTotal: run.applicableWeightTotal,
      weightedPointsTotal: run.weightedPointsTotal,
      evidenceCoverage: run.evidenceCoverage,
      coverageMeaning: COVERAGE_MEANING,
      rounding: 'The total is sum(weight × bucket value) / sum(applicable weights), rounded half-up once — only the final displayed result.',
      comparison: {
        key: run.comparisonKey,
        segmentIndex: run.segmentIndex,
        state: run.comparisonState as ComparisonState,
        previousRunId: run.previousRunId,
        scoringChanged: run.comparisonState === 'scoring-changed',
        changeInTotal: comparable && previous && run.total !== null && previous.total !== null ? run.total - previous.total : null,
        changeUnavailableReason: comparable
          ? null
          : run.comparisonState === 'new-segment'
            ? 'This is the first run in its comparison segment, so there is nothing to compare against.'
            : run.comparisonState === 'scoring-changed'
              ? 'Scoring changed since the previous run (methodology version, applicability decisions, market set, source definitions or measurement windows). A new comparison segment starts here.'
              : 'No change is shown because one of the two runs has no total to compare.',
      },
      fingerprint: run.fingerprint,
      scope: safeParse(run.scope, {}),
      applicabilitySnapshot: safeParse(run.applicabilitySnapshot, {}),
      buckets: run.buckets.map((b) => ({
        key: b.key,
        label: b.label,
        weight: b.weight,
        applicability: b.applicability,
        applicabilityReason: b.applicabilityReason,
        state: b.state,
        value: b.value,
        weightedPoints: b.weightedPoints,
        effectiveWeight: b.effectiveWeight,
        contribution: b.contribution,
        windowStart: b.windowStart ? b.windowStart.toISOString() : null,
        windowEnd: b.windowEnd ? b.windowEnd.toISOString() : null,
        methodologyVersion: b.methodologyVersion,
        metricVersion: b.metricVersion,
        metricInputs: safeParse(b.metricInputs, []),
        thresholds: safeParse(b.thresholds, {}),
        sources: safeParse(b.sources, []),
        maxAgeDays: b.maxAgeDays,
        minSample: b.minSample,
        missingReasons: safeParse(b.missingReasons, []),
        notes: safeParse(b.notes, []),
        detail: {
          path: b.detailPath,
          query: b.detailQuery,
          period: {
            start: b.windowStart ? b.windowStart.toISOString() : null,
            end: b.windowEnd ? b.windowEnd.toISOString() : null,
          },
        },
      })),
      /** Every bucket the methodology defines is present above — nothing is dropped from the payload. */
      bucketOrder: [...DIGITAL_PERFORMANCE_BUCKETS],
    };
  }
}

// ─── Module-level helpers ────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Order-preserving de-duplication — two submetrics may legitimately share a question. */
function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * A stored bucket state that predates a label. Reached only by a row written by
 * an older methodology; it is shown humanised rather than as a raw enum, and the
 * map above stays the single place the five current states are worded.
 */
function humaniseState(state: string): string {
  const spaced = state.replace(/[-_]+/g, ' ').trim();
  return spaced === '' ? 'Not measured yet' : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function bandFor(total: number, bands: Array<{ max: number; band: string }>): string {
  for (const row of bands) if (total <= row.max) return row.band;
  return bands[bands.length - 1].band;
}

/** Validate a caller-supplied methodology config before it is stored. */
function normaliseConfig(input: unknown): MethodologyConfig {
  const raw = input as Partial<MethodologyConfig>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.buckets) || raw.buckets.length === 0) {
    throw new BadRequestException('A methodology needs at least one bucket');
  }
  const buckets = raw.buckets as MethodologyBucketConfig[];
  const keys = buckets.map((b) => b.key);
  const unknown = keys.filter((k) => !(DIGITAL_PERFORMANCE_BUCKETS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new BadRequestException('Unknown bucket key(s): ' + unknown.join(', '));
  if (new Set(keys).size !== keys.length) throw new BadRequestException('Duplicate bucket key in methodology');
  const weightSum = buckets.reduce((sum, b) => sum + b.weight, 0);
  if (weightSum !== 100) {
    throw new BadRequestException('Bucket weights must sum to 100 — got ' + weightSum);
  }
  for (const b of buckets) {
    if (typeof b.weight !== 'number' || b.weight < 0) throw new BadRequestException('Bucket ' + b.key + ' has a negative or non-numeric weight');
    if (typeof b.metricVersion !== 'string' || b.metricVersion.trim() === '') {
      throw new BadRequestException('Bucket ' + b.key + ' needs a metricVersion');
    }
    if (typeof b.maxAgeDays !== 'number' || b.maxAgeDays <= 0) {
      throw new BadRequestException('Bucket ' + b.key + ' needs a positive maxAgeDays');
    }
    if (typeof b.minSample !== 'number' || b.minSample < 0) {
      throw new BadRequestException('Bucket ' + b.key + ' needs a minSample of 0 or more');
    }
    if (typeof b.detailPath !== 'string' || b.detailPath.trim() === '') {
      throw new BadRequestException('Bucket ' + b.key + ' needs a detailPath so its card can open client-safe detail (§5.5)');
    }
  }
  return {
    rounding: raw.rounding ?? 'half-up at the final displayed total only',
    buckets: buckets.map((b) => ({ ...b, scope: b.scope ?? {}, thresholds: b.thresholds ?? {}, detailQuery: b.detailQuery ?? null })),
    ...(raw.bands ? { bands: raw.bands } : {}),
  };
}
