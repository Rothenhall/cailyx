/**
 * SERP Intelligence Controller — REST API for ranking/AI-Overview tracking (Agent #3).
 *
 * Routes (nested under the owning project):
 *   GET    /api/projects/:projectId/serp-trackers                          — list
 *   POST   /api/projects/:projectId/serp-trackers                          — create
 *   GET    /api/projects/:projectId/serp-trackers/:trackerId              — detail
 *   POST   /api/projects/:projectId/serp-trackers/:trackerId/queries      — add keywords
 *   DELETE /api/projects/:projectId/serp-trackers/:trackerId/queries/:queryId
 *   POST   /api/projects/:projectId/serp-trackers/:trackerId/capture      — run a snapshot
 *   GET    /api/projects/:projectId/serp-trackers/:trackerId/snapshots    — list snapshots
 *   GET    /api/projects/:projectId/serp-trackers/:trackerId/snapshots/:snapshotId
 *   DELETE /api/projects/:projectId/serp-trackers/:trackerId              — delete
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module serp-intelligence.controller
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SerpIntelligenceService } from './serp-intelligence.service';
import { CreateTrackerDto, AddQueriesDto, CaptureDto } from './dto/serp-intelligence.dto';
import type { SerpProviderName } from './serp-intelligence.types';

@ApiTags('SERP Intelligence')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/serp-trackers')
export class SerpIntelligenceController {
  constructor(private readonly service: SerpIntelligenceService) {}

  @Get()
  @ApiOperation({ summary: 'List SERP trackers for a project' })
  @ApiResponse({ status: 200, description: 'Array of trackers with queries' })
  async list(@Param('projectId') projectId: string) {
    return this.service.listTrackers(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Create a SERP tracker',
    description:
      'A named set of tracked keywords + locale. Data source is DataForSEO (licensed API); ' +
      'the `fixture` provider is offline test scaffolding gated by SERP_ALLOW_FIXTURE=1.',
  })
  @ApiBody({ type: CreateTrackerDto })
  @ApiResponse({ status: 201, description: 'Tracker created with its queries' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async create(@Param('projectId') projectId: string, @Body() body: CreateTrackerDto) {
    return this.service.createTracker(projectId, {
      name: body.name,
      keywords: body.keywords,
      locationName: body.locationName,
      languageCode: body.languageCode,
      device: body.device,
      provider: body.provider as SerpProviderName | undefined,
    });
  }

  @Get(':trackerId')
  @ApiOperation({ summary: 'Get a tracker with queries + recent snapshots' })
  @ApiResponse({ status: 200, description: 'Tracker detail' })
  @ApiResponse({ status: 404, description: 'Tracker not found' })
  async getOne(@Param('trackerId') trackerId: string) {
    return this.service.getTracker(trackerId);
  }

  @Post(':trackerId/queries')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add keywords to a tracker' })
  @ApiBody({ type: AddQueriesDto })
  @ApiResponse({ status: 200, description: 'Updated tracker' })
  @ApiResponse({ status: 404, description: 'Tracker not found' })
  @ApiResponse({ status: 409, description: 'Keyword cap would be exceeded' })
  async addQueries(@Param('trackerId') trackerId: string, @Body() body: AddQueriesDto) {
    return this.service.addQueries(trackerId, body.keywords);
  }

  @Delete(':trackerId/queries/:queryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a keyword from a tracker' })
  @ApiResponse({ status: 200, description: '{ removed: queryId }' })
  @ApiResponse({ status: 404, description: 'Tracker or query not found' })
  async removeQuery(@Param('trackerId') trackerId: string, @Param('queryId') queryId: string) {
    return this.service.removeQuery(trackerId, queryId);
  }

  @Post(':trackerId/capture')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Capture a SERP snapshot',
    description:
      'Fetches every tracked query through the provider, analyses subject rank / AI-Overview / ' +
      'competitor presence, and persists results. Stops at SERP_MAX_COST_PER_CAPTURE. The live ' +
      'DataForSEO provider needs SWARM_ALLOW_LIVE=1 + DATAFORSEO_LOGIN/PASSWORD.',
  })
  @ApiBody({ type: CaptureDto, required: false })
  @ApiResponse({ status: 200, description: 'Capture rollup { snapshotId, status, queriesRun, costUsd, note }' })
  @ApiResponse({ status: 404, description: 'Tracker not found' })
  @ApiResponse({ status: 409, description: 'Tracker has no queries' })
  @ApiResponse({ status: 400, description: 'fixture provider without SERP_ALLOW_FIXTURE=1' })
  @ApiResponse({ status: 503, description: 'Live provider blocked (SWARM_ALLOW_LIVE / credentials)' })
  async capture(@Param('trackerId') trackerId: string, @Body() body: CaptureDto) {
    return this.service.capture(trackerId, body?.provider as SerpProviderName | undefined);
  }

  @Get(':trackerId/snapshots')
  @ApiOperation({ summary: 'List snapshots for a tracker' })
  @ApiResponse({ status: 200, description: 'Array of snapshots' })
  async snapshots(@Param('trackerId') trackerId: string) {
    return this.service.listSnapshots(trackerId);
  }

  @Get(':trackerId/snapshots/:snapshotId')
  @ApiOperation({ summary: 'Get a snapshot with per-query results' })
  @ApiResponse({ status: 200, description: 'Snapshot + results' })
  @ApiResponse({ status: 404, description: 'Snapshot not found' })
  async snapshot(@Param('trackerId') trackerId: string, @Param('snapshotId') snapshotId: string) {
    return this.service.getSnapshot(trackerId, snapshotId);
  }

  @Delete(':trackerId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a SERP tracker' })
  @ApiResponse({ status: 200, description: '{ removed: trackerId }' })
  @ApiResponse({ status: 404, description: 'Tracker not found' })
  async remove(@Param('trackerId') trackerId: string) {
    return this.service.deleteTracker(trackerId);
  }
}
