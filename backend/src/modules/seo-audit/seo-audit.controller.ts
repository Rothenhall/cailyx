/**
 * SEO Audit — REST surface.
 *
 *   POST /projects/:projectId/seo-audit/run           run a fresh audit
 *   GET  /projects/:projectId/seo-audit               list runs (summary)
 *   GET  /projects/:projectId/seo-audit/:auditId      one run, full
 *   GET  /projects/:projectId/seo-audit/:auditId/comparison
 *   GET  /projects/:projectId/seo-audit/trend/history
 *   POST /projects/:projectId/seo-audit/submit-sitemaps   the one action it can take
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { SeoAuditService } from './seo-audit.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';

@ApiTags('SEO Audit')
@ApiBearerAuth()
@Controller('projects/:projectId/seo-audit')
export class SeoAuditController {
  constructor(
    private readonly seo: SeoAuditService,
    private readonly pipelineQueue: PipelineQueueService,
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

  @Get('run/jobs/:jobId')
  @ApiOperation({ summary: 'Get the status of a queued SEO audit job' })
  async getRunJob(@Param('jobId') jobId: string) {
    return this.pipelineQueue.getStatus(jobId);
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
  @ApiOperation({ summary: 'Re-submit the property\'s sitemap(s) to Google' })
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
