/**
 * Scoring Controller — PRD §8 weighted roll-up API (FR-8.1–8.4).
 *
 * Routes:
 *   POST /api/projects/:projectId/scoring/run    score now against the active rubric
 *   GET  /api/projects/:projectId/scoring        list score runs
 *   GET  /api/projects/:projectId/scoring/latest latest score run (404 until first run)
 *   GET  /api/projects/:projectId/scoring/:runId one score run + evidence
 *   GET  /api/rubrics                            list rubric versions
 *   POST /api/rubrics                            create rubric version
 *
 * @module scoring.controller
 */

import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ScoringService } from './scoring.service';
import { CreateRubricDto } from './dto/scoring.dto';

@ApiTags('Scoring')
@Controller()
export class ScoringController {
  constructor(private readonly scoringService: ScoringService) {}

  @Post('projects/:projectId/scoring/run')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Score a project',
    description: 'Persists a ScoreRun against the active rubric version; every sub-score carries evidence; missing evidence sources mark dimensions partial (never silent zeros).',
  })
  @ApiResponse({ status: 201, description: 'Score run created' })
  @ApiResponse({ status: 404, description: 'Project or active rubric not found' })
  async scoreProject(@Param('projectId') projectId: string) {
    return this.scoringService.scoreProject(projectId);
  }

  @Get('projects/:projectId/scoring')
  @ApiOperation({ summary: 'List score runs for a project', description: 'Newest first, evidence included.' })
  async listScoreRuns(@Param('projectId') projectId: string) {
    return this.scoringService.listScoreRuns(projectId);
  }

  @Get('projects/:projectId/scoring/latest')
  @ApiOperation({ summary: 'Latest score run' })
  @ApiResponse({ status: 404, description: 'Project never scored' })
  async latestScore(@Param('projectId') projectId: string) {
    const latest = await this.scoringService.getLatest(projectId);
    if (!latest) {
      throw new NotFoundException('Project has no score runs — POST /projects/:projectId/scoring/run first');
    }
    return latest;
  }

  @Get('projects/:projectId/scoring/:runId')
  @ApiOperation({ summary: 'One score run with evidence' })
  async getScoreRun(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.scoringService.getScoreRun(projectId, runId);
  }

  @Get('rubrics')
  @ApiOperation({ summary: 'List scoring rubric versions' })
  async listRubrics() {
    return this.scoringService.listRubrics();
  }

  @Post('rubrics')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Create a rubric version',
    description: 'Weights must sum to 100 (PRD §8). First-ever rubric activates automatically; pass activate:true to switch versions.',
  })
  @ApiResponse({ status: 400, description: 'Weights do not sum to 100' })
  async createRubric(@Body() body: CreateRubricDto) {
    return this.scoringService.createRubric(body);
  }
}