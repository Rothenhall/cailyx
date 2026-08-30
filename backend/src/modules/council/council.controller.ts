/**
 * Council Controller — REST API for the intervention debate (Agent #10).
 *
 * Routes (nested under the owning project):
 *   GET    /api/projects/:projectId/council             — list sessions
 *   POST   /api/projects/:projectId/council             — run a session
 *   GET    /api/projects/:projectId/council/:sessionId  — detail (contributions + rankings)
 *   DELETE /api/projects/:projectId/council/:sessionId  — delete
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module council.controller
 */

import { Controller, Get, Post, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CouncilService } from './council.service';
import { RunCouncilDto } from './dto/council.dto';
import type { AgentRole } from './council.types';

@ApiTags('Council')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/council')
export class CouncilController {
  constructor(private readonly council: CouncilService) {}

  @Get()
  @ApiOperation({ summary: 'List council sessions for a project' })
  @ApiResponse({ status: 200, description: 'Array of CouncilSession rows' })
  async list(@Param('projectId') projectId: string) {
    return this.council.list(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Run an intervention debate',
    description:
      'Gathers the project\'s existing artefacts (gap-analysis, link graph, journeys, measurement, ' +
      'technical/entity audits), derives candidate interventions, runs the deterministic debate ' +
      'engine (agents × rounds) and a synthesizer, and stores the ranked outcome. `useLlm` swaps in ' +
      'one LLM-driven debate of the same shape (needs ANTHROPIC_API_KEY). Proposes no new measurement.',
  })
  @ApiBody({ type: RunCouncilDto })
  @ApiResponse({ status: 201, description: 'CouncilSession with contributions + rankings' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'useLlm requested without ANTHROPIC_API_KEY' })
  async run(@Param('projectId') projectId: string, @Body() body: RunCouncilDto) {
    return this.council.run(projectId, {
      question: body.question,
      rounds: body.rounds,
      agentRoles: body.agentRoles as AgentRole[] | undefined,
      useLlm: body.useLlm,
    });
  }

  @Get(':sessionId')
  @ApiOperation({ summary: 'Get a council session with contributions and rankings' })
  @ApiResponse({ status: 200, description: 'CouncilSession detail' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getOne(@Param('sessionId') sessionId: string) {
    return this.council.get(sessionId);
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a council session' })
  @ApiResponse({ status: 200, description: '{ removed: sessionId }' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async remove(@Param('sessionId') sessionId: string) {
    return this.council.remove(sessionId);
  }
}
