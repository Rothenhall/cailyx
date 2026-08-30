/**
 * Internal-Link Controller — REST API for topical-architecture analysis (Agent #8).
 *
 * Routes (nested under the owning project):
 *   GET    /api/projects/:projectId/link-graph                        — list runs
 *   POST   /api/projects/:projectId/link-graph                        — crawl + analyze
 *   GET    /api/projects/:projectId/link-graph/:graphId               — detail (nodes+edges+recs)
 *   GET    /api/projects/:projectId/link-graph/:graphId/recommendations — recs (?status=)
 *   PATCH  /api/projects/:projectId/link-graph/:graphId/recommendations/:recId — status
 *   DELETE /api/projects/:projectId/link-graph/:graphId               — delete
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module internal-link.controller
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InternalLinkService } from './internal-link.service';
import { AnalyzeLinkGraphDto, UpdateRecommendationDto } from './dto/internal-link.dto';

@ApiTags('Internal Link')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/link-graph')
export class InternalLinkController {
  constructor(private readonly service: InternalLinkService) {}

  @Get()
  @ApiOperation({ summary: 'List link-graph analysis runs for a project' })
  @ApiResponse({ status: 200, description: 'Array of LinkGraph rows' })
  async list(@Param('projectId') projectId: string) {
    return this.service.list(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Crawl the client site and build its internal link graph',
    description:
      'BFS crawl (bounded pages/depth, same host) of the client\'s own site → link graph → orphan / ' +
      'under-linked detection → "add link A → B" recommendations. rootUrl defaults to ' +
      'https://<project.domain>. `useLlm` refines anchor copy (needs ANTHROPIC_API_KEY).',
  })
  @ApiBody({ type: AnalyzeLinkGraphDto })
  @ApiResponse({ status: 201, description: 'Completed LinkGraph with nodes, edges, recommendations' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 400, description: 'fixture:// root without INTERNAL_LINK_ALLOW_FIXTURE=1' })
  @ApiResponse({ status: 503, description: 'useLlm requested without ANTHROPIC_API_KEY' })
  async analyze(@Param('projectId') projectId: string, @Body() body: AnalyzeLinkGraphDto) {
    return this.service.analyze(projectId, {
      rootUrl: body.rootUrl,
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      useLlm: body.useLlm,
    });
  }

  @Get(':graphId')
  @ApiOperation({ summary: 'Get a link graph with nodes, edges, and recommendations' })
  @ApiResponse({ status: 200, description: 'LinkGraph detail' })
  @ApiResponse({ status: 404, description: 'Link graph not found' })
  async getOne(@Param('graphId') graphId: string) {
    return this.service.getGraph(graphId);
  }

  @Get(':graphId/recommendations')
  @ApiOperation({ summary: 'List link recommendations for a graph' })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'applied', 'dismissed'] })
  @ApiResponse({ status: 200, description: 'Array of LinkRecommendation rows' })
  async recommendations(@Param('graphId') graphId: string, @Query('status') status?: string) {
    return this.service.listRecommendations(graphId, status);
  }

  @Patch(':graphId/recommendations/:recId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a recommendation status (open | applied | dismissed)' })
  @ApiBody({ type: UpdateRecommendationDto })
  @ApiResponse({ status: 200, description: 'Updated recommendation' })
  @ApiResponse({ status: 404, description: 'Graph or recommendation not found' })
  async updateRec(
    @Param('graphId') graphId: string,
    @Param('recId') recId: string,
    @Body() body: UpdateRecommendationDto,
  ) {
    return this.service.updateRecommendation(graphId, recId, body.status);
  }

  @Delete(':graphId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a link graph' })
  @ApiResponse({ status: 200, description: '{ removed: graphId }' })
  @ApiResponse({ status: 404, description: 'Link graph not found' })
  async remove(@Param('graphId') graphId: string) {
    return this.service.deleteGraph(graphId);
  }
}
