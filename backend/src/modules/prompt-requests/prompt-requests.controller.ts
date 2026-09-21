/**
 * Prompt Requests Controller — the admin-facing queue (client-portal.md
 * §13). Client-facing create/list routes live on `ClientPortalController`
 * (`client-portal.module.ts` imports `PromptRequestsModule`), not here —
 * this controller is operator-only.
 *
 * Routes (nested under the owning project):
 *   GET   /api/projects/:projectId/prompt-requests            — list the queue
 *   POST  /api/projects/:projectId/prompt-requests/:id/decide — admin decision
 *
 * @module prompt-requests.controller
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { PromptRequestsService } from './prompt-requests.service';
import { DecidePromptRequestDto } from './dto/prompt-requests.dto';
import type { PromptRequestStatus } from './prompt-requests.types';

@ApiTags('Prompt Requests')
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/prompt-requests')
export class PromptRequestsController {
  constructor(private readonly requests: PromptRequestsService) {}

  @Get()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'List the prompt add/delete request queue for a project',
    description: 'Each row carries its §20 quota snapshot (activePromptCount, planPromptLimit, overQuota) taken at request time.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'declined'] })
  @ApiResponse({ status: 200, description: 'Array of prompt requests' })
  async list(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.requests.list(projectId, status as PromptRequestStatus | undefined);
  }

  @Post(':id/decide')
  @Roles('admin')
  @ApiOperation({
    summary: 'Record an admin decision on a prompt request',
    description:
      'This endpoint never mutates the QuerySet itself — approve the actual add/remove through the query-set module\'s own edit/versioning endpoints first (fork the active set, add/remove the prompt, activate), then call this to close the queue item.',
  })
  @ApiBody({ type: DecidePromptRequestDto })
  @ApiResponse({ status: 200, description: 'Decided prompt request' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 409, description: 'Request already decided' })
  async decide(
    @Param('id') id: string,
    @Body() body: DecidePromptRequestDto,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.requests.decide(id, {
      decidedByUserId: user.userId,
      decision: body.decision,
      decisionNote: body.decisionNote,
      resultQuerySetItemId: body.resultQuerySetItemId,
    });
  }
}
