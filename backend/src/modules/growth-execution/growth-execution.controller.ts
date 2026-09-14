/**
 * Growth Execution Controller — REST API for stage 11.
 *
 * @module growth-execution.controller
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GrowthExecutionService } from './growth-execution.service';
import { CreateAssetsDto, ListAssetsQueryDto, UpdateAssetStatusDto, GenerateContentDto } from './dto/growth-execution.dto';

@ApiTags('Growth Execution')
@Controller('projects/:projectId/growth-execution')
export class GrowthExecutionController {
  constructor(private readonly growthExecution: GrowthExecutionService) {}

  @Get('topics')
  @ApiOperation({
    summary: 'Suggest blog topics & ad angles from priority keywords',
    description: 'Preview only — never persisted. Empty array when no keyword-research set has run yet for this project.',
  })
  @ApiResponse({ status: 200, description: '{ topics: TopicSuggestionDto[] }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async suggestTopics(@Param('projectId') projectId: string) {
    const topics = await this.growthExecution.suggestTopics(projectId);
    return { topics };
  }

  @Post('assets')
  @ApiOperation({
    summary: 'Create recommended assets (briefs) from open, actionable gaps',
    description:
      'Groups stage-8 gaps by their stage-9 recommendation category, generates one BRIEF (title + short angle, not full copy) per gap x mapped asset type. Deterministic template by default; useLlm:true refines each brief with one constrained LLM call (503 without a configured provider). For real generated content (full articles, ready-to-run ad copy), use POST .../content instead.',
  })
  @ApiBody({ type: CreateAssetsDto })
  @ApiResponse({ status: 201, description: 'The created assets' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'useLlm requested without a configured LLM provider' })
  async createAssets(@Param('projectId') projectId: string, @Body() body: CreateAssetsDto) {
    const assets = await this.growthExecution.createAssets(projectId, body);
    return { assets };
  }

  @Post('content')
  @ApiOperation({
    summary: 'Generate real article/ad-copy content (not a brief) from priority-keyword topics',
    description:
      'For each of the top priority-keyword topics (POST /topics), generates a full SEO-ready article (title, meta description, slug, 800-1200 word body with an FAQ section, and ready-to-embed JSON-LD — BlogPosting + FAQPage) and/or 4 ready-to-run ad copy variants. Always uses the LLM — there is no deterministic long-form writer, so this 503s honestly instead of faking one. Each topic x type is its own LLM call; bounded by `limit` (default 3).',
  })
  @ApiBody({ type: GenerateContentDto })
  @ApiResponse({ status: 201, description: 'The generated assets, each with a populated `content` field' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'No LLM provider configured (OPENROUTER_API_KEY or ANTHROPIC_API_KEY)' })
  async generateContent(@Param('projectId') projectId: string, @Body() body: GenerateContentDto) {
    const assets = await this.growthExecution.generateContent(projectId, body);
    return { assets };
  }

  @Get('assets')
  @ApiOperation({ summary: 'List recommended/in-progress/published growth assets' })
  @ApiResponse({ status: 200, description: '{ assets: GrowthAssetDto[] }' })
  async list(@Param('projectId') projectId: string, @Query() query: ListAssetsQueryDto) {
    return this.growthExecution.list(projectId, query);
  }

  @Patch('assets/:assetId')
  @ApiOperation({ summary: 'Move an asset through its lifecycle (recommended -> in-progress -> published)' })
  @ApiBody({ type: UpdateAssetStatusDto })
  @ApiResponse({ status: 200, description: 'The updated asset' })
  @ApiResponse({ status: 404, description: 'Asset not found for this project' })
  async updateStatus(
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Body() body: UpdateAssetStatusDto,
  ) {
    return this.growthExecution.updateStatus(projectId, assetId, body);
  }
}
