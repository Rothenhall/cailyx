/**
 * Agents Controller — the dashboard Agents Feed.
 *
 *   GET /api/projects/:projectId/agents — one status card per capability
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module agents.controller
 */

import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { AgentsService } from './agents.service';

@ApiTags('Agents')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Agents Feed for a project',
    description:
      'One card per capability (SEO, GEO, Articles, Authority, Journey, Persona, Council, Mentions, ' +
      'SERP, Monitoring) with a live status line derived from what that module has produced.',
  })
  @ApiResponse({ status: 200, description: '{ agents[], summary }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('projectId') projectId: string) {
    return this.service.forProject(projectId);
  }
}
