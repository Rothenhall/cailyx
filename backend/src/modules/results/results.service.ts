/**
 * ResultsService — G13's comparable-outcomes read.
 *
 * This is where design_plan §6.3 (the metric dictionary) and §6.4 (the
 * comparison and evidence policy) become code. Every non-negotiable in the G13
 * contract is implemented in this file:
 *
 * **Empty is not zero.** Every metric returns through {@link ResultsService.buildMetrics}
 * as a {@link Metric}, a discriminated union whose `value` property exists only
 * on the measured branch. A window with no observations produces
 * `state: 'not-measured'` with a reason and a prerequisite — there is no code
 * path that returns `0` for a metric that was never computed, and a consumer
 * that has not narrowed on `state` cannot compile a read of `.value`.
 *
 * **Movement is only shown when it is real.** {@link ResultsService.getResults}
 * resolves the baseline, compares the two cohorts key by key
 * ({@link CohortService.buildChecks}) and, on a methodology break, returns
 * `state: 'methodology-break'` — a branch that has **no `deltas` property at
 * all** — after recording the break on the cohort. The break is stated, the
 * withheld metric keys are named, and the movement is not drawn.
 *
 * **Freshness is not the period end.** The window's end comes from the stored
 * period; the newest source date comes from the sources. They travel in
 * different fields and {@link EvidenceService.buildFreshness} states the
 * relationship in a sentence, so no surface has to guess which one "updated"
 * means.
 *
 * **Personal contact data does not reach a client aggregate.** The projection
 * is narrowed on the server by {@link ResultsService.project}, which never
 * copies a contact field onto the response and reports what it removed. The
 * client route carries `@ClientPortal()`; this method decides what a permitted
 * caller may *see*, not who may call.
 *
 * **Revenue is not invented.** {@link ResultsService.businessOutcomes} returns
 * `state: 'not-measured'` and says why: validated business revenue needs a CRM
 * or conversion linkage that does not exist here, and the `Lead` rows that do
 * exist are Cailyx's own sales pipeline (PRD 6.11), never a client's ROI.
 *
 * @module results.service
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CohortService, type ComparisonContext } from './cohort.service';
import { PeriodService, type PeriodRow } from './period.service';
import { EvidenceService, type CollectedCounts, type CollectedEvidence } from './evidence.service';
import type {
  BaselineRef,
  BusinessOutcomes,
  CohortSummary,
  Comparability,
  DisclosureBlock,
  MeasuredMetric,
  Metric,
  MetricDelta,
  MetricScope,
  MetricUnit,
  NotMeasuredMetric,
  ObservationDisclosure,
  ResultsAudience,
  ResultsOmission,
  ResultsView,
  ResultsWindow,
  SampleDisclosure,
} from './results.types';
import { SAMPLING_FLOOR, SECRET_PATTERN } from './results.types';
import { round4 } from './results.util';
import type { ResultsQueryDto } from './dto/results.dto';

/** The project fields a results read needs. Never the whole row. */
interface ScopedProject {
  id: string;
  name: string;
  timezone: string;
  clientId: string | null;
}

/** Which rung of the cohort fallback was used. Reported, never inferred. */
type CohortSource = 'explicit' | 'period' | 'latest' | 'none';

/**
 * The caveat that travels with every counted rate.
 * design_plan §6.4, verbatim in substance: n>=5 is a floor, not a test.
 */
const SAMPLE_NOTE =
  'The requested n>=5 is a sampling floor, not a significance test and not proof of five successful responses per prompt. ' +
  'Repeated answers are not independent people. No confidence interval or significance badge is shown because no statistical method has been approved for this system.';

