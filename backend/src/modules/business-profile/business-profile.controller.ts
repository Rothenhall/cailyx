/**
 * BusinessProfileController — G04's HTTP surface.
 *
 * Four controller classes, because the surface has four distinct audiences and
 * route prefixes:
 *
 *   Operator  /api/projects/:projectId/business-profile   — the versioned facts
 *   Operator  /api/clients/:clientId/projects/:projectId  — attach and domain
 *   Operator  /api/projects/:projectId/onboarding         — asks + checklist
 *   Client    /api/portal/projects/:projectId/*           — the client's own
 *
 * The client class is separate so `@ClientPortal()` marks all of it at once —
 * RolesGuard is default-deny for client users, and a client route that quietly
 * inherited the operator guard would be a hole. On that class the caller's
 * `clientId` comes from the JWT only, and every handler still asks the scope
 * guard whether the project in the URL belongs to that client, so a client
 * cannot reach another client's profile by editing the URL.
 *
 * Attach and domain correction live under `:clientId/projects/:projectId`
 * rather than a bare `/projects/:projectId` because both are acts ON the
 * client-project relationship: the URL names the owner the caller claims, and
 * the service checks the project's actual owner against it.
 *
 * @module business-profile.controller
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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { BusinessProfileService } from './business-profile.service';
import {
  ConfirmBusinessProfileDto,
  GetBusinessProfileQueryDto,
  RebuildFromProfileDto,
  RejectBusinessProfileSuggestionDto,
  SaveBusinessProfileDto,
} from './dto/business-profile.dto';
import { AttachProjectDto, CorrectDomainDto } from './dto/attach.dto';
import {
  CreateOnboardingRequestDto,
  ListOnboardingRequestsQueryDto,
  PortalUpdateOnboardingRequestDto,
  UpdateOnboardingRequestDto,
} from './dto/onboarding-request.dto';

// ── Business profile (operator) ─────────────────────────────────────────

@ApiTags('business-profile')
@ApiBearerAuth()
@Controller('projects/:projectId/business-profile')
export class BusinessProfileController {
  constructor(
    protected readonly service: BusinessProfileService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The business profile, by default the newest version of any state',
    description:
      'Pass `version` to read one exact version, or `state=confirmed` to read the newest version a human stood behind — the latter 404s when nothing has ever been confirmed, which is a different fact from "the values are empty". The response carries `state`/`isDraft` and the newest confirmed version, so a caller can always tell a proposal from a confirmed fact.',
  })
  @ApiResponse({ status: 200, description: '{ profile | null, confirmedVersion, versionCount, unavailableReason }' })
  @ApiResponse({ status: 404, description: 'Project not found, requested version not found, or nothing has been confirmed' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: GetBusinessProfileQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getProfile(projectId, { version: query.version, state: query.state });
  }

  @Put()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Save a draft (merge onto the working draft)',
    description:
      'Merges the patch onto the current draft. If the newest row is unconfirmed it is updated in place; if it is confirmed, a new unconfirmed version is created from it. A confirmed row is NEVER edited — confirming writes a new row, so the record of what was agreed to survives the next edit.',
  })
  @ApiBody({ type: SaveBusinessProfileDto })
  @ApiResponse({ status: 200, description: '{ profile, warnings }' })
  async save(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: SaveBusinessProfileDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.saveDraft(projectId, dto, user.userId);
  }

  @Get('versions')
  @ApiOperation({ summary: 'Every profile version on file, newest first' })
  @ApiResponse({ status: 200, description: '{ versions, latestConfirmedVersion }' })
  async versions(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.listVersions(projectId);
  }

  @Post('confirm')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a draft — writes a NEW version carrying confirmedBy/confirmedAt',
    description:
      'The confirming user is recorded from the JWT. An empty draft is refused (there would be nothing for the confirmation to be of); an incomplete but substantive one is accepted, with the gaps returned in `warnings` and written to the audit event rather than turning into a note somebody types "ok" into.',
  })
  @ApiBody({ type: ConfirmBusinessProfileDto })
  @ApiResponse({ status: 200, description: '{ profile (the new confirmed version), confirmedFrom, warnings }' })
  @ApiResponse({ status: 404, description: 'Project or named version not found' })
  @ApiResponse({ status: 409, description: 'Nothing to confirm, already confirmed, superseded, or an empty draft' })
  async confirm(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: ConfirmBusinessProfileDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.confirm(projectId, dto, user.userId);
  }

  @Get('candidates')
  @ApiOperation({
    summary: 'Extracted site-context candidates — guesses, never facts',
    description:
      'Reads SiteContext (crawled/model-extracted). Served on its own surface with `provenance: "extracted"` and no confirmed-at field anywhere, because a scraped value must never be presented as something the client agreed to. Nothing here is merged into the profile automatically.',
  })
  @ApiResponse({ status: 200, description: '{ candidates, policy, latestConfirmedVersion }' })
  async candidates(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.listCandidates(projectId);
  }

  @Get('overview')
  @ApiOperation({
    summary: 'Business information (P02) — Confirmed / Suggested / Needs information, by section',
    description:
      'The four §9.1 sections (About your business, Your customers, Target locations and languages, Brand details), each with its confirmed-or-drafted values, its still-open suggestions from the latest site context, and its gaps. A suggestion that exactly repeats a previously declined value is withheld — see POST candidates/reject.',
  })
  @ApiResponse({ status: 200, description: 'BusinessInfoOverview' })
  async overview(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getBusinessInformation(projectId);
  }

  @Get('target-locations')
  @ApiOperation({
    summary: 'Target locations (P04) — structured targets, site-evidence suggestions, real provider-support preview',
    description:
      'Plan §10.2/§10.3/§10.4: the confirmed-or-drafted structured targets, countries `SiteContext.markets` still suggests that are not yet an active target, and a per-provider `{supported, effectiveGranularity, mode}` preview read from each adapter\'s actual request-building code — never a fabricated "supported: true".',
  })
  @ApiResponse({ status: 200, description: 'TargetLocationsOverview' })
  async targetLocations(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getTargetLocations(projectId);
  }

  @Post('candidates/reject')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a field suggestion ("keep current")',
    description:
      'Records that this exact suggested value was seen and declined, so a later recrawl producing the same value does not present it again. The value is read from the current site context, not the request body.',
  })
  @ApiBody({ type: RejectBusinessProfileSuggestionDto })
  @ApiResponse({ status: 200, description: '{ field, rejected, detail }' })
  @ApiResponse({ status: 404, description: 'Unknown field' })
  @ApiResponse({ status: 409, description: 'No site context, no current suggestion, or it already matches the confirmed/drafted value' })
  async rejectCandidate(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: RejectBusinessProfileSuggestionDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.rejectSuggestion(projectId, dto, { type: 'operator', id: user.userId });
  }

  @Post('rebuild')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Explicitly propagate confirmed facts (the only path that does)',
    description:
      'Confirming changes nothing else on the project. This endpoint is how a confirmed change reaches anything downstream, and it requires the caller to name the targets — nothing moves by implication. `dryRun` reports the diff without writing. The response names the artifacts deliberately left alone and the endpoint that owns each.',
  })
  @ApiBody({ type: RebuildFromProfileDto })
  @ApiResponse({ status: 200, description: 'RebuildResult — per-target before/after, plus what was not touched' })
  @ApiResponse({ status: 409, description: 'No confirmed version to read from, or the named version is a draft' })
  async rebuild(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: RebuildFromProfileDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.rebuild(projectId, dto, user.userId);
  }
}

// ── Attachment and domain (operator) ────────────────────────────────────

@ApiTags('clients: project attachment')
@ApiBearerAuth()
@Controller('clients/:clientId/projects')
export class ProjectAttachmentController {
  constructor(
    private readonly service: BusinessProfileService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get(':projectId/attach-check')
  @ApiOperation({
    summary: 'Preflight an attach without writing anything',
    description:
      'The same rules the attach itself applies, so a wizard can disable the button and explain why. Reports the project’s real ownership (`clientId`), any duplicate-domain collision under normalization, and whether the move needs an explicit reassignment.',
  })
  @ApiResponse({ status: 200, description: 'AttachmentCheckResult — attachable, blockers, warnings' })
  @ApiResponse({ status: 404, description: 'Client or project not found' })
  async check(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('projectId') projectId: string,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.service.checkAttachment(clientId, projectId);
  }

  @Put(':projectId/attach')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Attach (or explicitly reassign) a project to a client',
    description:
      'The authorized escape hatch for "creating a client project fails on an existing domain" (§5.3). Ownership is written to `clientId` only: a legacy `Project.clientName` never resolves to a client, and an unattached project carrying one is reported as unattached. Moving a project away from another client requires `reassign: true`. A duplicate domain — compared after normalization, so `https://www.Example.com/` collides with `example.com` — is refused with 409.',
  })
  @ApiBody({ type: AttachProjectDto })
  @ApiResponse({ status: 200, description: 'ProjectAttachmentDto — the project, its real ownership, and any warnings' })
  @ApiResponse({ status: 404, description: 'Client or project not found' })
  @ApiResponse({ status: 409, description: 'Duplicate domain, or a reassignment that was not explicitly requested' })
  async attach(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AttachProjectDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.service.attachProject(clientId, projectId, dto, user.userId);
  }

  @Put(':projectId/domain')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Correct a project’s domain (validated, conflict-checked, audited)',
    description:
      'Not a display-label edit: the domain keys every later crawl, audit and report, so the new value is normalized to a bare host, checked for collisions against every project, and stored with a mandatory reason and an audit record. The project must belong to `:clientId` — an unattached project is a 404 here, to be attached first.',
  })
  @ApiBody({ type: CorrectDomainDto })
  @ApiResponse({ status: 200, description: 'DomainCorrectionResult — before/after/normalized and whether anything was written' })
  @ApiResponse({ status: 400, description: 'The domain is not a valid hostname' })
  @ApiResponse({ status: 404, description: 'Client not found, or the project is not attached to this client' })
  @ApiResponse({ status: 409, description: 'Another project already uses this domain' })
  async correctDomain(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CorrectDomainDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.service.correctDomain(clientId, projectId, dto, user.userId);
  }
}

// ── Onboarding requests + checklist (operator) ──────────────────────────

/**
 * The requests and checklist surface.
 *
 * The routes are flat (`.../onboarding-requests`, `.../onboarding-checklist`)
 * rather than nested under `.../onboarding/...`, and that is not a style
 * choice. `JobsModule` — registered earlier in `app.module.ts` — already owns
 * `@Controller('projects/:projectId/onboarding')` with `@Get(':runId')`, so a
 * `GET /api/projects/:projectId/onboarding/checklist` is matched by that
 * controller's `:runId` route first and never reaches this one. Nest resolves
 * routes in registration order across modules, so the only fix available from
 * inside this module is to not share the prefix. `POST`/`PATCH` would have
 * coexisted (the jobs controller has no `POST :runId`), but splitting one
 * resource's reads from its writes across two prefixes would be worse than
 * moving all four.
 */
