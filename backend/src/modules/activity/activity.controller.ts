/**
 * ActivityController — G15: the read side of the append-only activity,
 * provenance and audit trail.
 *
 * Four route groups in one file, one per audience/scope:
 *
 *   Operator  /api/activity                       — the whole audit log
 *   Operator  /api/activity/export                — the same filters, unpaginated
 *   Operator  /api/projects/:projectId/activity   — one project's history
 *   Operator  /api/clients/:clientId/activity     — one client's history
 *   Client    /api/portal/activity                — this client's permitted events
 *
 * There is deliberately **no write route**: `ActivityService.record()` is the
 * in-process API other modules inject (ActivityModule exports the service for
 * exactly that), and an HTTP endpoint taking actor/result/origin from a body
 * would let any caller forge the audit record it is supposed to be evidence
 * of. Events become rows only through the code paths that actually do the
 * thing being recorded.
 *
 * The operator routes are all `@Roles('admin', 'delivery-lead')`: the same
 * rows sit behind every one of them, and design_plan §2.3 files the audit log
 * under Administration. The client route is a `@ClientPortal()` class so
 * RolesGuard's default-deny applies, and `clientId` comes from the JWT only.
 *
 * The clientVisible gate is applied by the service, not here —
 * `listForClient()` always ANDs `clientVisible: true` into its query, so
 * nothing internal can leak through the portal read by passing a filter.
 *
 * Query params are taken individually rather than through
 * `ListActivityQueryDto`: that DTO's `limit` carries `@IsInt()` with no
 * `@Type(() => Number)`, so a DTO-validated query string ("limit=50") fails
 * validation and the whole list route 400s. Coercing here keeps the
 * documented contract (limit 1–500, default 100) working today; adding
 * `@Type(() => Number)` to the DTO is the one-line fix that would let these
 * handlers use it again.
 *
 * @module activity.controller
 */

import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ActivityService } from './activity.service';
import { ACTIVITY_ACTIONS } from './dto/activity.dto';

