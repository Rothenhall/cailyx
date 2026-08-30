/**
 * Scorecard Service — Rung 0 free diagnostic (PRD §13, PLAN Phase 4).
 *
 * Runs the REAL pipeline at low depth (technical audit → versioned rubric
 * scoring) and derives exactly 3 named, specific problems from the run's own
 * evidence — deterministically, no LLM required, so the free tier works with
 * zero API keys (the funnel must never block on a paid key).
 *
 * The non-obvious guarantee (SOP): a scorecard is only marked nonObvious when
 * its evidence contains a fact the prospect could not know without running the
 * probes — a confirmed bot block, a schema failure, a render-dependency loss.
 *
 * @module scorecard.service
 */

import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { TechnicalAuditService } from '../technical-audit/technical-audit.service';
import { ScoringService } from '../scoring/scoring.service';
import { SubScore } from '../scoring/scoring.types';
import { ScorecardProblem, ScorecardResult } from './scorecard.types';

/** Deterministic next move per scoring dimension. */
const FIXES: Record<string, string> = {
  machineAccess: 'Unblock the named AI crawlers in robots.txt / CDN rules, then re-run the access probe to confirm a 200 for each agent.',
  entityClarity: 'Converge the entity descriptors (schema.org Organization/Person, platform profiles) onto one consistent description, then re-run the entity audit.',
  shortlistPresence: 'Claim the contexts where competitors are being named: listicles, comparisons, review sites — then measure again across the full query set.',
  extractability: 'Restructure pages: lead with the answer (BLUF), question-shaped H2s, extractable claims with sources — re-run page analysis after shipping.',
  authority: 'Build the citable sources: original data assets, expert attribution, and mentions that third parties corroborate.',
};

/** Evidence fragments that count as a non-obvious, probe-only finding. */
const NON_OBVIOUS = /blocked|403|disallow|no schema|missing.*schema|schema audit: fail|js.?render|not.*render|robots\.txt/i;

@Injectable()
export class ScorecardService {
  private readonly logger = new Logger(ScorecardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly technicalAudit: TechnicalAuditService,
    private readonly scoring: ScoringService,
  ) {}

  /** Public-project launch flag (PRD §17): operator-only until set. */
  get publicEnabled(): boolean {
    return this.config.get<string>('SCORECARD_PUBLIC') === '1';
  }

  /**
   * Run the free diagnostic. Always executes a fresh technical audit so the
   * score reflects probe evidence, then scores against the active rubric.
   */
  async run(projectId: string, depth: 'free' | 'operator' = 'free'): Promise<ScorecardResult> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // Low-depth but REAL: a fresh access/on-page probe against the project domain.
    const targetUrl = project.domain.startsWith('http') ? project.domain : `https://${project.domain}`;
    try {
      await this.technicalAudit.runAudit(targetUrl, projectId, 'manual');
    } catch (err) {
      // Never block the scorecard on probe failure — the affected dimensions
      // come back partial with a reason (FR-8.4), which is itself the finding.
      this.logger.warn(`Technical audit failed for ${targetUrl}: ${(err as Error).message}`);
    }

    const scoring = await this.scoring.scoreProject(projectId);
    const problems = this.topProblems(scoring.subScores);
    const nonObvious = problems.some((p) => p.evidence.some((line) => NON_OBVIOUS.test(line)));

    const row = await this.prisma.scorecardRun.create({
      data: {
        projectId,
        score: scoring.total,
        band: scoring.band,
        topFindings: JSON.stringify(problems),
        nonObvious,
        depth,
      },
    });

    return {
      id: row.id,
      projectId,
      score: scoring.total,
      band: scoring.band,
      problems,
      nonObvious,
      depth,
      publicToken: row.publicToken,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Exactly 3 named problems: lowest-value dimensions first, partials included with their reason. */
  topProblems(subScores: SubScore[]): ScorecardProblem[] {
    const ordered = [...subScores].sort((a, b) => (a.value ?? -1) - (b.value ?? -1));
    return ordered.slice(0, 3).map((s) => this.toProblem(s));
  }

  private toProblem(s: SubScore): ScorecardProblem {
    return {
      dimension: s.dimension,
      value: s.value,
      why: s.evidence[0] ?? s.partialReason ?? 'No evidence line on record for this dimension',
      fix: FIXES[s.dimension] ?? 'Re-run the diagnostic after remediation.',
      evidence: s.evidence,
    };
  }

  /** List a project's scorecard runs, newest first. */
  async list(projectId: string) {
    const rows = await this.prisma.scorecardRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.project(r));
  }

  /** One run, ownership-checked. */
  async get(projectId: string, runId: string) {
    const row = await this.prisma.scorecardRun.findFirst({ where: { id: runId, projectId } });
    if (!row) throw new NotFoundException('Scorecard run not found in this project: ' + runId);
    return this.project(row);
  }

  /** Public token view — the FR-13 shareable scorecard URL (unguessable cuid). */
  async getByPublicToken(token: string) {
    if (!this.publicEnabled) {
      throw new ForbiddenException('Public scorecards are disabled (set SCORECARD_PUBLIC=1 to launch the funnel)');
    }
    const row = await this.prisma.scorecardRun.findUnique({ where: { publicToken: token } });
    if (!row) throw new NotFoundException('No scorecard for this token');
    return this.project(row);
  }

  /** Column presentation with parsed problems. */
  private project(row: { [k: string]: unknown; topFindings: string }) {
    return { ...row, problems: JSON.parse(row.topFindings), topFindings: undefined };
  }
}