@ApiTags('onboarding: requests and checklist')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class OnboardingChecklistController {
  constructor(
    private readonly service: BusinessProfileService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get('onboarding-requests')
  @ApiOperation({
    summary: "A project's access requests, each with the work it is blocking",
    description:
      '`blockedWork` is returned both as the stored ids and resolved to work items, so a view can say WHAT is waiting on the client rather than only that something is. An id that no longer resolves is reported as `missing: true` rather than dropped.',
  })
  @ApiResponse({ status: 200, description: '{ requests, counts }' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListOnboardingRequestsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.listRequests(projectId, {
      status: query.status,
      kind: query.kind,
      outstanding: query.outstanding === 'true',
    });
  }

  @Post('onboarding-requests')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Raise an access request',
    description:
      'Every `blockedWork` id must belong to THIS project; a foreign or unknown id is a 404 rather than a stored reference, so one client’s request can never name another client’s work.',
  })
  @ApiBody({ type: CreateOnboardingRequestDto })
  @ApiResponse({ status: 201, description: 'The created request, with its blocked work resolved' })
  @ApiResponse({ status: 404, description: 'Project not found, or a blockedWork id is not on this project' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateOnboardingRequestDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.createRequest(projectId, dto, user.userId);
  }

  @Patch('onboarding-requests/:requestId')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Update a request (status, due date, blocked work)',
    description:
      'Status moves are validated against the permitted transition table. Reopening a resolved request clears `resolvedAt`/`resolvedBy` rather than leaving a resolution on the row that no longer holds.',
  })
  @ApiBody({ type: UpdateOnboardingRequestDto })
  @ApiResponse({ status: 200, description: 'The updated request' })
  @ApiResponse({ status: 404, description: 'Request not found on this project, or a blockedWork id is not on this project' })
  @ApiResponse({ status: 409, description: 'Transition not permitted from the current status' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('requestId') requestId: string,
    @Body() dto: UpdateOnboardingRequestDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.updateRequest(projectId, requestId, dto, user.userId);
  }

  @Get('onboarding-checklist')
  @ApiOperation({
    summary: 'The welcome checklist, built from the records behind each line',
    description:
      'Every line names its source, so nothing here is a hand-maintained list: the profile line reads the confirmed version, request lines read their requests, the seat line counts client members, and the scope line reads the project’s cycles. A line with no backing record is `not-requested`, which is not `done`. `blocking` lists the outstanding asks and the work items held up behind each.',
  })
  @ApiResponse({ status: 200, description: 'OnboardingChecklistDto' })
  async checklist(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getChecklist(projectId);
  }
}

