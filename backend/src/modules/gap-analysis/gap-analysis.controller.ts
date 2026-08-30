/**
 * Gap Analysis Controller — REST API.
 *
 * Endpoints: list (filterable), sync (re-classify), patch gap, roadmap, get gap.
 *
 * @module gap-analysis.controller
 */

import { Controller, Get, Post, Patch, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { GapAnalysisService } from './gap-analysis.service';
import { PatchGapDto } from './dto/gap-analysis.dto';

@ApiTags('Gap Analysis')
@Controller('projects/:projectId/gap-analysis')
export class GapAnalysisController {
  constructor(private readonly gapAnalysisService: GapAnalysisService) {}

  @Get()
  @ApiOperation({ summary: 'List gaps for a project', description: 'Filterable by dimension/action/status. Sorted by priorityScore desc (nulls last).' })
  @ApiQuery({ name: 'dimension', required: false, enum: ['visibility', 'narrative', 'topic', 'format', 'web-mentions', 'demand'] })
  @ApiQuery({ name: 'action', required: false, enum: ['fix', 'build', 'influence'] })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'in-progress', 'resolved'] })
  @ApiResponse({ status: 200, description: 'Gaps for project' })
  async listGaps(
    @Param('projectId') projectId: string,
    @Query('dimension') dimension?: string,
    @Query('action') action?: string,
    @Query('status') status?: string,
  ) {
    return this.gapAnalysisService.listGaps(projectId, { dimension, action, status });
  }

  @Get('gaps/:gapId')
  @ApiOperation({ summary: 'Get gap detail' })
  @ApiResponse({ status: 200, description: 'Gap detail' })
  @ApiResponse({ status: 404, description: 'Gap not found in project' })
  async getGap(@Param('projectId') projectId: string, @Param('gapId') gapId: string) {
    return this.gapAnalysisService.getGap(projectId, gapId);
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-run auto-classification', description: 'Ingests latest AuditFindings + SchemaChecks + PlatformRecords + ModelDiffs and upserts gaps. Idempotent.' })
  @ApiResponse({ status: 200, description: 'Sync result with counts' })
  async sync(@Param('projectId') projectId: string) {
    return this.gapAnalysisService.sync(projectId);
  }

  @Patch('gaps/:gapId')
  @ApiOperation({ summary: 'Patch a gap — override dimension/action/status and set priority inputs', description: 'Override auto-assigned dimension/action (flips *_auto_assigned to false). Set demandPotential/credibilityImpact/citationLikelihood 1-5 — priorityScore (=product) recomputed automatically.' })
  @ApiBody({ type: PatchGapDto })
  @ApiResponse({ status: 200, description: 'Gap updated' })
  @ApiResponse({ status: 404, description: 'Gap not found in project' })
  async patchGap(
    @Param('projectId') projectId: string,
    @Param('gapId') gapId: string,
    @Body() body: PatchGapDto,
  ) {
    return this.gapAnalysisService.patchGap(projectId, gapId, body);
  }

  @Get('roadmap')
  @ApiOperation({ summary: 'Roadmap grouped by action, sorted by priorityScore', description: 'Groups gaps by fix|build|influence, each sorted by priorityScore desc (nulls last). Order: fix → build → influence.' })
  @ApiResponse({ status: 200, description: 'Roadmap groups' })
  async roadmap(@Param('projectId') projectId: string) {
    return this.gapAnalysisService.getRoadmap(projectId);
  }
}
