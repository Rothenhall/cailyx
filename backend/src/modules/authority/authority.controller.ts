/**
 * Authority Controller — REST API for legitimate-mention discovery (Agent #6).
 *
 * Routes (nested under the owning project):
 *   GET    /api/projects/:projectId/authority-scans                              — list
 *   POST   /api/projects/:projectId/authority-scans                              — run a scan
 *   GET    /api/projects/:projectId/authority-scans/:scanId                      — detail (+ candidates)
 *   PATCH  /api/projects/:projectId/authority-scans/:scanId/candidates/:candidateId — set status
 *   POST   /api/projects/:projectId/authority-scans/:scanId/candidates/:candidateId/promote — → MentionTarget
 *   DELETE /api/projects/:projectId/authority-scans/:scanId                      — delete
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module authority.controller
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthorityService } from './authority.service';
import { RunScanDto, UpdateCandidateDto } from './dto/authority.dto';
import type { AuthorityMethod } from './authority.types';

@ApiTags('Authority')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/authority-scans')
export class AuthorityController {
  constructor(private readonly service: AuthorityService) {}

  @Get()
  @ApiOperation({ summary: 'List authority discovery scans for a project' })
  @ApiResponse({ status: 200, description: 'Array of AuthorityScan rows' })
  async list(@Param('projectId') projectId: string) {
    return this.service.list(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 12 } })
  @ApiOperation({
    summary: 'Run an authority discovery scan',
    description:
      'Finds publications / communities / podcasts / directories where the client could earn a ' +
      'mention. method ∈ serp | citations | llm | combined. `serp` uses the gated SERP provider; ' +
      '`citations` reads AI-answer citations from this project\'s journeys + measurement; `llm` needs ' +
      'ANTHROPIC_API_KEY. Nothing is contacted — candidates are promoted into mention-tracking by hand.',
  })
  @ApiBody({ type: RunScanDto, required: false })
  @ApiResponse({ status: 201, description: 'AuthorityScan with ranked candidates' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'llm method/useLlm without ANTHROPIC_API_KEY, or live SERP blocked' })
  async run(@Param('projectId') projectId: string, @Body() body: RunScanDto) {
    return this.service.run(projectId, {
      category: body.category,
      method: body.method as AuthorityMethod | undefined,
      listicleQueries: body.listicleQueries,
      useLlm: body.useLlm,
    });
  }

  @Get(':scanId')
  @ApiOperation({ summary: 'Get a scan with its ranked candidates' })
  @ApiResponse({ status: 200, description: 'AuthorityScan detail' })
  @ApiResponse({ status: 404, description: 'Scan not found' })
  async getOne(@Param('scanId') scanId: string) {
    return this.service.get(scanId);
  }

  @Patch(':scanId/candidates/:candidateId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a candidate status (new | promoted | dismissed)' })
  @ApiBody({ type: UpdateCandidateDto })
  @ApiResponse({ status: 200, description: 'Updated candidate' })
  @ApiResponse({ status: 404, description: 'Scan or candidate not found' })
  async updateCandidate(
    @Param('scanId') scanId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: UpdateCandidateDto,
  ) {
    return this.service.updateCandidate(scanId, candidateId, body.status);
  }

  @Post(':scanId/candidates/:candidateId/promote')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Promote a candidate into the mention-tracking outreach ledger',
    description: 'Creates a MentionTarget (status = new) for a human to pursue. No outreach is sent.',
  })
  @ApiResponse({ status: 201, description: '{ candidate, target }' })
  @ApiResponse({ status: 404, description: 'Scan or candidate not found' })
  @ApiResponse({ status: 409, description: 'Candidate already promoted' })
  async promote(@Param('scanId') scanId: string, @Param('candidateId') candidateId: string) {
    return this.service.promote(scanId, candidateId);
  }

  @Delete(':scanId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an authority scan' })
  @ApiResponse({ status: 200, description: '{ removed: scanId }' })
  @ApiResponse({ status: 404, description: 'Scan not found' })
  async remove(@Param('scanId') scanId: string) {
    return this.service.remove(scanId);
  }
}
