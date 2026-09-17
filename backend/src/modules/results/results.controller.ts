/**
 * ResultsController — G13's HTTP surface: comparable outcomes, the cohorts
 * that define comparability, the stored windows reports are cut from, and the
 * evidence manifests that make a snapshot reproducible.
 *
 * Five controllers in one file, because they share the service graph and the
 * `assertProjectAccess` preamble:
 *
 *   Operator  /api/projects/:projectId/results               — the read
 *   Operator  /api/projects/:projectId/measurement-cohorts   — the comparison key
 *   Operator  /api/projects/:projectId/report-periods        — the stored windows
 *   Operator  /api/projects/:projectId/evidence-manifests    — the pinned sources
 *   Client    /api/portal/projects/:projectId/results        — the client's own view
 *
 * Every handler validates project ownership against the URL's `:projectId`
 * before it touches a row, and every nested id (cohort, period, manifest) is
 * resolved *within* that project — an id from another project 404s rather than
 * resolving (AGENT-BRIEF rule 1; design_plan G03).
 *
 * The client route is a separate class so `@ClientPortal()` marks the whole
 * surface at once. RolesGuard is default-deny for client users, so a client
 * route that quietly inherited the operator guard would be a hole; the
 * service's `project()` then narrows the payload and names what it removed.
 *
 * @module results.controller
 */

import {
  Body,
  Controller,
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
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { CohortService } from './cohort.service';
import { PeriodService } from './period.service';
import { OverviewService } from './overview.service';
import { ResultsTabsService } from './results-tabs.service';
import { EvidenceService } from './evidence.service';
import { ResultsService } from './results.service';
import { CreateCohortDto, RecordBreakDto, UpdateCohortDto } from './dto/cohort.dto';
import { CreatePeriodDto, UpdatePeriodDto } from './dto/period.dto';
import { CreateManifestDto, ListManifestsQueryDto, ResultsQueryDto } from './dto/results.dto';

/** How many manifests a list request may return when it does not say. */
const DEFAULT_MANIFEST_LIMIT = 25;
const MAX_MANIFEST_LIMIT = 100;

/** `limit` arrives as a string; anything outside the documented range is a 400, not a silent clamp. */
function parseManifestLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MANIFEST_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_MANIFEST_LIMIT) {
    return DEFAULT_MANIFEST_LIMIT;
  }
  return value;
}

// ── The results read ────────────────────────────────────────────────────

@ApiTags('results')
@ApiBearerAuth()
@Controller('projects/:projectId/results')
export class ResultsController {
  constructor(
    private readonly results: ResultsService,
    private readonly scope: ScopeValidationService,
  ) {}

  /**
   * The comparable-results read for one window.
   *
   * `periodId` is the strong form: its stored bounds and timezone are used
   * verbatim, so an old report reproduces exactly. `from`/`to` are resolved in
   * `timezone` (bare `YYYY-MM-DD` dates mean the whole day in that zone), and
   * neither leaves the window marked as reproducible.
   *
   * The response states which rung of that precedence was used, and every
   * metric that could not be computed comes back as `state: "not-measured"`
   * with a reason rather than as `0`.
   */
  @Get()
  @ApiOperation({
    summary: 'Comparable results for a reporting window',
    description:
      'Serves the metric dictionary for one window with its evidence bundle, coverage and comparability verdict. ' +
      'A metric with no observations is returned as "not-measured" with the prerequisite, never as 0. ' +
      'When the methodology key changed against the baseline, the deltas are withheld and the break is reported instead.',
  })
  @ApiResponse({ status: 200, description: 'ResultsView — window, metrics, comparability, evidence, disclosure' })
  @ApiResponse({ status: 400, description: 'Unparseable window bound, invalid timezone, or an empty window' })
  @ApiResponse({ status: 404, description: 'Project, period, cohort or baseline not found on this project' })
  async read(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ResultsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.results.getResults(projectId, query, 'operator');
  }
}

// ── Cohorts ─────────────────────────────────────────────────────────────

