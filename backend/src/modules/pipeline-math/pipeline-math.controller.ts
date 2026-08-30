/**
 * Pipeline Math Controller — REST surface for the GTM qualification chain
 * (PLAN Phase 4). Live arithmetic for discovery calls, persisted per project.
 *
 * @module pipeline-math.controller
 */

import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PipelineMathService } from './pipeline-math.service';
import { SavePipelineMathDto } from './dto/pipeline-math.dto';

@ApiTags('Pipeline Math')
@Controller('projects/:projectId/pipeline-math')
export class PipelineMathController {
  constructor(private readonly pipelineMath: PipelineMathService) {}

  @Put()
  @ApiOperation({
    summary: 'Compute (create or replace) the project pipeline model',
    description:
      'Revenue target ÷ ACV ÷ win rate ÷ meeting-to-SQL ÷ lead-to-meeting ÷ visitor-to-lead = visitors needed. With a marketSize, the verdict is fiction when visitors exceed 1.5× the market.',
  })
  @ApiResponse({ status: 200, description: 'Model saved with all intermediate stages + verdict' })
  save(@Param('projectId') projectId: string, @Body() body: SavePipelineMathDto) {
    return this.pipelineMath.save(projectId, body);
  }

  @Get()
  @ApiOperation({ summary: 'Get the current model (404 with a hint when never computed)' })
  get(@Param('projectId') projectId: string) {
    return this.pipelineMath.get(projectId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Recompute with updated inputs',
    description: 'Partial body (e.g. {"winRate":0.3}) — unspecified inputs keep their stored value. Useful for What-If during a live call.',
  })
  recalc(@Param('projectId') projectId: string, @Body() body: Partial<SavePipelineMathDto>) {
    return this.pipelineMath.recalc(projectId, body);
  }
}