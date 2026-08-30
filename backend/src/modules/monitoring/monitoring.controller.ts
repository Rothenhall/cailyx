/**
 * Monitoring Controller — REST surface for pipeline health (PRD 6.12).
 *
 * Exposes the point-in-time snapshot, the delta between the two latest score
 * runs, a manual alert check, alert listing, and monitoring cadence management
 * (weekly/monthly/manual-only via the shared SchedulingService).
 *
 * All routes are project-scoped and auth-guarded (global JwtAuthGuard).
 *
 * @module monitoring.controller
 */

import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { MonitoringService } from './monitoring.service';
import { ListAlertsQueryDto } from './dto/monitoring.dto';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PrismaService } from '../database/prisma.service';

/** Body for setting the monitoring cadence. */
export class SetMonitoringScheduleDto {
  @ApiPropertyOptional({ description: 'Cadence for the monitoring re-check', enum: ['weekly', 'monthly', 'manual-only'] })
  @IsOptional()
  @IsIn(['weekly', 'monthly', 'manual-only'])
  cadence?: 'weekly' | 'monthly' | 'manual-only';
}

@ApiTags('Monitoring')
@Controller('projects/:projectId/monitoring')
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly scheduling: SchedulingService,
    private readonly prisma: PrismaService,
  ) {}

  /** Point-in-time health snapshot (score, mention/citation rates, crawler hits). */
  @Get('snapshot')
  @ApiOperation({ summary: 'Monitoring snapshot', description: 'Latest score run, latest completed measurement run (mention/citation rates), and crawler-hit count, in one read.' })
  @ApiResponse({ status: 200, description: 'Snapshot' })
  @ApiResponse({ status: 404, description: 'Nothing to monitor yet — run scoring or measurement first' })
  async snapshot(@Param('projectId') projectId: string) {
    return this.monitoring.snapshot(projectId);
  }

  /** Delta between the two latest score runs + measurement trend. */
  @Get('delta')
  @ApiOperation({ summary: 'Score-run delta', description: 'before/after/change across the two latest score runs, plus observation-count trend across the two latest completed measurement runs.' })
  @ApiResponse({ status: 200, description: 'Delta (score or measurement null when fewer than required runs)' })
  async delta(@Param('projectId') projectId: string) {
    return this.monitoring.getDelta(projectId);
  }

  /** Manual alert check — compares the two latest runs and raises alerts. */
  @Post('check')
  @ApiOperation({ summary: 'Run an alert check now', description: 'Compares the two latest score runs and measurement runs against thresholds (score −10pts, mention rate −15pts) and persists Alert rows for regressions.' })
  @ApiResponse({ status: 200, description: 'Array of alerts raised (possibly empty)' })
  async check(@Param('projectId') projectId: string) {
    return this.monitoring.checkDeltas(projectId);
  }

  /** List alerts, newest first, with kind/severity filters. */
  @Get('alerts')
  @ApiOperation({ summary: 'List alerts', description: 'Newest-first, filterable by kind and severity.' })
  @ApiResponse({ status: 200, description: 'Alert rows' })
  async listAlerts(@Param('projectId') projectId: string, @Query() query: ListAlertsQueryDto) {
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
  async setSchedule(@Param('projectId') projectId: string, @Body() body: SetMonitoringScheduleDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return this.scheduling.setSchedule(projectId, body.cadence ?? 'weekly', 'https://' + project.domain, 'monitoring');
  }

  /** Get the current schedule config (shared per project). */
  @Get('schedule')
  @ApiOperation({ summary: 'Get current schedule config' })
  @ApiResponse({ status: 200, description: 'Schedule config' })
  async getSchedule(@Param('projectId') projectId: string) {
    return this.scheduling.getSchedule(projectId);
  }

  /** Remove the monitoring schedule (back to manual-only). */
  @Delete('schedule')
  @ApiOperation({ summary: 'Remove the monitoring schedule', description: 'Deletes the repeatable job and flips the config back to manual-only.' })
  @ApiResponse({ status: 200, description: 'Removed' })
  async removeSchedule(@Param('projectId') projectId: string) {
    await this.scheduling.removeSchedule(projectId, 'monitoring');
    return { removed: true };
  }
}