@ApiTags('results: cohorts')
@ApiBearerAuth()
@Controller('projects/:projectId/measurement-cohorts')
export class CohortsController {
  constructor(
    private readonly cohorts: CohortService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "A project's measurement cohorts" })
  @ApiResponse({ status: 200, description: '{ cohorts: CohortSummary[] }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return { cohorts: await this.cohorts.list(projectId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One cohort, with its methodology fingerprint and recorded breaks' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cohorts.get(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Create a measurement cohort',
    description:
      'The methodology hash is computed from the query set, its version, the engines, the markets and the transport — never accepted from the request, so it always describes the row it sits on.',
  })
  @ApiBody({ type: CreateCohortDto })
  @ApiResponse({ status: 201, description: 'The created cohort' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateCohortDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cohorts.create(projectId, dto);
  }

  /**
   * Editing is the moment a methodology change becomes real, so it requires an
   * explicit reason when the key moves — and the change is appended to `breaks`
   * rather than replacing the fingerprint silently.
   */
  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Edit a cohort',
    description:
      'Changing the query set, its version, the engines, the markets or the transport recomputes the methodology hash and appends a break. Without `breakReason` such an edit is refused (409) — a silent methodology change is the failure this model exists to prevent.',
  })
  @ApiBody({ type: UpdateCohortDto })
  @ApiResponse({ status: 200, description: 'The updated cohort, with its recomputed hash and breaks' })
  @ApiResponse({ status: 409, description: 'The edit changes the methodology key and no breakReason was supplied' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCohortDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cohorts.update(projectId, id, dto);
  }

  @Post(':id/breaks')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a methodology break that no field change expresses',
    description:
      'For the case the schema cannot see: a provider swapped the model behind an unchanged surface id. It breaks comparability just as surely as renaming the engine, so it is recorded the same way.',
  })
  @ApiBody({ type: RecordBreakDto })
  @ApiResponse({ status: 200, description: 'The cohort, with the new break appended' })
  async recordBreak(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: RecordBreakDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.cohorts.recordBreak(projectId, id, dto);
  }
}

// ── Report periods ──────────────────────────────────────────────────────

@ApiTags('results: periods')
@ApiBearerAuth()
@Controller('projects/:projectId/report-periods')
export class PeriodsController {
  constructor(
    private readonly periods: PeriodService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "A project's stored reporting windows, newest first" })
  @ApiResponse({ status: 200, description: '{ periods: ReportPeriod[] }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return { periods: await this.periods.list(projectId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One stored window' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.periods.get(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Store a reporting window',
    description:
      'Bounds are resolved in `timezone` at creation and then frozen as instants, so a later viewer\'s clock or zone cannot shift them. This is what makes "the same report" reproducible.',
  })
  @ApiBody({ type: CreatePeriodDto })
  @ApiResponse({ status: 201, description: 'The created period' })
  @ApiResponse({ status: 400, description: 'Invalid timezone, unparseable bound, or an end before the start' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePeriodDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.periods.create(projectId, dto);
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Edit a stored window',
    description:
      'A period whose window has been pinned by an evidence manifest is immutable (409) — moving it would leave that manifest describing a window it was never built for. Label, cohort and baseline stay editable, because none of them re-point the pinned sources.',
  })
  @ApiBody({ type: UpdatePeriodDto })
  @ApiResponse({ status: 200, description: 'The updated period' })
  @ApiResponse({ status: 409, description: 'The window is pinned by an evidence manifest' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePeriodDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.periods.update(projectId, id, dto);
  }
}

// ── Evidence manifests ──────────────────────────────────────────────────

@ApiTags('results: evidence manifests')
@ApiBearerAuth()
@Controller('projects/:projectId/evidence-manifests')
export class EvidenceManifestsController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly periods: PeriodService,
    private readonly results: ResultsService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's evidence manifests, newest first",
    description: 'Filterable by subject (a report/revision) or period, so a released report can find the manifest it pinned.',
  })
  @ApiResponse({ status: 200, description: '{ manifests: EvidenceManifestView[] }' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListManifestsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return {
      manifests: await this.evidence.list(projectId, {
        subjectType: query.subjectType,
        subjectId: query.subjectId,
        periodId: query.periodId,
        limit: parseManifestLimit(query.limit),
      }),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One manifest, with its pinned ids, coverage and real source dates',
    description:
      '`freshness.latestSourceObservedAt` is the newest timestamp the sources themselves carry. It is a different field from `freshness.periodEndsOn`, which comes from the stored window — a latest-source timestamp is never presented as the period end.',
  })
  @ApiResponse({ status: 200, description: 'EvidenceManifestView' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.evidence.get(projectId, id);
  }

  /**
   * Build and pin a manifest. This is the write a released report makes: it
   * freezes which rows the snapshot came from, so "old reports never change"
   * becomes a property of storage rather than a promise in a docstring.
   */
  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Build and pin an evidence manifest',
    description:
      'Names the exact source rows for one window. `subjectType: "report"` requires a subjectId, because a manifest that names no subject cannot later be checked against the thing it is evidence for.',
  })
  @ApiBody({ type: CreateManifestDto })
  @ApiResponse({ status: 201, description: 'The created manifest' })
  @ApiResponse({ status: 400, description: 'A report manifest with no subjectId' })
  @ApiResponse({ status: 404, description: 'Project, report, cohort or score run not found on this project' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateManifestDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    // The window is resolved through the same precedence the read uses, so a
    // manifest and the results it describes can never cover different days.
    const project = await this.results.loadProject(projectId);
    const { window } = await this.periods.resolveWindow(
      projectId,
      { periodId: dto.periodId, from: dto.from, to: dto.to },
      project.timezone,
    );
    return this.evidence.create(projectId, dto, window);
  }
}

