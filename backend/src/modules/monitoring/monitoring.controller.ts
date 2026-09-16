/**
 * Monitoring Controller — REST surface for pipeline health (PRD 6.12).
 *
 * Exposes the point-in-time snapshot, the delta between the two latest score
 * runs, a manual alert check, alert listing, and monitoring cadence management
 * (weekly/monthly/manual-only via the shared SchedulingService).
 *
 * All routes are project-scoped and auth-guarded (global JwtAuthGuard).
 *
 * G07 added `assertProjectAccess` to every handler here. These routes were
 * project-scoped in the URL but never checked that the caller held the
 * project — "any authenticated operator" was the effective policy, which is
 * exactly the nested-id gap design_plan G03 closed everywhere else. Alerts,
 * scores and crawler data are client-visible material; they are now read only
 * by an operator assigned to the project (or an admin).
 *
 * Alert *triage* lives at `/api/projects/:projectId/alerts`
 * (`AlertsController`) — this controller raises alerts, that one resolves them.
 *
 * @module monitoring.controller
 */

import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { MonitoringService } from './monitoring.service';
import { ListAlertsQueryDto } from './dto/monitoring.dto';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PrismaService } from '../database/prisma.service';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';

/** Body for setting the monitoring cadence. */
export class SetMonitoringScheduleDto {
  @ApiPropertyOptional({ description: 'Cadence for the monitoring re-check', enum: ['weekly', 'monthly', 'manual-only'] })
  @IsOptional()
  @IsIn(['weekly', 'monthly', 'manual-only'])
  cadence?: 'weekly' | 'monthly' | 'manual-only';
}

@ApiTags('Monitoring')
@ApiBearerAuth()
@Controller('projects/:projectId/monitoring')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly scheduling: SchedulingService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeValidationService,
  ) {}

  /** Point-in-time health snapshot (score, mention/citation rates, crawler hits). */
  @Get('snapshot')
  @ApiOperation({ summary: 'Monitoring snapshot', description: 'Latest score run, latest completed measurement run (mention/citation rates), and crawler-hit count, in one read.' })
  @ApiResponse({ status: 200, description: 'Snapshot' })
  @ApiResponse({ status: 404, description: 'Nothing to monitor yet — run scoring or measurement first' })
  async snapshot(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.monitoring.snapshot(projectId);
  }

  /** Delta between the two latest score runs + measurement trend. */
  @Get('delta')
  @ApiOperation({
    summary: 'Score-run delta',
    description:
      'before/after/change across the two latest stored score runs, plus the observation-count trend across the two latest completed measurement runs. This is a TWO-POINT comparison of results other modules already produced, not a series and not a time range — there is no `from`/`to`, no per-period breakdown, and no collection here: a delta can only exist once two runs have been stored, and nothing on this route triggers a new one (G19/D19). For a full trend, read the module that owns the series (technical-audit/trend, seo-audit/trend, aeo-audit verdicts).',
  })
  @ApiResponse({ status: 200, description: 'Delta. `score` is null until two score runs exist; `measurement` is null until two completed measurement runs exist. `score.change` is null until a previous run exists to subtract; it is a point difference, not a rate.' })
  async delta(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.monitoring.getDelta(projectId);
  }

  /** Manual alert check — compares the two latest runs and raises alerts. */
  @Post('check')
  @ApiOperation({ summary: 'Run an alert check now', description: 'Compares the two latest score runs and measurement runs against thresholds (score −10pts, mention rate −15pts) and persists Alert rows for regressions. A regression already open for the same condition updates that alert rather than adding a second one.' })
  @ApiResponse({ status: 200, description: 'The regressions found by this check (possibly empty) — not necessarily new alert rows' })
  async check(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.monitoring.checkDeltas(projectId);
  }

  /**
   * List alerts, newest first, with kind/severity filters.
   *
   * Returns the raw `Alert` rows (this is the pre-G07 shape). Triage state and
   * the de-duplicated view are on `GET /api/projects/:projectId/alerts`.
   */
  @Get('alerts')
  @ApiOperation({ summary: 'List alerts', description: 'Newest-first, filterable by kind and severity. Raw Alert rows — triage state and occurrence counts are on /alerts.' })
  @ApiResponse({ status: 200, description: 'Alert rows' })
  async listAlerts(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListAlertsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    const alerts = await this.monitoring.listAlerts(projectId);
    let filtered = alerts;
    if (query.kind) filtered = filtered.filter((a) => a.kind === query.kind);
    if (query.severity) filtered = filtered.filter((a) => a.severity === query.severity);
    return filtered.slice(0, query.limit ?? 50);
  }

  /**
   * Set the monitoring cadence (FR-12.1). Registers a repeatable BullMQ job
   * under the `monitoring` task name; the handler re-runs checkDeltas on cadence.
   */
  @Put('schedule')
  @ApiOperation({ summary: 'Set monitoring cadence (weekly/monthly/manual-only)', description: 'Registers a repeatable scheduled job whose handler re-runs the alert check. Note: shares the per-project ScheduleConfig row with the technical-audit cadence.' })
  @ApiBody({ type: SetMonitoringScheduleDto })
  @ApiResponse({ status: 200, description: 'Schedule config' })
  async setSchedule(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() body: SetMonitoringScheduleDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return this.scheduling.setSchedule(projectId, body.cadence ?? 'weekly', 'https://' + project.domain, 'monitoring');
  }

  /** Get the current schedule config (shared per project). */
  @Get('schedule')
  @ApiOperation({ summary: 'Get current schedule config' })
  @ApiResponse({ status: 200, description: 'Schedule config' })
  async getSchedule(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.scheduling.getSchedule(projectId);
  }

  /** Remove the monitoring schedule (back to manual-only). */
  @Delete('schedule')
  @ApiOperation({ summary: 'Remove the monitoring schedule', description: 'Deletes the repeatable job and flips the config back to manual-only.' })
  @ApiResponse({ status: 200, description: 'Removed' })
  async removeSchedule(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    await this.scheduling.removeSchedule(projectId, 'monitoring');
    return { removed: true };
  }
}
