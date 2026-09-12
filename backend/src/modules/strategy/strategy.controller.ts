/**
 * Strategy Controller — REST API for stage 9, "Strategy & Recommendations".
 *
 * @module strategy.controller
 */

import { Controller, Get, Post, Param, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { StrategyService } from './strategy.service';

@ApiTags('Strategy')
@Controller('projects/:projectId/strategy')
export class StrategyController {
  constructor(private readonly strategyService: StrategyService) {}

  @Post('build')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create/rebuild the action plan',
    description:
      'Re-runs gap-analysis sync (stage 8), then groups every actionable gap (issue/gap/opportunity/risk — never a ' +
      'strength) into the nine recommendation categories, ranked quick-wins-first. Idempotent — replaces each category ' +
      'in place and drops any category no longer backed by a gap.',
  })
  @ApiResponse({ status: 200, description: 'The built action plan' })
  async build(@Param('projectId') projectId: string) {
    return this.strategyService.buildActionPlan(projectId);
  }

  @Get()
  @ApiOperation({ summary: 'Get the latest stored action plan', description: 'Returns null-shaped 404 if build has never run for this project.' })
  @ApiResponse({ status: 200, description: 'The action plan' })
  @ApiResponse({ status: 404, description: 'No action plan built yet — POST .../strategy/build first' })
  async get(@Param('projectId') projectId: string) {
    const plan = await this.strategyService.getActionPlan(projectId);
    if (!plan) throw new NotFoundException('No action plan built yet for this project — POST .../strategy/build first.');
    return plan;
  }
}
