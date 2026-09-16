/**
 * BudgetsController — G12's HTTP surface: budget policies, cost estimates,
 * the spend ledger and the reservation lifecycle.
 *
 * Three route groups in one file because they share the services and the same
 * ownership preamble:
 *
 *   Operator  /api/projects/:projectId/budget                — the ceilings
 *   Operator  /api/projects/:projectId/budget/reservations   — reserve / approve / release / settle
 *   Operator  /api/projects/:projectId/cost-estimates        — the pre-flight estimate
 *   Operator  /api/projects/:projectId/spend                 — the cost audit ledger
 *
 * Every handler calls `scope.assertProjectAccess` for the URL's `:projectId`
 * before it touches a row, and every nested reservation id is resolved
 * *within* that project — a reservation id from another project 404s rather
 * than resolving (AGENT-BRIEF rule 1; design_plan G03).
 *
 * `PUT budget` and `approve` are role-restricted: writing a ceiling and
 * authorising an overage are commitments, not routine actions. Reserving,
 * releasing and settling are not restricted beyond project access, because
 * refusing to let an operator record what a run actually cost would push the
 * number somewhere unrecorded.
 *
 * @module budgets.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { BudgetsService } from './budgets.service';
import { ReservationsService, type Actor } from './reservations.service';
import { CreateCostEstimateDto, GetBudgetQueryDto, ListSpendQueryDto, PutBudgetPolicyDto } from './dto/budget.dto';
import {
  CreateReservationDto,
  ListReservationsQueryDto,
  RecordSpendEventDto,
  ReleaseReservationDto,
  SettleReservationDto,
} from './dto/spend.dto';

/** Maps the JWT payload onto the reservation service's actor shape. */
function actorOf(user: AuthedRequestUser): Actor {
  return { userId: user.userId, role: user.role, type: user.type };
}

// ── Budget policies and estimates ───────────────────────────────────────

@ApiTags('budgets')
@ApiBearerAuth()
@Controller('projects/:projectId/budget')
export class BudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's budget ceilings, evaluated",
    description:
      'Returns every ceiling that applies — client, project and (when ?taskKind= is given) operation scoped — ' +
      'each with the window it was measured over and its per-unit totals. Dollars and provider credits are reported ' +
      'in separate units and are never summed. A unit no policy caps is listed in `unboundedUnits` rather than ' +
      'reported as within budget.',
  })
  @ApiResponse({ status: 200, description: 'BudgetView — policies, bindingCeilings, unboundedUnits, notes' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'Project does not exist' })
  async read(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: GetBudgetQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.budgets.getBudgetView(projectId, query.taskKind);
  }

  @Put()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Create or replace a budget ceiling',
    description:
      'Writes the project-wide ceiling, or an operation-level one when `taskKind` is supplied. At least one of ' +
      '`limitUsd`, `limitCredits` or `perRunCapUsd` must be set — a policy that caps nothing would be reported as ' +
      'bounded for work that is not. `hard` refuses an overage; `soft` holds it unapproved until an approving role ' +
      'confirms it.',
  })
  @ApiBody({ type: PutBudgetPolicyDto })
  @ApiResponse({ status: 200, description: 'The saved policy, plus the re-evaluated BudgetView' })
  @ApiResponse({ status: 409, description: 'No ceiling was supplied' })
  async put(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: PutBudgetPolicyDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.budgets.putProjectPolicy(projectId, dto, user.userId);
  }
}

// ── Cost estimates ──────────────────────────────────────────────────────

