/**
 * Findings Service — gap rows turned into what/why/fix copy in two registers
 * (PRD FR-9.1–9.3), passed through the claims-discipline filter before storage.
 *
 * LLM choice (docs/analysis/wave-2.md): Anthropic SDK with a strict JSON
 * schema and a claims-discipline post-check — never free-form copy.
 * FR-9.1 degrades honestly: when evidence is thin, the finding is stored
 * `thinRun` with a disclosed gap, not inflated prose.
 *
 * Generation requires ANTHROPIC_API_KEY. One Finding row per generated gap;
 * re-generating creates a fresh batch.
 *
 * @module findings.service
 */

import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { ClaimsService } from '../claims/claims.service';
import { BANNED_PHRASES } from '../claims/claims.types';
import { MIN_FINDINGS, NON_OBVIOUS_MIN_EVIDENCE } from './findings.types';
import type { CheckReport } from '../claims/claims.types';
import type { FindingCopy, GeneratedFinding } from './findings.types';

/** Context handed to the LLM per finding — evidence only, no free data. */
interface FindingContext {
  gapId: string;
  title: string;
  description: string;
  dimension: string;
  action: string;
  severity: string | null;
  evidence: string[];
  thinRun: boolean;
}

@Injectable()
export class FindingsService {
  private readonly logger = new Logger(FindingsService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly claims: ClaimsService,
  ) {}

  /**
   * Generate findings copy for a project: ranks its open gaps, picks the top
   * ones by priority score, constrains an LLM per finding, filters through
   * claims discipline, and stores Finding rows.
   * @throws ServiceUnavailableException when ANTHROPIC_API_KEY is missing.
   * @throws NotFoundException when the project or its gap analysis is missing.
   */
  async generate(projectId: string, input?: { limit?: number }): Promise<{ findings: GeneratedFinding[]; thinRun: boolean }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    if (!this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException('ANTHROPIC_API_KEY not configured — findings copy generation unavailable');
    }

    const limit = Math.min(Math.max(input?.limit ?? 5, 1), 10);
    const contexts = await this.selectFindings(projectId, limit);

    const results: GeneratedFinding[] = [];
    for (const ctx of contexts) {
      try {
        const copy = await this.generateCopy(project.name, ctx);
        const report = this.claims.checkCopy(this.copyText(copy));
        if (report.banned.length > 0) {
          this.logger.warn('Generated copy hit banned phrases for "' + ctx.title + '" — regenerating once with explicit bans');
          const retry = await this.generateCopy(project.name, ctx, {
            bannedMatches: report.banned.map((b) => b.match),
          });
          const recheck = this.claims.checkCopy(this.copyText(retry));
          if (recheck.banned.length > 0) {
            this.logger.error('Copy for "' + ctx.title + '" still violates discipline — skipped');
            continue;
          }
          results.push(await this.store(projectId, ctx, retry, recheck));
          continue;
        }
        results.push(await this.store(projectId, ctx, copy, report));
      } catch (err) {
        this.logger.error('Copy generation failed for "' + ctx.title + '": ' + (err as Error).message);
      }
    }

