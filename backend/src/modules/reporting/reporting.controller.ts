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

import { Controller, Get, Post, Put, Param, Query, Body, Headers, HttpCode, HttpStatus, NotFoundException, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/auth.decorators';
import { AuthService } from '../auth/auth.service';
import { ReportingService } from './reporting.service';
import { GenerateReportDto, SetVisibilityDto } from './dto/reporting.dto';

@ApiTags('Reporting')
@Controller('projects/:projectId/reports')
export class ReportingController {
  constructor(
    private readonly reportingService: ReportingService,
    private readonly auth: AuthService,
  ) {}

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
  @ApiResponse({ status: 404, description: 'Report not found' })
  async getBySlug(@Param('projectId') projectId: string, @Param('slug') slug: string) {
    // Authenticated + operator-only (RolesGuard default-denies client-type JWTs on
    // non-@ClientPortal routes) — there is no separate unauthenticated public report
    // viewer, so this must see private reports too or an operator can never view
    // their own project's (private-by-default) reports.
    return this.reportingService.getBySlug(slug, true);
  }

  /**
   * Render the branded HTML report (FR-10.1, FR-10.3).
   * ?view=detailed for the detailed register; default is the executive one-pager.
   * noindex meta is applied by default (FR-10.5).
   *
   * @Public() — this is the actual "public/private per visibility" link the
   * module docstring describes: a report marked `visibility: "public"` opens
   * for anyone with the URL, no login required. A logged-in operator can
   * still preview their own private (default) reports by sending a bearer
   * token — verified here manually (best-effort, never throws) since the
   * route itself skips the global auth guard.
   */
  @Public()
  @Get(':slug/render')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Render branded HTML report' })
  @ApiResponse({ status: 200, description: 'HTML report page — public reports need no auth; private reports need an operator bearer token' })
  @ApiResponse({ status: 404, description: 'Report not found, or private and no valid operator token was sent' })
  async renderHtml(
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Query('view') view?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const isOperator = await this.auth.isValidBearer(authorization);
    // Pre-existing bug found while verifying the stage-12 growth-plan
    // section: this handler ignored ?view entirely and always rendered
    // executive, despite its own docstring above promising detailed.
    return this.reportingService.renderHtml(slug, view === 'detailed' ? 'detailed' : 'executive', isOperator);
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