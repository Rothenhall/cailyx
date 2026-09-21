/**
 * ApprovalsController — G10: version-bound review requests, immutable
 * decisions, and the revision-scoped claim/source check records.
 *
 * Three controller classes, because the surface has three distinct audiences:
 *
 *   Operator  /api/projects/:projectId/approvals  — request, list, decide, cancel
 *   Operator  /api/approvals/check-results        — the claim/source review
 *                                                   records behind a revision
 *   Client    /api/portal/approvals               — the client's own queue and
 *                                                   their decision on it
 *
 * The client surface is a separate class so `@ClientPortal()` marks all of it
 * at once — RolesGuard is default-deny for client users, and a client route
 * that quietly inherited the operator guard would be a hole. On that class
 * `clientId` comes from the JWT only; a client cannot ask for another client's
 * approval queue by editing the URL.
 *
 * Why the operator id routes are nested under `:projectId`: every service
 * method that resolves an `id` (`get`, `decide`, `cancel`) takes the owning
 * `projectId` as its first argument and 404s when the row belongs to a
 * different project (`requireOwned`). A bare `/approvals/:id` route could not
 * make that check, so the owning project stays in the URL (design_plan G03).
 *
 * Decisions are admin/delivery-lead only (design_plan §2.2: content/technical
 * "submit for review", the designated reviewer decides). `decide` supersedes
 * the prior decision rather than rewriting it — no approval path ever erases
 * an earlier one.
 *
 * @module approvals.controller
 */

import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
// C5 (`docs/analysis/client-portal.md` §27) — only a client-admin seat may
// approve/request-changes on content before it publishes; a
// client-collaborator seat keeps view access but not this action. Reuses
// ClientAccessService.resolveMembership exactly as client-access.controller.ts
// already does for its own client-admin-only routes — no new role model.
import { ClientAccessService } from '../client-access/client-access.service';
import { ApprovalsService } from './approvals.service';
import {
  CancelApprovalDto,
  CreateApprovalRequestDto,
  DecideApprovalDto,
  ListApprovalsQueryDto,
} from './dto/approvals.dto';

// ── Operator: a project's approval requests ─────────────────────────────

