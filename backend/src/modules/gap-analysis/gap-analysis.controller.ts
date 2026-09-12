/**
 * Gap Analysis Controller — REST API.
 *
 * Endpoints: list (filterable), sync (re-classify), patch gap, roadmap
 * (by action), by-category (SWOT-style), matrix (impact/effort), get gap.
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
  @ApiOperation({ summary: 'List gaps for a project', description: 'Filterable by dimension/action/category/status. Sorted by priorityScore desc (nulls last).' })
  @ApiQuery({ name: 'dimension', required: false, enum: ['visibility', 'narrative', 'topic', 'format', 'web-mentions', 'demand'] })
  @ApiQuery({ name: 'action', required: false, enum: ['fix', 'build', 'influence'] })
  @ApiQuery({ name: 'category', required: false, enum: ['issue', 'gap', 'opportunity', 'strength', 'risk'] })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'in-progress', 'resolved'] })
  @ApiResponse({ status: 200, description: 'Gaps for project' })
  async listGaps(
    @Param('projectId') projectId: string,
    @Query('dimension') dimension?: string,
    @Query('action') action?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    return this.gapAnalysisService.listGaps(projectId, { dimension, action, category, status });
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
  @ApiOperation({
    summary: 'Re-run auto-classification',
    description:
      'Consolidates every audit module\'s latest findings (technical-audit, entity-audit, digital-presence, tech-stack, ' +
      'competitors, serp-intelligence, aeo-audit), classifies each into issue/gap/opportunity/strength/risk, scores impact ' +
      '× effort, and upserts gaps. Idempotent. Read-only — never triggers a new scan, crawl, or paid call.',
  })
  @ApiResponse({ status: 200, description: 'Sync result with counts' })
  async sync(@Param('projectId') projectId: string) {
    return this.gapAnalysisService.sync(projectId);
  }

  @Patch('gaps/:gapId')
  @ApiOperation({
    summary: 'Patch a gap — override dimension/action/category/status and set priority inputs',
    description:
      'Override auto-assigned dimension/action/category (flips the matching *_auto_assigned to false). ' +
      'Set demandPotential/credibilityImpact/citationLikelihood 1-5 for the PR/outreach priorityScore (product, recomputed ' +
      'automatically). Set impactScore/effortScore 1-5 to override the automatic impact/effort scoring — quadrant recomputes.',
  })
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

  @Get('by-category')
  @ApiOperation({
    summary: 'Gaps grouped by category (SWOT-style)',
    description: 'Groups gaps by issue/risk/gap/opportunity/strength, worst-first within issue/risk/gap/opportunity, most-recent-first within strength.',
  })
  @ApiResponse({ status: 200, description: 'Category groups' })
  async byCategory(@Param('projectId') projectId: string) {
    return this.gapAnalysisService.byCategory(projectId);
  }

  @Get('matrix')
  @ApiOperation({
    summary: 'Gaps grouped by impact/effort quadrant',
    description: 'Groups actionable gaps (issue/gap/opportunity/risk) into quick-win/major-project/fill-in/thankless-task. Strengths never appear — nothing to prioritise fixing.',
  })
  @ApiResponse({ status: 200, description: 'Quadrant groups' })
  async matrix(@Param('projectId') projectId: string) {
    return this.gapAnalysisService.matrix(projectId);
  }
}
