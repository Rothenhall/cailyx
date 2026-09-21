/**
 * Content Requests Controller — operator-side read of client-submitted
 * requests (client-portal.md §14, §22). Client-facing create/list routes
 * live on `ClientPortalController` (`client-portal.module.ts` imports
 * `ContentRequestsModule`), not here.
 *
 * This is traceability, not a triage inbox: by the time an operator reads
 * this list, the real `GrowthAsset` already exists in `content-workspace`
 * (§22) — this endpoint just lets an operator filter "what did clients ask
 * for" without hunting through the full content list for `source: 'client-request'`.
 *
 * Route: GET /api/projects/:projectId/content-requests
 *
 * @module content-requests.controller
 */

import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { ContentRequestsService } from './content-requests.service';

@ApiTags('Content Requests')
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/content-requests')
export class ContentRequestsController {
  constructor(private readonly requests: ContentRequestsService) {}

  @Get()
  @Roles('admin', 'delivery-lead', 'content')
  @ApiOperation({
    summary: 'List client-submitted content requests for a project',
    description: 'Each row is already a real content-workspace item (growthAssetId) — this is traceability, not a queue to convert (§22).',
  })
  @ApiResponse({ status: 200, description: 'Array of content requests' })
  async list(@Param('projectId') projectId: string) {
    return this.requests.list(projectId);
  }
}