@ApiTags('approvals')
@ApiBearerAuth()
@Controller('projects/:projectId/approvals')
export class ProjectApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get()
  @ApiOperation({
    summary: "A project's approval requests, newest first",
    description: 'Filterable by status, artifact type and artifact id — e.g. every request ever raised against one report.',
  })
  @ApiResponse({ status: 200, description: '{ requests: ApprovalRequestDto[] }' })
  async list(@Param('projectId') projectId: string, @Query() query: ListApprovalsQueryDto) {
    return this.service.list(projectId, {
      status: query.status,
      artifactType: query.artifactType,
      artifactId: query.artifactId,
    });
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Raise an approval request against one exact artifact revision',
    description:
      'The request binds to artifactRevision; a later revision of the same artifact invalidates it rather than carrying consent forward. When reviewerType is "client" (the default), clientId defaults to the project\'s own client and is rejected if it names a different one — a client-facing approval can never be bound to a client that does not own the project.',
  })
  @ApiBody({ type: CreateApprovalRequestDto })
  @ApiResponse({ status: 201, description: 'The created approval request, status "pending"' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 403, description: 'clientId names a client that does not own this project' })
  @ApiResponse({ status: 409, description: 'reviewerType "client" but neither the body nor the project carries a clientId' })
  async create(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateApprovalRequestDto,
  ) {
    return this.service.create(projectId, user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One approval request with its decision history' })
  @ApiResponse({ status: 200, description: 'The request plus every decision, newest first (only the head is current; older ones are superseded)' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.get(projectId, id);
  }

  @Post(':id/decision')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record an operator decision',
    description:
      'revision must equal the request\'s current artifactRevision — it proves the decision was made against the live version rather than a stale screen, and is rejected otherwise. The decision is inserted as a new immutable row; any earlier decision is marked superseded, never rewritten.',
  })
  @ApiBody({ type: DecideApprovalDto })
  @ApiResponse({ status: 200, description: 'The updated request with the new decision first in its history' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  @ApiResponse({ status: 409, description: 'Already resolved/cancelled/invalidated, or the quoted revision is not the one the request is bound to' })
  async decide(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: DecideApprovalDto,
  ) {
    return this.service.decide(projectId, id, user.userId, dto);
  }

  @Post(':id/cancel')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a pending request',
    description: 'Only pending or changes-requested requests can be cancelled. The row is kept with its invalidation reason — withdrawn consent is never deleted.',
  })
  @ApiBody({ type: CancelApprovalDto })
  @ApiResponse({ status: 200, description: 'The cancelled request' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  @ApiResponse({ status: 409, description: 'Already approved, cancelled or invalidated' })
  async cancel(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: CancelApprovalDto,
  ) {
    return this.service.cancel(projectId, id, dto.reason);
  }
}

// ── Operator: claim/source check records ────────────────────────────────

/**
 * The review records tied to one exact artifact revision — the evidence behind
 * a decision, not the decision itself.
 *
 * This route is **not** project-scoped, and that is a real gap rather than a
 * choice: `CheckResult` carries no `projectId`/`clientId` column (only
 * `subjectType` + `subjectId`), so there is nothing for a `:projectId` URL to
 * be checked against, and the service's `listCheckResults(subjectType,
 * subjectId)` takes no project. Mounting it under a project path without that
 * check would be exactly the nested-id hole G03 describes. Until the model
 * gains an owning column (or the service grows a scoped read), the
 * compensating control is the role restriction below: operator-only, and
 * admin/delivery-lead at that.
 */
@ApiTags('approvals: check results')
@ApiBearerAuth()
@Roles('admin', 'delivery-lead')
@Controller('approvals')
export class ApprovalCheckResultsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get('check-results')
  @ApiOperation({
    summary: 'Claim/source review records for one exact subject, or for a whole project',
    description:
      'Pass `subjectType` + `subjectId` for one exact revision (content-revision | report-revision | work-item — subjectId is that row\'s id, matching the revision an approval is bound to). ' +
      'Or pass `projectId` alone for every check recorded against that project. ' +
      'The project read returns only checks written after `CheckResult.projectId` was added: older rows carry no scope and cannot be attributed after the fact, so they remain reachable only through the subject read.',
  })
  @ApiQuery({ name: 'subjectType', required: false, description: 'content-revision | report-revision | work-item' })
  @ApiQuery({ name: 'subjectId', required: false, description: 'The id of the revision/work item the checks were run against' })
  @ApiQuery({ name: 'projectId', required: false, description: 'Return every check recorded against this project' })
  @ApiResponse({ status: 200, description: '{ results: CheckResultDto[] } — status, detail, payload, checkedBy and checkedVia (automated vs human) per check' })
  @ApiResponse({ status: 400, description: 'Neither a subject nor a projectId was supplied' })
  async list(
    @Query('subjectType') subjectType?: string,
    @Query('subjectId') subjectId?: string,
    @Query('projectId') projectId?: string,
  ) {
    if (projectId) {
      return this.service.listCheckResultsForProject(projectId);
    }
    if (!subjectType || !subjectId) {
      throw new BadRequestException(
        'Supply either subjectType and subjectId (one exact revision), or projectId (the whole project). Checks are only meaningful against one revision or one project.',
      );
    }
    return this.service.listCheckResults(subjectType, subjectId);
  }
}

// ── Client portal ───────────────────────────────────────────────────────

/**
 * The client's own approval queue.
 *
 * `@ClientPortal()` marks the whole class, and `clientId` comes from the JWT —
 * never from a request field. A request that is not this client's is a 404,
 * the same response as one that does not exist, so the surface never confirms
 * that another client's request exists.
 */
@ApiTags('approvals: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/approvals')
export class ApprovalsPortalController {
  constructor(
    private readonly service: ApprovalsService,
    private readonly clientAccess: ClientAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: "This client's approval requests, newest first" })
  @ApiResponse({ status: 200, description: '{ requests: ApprovalRequestDto[] } — client-reviewer requests only' })
  async list(@CurrentUser() user: AuthedRequestUser) {
    return this.service.portalList(this.requireClientId(user));
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One of this client\'s approval requests, with its decision history',
    description: 'Includes the exact artifact revision and revisionId under review, so the client can see what version they are being asked about.',
  })
  @ApiResponse({ status: 200, description: 'The request plus its decisions' })
  @ApiResponse({ status: 404, description: 'Not found, or not this client\'s request' })
  async get(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.portalGet(this.requireClientId(user), id);
  }

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or request changes on this client\'s own request (client-admin seat only)',
    description:
      'revision must equal the request\'s current artifactRevision — a client cannot approve a version they have not been shown, and one is rejected with 409 rather than recorded. Decisions are immutable: a later decision supersedes the earlier one instead of overwriting it. C5 (docs/analysis/client-portal.md §27): only a client-admin seat may decide — a client-collaborator seat can view the queue but not approve/reject.',
  })
  @ApiBody({ type: DecideApprovalDto })
  @ApiResponse({ status: 200, description: 'The updated request, with the new decision first in its history' })
  @ApiResponse({ status: 403, description: 'Caller is a client-collaborator seat, not client-admin' })
  @ApiResponse({ status: 404, description: 'Not found, or not this client\'s request' })
  @ApiResponse({ status: 409, description: 'Already resolved/cancelled/invalidated, or the quoted revision is not the one the request is bound to' })
  async decide(
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: DecideApprovalDto,
  ) {
    const clientId = this.requireClientId(user);
    const membership = await this.clientAccess.resolveMembership(clientId, user.userId);
    if (membership.role !== 'client-admin') {
      throw new ForbiddenException('Only a client-admin seat may approve or request changes on content before it publishes');
    }
    return this.service.portalDecide(clientId, id, user.userId, dto);
  }

  /**
   * Structurally guaranteed by RolesGuard — only a `type="client"` user with a
   * clientId reaches a `@ClientPortal()` route. Re-checked here rather than
   * trusted blindly two layers away, matching the delivery-plan portal
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
