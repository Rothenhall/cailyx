/**
 * ContentCalendarController — P10 (platform_improvement_plan.md §6.4-§6.7).
 *
 * Three route groups in one file, because they share one service and one entry
 * contract:
 *
 *   Operator  /api/projects/:projectId/content-calendar   — the project calendar
 *   Operator  /api/projects/:projectId/content-schedules  — placement writes
 *   Operator  /api/content-calendar                       — portfolio scope
 *   Client    /api/portal/projects/:projectId/content-calendar — the client's own
 *
 * There is exactly one read shape (`CalendarReadResult`) and one entry shape
 * (`CalendarEvent`) across all of them. §6.4's "one content calendar feature,
 * one entry contract, one shared React implementation, one source of scheduling
 * truth" is a statement about the API as much as about the UI: a second
 * endpoint with a second shape is how two calendars come back.
 *
 * Route paths are `content-calendar`/`content-schedules` rather than
 * `calendar` on purpose. `/calendar` is the name the *old* screens used, and
 * §20.3 keeps those paths redirecting rather than reassigning them; a staff
 * member's old bookmark must not silently start rendering a different calendar
 * with different contents.
 *
 * The client routes are a separate controller class so `@ClientPortal()` marks
 * that whole surface at once — RolesGuard is default-deny for client users, and
 * a client route that quietly inherited the operator guard would be a hole.
 * There are deliberately **no** write routes in the portal controller: a client
 * reads their calendar, and moving a placement stays an operator action (§6.6's
 * intention is the agency's commitment).
 *
 * @module content-calendar.controller
 */

import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ClientPortal, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ContentCalendarService } from './content-calendar.service';
import {
  CancelPlacementDto,
  CreatePlacementDto,
  LinkPublicationDto,
  ListCalendarQueryDto,
  PortalCalendarQueryDto,
  UpdatePlacementDto,
} from './dto/content-calendar.dto';

/**
 * Who may place and move content on a calendar.
 *
 * `content` is included because the person writing the piece is the person who
 * knows when it should go out, and a placement is an intention with no
 * authority behind it — it grants nothing. Linking a publication is narrower
 * (see below) because that is the step that actually sends something.
 */
const SCHEDULE_WRITE_ROLES = ['admin', 'delivery-lead', 'content'] as const;

/**
 * Who may link a placement to an approved revision — i.e. who may cause a
 * publication to exist.
 *
 * The same two roles publishing's own `POST /publications` allows. Kept
 * identical on purpose: if this route were laxer, the calendar would be the
 * cheaper way to publish, and the approval gates would be one route deep.
 */
const PUBLISH_LINK_ROLES = ['admin', 'delivery-lead'] as const;

@ApiTags('Content calendar')
@ApiBearerAuth()
@Controller('projects/:projectId/content-calendar')
export class ProjectContentCalendarController {
  constructor(private readonly calendar: ContentCalendarService) {}

  /**
   * The project's calendar for a bounded window.
   *
   * The response always carries `page.truncated`, `page.nextCursor` and
   * `totalInWindow`, so a client can tell an empty month from a truncated page
   * (§6.7 — "a UI cannot claim a month is empty because it loaded only the
   * latest 200 records").
   */
  @Get()
  @ApiOperation({ summary: "A project's content calendar, month by default" })
  @ApiResponse({ status: 200, description: 'CalendarReadResult' })
  async read(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListCalendarQueryDto,
  ) {
    return this.calendar.readProjectCalendar(user, projectId, query);
  }
}

@ApiTags('Content calendar')
@ApiBearerAuth()
@Controller('projects/:projectId/content-schedules')
export class ContentSchedulesController {
  constructor(private readonly calendar: ContentCalendarService) {}

