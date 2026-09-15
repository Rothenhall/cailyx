/**
 * Reporting Service — Aggregates audit data into branded diagnostic reports.
 *
 * Consumes (via Prisma):
 *   - TechnicalAudit + AuditFinding + PageMetadata (technical-audit)
 *   - SchemaCheck + PlatformRecord (entity-audit)
 *   - Gap + GapAnalysis (gap-analysis)
 *
 * Consumes (via injected service, all pure reads — never a rebuild/LLM/vendor call):
 *   - StrategyService.getActionPlan() — stage 9's ranked recommendations
 *   - FindingsService.list() — stage 8's LLM what/why/fix copy
 *   - BacklinksService.latest() — the project's latest DataForSEO backlinks pull
 *
 * Produces:
 *   - Scored report (PRD §8: Machine access 25, Entity clarity 25, Shortlist 20,
 *     Extractability 20, Authority 10)
 *   - Executive summary
 *   - Growth plan: stage 12's "Comprehensive Audit & Growth Report" →
 *     "Prioritized Growth Roadmap" (see `GrowthPlanDto`)
 *   - Branded HTML (FR-10.1, FR-10.4), stable slug URL, noindex default (FR-10.5)
 *
 * @module reporting.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import { join } from 'path';
import { readFileSync } from 'fs';
import { PrismaService } from '../database/prisma.service';
import { ScoringService } from '../scoring/scoring.service';
import { StrategyService } from '../strategy/strategy.service';
import { FindingsService } from '../findings/findings.service';
import { BacklinksService } from '../backlinks/backlinks.service';
import { PresenceService } from '../digital-presence/presence.service';
import { CompetitorsService } from '../competitors/competitors.service';
import type {
  ReportData,
  ReportFindingDto,
  ReportRoadmapDto,
  GrowthPlanDto,
  ScoreSummary,
  SubScore,
  ScoreBand,
  BrandingConfig,
} from './reporting.types';
import type { BacklinksSummaryDto } from '../backlinks/backlinks.types';
import type { PresenceInventory } from '../digital-presence/presence.types';
import type { GapResult } from '../competitors/competitors.service';


// Handlebars helper: {{#if_eq a b}}...{{/if_eq}}
Handlebars.registerHelper('if_eq', function (a: unknown, b: unknown, options: any) {
  return a === b ? options.fn(this) : options.inverse(this);
});

@Injectable()
export class ReportingService {
  private readonly logger = new Logger(ReportingService.name);

  private readonly defaultBranding: BrandingConfig = {
    orgName: process.env.REPORT_BRAND_NAME || 'Rothenhall Partners',
    tagline: process.env.REPORT_BRAND_TAGLINE || 'AI Visibility Diagnostics',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: ScoringService,
    private readonly strategy: StrategyService,
    private readonly findings: FindingsService,
    private readonly backlinksService: BacklinksService,
    private readonly presenceService: PresenceService,
    private readonly competitorsService: CompetitorsService,
  ) {}

  /** Best-effort presence inventory for a report — never throws, never blocks generation. */
  private async getPresenceSnapshot(projectId: string): Promise<PresenceInventory | null> {
    try {
      return await this.presenceService.inventory(projectId);
    } catch (err) {
      this.logger.warn(`Report: presence inventory unavailable for ${projectId} — continuing without it: ${(err as Error).message}`);
      return null;
    }
  }

  /** Best-effort competitor gap for a report — never throws (no tracked competitors is normal on day one, not an error). */
  private async getCompetitorsSnapshot(projectId: string): Promise<GapResult | null> {
    try {
      return await this.competitorsService.gap(projectId);
    } catch (err) {
      this.logger.warn(`Report: competitor gap unavailable for ${projectId} — continuing without it: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Generate report ──────────────────────────────────────────

  async generateReport(projectId: string, targetUrl: string, title: string): Promise<ReportData> {
    this.logger.log('Generating report for project ' + projectId);

    const audit = await this.prisma.technicalAudit.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { findings: true, pageMetadata: true },
    });

    if (!audit) {
      throw new NotFoundException('No technical audit found for project ' + projectId + '. Run a technical audit first.');
    }

    const roadmap = await this.getRoadmapSnapshot(projectId);
    const growthPlan = await this.getGrowthPlanSnapshot(projectId);
    const backlinks = await this.backlinksService.latest(projectId);
    const presence = await this.getPresenceSnapshot(projectId);
    const competitors = await this.getCompetitorsSnapshot(projectId);
    // §8 scoring moved into the versioned-rubric scoring module (FR-8.1–8.4):
    // real measurement inputs, evidence-linked sub-scores, rubric version recorded.
    const scoreResult = await this.scoring.scoreProject(projectId);
    const score: ScoreSummary = {
      total: scoreResult.total,
      band: scoreResult.band as ScoreBand,
      subScores: scoreResult.subScores as unknown as SubScore[],
      rubricVersion: scoreResult.rubricVersion,
    };

    const findings: ReportFindingDto[] = audit.findings.map((f: any) => ({
      type: f.type,
      status: f.status,
      severity: f.severity,
      confidence: f.confidence,
      detail: this.safeParse(f.detail),
      recommendedFix: f.recommendedFix,
      reproductionCommands: f.reproductionCommands ? this.safeParse(f.reproductionCommands) : null,
      createdAt: audit.createdAt.toISOString(),
    }));

    const executiveSummary = this.buildExecutiveSummary(title, audit.targetUrl, score, findings, roadmap, growthPlan);
    const slug = this.buildSlug(title);

    const record = await this.prisma.report.create({
      data: {
        projectId,
        slug,
        title,
        targetUrl: audit.targetUrl,
        visibility: 'private',
        executiveSummary,
        scoreTotal: score.total,
        scoreBand: score.band,
        subScores: JSON.stringify(score.subScores),
        findingsSnapshot: JSON.stringify(findings),
        roadmapSnapshot: JSON.stringify(roadmap),
        growthPlanSnapshot: JSON.stringify(growthPlan),
        backlinksSnapshot: backlinks ? JSON.stringify(backlinks) : null,
        presenceSnapshot: presence ? JSON.stringify(presence) : null,
        competitorsSnapshot: competitors ? JSON.stringify(competitors) : null,
        branding: JSON.stringify(this.defaultBranding),
      },
    });

    this.logger.log('Report generated: ' + slug + ' (score: ' + score.total + ', band: ' + score.band + ')');

    return {
      id: record.id,
      projectId,
      slug,
      title,
      targetUrl: audit.targetUrl,
      visibility: 'private',
      executiveSummary,
      scoreTotal: score.total,
      scoreBand: score.band,
      subScores: score.subScores,
      findings,
      roadmap,
      growthPlan,
      backlinks,
      presence,
      competitors,
      createdAt: record.createdAt.toISOString(),
    };
  }

  // ─── Get / list / visibility ─────────────────────────────────

  async getBySlug(slug: string, includePrivate: boolean = false): Promise<ReportData> {
    const record = await this.prisma.report.findUnique({ where: { slug } });
    if (!record) throw new NotFoundException('Report ' + slug + ' not found');
    if (record.visibility === 'private' && !includePrivate) {
      throw new NotFoundException('Report ' + slug + ' not found');
    }
    return this.toReportData(record);
  }

  async listReports(projectId: string) {
    const reports = await this.prisma.report.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, slug: true, title: true, targetUrl: true, visibility: true, scoreTotal: true, scoreBand: true, createdAt: true },
    });
    return { reports };
  }

  async setVisibility(projectId: string, slug: string, visibility: 'private' | 'public') {
    const record = await this.prisma.report.findUnique({ where: { slug } });
    if (!record || record.projectId !== projectId) {
      throw new NotFoundException('Report ' + slug + ' not found for project ' + projectId);
    }
    const updated = await this.prisma.report.update({
      where: { slug },
      data: { visibility },
      select: { slug: true, visibility: true },
    });
    this.logger.log('Report ' + slug + ' visibility set to ' + visibility);
    return updated;
  }

  // ─── Executive summary ────────────────────────────────────────

  private buildExecutiveSummary(
    title: string,
    url: string,
    score: ScoreSummary,
    findings: ReportFindingDto[],
    roadmap: ReportRoadmapDto[],
    growthPlan: GrowthPlanDto,
  ): string {
    const failures = findings.filter((f) => f.status === 'fail');
    const highSev = failures.filter((f) => f.severity === 'high');

    const lines: string[] = [];
    lines.push(title + ' scores ' + score.total + '/100 (' + score.band + ') on AI visibility.');
    lines.push('');

    if (failures.length === 0) {
      lines.push('No blocking issues found — all ' + findings.length + ' checks passed. AI crawlers can read the site and structured data is intact.');
    } else {
      lines.push(failures.length + ' of ' + findings.length + ' checks failed:');
      for (const f of failures) {
        const detail = f.detail as Record<string, unknown>;
        let extra = '';
        if (detail && 'contentLossPercent' in detail && typeof detail['contentLossPercent'] === 'number') {
          extra = ' (' + detail['contentLossPercent'] + '% content loss without JS)';
        }
        const firstSentence = f.recommendedFix.split('.')[0] + '.';
        lines.push('  - ' + f.type + ': ' + firstSentence + extra);
      }
      if (highSev.length > 0) {
        lines.push('');
        lines.push(highSev.length + ' HIGH-severity issue' + (highSev.length > 1 ? 's' : '') + ' need immediate attention.');
      }
    }

    if (roadmap.length > 0) {
      const fixes = roadmap.filter((r) => r.action === 'fix').length;
      const builds = roadmap.filter((r) => r.action === 'build').length;
      const influences = roadmap.filter((r) => r.action === 'influence').length;
      lines.push('');
      lines.push('Roadmap: ' + fixes + ' fix, ' + builds + ' build, ' + influences + ' influence items.');
    }

    if (growthPlan.actionPlan && growthPlan.actionPlan.recommendations.length > 0) {
      const top = growthPlan.actionPlan.recommendations[0]; // already ranked quick-wins-first
      lines.push('');
      lines.push(
        'Growth plan: ' + growthPlan.actionPlan.recommendations.length + ' recommendation categor' +
          (growthPlan.actionPlan.recommendations.length === 1 ? 'y' : 'ies') + ', top priority — ' + top.title + '.',
      );
    }

    return lines.join('\n');
  }

  // ─── Roadmap snapshot ─────────────────────────────────────────

  private async getRoadmapSnapshot(projectId: string): Promise<ReportRoadmapDto[]> {
    const gaps = await this.prisma.gap.findMany({
      where: { gapAnalysis: { projectId } },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
    });

    return gaps.map((g: any) => ({
      dimension: g.dimension,
      action: g.action,
      title: g.title,
      description: g.description,
      severity: g.severity,
      priorityScore: g.priorityScore,
      status: g.status,
    }));
  }

  // ─── Growth plan snapshot (stage 12 "Prioritized Growth Roadmap") ──

  /**
   * Both sources are pure reads — `strategy.getActionPlan()` returns the
   * last-built plan (null if `POST .../strategy/build` was never called);
   * `findings.list()` returns whatever `findings.generate()` has already
   * stored. Report generation never triggers either module to do fresh work.
   */
  private async getGrowthPlanSnapshot(projectId: string): Promise<GrowthPlanDto> {
    const [actionPlan, findingsResult] = await Promise.all([
      this.strategy.getActionPlan(projectId),
      this.findings.list(projectId),
    ]);

    return {
      actionPlan: actionPlan
        ? {
            recommendations: actionPlan.recommendations.map((r) => ({
              category: r.category,
              label: r.label,
              title: r.title,
              summary: r.summary,
              priorityRank: r.priorityRank,
              quickWinCount: r.quickWinCount,
              majorProjectCount: r.majorProjectCount,
              fillInCount: r.fillInCount,
              thanklessTaskCount: r.thanklessTaskCount,
              gapIds: r.gapIds,
            })),
            notCovered: actionPlan.notCovered,
            updatedAt: actionPlan.updatedAt,
          }
        : null,
      findingsCopy: findingsResult.findings.map((f: any) => ({
        gapId: f.gapId,
        title: f.title,
        whatExecutive: f.whatExecutive,
        whatTechnical: f.whatTechnical,
        whyExecutive: f.whyExecutive,
        whyTechnical: f.whyTechnical,
        fixExecutive: f.fixExecutive,
        fixTechnical: f.fixTechnical,
        thinRun: f.thinRun,
        disclosedGap: f.disclosedGap,
      })),
      assetsNote:
        'Stage 11 "Marketing & Growth Execution" (blog topics, ad angles, generated content/ad/landing-page assets) ' +
        'has no module yet — this section intentionally has no data rather than a fabricated one.',
    };
  }

  // ─── HTML render (FR-10.1, FR-10.3) ──────────────────────────

  async renderHtml(slug: string, view: 'executive' | 'detailed' = 'executive', includePrivate: boolean = false): Promise<string> {
    const report = await this.getBySlug(slug, includePrivate);
    let templateSrc: string;
    try {
      templateSrc = readFileSync(join(__dirname, 'templates', 'report-html.hbs'), 'utf8');
    } catch {
      templateSrc = readFileSync(join(process.cwd(), 'src', 'modules', 'reporting', 'templates', 'report-html.hbs'), 'utf8');
    }
    const template = Handlebars.compile(templateSrc);
    return template({ report, view, branding: this.defaultBranding });
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private safeParse(value: string | null | undefined): any {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private buildSlug(title: string): string {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base + '-' + Date.now().toString(36);
  }

  private toReportData(record: any): ReportData {
    return {
      id: record.id,
      projectId: record.projectId,
      slug: record.slug,
      title: record.title,
      targetUrl: record.targetUrl,
      visibility: record.visibility,
      executiveSummary: record.executiveSummary,
      scoreTotal: record.scoreTotal,
      scoreBand: record.scoreBand,
      subScores: (this.safeParse(record.subScores) as SubScore[]) || [],
      findings: (this.safeParse(record.findingsSnapshot) as ReportFindingDto[]) || [],
      roadmap: (this.safeParse(record.roadmapSnapshot) as ReportRoadmapDto[]) || [],
      // Reports generated before this field existed have no column value at all.
      growthPlan: record.growthPlanSnapshot ? (this.safeParse(record.growthPlanSnapshot) as GrowthPlanDto) : null,
      backlinks: record.backlinksSnapshot ? (this.safeParse(record.backlinksSnapshot) as BacklinksSummaryDto) : null,
      presence: record.presenceSnapshot ? (this.safeParse(record.presenceSnapshot) as PresenceInventory) : null,
      competitors: record.competitorsSnapshot ? (this.safeParse(record.competitorsSnapshot) as GapResult) : null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
