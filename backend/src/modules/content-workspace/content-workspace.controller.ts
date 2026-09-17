/**
 * Content Workspace Controller — REST API for P08's canonical staff content
 * list/detail, capability matrix, and the legacy-family review tool.
 *
 * @module content-workspace.controller
 */

import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ContentWorkspaceService } from './content-workspace.service';
import { ListContentWorkspaceQueryDto, MergeBriefFamiliesDto, SetAssigneeDto } from './dto/content-workspace.dto';

const CONTENT_EDITOR_ROLES = ['admin', 'delivery-lead', 'content'] as const;

@ApiTags('Content Workspace')
@Controller('projects/:projectId/content-workspace')
export class ContentWorkspaceController {
  constructor(private readonly workspace: ContentWorkspaceService) {}

  @Get('capabilities')
  @ApiOperation({ summary: 'Type capability matrix — real generation-implemented flags, not a frontend guess (§13.9)' })
  async capabilities() {
    return this.workspace.capabilities();
  }

  @Get('items')
  @ApiOperation({ summary: 'Canonical content list, server-side filtered/paginated, one row per piece (§13.3)' })
  @ApiResponse({ status: 200, description: '{ items, total, page, pageSize }' })
  async list(@Param('projectId') projectId: string, @Query() query: ListContentWorkspaceQueryDto) {
    return this.workspace.list(projectId, query);
  }

  @Get('items/:assetId')
  @ApiOperation({ summary: 'Content detail: header, preview/editor state, plan, review, schedule, history (§13.5)' })
  @ApiResponse({ status: 404, description: 'Not found, wrong project, or not a workspace-tracked content type' })
  async detail(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.workspace.detail(projectId, assetId);
  }

  @Patch('items/:assetId/assignee')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'Set/clear the staff owner for this content piece' })
  @ApiBody({ type: SetAssigneeDto })
  async setAssignee(@Param('projectId') projectId: string, @Param('assetId') assetId: string, @Body() body: SetAssigneeDto) {
    return this.workspace.setAssignee(projectId, assetId, body.assigneeId ?? null);
  }

  @Post('items/:assetId/revisions/:revisionId/share')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'Explicitly mark a revision client-visible (§13.5/§14.4) — default is private' })
  @ApiResponse({ status: 404, description: 'Revision not found for this asset/project' })
  async shareRevision(@Param('projectId') projectId: string, @Param('assetId') assetId: string, @Param('revisionId') revisionId: string, @Req() req: Request) {
    const user = req.user as AuthedRequestUser | undefined;
    return this.workspace.shareRevision(projectId, assetId, revisionId, user?.userId);
  }

  @Post('items/:assetId/revisions/:revisionId/unshare')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'Withdraw client visibility from a revision' })
  async unshareRevision(@Param('projectId') projectId: string, @Param('assetId') assetId: string, @Param('revisionId') revisionId: string) {
    return this.workspace.unshareRevision(projectId, assetId, revisionId);
  }

  @Post('brief-families/merge')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({
    summary: 'Staff tool: manually reunite two legacy brief families an operator recognizes as one lineage (§13.2)',
    description: 'Never automatic, never based on a title match — every pre-P08 row was migrated to its own isolated family, and only an operator who recognizes the real lineage should merge them.',
  })
  @ApiBody({ type: MergeBriefFamiliesDto })
  async mergeBriefFamilies(@Param('projectId') projectId: string, @Body() body: MergeBriefFamiliesDto) {
    return this.workspace.mergeBriefFamilies(projectId, body.fromFamilyId, body.intoFamilyId);
  }
}
