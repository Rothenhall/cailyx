/**
 * DeliveryPlanController — G06.
 *
 * Three route groups in one file, because they share the service and the
 * `Actor` construction:
 *
 *   Operator  /api/clients/:clientId/engagements     — the commercial container
 *   Operator  /api/projects/:projectId/cycles        — time-boxed commitments
 *   Operator  /api/projects/:projectId/work-items    — the deliverables
 *   Operator  /api/team/*, /api/capacity             — capacity and milestones
 *   Client    /api/portal/projects/:projectId/*      — the client's own view
 *
 * The client routes are a separate controller class so `@ClientPortal()` marks
 * the whole surface at once — RolesGuard is default-deny for client users, and
 * a client route that quietly inherited the operator guard would be a hole.
 *
 * Every handler passes the entity's owning `projectId`/`clientId` down to the
 * service rather than resolving a bare id, so a foreign id in the URL fails the
 * ownership check instead of being fetched (design_plan G03, line 1613).
 *
 * @module delivery-plan.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { DeliveryPlanService, type Actor } from './delivery-plan.service';
import { CreateCapacityAllocationDto, CreateMilestoneDto, UpdateCapacityAllocationDto, UpdateMilestoneDto } from './dto/capacity.dto';
import { CommitCycleDto, CreateCycleDto, SetCycleStatusDto, UpdateCycleDto } from './dto/cycle.dto';
import {
  AgreeCommitmentDto,
  CancelCommitmentDto,
  CommitmentScopeChangeDto,
  CompleteCommitmentDto,
  CreateCommitmentDto,
  RecordOutcomeMetricDto,
  SetCommitmentStatusDto,
  UpdateCommitmentDto,
} from './dto/commitment.dto';
import { CreateEngagementDto, SetEngagementStatusDto, UpdateEngagementDto } from './dto/engagement.dto';
import {
  AddAcceptanceCheckDto,
  BlockWorkItemDto,
  CreateWorkItemDto,
  PortalEvidenceDto,
  SetAcceptanceCheckDto,
  SubmitWorkItemDto,
  UpdateWorkItemDto,
  VerifyWorkItemDto,
} from './dto/work-item.dto';

/** Maps the JWT payload onto the service's actor shape. */
function actorOf(user: AuthedRequestUser): Actor {
  return { userId: user.userId, role: user.role, type: user.type };
}

// ── Engagements ─────────────────────────────────────────────────────────

@ApiTags('delivery-plan: engagements')
@ApiBearerAuth()
@Controller('clients/:clientId/engagements')
export class EngagementsController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({ summary: "A client's engagements" })
  @ApiResponse({ status: 200, description: '{ engagements: EngagementDto[] }' })
  async list(@Param('clientId') clientId: string) {
    return this.service.listEngagements(clientId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One engagement' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different client' })
  async get(@Param('clientId') clientId: string, @Param('id') id: string) {
    return this.service.getEngagement(clientId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Create an engagement for a client' })
  @ApiBody({ type: CreateEngagementDto })
  @ApiResponse({ status: 201, description: 'The created engagement' })
  async create(@Param('clientId') clientId: string, @Body() dto: CreateEngagementDto) {
    return this.service.createEngagement(clientId, dto);
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Edit an engagement' })
  @ApiResponse({ status: 200, description: 'The updated engagement' })
  async update(
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEngagementDto,
  ) {
    return this.service.updateEngagement(clientId, id, dto);
  }

  @Patch(':id/status')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Move an engagement through its lifecycle',
    description:
      'Pausing records pausedAt so cadence ticks and future committed work stop; it never deletes in-flight work.',
  })
  @ApiResponse({ status: 200, description: 'The updated engagement' })
  @ApiResponse({ status: 409, description: 'Transition not permitted from the current status' })
  async setStatus(
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() dto: SetEngagementStatusDto,
  ) {
    return this.service.setEngagementStatus(clientId, id, dto);
  }
}

