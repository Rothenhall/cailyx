/**
 * DigitalPerformanceController — the Cailyx digital-performance score family
 * (platform_improvement_plan.md §5.2–§5.5, phase P14).
 *
 * Routes:
 *   POST /api/projects/:projectId/scores/digital-performance/run           build a run (explicit action only)
 *   GET  /api/projects/:projectId/scores/digital-performance/latest        latest run + last complete run
 *   GET  /api/projects/:projectId/scores/digital-performance/trend         comparison segments
 *   GET  /api/projects/:projectId/scores/digital-performance/applicability recorded applicability decisions
 *   PUT  /api/projects/:projectId/scores/digital-performance/applicability record one decision
 *   GET  /api/projects/:projectId/scores/:runId                            one immutable run with its buckets
 *   GET  /api/score-methodologies                                          methodology versions
 *   POST /api/score-methodologies                                          create a methodology version
 *
 * §5.7's rule holds here: **every read is a read.** The only route that
 * calculates anything is the explicit POST; the GETs read stored rows and never
 * start an audit, refresh a paid provider or create a job. Scoring logic lives
 * entirely in the service layer — this controller only routes.
 *
 * The path prefix is `scores`, deliberately different from the legacy `scoring`
 * routes so the two families can never be confused at the URL level either.
 *
 * @module digital-performance.controller
 */

import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { DigitalPerformanceService } from './digital-performance.service';
import { CreateMethodologyDto, SetApplicabilityDto } from './dto/digital-performance.dto';

@ApiTags('Digital performance score')
@Controller()
export class DigitalPerformanceController {
  constructor(private readonly service: DigitalPerformanceService) {}

  @Post('projects/:projectId/scores/digital-performance/run')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Build a digital-performance score run',
    description:
      'The only route that calculates a score, and it is an explicit action. ' +
      'If any applicable bucket is unmeasured or invalid the run is returned incomplete with NO numeric total, ' +
      'while the valid bucket values are still shown. Runs are immutable.',
  })
  @ApiResponse({ status: 201, description: 'Run created' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async run(@Param('projectId') projectId: string) {
    return this.service.run(projectId);
  }

  @Get('projects/:projectId/scores/digital-performance/latest')
  @ApiOperation({
    summary: 'Latest digital-performance run and the last complete one',
    description:
      'Returns stored runs only — this never builds a score. The last complete run is returned as a separate object so its total can never be blended with newly measured buckets.',
  })
  async latest(@Param('projectId') projectId: string) {
    return this.service.getLatest(projectId);
  }

  @Get('projects/:projectId/scores/digital-performance/trend')
  @ApiOperation({
    summary: 'Comparison segments for the digital-performance score',
    description:
      'Runs grouped by comparison key. A change is reported only between runs with the same methodology version, applicability, market set, source definitions and measurement windows; anything else starts a new segment and is reported as "Scoring changed".',
  })
  async trend(@Param('projectId') projectId: string) {
    return this.service.getTrend(projectId);
  }

  @Get('projects/:projectId/scores/digital-performance/applicability')
  @ApiOperation({
    summary: 'Recorded applicability decisions',
    description:
      'A bucket is applicable unless a decision says otherwise. A bucket that could not be measured stays applicable and reads "not-measured".',
  })
  async getApplicability(@Param('projectId') projectId: string) {
    return this.service.getApplicability(projectId);
  }

  @Put('projects/:projectId/scores/digital-performance/applicability')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Record one applicability decision',
    description:
      'Marking a bucket not applicable REQUIRES a reason — "not relevant" is a recorded decision, not an absence of data. Superseding writes a new row; history is kept.',
  })
  @ApiResponse({ status: 400, description: 'Unknown bucket, or a not-applicable decision without a reason' })
  async setApplicability(
    @Param('projectId') projectId: string,
    @Body() body: SetApplicabilityDto,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.service.setApplicability(projectId, body, user?.email ?? null);
  }

  @Get('projects/:projectId/scores/:runId')
  @ApiOperation({ summary: 'One digital-performance run with its buckets', description: 'Runs are immutable, so a stored run always reads back exactly as it was calculated.' })
  @ApiResponse({ status: 404, description: 'Run not found in this project' })
  async getRun(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.service.getRun(projectId, runId);
  }

  @Get('score-methodologies')
  @ApiOperation({
    summary: 'List score methodology versions',
    description: 'Weights and thresholds live here, versioned — a later approved change is a new version, not a code rewrite.',
  })
  async listMethodologies() {
    return this.service.listMethodologies();
  }

  @Post('score-methodologies')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Create a score methodology version',
    description:
      'Bucket weights must sum to 100 and every bucket key must be one of the six known buckets. Existing versions are never edited, so runs keep the thresholds they were calculated with.',
  })
  @ApiResponse({ status: 400, description: 'Weights do not sum to 100, or an unknown/duplicate bucket key' })
  async createMethodology(@Body() body: CreateMethodologyDto) {
    return this.service.createMethodology(body);
  }
}

/**
 * The **client-facing** read of the same score family (P15). No route here
 * calculates anything: `GET` reads the stored run through
 * `DigitalPerformanceService.getClientSafe`, which is a projection of the exact
 * run the staff read serves.
 *
 * There is deliberately no client route to the methodology `POST`, to
 * applicability decisions, to a raw run by id, or to a trend segment list:
 * those carry the internal handles §4.6 reserves for staff. The client gets the
 * score, its buckets, the disclosures that explain them, and the period each
 * bucket's detail should be opened with.
 *
 * §5.7's rule holds on both controllers: reading never starts an audit, refreshes
 * a paid provider, builds a score or creates a job. Building one is the explicit
 * `POST` on the staff controller above.
 */
@ApiTags('Digital performance score (client)')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId/scores/digital-performance')
export class DigitalPerformancePortalController {
  constructor(
    private readonly service: DigitalPerformanceService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get('latest')
  @ApiOperation({
    summary: "This client's own Cailyx score, in client-safe language",
    description:
      'The stored latest run plus, separately, the last complete one. An incomplete run has no total — the response carries null, never a partial sum.',
  })
  @ApiResponse({ status: 200, description: '{ score: ClientSafeScoreView, explanation: ScoreExplanation }' })
  @ApiResponse({ status: 403, description: 'Project does not belong to this client' })
  async latest(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getClientSafe(projectId);
  }
}
