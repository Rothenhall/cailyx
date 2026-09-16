/**
 * ClientAccessController — G02.
 *
 * Six route groups in one file, because they share two services
 * (`ClientAccessService` for seats/invites, `GoogleDelegationService` for the
 * delegated Google surface) and the same scope-resolution helpers:
 *
 *   Operator  /api/clients/:clientId/members            — seats
 *   Operator  /api/clients/:clientId/invites            — invitations
 *   Public    /api/invites/:token/accept                — acceptance
 *   Client    /api/portal/members, /api/portal/invites  — the client's own seats
 *   Client    /api/portal/projects/:projectId/integrations/google/* — their own
 *                                                       Google grant + delegations
 *
 * The client surfaces are separate controller classes so `@ClientPortal()`
 * marks each whole surface at once. RolesGuard is default-deny for both
 * directions — a `type: "client"` user cannot reach an unmarked route, and an
 * operator cannot reach a `@ClientPortal()` one — so a client route that
 * quietly inherited the operator surface would be a hole in both directions.
 *
 * **Scope is resolved server-side, from the caller, never from the request:**
 * - Operator routes: `clientId` comes from the URL *and* is checked against the
 *   caller's assigned portfolio before the service touches anything
 *   (`ScopeValidationService.assertClientAccess`), so an unassigned operator
 *   gets 403 rather than another client's seat list.
 * - Client routes: `clientId` comes from the caller's JWT (`user.clientId`),
 *   never a request field, so a client cannot ask for another client's seats by
 *   editing the URL. Project-scoped Google routes additionally resolve the
 *   caller's seat (`resolveMembership`) and check the project against that
 *   seat's scope (`requireProjectInScope`).
 * - Public acceptance: the grant (clientId/role/projectIds) is read from the
 *   STORED token row. The body carries only what the invitee supplies — a
 *   password and optionally a name — never a role or a clientId.
 *
 * Contract source: design_plan.md Appendix A (G02), lines 1601-1608.
 *
 * @module client-access.controller
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { ClientPortal, Public, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import type { GoogleService } from '../google/google.types';
import { ClientAccessService } from './client-access.service';
import { GoogleDelegationService } from './google-delegation.service';
import type { ResolvedMembership } from './client-access.types';
import {
  AcceptInviteDto,
  CreateDelegationDto,
  CreateInviteDto,
  CreateMemberDto,
  GoogleAuthorizeDto,
  GoogleResourceQueryDto,
  SetGoogleResourceDto,
  UpdateMemberDto,
} from './dto/client-access.dto';

/**
 * Structurally guaranteed by RolesGuard — only a `type="client"` user with a
 * clientId reaches a `@ClientPortal()` route. Re-checked at the boundary
 * rather than trusted blindly two layers away.
 */
function requireClientId(user: AuthedRequestUser): string {
  if (!user.clientId) {
    throw new Error(
      'Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.',
    );
  }
  return user.clientId;
}

/**
 * Seat management is the one thing a client-admin does that a collaborator or
 * viewer must not: `client-collaborator` has scoped project access and
 * `client-viewer` is read-only (see client-access.types.ts). A login created
 * before G02 has no ClientMember row yet and resolves as a full-scope
 * client-admin, so nobody is locked out mid-rollout.
 */
async function requireClientAdmin(
  access: ClientAccessService,
  user: AuthedRequestUser,
): Promise<string> {
  const clientId = requireClientId(user);
  const membership = await access.resolveMembership(clientId, user.userId);
  if (membership.role !== 'client-admin') {
    throw new ForbiddenException('Only a client-admin seat may manage seats and invitations');
  }
  return clientId;
}

/** Path/query values arrive as raw strings; the two Google services are the only accepted ones. */
function googleService(raw: string | undefined): GoogleService {
  if (raw !== 'search-console' && raw !== 'analytics') {
    throw new BadRequestException('service must be "search-console" or "analytics"');
  }
  return raw;
}

