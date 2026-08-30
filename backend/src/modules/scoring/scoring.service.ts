/**
 * Scoring Service — the PRD §8 weighted roll-up as a versioned, persisted,
 * evidence-linked module (FR-8.1–8.4).
 *
 * Hard rules (PLAN §7, PRD §8):
 * - The score is a communication device; the Observations are the truth —
 *   every sub-score carries evidence lines, never a bare number (FR-8.3).
 * - FR-8.2: weights and bands live on versioned rubric rows; a score run
 *   records which rubric version it used. v1 is seeded with PRD defaults.
 * - FR-8.4: a missing or failed evidence source marks the dimension partial —
 *   it contributes 0 (nothing was measured) but the run is flagged `partial`
 *   and the reason is recorded. Never inflate by re-normalizing.
 * - Real inputs: shortlist presence reads the measurement summary
 *   (mention rate + share of voice), not coverage proxies.
 *
 * @module scoring.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MeasurementService } from '../measurement/measurement.service';
import { DEFAULT_BANDS, DEFAULT_WEIGHTS, DIMENSIONS } from './scoring.types';
import type {
  Dimension,
  DimensionInput,
  RunStatus,
  ScoreBand,
  ScoringResult,
  ScoringInput,
  SubScore,
} from './scoring.types';

/** Shape of the rubric's weights JSON column. */
type RubricWeights = Record<Dimension, number>;

/** Minimal technical-audit finding row needed for dimension evaluation. */
interface AuditFindingRow {
  type: string;
  status: string;
  severity: string;
}