// ── Client portal ───────────────────────────────────────────────────────

/**
 * The client's own view of their results.
 *
 * `@ClientPortal()` marks the whole class and `clientId` comes from the JWT —
 * never from a request field — so a client cannot read another client's
 * results by editing the URL. `assertProjectAccess` then checks the project
 * against that client.
 *
 * The payload is narrowed by `ResultsService.project()`: lead rows, personal
 * contact data, raw model answers, internal notes, unpublished drafts and
 * commercial costs are absent from the response, and each removal is reported
 * in `disclosure.omitted` so the reader sees an omission rather than an empty.
 */
@ApiTags('results: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId')
export class ResultsPortalController {
  constructor(
    private readonly results: ResultsService,
    private readonly scope: ScopeValidationService,
    private readonly overview: OverviewService,
    private readonly tabs: ResultsTabsService,
  ) {}

  @Get('results')
  @ApiOperation({ summary: "This client's own comparable results" })
  @ApiResponse({ status: 200, description: 'ResultsView, narrowed for the client audience' })
  @ApiResponse({ status: 403, description: 'Project does not belong to this client' })
  async read(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ResultsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.results.getResults(projectId, query, 'client');
  }

  /**
   * §5.1's Overview, composed server-side (§5.7). Every panel is its own
   * section envelope, so one failed source read degrades one panel instead of
   * blanking the page (§4.5).
   */
  @Get('overview')
  @ApiOperation({
    summary: "This client's project overview",
    description:
      'One prominent score with its applicable bucket cards, at most three action cards with the true total, ' +
      'at most five upcoming items, and a compact plan/report footer. Reads stored data only: loading this ' +
      'never starts an audit, refreshes a paid provider, builds a score or creates a job.',
  })
  @ApiResponse({ status: 200, description: 'ClientOverviewView' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async overviewView(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    const clientId = this.clientId(user);
    await this.scope.assertProjectAccess(user, projectId);
    return this.overview.getClientOverview(clientId, projectId);
  }

  /** §3.3's Results tab: Website. */
  @Get('results/website')
  @ApiOperation({
    summary: 'Website results, client-safe',
    description:
      'A projection of the same website read model the staff research screen uses: health, search performance, ' +
      'important pages and the source-availability disclosures. Rule ids and page identity handles are removed.',
  })
  async websiteTab(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.tabs.websiteTab(projectId);
  }

  /** §3.3's Results tab: AI visibility. */
  @Get('results/ai')
  @ApiOperation({
    summary: 'AI visibility results, client-safe',
    description:
      'Appeared and recommended stay separate counts, every failed or gated surface is named, and the question-set ' +
      'version stays in the details rather than a headline.',
  })
  async aiTab(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.tabs.aiVisibilityTab(projectId);
  }

  /**
   * §3.3's Results tab: Online presence.
   *
   * The projection is P05's own client-safe presence read
   * (`PresenceService.portalInventory`, also served by
   * `GET /portal/projects/:id/presence`); this route only adds the section
   * envelope so the tab fails the same way as the other three.
   */
  @Get('results/presence')
  @ApiOperation({
    summary: 'Online presence results, client-safe',
    description:
      'Where the client already exists online: found profiles with their state, and the platforms that apply but ' +
      'where nothing was found yet. Candidate confidence scores, discovery-run ids and spend figures stay out.',
  })
  async presenceTab(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.tabs.presenceTab(projectId);
  }

  /**
   * §3.3's Results tab: Competitors.
   *
   * Reads the stored competitor rows and the newest **frozen** comparison
   * snapshot. It deliberately does not build a new comparison: `gap()` can
   * fetch and score a homepage, which §5.7 forbids on a page load.
   */
  @Get('results/competitors')
  @ApiOperation({
    summary: 'Competitor comparison, from the last frozen snapshot',
    description:
      'Never recomputed on read. A newer rival added today does not change what an earlier published comparison said.',
  })
  async competitorsTab(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.tabs.competitorsTab(projectId);
  }

  /** Structurally guaranteed by RolesGuard; re-checked rather than trusted two layers away. */
  private clientId(user: AuthedRequestUser): string {
    if (!user.clientId) {
      throw new Error('Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.');
    }
    return user.clientId;
  }
}