// ── Client portal ───────────────────────────────────────────────────────

/**
 * The client's own surface for CP04.
 *
 * `clientId` comes from the JWT and is never a request field. Every handler
 * passes the URL's `projectId` to `assertProjectAccess`, which is what stops a
 * client reading another client's profile by editing the URL. Status moves a
 * client may make are narrower than the operator's — see the service call.
 */
@ApiTags('business-profile: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId')
export class BusinessProfilePortalController {
  constructor(
    private readonly service: BusinessProfileService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get('business-profile')
  @ApiOperation({
    summary: "This client's business profile, latest version",
    description:
      'Carries `state`/`isDraft` and the newest confirmed version, so the portal can render an unconfirmed draft as "not yet confirmed" instead of presenting a proposal as agreed fact.',
  })
  @ApiResponse({ status: 200, description: '{ profile, confirmedVersion, versionCount, unavailableReason }' })
  @ApiResponse({ status: 403, description: 'Project does not belong to this client' })
  async getProfile(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: GetBusinessProfileQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getProfile(projectId, { version: query.version, state: query.state });
  }

  @Put('business-profile')
  @ApiOperation({
    summary: 'Correct the business profile draft',
    description:
      'Same merge semantics as the operator route: the draft is updated, and a confirmed version is never rewritten. A client correcting their own details produces a new draft that an operator confirms.',
  })
  @ApiBody({ type: SaveBusinessProfileDto })
  @ApiResponse({ status: 200, description: '{ profile, warnings }' })
  async saveProfile(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: SaveBusinessProfileDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.saveDraft(projectId, dto, user.userId);
  }

  @Post('business-profile/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the business profile — the CP04 "confirm your details" action',
    description:
      'Records the confirming seat from the JWT. Writes a new version rather than stamping the draft, so what the client was shown when they confirmed remains on file.',
  })
  @ApiBody({ type: ConfirmBusinessProfileDto })
  @ApiResponse({ status: 200, description: '{ profile (the new confirmed version), confirmedFrom, warnings }' })
  @ApiResponse({ status: 409, description: 'Nothing to confirm, already confirmed, superseded, or an empty draft' })
  async confirmProfile(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: ConfirmBusinessProfileDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.confirm(projectId, dto, user.userId);
  }

