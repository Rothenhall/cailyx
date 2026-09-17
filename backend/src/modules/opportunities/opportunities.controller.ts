/**
 * Opportunities Controller — REST API for P07 (§12.5-§12.7).
 *
 * @module opportunities.controller
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OpportunitiesService } from './opportunities.service';
import { KeywordResearchService } from '../keyword-research/keyword-research.service';
import {
  AnalyzeOpportunitiesDto,
  ConvertOpportunityDto,
  DismissOpportunityDto,
  ListOpportunitiesQueryDto,
  ReopenOpportunityDto,
  ResearchTermDto,
} from './dto/opportunities.dto';

@ApiTags('Opportunities')
@Controller('projects/:projectId/opportunities')
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly keywordResearch: KeywordResearchService,
  ) {}

  @Post('analyze')
  @ApiOperation({
    summary: 'Run the observed-corpus keyword-gap analysis and upsert canonical Opportunity rows',
    description:
      'Computes gaps only within tracked SERP queries + keyword research already captured for this project (§12.6) — never claims a rival\'s full ranking universe, never triggers a new SERP/AEO/keyword-research run. Re-running always UPDATES the same identity-matched row rather than duplicating it, and never reopens a dismissed row.',
  })
  @ApiBody({ type: AnalyzeOpportunitiesDto })
  @ApiResponse({ status: 201, description: 'AnalyzeOpportunitiesResult' })
  async analyze(@Param('projectId') projectId: string, @Body() body: AnalyzeOpportunitiesDto) {
    return this.opportunities.analyze(projectId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List canonical opportunities — server-side filter + pagination' })
  @ApiResponse({ status: 200, description: '{ total, page, pageSize, opportunities }' })
  async list(@Param('projectId') projectId: string, @Query() query: ListOpportunitiesQueryDto) {
    return this.opportunities.list(projectId, query);
  }

  @Get(':opportunityId')
  @ApiOperation({ summary: 'One opportunity by id' })
  async get(@Param('projectId') projectId: string, @Param('opportunityId') opportunityId: string) {
    return this.opportunities.get(projectId, opportunityId);
  }

  @Patch(':opportunityId/dismiss')
  @ApiOperation({ summary: 'Dismiss an opportunity with a reason — analysis re-runs will never silently reopen it' })
  @ApiBody({ type: DismissOpportunityDto })
  async dismiss(
    @Param('projectId') projectId: string,
    @Param('opportunityId') opportunityId: string,
    @Body() body: DismissOpportunityDto,
  ) {
    return this.opportunities.dismiss(projectId, opportunityId, body);
  }

  @Patch(':opportunityId/reopen')
  @ApiOperation({ summary: 'Reopen a dismissed opportunity — requires its own new reason' })
  @ApiBody({ type: ReopenOpportunityDto })
  async reopen(
    @Param('projectId') projectId: string,
    @Param('opportunityId') opportunityId: string,
    @Body() body: ReopenOpportunityDto,
  ) {
    return this.opportunities.reopen(projectId, opportunityId, body);
  }

  @Post(':opportunityId/convert')
  @ApiOperation({
    summary: 'Create content from an opportunity — idempotent (§12.7 design + basic wiring)',
    description:
      'Reuses growth-execution\'s existing GrowthAsset creation with an idempotencyKey + sourceOpportunityId. A retried call with the same key, or a second call against an opportunity that already has a linked draft, returns the EXISTING asset ("Open existing draft") rather than creating a duplicate. The source opportunity is marked in-progress/linked, never deleted. Full brief-family/stable-identity rework is P08\'s job — this is the minimal real conversion action only.',
  })
  @ApiBody({ type: ConvertOpportunityDto })
  async convert(
    @Param('projectId') projectId: string,
    @Param('opportunityId') opportunityId: string,
    @Body() body: ConvertOpportunityDto,
  ) {
    return this.opportunities.convertToContent(projectId, opportunityId, body);
  }

  @Post('research-term')
  @ApiOperation({
    summary: 'Manual keyword lookup — "Research a search term" (§12.6 R29 / §12.7)',
    description: 'Reuses keyword-research\'s existing DataForSEO volume lookup and its cost gates (SWARM_ALLOW_LIVE, DATAFORSEO_LOGIN/PASSWORD) unchanged — no separate implementation.',
  })
  @ApiBody({ type: ResearchTermDto })
  async researchTerm(@Param('projectId') projectId: string, @Body() body: ResearchTermDto) {
    return this.keywordResearch.research(projectId, {
      keywords: [body.keyword],
      locationName: body.locationName,
      languageCode: body.languageCode,
      includeRelated: false,
    });
  }
}