// ── Cycles ──────────────────────────────────────────────────────────────

@ApiTags('delivery-plan: cycles')
@ApiBearerAuth()
@Controller('projects/:projectId/cycles')
export class CyclesController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({ summary: "A project's cycles" })
  @ApiResponse({ status: 200, description: '{ cycles: CycleDto[] }' })
  async list(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.service.listCycles(projectId, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One cycle' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.getCycle(projectId, id);
  }

  @Get(':id/detail')
  @ApiOperation({ summary: 'A cycle with its work items and progress' })
  @ApiResponse({ status: 200, description: 'Cycle detail' })
  async detail(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.getCycleDetail(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Create a cycle' })
  @ApiBody({ type: CreateCycleDto })
  @ApiResponse({ status: 201, description: 'The created cycle' })
  async create(@Param('projectId') projectId: string, @Body() dto: CreateCycleDto) {
    return this.service.createCycle(projectId, dto);
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Edit a cycle' })
  @ApiResponse({ status: 200, description: 'The updated cycle' })
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCycleDto,
  ) {
    return this.service.updateCycle(projectId, id, dto);
  }

  @Patch(':id/status')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Move a cycle through its lifecycle' })
  @ApiResponse({ status: 200, description: 'The updated cycle' })
  @ApiResponse({ status: 409, description: 'Transition not permitted from the current status' })
  async setStatus(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SetCycleStatusDto,
  ) {
    return this.service.setCycleStatus(projectId, id, dto);
  }

  @Post(':id/commit')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Commit a cycle — freezes the scope denominator',
    description:
      'Snapshots the committed work-item count so "delivered 8 of 10 committed" stays true afterwards. Every later addition or removal is appended to scopeChanges with a reason rather than silently changing the denominator.',
  })
  @ApiBody({ type: CommitCycleDto })
  @ApiResponse({ status: 200, description: 'The committed cycle' })
  @ApiResponse({ status: 409, description: 'Already committed, or has no work items to commit' })
  async commit(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CommitCycleDto,
  ) {
    return this.service.commitCycle(projectId, id, user.userId, dto);
  }
}

// ── Commitments (P11 — 30-day plan) ───────────────────────────────────────

@ApiTags('delivery-plan: commitments')
@ApiBearerAuth()
@Controller('projects/:projectId/commitments')
export class CommitmentsController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({ summary: "A project's plan commitments" })
  async list(@Param('projectId') projectId: string, @Query('cycleId') cycleId?: string, @Query('status') status?: string) {
    return { commitments: await this.service.listCommitments(projectId, { cycleId, status }) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One commitment with derived progress' })
  async get(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.getCommitment(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Create a plan commitment under a cycle' })
  @ApiBody({ type: CreateCommitmentDto })
  async create(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser, @Body() dto: CreateCommitmentDto) {
    return this.service.createCommitment(projectId, dto, user.userId);
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Edit a commitment (not yet completed/closed/cancelled/superseded)' })
  async update(@Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: UpdateCommitmentDto) {
    return this.service.updateCommitment(projectId, id, dto);
  }

  @Patch(':id/status')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Forward-biased status transition (never "agreed" or "completed" — use the dedicated actions)' })
  async setStatus(@Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: SetCommitmentStatusDto) {
    return this.service.setCommitmentStatus(projectId, id, dto);
  }

  @Post(':id/agree')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record client agreement',
    description: 'An operator writing the plan is not client agreement — this is the one path to "agreed", requiring an explicit confirm.',
  })
  @ApiBody({ type: AgreeCommitmentDto })
  async agree(@Param('projectId') projectId: string, @Param('id') id: string, @CurrentUser() user: AuthedRequestUser, @Body() dto: AgreeCommitmentDto) {
    return this.service.agreeCommitment(projectId, id, actorOf(user), dto);
  }

  @Post(':id/scope-change')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a scope change: previous/new target+date, reason, whether reconfirmation is required' })
  @ApiBody({ type: CommitmentScopeChangeDto })
  async scopeChange(@Param('projectId') projectId: string, @Param('id') id: string, @CurrentUser() user: AuthedRequestUser, @Body() dto: CommitmentScopeChangeDto) {
    return this.service.recordCommitmentScopeChange(projectId, id, actorOf(user), dto);
  }

  @Post(':id/outcome-metric')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record an observed value for an outcome-style commitment' })
  @ApiBody({ type: RecordOutcomeMetricDto })
  async recordOutcome(@Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: RecordOutcomeMetricDto) {
    return this.service.recordOutcomeMetric(projectId, id, dto);
  }

  @Post(':id/complete')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a commitment completed',
    description: 'Countable commitments require verified >= target (or an explicit force+forceReason). Outcome commitments require their own metric observation, never just closed tasks.',
  })
  @ApiBody({ type: CompleteCommitmentDto })
  async complete(@Param('projectId') projectId: string, @Param('id') id: string, @CurrentUser() user: AuthedRequestUser, @Body() dto: CompleteCommitmentDto) {
    return this.service.completeCommitment(projectId, id, actorOf(user), dto);
  }

  @Post(':id/cancel')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a commitment' })
  @ApiBody({ type: CancelCommitmentDto })
  async cancel(@Param('projectId') projectId: string, @Param('id') id: string, @Body() dto: CancelCommitmentDto) {
    return this.service.cancelCommitment(projectId, id, dto);
  }
}

