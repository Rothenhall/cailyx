/**
 * Page Analysis Controller — REST surface for SOP-6 analysis (FR-3.3).
 *
 * @module page-analysis.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PageAnalysisService } from './page-analysis.service';
import { AnalyzePageDto } from './dto/page-analysis.dto';

@ApiTags('Page Analysis')
@Controller('projects/:projectId/page-analysis')
export class PageAnalysisController {
  constructor(private readonly pageAnalysis: PageAnalysisService) {}

  /** Analyze a URL (deterministic; optional LLM notes behind useLlm). */
  @Post('analyze')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Analyze a page for answer-engine extractability (SOP-6)',
    description: 'Deterministic BLUF / question-H2 / standalone / extractable-claims / format pipeline with disclosed weights (30/25/25/20 → 0-100). History is kept per call so restructures stay comparable. useLlm=true adds Claude llmNotes (never scored; 503 without ANTHROPIC_API_KEY).',
  })
  @ApiResponse({ status: 200, description: 'Analysis persisted (status=fetch-failed rows carry no analysis)' })
  @ApiResponse({ status: 400, description: 'Invalid URL' })
  @ApiResponse({ status: 503, description: 'useLlm requested but ANTHROPIC_API_KEY missing' })
  async analyze(@Param('projectId') projectId: string, @Body() body: AnalyzePageDto) {
    return this.pageAnalysis.analyze(projectId, body.url, body.useLlm === true);
  }

  /** Analysis history for the project, newest first. */
  @Get()
  @ApiOperation({ summary: 'List page analyses (newest first)' })
  @ApiResponse({ status: 200, description: 'Analysis rows with persisted subscores' })
  async list(@Param('projectId') projectId: string) {
    return this.pageAnalysis.list(projectId);
  }

  /** One analysis (ownership-checked). */
  @Get(':analysisId')
  @ApiOperation({ summary: 'Get one analysis' })
  @ApiResponse({ status: 200, description: 'Row detail (headings/claims/format JSON decoded as strings)' })
  async getOne(@Param('projectId') projectId: string, @Param('analysisId') analysisId: string) {
    return this.pageAnalysis.getOne(projectId, analysisId);
  }
}