/**
 * Attribution Controller — self-reported acquisition source.
 *
 * Public (no auth — written to by a form on the client's own site):
 *   POST /api/public/attribution/:projectId    record one answer
 *
 * Operator (JWT):
 *   GET  /api/projects/:projectId/attribution          list responses
 *   GET  /api/projects/:projectId/attribution/summary  roll-up
 *
 * The public route is throttled hard, takes a closed set of sources, caps every
 * field, and always answers 204 — it never confirms whether a project id is
 * real, so it cannot be used to enumerate projects.
 *
 * @module attribution.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AttributionService } from './attribution.service';
import { CaptureAttributionDto } from './dto/attribution.dto';
import { Public } from '../../common/decorators/auth.decorators';

@ApiTags('Attribution')
@Controller()
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  /**
   * Record one self-reported answer. Unauthenticated by design: this is posted
   * from the client's own site, where no operator session exists.
   */
  @Public()
  @Post('public/attribution/:projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiParam({ name: 'projectId', description: 'Owning project ID' })
  @ApiOperation({
    summary: 'Record a self-reported source (public)',
    description:
      'Written by a "how did you find us" form on the client site. Always returns 204 — an ' +
      'unknown project is silently ignored so the endpoint cannot enumerate projects. Stores no ' +
      'IP address.',
  })
  @ApiBody({ type: CaptureAttributionDto })
  @ApiResponse({ status: 204, description: 'Recorded (or silently ignored)' })
  @ApiResponse({ status: 400, description: 'Unknown source, or a field over its length cap' })
  async capture(@Param('projectId') projectId: string, @Body() body: CaptureAttributionDto): Promise<void> {
    try {
      await this.attribution.capture(projectId, body);
    } catch {
      // deliberately swallowed: a caller must not learn whether a project exists
    }
  }

  @Get('projects/:projectId/attribution')
  @ApiBearerAuth()
  @ApiParam({ name: 'projectId', description: 'Owning project ID' })
  @ApiQuery({ name: 'take', required: false, description: 'Max rows (default 200, cap 500)' })
  @ApiOperation({ summary: 'List self-reported responses', description: 'Newest first.' })
  @ApiResponse({ status: 200, description: 'Array of responses' })
  async list(@Param('projectId') projectId: string, @Query('take') take?: string) {
    return this.attribution.list(projectId, take ? Number(take) : undefined);
  }

  @Get('projects/:projectId/attribution/summary')
  @ApiBearerAuth()
  @ApiParam({ name: 'projectId', description: 'Owning project ID' })
  @ApiOperation({
    summary: 'Self-report roll-up',
    description:
      'Total responses, how many named an AI assistant, the split by source, and the prompts ' +
      'buyers reported using. This is the pipeline number inferred analytics cannot produce.',
  })
  @ApiResponse({ status: 200, description: 'Summary' })
  async summary(@Param('projectId') projectId: string) {
    return this.attribution.summary(projectId);
  }
}
