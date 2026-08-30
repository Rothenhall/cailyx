/**
 * Scorecard Controller — Rung 0 free diagnostic (PRD §13).
 *
 * Operator endpoints are role-guarded like every module. The public take by
 * token is @Public but hard-gated behind SCORECARD_PUBLIC=1 (PRD §17:
 * self-serve launch is a decision, not an accident).
 *
 * @module scorecard.controller
 */

import { Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/auth.decorators';
import { ScorecardService } from './scorecard.service';

@ApiTags('Scorecard')
@Throttle({ default: { ttl: 60000, limit: 30 } })
@Controller('projects/:projectId/scorecard')
export class ScorecardController {
  constructor(private readonly scorecard: ScorecardService) {}

  @Post()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Run the Rung 0 free diagnostic',
    description:
      'Fresh technical audit (low depth) + versioned-rubric scoring → 0-100 score, band, exactly 3 named problems with evidence, nonObvious flag (the SOP guarantee), and a public share token.',
  })
  @ApiResponse({ status: 201, description: 'Scorecard run persisted' })
  run(
    @Param('projectId') projectId: string,
    @Query('depth') depth?: 'free' | 'operator',
  ) {
    return this.scorecard.run(projectId, depth === 'operator' ? 'operator' : 'free');
  }

  @Get()
  @ApiOperation({ summary: 'List scorecard runs (newest first)' })
  list(@Param('projectId') projectId: string) {
    return this.scorecard.list(projectId);
  }

  @Get('public/:publicToken')
  @Public()
  @ApiOperation({
    summary: 'Public scorecard view by shareable token',
    description: 'The lead-gen URL (FR-13 Free tier). Disabled unless SCORECARD_PUBLIC=1 — operator-only until the §17 launch decision flips the flag.',
  })
  async byToken(@Param('publicToken') publicToken: string) {
    return this.scorecard.getByPublicToken(publicToken);
  }

  @Get(':runId')
  @ApiOperation({ summary: 'One scorecard run (ownership-checked)' })
  get(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.scorecard.get(projectId, runId);
  }
}