  @Get('business-profile/overview')
  @ApiOperation({
    summary: 'Business information (P02) — Confirmed / Suggested / Needs information, by section',
    description:
      'Same shape and same client-safe fields as the operator read: no run id, no model name, no cost — only source page and date, which §4.6 allows on a client screen. A suggestion that exactly repeats one this client (or staff) already declined is withheld.',
  })
  @ApiResponse({ status: 200, description: 'BusinessInfoOverview' })
  async businessInfoOverview(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getBusinessInformation(projectId);
  }

  @Get('business-profile/target-locations')
  @ApiOperation({
    summary: 'Target locations (P04) — same shape as the operator read',
    description: 'Structured targets, still-open site-evidence suggestions, and the real per-provider support preview.',
  })
  @ApiResponse({ status: 200, description: 'TargetLocationsOverview' })
  async targetLocations(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getTargetLocations(projectId);
  }

  @Post('business-profile/candidates/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a field suggestion ("keep current")',
    description:
      'The client-facing "Keep current" action beside a suggestion. Records the decline so the same suggested value is not shown again on a later recrawl.',
  })
  @ApiBody({ type: RejectBusinessProfileSuggestionDto })
  @ApiResponse({ status: 200, description: '{ field, rejected, detail }' })
  @ApiResponse({ status: 409, description: 'No site context, no current suggestion, or it already matches the confirmed/drafted value' })
  async rejectBusinessInfoSuggestion(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: RejectBusinessProfileSuggestionDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.rejectSuggestion(projectId, dto, { type: 'client', id: user.userId });
  }

  @Get('onboarding/checklist')
  @ApiOperation({
    summary: 'The welcome checklist for this client',
    description:
      'The same builder as the operator checklist. `blocking` is the "why is this waiting on me" view: each outstanding request with the work items it is holding up, resolved to titles and statuses. Internal operator-only fields are not part of this shape.',
  })
  @ApiResponse({ status: 200, description: 'OnboardingChecklistDto' })
  async checklist(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getChecklist(projectId);
  }

  @Patch('onboarding/requests/:requestId')
  @ApiOperation({
    summary: 'Mark an access request started or done',
    description:
      'Narrower than the operator route on purpose: a client can move a request to in-progress, done or back to open, and nothing else. Waiving an ask is the operator choosing not to need it, so it is not a client action.',
  })
  @ApiBody({ type: PortalUpdateOnboardingRequestDto })
  @ApiResponse({ status: 200, description: 'The updated request' })
  @ApiResponse({ status: 404, description: 'Request not found on this project' })
  @ApiResponse({ status: 409, description: 'A client may not make that status change' })
  async updateRequest(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('requestId') requestId: string,
    @Body() dto: PortalUpdateOnboardingRequestDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.updateRequest(projectId, requestId, dto, user.userId, {
      allowedStatuses: ['open', 'in-progress', 'done'],
      actorLabel: 'client',
    });
  }
}
