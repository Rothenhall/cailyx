/**
 * PublishingController — G11's operator surface.
 *
 * Two route groups, both nested under the owning project so the ownership check
 * in the URL is real (AGENT-BRIEF rule 1): a destination id or publication id
 * from another project 404s rather than resolving.
 *
 *   /api/projects/:projectId/publish-destinations  — connect, test, revoke, pick a resource
 *   /api/projects/:projectId/publications          — create, read, cancel, retry, verify
 *
 * The destinations live at `publish-destinations` rather than under
 * `/publications/destinations` (which is where the design plan's wording would
 * put them) because `publications/:publicationId` already exists: a nested
 * `destinations` segment would be matched by the id parameter first and depend
 * on declaration order to behave. An explicit path is unambitious and correct.
 *
 * Roles: connecting a destination and publishing are `admin`/`delivery-lead`
 * (they write to a third party and commit the client publicly). Reading is open
 * to any operator who can reach the project — scope is enforced by
 * `ScopeValidationService` at the top of each handler.
 *
 * @module publishing.controller
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
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { PublishingService, type Actor } from './publishing.service';
import {
  CreateDestinationDto,
  ListDestinationsQueryDto,
  RevokeDestinationDto,
  SelectResourceDto,
  UpdateDestinationDto,
} from './dto/destination.dto';
import {
  CancelPublicationDto,
  CreatePublicationDto,
  ListPublicationsQueryDto,
  RetryPublicationDto,
} from './dto/publication.dto';

/** Maps the JWT payload onto the service's actor shape. */
function actorOf(user: AuthedRequestUser): Actor {
  return { userId: user.userId, role: user.role, type: user.type };
}

// ── Provider catalogue ──────────────────────────────────────────────────

@ApiTags('publishing: providers')
@ApiBearerAuth()
@Controller('publishing')
export class PublishingProvidersController {
  constructor(private readonly service: PublishingService) {}

  @Get('providers')
  @ApiOperation({
    summary: 'Every publishing provider, and whether it can be used yet',
    description:
      'One entry per provider with its kind (cms | social | email | ads | webhook), the scopes it can be authorized for, and — when no adapter exists — the reason it is unavailable. ' +
      'Kinds are disjoint on purpose: a connection is made to one provider for named scopes, never to "social + CMS" in a single consent.',
  })
  @ApiResponse({ status: 200, description: '{ providers: ProviderDeclaration[] }' })
  list() {
    return this.service.listProviders();
  }
}

// ── Destinations ────────────────────────────────────────────────────────

@ApiTags('publishing: destinations')
@ApiBearerAuth()
@Controller('projects/:projectId/publish-destinations')
export class PublishDestinationsController {
  constructor(
    private readonly service: PublishingService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "A project's publish destinations", description: 'Never returns a credential value — `credentialRef` is the secret-store name and `credentialConfigured` says whether it currently resolves.' })
  @ApiResponse({ status: 200, description: '{ destinations: PublishDestinationView[] }' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListDestinationsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.listDestinations(projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One destination' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Param('id') id: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getDestination(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Declare a destination (does not connect it)',
    description:
      'Creates the connection in `unconfigured`. Nothing is called remotely, so a row existing is never mistaken for a provider working. ' +
      '`config` holds non-secret settings only — a secret-shaped key is rejected — and `permissions` must be a subset of this one provider\'s declared scopes.',
  })
  @ApiBody({ type: CreateDestinationDto })
  @ApiResponse({ status: 201, description: 'The created destination' })
  @ApiResponse({ status: 400, description: 'Unknown provider, unknown/absent scope, or a secret-shaped config key' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateDestinationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.createDestination(projectId, dto, actorOf(user));
  }

  @Patch(':id')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Edit a destination', description: 'Changing the config or the credential reference returns it to `unconfigured`: what was tested is no longer what is configured.' })
  @ApiBody({ type: UpdateDestinationDto })
  @ApiResponse({ status: 200, description: 'The updated destination' })
  @ApiResponse({ status: 409, description: 'The destination was revoked' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDestinationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.updateDestination(projectId, id, dto, actorOf(user));
  }

  @Post(':id/authorize')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connect a destination',
    description:
      'Runs the provider\'s own reachability test and marks the destination `connected` only if it passes. A provider with no adapter gets **501** with the reason — no authorization URL is fabricated for a flow that cannot complete.',
  })
  @ApiResponse({ status: 200, description: 'The connected destination' })
  @ApiResponse({ status: 501, description: 'No adapter exists for this provider in this build' })
  @ApiResponse({ status: 503, description: 'The credential/endpoint is not configured, or the provider refused the test' })
  async authorize(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.authorizeDestination(projectId, id, actorOf(user));
  }

  @Post(':id/test')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a destination',
    description: 'Reaches the provider without changing the authorized scopes. A failure is persisted on the row (`status: "error"`, `lastError`) as well as returned.',
  })
  @ApiResponse({ status: 200, description: 'The tested destination' })
  @ApiResponse({ status: 501, description: 'No adapter exists for this provider in this build' })
  @ApiResponse({ status: 503, description: 'Not configured, or the remote test failed' })
  async test(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Param('id') id: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.testDestination(projectId, id, actorOf(user));
  }

  @Get(':id/resources')
  @ApiOperation({
    summary: 'The remote resources this destination may publish into',
    description: 'For a CMS this is the site/collection list; for a webhook it is the endpoint or the channels the receiver declares.',
  })
  @ApiResponse({ status: 200, description: '{ provider, resources, selectedResourceId }' })
  @ApiResponse({ status: 501, description: 'No adapter exists for this provider in this build' })
  async resources(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.listResources(projectId, id);
  }

  @Post(':id/resource')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Choose the remote resource to publish into',
    description: 'The choice is validated against the adapter\'s own list — an id the provider does not offer is a 400, not a value stored to fail on later.',
  })
  @ApiBody({ type: SelectResourceDto })
  @ApiResponse({ status: 200, description: 'The updated destination' })
  @ApiResponse({ status: 400, description: 'That resource is not one the provider offers' })
  async selectResource(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SelectResourceDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.selectResource(projectId, id, dto, actorOf(user));
  }

  @Post(':id/revoke')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a destination',
    description:
      'Stops future pushes. Pending publications for it are left pending with a derived reason (the response says how many) rather than silently cancelled, and nothing already at the remote system is touched.',
  })
  @ApiBody({ type: RevokeDestinationDto })
  @ApiResponse({ status: 200, description: 'The revoked destination, plus how many publications were waiting on it' })
  @ApiResponse({ status: 409, description: 'Already revoked' })
  async revoke(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: RevokeDestinationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.revokeDestination(projectId, id, dto.reason, actorOf(user));
  }
}

