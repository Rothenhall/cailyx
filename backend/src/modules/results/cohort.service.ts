/**
 * CohortService — G13's comparability engine.
 *
 * A `MeasurementCohort` names the methodology a set of periods was measured
 * under. This service owns two things and nothing else:
 *
 * 1. **The methodology fingerprint.** {@link methodologyHashOf} canonicalises
 *    the §6.4 comparison key (query set + version, engines, markets,
 *    transport) into a sha256. The hash is recomputed on every write, never
 *    accepted from a caller, so it always describes the row it sits on.
 *
 * 2. **The comparability verdict.** {@link buildChecks} compares two cohorts
 *    key by key and says which differences invalidate the comparison. The
 *    caller (`ResultsService`) uses that verdict to decide whether a delta may
 *    exist at all — a break means the delta is *withheld*, not clamped to zero
 *    and not qualified with a footnote.
 *
 * A break is recorded on the cohort as it is discovered
 * ({@link recordComparisonBreak}), deduplicated by baseline so that reading
 * the same comparison twice does not append the same break twice.
 *
 * @module cohort.service
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { CohortSummary, ComparabilityCheck, MethodologyBreak } from './results.types';
import { methodologyHashOf, parseJson, parseStringArray, iso } from './results.util';
import type { CreateCohortDto, RecordBreakDto, UpdateCohortDto } from './dto/cohort.dto';

/** Extra context a cohort pair cannot carry alone but comparability depends on. */
export interface ComparisonContext {
  /** Score rubric version used by the current period's score run. */
  currentRubricVersion: number | null;
  /** Score rubric version used by the baseline's score run. */
  baselineRubricVersion: number | null;
  /** Window length in days, per §6.4 ("reporting window" is part of the key). */
  currentWindowDays: number;
  baselineWindowDays: number;
  /** Repeats-per-prompt policy actually used, when a run recorded it. */
  currentRepeats: number | null;
  baselineRepeats: number | null;
}

/** Check keys whose difference is a hard break rather than a caveat. */
const HARD_BREAK_KEYS = new Set(['query-set', 'query-set-version', 'engines', 'markets', 'transport', 'rubric-version']);

