/**
 * Measurement Controller — REST API for AI-surface observation runs (SOP-2).
 *
 * Routes:
 *   POST /api/projects/:projectId/measurement/runs            create run (n>=5)
 *   POST /api/projects/:projectId/measurement/runs/:runId/execute  execute (cost-capped)
 *   GET  /api/projects/:projectId/measurement/runs            list runs
 *   GET  /api/projects/:projectId/measurement/runs/:runId     run + observations
 *   GET  /api/projects/:projectId/measurement/summary         rates + share of voice
 *
 * @module measurement.controller
 */

import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MeasurementService } from './measurement.service';
import { CreateRunDto } from './dto/measurement.dto';
import type { Surface } from './measurement.types';

@ApiTags('Measurement')
@ApiBearerAuth()
@Controller('projects/:projectId/measurement')
export class MeasurementController {
  constructor(private readonly measurementService: MeasurementService) {}

  /**
   * Create a run against an active query set. n>=5 enforced at DTO and service level.
   */
  @Post('runs')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Create a measurement run',
    description: 'Targets one ACTIVE query set on one surface + geo. runCount defaults to 5 (n>=5 enforced — below is a 400, no exceptions).',
  })
  @ApiBody({ type: CreateRunDto })
  @ApiResponse({ status: 201, description: 'Run created in pending state' })
  @ApiResponse({ status: 400, description: 'runCount < 5 or unknown surface' })
  @ApiResponse({ status: 404, description: 'Project or query set not found' })
  @ApiResponse({ status: 409, description: 'Query set is not active' })
  async createRun(@Param('projectId') projectId: string, @Body() body: CreateRunDto) {
    return this.measurementService.createRun(projectId, {
      querySetId: body.querySetId,
      surface: body.surface as Surface,
      geo: body.geo,
      runCount: body.runCount,
    });
  }

  /**
   * Execute a run: every prompt × runCount observations, cost-capped.
   */
  @Post('runs/:runId/execute')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Execute a measurement run',
    description: 'Sequential observations via the surface adapter; records mentioned/cited/competitors per observation; enforces the per-run cost cap.',
  })
  @ApiResponse({ status: 200, description: 'Run finished (completed, or failed with error reason recorded)' })
  @ApiResponse({ status: 404, description: 'Run not found in this project' })
  @ApiResponse({ status: 409, description: 'Run is already executing' })
  async executeRun(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    await this.measurementService.getRun(projectId, runId); // ownership check
    return this.measurementService.executeRun(runId);
  }

  /**
   * List runs.
   */
  @Get('runs')
  @ApiOperation({ summary: 'List measurement runs', description: 'Newest first; optional ?surface= filter.' })
  @ApiResponse({ status: 200, description: 'Runs array' })
  async listRuns(@Param('projectId') projectId: string, @Query('surface') surface?: string) {
    return this.measurementService.listRuns(projectId, surface);
  }

  /**
   * One run with all observations.
   */
  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get a run with observations' })
  @ApiResponse({ status: 200, description: 'Run with observations (mentions, citations, raw answers)' })
  @ApiResponse({ status: 404, description: 'Run not found in this project' })
  async getRun(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.measurementService.getRun(projectId, runId);
  }

  /**
   * Aggregate rates + share of voice.
   */
  @Get('summary')
  @ApiOperation({
    summary: 'Measurement summary',
    description: 'Mention/citation rates overall, by surface, and by funnel stage; share of voice vs named competitors. Rates, never positions.',
  })
  @ApiQuery({ name: 'runId', required: false })
  @ApiResponse({ status: 200, description: 'Summary block' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async summary(@Param('projectId') projectId: string, @Query('runId') runId?: string) {
    return this.measurementService.summary(projectId, runId);
  }
}