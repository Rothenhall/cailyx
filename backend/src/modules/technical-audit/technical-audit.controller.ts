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

import { Controller, Post, Get, Put, Param, Body, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TechnicalAuditService } from './technical-audit.service';
import { RunAuditDto, SetScheduleDto } from './dto/technical-audit.dto';
import { PrismaService } from '../database/prisma.service';
import { SchedulingService } from '../scheduling/scheduling.service';

@ApiTags('Technical Audit')
@Controller('projects/:projectId/technical-audit')
export class TechnicalAuditController {
  constructor(
    private readonly auditService: TechnicalAuditService,
    private readonly prisma: PrismaService,
    private readonly scheduling: SchedulingService,
  ) {}

  /**
   * Trigger a manual technical audit for a project's target URL.
   * Executes all 5 checks: robots.txt, CDN probe, JS render, CWV, schema.
   *
   * Rate-limited to 3 requests per 60s per IP (audit runs are expensive).
   */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Run a technical audit',
    description: 'Executes all 5 checks: robots.txt, CDN probe, JS render, CWV, schema. Returns findings with reproduction commands and page metadata. Persisted to database. Rate-limited to 3/minute.',
  })
  @ApiBody({ type: RunAuditDto })
  @ApiResponse({ status: 200, description: 'Audit completed with findings' })
  @ApiResponse({ status: 400, description: 'Invalid URL — must be a valid http(s) URL' })
  @ApiResponse({ status: 429, description: 'Too many audit runs — rate limited to 3/minute' })
  async runAudit(
    @Param('projectId') projectId: string,
    @Body() body: RunAuditDto,
  ) {
    return this.auditService.runAudit(body.targetUrl, projectId, 'manual');
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
      },
    });
    if (!audit) {
      throw new NotFoundException(`Audit ${auditId} not found for project ${projectId}`);
    }
    return audit;
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
    // Get the target URL from the most recent audit for this project
    const latestAudit = await this.prisma.technicalAudit.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { targetUrl: true },
    });

    const targetUrl = latestAudit?.targetUrl || '';
    if (!targetUrl && body.cadence !== 'manual-only') {
      return {
        cadence: body.cadence,
        nextRunAt: null,
        active: false,
        error: 'No target URL found for this project. Run a manual audit first.',
      };
    }

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