@Injectable()
export class CohortService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every cohort on a project, oldest first. */
  async list(projectId: string): Promise<CohortSummary[]> {
    const rows = await this.prisma.measurementCohort.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  /** One cohort, resolved inside its project — a foreign id 404s rather than resolving. */
  async get(projectId: string, id: string): Promise<CohortSummary> {
    const row = await this.prisma.measurementCohort.findFirst({ where: { id, projectId } });
    if (!row) throw new NotFoundException(`Measurement cohort ${id} not found for project ${projectId}`);
    return this.toSummary(row);
  }

  /**
   * Create a cohort. `baselineRunId` is validated against this project's
   * measurement runs — a baseline pointing at another project's run would make
   * every later comparison quietly meaningless.
   */
  async create(projectId: string, dto: CreateCohortDto): Promise<CohortSummary> {
    const engines = dto.engines ?? [];
    const markets = dto.markets ?? [];

    if (dto.querySetId) await this.assertQuerySetBelongsToProject(dto.querySetId, projectId);
    if (dto.baselineRunId) await this.assertRunBelongsToProject(dto.baselineRunId, projectId);

    const baselineAt = dto.baselineRunId
      ? (await this.prisma.measurementRun.findUnique({ where: { id: dto.baselineRunId }, select: { createdAt: true } }))?.createdAt ?? null
      : null;

    const querySetVersion = dto.querySetVersion ?? (await this.inferQuerySetVersion(dto.querySetId));

    const row = await this.prisma.measurementCohort.create({
      data: {
        projectId,
        name: dto.name,
        querySetId: dto.querySetId ?? null,
        querySetVersion,
        engines: JSON.stringify(engines),
        markets: JSON.stringify(markets),
        transport: dto.transport ?? null,
        methodologyHash: methodologyHashOf({
          querySetId: dto.querySetId ?? null,
          querySetVersion,
          engines,
          markets,
          transport: dto.transport ?? null,
        }),
        baselineRunId: dto.baselineRunId ?? null,
        baselineAt,
      },
    });
    return this.toSummary(row);
  }

  /**
   * Edit a cohort.
   *
   * Changing any field that feeds the methodology hash requires
   * `breakReason`; without it the edit is refused. That is deliberate friction:
   * an operator who swaps an engine mid-engagement *must* state it, because the
   * alternative is two periods being compared as if nothing happened.
   */
  async update(projectId: string, id: string, dto: UpdateCohortDto): Promise<CohortSummary> {
    const current = await this.get(projectId, id);

    const engines = dto.engines ?? current.engines;
    const markets = dto.markets ?? current.markets;
    const querySetId = dto.querySetId ?? current.querySetId;
    const querySetVersion = dto.querySetVersion ?? current.querySetVersion;
    const transport = dto.transport ?? current.transport;

    if (dto.querySetId) await this.assertQuerySetBelongsToProject(dto.querySetId, projectId);
    if (dto.querySetVersion !== undefined && dto.querySetId === undefined && !current.querySetId) {
      throw new BadRequestException('querySetVersion was supplied but this cohort has no querySetId to version');
    }

    const nextHash = methodologyHashOf({ querySetId, querySetVersion, engines, markets, transport });
    const changedKeys = this.diffKeys(current, { engines, markets, transport, querySetId, querySetVersion, methodologyHash: nextHash });
    const hashChanged = nextHash !== current.methodologyHash;

    if (hashChanged && !dto.breakReason) {
      throw new ConflictException(
        'This edit changes the methodology key (' +
          changedKeys.join(', ') +
          '), which breaks comparability with every period already measured under it. ' +
          'Supply `breakReason` to record the break deliberately rather than changing the basis silently.',
      );
    }

    const breaks = [...current.breaks];
    if (hashChanged) {
      breaks.push({
        at: new Date().toISOString(),
        reason: dto.breakReason as string,
        previousHash: current.methodologyHash,
        currentHash: nextHash,
        keys: changedKeys.length > 0 ? changedKeys : undefined,
      });
    }

    const row = await this.prisma.measurementCohort.update({
      where: { id },
      data: {
        name: dto.name ?? current.name,
        querySetId,
        querySetVersion,
        engines: JSON.stringify(engines),
        markets: JSON.stringify(markets),
        transport,
        methodologyHash: nextHash,
        breaks: JSON.stringify(breaks),
      },
    });
    return this.toSummary(row);
  }

  /**
   * Record a break that no field change expresses — a provider swapping the
   * model behind an unchanged surface id is the common case, and it breaks
   * comparability just as surely as renaming the engine does.
   */
  async recordBreak(projectId: string, id: string, dto: RecordBreakDto): Promise<CohortSummary> {
    const current = await this.get(projectId, id);
    const breaks: MethodologyBreak[] = [
      ...current.breaks,
      {
        at: new Date().toISOString(),
        reason: dto.reason,
        previousHash: current.methodologyHash,
        currentHash: current.methodologyHash,
        keys: [],
      },
    ];
    const row = await this.prisma.measurementCohort.update({
      where: { id },
      data: { breaks: JSON.stringify(breaks) },
    });
    return this.toSummary(row);
  }

  /**
   * Which cohort applies to a read.
   *
   * Precedence is explicit and the caller is told which rung was used: an
   * explicit `cohortId`, else the period's own cohort, else the project's most
   * recent cohort, else none. Falling back silently would let a read be
   * compared against a methodology the caller never chose.
   */
  async resolveForRead(
    projectId: string,
    explicitCohortId: string | null,
    periodCohortId: string | null,
  ): Promise<{ cohort: CohortSummary | null; source: 'explicit' | 'period' | 'latest' | 'none' }> {
    if (explicitCohortId) {
      return { cohort: await this.get(projectId, explicitCohortId), source: 'explicit' };
    }
    if (periodCohortId) {
      const row = await this.prisma.measurementCohort.findFirst({ where: { id: periodCohortId, projectId } });
      if (row) return { cohort: this.toSummary(row), source: 'period' };
    }
    const latest = await this.prisma.measurementCohort.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (latest) return { cohort: this.toSummary(latest), source: 'latest' };
    return { cohort: null, source: 'none' };
  }

  /**
   * Compare two cohorts key by key.
   *
   * A null cohort is not "comparable by default": when either side has no
   * cohort the checks say so and {@link hasHardBreak} treats it as a break,
   * because an unpinned methodology cannot be shown to match another one.
   */
  buildChecks(current: CohortSummary | null, baseline: CohortSummary | null, context: ComparisonContext): ComparabilityCheck[] {
    const join = (values: string[] | undefined): string | null =>
      values && values.length > 0 ? [...values].map((v) => v.trim().toLowerCase()).sort().join(', ') : null;

    const check = (
      key: ComparabilityCheck['key'],
      label: string,
      a: string | number | null,
      b: string | number | null,
      isBreak: boolean,
      noteWhenDifferent: string,
    ): ComparabilityCheck => {
      const currentValue = a === null || a === undefined ? null : String(a);
      const baselineValue = b === null || b === undefined ? null : String(b);
      const same = currentValue === baselineValue;
      return {
        key,
        label,
        current: currentValue,
        baseline: baselineValue,
        same,
        isBreak: isBreak && !same,
        note: same ? 'Identical on both sides.' : noteWhenDifferent,
      };
    };

    const checks: ComparabilityCheck[] = [
      check('query-set', 'Query set', current?.querySetId ?? null, baseline?.querySetId ?? null, true, 'The two periods asked different questions; their rates are not the same measurement.'),
      check('query-set-version', 'Query set version', current?.querySetVersion ?? null, baseline?.querySetVersion ?? null, true, 'The question set changed between the two periods, so a rate change may be the change in wording.'),
      check('engines', 'Engines / surfaces', join(current?.engines), join(baseline?.engines), true, 'Different engines answer differently; the difference is the engine, not necessarily visibility.'),
      check('markets', 'Markets', join(current?.markets), join(baseline?.markets), true, 'A different market is a different population, not a movement in one.'),
      check('transport', 'Transport', current?.transport ?? null, baseline?.transport ?? null, true, 'An API answer and a browser-session answer are different observations of the same question.'),
      check('rubric-version', 'Score rubric version', context.currentRubricVersion, context.baselineRubricVersion, true, 'The rubric changed, so the two totals are computed differently. design_plan §6.3: read the versioned rubric; defaults can change.'),
      check('repeats-policy', 'Repeats per prompt', context.currentRepeats, context.baselineRepeats, false, 'Different repeat counts change the denominator; the floor of 5 applies to both.'),
      check('window-length', 'Window length (days)', context.currentWindowDays, context.baselineWindowDays, false, 'Unequal windows change exposure time; a longer window has more chances to observe a mention.'),
    ];

    // A missing cohort on either side is itself a break: there is no
    // fingerprint to show the two periods were measured the same way.
    if (!current || !baseline) {
      checks.push({
        key: 'query-set',
        label: 'Methodology pin',
        current: current ? current.methodologyHash : null,
        baseline: baseline ? baseline.methodologyHash : null,
        same: false,
        isBreak: true,
        note: !current
          ? 'The current period has no MeasurementCohort, so its methodology is unpinned and cannot be shown to match the baseline.'
          : 'The baseline period has no MeasurementCohort, so there is nothing to show it was measured the same way.',
      });
    } else if (current.methodologyHash !== baseline.methodologyHash) {
      checks.push({
        key: 'transport',
        label: 'Methodology fingerprint',
        current: current.methodologyHash,
        baseline: baseline.methodologyHash,
        same: false,
        isBreak: true,
        note: 'The stored fingerprints differ. One or more of the keys above changed; the individual differences are listed where the cohorts record them.',
      });
    }

    return checks;
  }

  /** True when any check invalidates the comparison outright. */
  hasHardBreak(checks: ComparabilityCheck[]): boolean {
    return checks.some((entry) => entry.isBreak && HARD_BREAK_KEYS.has(entry.key));
  }

  /** Just the breaks, for the response. */
  breaksOf(checks: ComparabilityCheck[]): ComparabilityCheck[] {
    return checks.filter((entry) => entry.isBreak);
  }

  /**
   * Persist a break discovered by a comparison.
   *
   * Deduplicated by `(previousHash, currentHash, againstCohortId)`: reading the
   * same comparison a hundred times records one break, because the break is a
   * fact about the pair, not about the read. The baseline period id is kept in
   * the reason text so an operator can see which comparison first found it.
   */
  async recordComparisonBreak(
    projectId: string,
    currentCohortId: string,
    baseline: { cohortId: string | null; periodId: string },
    checks: ComparabilityCheck[],
    reason: string,
  ): Promise<MethodologyBreak[]> {
    const row = await this.prisma.measurementCohort.findFirst({ where: { id: currentCohortId, projectId } });
    if (!row) return [];

    const current = this.toSummary(row);
    const keys = checks.filter((entry) => entry.isBreak).map((entry) => entry.key);
    if (keys.length === 0) return current.breaks;

    const alreadyRecorded = current.breaks.some(
      (entry) => entry.againstCohortId === baseline.cohortId && entry.previousHash === current.methodologyHash,
    );
    if (alreadyRecorded) return current.breaks;

    const recorded: MethodologyBreak = {
      at: new Date().toISOString(),
      reason,
      previousHash: current.methodologyHash,
      currentHash: null,
      againstCohortId: baseline.cohortId,
      keys,
    };
    const breaks = [...current.breaks, recorded];
    await this.prisma.measurementCohort.update({
      where: { id: currentCohortId },
      data: { breaks: JSON.stringify(breaks) },
    });
    return breaks;
  }

  // ── Privates ──────────────────────────────────────────────────────

  private async assertQuerySetBelongsToProject(querySetId: string, projectId: string): Promise<void> {
    const found = await this.prisma.querySet.findFirst({ where: { id: querySetId, projectId }, select: { id: true } });
    if (!found) throw new NotFoundException(`Query set ${querySetId} not found for project ${projectId}`);
  }

  private async assertRunBelongsToProject(runId: string, projectId: string): Promise<void> {
    const found = await this.prisma.measurementRun.findFirst({ where: { id: runId, projectId }, select: { id: true } });
    if (!found) throw new NotFoundException(`Measurement run ${runId} not found for project ${projectId}`);
  }

  /** The query set's own `version` column — the truth, not a caller's guess. */
  private async inferQuerySetVersion(querySetId: string | undefined): Promise<number | null> {
    if (!querySetId) return null;
    const set = await this.prisma.querySet.findUnique({ where: { id: querySetId }, select: { version: true } });
    return set?.version ?? null;
  }

  private diffKeys(
    current: CohortSummary,
    next: Pick<CohortSummary, 'engines' | 'markets' | 'transport' | 'querySetId' | 'querySetVersion' | 'methodologyHash'>,
  ): ComparabilityCheck['key'][] {
    const keys: ComparabilityCheck['key'][] = [];
    const sortJoin = (v: string[]) => [...v].map((x) => x.trim().toLowerCase()).sort().join(',');
    if (current.querySetId !== next.querySetId) keys.push('query-set');
    if (current.querySetVersion !== next.querySetVersion) keys.push('query-set-version');
    if (sortJoin(current.engines) !== sortJoin(next.engines)) keys.push('engines');
    if (sortJoin(current.markets) !== sortJoin(next.markets)) keys.push('markets');
    if ((current.transport ?? null) !== (next.transport ?? null)) keys.push('transport');
    return keys;
  }

  private toSummary(row: {
    id: string;
    name: string;
    querySetId: string | null;
    querySetVersion: number | null;
    engines: string;
    markets: string;
    transport: string | null;
    methodologyHash: string | null;
    baselineRunId: string | null;
    baselineAt: Date | null;
    breaks: string;
  }): CohortSummary {
    return {
      id: row.id,
      name: row.name,
      querySetId: row.querySetId,
      querySetVersion: row.querySetVersion,
      engines: parseStringArray(row.engines),
      markets: parseStringArray(row.markets),
      transport: row.transport,
      methodologyHash: row.methodologyHash,
      baselineRunId: row.baselineRunId,
      baselineAt: iso(row.baselineAt),
      breaks: parseJson<MethodologyBreak[]>(row.breaks, []),
    };
  }
}
