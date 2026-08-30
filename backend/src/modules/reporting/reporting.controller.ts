/**
 * Reporting Controller — REST API endpoints for diagnostic reports.
 *
 * Endpoints are prefixed /api/projects/:projectId/reports.
 * HTML rendering available at /api/reports/:slug (public/private per visibility).
 *
 * Rate limits: generate is 3/60s (expensive aggregation), others 100/60s global.
 *
 * @module reporting.controller
 */

import { Controller, Get, Post, Put, Param, Body, HttpCode, HttpStatus, NotFoundException, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ReportingService } from './reporting.service';
import { GenerateReportDto, SetVisibilityDto } from './dto/reporting.dto';

@ApiTags('Reporting')
@Controller('projects/:projectId/reports')
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  /**
   * Generate a diagnostic report for a project (PRD FR-10.1).
   * Aggregates the latest technical-audit, entity-audit, and gap-analysis data.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Generate a diagnostic report',
    description: 'Aggregates technical-audit findings, entity-audit schema checks, and gap-analysis roadmap into a scored, branded report. Requires a technical audit to have been run first.',
  })
  @ApiBody({ type: GenerateReportDto })
  @ApiResponse({ status: 201, description: 'Report generated' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 404, description: 'No technical audit found for project' })
  @ApiResponse({ status: 429, description: 'Rate limited to 3/minute' })
  async generate(
    @Param('projectId') projectId: string,
    @Body() body: GenerateReportDto,
  ) {
    return this.reportingService.generateReport(projectId, body.targetUrl, body.title);
  }

  /**
   * List all reports for a project.
   */
  @Get()
  @ApiOperation({ summary: 'List reports for a project' })
  @ApiResponse({ status: 200, description: 'Array of report summaries' })
  async list(@Param('projectId') projectId: string) {
    return this.reportingService.listReports(projectId);
  }

  /**
   * Get a report by slug (JSON).
   */
  @Get(':slug/view')
  @ApiOperation({ summary: 'Get report JSON by slug' })
  @ApiResponse({ status: 200, description: 'Full report data' })
  @ApiResponse({ status: 404, description: 'Report not found or private' })
  async getBySlug(@Param('projectId') projectId: string, @Param('slug') slug: string) {
    return this.reportingService.getBySlug(slug, false);
  }

  /**
   * Render the branded HTML report (FR-10.1, FR-10.3).
   * ?view=detailed for the detailed register; default is the executive one-pager.
   * noindex meta is applied by default (FR-10.5).
   */
  @Get(':slug/render')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Render branded HTML report' })
  @ApiResponse({ status: 200, description: 'HTML report page' })
  @ApiResponse({ status: 404, description: 'Report not found or private' })
  async renderHtml(
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
  ) {
    return this.reportingService.renderHtml(slug, 'executive');
  }

  /**
   * Set report visibility (FR-10.5).
   */
  @Put(':slug/visibility')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set report visibility (private/public)' })
  @ApiBody({ type: SetVisibilityDto })
  @ApiResponse({ status: 200, description: 'Visibility updated' })
  async setVisibility(
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: SetVisibilityDto,
  ) {
    return this.reportingService.setVisibility(projectId, slug, body.visibility);
  }
}