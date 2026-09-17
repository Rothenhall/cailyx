/**
 * Content Generation Controller — P09 (§13.6, §13.7, §13.9). Staff-only: a
 * client can request/review content but never sees model/provider/cost
 * fields, and this whole surface stays behind CONTENT_EDITOR_ROLES.
 *
 * @module content-generation.controller
 */

import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ContentGenerationService } from './content-generation.service';
import { CreateGenerationJobDto, ListGenerationJobsQueryDto } from './dto/content-generation.dto';

const CONTENT_EDITOR_ROLES = ['admin', 'delivery-lead', 'content'] as const;

@ApiTags('Content Generation')
@Controller('projects/:projectId/content-generation')
@Roles(...CONTENT_EDITOR_ROLES)
export class ContentGenerationController {
  constructor(private readonly generation: ContentGenerationService) {}

  @Post('jobs')
  @ApiOperation({ summary: 'Enqueue a durable generation job — returns an accepted job identity promptly (§13.7)' })
  @ApiResponse({ status: 201, description: '{ job, created }. created:false on an idempotency-key resubmit.' })
  @ApiResponse({ status: 422, description: 'Asset type has no implemented writer (§13.9) — refused honestly, never simulated.' })
  @ApiBody({ type: CreateGenerationJobDto })
  async enqueue(@Param('projectId') projectId: string, @Body() body: CreateGenerationJobDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser | undefined;
    return this.generation.enqueue(projectId, body, user?.userId);
  }

  @Get('jobs')
  @ApiOperation({
    summary: 'Recent generation jobs for this project — the reload-proof inline status (§13.7)',
    description: 'Job state is server-side, so a browser reload, a different device or an expired session finds the same jobs instead of losing them. Newest first.',
  })
  @ApiResponse({ status: 200, description: '{ jobs: GenerationJobDto[] }' })
  async listJobs(@Param('projectId') projectId: string, @Query() query: ListGenerationJobsQueryDto) {
    return this.generation.listJobs(projectId, query);
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Poll job status — survives browser reload/session expiry, the job itself is server-side state' })
  async getJob(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.generation.getJob(projectId, jobId);
  }

  @Post('jobs/:jobId/retry')
  @ApiOperation({ summary: 'Retry a FAILED job (bounded by maxAttempts); a SUCCEEDED job returns its existing output, never a duplicate' })
  async retry(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.generation.retry(projectId, jobId);
  }

  @Post('jobs/:jobId/cancel')
  @ApiOperation({ summary: 'Cancel a queued/running job' })
  async cancel(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.generation.cancel(projectId, jobId);
  }
}
