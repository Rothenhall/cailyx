/**
 * Reporting Service — Aggregates audit data into branded diagnostic reports.
 *
 * Consumes (via Prisma):
 *   - TechnicalAudit + AuditFinding + PageMetadata (technical-audit)
 *   - SchemaCheck + PlatformRecord (entity-audit)
 *   - Gap + GapAnalysis (gap-analysis)
 *
 * Produces:
 *   - Scored report (PRD §8: Machine access 25, Entity clarity 25, Shortlist 20,
 *     Extractability 20, Authority 10)
 *   - Executive summary
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
import type {
  ReportData,
  ReportFindingDto,
  ReportRoadmapDto,
  ScoreSummary,
  SubScore,
  ScoreBand,
  BrandingConfig,
} from './reporting.types';


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
  ) {}

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

    const executiveSummary = this.buildExecutiveSummary(title, audit.targetUrl, score, findings, roadmap);
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

  // ─── HTML render (FR-10.1, FR-10.3) ──────────────────────────

  async renderHtml(slug: string, view: 'executive' | 'detailed' = 'executive'): Promise<string> {
    const report = await this.getBySlug(slug, true);
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
      createdAt: record.createdAt.toISOString(),
    };
  }
}
