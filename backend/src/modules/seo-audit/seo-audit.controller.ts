/**
 * SEO Audit — REST surface.
 *
 *   POST /projects/:projectId/seo-audit/run           run a fresh audit
 *   GET  /projects/:projectId/seo-audit               list runs (summary)
 *   GET  /projects/:projectId/seo-audit/:auditId      one run, full
 *   GET  /projects/:projectId/seo-audit/:auditId/comparison
 *   GET  /projects/:projectId/seo-audit/trend/history
 *   POST /projects/:projectId/seo-audit/submit-sitemaps   the one action it can take
 *                                                          (a Search Console WRITE — needs
 *                                                          the read/write `webmasters` scope)
 *
 * All behind the global JwtAuthGuard. The Search Console connection is the
 * per-operator one, so `userId` comes from the token.
 *
 * @module seo-audit/seo-audit.controller
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { SeoAuditService } from './seo-audit.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';

@ApiTags('SEO Audit')
@ApiBearerAuth()
@Controller('projects/:projectId/seo-audit')
export class SeoAuditController {
  constructor(
    private readonly seo: SeoAuditService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly scope: ScopeValidationService,
  ) {}

  /**
   * Queues the audit on the background pipeline and returns immediately with
   * a jobId. Poll GET run/jobs/:jobId for status/result.
   */
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue an SEO audit from Search Console data' })
  async run(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() body: { windowDays?: number },
  ) {
    const days = Number(body?.windowDays ?? 28);
    if (!Number.isInteger(days) || days < 7 || days > 90) {
      throw new BadRequestException('windowDays must be an integer between 7 and 90');
    }
    const { jobId } = await this.pipelineQueue.enqueue(
      'seo-audit',
      { projectId, userId: user.userId, triggeredBy: 'manual', windowDays: days },
      { attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
    );
    return { jobId, projectId, status: 'queued' };
  }

  /**
   * Poll a queued SEO audit job.
   *
   * Guarded the same way as the technical-audit equivalent: resolved by id,
   * then checked against the URL's `:projectId`. A foreign id returns 404
   * rather than that project's job status (design_plan G03, line 1613).
   */
  @Get('run/jobs/:jobId')
  @ApiOperation({ summary: 'Get the status of a queued SEO audit job' })
  @ApiResponse({ status: 200, description: 'Job status' })
  @ApiResponse({ status: 404, description: 'Job does not exist, or belongs to a different project' })
  async getRunJob(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    const status = await this.pipelineQueue.getStatus(jobId);
    this.scope.assertJobBelongsToProject(status, projectId, 'SEO audit job');
    return status;
  }

  @Get()
  @ApiOperation({ summary: 'List SEO audit runs (summary rows)' })
  list(@Param('projectId') projectId: string) {
    return this.seo.list(projectId);
  }

  @Get('trend/history')
  @ApiOperation({ summary: 'Score / clicks / impressions history, oldest first' })
  trend(@Param('projectId') projectId: string, @Query('limit') limit?: string) {
    return this.seo.trend(projectId, limit ? Math.min(60, Math.max(2, parseInt(limit, 10) || 30)) : 30);
  }

  @Post('submit-sitemaps')
  @ApiOperation({
    summary: 'Re-submit the property\'s sitemap(s) to Google',
    description:
      'Re-submits every sitemap Search Console has registered for the project\'s mapped property, so Google recrawls them. This is a Search Console WRITE: it requires a grant holding the read/write `webmasters` scope. A grant created before that scope was requested holds only `webmasters.readonly` and is answered with 409 plus the reconnect instruction — a read-only grant cannot perform the PUT.',
  })
  @ApiResponse({ status: 201, description: '{ submitted: string[] } — the feedpaths Google accepted. At least one always succeeds when this is returned; a run where every submit failed is an error, not an empty list.' })
  @ApiResponse({ status: 409, description: 'The connected Search Console grant is read-only (reconnect to grant write access), no sitemap is registered for the property, or Google rejected every submission' })
  @ApiResponse({ status: 404, description: 'The project has no Search Console property mapped' })
  submit(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    return this.seo.submitSitemaps(projectId, user.userId);
  }

  @Get('schedule')
  @ApiOperation({ summary: 'Current recurring-SEO-audit schedule' })
  getSchedule(@Param('projectId') projectId: string) {
    return this.seo.getSchedule(projectId);
  }

  @Put('schedule')
  @ApiOperation({ summary: 'Set the recurring SEO audit cadence (daily/weekly/monthly/manual-only)' })
  setSchedule(@Param('projectId') projectId: string, @Body() body: { cadence?: string }) {
    const c = body?.cadence;
    if (c !== 'daily' && c !== 'weekly' && c !== 'monthly' && c !== 'manual-only') {
      throw new BadRequestException('cadence must be daily, weekly, monthly or manual-only');
    }
    return this.seo.setSchedule(projectId, c);
  }

  @Get(':auditId')
  @ApiOperation({ summary: 'One SEO audit run, with queries, pages and findings' })
  async get(@Param('projectId') projectId: string, @Param('auditId') auditId: string) {
    const audit = await this.seo.get(projectId, auditId);
    if (!audit) throw new NotFoundException(`SEO audit ${auditId} not found`);
    return audit;
  }

  @Get(':auditId/comparison')
  @ApiOperation({ summary: 'Run-over-run comparison for one SEO audit' })
  async comparison(@Param('projectId') projectId: string, @Param('auditId') auditId: string) {
    const cmp = await this.seo.comparison(projectId, auditId);
    if (!cmp) throw new NotFoundException(`SEO audit ${auditId} not found`);
    return cmp;
  }
}