/** Rolling window for a test read — same 1-90 range the operator Google surface accepts. */
function parseDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 28;
  const days = Number.parseInt(raw, 10);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new BadRequestException('days must be an integer between 1 and 90');
  }
  return days;
}

// ── Operator: seats ─────────────────────────────────────────────────────

@ApiTags('client-access: members')
@ApiBearerAuth()
@Controller('clients/:clientId/members')
export class ClientMembersController {
  constructor(
    private readonly access: ClientAccessService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A client's seats",
    description:
      'Seats are counted per person, not per login: `projectIds` empty means every project of this client, and `status: "suspended"` rows are excluded because a revoked seat is soft-deleted (removedAt set) so its audit trail survives.',
  })
  @ApiResponse({ status: 200, description: '{ members: ClientMemberDto[] }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this client' })
  async list(@Param('clientId') clientId: string, @CurrentUser() user: AuthedRequestUser) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.listMembers(clientId);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Add an existing client login as a scoped seat',
    description:
      'For a person who already has a login for this client (see the invite routes for anyone who does not). `userId` must be an existing `type: "client"` login belonging to this same client — a login for another account is rejected rather than silently re-parented. Re-adding a previously revoked seat reactivates it instead of creating a duplicate.',
  })
  @ApiBody({ type: CreateMemberDto })
  @ApiResponse({ status: 201, description: 'The created (or reactivated) ClientMemberDto' })
  @ApiResponse({ status: 400, description: 'userId is not an existing client login belonging to this client' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this client, or lacks the role' })
  async create(
    @Param('clientId') clientId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateMemberDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.createMember(clientId, dto, user.userId);
  }

  @Patch(':memberId')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: "Change a seat's role, project scope or status",
    description:
      'Narrowing `projectIds` takes effect on the member\'s next request — their token is re-derived from the database on every call, so a seat scope change does not have to wait for a token to expire.',
  })
  @ApiBody({ type: UpdateMemberDto })
  @ApiResponse({ status: 200, description: 'The updated ClientMemberDto' })
  @ApiResponse({ status: 404, description: 'No such seat for this client' })
  async update(
    @Param('clientId') clientId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: UpdateMemberDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.updateMember(clientId, memberId, dto);
  }

  @Delete(':memberId')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Revoke a seat',
    description:
      'A soft delete (removedAt + status "suspended") — never a hard delete, so invitedBy and the seat\'s history survive the revocation.',
  })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 404, description: 'No such seat for this client' })
  async revoke(
    @Param('clientId') clientId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.revokeMember(clientId, memberId);
  }
}

// ── Operator: invitations ───────────────────────────────────────────────

@ApiTags('client-access: invites')
@ApiBearerAuth()
@Controller('clients/:clientId/invites')
export class ClientInvitesController {
  constructor(
    private readonly access: ClientAccessService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A client's invitations, newest first",
    description:
      'Each row carries its derived status — pending / accepted / expired / revoked — rather than asking the caller to compare expiresAt against the clock. Only invites scoped to this client are returned.',
  })
  @ApiResponse({ status: 200, description: '{ invites: InviteDto[] }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this client' })
  async list(@Param('clientId') clientId: string, @CurrentUser() user: AuthedRequestUser) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.listInvites(clientId);
  }

  @Post()
  @Roles('admin', 'delivery-lead')
  @ApiOperation({
    summary: 'Invite somebody to the client portal',
    description:
      'Creates a single-use, 7-day invitation whose scope (client, seat role, project ids) is stored with the token — the invitee can never widen it on acceptance. The raw token and accept URL are returned exactly once, in this response, and are never retrievable again; `emailSent`/`emailError` report the delivery attempt honestly instead of claiming an email went out. An email that already has a login for this client is refused with a conflict — add them as a seat instead.',
  })
  @ApiBody({ type: CreateInviteDto })
  @ApiResponse({ status: 201, description: 'InviteCreatedDto — includes the one-time token and acceptUrl' })
  @ApiResponse({ status: 409, description: 'That email already has a login (for this client or another account)' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this client, or lacks the role' })
  async create(
    @Param('clientId') clientId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateInviteDto,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.createInvite(clientId, dto, user.userId);
  }

  @Delete(':inviteId')
  @Roles('admin', 'delivery-lead')
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 404, description: 'No such invite for this client' })
  @ApiResponse({ status: 409, description: 'The invite was already accepted — revoke the seat instead' })
  async revoke(
    @Param('clientId') clientId: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    await this.scope.assertClientAccess(user, clientId);
    return this.access.revokeInvite(clientId, inviteId);
  }
}

