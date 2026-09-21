/**
 * Clients Controller — operator/admin REST API.
 *
 * @module clients.controller
 */

import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ClientsService } from './clients.service';
import {
  CreateClientDto,
  UpdateClientDto,
  CreateClientProjectDto,
  CreateClientLoginDto,
  PostClientMessageDto,
  WaiveOnboardingWizardDto,
  SuspendClientDto,
  ReactivateClientDto,
  TransferOwnershipDto,
} from './dto/clients.dto';

@ApiTags('Clients')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @ApiOperation({ summary: 'List clients with a progress overview (score, band, open gaps, onboarding state)' })
  @ApiResponse({ status: 200, description: '{ clients: ClientOverviewDto[] }' })
  async list() {
    return this.clients.listClients();
  }

  @Post()
  @Roles('delivery-lead')
  @ApiOperation({ summary: 'Create a client' })
  @ApiBody({ type: CreateClientDto })
  @ApiResponse({ status: 201, description: 'The created client' })
  async create(@Body() body: CreateClientDto) {
    return this.clients.createClient(body);
  }

  @Get(':clientId')
  @ApiOperation({ summary: 'Get a client with its projects (status, score/band, onboarding progress)' })
  @ApiResponse({ status: 200, description: 'The client detail' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async get(@Param('clientId') clientId: string) {
    return this.clients.getClient(clientId);
  }

  @Patch(':clientId')
  @Roles('delivery-lead')
  @ApiOperation({ summary: 'Update a client (name, contact, status, owner, notes)' })
  @ApiBody({ type: UpdateClientDto })
  @ApiResponse({ status: 200, description: 'The updated client' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async update(@Param('clientId') clientId: string, @Body() body: UpdateClientDto) {
    return this.clients.updateClient(clientId, body);
  }

  @Post(':clientId/suspend')
  @Roles('admin')
  @ApiOperation({
    summary: 'Suspend a client (admin only)',
    description:
      'C5 (docs/analysis/client-portal.md §5/§23/§30). Sets status to "suspended" and immediately revokes every Google connection reachable through any of this client\'s projects — a real revoke at Google, not just "stop calling". Writes an audit event (GET /api/activity, action "suspended"). Also used by the payment-failure grace-period sweep as the "system" actor.',
  })
  @ApiBody({ type: SuspendClientDto })
  @ApiResponse({ status: 200, description: 'The suspended client plus which Google connections were revoked' })
  @ApiResponse({ status: 403, description: 'Caller is not admin' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async suspend(@Param('clientId') clientId: string, @Body() body: SuspendClientDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.clients.suspendClient(clientId, { type: 'user', id: user.userId }, body.reason);
  }

  @Post(':clientId/reactivate')
  @Roles('admin')
  @ApiOperation({
    summary: 'Reactivate a suspended client (admin only)',
    description:
      'C5 (docs/analysis/client-portal.md §5/§23). Sets status back to "active". Does NOT restore Google access — the client reconnects each project\'s GSC/GA4 from scratch (accepted tradeoff, §23). Writes an audit event (action "reactivated").',
  })
  @ApiBody({ type: ReactivateClientDto })
  @ApiResponse({ status: 200, description: 'The reactivated client' })
  @ApiResponse({ status: 403, description: 'Caller is not admin' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async reactivate(@Param('clientId') clientId: string, @Body() body: ReactivateClientDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.clients.reactivateClient(clientId, user.userId, body.reason);
  }

  @Post(':clientId/transfer-ownership')
  @Roles('admin')
  @ApiOperation({
    summary: "Reassign this client's primary contact (admin only)",
    description:
      'C5 (docs/analysis/client-portal.md §32). Human-mediated admin action — either names an existing client seat (memberId, whose user becomes the new primary contact) or supplies contactName/contactEmail directly. Writes an audit event (action "ownership-transferred").',
  })
  @ApiBody({ type: TransferOwnershipDto })
  @ApiResponse({ status: 200, description: 'The updated client' })
  @ApiResponse({ status: 403, description: 'Caller is not admin' })
  @ApiResponse({ status: 404, description: 'Client not found, or memberId does not belong to this client' })
  @ApiResponse({ status: 409, description: 'Neither memberId nor contactName/contactEmail was supplied' })
  async transferOwnership(@Param('clientId') clientId: string, @Body() body: TransferOwnershipDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.clients.transferOwnership(clientId, user.userId, body);
  }

  /**
   * "Add client -> run the pipeline" — creates a Project under this client
   * and starts the Day-1 pipeline (technical-audit -> digital-presence ->
   * tech-stack -> competitors -> gap-analysis -> strategy -> report) in the
   * background. Returns immediately; poll GET .../projects/:projectId (via
   * GET /clients/:clientId, which lists every project with its current
   * onboardingStatus/onboardingStep) for progress.
   */
  @Post(':clientId/projects')
  @Roles('delivery-lead')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Add a project for this client and run the Day-1 pipeline',
    description:
      'Creates the project and starts the full audit-to-report pipeline in the background. Returns immediately with onboardingStatus "running" — poll GET /clients/:clientId for progress.',
  })
  @ApiBody({ type: CreateClientProjectDto })
  @ApiResponse({ status: 201, description: 'The created project (onboardingStatus: "running")' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 409, description: 'A project for this domain already exists' })
  async createProject(@Param('clientId') clientId: string, @Body() body: CreateClientProjectDto) {
    return this.clients.createProject(clientId, body);
  }

  @Get(':clientId/projects/:projectId/onboarding-wizard')
  @ApiOperation({
    summary: "A project's onboarding-wizard gate state",
    description:
      'C1 (docs/analysis/client-portal.md §16). One of not-started | confirming-details | connecting-gsc | connecting-ga4 | done | waived. The wizard UI that transitions through these states is Phase C2 — this route only reads the current state.',
  })
  @ApiResponse({ status: 200, description: '{ projectId, state }' })
  @ApiResponse({ status: 404, description: 'Client not found, or project does not belong to this client' })
  async getOnboardingWizardState(@Param('clientId') clientId: string, @Param('projectId') projectId: string) {
    return this.clients.getOnboardingWizardState(clientId, projectId);
  }

  @Post(':clientId/projects/:projectId/onboarding-wizard/waive')
  @Roles('admin')
  @ApiOperation({
    summary: 'Waive the Google-connect onboarding gate for this project (admin only)',
    description:
      'C1 (docs/analysis/client-portal.md §15). Sets the onboarding-wizard state straight to "waived" — a real, visibly distinct terminal state, never silently rendered as "done" — and writes an audit event (GET /api/activity, action "waived") recording who waived it, when, and for which client/project. Use when a client cannot complete Google Search Console/Analytics access on day one (agency handoff pending, IT ticket open) so they are not permanently locked out of a portal they are paying for.',
  })
  @ApiBody({ type: WaiveOnboardingWizardDto })
  @ApiResponse({ status: 200, description: 'The updated ClientProjectSummaryDto, onboardingWizardState: "waived"' })
  @ApiResponse({ status: 403, description: 'Caller is not admin' })
  @ApiResponse({ status: 404, description: 'Client not found, or project does not belong to this client' })
  async waiveOnboardingWizard(
    @Param('clientId') clientId: string,
    @Param('projectId') projectId: string,
    @Body() body: WaiveOnboardingWizardDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthedRequestUser;
    return this.clients.waiveOnboardingWizard(clientId, projectId, user.userId, body.reason);
  }

  /**
   * @deprecated Superseded by `POST /clients/:clientId/invites` (`client-access`
   * module) per `docs/analysis/client-portal.md` §2 and `docs/PLAN.md` §11.0
   * (Stage-1 cleanup, 2026-09-20). The invite-link flow is now canonical: a
   * single-use 7-day link where the client sets their own password, instead of
   * a plaintext temporary password generated server-side and relayed by hand
   * (over email or by an operator copy/pasting it — real exposure). This
   * endpoint is kept, not removed — it still works, for the rare escape-hatch
   * case where the invite-link flow cannot be used — but it must not be treated
   * as a live parallel path: new integrations, UI, and automation (e.g. the
   * Phase-C2 auto-email-on-pipeline-completion work) must call
   * `POST /clients/:clientId/invites` instead. See `ClientsService.createClientLogin`
   * for the same note on the implementation.
   */
  @Post(':clientId/login')
  @Roles('delivery-lead')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: '[Deprecated] Create a client-portal login for this client (temp password)',
    description:
      'DEPRECATED — use POST /clients/:clientId/invites instead (invite-link, client sets their own password). Kept as a non-default escape hatch, not removed. Generates a temporary password, creates a type="client" User row, and best-effort emails it via Plunk. The password is returned exactly once in the response — relay it by hand if emailSent is false.',
  })
  @ApiBody({ type: CreateClientLoginDto })
  @ApiResponse({ status: 201, description: 'The created login, including the one-time temporary password' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async createLogin(@Param('clientId') clientId: string, @Body() body: CreateClientLoginDto) {
    return this.clients.createClientLogin(clientId, body);
  }

  @Get(':clientId/messages')
  @ApiOperation({ summary: 'List the message thread with this client' })
  @ApiResponse({ status: 200, description: '{ messages: ClientMessageDto[] }' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async listMessages(@Param('clientId') clientId: string) {
    return this.clients.listMessages(clientId);
  }

  @Post(':clientId/messages')
  @ApiOperation({
    summary: 'Post a message to this client (visible to them in the client portal)',
    description:
      'Author type is set server-side to `operator` — it is never taken from the request. A supplied `projectId` must belong to THIS client; a project id owned by anyone else is rejected with 403, the same rule the client-portal write applies.',
  })
  @ApiBody({ type: PostClientMessageDto })
  @ApiResponse({ status: 201, description: 'The posted message' })
  @ApiResponse({ status: 403, description: 'The supplied projectId does not belong to this client' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async postMessage(@Param('clientId') clientId: string, @Body() body: PostClientMessageDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.clients.postMessage(clientId, user.userId, body);
  }
}