// ── Publications ────────────────────────────────────────────────────────

@ApiTags('publishing: publications')
@ApiBearerAuth()
@Controller('projects/:projectId/publications')
export class PublicationsController {
  constructor(
    private readonly service: PublishingService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "A project's publications, newest first", description: 'Each row carries its push state and its verification state separately, plus a derived `blockedReason` when nothing will happen next.' })
  @ApiResponse({ status: 200, description: '{ publications: PublicationView[] }' })
  async list(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Query() query: ListPublicationsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.listPublications(projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One publication' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Param('id') id: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.getPublication(projectId, id);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Publish an approved revision (or schedule it)',
    description:
      'The only path that can lead to a remote write. Requires an approved approval request for **this exact revision** (recorded on the row as `approvalId`), passes the same claim gate that guards report release, and checks the scopes against what the destination was authorized for. ' +
      'Without `scheduledFor` it dispatches immediately; with one it waits for the dispatcher, which re-checks every gate before writing.',
  })
  @ApiBody({ type: CreatePublicationDto })
  @ApiResponse({ status: 201, description: 'The publication, dispatched or scheduled, with its own state' })
  @ApiResponse({ status: 403, description: 'The destination is not authorized for the requested scopes' })
  @ApiResponse({ status: 409, description: 'No approval for this revision, the destination is not connected, or the revision changed since it was read' })
  @ApiResponse({ status: 501, description: 'No adapter exists for this destination\'s provider' })
  async create(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreatePublicationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.createPublication(projectId, dto, actorOf(user));
  }

  @Post(':id/verify')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the published content is live',
    description:
      'Fetches the remote URL and looks for a content marker. Records `verifiedAt`/`verifiedUrl` or `verifyError` plus a `CheckResult` evidence row — and never changes `status`, because a failed fetch does not un-publish anything.',
  })
  @ApiResponse({ status: 200, description: 'The publication with its verification state' })
  @ApiResponse({ status: 409, description: 'There is no remote URL to verify yet' })
  async verify(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Param('id') id: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.verifyPublication(projectId, id, actorOf(user));
  }

  @Post(':id/cancel')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a publication that has not gone out',
    description: 'Refused once the content has reached the remote system: cancelling a row cannot remove a live post, and rollback is not implemented — the error says so.',
  })
  @ApiBody({ type: CancelPublicationDto })
  @ApiResponse({ status: 200, description: 'The cancelled publication' })
  @ApiResponse({ status: 409, description: 'Already at the remote system, already cancelled, or already published' })
  async cancel(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: CancelPublicationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.cancelPublication(projectId, id, dto.reason, actorOf(user));
  }

  @Post(':id/retry')
  @Roles('admin', 'delivery-lead')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a failed publication (safe by construction)',
    description:
      'If the publication already has a remote id, the write happened: this re-runs **verification** instead of posting again, and the response says `retried: "verification"`. A retry that would re-post requires `confirmNoRemoteCopy: true` when the previous dispatch was interrupted.',
  })
  @ApiBody({ type: RetryPublicationDto })
  @ApiResponse({ status: 200, description: 'The publication, plus what was actually retried' })
  @ApiResponse({ status: 409, description: 'In flight, cancelled, pending, or confirmation required before re-posting' })
  async retry(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: RetryPublicationDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.service.retryPublication(projectId, id, dto, actorOf(user));
  }
}