// ── Public: acceptance ──────────────────────────────────────────────────

/**
 * The only unauthenticated route in this module. The invitee has no session
 * yet by definition, so the token in the URL is the credential.
 *
 * The request body is deliberately narrow: a password and an optional display
 * name. It cannot carry a role, a clientId or a project list, because the grant
 * is read from the stored token row — so a tampered or replayed body has
 * nothing to widen.
 */
@ApiTags('client-access: invite acceptance')
@Controller('invites')
export class InviteAcceptanceController {
  constructor(private readonly access: ClientAccessService) {}

  @Public()
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation — set a password and open a session',
    description:
      'The grant (client, seat role, project scope) is resolved exclusively from the stored token, never from this body. Single use: an accepted token is marked used, so a replayed link cannot mint a second session. Expired, revoked and already-accepted tokens are refused with 409 and the invitee is told to ask for a new invite. An email that already exists for a different account is refused rather than re-parented. On success the response is a session (accessToken/refreshToken) plus the created or reactivated seat.',
  })
  @ApiBody({ type: AcceptInviteDto })
  @ApiResponse({ status: 200, description: 'InviteAcceptedDto — { accessToken, refreshToken, member }' })
  @ApiResponse({ status: 404, description: 'Unknown invite token' })
  @ApiResponse({ status: 409, description: 'Revoked, already accepted, expired, malformed, or an email conflict' })
  async accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.access.acceptInvite(token, dto);
  }
}

// ── Client portal: seats ────────────────────────────────────────────────

/**
 * The client's own seat list. `@ClientPortal()` marks the whole class, and
 * `clientId` comes from the JWT — never from a request field, so a client
 * cannot read or change another client's seats by editing a URL.
 *
 * Reading is open to every seat (you can see who else is on your account);
 * every mutation requires a `client-admin` seat, mirroring the seat model.
 */
@ApiTags('client-access: portal members')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/members')
export class ClientPortalMembersController {
  constructor(private readonly access: ClientAccessService) {}

  @Get()
  @ApiOperation({ summary: "This client's own seats" })
  @ApiResponse({ status: 200, description: '{ members: ClientMemberDto[] }' })
  async list(@CurrentUser() user: AuthedRequestUser) {
    return this.access.listMembers(requireClientId(user));
  }

  @Post()
  @ApiOperation({
    summary: 'Add one of this client\'s existing logins as a scoped seat (client-admin only)',
    description:
      'The client is taken from the caller\'s session, so this endpoint can only ever seat somebody in the caller\'s own account. `userId` must already be a login of this client.',
  })
  @ApiBody({ type: CreateMemberDto })
  @ApiResponse({ status: 201, description: 'The created (or reactivated) ClientMemberDto' })
  @ApiResponse({ status: 400, description: 'userId is not an existing client login belonging to this client' })
  @ApiResponse({ status: 403, description: 'Caller is not a client-admin seat' })
  async create(@CurrentUser() user: AuthedRequestUser, @Body() dto: CreateMemberDto) {
    const clientId = await requireClientAdmin(this.access, user);
    return this.access.createMember(clientId, dto, user.userId);
  }

  @Patch(':memberId')
  @ApiOperation({ summary: "Change one of this client's seats (client-admin only)" })
  @ApiBody({ type: UpdateMemberDto })
  @ApiResponse({ status: 200, description: 'The updated ClientMemberDto' })
  @ApiResponse({ status: 404, description: 'No such seat for this client' })
  async update(
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: UpdateMemberDto,
  ) {
    const clientId = await requireClientAdmin(this.access, user);
    return this.access.updateMember(clientId, memberId, dto);
  }