  /**
   * Plan a placement — a date the content is *intended* for.
   *
   * Nothing about this call requires an approved revision, which is the whole
   * point of §6.6: a planned date must be visible before approval, not after.
   * It is idempotent on `idempotencyKey` (§6.7).
   */
  @Post()
  @Roles(...SCHEDULE_WRITE_ROLES)
  @ApiOperation({ summary: 'Plan a content placement (the scheduling intention)' })
  @ApiBody({ type: CreatePlacementDto })
  @ApiResponse({ status: 201, description: 'CalendarEvent' })
  @ApiResponse({ status: 400, description: 'Invalid time, nonexistent or ambiguous DST reading, or a non-content asset' })
  @ApiResponse({ status: 409, description: 'A destination that cannot be used, or a repeated local time left undisambiguated' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePlacementDto,
  ) {
    return this.calendar.createPlacement(user, projectId, dto);
  }

  /**
   * Move or edit a placement.
   *
   * `version` is required and a stale one is refused (409 `version-conflict`),
   * so two operators editing the same week cannot silently overwrite each
   * other (§6.7).
   */
  @Patch(':id')
  @Roles(...SCHEDULE_WRITE_ROLES)
  @ApiOperation({ summary: 'Move or edit a placement (optimistic concurrency)' })
  @ApiBody({ type: UpdatePlacementDto })
  @ApiResponse({ status: 200, description: 'CalendarEvent' })
  @ApiResponse({ status: 409, description: 'Stale version, or a cancelled placement' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePlacementDto,
  ) {
    return this.calendar.updatePlacement(user, projectId, id, dto);
  }

  /**
   * Cancel a placement. A state change, never a delete — §6.7's "cancellation
   * preserves history", and the reason a reason is required.
   */
  @Post(':id/cancel')
  @Roles(...SCHEDULE_WRITE_ROLES)
  @ApiOperation({ summary: 'Cancel a placement (history preserved, never deleted)' })
  @ApiBody({ type: CancelPlacementDto })
  @ApiResponse({ status: 201, description: 'CalendarEvent with state "cancelled"' })
  @ApiResponse({ status: 409, description: 'A publication is still queued against this placement' })
  async cancel(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: CancelPlacementDto,
  ) {
    return this.calendar.cancelPlacement(user, projectId, id, dto.reason, dto.version);
  }

  /**
   * Link the placement to an approved revision — through publishing's gates.
   *
   * Narrower roles than a plain move, because this is the step that creates a
   * publication. Every gate (exact-revision approval, destination connected,
   * permissions granted, provider implemented) is enforced by publishing, and
   * re-checked again at dispatch time.
   */
  @Post(':id/publication')
  @Roles(...PUBLISH_LINK_ROLES)
  @ApiOperation({ summary: "Link this placement to an approved revision via publishing's gates" })
  @ApiBody({ type: LinkPublicationDto })
  @ApiResponse({ status: 201, description: 'CalendarEvent with its execution attached' })
  @ApiResponse({ status: 409, description: 'No approved revision at the current revision, or a revision mismatch' })
  @ApiResponse({ status: 400, description: 'A manual-only channel, which never sends automatically' })
  async link(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: LinkPublicationDto,
  ) {
    return this.calendar.linkPublication(user, projectId, id, dto);
  }
}

@ApiTags('Content calendar')
@ApiBearerAuth()
@Controller('content-calendar')
export class PortfolioContentCalendarController {
  constructor(private readonly calendar: ContentCalendarService) {}

  /**
   * The portfolio calendar — the same events, across every project the caller
   * may see (§3.4).
   *
   * Access is not a parameter: the permitted project set comes from the caller's
   * own access rules, so an operator reads their own book. `projectId` narrows
   * within that set and is refused (404) outside it.
   */
  @Get()
  @ApiOperation({ summary: 'Portfolio content calendar across permitted projects' })
  @ApiResponse({ status: 200, description: 'CalendarReadResult' })
  async read(@CurrentUser() user: AuthedRequestUser, @Query() query: ListCalendarQueryDto) {
    return this.calendar.readPortfolioCalendar(user, query);
  }
}

@ApiTags('Client Portal')
@ClientPortal()
@Controller('portal/projects/:projectId/content-calendar')
export class PortalContentCalendarController {
  constructor(private readonly calendar: ContentCalendarService) {}

  /**
   * The client's own calendar.
   *
   * Read-only, and filtered: only pieces with an explicitly shared revision
   * appear at all (§13.5), and the filter is applied to the query rather than
   * the output, so `totalInWindow` and the unscheduled total cannot count an
   * unshared internal draft either. Internal fields are omitted rather than
   * blanked — no destination label, no owner id, no raw provider error.
   */
  @Get()
  @ApiOperation({ summary: "This client's own content calendar" })
  @ApiResponse({ status: 200, description: 'CalendarReadResult, filtered to explicitly shared content' })
  @ApiResponse({ status: 404, description: 'A project this client login does not own' })
  async read(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Query() query: PortalCalendarQueryDto,
  ) {
    return this.calendar.readPortalCalendar(this.clientId(req), projectId, query);
  }

  private clientId(req: Request): string {
    const user = req.user as AuthedRequestUser;
    // Structurally guaranteed by RolesGuard (only a type="client" user carrying
    // a clientId ever reaches a @ClientPortal() route) — checked again here
    // defensively rather than trusted two layers away. A missing clientId is a
    // guard bug, not a client error, so it must not read as "not found".
    if (!user.clientId) {
      throw new Error(
        'Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.',
      );
    }
    return user.clientId;
  }
}