/** Keys whose movement is drawn as a delta. Everything else is reported per period only. */
const DELTA_KEYS = new Set(['rubricScore', 'mentionRate', 'citationRate', 'shareOfVoice', 'coverage']);

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodService,
    private readonly cohorts: CohortService,
    private readonly evidence: EvidenceService,
  ) {}

  /**
   * The comparable-results read.
   *
   * @param projectId the project whose results are being read. The caller has
   *        already been checked against this id by `ScopeValidationService`;
   *        every nested id is resolved *inside* it (AGENT-BRIEF rule 1).
   * @param query the window/cohort/baseline request.
   * @param audience which projection to build. `'client'` narrows the payload
   *        and names what was removed.
   */
  async getResults(projectId: string, query: ResultsQueryDto, audience: ResultsAudience): Promise<ResultsView> {
    const project = await this.loadProject(projectId);

    const { window, period } = await this.periods.resolveWindow(projectId, query, project.timezone);
    const { cohort, source: cohortSource } = await this.cohorts.resolveForRead(
      projectId,
      query.cohortId ?? null,
      period?.cohortId ?? null,
    );

    const current = await this.evidence.collect(projectId, window);
    const currentMetrics = this.buildMetrics(current.counts, window, cohort);

    const comparability = await this.buildComparability(
      projectId,
      query,
      window,
      period,
      cohort,
      current,
      currentMetrics,
    );

    // A manifest already pinned for this period is reported, not re-derived:
    // the pinned one is the snapshot a released report points at.
    const pinnedManifest = period
      ? await this.evidence.findForSubject(projectId, 'result-set', null, period.id)
      : null;

    const disclosure = this.buildDisclosure(current, audience, window, cohortSource);

    const notes: string[] = [
      'Metrics are computed from the rows pinned in this bundle. Each metric carries its own numerator, denominator, sample and scope; none of them is derived from a page view or an estimate.',
      'A metric that could not be computed is returned as "not-measured" with the reason and the prerequisite. It is never returned as 0, and a missing baseline is never rendered as a decline.',
      current.bundle.freshness.statement,
    ];
    if (window.reproducibilityNote) notes.push(window.reproducibilityNote);
    if (cohortSource === 'latest') {
      notes.push(
        "No cohort was named and this period has none, so the project's most recent cohort was used. Pass ?cohortId= to compare against a specific methodology.",
      );
    }
    if (cohortSource === 'none') {
      notes.push(
        'This project has no MeasurementCohort, so its methodology is unpinned. Any comparison is reported as a methodology break until one is created.',
      );
    }
    if (current.bundle.truncations.length > 0) notes.push(...current.bundle.truncations);

    const view: ResultsView = {
      projectId,
      generatedAt: new Date().toISOString(),
      audience,
      window,
      cohort,
      metrics: currentMetrics,
      comparability,
      evidence: {
        manifestId: pinnedManifest?.id ?? null,
        pinned: pinnedManifest !== null,
        sources: pinnedManifest?.sources ?? current.bundle.sources,
        coverage: pinnedManifest?.coverage ?? current.bundle.coverage,
        freshness: pinnedManifest?.freshness ?? current.bundle.freshness,
        omissions: pinnedManifest?.omissions ?? current.bundle.omissions,
        truncations: pinnedManifest?.truncations ?? current.bundle.truncations,
        scoreRunId: pinnedManifest?.scoreRunId ?? current.bundle.scoreRunId,
        rubricVersion: pinnedManifest?.rubricVersion ?? current.bundle.rubricVersion,
      },
      businessOutcomes: await this.businessOutcomes(projectId, current.counts),
      disclosure,
      notes,
    };

    return this.project(view, audience);
  }

  /** The project fields a read needs, resolved inside the URL's id. */
  async loadProject(projectId: string): Promise<ScopedProject> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, timezone: true, clientId: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  // ── Metrics ─────────────────────────────────────────────────────────

  /**
   * Turn a collection pass into the full metric dictionary.
   *
   * Every key this module serves is present in the result, measured or not.
   * The dictionary is never filtered down to whatever happened to have data,
   * because an absent row is exactly the ambiguity this module exists to
   * remove.
   */
  buildMetrics(counts: CollectedCounts, window: ResultsWindow, cohort: CohortSummary | null): Metric[] {
    const scope = this.scopeOf(cohort);
    const sample = (partial: Partial<SampleDisclosure>): SampleDisclosure => ({
      observations: partial.observations ?? counts.observations.total,
      samplingFloor: SAMPLING_FLOOR,
      meetsSamplingFloor: partial.meetsSamplingFloor ?? counts.observations.maxRepeats >= SAMPLING_FLOOR,
      prompts: partial.prompts ?? counts.observations.prompts,
      repeats: partial.repeats ?? counts.observations.maxRepeats,
      engines: partial.engines ?? counts.observations.distinctEngines,
      note: partial.note ?? SAMPLE_NOTE,
    });

    const metrics: Metric[] = [];

    // ── Rubric score ────────────────────────────────────────────────
    if (counts.score === null) {
      metrics.push(
        notMeasured('rubricScore', 'Rubric score', 'points',
          'The versioned rubric total (0-100) for the newest score run covering this window.',
          `No ScoreRun covers this window (${window.startsOn} - ${window.endsOn}).`,
          'Run scoring for this window, or read a stored period that contains a score run.',
          scope,
          sample({ observations: 0, prompts: 0, repeats: 0, engines: 0, meetsSamplingFloor: false }),
          ['A score is a rubric total, not a percentage of anything and not a traffic measurement.']),
      );
    } else {
      metrics.push({
        state: 'measured',
        key: 'rubricScore',
        label: 'Rubric score',
        unit: 'points',
        definition:
          'The versioned rubric total (0-100) for the newest score run covering this window. Rubric labels are descriptive, not a promise that an engine recommends the brand.',
        value: counts.score.total,
        sample: sample({}),
        scope,
        notes: [
          `Band: ${counts.score.band}. "Recommended" is a rubric label, not evidence an engine recommends the brand.`,
          `Rubric version ${counts.score.rubricVersion}; score run ${counts.score.id}. A rubric change makes this total non-comparable with totals from an earlier rubric version.`,
          ...(counts.score.status === 'partial'
            ? [
                'This run is partial: at least one dimension had missing evidence and contributed zero under the rubric. The rubric does not re-weight around missing dimensions, and partial is not a synonym for failed.',
              ]
            : []),
        ],
      });
    }

    // ── Mention / citation rates ────────────────────────────────────
    const rate = (
      key: 'mentionRate' | 'citationRate',
      label: string,
      definition: string,
      numerator: number,
    ): Metric => {
      if (counts.observations.total === 0) {
        return notMeasured(key, label, 'ratio', definition,
          `No observation was recorded inside this window (${window.startsOn} - ${window.endsOn}).`,
          'Run an AEO measurement for this window with an active query set. Without observations the rate is undefined, not zero.',
          scope,
          sample({ observations: 0, prompts: 0, repeats: 0, engines: 0, meetsSamplingFloor: false }),
          ['A zero denominator is not a zero rate, so this is reported as unmeasured rather than as 0.']);
      }
      const enough = counts.observations.maxRepeats >= SAMPLING_FLOOR;
      return {
        state: 'measured',
        key,
        label,
        unit: 'ratio',
        definition,
        value: round4(numerator / counts.observations.total),
        numerator,
        denominator: counts.observations.total,
        sample: sample({ meetsSamplingFloor: enough }),
        scope,
        notes: [
          `${numerator} of ${counts.observations.total} selected observations.`,
          enough
            ? `The sampling floor of ${SAMPLING_FLOOR} repeats per prompt was met (most repeats seen on a single prompt: ${counts.observations.maxRepeats}). That is a floor, not a significance test.`
            : `Below the sampling floor: the most repeats seen on any prompt was ${counts.observations.maxRepeats}, against a floor of ${SAMPLING_FLOOR}. Report it as provisional and do not describe it as significant.`,
        ],
      };
    };

    metrics.push(rate('mentionRate', 'Mention rate',
      'Observations that mentioned the subject, over selected observations in the window. Distinct from citation and from a crawler hit.',
      counts.observations.mentioned));
    metrics.push(rate('citationRate', 'Citation rate',
      "Observations that cited the subject's domain, over selected observations in the window. Validated by the host recorded on the observation, not inferred from a mention.",
      counts.observations.cited));

    // ── Share of voice ──────────────────────────────────────────────
    const sov = counts.shareOfVoice;
    const sovDenominator = sov.clientPresence + sov.competitorPresence;
    const sovDefinition =
      'Client presence count over the client plus tracked-competitor presence counts, in the selected observations. Benchmark-relative, not market share.';
    if (sov.trackedCompetitors === 0) {
      metrics.push(
        notMeasured('shareOfVoice', 'Share of voice', 'ratio', sovDefinition,
          'No competitors are tracked on this project, so there is no benchmark to divide by.',
          'Track at least one competitor on this project. Share of voice is client presence over client plus tracked-competitor presence.',
          scope, sample({}),
          ['Returned rows need not sum to 100% — this is a ratio against a tracked set, not a market-wide share.']),
      );
    } else if (sovDenominator === 0) {
      metrics.push(
        notMeasured('shareOfVoice', 'Share of voice', 'ratio', sovDefinition,
          'Neither the subject nor any tracked competitor appeared in the observations for this window.',
          'Observations in which the subject or a tracked competitor is named. An empty field of view is not a share of zero.',
          scope, sample({}),
          ['Benchmark-relative, not market share.']),
      );
    } else {
      metrics.push({
        state: 'measured',
        key: 'shareOfVoice',
        label: 'Share of voice',
        unit: 'ratio',
        definition: sovDefinition,
        value: round4(sov.clientPresence / sovDenominator),
        numerator: sov.clientPresence,
        denominator: sovDenominator,
        sample: sample({}),
        scope,
        notes: [
          `Client presence ${sov.clientPresence} of ${sovDenominator} tracked-brand presences.`,
          `Measured against ${sov.trackedCompetitors} tracked competitor(s).`,
          'The returned top rows may not sum to 100% — this is a ratio against the tracked set, not a market-wide share.',
          ...(sov.untrackedNames > 0
            ? [
                `${sov.untrackedNames} further brand name(s) appeared in answers that are not tracked competitors. They are excluded from the denominator; add them to the tracked set to include them.`,
              ]
            : []),
        ],
      });
    }

    // ── Observations ────────────────────────────────────────────────
    if (counts.observations.total === 0) {
      metrics.push(
        notMeasured('observations', 'Observations', 'count',
          'The number of AI answers recorded inside this window that passed the selection rules.',
          `No observation was recorded inside this window (${window.startsOn} - ${window.endsOn}).`,
          'Complete an AEO measurement run whose observations fall inside this window.',
          scope,
          sample({ observations: 0, prompts: 0, repeats: 0, engines: 0, meetsSamplingFloor: false }),
          ['An empty window is reported as unmeasured rather than as a count of zero, so it cannot be mistaken for a measured absence of visibility.']),
      );
    } else {
      metrics.push({
        state: 'measured',
        key: 'observations',
        label: 'Observations',
        unit: 'count',
        definition: 'The number of AI answers recorded inside this window that passed the selection rules.',
        value: counts.observations.total,
        sample: sample({}),
        scope,
        notes: [
          `${counts.observations.prompts} distinct prompt(s) x up to ${counts.observations.maxRepeats} repeat(s).`,
          'AI-attributed responses are self-reported by the provider and are not independent samples of people.',
        ],
      });
    }

    // ── Coverage ────────────────────────────────────────────────────
    const cov = counts.coverage;
    const coverageDefinition =
      'Successful agreed evidence units over planned units, across the measurement runs in this window.';
    if (cov.expected === 0) {
      metrics.push(
        notMeasured('coverage', 'Coverage', 'ratio', coverageDefinition,
          'No measurement run requested any collection in this window, so there are no planned units to report coverage against.',
          'A measurement run covering this window.',
          scope, sample({}),
          ['Coverage is a collection metric: it says how much of the agreed evidence was obtained, not how good the result was.']),
      );
    } else {
      metrics.push({
        state: 'measured',
        key: 'coverage',
        label: 'Coverage',
        unit: 'ratio',
        definition: coverageDefinition,
        value: round4(cov.succeeded / cov.expected),
        numerator: cov.succeeded,
        denominator: cov.expected,
        sample: sample({}),
        scope,
        notes: [
          `${cov.succeeded} of ${cov.expected} planned units succeeded.`,
          ...(cov.failed > 0
            ? ['Failed collection is named in the failure list and lowers this figure; it is never reported as "no issue found".']
            : []),
          ...(cov.pending > 0
            ? [`${cov.pending} unit(s) are still pending. Pending work is disclosed rather than dropped.`]
            : []),
        ],
      });
    }

    // ── Crawler activity ────────────────────────────────────────────
    const crawler = counts.crawlerHits;
    const crawlerDefinition = 'Ingested bot hits inside the window, classified by bot type at ingest.';
    if (crawler.everIngested === 0) {
      metrics.push(
        notMeasured('crawlerActivity', 'Crawler activity', 'count', crawlerDefinition,
          'No crawler hit has ever been ingested for this project, so the log source is not wired up.',
          'Ingest crawler server logs for this project (SOP-3 / 4.5).',
          scope, sample({}),
          ['A hit does not prove indexing, citation or inclusion in training.']),
      );
    } else {
      metrics.push({
        state: 'measured',
        key: 'crawlerActivity',
        label: 'Crawler activity',
        unit: 'count',
        definition: crawlerDefinition,
        value: crawler.total,
        sample: sample({}),
        scope,
        notes: [
          `Across ${crawler.distinctVendors} vendor(s): ${Object.entries(crawler.byType).map(([type, n]) => `${type} ${n}`).join(', ') || 'no classified hits'}.`,
          'A hit does not prove indexing, citation or training inclusion, and a missing hit does not prove a crawler stayed away.',
        ],
      });
    }

    // ── Referring domains ───────────────────────────────────────────
    const backlinks = counts.referringDomains;
    const domainsDefinition =
      'Referring domains from the newest backlinks snapshot at or before the window end. A provider snapshot, not a full link inventory.';
    if (backlinks === null) {
      metrics.push(
        notMeasured('referringDomains', 'Referring domains', 'count', domainsDefinition,
          'No backlinks snapshot exists for this project.',
          'Run a backlinks refresh for this project.',
          scope, sample({}),
          ['A provider snapshot, not a full link inventory.']),
      );
    } else if (backlinks.value === null) {
      metrics.push(
        notMeasured('referringDomains', 'Referring domains', 'count', domainsDefinition,
          `The provider snapshot (${backlinks.status}) recorded no referring-domain count.`,
          'A backlinks snapshot that completed with a referring-domain figure.',
          scope, sample({}),
          ['A provider returning no number is not the same as a provider returning zero.']),
      );
    } else {
      metrics.push({
        state: 'measured',
        key: 'referringDomains',
        label: 'Referring domains',
        unit: 'count',
        definition: domainsDefinition,
        value: backlinks.value,
        sample: sample({}),
        scope,
        notes: [
          `Provider snapshot captured ${backlinks.capturedAt} (status: ${backlinks.status}).`,
          'The top-links sample in that snapshot is a sample, not the full set of links.',
          ...(backlinks.status === 'partial' ? ['The snapshot is marked partial, so this figure undercounts.'] : []),
        ],
      });
    }

    return metrics;
  }

  // ── Comparability ───────────────────────────────────────────────────

  /**
   * Resolve the baseline, compare, and decide whether a delta may exist.
   *
   * Precedence: an explicit `baselineId`, else the served period's stored
   * `baselinePeriodId`, else no comparison at all. There is deliberately no
   * "assume the previous period" default — choosing a baseline is a statement
   * about what the two numbers mean, and this service does not make that
   * statement on the reader's behalf.
   */
  private async buildComparability(
    projectId: string,
    query: ResultsQueryDto,
    window: ResultsWindow,
    period: PeriodRow | null,
    cohort: CohortSummary | null,
    current: CollectedEvidence,
    currentMetrics: Metric[],
  ): Promise<Comparability> {
    let baselinePeriod: PeriodRow | null = null;
    let resolvedFrom: 'explicit' | 'stored' = 'explicit';

    if (query.baselineId) {
      baselinePeriod = (await this.periods.resolveBaseline(projectId, query.baselineId, { period, window })).period;
    } else if (period?.baselinePeriodId) {
      const stored = await this.prisma.reportPeriod.findFirst({ where: { id: period.baselinePeriodId, projectId } });
      if (stored) {
        baselinePeriod = stored;
        resolvedFrom = 'stored';
      }
    }

    if (!baselinePeriod) {
      return {
        state: 'no-baseline',
        reason: 'No baseline period is named for this read, so no comparison was drawn.',
        prerequisite:
          'Name one with ?baselineId=<ReportPeriod id>, or set baselinePeriodId on this period so every read of it compares against the same stored window.',
      };
    }

    const baselineWindow = this.periods.windowOfBaseline(baselinePeriod);
    const { cohort: baselineCohort } = await this.cohorts.resolveForRead(projectId, null, baselinePeriod.cohortId);
    const baselineEvidence = await this.evidence.collect(projectId, baselineWindow);

    const context: ComparisonContext = {
      currentRubricVersion: current.counts.score?.rubricVersion ?? null,
      baselineRubricVersion: baselineEvidence.counts.score?.rubricVersion ?? null,
      currentWindowDays: window.days,
      baselineWindowDays: baselineWindow.days,
      currentRepeats: current.counts.observations.maxRepeats || null,
      baselineRepeats: baselineEvidence.counts.observations.maxRepeats || null,
    };

    const checks = this.cohorts.buildChecks(cohort, baselineCohort, context);
    const baselineRef: BaselineRef = {
      periodId: baselinePeriod.id,
      label: baselinePeriod.label,
      startsOn: baselinePeriod.startsOn.toISOString(),
      endsOn: baselinePeriod.endsOn.toISOString(),
      timezone: baselinePeriod.timezone,
      cohortId: baselineCohort?.id ?? null,
      methodologyHash: baselineCohort?.methodologyHash ?? null,
      windowSource: 'period',
    };

    const baselineMetrics = this.buildMetrics(baselineEvidence.counts, baselineWindow, baselineCohort);

    if (this.cohorts.hasHardBreak(checks)) {
      const breaks = this.cohorts.breaksOf(checks);
      const reason =
        `The methodology key changed between "${baselinePeriod.label}" and this window (${breaks.map((b) => b.label).join(', ')}). ` +
        'The two periods are not the same measurement, so the movement between them is not reported.';
      const recorded = cohort
        ? await this.cohorts.recordComparisonBreak(
            projectId,
            cohort.id,
            { cohortId: baselineCohort?.id ?? null, periodId: baselinePeriod.id },
            checks,
            reason,
          )
        : [];

      return {
        state: 'methodology-break',
        baseline: baselineRef,
        checks,
        breaks: recorded.length > 0 ? recorded : cohort?.breaks ?? [],
        reason,
        withheld:
          'Deltas are withheld rather than shown with a caveat: a difference caused by a changed query set, engine, market, transport or rubric is not a change in visibility, and presenting it as one would be false. ' +
          'Re-measure the current period under the baseline cohort to obtain a comparable pair.',
        withheldMetricKeys: currentMetrics.filter((metric) => DELTA_KEYS.has(metric.key)).map((metric) => metric.key),
      };
    }

    return {
      state: 'comparable',
      baseline: baselineRef,
      checks,
      deltas: this.buildDeltas(currentMetrics, baselineMetrics, current.counts, baselineEvidence.counts, resolvedFrom),
      note:
        'Both periods share the same comparison key, so the deltas below are movement in the same measurement. ' +
        'Rate deltas are in percentage points (20% -> 30% is +10 pp), not relative percentages. ' +
        'A delta is still not a causal claim: nothing here links the change to work delivered unless a verification records it.',
    };
  }

  /**
   * Deltas, key by key.
   *
   * A key measured on both sides yields a delta; a key missing on either side
   * yields an explicit `not-measured` delta naming which side was missing. A
   * delta of zero is therefore always a real measured equality rather than a
   * default.
   */
  private buildDeltas(
    current: Metric[],
    baseline: Metric[],
    currentCounts: CollectedCounts,
    baselineCounts: CollectedCounts,
    resolvedFrom: 'explicit' | 'stored',
  ): MetricDelta[] {
    const baselineNote = resolvedFrom === 'stored'
      ? "the period's stored baselinePeriodId"
      : 'the baseline named in the request';

    return current.map((metric) => {
      const before = baseline.find((candidate) => candidate.key === metric.key);

      if (!DELTA_KEYS.has(metric.key)) {
        return {
          key: metric.key,
          label: metric.label,
          state: 'not-measured' as const,
          unit: metric.unit,
          reason:
            'This metric is reported per period but is not drawn as a delta — a change in a raw count or an inventory figure is not a rate movement, and drawing one would imply a comparison the two numbers do not support.',
          prerequisite: 'A rate or score metric, which carries a denominator in both periods.',
        };
      }
      if (metric.state === 'not-measured') {
        return {
          key: metric.key,
          label: metric.label,
          state: 'not-measured' as const,
          unit: metric.unit,
          reason: `This window is not measured: ${metric.reason}`,
          prerequisite: metric.prerequisite,
        };
      }
      if (!before || before.state === 'not-measured') {
        return {
          key: metric.key,
          label: metric.label,
          state: 'not-measured' as const,
          unit: metric.unit,
          reason: before
            ? `The baseline period is not measured for this metric: ${before.reason}`
            : 'The baseline period carries no value for this metric.',
          prerequisite:
            before && before.state === 'not-measured'
              ? before.prerequisite
              : 'A baseline period in which this metric was measured.',
        };
      }

      const isScore = metric.key === 'rubricScore';
      const value = isScore ? metric.value - before.value : round4((metric.value - before.value) * 100);

      return {
        key: metric.key,
        label: metric.label,
        state: 'measured' as const,
        unit: (isScore ? 'points' : 'percentage-points') as 'points' | 'percentage-points',
        value,
        current: isScore ? metric.value : round4(metric.value * 100),
        baseline: isScore ? before.value : round4(before.value * 100),
        sourceIds: {
          current: isScore ? currentCounts.score?.id ?? null : null,
          baseline: isScore ? baselineCounts.score?.id ?? null : null,
        },
        note: isScore
          ? "Points on the rubric's own scale. The rubric version is checked above; a version change withholds this delta entirely."
          : `Percentage points: ${(before.value * 100).toFixed(1)}% -> ${(metric.value * 100).toFixed(1)}% is ${value >= 0 ? '+' : ''}${value.toFixed(1)} pp. Baseline was ${baselineNote}.`,
      };
    });
  }

  // ── Business outcomes ───────────────────────────────────────────────

  /**
   * Business outcomes, deliberately unmeasured.
   *
   * This block exists so the absence is *stated* rather than left to a surface
   * to fill with a plausible number. It also labels the rows the system does
   * hold with what they actually are: `Lead` is Cailyx's own inbound sales
   * pipeline for a project (PRD 6.11), not a client's revenue, and summing it
   * into an ROI figure would be a fabrication about someone else's business.
   *
   * The lead count is real — read from the table, not assumed — and is shown
   * to the operator only, because a lead row is personal contact data.
   */
  async businessOutcomes(projectId: string, counts: CollectedCounts): Promise<BusinessOutcomes> {
    const leadCount = await this.prisma.lead.count({ where: { projectId } });

    return {
      state: 'not-measured',
      reason:
        'Validated business revenue is not measurable in this system. It requires a deliberate CRM or conversion linkage — a mapped source of closed-won value, an attribution window and a consent basis — and no such linkage exists here.',
      prerequisite:
        'A CRM or conversion source mapped to this project, with an agreed attribution window, before any revenue figure is shown. Until then revenue and ROI are reported as unmeasured.',
      presentRows: {
        cailyxLeadPipeline: {
          count: leadCount,
          whatItIs:
            "Cailyx's own inbound sales pipeline for this project (PRD 6.11). Counted here for the operator and never rendered as client revenue.",
          whatItIsNot:
            'Not client revenue, not client ROI, and not an outcome of the delivered work. It also holds personal contact data (name, email), which is why it is excluded from client and public projections entirely.',
        },
        aiAttributedResponses: {
          count: counts.observations.mentioned,
          whatItIs:
            'Self-reported count of AI answers in this window in which the subject appeared. A count of observations, not of people and not of conversions.',
          whatItIsNot:
            'Not attributable revenue. There is no causal linkage between an AI answer and a sale, and none is claimed.',
        },
      },
    };
  }

  // ── Projection ──────────────────────────────────────────────────────

  /**
   * Narrow a view for its audience.
   *
   * The operator projection is returned unchanged. The client projection strips
   * what §6.4 requires out of a public/client aggregate and records each
   * removal in `disclosure.omitted`, so the omission is visible to the reader
   * rather than being a silent absence they might read as "there is none".
   *
   * Scope itself is settled before this runs: `ScopeValidationService` decides
   * who may reach a project, and `@ClientPortal()` decides who may reach the
   * client route at all. This method decides what a permitted caller may see.
   */
  project(view: ResultsView, audience: ResultsAudience): ResultsView {
    if (audience === 'operator') {
      return { ...view, disclosure: { ...view.disclosure, omitted: [], audience } };
    }

    const omitted: ResultsOmission[] = [
      {
        key: 'lead-pipeline',
        reason:
          "Lead rows are Cailyx's own inbound sales pipeline and contain personal contact data (name, email). They are never part of a client or public aggregate, and never presented as client revenue or ROI.",
      },
      {
        key: 'personal-contact-data',
        reason:
          'Contact names, email addresses and message recipients are omitted. No metric in this response is derived from a person, and none is attributable to one.',
      },
      {
        key: 'operator-identifiers',
        reason: 'Operator user ids, names and assignments are internal and are not included.',
      },
      {
        key: 'raw-model-answers',
        reason:
          'Verbatim model answers are model output rather than measured evidence and may quote third parties. Only the counted observations derived from them are included.',
      },
      {
        key: 'internal-notes',
        reason: 'Internal notes and internal message bodies are a separate server-side channel and are never included.',
      },
      {
        key: 'unpublished-drafts',
        reason:
          'Reports that have not been released to the client (draft, in-review, withdrawn) are excluded. A published report is a frozen snapshot; an unpublished one is not a result.',
      },
      {
        key: 'commercial-costs',
        reason: 'Provider cost, spend and margin figures are commercial and are omitted.',
      },
      {
        key: 'other-clients',
        reason:
          'Rows belonging to any other client are never included. Ownership is validated on the server against the project in the URL rather than filtered for display.',
      },
    ];

    const scrub = (entry: ObservationDisclosure): ObservationDisclosure => ({
      ...entry,
      // A provider error can name internal infrastructure or echo a credential
      // back. The failure is disclosed; the infrastructure detail is not.
      detail: SECRET_PATTERN.test(entry.detail)
        ? "The collection failed. The provider's diagnostic detail names internal infrastructure, so it is not included here; your Cailyx team can supply it on request."
        : entry.detail,
    });

    return {
      ...view,
      businessOutcomes: {
        ...view.businessOutcomes,
        presentRows: {
          cailyxLeadPipeline: {
            count: 0,
            whatItIs: 'Not included in a client projection.',
            whatItIsNot:
              "Cailyx's own sales pipeline is not client revenue and is not shown here. Its rows contain personal contact data and are excluded from client and public aggregates.",
          },
          aiAttributedResponses: view.businessOutcomes.presentRows.aiAttributedResponses,
        },
      },
      disclosure: {
        ...view.disclosure,
        pending: view.disclosure.pending.map(scrub),
        failed: view.disclosure.failed.map(scrub),
        omitted,
        audience,
      },
    };
  }

  // ── Privates ──────────────────────────────────────────────────────

  private buildDisclosure(
    collected: CollectedEvidence,
    audience: ResultsAudience,
    window: ResultsWindow,
    cohortSource: CohortSource,
  ): DisclosureBlock {
    const caveats: string[] = [
      'Pending and failed collections are listed here in full. Nothing is dropped silently: a failed unit lowers coverage and is named, and a metric with no successful collection behind it stays unmeasured.',
      'Share of voice is benchmark-relative against the tracked competitor set, not market share.',
      'A "recommended" rubric band is a label, not a claim that an engine recommends the brand.',
    ];
    if (cohortSource !== 'explicit') {
      caveats.push(
        cohortSource === 'none'
          ? 'No MeasurementCohort is pinned, so the methodology behind these numbers is not recorded and cannot be shown to match another period.'
          : `The cohort was resolved from ${cohortSource === 'period' ? 'the period' : "the project's most recent cohort"} rather than named in the request.`,
      );
    }
    if (!window.stored) {
      caveats.push(
        'This window is not stored. Numbers computed from it will change as the window moves; a ReportPeriod is what makes a report reproducible.',
      );
    }
    if (collected.bundle.omissions.length > 0) {
      caveats.push(
        `Sources expected for this window that produced nothing: ${collected.bundle.omissions
          .map((entry) => entry.replace(/^absent: /, ''))
          .join('; ')}.`,
      );
    }

    return {
      pending: collected.pending,
      failed: collected.failed,
      caveats,
      omitted: [],
      audience,
    };
  }

  private scopeOf(cohort: CohortSummary | null): MetricScope {
    return {
      cohortId: cohort?.id ?? null,
      methodologyHash: cohort?.methodologyHash ?? null,
      querySetId: cohort?.querySetId ?? null,
      querySetVersion: cohort?.querySetVersion ?? null,
      engines: cohort?.engines ?? [],
      markets: cohort?.markets ?? [],
      transport: cohort?.transport ?? null,
      // The per-observation model is recorded on the observation, not on the
      // cohort. Left null rather than filled with the surface id, which is a
      // different thing.
      model: null,
    };
  }
}

/**
 * A metric that could not be computed.
 *
 * Returns a `NotMeasuredMetric`, which structurally has no `value` property —
 * the type-level half of "empty is not zero".
 */
function notMeasured(
  key: string,
  label: string,
  unit: MetricUnit,
  definition: string,
  reason: string,
  prerequisite: string,
  scope: MetricScope,
  sample: SampleDisclosure,
  notes: string[],
): NotMeasuredMetric {
  return { state: 'not-measured', key, label, unit, definition, reason, prerequisite, sample, scope, notes };
}

/** Narrow a metric to its measured branch. Exported so controllers and consumers share one guard. */
export function isMeasured(metric: Metric): metric is MeasuredMetric {
  return metric.state === 'measured';
}
