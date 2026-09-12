/**
 * Technical Audit Controller — REST API endpoints.
 *
 * Uses DTOs with class-validator for input validation (@IsUrl prevents SSRF).
 * Rate-limited via @nestjs/throttler — audit runs are expensive (20+ probes + Playwright + PSI API),
 * so POST /run is limited to 3 per minute. Other endpoints use the global default (100/60s).
 *
 * Persistence: TechnicalAudit + AuditFinding + PageMetadata stored in PostgreSQL via PrismaService.
 * Scheduling: Recurring audits managed via SchedulingService (BullMQ + Redis).
 *
 * @module technical-audit.controller
 */

import {
  Controller,
  Post,
  Get,
  Put,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TechnicalAuditService } from './technical-audit.service';
import { RunAuditDto, SetScheduleDto } from './dto/technical-audit.dto';
import { PrismaService } from '../database/prisma.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';

@ApiTags('Technical Audit')
@Controller('projects/:projectId/technical-audit')
export class TechnicalAuditController {
  constructor(
    private readonly auditService: TechnicalAuditService,
    private readonly prisma: PrismaService,
    private readonly scheduling: SchedulingService,
    private readonly pipelineQueue: PipelineQueueService,
  ) {}

  /**
   * Trigger a manual technical audit for a project's target URL.
   * Executes all 5 checks: robots.txt, CDN probe, JS render, CWV, schema.
   *
   * Runs on the background pipeline queue — this returns immediately with a
   * jobId. Poll GET run/jobs/:jobId for status/result. Rate-limited to 3
   * requests per 60s per IP (audit runs are expensive).
   */
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Queue a technical audit',
    description: 'Queues all 5 checks (robots.txt, CDN probe, JS render, CWV, schema) on the background pipeline. Returns a jobId immediately — poll GET run/jobs/:jobId for status and, once completed, the result. Rate-limited to 3/minute.',
  })
  @ApiBody({ type: RunAuditDto })
  @ApiResponse({ status: 202, description: 'Audit queued' })
  @ApiResponse({ status: 400, description: 'Invalid URL — must be a valid http(s) URL' })
  @ApiResponse({ status: 429, description: 'Too many audit runs — rate limited to 3/minute' })
  async runAudit(
    @Param('projectId') projectId: string,
    @Body() body: RunAuditDto,
  ) {
    const targetUrl = await this.resolveTarget(projectId, body.targetUrl);
    const { jobId } = await this.pipelineQueue.enqueue(
      'technical-audit',
      { targetUrl, projectId, triggeredBy: 'manual' },
      { attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
    );
    return { jobId, projectId, targetUrl, status: 'queued' };
  }

  /**
   * Poll the status of a queued technical audit job.
   */
  @Get('run/jobs/:jobId')
  @ApiOperation({ summary: 'Get the status of a queued technical audit job' })
  @ApiResponse({ status: 200, description: 'Job status — waiting/active/completed/failed, with result or error' })
  async getRunJob(@Param('jobId') jobId: string) {
    return this.pipelineQueue.getStatus(jobId);
  }

  /**
   * The audited URL is a property of the project, not something an operator
   * should retype. Resolution order: an explicit body value, then the
   * project's own `domain`.
   *
   * A caller-supplied URL is already validated as http(s) by the DTO; the
   * project's domain is normalised here because it is stored bare
   * ("example.com") and may or may not carry a scheme.
   */
  private async resolveTarget(projectId: string, supplied?: string): Promise<string> {
    if (supplied) return supplied;

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    });
    if (!project?.domain) {
      throw new BadRequestException(
        `Project ${projectId} has no domain set, so there is nothing to audit. ` +
          'Set the project domain, or pass an explicit targetUrl.',
      );
    }

    const raw = project.domain.trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      return new URL(withScheme).toString();
    } catch {
      throw new BadRequestException(`Project domain "${raw}" is not a usable URL.`);
    }
  }

  /**
   * List all audit runs for a project.
   * Returns audit summaries from the database, ordered by most recent first.
   */
  @Get()
  @ApiOperation({ summary: 'List audit runs for a project' })
  @ApiResponse({ status: 200, description: 'Array of audit run summaries' })
  async listAudits(@Param('projectId') projectId: string) {
    const audits = await this.prisma.technicalAudit.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        projectId: true,
        targetUrl: true,
        triggeredBy: true,
        createdAt: true,
        score: true,
        pagesCrawled: true,
        previousAuditId: true,
        narrative: true,
        findings: {
          select: { id: true, type: true, status: true, severity: true },
        },
      },
    });
    return { audits };
  }

  /**
   * Get a specific audit run with all findings, reproduction commands, and page metadata.
   */
  @Get(':auditId')
  @ApiOperation({ summary: 'Get audit detail by ID' })
  @ApiResponse({ status: 200, description: 'Full audit with all findings, metadata, and reproduction commands' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  async getAudit(
    @Param('projectId') projectId: string,
    @Param('auditId') auditId: string,
  ) {
    const audit = await this.prisma.technicalAudit.findFirst({
      where: { id: auditId, projectId },
      include: {
        findings: true,
        pageMetadata: true,
        // Worst pages first: a 150-row inventory is read top-down, and the
        // operator wants the pages that need work, not alphabetical order.
        pages: { orderBy: { score: 'asc' } },
      },
    });
    if (!audit) {
      throw new NotFoundException(`Audit ${auditId} not found for project ${projectId}`);
    }
    return audit;
  }

  /**
   * Previous-vs-current comparison for one run: every metric that moved, plus
   * which pages were added, removed, improved or regressed.
   */
  @Get(':auditId/comparison')
  @ApiOperation({ summary: 'Compare an audit run against the one before it' })
  @ApiResponse({ status: 200, description: 'Deltas and page-level churn' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  async getComparison(
    @Param('projectId') projectId: string,
    @Param('auditId') auditId: string,
  ) {
    const comparison = await this.auditService.getComparison(projectId, auditId);
    if (!comparison) {
      throw new NotFoundException(`Audit ${auditId} not found for project ${projectId}`);
    }
    return comparison;
  }

  /**
   * Score history, oldest first — the series behind the trend line.
   */
  @Get('trend/history')
  @ApiOperation({ summary: 'Audit score history for a project' })
  @ApiResponse({ status: 200, description: 'Chronological score series' })
  async getTrend(
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
    return { history: await this.auditService.getTrend(projectId, n) };
  }

  /**
   * Set or update the scheduling cadence for recurring audits.
   * Creates a BullMQ repeatable job and stores config in the database.
   */
  @Put('schedule')
  @ApiOperation({ summary: 'Set scheduling cadence (weekly/monthly/manual)' })
  @ApiBody({ type: SetScheduleDto })
  @ApiResponse({ status: 200, description: 'Schedule updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid cadence — must be weekly, monthly, or manual-only' })
  async setSchedule(
    @Param('projectId') projectId: string,
    @Body() body: SetScheduleDto,
  ) {
    // The target comes from the project itself. It used to be read from the
    // most recent audit, which made scheduling impossible until someone had
    // already run one by hand — and returned that failure as a 200 with an
    // `error` string, which callers routinely missed.
    const targetUrl =
      body.cadence === 'manual-only' ? '' : await this.resolveTarget(projectId);

    return this.scheduling.setSchedule(projectId, body.cadence, targetUrl);
  }

  /**
   * Get the current schedule config for a project.
   */
  @Get('schedule')
  @ApiOperation({ summary: 'Get current schedule configuration' })
  @ApiResponse({ status: 200, description: 'Current schedule config' })
  async getSchedule(@Param('projectId') projectId: string) {
    return this.scheduling.getSchedule(projectId);
  }
}