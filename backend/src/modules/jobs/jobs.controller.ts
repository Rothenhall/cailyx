/**
 * JobsController — G07's HTTP surface for the durable ledger, the onboarding
 * run and cadence rules.
 *
 * Three route groups in one file because they share the ledger service and the
 * `assertProjectAccess` preamble:
 *
 *   /api/projects/:projectId/jobs              — what ran, what it cost, what it produced
 *   /api/projects/:projectId/onboarding        — the Day-1 pipeline as a resumable run
 *   /api/projects/:projectId/cadences/:taskKind — the recurring schedule for one task kind
 *
 * Every handler validates project ownership against the URL's `:projectId`
 * before it touches a row, and every run/rule id is resolved *within* that
 * project — a run id from another project 404s rather than resolving
 * (AGENT-BRIEF rule 1; design_plan G03).
 *
 * @module jobs.controller
 */

import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { JobsService } from './jobs.service';
import { CadenceService } from './cadence.service';
import { OnboardingService } from './onboarding.service';
import { CancelRunDto, CreateRunDto, ListRunsQueryDto, RecordStepDto } from './dto/jobs.dto';
import { PutCadenceDto, RunCadenceNowDto } from './dto/cadence.dto';
import { CreateOnboardingRunDto, ResumeOnboardingRunDto } from './dto/onboarding.dto';

// ── Durable runs ────────────────────────────────────────────────────────

@ApiTags('jobs')
@ApiBearerAuth()
@Controller('projects/:projectId/jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's background runs, newest first",
    description: 'Filterable by task kind and status. Each run carries its steps, its coverage counts and which actions the server will currently accept.',
  })
  @ApiResponse({ status: 200, description: '{ runs: JobRunDto[] }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'Project does not exist' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListRunsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.jobs.listRuns(projectId, {
      taskKind: query.taskKind,
      status: query.status,
      limit: query.limit,
    });
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'One run, with its steps and coverage disclosure' })
  @ApiResponse({ status: 200, description: 'JobRunDto' })
  @ApiResponse({ status: 404, description: 'No such run on this project' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.jobs.getRun(projectId, jobId);
  }

  /**
   * Create a run, or return the one that already exists under this
   * idempotency key.
   *
   * 201 means a new run was created; 200 means the key was already used and
   * the existing run is returned untouched. The status code carries that
   * distinction so a client cannot mistake "already started" for "started
   * again".
   */
  @Post()
  @ApiOperation({
    summary: 'Create a run (idempotent) or return the existing one',
    description:
      'With an `idempotencyKey` that already exists this returns the existing run and starts nothing. Without a key, a run of the same task kind already in flight on this project is reported as a 409 conflict rather than started twice.',
  })
  @ApiBody({ type: CreateRunDto })
  @ApiResponse({ status: 201, description: 'A new run was created (and queued where a handler exists)' })
  @ApiResponse({ status: 200, description: 'The idempotency key already existed — the existing run is returned, nothing was started' })
  @ApiResponse({ status: 409, description: 'Another run of this kind is in flight on this project' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateRunDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    const result = await this.jobs.createAndEnqueue({
      projectId,
      taskKind: dto.taskKind,
      idempotencyKey: dto.idempotencyKey,
      trigger: (dto.trigger as 'manual' | 'cadence' | 'pipeline' | 'retry' | undefined) ?? 'manual',
      triggeredBy: user.userId,
      input: dto.input,
      steps: dto.steps?.map((name, position) => ({ name, position })),
      maxAttempts: dto.maxAttempts,
      reversible: dto.reversible,
      maxCostUsd: dto.maxCostUsd,
      stage: dto.stage,
    });

    if (result.outcome === 'locked') {
      throw new ConflictException(
        `A ${dto.taskKind} run is already in flight on this project (${result.run.id}). ` +
          `Retry or cancel that run instead of starting a second one.`,
      );
    }

    res.status(result.outcome === 'created' ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      run: await this.jobs.getRun(projectId, result.run.id),
      created: result.outcome === 'created',
      requeued: result.requeued,
      /** Why the run could not be handed to a worker, when it could not. */
      notStartedReason: result.requeueBlockedReason,
    };
  }

  @Post(':jobId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a finished run (bounded)',
    description:
      'Steps that already succeeded are kept — a retry re-attempts what produced no result rather than buying the whole run again. Refused while the run is still running, and once `maxAttempts` is reached.',
  })
  @ApiResponse({ status: 200, description: 'RetryResult — attempt, reset steps, preserved steps, whether it was requeued' })
  @ApiResponse({ status: 409, description: 'Still running, or the retry budget is exhausted' })
  async retry(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.jobs.retry(projectId, jobId, user.userId);
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a run, stating what is already spent',
    description:
      'The response states the cost already recorded and whether the work is reversible, and always reports `refunded: false`. Cancelling a run that is mid-flight is cooperative: a handler that checks `assertActive` stops at its next step boundary.',
  })
  @ApiBody({ type: CancelRunDto })
  @ApiResponse({ status: 200, description: 'CancelResult — spent cost, reversibility, and the sentence to display' })
  @ApiResponse({ status: 409, description: 'The run already finished' })
  async cancel(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
    @Body() dto: CancelRunDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.jobs.cancel(projectId, jobId, dto.reason);
  }

  /**
   * Step reporting for a module that drives its own run without the queue.
   * Kept on the jobs surface rather than asking each module to write its own
   * copy of the coverage calculus.
   */
  @Post(':jobId/steps')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a step outcome on a run',
    description: 'Re-derives the run status from its steps: a step that fails does not fail the run, it lowers its coverage.',
  })
  @ApiBody({ type: RecordStepDto })
  @ApiResponse({ status: 200, description: 'The re-derived run' })
  async recordStep(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
    @Body() dto: RecordStepDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    // Resolve inside the project first: recordStep addresses a run by bare id.
    await this.jobs.getRun(projectId, jobId);
    return this.jobs.recordStep(jobId, {
      name: dto.name,
      status: dto.status as 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped',
      attempted: dto.attempted,
      succeeded: dto.succeeded,
      error: dto.error,
      costUsd: dto.costUsd,
    });
  }
}