  @Delete(':memberId')
  @ApiOperation({ summary: "Revoke one of this client's seats (client-admin only)" })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 404, description: 'No such seat for this client' })
  async revoke(@Param('memberId') memberId: string, @CurrentUser() user: AuthedRequestUser) {
    const clientId = await requireClientAdmin(this.access, user);
    return this.access.revokeMember(clientId, memberId);
  }
}

// ── Client portal: invitations ──────────────────────────────────────────

@ApiTags('client-access: portal invites')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/invites')
export class ClientPortalInvitesController {
  constructor(private readonly access: ClientAccessService) {}

  @Get()
  @ApiOperation({ summary: "This client's own invitations, with derived status" })
  @ApiResponse({ status: 200, description: '{ invites: InviteDto[] }' })
  async list(@CurrentUser() user: AuthedRequestUser) {
    return this.access.listInvites(requireClientId(user));
  }

  @Post()
  @ApiOperation({
    summary: 'Invite a colleague to this client\'s portal (client-admin only)',
    description:
      'The invite is scoped to the caller\'s own client and to whatever seat role / project ids the caller chooses; the accept URL and one-time token are returned exactly once in this response.',
  })
  @ApiBody({ type: CreateInviteDto })
  @ApiResponse({ status: 201, description: 'InviteCreatedDto — includes the one-time token and acceptUrl' })
  @ApiResponse({ status: 403, description: 'Caller is not a client-admin seat' })
  @ApiResponse({ status: 409, description: 'That email already has a login (for this client or another account)' })
  async create(@CurrentUser() user: AuthedRequestUser, @Body() dto: CreateInviteDto) {
    const clientId = await requireClientAdmin(this.access, user);
    return this.access.createInvite(clientId, dto, user.userId);
  }

  @Delete(':inviteId')
  @ApiOperation({ summary: "Revoke one of this client's pending invitations (client-admin only)" })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 404, description: 'No such invite for this client' })
  @ApiResponse({ status: 409, description: 'The invite was already accepted — revoke the seat instead' })
  async revoke(@Param('inviteId') inviteId: string, @CurrentUser() user: AuthedRequestUser) {
    const clientId = await requireClientAdmin(this.access, user);
    return this.access.revokeInvite(clientId, inviteId);
  }
}

// ── Client portal: Google connections and delegations ───────────────────

/**
 * A client's own Google authorization, mapped onto their own project.
 *
 * A `GoogleConnection` is owned by exactly one `User` — operator or client, the
 * google module never checks which — so this surface lets a client authorize
 * their own Google account and map it to their own project, and lets a second
 * person read through it via a delegation *without ever holding its tokens*.
 * Every read here is proxied through the connection OWNER's stored grant.
 *
 * Two independent gates, both server-side:
 * 1. **This controller**: `clientId` from the JWT, the seat resolved, and the
 *    project checked against that seat's scope — so a collaborator scoped to
 *    project A cannot reach project B even within the same client.
 * 2. **The service**: mutations are ownership-bound. Only the connection owner
 *    may map a resource, disconnect, or grant a delegation; only the owner or
 *    the grantee may revoke one. No handler here passes a caller-supplied
 *    `userId` as an owner — the owner is always derived from the stored row.
 */
