/**
 * Refresh-Cadence Controller — C7, read-only status + an optional manual
 * override for operators/QA. There is deliberately NO endpoint to configure
 * a project's cadence: it is derived automatically from the client's plan
 * tier (`docs/analysis/client-portal.md` §19) via `RefreshCadenceService`
 * and the hourly `RefreshCadenceSchedulerService` poller — an operator has
 * nothing to set here.
 *
 * All routes are project-scoped and auth-guarded (global JwtAuthGuard) with
 * `ScopeValidationService.assertProjectAccess`, matching `monitoring`'s
 * pattern for nested-id project routes.
 *
 * @module refresh-cadence.controller
 */

import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RefreshCadenceService } from './refresh-cadence.service';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';

@ApiTags('Refresh Cadence')
@ApiBearerAuth()
@Controller('projects/:projectId/refresh-cadence')
export class RefreshCadenceController {
  constructor(
    private readonly refresh: RefreshCadenceService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Automatic refresh-cadence status',
    description: 'Plan tier, derived cadence, and next/last run — read-only. Cadence is never operator-configured; it is derived from Client.planTier.',
  })
  @ApiResponse({ status: 200, description: 'Cadence status' })
  async status(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.refresh.getStatus(projectId);
  }

  @Post('run-now')
  @ApiOperation({
    summary: 'Run the scoped refresh immediately (operator override, not part of the automatic cadence)',
    description: 'Runs the same scoped measurement+scoring refresh the scheduler would run on cadence. Useful for QA/ops; does not change the automatic schedule.',
  })
  @ApiResponse({ status: 200, description: 'Refresh result — `ran: false` with a reason when there is nothing to replay yet' })
  async runNow(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.refresh.runScopedRefresh(projectId);
  }
}