@ApiTags('budgets: cost estimates')
@ApiBearerAuth()
@Controller('projects/:projectId/cost-estimates')
export class CostEstimatesController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly scope: ScopeValidationService,
  ) {}

  /**
   * A pre-flight estimate, not a charge and not a reservation.
   *
   * For `taskKind: 'aeo-audit'` the answer is a **Cloro credit estimate** for
   * the answer-engine sampling — the only estimator this build has — reported
   * with its tariff basis. It is not all-provider USD spend and it is not a
   * team budget ledger; any dollar figure is returned as an explicitly-flagged
   * conversion at `CLORO_CREDIT_USD`, in its own field so it can never be
   * merged into the credit figure.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Estimate what a run would cost, with units',
    description:
      'Estimates are not actuals and reserve nothing. Where no estimator exists for a task kind the answer is an ' +
      'explicit `available: false` with the reason — never a zero. An unknown provider balance is reported as ' +
      '`unknown` with the reason, never as affordable.',
  })
  @ApiBody({ type: CreateCostEstimateDto })
  @ApiResponse({ status: 200, description: 'CostEstimateView — ranges per unit, policies, affordability, balances' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateCostEstimateDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.budgets.estimate(projectId, dto);
  }
}

// ── Spend ledger ────────────────────────────────────────────────────────

@ApiTags('budgets: spend')
@ApiBearerAuth()
@Controller('projects/:projectId/spend')
export class SpendController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's cost audit ledger",
    description:
      'Actuals (SpendEvent) and holds (SpendReservation) reported side by side, per unit, with a per-provider ' +
      'breakdown and the estimate-vs-actual variance for every settled reservation. Lapsed holds are swept on read ' +
      'so a crashed run stops counting against the ceiling. No provider balance is read on this route, and the ' +
      'response says so rather than implying one.',
  })
  @ApiResponse({ status: 200, description: 'SpendView — totals, byProvider, events, reservations, balanceProbe' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListSpendQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.budgets.getSpendView(projectId, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record an actual charge that was not reserved',
    description:
      'For free-tier calls and work predating the ledger. Requires a `reservationId` or a `jobRunId`: without one ' +
      'the row cannot be de-duplicated against a retry, and a duplicate charge in the audit ledger is worse than a ' +
      'missing one. A retried post of the same attributable charge returns the existing event rather than a second one.',
  })
  @ApiBody({ type: RecordSpendEventDto })
  @ApiResponse({ status: 200, description: '{ event, deduplicated, existingEventId, reason }' })
  @ApiResponse({ status: 409, description: 'Neither a reservationId nor a jobRunId was supplied' })
  async record(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: RecordSpendEventDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.budgets.recordSpendEvent(projectId, dto, user.userId);
  }
}

// ── Reservations ────────────────────────────────────────────────────────

@ApiTags('budgets: reservations')
@ApiBearerAuth()
@Controller('projects/:projectId/budget/reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Reservations, newest first — the approval queue with ?awaitingApprovalOnly=true',
    description:
      'Lapsed holds are swept before listing, so a hold nobody is waiting on any more is not counted as pending. ' +
      '`awaitingApprovalCount` is always returned, whatever the filter.',
  })
  @ApiResponse({ status: 200, description: '{ reservations, awaitingApprovalCount, expiredOnThisRead }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListReservationsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reservations.list(projectId, query);
  }

  /**
   * The reserve-before-spend action. The cap check and the hold commit
   * together, so two concurrent requests cannot both pass the same ceiling.
   */
  @Post()
  @ApiOperation({
    summary: 'Reserve spend before a run starts (atomic)',
    description:
      'The ceiling check and the hold are one transaction, serialised on the project row, so concurrent requests ' +
      'cannot both pass the cap and overspend. A hard ceiling is refused (409). A soft ceiling creates the hold ' +
      'unapproved: it still counts against the ceiling and cannot be settled until an approving role confirms it. ' +
      'The per-run cap is checked against the high estimate and is never approvable.',
  })
  @ApiBody({ type: CreateReservationDto })
  @ApiResponse({ status: 201, description: 'The held reservation, its approval state and the ceilings it was checked against' })
  @ApiResponse({ status: 409, description: 'A hard ceiling, the per-run cap, or an unmeasurable ceiling window blocks it' })
  async reserve(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateReservationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reservations.reserve(projectId, dto, actorOf(user));
  }

  @Post(':id/approve')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a soft-ceiling overage',
    description:
      'Only a held reservation with no approver can be approved — the first approval stands and a second is a 409. ' +
      'A hard ceiling never reaches this route: it was refused at reserve time.',
  })
  @ApiResponse({ status: 200, description: 'The approved reservation' })
  @ApiResponse({ status: 409, description: 'Already approved, not held, or the caller lacks an approving role' })
  async approve(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reservations.approve(projectId, id, actorOf(user));
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give a hold back without charging',
    description:
      'For a run that never happened. The hold stops counting against the ceiling immediately. Only a held ' +
      'reservation can be released — releasing a settled one would not undo its charge, so it is a 409.',
  })
  @ApiBody({ type: ReleaseReservationDto, required: false })
  @ApiResponse({ status: 200, description: 'The released reservation' })
  @ApiResponse({ status: 409, description: 'Not held — already settled, released or expired' })
  async release(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: ReleaseReservationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reservations.release(projectId, id, body.reason);
  }

  @Post(':id/settle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record what was actually charged (exactly once)',
    description:
      'Settling writes the spend events that carry the actual, in the same transaction as the status flip. ' +
      'Settling an already-settled reservation is a 409, not a second charge — this is the retry/cache-hit guard. ' +
      'A charge above what was reserved needs acknowledgeOverReservation. A charge reported only in credits writes ' +
      'a credit event and no invented dollar figure.',
  })
  @ApiBody({ type: SettleReservationDto })
  @ApiResponse({ status: 200, description: 'The settled reservation, the events written, and any defaulting disclosed' })
  @ApiResponse({ status: 409, description: 'Already settled/released/expired, unapproved, or an unacknowledged overrun' })
  async settle(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SettleReservationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reservations.settle(projectId, id, dto, actorOf(user));
  }
}
