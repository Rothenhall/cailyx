/**
 * AlertsController — G07's alert triage surface at
 * `/api/projects/:projectId/alerts`.
 *
 * A separate controller from `MonitoringController` because the route prefix
 * is different (`/alerts`, not `/monitoring/*`), and because the existing
 * monitoring controller is the *generation* path: monitors raise alerts, this
 * surface triages them. Splitting them means neither file has to know about
 * the other's transition rules.
 *
 * Every handler validates project ownership against the URL's `:projectId`
 * before resolving an alert id, and `AlertsService` re-scopes every read and
 * write to that same project — an alert id from another project 404s rather
 * than resolving (AGENT-BRIEF rule 1).
 *
 * @module alerts.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { AlertsService } from './alerts.service';
import { AssignAlertDto, ListAlertsQueryDto, ResolveAlertDto } from './dto/monitoring.dto';

@ApiTags('monitoring: alerts')
@ApiBearerAuth()
@Controller('projects/:projectId/alerts')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's alerts with their triage state",
    description:
      'Newest activity first — ordered by when the condition was last seen, so a nightly regression that is still firing stays at the top. A condition that re-fires updates one row (`occurrences`) instead of appending a new alert every night.',
  })
  @ApiResponse({ status: 200, description: '{ alerts: AlertDto[] }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'Project does not exist' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListAlertsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.alerts.list(projectId, {
      kind: query.kind,
      severity: query.severity,
      status: query.status,
      limit: query.limit,
    });
  }

  @Get(':alertId')
  @ApiOperation({ summary: 'One alert, its triage state and the actions still available' })
  @ApiResponse({ status: 200, description: 'AlertDto' })
  @ApiResponse({ status: 404, description: 'No such alert on this project' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('alertId') alertId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.alerts.get(projectId, alertId);
  }

  @Post(':alertId/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge an alert',
    description:
      'Records who saw it and when. Acknowledging an already-acknowledged alert is idempotent for the same operator and a conflict for a different one.',
  })
  @ApiResponse({ status: 200, description: 'The updated alert' })
  @ApiResponse({ status: 409, description: 'Already acknowledged by someone else, or already closed' })
  async acknowledge(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('alertId') alertId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.alerts.acknowledge(projectId, alertId, user.userId);
  }

  @Post(':alertId/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign an alert to an operator',
    description: 'The assignee must be a non-disabled operator account. Re-assignment is allowed and replaces the previous assignee.',
  })
  @ApiBody({ type: AssignAlertDto })
  @ApiResponse({ status: 200, description: 'The updated alert' })
  @ApiResponse({ status: 404, description: 'No such alert on this project, or no such user' })
  @ApiResponse({ status: 409, description: 'The target is not an operator, is disabled, or the alert is closed' })
  async assign(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('alertId') alertId: string,
    @Body() dto: AssignAlertDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.alerts.assign(projectId, alertId, dto.assigneeId, user.userId);
  }

  @Post(':alertId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve an alert, recording what was decided',
    description:
      'Resolution text is required. Resolving is terminal for this episode: a later firing of the same condition opens a new alert rather than re-opening this one, and resolving is a decision about the response — it is never a claim that the underlying measurement was re-verified.',
  })
  @ApiBody({ type: ResolveAlertDto })
  @ApiResponse({ status: 200, description: 'The updated alert' })
  @ApiResponse({ status: 404, description: 'No such alert on this project, or the work item is not on this project' })
  @ApiResponse({ status: 409, description: 'The alert is already closed' })
  async resolve(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('alertId') alertId: string,
    @Body() dto: ResolveAlertDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.alerts.resolve(projectId, alertId, user.userId, {
      resolution: dto.resolution,
      workItemId: dto.workItemId,
    });
  }
}