    const thinRun = results.length < MIN_FINDINGS;
    if (thinRun) {
      this.logger.warn('Thin findings run for project ' + projectId + ': ' + results.length + ' finding(s)');
    }
    return { findings: results, thinRun };
  }

  /** List stored findings for a project (thinRun flagged when below the floor). */
  async list(projectId: string) {
    const rows = await this.prisma.finding.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    return { findings: rows, thinRun: rows.length < MIN_FINDINGS };
  }

  /** Raw rows for single-finder lookups (controller does the 404 mapping). */
  async findingRows(projectId: string) {
    return this.prisma.finding.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  // ─── Selection + evidence (FR-9.1) ────────────────────────────

  /**
   * Pick the top open gaps by priorityScore and attach what evidence exists.
   * Non-obvious test: evidence from >= 2 modules (audit / measurement / entity)
   * OR a high severity; gaps failing it still generate but are flagged thinRun
   * with a disclosed gap rather than getting inflated prose.
   */
  private async selectFindings(projectId: string, limit: number): Promise<FindingContext[]> {
    const [gapAnalysis, audit, hasObservations, entityAudit] = await Promise.all([
      this.prisma.gapAnalysis.findFirst({ where: { projectId } }),
      this.prisma.technicalAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { findings: { take: 8 } },
      }),
      this.prisma.observation.findFirst({ where: { run: { projectId } }, select: { id: true } }),
      this.prisma.entityAudit.findFirst({ where: { projectId }, include: { entities: { take: 1 } } }),
    ]);
    if (!gapAnalysis) {
      throw new NotFoundException('No gap analysis for project ' + projectId + ' — run gap-analysis sync first');
    }

    const gaps = await this.prisma.gap.findMany({
      where: { gapAnalysisId: gapAnalysis.id, status: 'open' },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    const evidenceModules = [
      audit ? 'technical-audit' : null,
      hasObservations ? 'measurement' : null,
      entityAudit ? 'entity-audit' : null,
    ].filter((m): m is string => m !== null);

    return gaps.map((gap) => {
      const highSeverity = gap.severity === 'high' || gap.severity === 'critical';
      const nonObvious = evidenceModules.length >= NON_OBVIOUS_MIN_EVIDENCE || highSeverity;
      return {
        gapId: gap.id,
        title: gap.title,
        description: gap.description,
        dimension: gap.dimension,
        action: gap.action,
        severity: gap.severity,
        evidence: [
          ...(audit?.findings ?? []).map((f) => 'audit: ' + f.type + ' ' + f.status + ' (' + f.severity + ')'),
          hasObservations ? 'measurement: observations exist' : '',
          entityAudit ? 'entity: schema checks exist' : '',
        ].filter((s) => s !== ''),
        thinRun: !nonObvious || evidenceModules.length === 0,
      };
    });
  }

  // ─── Constrained generation (FR-9.3) ──────────────────────────

  private async generateCopy(
    projectName: string,
    ctx: FindingContext,
    opts?: { bannedMatches?: string[] },
  ): Promise<FindingCopy> {
    const client = this.ensureClient();
    const avoid =
      opts?.bannedMatches && opts.bannedMatches.length > 0
        ? '\n\nSTRICTLY BANNED (you already used these — never repeat them): ' +
          opts.bannedMatches.map((b) => '"' + b + '"').join(', ')
        : '';

    const response = await client.messages.create({
      model: this.config.get<string>('FINDINGS_MODEL', 'claude-opus-5'),
      max_tokens: 1500,
      system:
        'You write findings copy for an AI-visibility audit product. Two registers, always:\n' +
        '- executive: 2 sentences max, no jargon, no hedging\n' +
        '- technical: precise, references only the concrete evidence given\n' +
        'Never state numbers that are not in the evidence. Never use these phrases or close synonyms of them: ' +
        BANNED_PHRASES.map((p) => '"' + p + '"').join(', ') +
        '.\nRespond with ONLY JSON matching: ' +
        '{"whatExecutive":string,"whatTechnical":string,"whyExecutive":string,"whyTechnical":string,"fixExecutive":string,"fixTechnical":string}',
      messages: [
        {
          role: 'user',
          content:
            'Finding for client "' + projectName + '":\n' +
            'Title: ' + ctx.title + '\n' +
            'Dimension: ' + ctx.dimension + '\n' +
            'Action: ' + ctx.action + '\n' +
            'Severity: ' + (ctx.severity ?? 'unknown') + (ctx.thinRun ? ' (thin evidence run — say what is missing in why-technical)' : '') + '\n' +
            'Description: ' + ctx.description + '\n' +
            'Evidence (the only facts you may reference): ' + (ctx.evidence.join('; ') || 'none') + avoid,
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Model returned non-JSON copy for "' + ctx.title + '"');
    }
    return this.validateCopyShape(parsed);
  }

  /** Narrow the parsed JSON to the six-attribute copy shape; throw on any gap. */
  private validateCopyShape(value: unknown): FindingCopy {
    const required: Array<keyof FindingCopy> = [
      'whatExecutive',
      'whatTechnical',
      'whyExecutive',
      'whyTechnical',
      'fixExecutive',
      'fixTechnical',
    ];
    if (typeof value !== 'object' || value === null) {
      throw new Error('Copy JSON was not an object');
    }
    const obj = value as Record<string, unknown>;
    for (const key of required) {
      if (typeof obj[key] !== 'string' || (obj[key] as string).length < 5) {
        throw new Error('Copy missing or too short: ' + key);
      }
    }
    return {
      whatExecutive: obj.whatExecutive as string,
      whatTechnical: obj.whatTechnical as string,
      whyExecutive: obj.whyExecutive as string,
      whyTechnical: obj.whyTechnical as string,
      fixExecutive: obj.fixExecutive as string,
      fixTechnical: obj.fixTechnical as string,
    };
  }

  // ─── Persistence ──────────────────────────────────────────────

  private async store(
    projectId: string,
    ctx: FindingContext,
    copy: FindingCopy,
    report: CheckReport,
  ): Promise<GeneratedFinding> {
    const disclosedGap = ctx.thinRun
      ? 'Evidence below the non-obvious threshold: ' + (ctx.evidence.join('; ') || 'none recorded')
      : null;
    await this.prisma.finding.create({
      data: {
        projectId,
        gapId: ctx.gapId,
        title: ctx.title,
        whatExecutive: copy.whatExecutive,
        whatTechnical: copy.whatTechnical,
        whyExecutive: copy.whyExecutive,
        whyTechnical: copy.whyTechnical,
        fixExecutive: copy.fixExecutive,
        fixTechnical: copy.fixTechnical,
        thinRun: ctx.thinRun,
        disclosedGap,
      },
    });
    return {
      gapId: ctx.gapId,
      title: ctx.title,
      copy,
      thinRun: ctx.thinRun,
      disclosedGap,
      violations: report.violations.filter((v) => v.startsWith('Banned phrase')),
    };
  }

  private copyText(copy: FindingCopy): string {
    return [copy.whatExecutive, copy.whatTechnical, copy.whyExecutive, copy.whyTechnical, copy.fixExecutive, copy.fixTechnical].join(' ');
  }

  private ensureClient(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.anthropic;
  }
}