/** Minimal entity-audit shape needed for entity/authority evaluation. */
interface EntityAuditShape {
  entities: Array<{
    schemaChecks: Array<{ status: string; schemaType: string | null }>;
    platformRecords: Array<{ source: string }>;
  }>;
}

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly measurement: MeasurementService,
  ) {}

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Score a project against the active rubric and persist a ScoreRun.
   * @throws NotFoundException when the project or active rubric is missing.
   */
  async scoreProject(projectId: string): Promise<ScoringResult> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    let rubric = await this.prisma.scoreRubric.findFirst({ where: { active: true } });
    if (!rubric) {
      // Out-of-the-box: seed rubric v1 with the PRD §8 defaults (first-ever
      // rubric activates itself in createRubric).
      this.logger.log('No active rubric — seeding PRD §8 default rubric v1');
      await this.createRubric({ note: 'Auto-seeded PRD §8 defaults (25/25/20/20/10; invisible/faint/present/recommended)' });
      rubric = await this.prisma.scoreRubric.findFirst({ where: { active: true } });
      if (!rubric) throw new NotFoundException('Rubric seeding failed');
    }

    const weights = this.parseWeights(rubric.weights);
    const bands = this.parseBands(rubric.bands);

    const input = await this.gatherInputs(projectId);
    const { subScores, total, status } = this.evaluate(input, weights);
    const band = this.bandFor(total, bands);

    const created = await this.prisma.scoreRun.create({
      data: {
        projectId,
        rubricVersion: rubric.version,
        total,
        band,
        status,
        subScores: JSON.stringify(subScores),
      },
    });

    this.logger.log(
      'Scored project ' + projectId + ': ' + total + '/100 (' + band + ') on rubric v' + rubric.version + ' [' + status + ']',
    );
    return {
      id: created.id,
      rubricVersion: rubric.version,
      total,
      band,
      status,
      subScores,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /** One score run with evidence, project-ownership checked. */
  async getScoreRun(projectId: string, runId: string) {
    const run = await this.prisma.scoreRun.findFirst({ where: { id: runId, projectId } });
    if (!run) throw new NotFoundException('Score run not found in this project: ' + runId);
    return { ...run, subScores: JSON.parse(run.subScores) };
  }

  /** List score runs for a project, newest first. */
  async listScoreRuns(projectId: string) {
    const runs = await this.prisma.scoreRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return runs.map((r) => ({ ...r, subScores: JSON.parse(r.subScores) }));
  }

  /** Latest score run, or null when never scored. Used by reporting. */
  async getLatest(projectId: string): Promise<ScoringResult | null> {
    const run = await this.prisma.scoreRun.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) return null;
    return {
      id: run.id,
      rubricVersion: run.rubricVersion,
      total: run.total,
      band: run.band as ScoreBand,
      status: run.status as RunStatus,
      subScores: JSON.parse(run.subScores),
      createdAt: run.createdAt.toISOString(),
    };
  }

  // ─── Rubric management (FR-8.2) ───────────────────────────────

  /** List all rubric versions, newest first. */
  async listRubrics() {
    return this.prisma.scoreRubric.findMany({ orderBy: { version: 'desc' } });
  }

  /**
   * Create a rubric version. Weights must sum to 100. The first-ever rubric
   * becomes active automatically; otherwise pass activate:true to switch
   * (previous active rows are deactivated).
   * @throws BadRequestException when weights do not sum to 100.
   */
  async createRubric(input: {
    version?: number;
    weights?: Partial<RubricWeights>;
    bands?: Array<{ max: number; band: string }>;
    activate?: boolean;
    note?: string;
  }) {
    const weights: RubricWeights = input.weights
      ? ({ ...DEFAULT_WEIGHTS, ...input.weights } as RubricWeights)
      : { ...DEFAULT_WEIGHTS };
    const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (weightSum !== 100) {
      throw new BadRequestException(
        'Rubric weights must sum to 100 (PRD §8) — got ' + weightSum,
      );
    }

    const bands =
      input.bands && input.bands.length > 0
        ? input.bands.map((b) => ({ max: b.max, band: b.band as ScoreBand }))
        : DEFAULT_BANDS;

    let version = input.version;
    if (version === undefined) {
      const latest = await this.prisma.scoreRubric.findFirst({ orderBy: { version: 'desc' } });
      version = (latest?.version ?? 0) + 1;
    }
    if (version < 1) throw new BadRequestException('Rubric version must be >= 1');

    const anyActive = (await this.prisma.scoreRubric.count({ where: { active: true } })) > 0;
    const activate = input.activate === true || !anyActive;
    if (activate && anyActive) {
      await this.prisma.scoreRubric.updateMany({ where: { active: true }, data: { active: false } });
    }

    return this.prisma.scoreRubric.create({
      data: {
        version,
        weights: JSON.stringify(weights),
        bands: JSON.stringify(bands),
        active: activate,
        note: input.note ?? null,
      },
    });
  }

  // ─── Evidence gathering ───────────────────────────────────────

  /**
   * Collect every dimension's evidence. Each missing source becomes a partial
   * dimension with a reason — never a silent zero (FR-8.4).
   */
  private async gatherInputs(projectId: string): Promise<ScoringInput> {
    const [audit, entityAudit, measurementSummary] = await Promise.all([
      this.prisma.technicalAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { findings: true },
      }),
      this.prisma.entityAudit.findFirst({
        where: { projectId },
        include: { entities: { include: { schemaChecks: true, platformRecords: true } } },
      }),
      this.safeMeasurementSummary(projectId),
    ]);

    const findings = (audit?.findings ?? undefined) as AuditFindingRow[] | undefined;
    const entities = (entityAudit?.entities ?? undefined) as EntityAuditShape['entities'] | undefined;

    return {
      machineAccess: this.evalMachineAccess(findings),
      entityClarity: this.evalEntityClarity(entities),
      shortlistPresence: this.evalShortlist(measurementSummary),
      extractability: this.evalExtractability(findings),
      authority: this.evalAuthority(entities, findings),
    };
  }

  /** Measurement summary never blocks scoring — its failure is one partial dimension. */
  private async safeMeasurementSummary(projectId: string) {
    try {
      const hasRuns = await this.prisma.measurementRun.findFirst({ where: { projectId } });
      if (!hasRuns) return null;
      return await this.measurement.summary(projectId);
    } catch {
      return null;
    }
  }

  // ─── Dimension evaluators ─────────────────────────────────────

  private evalMachineAccess(findings?: AuditFindingRow[]): DimensionInput {
    if (!findings) {
      return { value: null, evidence: [], partial: true, partialReason: 'No technical audit run — crawler access unmeasured' };
    }
    const rows = findings.filter((f) => ['robots', 'cdn-inferred'].includes(f.type));
    if (rows.length === 0) {
      return { value: null, evidence: [], partial: true, partialReason: 'Audit ran but produced no robots/CDN findings' };
    }
    const pass = rows.filter((f) => f.status === 'pass').length;
    return {
      value: Math.round((pass / rows.length) * 100),
      evidence: rows.map((f) => f.type + ': ' + f.status + ' (' + f.severity + ')'),
      partial: false,
    };
  }

  private evalEntityClarity(entities?: EntityAuditShape['entities']): DimensionInput {
    const checks = entities?.flatMap((e) => e.schemaChecks) ?? [];
    if (checks.length === 0) {
      return { value: null, evidence: [], partial: true, partialReason: 'No entity schema checks run yet' };
    }
    const pass = checks.filter((c) => c.status === 'pass').length;
    return {
      value: Math.round((pass / checks.length) * 100),
      evidence: checks.map((c) => 'Schema: ' + (c.schemaType || 'none') + ' — ' + c.status),
      partial: false,
    };
  }

  /** Real measurement-derived shortlist presence (mention rate + share of voice). */
  private evalShortlist(
    summary: Awaited<ReturnType<MeasurementService['summary']>> | null,
  ): DimensionInput {
    if (summary && summary.observations > 0) {
      const sov = summary.shareOfVoice.find((s) => s.name.endsWith('(you)'))?.share ?? 0;
      const value = Math.round(summary.mentionRate * 50 + sov * 50);
      return {
        value,
        evidence: [
          'Mention rate ' + (summary.mentionRate * 100).toFixed(1) + '% over ' + summary.observations + ' observations',
          'Share of voice (you): ' + (sov * 100).toFixed(1) + '%',
          'Surfaces: ' + summary.bySurface.map((s) => s.surface).join(', '),
        ],
        partial: false,
      };
    }
    return {
      value: null,
      evidence: ['No measurement observations yet — run the measurement engine against an active query set'],
      partial: true,
      partialReason: 'Measurement not run — shortlist presence cannot be scored',
    };
  }

  private evalExtractability(findings?: AuditFindingRow[]): DimensionInput {
    if (!findings) {
      return { value: null, evidence: [], partial: true, partialReason: 'No technical audit run' };
    }
    const rows = findings.filter((f) => ['js-render', 'cwv'].includes(f.type));
    if (rows.length === 0) {
      return { value: null, evidence: [], partial: true, partialReason: 'Audit ran but no js-render/CWV findings recorded' };
    }
    const pass = rows.filter((f) => f.status === 'pass').length;
    return {
      value: Math.round((pass / rows.length) * 100),
      evidence: rows.map((f) => f.type + ': ' + f.status),
      partial: false,
    };
  }

  private evalAuthority(
    entities?: EntityAuditShape['entities'],
    findings?: AuditFindingRow[],
  ): DimensionInput {
    const schemaFinding = findings?.find((f) => f.type === 'schema');
    const platformRecords = entities?.flatMap((e) => e.platformRecords) ?? [];
    const evidence: string[] = [];
    let score = 0;

    if (schemaFinding) {
      if (schemaFinding.status === 'pass') {
        score += 50;
        evidence.push('Structured-data audit passed (+50)');
      } else {
        evidence.push('Schema audit: ' + schemaFinding.status + ' (+0)');
      }
    }
    if (platformRecords.length > 0) {
      score += 50;
      evidence.push('Platform records present: ' + platformRecords.map((r) => r.source).join(', ') + ' (+50)');
    } else {
      evidence.push('No platform records linked to entities (+0)');
    }

    if (!schemaFinding && platformRecords.length === 0) {
      return {
        value: null,
        evidence,
        partial: true,
        partialReason: 'No schema audit and no platform records — authority evidence absent',
      };
    }
    return { value: score, evidence, partial: false };
  }

  // ─── Roll-up ──────────────────────────────────────────────────

  /**
   * Weighted roll-up. Partial dimensions contribute 0 — never inflated — and
   * the run is flagged partial so consumers know the number is a floor (FR-8.4).
   */
  private evaluate(input: ScoringInput, weights: RubricWeights): { subScores: SubScore[]; total: number; status: RunStatus } {
    const byDim: Record<Dimension, DimensionInput> = {
      'Machine access': input.machineAccess,
      'Entity clarity': input.entityClarity,
      'Shortlist presence': input.shortlistPresence,
      'On-page extractability': input.extractability,
      'Authority signal': input.authority,
    };

    const subScores: SubScore[] = DIMENSIONS.map((dim) => {
      const d = byDim[dim];
      const weight = weights[dim];
      if (d.partial || d.value === null) {
        return {
          dimension: dim,
          weight,
          value: 0,
          contribution: 0,
          evidence: d.evidence,
          partial: true,
          ...(d.partialReason ? { partialReason: d.partialReason } : {}),
        };
      }
      return {
        dimension: dim,
        weight,
        value: d.value,
        contribution: Math.round((d.value / 100) * weight),
        evidence: d.evidence,
        partial: false,
      };
    });

    const total = subScores.reduce((sum, s) => sum + s.contribution, 0);
    const status: RunStatus = subScores.some((s) => s.partial) ? 'partial' : 'complete';
    return { subScores, total, status };
  }

  private bandFor(total: number, bands: Array<{ max: number; band: ScoreBand }>): ScoreBand {
    for (const row of bands) {
      if (total <= row.max) return row.band;
    }
    return bands[bands.length - 1].band;
  }

  private parseWeights(raw: string): RubricWeights {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    return { ...DEFAULT_WEIGHTS, ...(parsed as Partial<RubricWeights>) };
  }

  private parseBands(raw: string): Array<{ max: number; band: ScoreBand }> {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const rows = parsed.filter(
          (r): r is { max: number; band: ScoreBand } =>
            typeof r === 'object' && r !== null && typeof (r as { max?: unknown }).max === 'number' && typeof (r as { band?: unknown }).band === 'string',
        );
        if (rows.length > 0) return rows;
      }
    } catch {
      // fall through to defaults
    }
    return DEFAULT_BANDS;
  }
}