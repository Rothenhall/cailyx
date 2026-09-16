/**
 * LifecycleController — G17's HTTP surface: exports, retention policy and
 * offboarding.
 *
 * Five controllers in one file, one per audience/scope:
 *
 *   Operator  /api/projects/:projectId/exports      — request/status/download
 *   Operator  /api/clients/:clientId/exports        — the same, client-wide
 *   Operator  /api/retention-policies               — reads, updates, preview/run
 *   Operator  /api/clients/:clientId/offboarding    — preview / execute / status
 *   Client    /api/portal/exports                   — this client's own exports
 *
 * Ownership is validated against the id in the URL before any row is touched
 * (AGENT-BRIEF rule 1). An export id is resolved *within* its scope, so an id
 * from another client's export 404s rather than resolving.
 *
 * The destructive routes are admin-only and every one of them is preview-first:
 * `POST .../offboarding` carries out a plan that `POST .../offboarding/preview`
 * already listed, and a retention `apply` needs an enabled policy plus
 * `confirm: true`. Nothing here deletes on a bare POST.
 *
 * @module lifecycle.controller
 */

import {
  BadRequestException,
  Body,
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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ClientPortal, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { LifecycleService, type ExportActor } from './lifecycle.service';
import { OffboardingService } from './offboarding.service';
import { RetentionService } from './retention.service';
import { CreateExportDto } from './dto/export.dto';
import { ApplyRetentionDto, UpdateRetentionPolicyDto } from './dto/retention.dto';
import {
  CancelOffboardingDto,
  ExecuteOffboardingDto,
  PreviewOffboardingDto,
} from './dto/offboarding.dto';

/** Maps the JWT payload onto the export/audit actor shape. */
function actorOf(user: AuthedRequestUser): ExportActor {
  return { userId: user.userId, label: user.email ?? null };
}

// ── Project exports ─────────────────────────────────────────────────────

@ApiTags('lifecycle: exports')
@ApiBearerAuth()
@Controller('projects/:projectId/exports')
export class LifecycleController {
  constructor(
    private readonly exports: LifecycleService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's export requests, newest first",
    description: 'Status, lifetime and what was omitted from each. The row outlives the payload: an expired export still reports that it existed and when it expired.',
  })
  @ApiResponse({ status: 200, description: '{ exports: ExportRequestView[] }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return { exports: await this.exports.list('project', projectId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One export request' })
  @ApiResponse({ status: 404, description: 'Not found, or not in this project\'s scope' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.exports.get('project', projectId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request an export of this project',
    description:
      'Assembles the requested sections from stored rows, writes a scoped payload and gives it a lifetime. The default bundle deliberately excludes `leads` (Cailyx\'s own sales pipeline, personal contact data) and `activity` (the audit trail); both are exportable, but only on request.',
  })
  @ApiBody({ type: CreateExportDto })
  @ApiResponse({ status: 201, description: 'The export request, with `ready` and a size, or `failed` with the reason' })
  @ApiResponse({ status: 400, description: 'Unknown section, or a csv export with more than one section' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateExportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.exports.createForProject(projectId, dto, actorOf(user));
  }

  /**
   * Download an export.
   *
   * Returns the bundle as JSON with the download metadata beside it, so
   * `expiresAt`, `downloadedAt` and `omittedNote` are disclosed in the response
   * itself rather than in a header a client has to go looking for. `?raw=true`
   * streams the file bytes with the same guards applied, for a programmatic
   * consumer that wants the artifact and nothing else.
   */
  @Get(':id/download')
  @ApiOperation({
    summary: 'Download a ready, unexpired export',
    description:
      'Enforces the scope, the status and `expiresAt`, and records `downloadedAt`. Past the expiry the export is marked expired, its payload is removed, and the request is refused with 410.',
  })
  @ApiQuery({ name: 'raw', required: false, description: 'Stream the file itself with Content-Disposition, instead of the JSON envelope carrying the download metadata.' })
  @ApiResponse({ status: 200, description: 'The export, or the JSON envelope describing it' })
  @ApiResponse({ status: 409, description: 'Not ready, or the payload is missing from this host' })
  @ApiResponse({ status: 410, description: 'Expired — the download link is not a permalink' })
  async download(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Query('raw') raw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.serve(res, await this.exports.download('project', projectId, id), raw === 'true');
  }

  /** Shared download response shaping, so both scope surfaces behave identically. */
  private serve(res: Response, download: Awaited<ReturnType<LifecycleService['download']>>, raw: boolean) {
    res.setHeader('X-Export-Expires-At', download.expiresAt ?? 'none');
    res.setHeader('X-Export-Downloaded-At', download.downloadedAt);

    if (raw) {
      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      return download.content;
    }

    let parsed: unknown = download.content;
    if (download.format === 'json') {
      try {
        parsed = JSON.parse(download.content);
      } catch {
        parsed = download.content;
      }
    }
    return {
      exportRequestId: download.exportRequestId,
      scopeType: download.scopeType,
      scopeId: download.scopeId,
      format: download.format,
      filename: download.filename,
      contentType: download.contentType,
      sizeBytes: download.sizeBytes,
      downloadedAt: download.downloadedAt,
      expiresAt: download.expiresAt,
      omittedNote: download.omittedNote,
      content: parsed,
    };
  }
}

// ── Client-scoped exports ───────────────────────────────────────────────

@ApiTags('lifecycle: exports (client)')
@ApiBearerAuth()
@Controller('clients/:clientId/exports')
export class ClientExportsController {
  constructor(
    private readonly exports: LifecycleService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "A client's export requests, newest first" })
  @ApiResponse({ status: 200, description: '{ exports: ExportRequestView[] }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('clientId') clientId: string) {
    await this.scope.assertClientAccess(user, clientId);
    return { exports: await this.exports.list('client', clientId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One client-scoped export request' })
  @ApiResponse({ status: 404, description: 'Not found, or not in this client\'s scope' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.exports.get('client', clientId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Request an export of everything this client owns',
    description: 'Covers every project of the client plus the client-level rows: messages, engagements and seat membership. Admin or delivery-lead, because the bundle is the widest read in this module.',
  })
  @ApiBody({ type: CreateExportDto })
  @ApiResponse({ status: 201, description: 'The export request' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Body() dto: CreateExportDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.exports.createForClient(clientId, dto, actorOf(user));
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download a ready, unexpired client export' })
  @ApiResponse({ status: 200, description: 'The export' })
  @ApiResponse({ status: 410, description: 'Expired' })
  async download(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Query('raw') raw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    const download = await this.exports.download('client', clientId, id);
    res.setHeader('X-Export-Expires-At', download.expiresAt ?? 'none');
    res.setHeader('X-Export-Downloaded-At', download.downloadedAt);
    if (raw === 'true') {
      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      return download.content;
    }
    let parsed: unknown = download.content;
    if (download.format === 'json') {
      try {
        parsed = JSON.parse(download.content);
      } catch {
        parsed = download.content;
      }
    }
    return { ...download, content: parsed };
  }
}

// ── Retention policy ────────────────────────────────────────────────────

/**
 * Admin-only end to end. A retention policy decides when client data is
 * removed, which is an administrative decision rather than a delivery one, and
 * every route here is filed under Administration in design_plan §2.3.
 */
@ApiTags('lifecycle: retention')
@ApiBearerAuth()
@Roles('admin')
@Controller('retention-policies')
export class RetentionController {
  constructor(
    private readonly retention: RetentionService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every retention policy, including the ones with no policy row',
    description:
      'A resource type with no row is returned with `configured: false` and its documented defaults, so "we decided this" and "this is what would happen if we did" are visibly different states rather than a missing row.',
  })
  @ApiResponse({ status: 200, description: '{ policies: RetentionPolicyView[] }' })
  async list() {
    return { policies: await this.retention.list() };
  }

  @Get(':resourceType')
  @ApiOperation({ summary: 'One retention policy' })
  @ApiResponse({ status: 400, description: 'Unknown resource type' })
  async get(@Param('resourceType') resourceType: string) {
    return this.retention.get(resourceType);
  }

  @Put(':resourceType')
  @ApiOperation({
    summary: 'Create or replace a retention policy',
    description:
      'The action is validated against what the resource type permits. `delete` is refused for `activity`: design_plan G17 requires audit history to be retained under policy even when the resource it describes is deleted.',
  })
  @ApiBody({ type: UpdateRetentionPolicyDto })
  @ApiResponse({ status: 200, description: 'The saved policy' })
  @ApiResponse({ status: 400, description: 'Action not permitted for this resource type, or enabling a policy with no window' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('resourceType') resourceType: string,
    @Body() dto: UpdateRetentionPolicyDto,
  ) {
    return this.retention.update(resourceType, dto, actorOf(user));
  }

  @Get(':resourceType/preview')
  @ApiOperation({
    summary: 'Count what a retention run would affect, without running it',
    description: 'Always safe to call, and never requires the policy to be enabled — knowing what a policy would do is exactly what an admin needs before turning one on.',
  })
  @ApiResponse({ status: 200, description: 'RetentionCounts — eligible, affected, the cutoff instant, and a sentence' })
  async preview(@Param('resourceType') resourceType: string) {
    return this.retention.preview(resourceType);
  }

  @Post(':resourceType/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a retention policy',
    description:
      'Refuses when the policy is disabled, when `confirm` is not literally true, or when the resource type does not permit the configured action. Counts are recomputed at run time, so the number reported as acted on is the number acted on.',
  })
  @ApiBody({ type: ApplyRetentionDto })
  @ApiResponse({ status: 200, description: 'RetentionRunResult — eligible, applied, the cutoff and the reason' })
  @ApiResponse({ status: 400, description: 'Missing confirmation, or an action the resource type does not permit' })
  @ApiResponse({ status: 409, description: 'The policy is disabled, or has no retention window' })
  async run(
    @CurrentUser() user: AuthedRequestUser,
    @Param('resourceType') resourceType: string,
    @Body() dto: ApplyRetentionDto,
  ) {
    return this.retention.apply(resourceType, dto, actorOf(user));
  }
}

// ── Offboarding ─────────────────────────────────────────────────────────

@ApiTags('lifecycle: offboarding')
@ApiBearerAuth()
@Controller('clients/:clientId/offboarding')
export class OffboardingController {
  constructor(
    private readonly offboarding: OffboardingService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: "A client's offboarding runs, newest first" })
  @ApiResponse({ status: 200, description: '{ runs: OffboardingRunView[] }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('clientId') clientId: string) {
    await this.scope.assertClientAccess(user, clientId);
    return { runs: await this.offboarding.list(clientId) };
  }

  @Get(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'One offboarding run',
    description: 'A run still in `preview` is re-counted on read, so `drift` shows whether the plan is still exact before anyone executes it.',
  })
  @ApiResponse({ status: 404, description: 'Not found for this client' })
  async get(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.offboarding.get(clientId, id);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Preview an offboarding — exactly what it would affect, by type and count',
    description:
      'Read-only. Lists every resource type the policy defines with its live count and the sentence describing what the action does to it, plus the public-report-link decision and any frozen evidence manifest the plan would break. Narrowing with `classes` is opt-in; the default preview is never trimmed for the caller.',
  })
  @ApiBody({ type: PreviewOffboardingDto })
  @ApiResponse({ status: 200, description: 'OffboardingPreview' })
  @ApiResponse({ status: 400, description: 'Unknown resource type, or an override the policy refuses' })
  async preview(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Body() dto: PreviewOffboardingDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.offboarding.preview(clientId, dto, actorOf(user));
  }

  /**
   * Admin-only, and the only route in this module that destroys data.
   *
   * There is no way to reach it without a preview: it takes the preview's id,
   * re-counts the same resource types, and refuses if anything moved. The
   * separate confirmation phrase exists because a destructive call assembled
   * by a script against the wrong client id is exactly the mistake this
   * workflow has to survive.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Roles('admin')
  @ApiOperation({
    summary: 'Execute the offboarding a preview described',
    description:
      'Requires the preview id, `confirm: true` and the client\'s exact name. Refuses (409) if the counts moved since the preview, if the preview is older than its lifetime, or if the plan would break a pinned evidence snapshot that has not been acknowledged.',
  })
  @ApiBody({ type: ExecuteOffboardingDto })
  @ApiResponse({ status: 200, description: 'The completed run, with per-resource-type counts of what was actually acted on' })
  @ApiResponse({ status: 400, description: 'Missing confirmation, or the confirmation phrase does not match the client' })
  @ApiResponse({ status: 409, description: 'Counts drifted, the preview expired, or a frozen snapshot was not acknowledged' })
  async execute(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Body() dto: ExecuteOffboardingDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.offboarding.execute(clientId, dto, actorOf(user));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Abandon an unexecuted preview' })
  @ApiResponse({ status: 409, description: 'The run already executed — a completed offboarding is a fact, not a draft' })
  async cancel(
    @CurrentUser() user: AuthedRequestUser,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() dto: CancelOffboardingDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.offboarding.cancel(clientId, id, dto, actorOf(user));
  }
}

// ── Client portal ───────────────────────────────────────────────────────

/**
 * The client's own exports.
 *
 * `@ClientPortal()` marks the whole class, and `clientId` comes from the JWT —
 * never from a request field — so a client cannot read another client's export
 * by editing a URL. A client may request and download their own data; they may
 * not request `leads` (Cailyx's own pipeline) or `activity`, and the service
 * refuses both on this surface below.
 */
@ApiTags('lifecycle: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/exports')
export class LifecyclePortalController {
  constructor(
    private readonly exports: LifecycleService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "This client's own export requests" })
  @ApiResponse({ status: 200, description: '{ exports: ExportRequestView[] }' })
  async list(@CurrentUser() user: AuthedRequestUser) {
    const clientId = this.requireClientId(user);
    await this.scope.assertClientAccess(user, clientId);
    return { exports: await this.exports.list('client', clientId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of this client\'s export requests' })
  @ApiResponse({ status: 404, description: 'Not found, or not this client\'s export' })
  async get(@CurrentUser() user: AuthedRequestUser, @Param('id') id: string) {
    const clientId = this.requireClientId(user);
    await this.scope.assertClientAccess(user, clientId);
    return this.exports.get('client', clientId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request an export of this client\'s own data',
    description:
      'The client may export everything the client-wide bundle carries. `leads` (Cailyx\'s own sales pipeline) and `activity` (the internal audit trail) are refused here regardless of what is requested.',
  })
  @ApiBody({ type: CreateExportDto })
  @ApiResponse({ status: 201, description: 'The export request' })
  @ApiResponse({ status: 400, description: 'A section a client may not export' })
  async create(@CurrentUser() user: AuthedRequestUser, @Body() dto: CreateExportDto) {
    const clientId = this.requireClientId(user);
    await this.scope.assertClientAccess(user, clientId);
    return this.exports.createForClient(clientId, this.forClientSurface(dto), actorOf(user));
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download one of this client\'s ready, unexpired exports' })
  @ApiResponse({ status: 200, description: 'The export envelope, including the omitted-field disclosure' })
  @ApiResponse({ status: 410, description: 'Expired' })
  async download(
    @CurrentUser() user: AuthedRequestUser,
    @Param('id') id: string,
    @Query('raw') raw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const clientId = this.requireClientId(user);
    await this.scope.assertClientAccess(user, clientId);
    const download = await this.exports.download('client', clientId, id);

    res.setHeader('X-Export-Expires-At', download.expiresAt ?? 'none');
    res.setHeader('X-Export-Downloaded-At', download.downloadedAt);

    if (raw === 'true') {
      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      return download.content;
    }

    let parsed: unknown = download.content;
    if (download.format === 'json') {
      try {
        parsed = JSON.parse(download.content);
      } catch {
        parsed = download.content;
      }
    }
    return { ...download, content: parsed };
  }

  /**
   * Strip the two sections a client may not export.
   *
   * Refused rather than silently dropped: a client who asked for their data and
   * received a bundle quietly missing a section would have no way to know
   * whether the section was empty or withheld.
   */
  private forClientSurface(dto: CreateExportDto): CreateExportDto {
    const forbidden = (dto.sections ?? []).filter((section) => section === 'leads' || section === 'activity');
    if (forbidden.length > 0) {
      throw new BadRequestException(
        `A client export cannot include: ${forbidden.join(', ')}. ` +
          '`leads` is Cailyx\'s own sales pipeline rather than this client\'s data, and `activity` is the internal audit trail. ' +
          'Both are available to your Cailyx team on request.',
      );
    }
    return dto;
  }

  /** Structurally guaranteed by RolesGuard; re-checked rather than trusted two layers away. */
  private requireClientId(user: AuthedRequestUser): string {
    if (!user.clientId) {
      throw new Error('Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.');
    }
    return user.clientId;
  }
}
