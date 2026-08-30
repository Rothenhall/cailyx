/**
 * Findings Controller — what/why/fix copy API (FR-9.1–9.3).
 *
 * Routes:
 *   POST /api/projects/:projectId/findings/generate  generate findings from open gaps (LLM, claims-filtered)
 *   GET  /api/projects/:projectId/findings           list stored findings (thinRun flagged)
 *   GET  /api/projects/:projectId/findings/:findingId  one finding
 *
 * @module findings.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FindingsService } from './findings.service';
import { GenerateFindingsDto } from './dto/findings.dto';

@ApiTags('Findings')
@Controller('projects/:projectId/findings')
export class FindingsController {
  constructor(private readonly findingsService: FindingsService) {}

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Generate findings from open gaps',
    description: 'Ranks open gaps, generates what/why/fix copy in executive + technical registers via a constrained LLM, filters through claims discipline (FR-9.4). Banned copy is regenerated once, then skipped. Flags thinRun when evidence is below the non-obvious threshold.',
  })
  @ApiResponse({ status: 200, description: 'Findings generated (possibly thinRun)' })
  @ApiResponse({ status: 404, description: 'Project or gap analysis missing' })
  @ApiResponse({ status: 503, description: 'ANTHROPIC_API_KEY not configured' })
  async generate(@Param('projectId') projectId: string, @Body() body: GenerateFindingsDto) {
    return this.findingsService.generate(projectId, { limit: body.limit });
  }

  @Get()
  @ApiOperation({ summary: 'List stored findings', description: 'Newest first; thinRun=true when fewer than three findings exist.' })
  async list(@Param('projectId') projectId: string) {
    return this.findingsService.list(projectId);
  }

  @Get(':findingId')
  @ApiOperation({ summary: 'One finding with both registers' })
  async getOne(@Param('projectId') projectId: string, @Param('findingId') findingId: string) {
    // findMany-based lookup keeps ownership in one where-clause.
    const rows = await this.findingsService.findingRows(projectId);
    const row = rows.find((f) => f.id === findingId);
    if (!row) throw new NotFoundException('Finding not found in this project: ' + findingId);
    return row;
  }
}