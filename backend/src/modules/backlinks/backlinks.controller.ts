/**
 * Backlinks Controller — REST API endpoints.
 *
 * @module backlinks.controller
 */

import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BacklinksService } from './backlinks.service';
import { RefreshBacklinksDto } from './dto/backlinks.dto';

@ApiTags('Backlinks')
@Controller('projects/:projectId/backlinks')
export class BacklinksController {
  constructor(private readonly backlinks: BacklinksService) {}

  @Post('refresh')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Pull a fresh backlinks summary + top-backlink sample',
    description:
      'Two DataForSEO calls (~$0.03-0.06 total): backlinks/summary/live (profile) and backlinks/backlinks/live (evidence sample). Requires SWARM_ALLOW_LIVE=1 and DATAFORSEO_LOGIN/PASSWORD — 503 naming exactly what is missing otherwise.',
  })
  @ApiBody({ type: RefreshBacklinksDto })
  @ApiResponse({ status: 201, description: 'The created summary, including a partial/failed run — check `status`' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'SWARM_ALLOW_LIVE, DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD not configured' })
  async refresh(@Param('projectId') projectId: string, @Body() body: RefreshBacklinksDto) {
    return this.backlinks.refresh(projectId, body);
  }

  @Get()
  @ApiOperation({ summary: 'Backlinks summary history for a project, newest first' })
  @ApiResponse({ status: 200, description: '{ summaries: BacklinksSummaryDto[] }' })
  async list(@Param('projectId') projectId: string) {
    return this.backlinks.list(projectId);
  }

  @Get('latest')
  @ApiOperation({ summary: 'Most recent backlinks summary, or null when none has been pulled yet' })
  @ApiResponse({ status: 200, description: 'BacklinksSummaryDto | null' })
  async latest(@Param('projectId') projectId: string) {
    return this.backlinks.latest(projectId);
  }
}