/**
 * `limit` arrives as a string. Anything that is not an integer inside the
 * documented 1–500 range is a 400 rather than a silent fallback to the
 * default — "the first 100 events" and "however many you meant" are
 * different answers and only one of them is safe to return.
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new BadRequestException(`limit must be an integer between 1 and 500, got "${raw}"`);
  }
  return value;
}

// ── Operator: the full audit log ────────────────────────────────────────

@ApiTags('activity')
@ApiBearerAuth()
@Roles('admin', 'delivery-lead')
@Controller('activity')
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get()
  @ApiOperation({
    summary: 'The audit trail, newest first, every event regardless of client visibility',
    description:
      'Filter by resource (type and/or id), action, client, project or actor. Cursor-paginated: pass the previous response\'s nextCursor back as cursor. limit defaults to 100 and is capped at 500 — use the export route for bulk reads.',
  })
  @ApiQuery({ name: 'resourceType', required: false, description: 'e.g. "report", "work-item", "budget-policy"' })
  @ApiQuery({ name: 'resourceId', required: false })
  @ApiQuery({ name: 'action', required: false, enum: ACTIVITY_ACTIONS })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'projectId', required: false })
  @ApiQuery({ name: 'actorId', required: false, description: 'User.id, or the stable id of a system/scheduler/webhook actor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–500, default 100' })
  @ApiQuery({ name: 'cursor', required: false, description: 'A previous response\'s nextCursor' })
  @ApiResponse({ status: 200, description: '{ events: ActivityEventDto[], nextCursor } — nextCursor is null on the last page' })
  @ApiResponse({ status: 400, description: 'limit is not an integer between 1 and 500' })
  @ApiResponse({ status: 403, description: 'Caller is not admin or delivery-lead' })
  async list(
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('action') action?: string,
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('actorId') actorId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({
      resourceType,
      resourceId,
      action,
      clientId,
      projectId,
      actorId,
      limit: parseLimit(limit),
      cursor,
    });
  }

  @Get('export')
  @ApiOperation({
    summary: 'The same filtered audit trail, unpaginated up to the export cap',
    description:
      'Returns up to 5000 events (the service\'s hard cap) so a CSV/JSON export is assembled from one complete set rather than pages that may shift underneath it. Same roles as the paginated read: the cap bounds the transfer, not the audience.',
  })
  @ApiQuery({ name: 'resourceType', required: false })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'projectId', required: false })
  @ApiQuery({ name: 'action', required: false, enum: ACTIVITY_ACTIONS })
  @ApiResponse({ status: 200, description: '{ events: ActivityEventDto[] } — anything past the 5000-event cap is omitted rather than silently truncated mid-set' })
  @ApiResponse({ status: 403, description: 'Caller is not admin or delivery-lead' })
  async export(
    @Query('resourceType') resourceType?: string,
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('action') action?: string,
  ) {
    return this.service.export({ resourceType, clientId, projectId, action });
  }
}

// ── Operator: one project's history ─────────────────────────────────────

@ApiTags('activity')
@ApiBearerAuth()
@Roles('admin', 'delivery-lead')
@Controller('projects/:projectId/activity')
export class ProjectActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get()
  @ApiOperation({
    summary: "One project's activity history, newest first",
    description:
      'Project-scoped but not client-gated: this is the operator\'s view of everything that happened on the project, including events a client may not see. The project id comes from the URL, so a caller cannot widen it through a filter.',
  })
  @ApiQuery({ name: 'resourceType', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–500, default 100' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: '{ events: ActivityEventDto[], nextCursor }' })
  @ApiResponse({ status: 400, description: 'limit is not an integer between 1 and 500' })
  @ApiResponse({ status: 403, description: 'Caller is not admin or delivery-lead' })
  async list(
    @Param('projectId') projectId: string,
    @Query('resourceType') resourceType?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listForProject(projectId, { resourceType, limit: parseLimit(limit), cursor });
  }
}

// ── Operator: one client's history ──────────────────────────────────────

@ApiTags('activity')
@ApiBearerAuth()
@Roles('admin', 'delivery-lead')
@Controller('clients/:clientId/activity')
export class ClientActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get()
  @ApiOperation({
    summary: "One client's activity history across its projects, newest first",
    description:
      'The operator-side equivalent of the portal read: same client scope, full visibility. A clientId in the query string is ignored — the path segment is what scopes the query.',
  })
  @ApiQuery({ name: 'resourceType', required: false })
  @ApiQuery({ name: 'resourceId', required: false })
  @ApiQuery({ name: 'action', required: false, enum: ACTIVITY_ACTIONS })
  @ApiQuery({ name: 'projectId', required: false, description: 'Narrow to one of this client\'s projects' })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–500, default 100' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: '{ events: ActivityEventDto[], nextCursor }' })
  @ApiResponse({ status: 400, description: 'limit is not an integer between 1 and 500' })
  @ApiResponse({ status: 403, description: 'Caller is not admin or delivery-lead' })
  async list(
    @Param('clientId') clientId: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('action') action?: string,
    @Query('projectId') projectId?: string,
    @Query('actorId') actorId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({
      clientId,
      resourceType,
      resourceId,
      action,
      projectId,
      actorId,
      limit: parseLimit(limit),
      cursor,
    });
  }
}

// ── Client portal ───────────────────────────────────────────────────────

/**
 * The client's own activity timeline.
 *
 * `@ClientPortal()` marks the whole class, and `clientId` comes from the JWT —
 * never from a request field, so one client cannot read another's history.
 * The service additionally gates every row on `clientVisible`, so an internal
 * event (a budget change, an operator-only note) is absent rather than
 * filtered after the fact.
 */
@ApiTags('activity: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/activity')
export class PortalActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get()
  @ApiOperation({
    summary: "This client's own activity timeline, newest first",
    description: 'Client-visible events only, across all of this client\'s projects. Rows are gated server-side on clientVisible, not by the caller\'s filters.',
  })
  @ApiQuery({ name: 'resourceType', required: false })
  @ApiQuery({ name: 'projectId', required: false, description: 'Narrow to one of this client\'s own projects' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–500, default 100' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: '{ events: ActivityEventDto[], nextCursor }' })
  @ApiResponse({ status: 400, description: 'limit is not an integer between 1 and 500' })
  async list(
    @Query('resourceType') resourceType: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.service.listForClient(this.requireClientId(user), {
      resourceType,
      projectId,
      limit: parseLimit(limit),
      cursor,
    });
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
