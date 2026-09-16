/**
 * OperationsController — G14.
 *
 * Two route groups in one file, because they share the portfolio service:
 *
 *   Operator  /api/operations/*   — portfolio overview, client health, work,
 *                                   reports and sales leads
 *   Operator  /api/saved-views    — the caller's own stored filter state
 *
 * Every route here is an operator route: `type: "client"` users are rejected by
 * RolesGuard's default-deny before they ever reach a handler, so nothing in
 * this file is reachable from the client portal.
 *
 * **These are paginated aggregates, not per-row endpoints.** The portfolio must
 * load in one query: the service computes every list with grouped/batched
 * Prisma queries over the caller's assigned clients, so a 200-client portfolio
 * costs a handful of queries rather than a fan-out of 200. Nothing in this
 * layer loops, and no caller has to poll per client to fill a table.
 *
 * **Assignment scope comes from the caller, never from the query string.**
 * `user` is the first argument of every service method and the service resolves
 * the visible client/project universe from it (direct `OperatorAssignment` rows
 * plus the clients of any assigned project; `admin` sees everything). A
 * `clientId`/`projectId` in the query is only ever a *narrowing filter* applied
 * on top of that scope — it can never widen it, and an id outside the caller's
 * portfolio is refused by the service (403 for a client, 404 for a project).
 *
 * Contract source: design_plan.md Appendix A (G14), lines 1687-1694.
 *
 * @module operations.controller
 */

import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { OperationsService } from './operations.service';
import {
  ClientsHealthQueryDto,
  CreateSavedViewDto,
  ReportsQueryDto,
  SalesLeadsQueryDto,
  UpdateSavedViewDto,
  WorkQueryDto,
} from './dto/operations.dto';

// ── Portfolio ───────────────────────────────────────────────────────────

@ApiTags('operations')
@ApiBearerAuth()
@Controller('operations')
export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Portfolio overview — the attention counts for the whole visible portfolio',
    description:
      'One aggregate call for the header of the operations home: client status counts, projects by status, open/overdue/blocked work, pending approvals, reports and leads by status, alerts by severity and stale sources. Every count is computed with grouped queries against the caller\'s scope, so the whole portfolio loads in a single request — never one request per client. `scope` reports whether the numbers are "all" (admin) or the caller\'s "assigned" portfolio, and `assignedClientCount` is null for an unrestricted admin rather than a fabricated total.',
  })
  @ApiResponse({ status: 200, description: 'OverviewDto' })
  async overview(@CurrentUser() user: AuthedRequestUser) {
    return this.service.getOverview(user);
  }

  @Get('clients/health')
  @ApiOperation({
    summary: "Per-client health rows for the portfolio table (paginated)",
    description:
      'Returns a Page<ClientHealthDto> — `{ items, page, pageSize, total }`. Pagination is page/pageSize (defaults 1/25, pageSize capped at 100 by the query DTO); `total` is computed with the same filters used to fetch `items`, so a filtered page and its total never drift. ' +
      'Each row is assembled from aggregates in one pass: worst open issue, open-issue count, overdue work, decisions awaiting review, stale sources, delivery lead, next commitment and linked evidence. ' +
      '`healthReasons` is the transparent reason list behind the row — there is no hidden composite health number. ' +
      '`highestLatestProjectScore` is the highest `scoreTotal` among this client\'s projects\' MOST RECENT reports — the highest latest project score, NOT an aggregate client-health score. No aggregate health contract exists, so it must be labelled that way wherever it is rendered; a null means no project of this client has a report yet ("not measured yet"), which is not a zero and not a failure. ' +
      'The three flag filters (hasOverdueWork / hasAwaitingDecisions / hasStaleSources) depend on those aggregates, so they are applied after the aggregates are computed and the page is sliced from the filtered set — `total` is then the filtered total, not the raw client count.',
  })
  @ApiResponse({ status: 200, description: 'Page<ClientHealthDto> — { items, page, pageSize, total }' })
  @ApiResponse({ status: 403, description: 'A named clientId is outside the caller\'s assigned portfolio' })
  async clientsHealth(@CurrentUser() user: AuthedRequestUser, @Query() query: ClientsHealthQueryDto) {
    return this.service.getClientsHealth(user, query);
  }

  @Get('work')
  @ApiOperation({
    summary: 'Work items across the portfolio, server-filtered and paginated',
    description:
      'Returns a Page<WorkRowDto> — `{ items, page, pageSize, total }`, page/pageSize as in the query DTO (defaults 1/25, maximum 100). ' +
      'Filters (status, category, discipline, priority, assigneeId, clientId, projectId, overdue, search) are applied server-side against the caller\'s assigned scope before the page is sliced, and `total` uses the same filters. ' +
      '`clientId`/`projectId` narrow the caller\'s own portfolio only — a client outside it is refused, and a project outside it is reported as not found so the id is never confirmed to someone who cannot see it. ' +
      '`overdue` means past dueAt and not verified/cancelled, so finished work is never counted as late.',
  })
  @ApiResponse({ status: 200, description: 'Page<WorkRowDto> — { items, page, pageSize, total }' })
  @ApiResponse({ status: 403, description: 'A named clientId is outside the caller\'s assigned portfolio' })
  @ApiResponse({ status: 404, description: 'A named projectId is not visible to the caller' })
  async work(@CurrentUser() user: AuthedRequestUser, @Query() query: WorkQueryDto) {
    return this.service.getWork(user, query);
  }

  @Get('reports')
  @ApiOperation({
    summary: 'Reports across the portfolio, server-filtered and paginated',
    description:
      'Returns a Page<ReportRowDto> — `{ items, page, pageSize, total }`, page/pageSize as in the query DTO (defaults 1/25, maximum 100). ' +
      'Filter by status, visibility, clientId, projectId or free-text title; the client/project filters narrow the caller\'s assigned scope and never extend it. ' +
      'Score is returned with its band exactly as the report row records it, or the row is not a released one — a report that was withdrawn keeps its last recorded score rather than being re-scored.',
  })
  @ApiResponse({ status: 200, description: 'Page<ReportRowDto> — { items, page, pageSize, total }' })
  @ApiResponse({ status: 403, description: 'A named clientId is outside the caller\'s assigned portfolio' })
  @ApiResponse({ status: 404, description: 'A named projectId is not visible to the caller' })
  async reports(@CurrentUser() user: AuthedRequestUser, @Query() query: ReportsQueryDto) {
    return this.service.getReports(user, query);
  }

  @Get('sales/leads')
  @ApiOperation({
    summary: 'Sales leads across the portfolio, server-filtered and paginated',
    description:
      'Returns a Page<SalesLeadRowDto> — `{ items, page, pageSize, total }`, page/pageSize as in the query DTO (defaults 1/25, maximum 100). ' +
      'Filter by status (new/reached/booked/won/lost), source (bulk/api/form/scorecard), projectId or free-text email. ' +
      'Lead attribution is project-bound, so this surface is scoped through the caller\'s assigned projects — a lead on a project outside the portfolio is simply not in the result.',
  })
  @ApiResponse({ status: 200, description: 'Page<SalesLeadRowDto> — { items, page, pageSize, total }' })
  @ApiResponse({ status: 404, description: 'A named projectId is not visible to the caller' })
  async salesLeads(@CurrentUser() user: AuthedRequestUser, @Query() query: SalesLeadsQueryDto) {
    return this.service.getSalesLeads(user, query);
  }
}