// ── Needs-your-action queue (P11 — §5.6) ───────────────────────────────────

@ApiTags('delivery-plan: actions')
@ApiBearerAuth()
@Controller('projects/:projectId/actions')
export class ActionsController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({ summary: 'Full staff-scoped needs-your-action queue for this project' })
  async list(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.getStaffActions(projectId, actorOf(user));
  }
}

// ── Work items ──────────────────────────────────────────────────────────

@ApiTags('delivery-plan: work items')
@ApiBearerAuth()
@Controller('projects/:projectId/work-items')
export class WorkItemsController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({ summary: "A project's work items, filterable by status/cycle/assignee" })
  @ApiResponse({ status: 200, description: '{ workItems: WorkItemDto[] }' })
  async list(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('cycleId') cycleId?: string,
    @Query('assigneeId') assigneeId?: string,
  ) {
    return this.service.listWorkItems(projectId, { status, cycleId, assigneeId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One work item with its checks, evidence and history' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.getWorkItem(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Create a work item',
    description: 'dependsOn is validated for cycles on write — a dependency loop is rejected with 409.',
  })
  @ApiBody({ type: CreateWorkItemDto })
  @ApiResponse({ status: 201, description: 'The created work item' })
  @ApiResponse({ status: 409, description: 'The dependency graph would contain a cycle' })
  async create(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateWorkItemDto,
  ) {
    return this.service.createWorkItem(projectId, dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a work item' })
  @ApiResponse({ status: 200, description: 'The updated work item' })
  @ApiResponse({ status: 403, description: 'Caller is neither assignee, reviewer nor admin' })
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: UpdateWorkItemDto,
  ) {
    return this.service.updateWorkItem(projectId, id, dto, actorOf(user));
  }

  @Delete(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Delete a work item' })
  @ApiResponse({ status: 200, description: '{ id, deleted: true }' })
  async remove(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.deleteWorkItem(projectId, id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit completed work for review' })
  @ApiBody({ type: SubmitWorkItemDto })
  @ApiResponse({ status: 200, description: 'The updated work item' })
  @ApiResponse({ status: 403, description: 'Caller is neither assignee, reviewer nor admin' })
  async submit(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: SubmitWorkItemDto,
  ) {
    return this.service.submitWorkItem(projectId, id, actorOf(user), dto);
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record verification evidence for submitted work',
    description:
      'A rejection reopens the work item rather than closing it — an unverified deliverable never counts as done.',
  })
  @ApiBody({ type: VerifyWorkItemDto })
  @ApiResponse({ status: 200, description: 'The updated work item' })
  @ApiResponse({ status: 403, description: 'Caller is neither reviewer nor admin' })
  async verify(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: VerifyWorkItemDto,
  ) {
    return this.service.verifyWorkItem(projectId, id, actorOf(user), dto);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Block a work item',
    description: 'Records both the reason and who it is waiting on, so a client-caused blocker is distinguishable from an internal one.',
  })
  @ApiBody({ type: BlockWorkItemDto })
  @ApiResponse({ status: 200, description: 'The updated work item' })
  async block(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: BlockWorkItemDto,
  ) {
    return this.service.blockWorkItem(projectId, id, actorOf(user), dto);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear a block' })
  @ApiResponse({ status: 200, description: 'The updated work item' })
  async unblock(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.service.unblockWorkItem(projectId, id, actorOf(user));
  }

  @Post(':id/checks')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Add an acceptance check to a work item' })
  @ApiBody({ type: AddAcceptanceCheckDto })
  @ApiResponse({ status: 201, description: 'The created check' })
  async addCheck(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: AddAcceptanceCheckDto,
  ) {
    return this.service.addAcceptanceCheck(projectId, id, dto);
  }

  @Patch(':id/checks/:checkId')
  @ApiOperation({ summary: 'Record the outcome of an acceptance check' })
  @ApiResponse({ status: 200, description: 'The updated check' })
  async setCheck(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('checkId') checkId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: SetAcceptanceCheckDto,
  ) {
    return this.service.setAcceptanceCheck(projectId, id, checkId, actorOf(user), dto);
  }
}

// ── Milestones ──────────────────────────────────────────────────────────

@ApiTags('delivery-plan: milestones')
@ApiBearerAuth()
@Controller('projects/:projectId/milestones')
export class MilestonesController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({ summary: "A project's milestones" })
  @ApiResponse({ status: 200, description: '{ milestones: MilestoneDto[] }' })
  async list(@Param('projectId') projectId: string) {
    return this.service.listMilestones(projectId, false);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Create a milestone' })
  @ApiBody({ type: CreateMilestoneDto })
  @ApiResponse({ status: 201, description: 'The created milestone' })
  async create(@Param('projectId') projectId: string, @Body() dto: CreateMilestoneDto) {
    return this.service.createMilestone(projectId, dto);
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Edit a milestone' })
  @ApiResponse({ status: 200, description: 'The updated milestone' })
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMilestoneDto,
  ) {
    return this.service.updateMilestone(projectId, id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Delete a milestone' })
  @ApiResponse({ status: 200, description: '{ id, deleted: true }' })
  async remove(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.deleteMilestone(projectId, id);
  }
}

// ── Capacity ────────────────────────────────────────────────────────────

@ApiTags('delivery-plan: capacity')
@ApiBearerAuth()
@Controller('team/capacity')
export class CapacityController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get()
  @ApiOperation({
    summary: 'Team capacity across a date range',
    description: 'Available versus allocated hours per person, so an overloaded handoff is visible before it is promised.',
  })
  @ApiResponse({ status: 200, description: '{ allocations: CapacityAllocationDto[] }' })
  async list(
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.listTeamCapacity({ userId, from, to });
  }

  @Get('projects/:projectId')
  @ApiOperation({ summary: "A project's capacity allocations" })
  @ApiResponse({ status: 200, description: '{ allocations: CapacityAllocationDto[] }' })
  async listForProject(
    @Param('projectId') projectId: string,
    @Query('cycleId') cycleId?: string,
  ) {
    return this.service.listProjectCapacity(projectId, cycleId);
  }

  @Post('projects/:projectId')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Allocate capacity to a person for a project' })
  @ApiBody({ type: CreateCapacityAllocationDto })
  @ApiResponse({ status: 201, description: 'The created allocation' })
  async createForProject(
    @Param('projectId') projectId: string,
    @Body() dto: CreateCapacityAllocationDto,
  ) {
    return this.service.createCapacityAllocation(projectId, dto);
  }

  @Post('org')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Allocate capacity not tied to a project (leave, holiday, overhead)' })
  @ApiBody({ type: CreateCapacityAllocationDto })
  @ApiResponse({ status: 201, description: 'The created allocation' })
  async createOrgWide(@Body() dto: CreateCapacityAllocationDto) {
    return this.service.createCapacityAllocation(null, dto);
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Edit a capacity allocation' })
  @ApiResponse({ status: 200, description: 'The updated allocation' })
  async update(@Param('id') id: string, @Body() dto: UpdateCapacityAllocationDto) {
    return this.service.updateCapacityAllocation(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Delete a capacity allocation' })
  @ApiResponse({ status: 200, description: '{ id, deleted: true }' })
  async remove(@Param('id') id: string) {
    return this.service.deleteCapacityAllocation(id);
  }
}

// ── Client portal ───────────────────────────────────────────────────────

/**
 * The client's own view of the plan.
 *
 * `@ClientPortal()` marks the whole class, and `clientId` comes from the JWT —
 * never from a request field, so a client cannot ask for another client's plan
 * by editing the URL. Internal notes are excluded by the service, not filtered
 * here.
 */
@ApiTags('delivery-plan: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId')
export class DeliveryPlanPortalController {
  constructor(private readonly service: DeliveryPlanService) {}

  @Get('plan')
  @ApiOperation({ summary: "This client's published plan for one of their projects" })
  @ApiResponse({ status: 200, description: 'Published roadmap, commitments and milestones' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async plan(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.getPortalPlan(this.requireClientId(user), projectId);
  }

  @Get('work')
  @ApiOperation({
    summary: 'Work items shared with this client',
    description: 'Only rows flagged clientVisible. Internal notes are never included.',
  })
  @ApiResponse({ status: 200, description: '{ workItems: PortalWorkItemDto[] }' })
  async work(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.listPortalWorkItems(this.requireClientId(user), projectId);
  }

  @Post('work/:workItemId/evidence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The client submits evidence for a work item they own' })
  @ApiBody({ type: PortalEvidenceDto })
  @ApiResponse({ status: 200, description: 'The updated work item' })
  @ApiResponse({ status: 404, description: 'Work item does not belong to this client' })
  async submitEvidence(
    @Param('projectId') projectId: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: PortalEvidenceDto,
  ) {
    return this.service.submitPortalEvidence(
      this.requireClientId(user),
      projectId,
      workItemId,
      user.userId,
      dto,
    );
  }

  @Get('plan/commitments')
  @ApiOperation({
    summary: "This client's 30-day plan commitments",
    description: 'Served separately from GET .../plan so that response shape never changes.',
  })
  async commitments(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.getPortalCommitments(this.requireClientId(user), projectId);
  }

  @Get('actions')
  @ApiOperation({ summary: 'This client\'s full needs-your-action queue for one project' })
  async actions(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.getPortalActions(this.requireClientId(user), projectId);
  }

  @Get('actions/overview')
  @ApiOperation({ summary: 'Capped needs-your-action summary (default 3 cards) with the true total count' })
  async actionsOverview(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? Number.parseInt(limit, 10) : 3;
    return this.service.getPortalActionsOverview(this.requireClientId(user), projectId, Number.isFinite(parsed) && parsed > 0 ? parsed : 3);
  }

  /**
   * Structurally guaranteed by RolesGuard — only a `type="client"` user with a
   * clientId reaches a `@ClientPortal()` route. Re-checked here rather than
   * trusted blindly two layers away, matching the existing client-portal
   * controller's own defensive check.
   */
  private requireClientId(user: AuthedRequestUser): string {
    if (!user.clientId) {
      throw new Error(
        'Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.',
      );
    }
    return user.clientId;
  }
}
