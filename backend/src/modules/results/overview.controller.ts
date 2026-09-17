/**
 * OverviewController — the staff HTTP surface of the project Overview
 * (platform_improvement_plan.md §5.1, §5.7, phase P15).
 *
 *   Operator  GET /api/projects/:projectId/overview
 *
 * The client equivalent is `ResultsPortalController.overviewView`
 * (`/api/portal/projects/:projectId/overview`); both call the same
 * `OverviewService`, so "what the client sees" and "what the team sees" cannot
 * drift apart. This read adds the §5.1 "Team attention" panel and nothing else
 * that changes the client-equivalent panels.
 *
 * §5.7: this is a read. It starts no audit, refreshes no paid provider, builds
 * no score and creates no job — the score panel reads stored runs, and building
 * one stays the explicit `POST /scores/digital-performance/run`.
 *
 * Access is `assertProjectAccess`, the same check every other project read
 * uses: an operator sees the projects they are assigned to, an admin sees all.
 *
 * @module results/overview.controller
 */

import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { OverviewService } from './overview.service';

@ApiTags('overview')
@ApiBearerAuth()
@Roles('admin', 'delivery-lead')
@Controller('projects/:projectId/overview')
export class OverviewController {
  constructor(
    private readonly overview: OverviewService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The project overview, composed for staff',
    description:
      'One prominent score with its applicable bucket cards, up to three action cards with the true total, up to ' +
      'five upcoming content items, a compact plan/report footer, and a staff-only "Team attention" panel below ' +
      'the client-equivalent information. Every panel is its own section envelope: a failed source read degrades ' +
      'that panel and leaves the others intact.',
  })
  @ApiResponse({ status: 200, description: 'StaffOverviewView' })
  @ApiResponse({ status: 404, description: 'Project not found, or not visible to this operator' })
  async read(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.overview.getStaffOverview(user, projectId);
  }
}