@ApiTags('client-access: portal google')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId/integrations/google')
export class ClientPortalGoogleController {
  constructor(
    private readonly access: ClientAccessService,
    private readonly google: GoogleDelegationService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Whether server-side Google OAuth credentials are configured',
    description:
      'When this is false nothing else on this surface can work — the UI must show the explicit unavailable state rather than an empty connected state.',
  })
  @ApiResponse({ status: 200, description: '{ configured: boolean }' })
  async status(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    await this.assertProjectInScope(user, projectId);
    return { configured: this.google.isConfigured() };
  }

  @Get('connections')
  @ApiOperation({
    summary: 'Per-service Google state for this project, from this caller\'s point of view',
    description:
      'One row per service (search-console, analytics) with `access` — "owner" (the caller authorized it), "delegated" (someone else did and granted the caller access), or "none". `connectionId` is null when no connection reaches this caller: that is the same situation as "none" and must never be rendered as connected-but-broken. Tokens are never returned; `ownerUserId` says whose grant it is.',
  })
  @ApiResponse({ status: 200, description: '{ connections: ScopedGoogleConnectionDto[] } — returned as an array' })
  @ApiResponse({ status: 403, description: 'This seat is not scoped to this project' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async connections(@Param('projectId') projectId: string, @CurrentUser() user: AuthedRequestUser) {
    await this.assertProjectInScope(user, projectId);
    return this.google.listConnections(user.userId, projectId);
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Begin OAuth consent for the caller's own Google account",
    description:
      'Returns the Google consent URL to open. The resulting connection is owned by the caller\'s own user id — the project id is carried only as context for the resource picker, it never scopes the grant to a project.',
  })
  @ApiBody({ type: GoogleAuthorizeDto })
  @ApiResponse({ status: 200, description: '{ url }' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async authorize(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: GoogleAuthorizeDto,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.authorize(user.userId, projectId, dto.service);
  }

  @Get('resources')
  @ApiOperation({
    summary: 'Sites / properties to map to this project, plus the current mapping',
    description:
      'The picker is only meaningful for the connection owner: a delegated grantee gets `readOnly: true` with the existing mapping and an empty options list, because they cannot browse or change what somebody else\'s account can see. An empty `options` with `connected: true` means the provider returned nothing — not that the mapping was cleared.',
  })
  @ApiResponse({ status: 200, description: '{ service, projectId, connected, options, selected, readOnly }' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async resources(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Query() query: GoogleResourceQueryDto,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.resources(user.userId, projectId, query.service);
  }

  @Put('resources')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Map a site or property to this project (connection owner only)',
    description:
      'resourceId must be one of the options returned by the resources list — the picker constrains it rather than accepting a free-typed id. A caller without their own connection for this service is refused with a conflict telling them to connect first, rather than silently mapping somebody else\'s grant.',
  })
  @ApiBody({ type: SetGoogleResourceDto })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 409, description: 'The caller has no Google connection of their own for this service' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async setResource(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: SetGoogleResourceDto,
  ) {
    await this.assertProjectInScope(user, projectId);
    await this.google.setResource(user.userId, projectId, dto.service, dto.resourceId, dto.resourceLabel ?? null);
    return { ok: true };
  }

  @Get('connections/:connectionId/impact')
  @ApiOperation({
    summary: 'What breaks if this connection is disconnected',
    description:
      'Reports the affected projects (which would go dark) and the other people holding a live delegation on this same grant. The response is restricted to the caller\'s own client\'s projects — and to their seat scope when the seat has one — so a connection that happens to serve projects of several clients never leaks another client\'s project ids or delegate list through this route.',
  })
  @ApiResponse({ status: 200, description: 'ConnectionImpactDto — { connectionId, service, ownerUserId, affectedProjects, affectedDelegates }' })
  @ApiResponse({ status: 404, description: 'Connection does not exist' })
  async impact(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    const membership = await this.assertProjectInScope(user, projectId);
    return this.google.impact(connectionId, await this.ownProjectIds(user, membership));
  }

  @Delete('connections/:service')
  @ApiOperation({
    summary: 'Disconnect the caller\'s own Google connection for this service',
    description:
      'Disconnecting cascades the project-resource mappings and revokes every live delegation on that connection. The response is the impact — the honest list of what just went dark — so the caller sees the consequence rather than a bare ok. Returns null when the caller has no connection for this service.',
  })
  @ApiResponse({ status: 200, description: 'ConnectionImpactDto | null' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async disconnect(
    @Param('projectId') projectId: string,
    @Param('service') service: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.disconnect(user.userId, googleService(service));
  }

  @Get('test-read')
  @ApiOperation({
    summary: 'Read this project\'s Google data to prove the mapping works',
    description:
      'A proxied read: the resource mapped to this project is resolved server-side, the caller must be the connection owner or hold a live delegation on this exact connection + project, and the read then runs with the OWNER\'s stored token — the caller never sees or receives a token. A failed read is reported as a failure; it is never rendered as zeros. `days` is the rolling window (1-90, default 28).',
  })
  @ApiResponse({ status: 200, description: 'SearchConsoleSummary | AnalyticsSummary' })
  @ApiResponse({ status: 403, description: 'No live delegation for this caller on this project\'s connection' })
  @ApiResponse({ status: 404, description: 'No Google resource of this service is mapped to this project yet' })
  async testRead(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Query('service') service: string | undefined,
    @Query('days') days: string | undefined,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.proxiedSummary(user.userId, projectId, googleService(service), parseDays(days));
  }

  @Get('connections/:connectionId/delegations')
  @ApiOperation({
    summary: 'Everyone holding a delegation on this connection (including revoked rows)',
    description:
      'A revoked delegation is returned with `revokedAt` set rather than being hidden, so the history of who had access and when it ended stays visible.',
  })
  @ApiResponse({ status: 200, description: 'DelegationDto[] — returned as an array' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async delegations(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.listDelegationsForConnection(connectionId);
  }

  @Post('connections/:connectionId/delegations')
  @ApiOperation({
    summary: 'Grant someone access to this project\'s Google data (connection owner only)',
    description:
      'Only the connection owner decides who reuses their authorized data — never self-service by the would-be grantee. The connection must already be mapped to this project, and the owner cannot delegate to themselves. Re-granting an existing or previously revoked delegation reactivates it in place with the new access level.',
  })
  @ApiBody({ type: CreateDelegationDto })
  @ApiResponse({ status: 201, description: 'The created or reactivated DelegationDto' })
  @ApiResponse({ status: 400, description: 'Connection is not mapped to this project, or the grantee id does not exist' })
  @ApiResponse({ status: 403, description: 'Caller is not the owner of this connection' })
  async grantDelegation(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateDelegationDto,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.grantDelegation(
      connectionId,
      projectId,
      dto.granteeUserId,
      dto.accessLevel ?? 'read',
      user.userId,
    );
  }

  @Delete('connections/:connectionId/delegations/:granteeUserId')
  @ApiOperation({
    summary: 'Revoke a delegation — by its owner or by the grantee themselves',
    description:
      'A grantee can hand back access they no longer need without waiting on the owner. Revocation is a timestamp, not a delete, so the grant history survives.',
  })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 403, description: 'Caller is neither the connection owner nor the grantee' })
  @ApiResponse({ status: 404, description: 'Connection does not exist' })
  async revokeDelegation(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @Param('granteeUserId') granteeUserId: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    await this.assertProjectInScope(user, projectId);
    return this.google.revokeDelegation(connectionId, projectId, granteeUserId, user.userId);
  }

  /**
   * Resolves this caller's seat and asserts the project is one it may act on.
   * `requireProjectInScope` returns 404 for a project of another client and 403
   * for one outside a scoped seat, so a collaborator cannot reach a sibling
   * project by id. Runs before every handler on this surface.
   */
  private async assertProjectInScope(
    user: AuthedRequestUser,
    projectId: string,
  ): Promise<ResolvedMembership> {
    const membership = await this.access.resolveMembership(requireClientId(user), user.userId);
    await this.access.requireProjectInScope(membership, projectId);
    return membership;
  }

  /**
   * The projects whose mappings this caller may be shown: this client's own
   * projects, narrowed to the seat's scope when the seat has one. Handed to
   * `impact()` so a connection serving several clients cannot leak their ids
   * (or their delegates) into this client's view.
   */
  private async ownProjectIds(
    user: AuthedRequestUser,
    membership: ResolvedMembership,
  ): Promise<string[]> {
    const own = (await this.scope.getAccessibleProjectIds(user)) ?? [];
    if (membership.projectIds.length === 0) return own;
    return own.filter((id) => membership.projectIds.includes(id));
  }
}