// ── Saved views ─────────────────────────────────────────────────────────

/**
 * Saved views are personal, not shared: every row is keyed to the caller's own
 * `userId` (taken from the JWT, never from the body or a query), and the
 * service refuses to read, update or delete somebody else's view. They store
 * the *filter state* the caller typed — not a cached copy of the rows it
 * matched — so a saved view can never show stale or newly-unauthorized data:
 * reopening it re-runs the query under the current scope.
 */
@ApiTags('operations: saved views')
@ApiBearerAuth()
@Controller('saved-views')
export class SavedViewsController {
  constructor(private readonly service: OperationsService) {}

  @Get()
  @ApiOperation({
    summary: "The caller's own saved views, newest-updated first",
    description:
      'Optionally filtered by `surface` (clients/projects/work/reports/leads/alerts). A surface with no saved views — or an unrecognised one — returns an empty list rather than an error; the caller only ever sees their own rows.',
  })
  @ApiResponse({ status: 200, description: 'SavedViewDto[]' })
  async list(@CurrentUser() user: AuthedRequestUser, @Query('surface') surface?: string) {
    return this.service.listSavedViews(user, surface);
  }

  @Post()
  @ApiOperation({
    summary: 'Save the current filter state of a surface',
    description:
      'Stores the filter/sort/column state verbatim against the caller\'s own account. It is deliberately never a snapshot of result rows: results are re-evaluated from live data and the caller\'s current assignment scope every time the view is opened.',
  })
  @ApiBody({ type: CreateSavedViewDto })
  @ApiResponse({ status: 201, description: 'The created SavedViewDto' })
  async create(@CurrentUser() user: AuthedRequestUser, @Body() body: CreateSavedViewDto) {
    return this.service.createSavedView(user, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, re-filter or re-default one of the caller\'s saved views' })
  @ApiBody({ type: UpdateSavedViewDto })
  @ApiResponse({ status: 200, description: 'The updated SavedViewDto' })
  @ApiResponse({ status: 404, description: 'No such view, or it belongs to another user' })
  async update(
    @Param('id') id: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() body: UpdateSavedViewDto,
  ) {
    return this.service.updateSavedView(user, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: "Delete one of the caller's saved views" })
  @ApiResponse({ status: 200, description: '{ id, deleted: true }' })
  @ApiResponse({ status: 404, description: 'No such view, or it belongs to another user' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.deleteSavedView(user, id);
  }
}