// ── Onboarding run ──────────────────────────────────────────────────────

@ApiTags('jobs: onboarding')
@ApiBearerAuth()
@Controller('projects/:projectId/onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The project's onboarding run and what resume would do next",
    description:
      'Returns `run: null` (not a 404) when the durable ledger has no onboarding run for this project yet, alongside the pre-G07 `onboardingStatus`/`onboardingStep` fields for comparison.',
  })
  @ApiResponse({ status: 200, description: 'OnboardingRunView' })
  async read(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.onboarding.read(projectId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create the onboarding run (idempotent per project)',
    description:
      'The default idempotency key is `onboarding:<projectId>`, so the Day-1 pipeline starts once per project: a repeated POST returns the existing run (200) instead of starting a second one (201).',
  })
  @ApiBody({ type: CreateOnboardingRunDto })
  @ApiResponse({ status: 201, description: 'The onboarding run was created' })
  @ApiResponse({ status: 200, description: 'The project already had an onboarding run — it is returned untouched' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateOnboardingRunDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    const result = await this.onboarding.create(projectId, dto, user.userId);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Get(':runId')
  @ApiOperation({ summary: 'One onboarding run' })
  @ApiResponse({ status: 404, description: 'No such onboarding run on this project' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.onboarding.getRun(projectId, runId);
  }

  @Post(':runId/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume from the first stage that did not succeed',
    description:
      'Stages that already succeeded are not re-run — resuming re-attempts what produced no result. If no executor for the next stage is registered in this process, `resumed: false` comes back with the reason rather than a stage that pretends to have run.',
  })
  @ApiBody({ type: ResumeOnboardingRunDto })
  @ApiResponse({ status: 200, description: 'ResumeResult — resumed, advancedStage, and the run afterwards' })
  @ApiResponse({ status: 409, description: 'Finished, already running, or out of retry budget' })
  async resume(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('runId') runId: string,
    @Body() dto: ResumeOnboardingRunDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.onboarding.resume(projectId, runId, user.userId, dto);
  }
}

// ── Cadence rules ───────────────────────────────────────────────────────

@ApiTags('jobs: cadences')
@ApiBearerAuth()
@Controller('projects/:projectId/cadences')
export class CadencesController {
  constructor(
    private readonly cadences: CadenceService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every supported task kind with its schedule',
    description: 'Kinds with no rule yet are listed with `configured: false` and the documented defaults — a missing schedule is a state, not a missing row.',
  })
  @ApiResponse({ status: 200, description: '{ cadences: CadenceRuleDto[] }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cadences.listCadences(projectId);
  }

  @Get(':taskKind')
  @ApiOperation({ summary: 'One task kind\'s cadence rule' })
  @ApiResponse({ status: 200, description: 'CadenceRuleDto' })
  @ApiResponse({ status: 400, description: 'Unknown task kind' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('taskKind') taskKind: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cadences.getCadence(projectId, taskKind);
  }

  /**
   * Role-restricted: a schedule is a standing commitment to spend on a
   * cadence, not a one-off action, so it takes the same roles that own
   * delivery commitments.
   */
  @Put(':taskKind')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Create or replace a task kind\'s cadence rule',
    description:
      'Validates the anchors (a weekly rule needs a weekday, a monthly rule a day of month), validates the timezone, and recomputes `nextRunAt` in that timezone. Setting `paused: true` stops the rule ticking without losing its schedule.',
  })
  @ApiBody({ type: PutCadenceDto })
  @ApiResponse({ status: 200, description: 'The saved rule, with its recomputed nextRunAt' })
  @ApiResponse({ status: 400, description: 'Unknown frequency, invalid timezone, or a missing schedule anchor' })
  async put(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('taskKind') taskKind: string,
    @Body() dto: PutCadenceDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cadences.putCadence(projectId, taskKind, dto);
  }

  @Post(':taskKind/run-now')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tick a cadence rule now, out of band',
    description:
      'Same rules as an automatic tick minus the clock. A paused rule is refused (409); unmet prerequisites are refused unless the caller explicitly accepts them with `overridePrerequisites: true`. A manual tick does not move the schedule.',
  })
  @ApiBody({ type: RunCadenceNowDto })
  @ApiResponse({ status: 200, description: 'TickOutcome — started / duplicate / skipped / locked, with the reason' })
  @ApiResponse({ status: 409, description: 'The rule is paused, or its prerequisites are not ready' })
  async runNow(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('taskKind') taskKind: string,
    @Body() dto: RunCadenceNowDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cadences.runNow(projectId, taskKind, dto, user.userId);
  }
}
