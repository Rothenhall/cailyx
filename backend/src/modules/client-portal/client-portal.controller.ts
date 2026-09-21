import { AuthService } from '../auth/auth.service';
/**
 * Client Portal Controller — client-facing REST API.
 *
 * Every route is @ClientPortal() — accessible ONLY to a type="client" User,
 * and ONLY these routes (RolesGuard rejects a client-type user from every
 * other route in the system by default; see common/guards/roles.guard.ts).
 *
 * @module client-portal.controller
 */

import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ClientPortalService } from './client-portal.service';
import { PostPortalMessageDto } from './dto/client-portal.dto';

@ApiTags('Client Portal')
@Controller('portal')
@ClientPortal()
export class ClientPortalController {
  constructor(
    private readonly portal: ClientPortalService,
    private readonly auth: AuthService,
  ) {}

  /**
   * The signed-in client's own identity.
   *
   * `AuthService.getPortalMe` has existed since G01, but no route exposed it,
   * so this path 404'd. That mattered: the web client shell calls it to
   * establish the session, and a 404 read as "not signed in" — a properly
   * authenticated client saw a signed-out account menu.
   *
   * Not `GET /auth/me`: that route is operator-only by design (it serves
   * `SafeUserDto` with a `role`, which a client has no meaningful value for).
   */
  @Get('me')
  @ApiOperation({ summary: "This client login's own profile" })
  @ApiResponse({ status: 200, description: 'PortalMeDto — always carries its Client; never carries a role' })
  @ApiResponse({ status: 403, description: 'Reached by an operator account' })
  async me(@Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.auth.getPortalMe(user.userId);
  }

  @Get('projects')
  @ApiOperation({ summary: "This client's own projects, with status/score/band" })
  @ApiResponse({ status: 200, description: '{ projects: PortalProjectDto[] }' })
  async listProjects(@Req() req: Request) {
    return this.portal.listProjects(this.clientId(req));
  }

  @Get('reports')
  @ApiOperation({ summary: "This client's own reports, across all their projects" })
  @ApiResponse({ status: 200, description: '{ reports: PortalReportSummaryDto[] }' })
  async listReports(@Req() req: Request) {
    return this.portal.listReports(this.clientId(req));
  }

  @Get('reports/:slug')
  @ApiOperation({ summary: 'The full report by slug — 404 if it does not belong to this client' })
  @ApiResponse({ status: 200, description: 'Full ReportData' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different client' })
  async getReport(@Param('slug') slug: string, @Req() req: Request) {
    return this.portal.getReport(this.clientId(req), slug);
  }

  // ─── C2 onboarding wizard (docs/analysis/client-portal.md §2/§11/§16/§17)
  // — the project-scoped gate state and its three step-transition endpoints.
  // Order: confirm details -> (report + rest of portal already reachable) ->
  // connect GSC -> connect GA4 -> done. The gate itself lives in the web
  // client's project layout, not here.

  @Get('projects/:projectId/onboarding-wizard')
  @ApiOperation({ summary: "This project's onboarding-wizard gate state (not-started | confirming-details | connecting-gsc | connecting-ga4 | done | waived)" })
  @ApiResponse({ status: 200, description: '{ projectId, state }' })
  @ApiResponse({ status: 403, description: 'projectId does not belong to this client' })
  async getOnboardingWizardState(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.getOnboardingWizardState(this.clientId(req), projectId);
  }

  @Post('projects/:projectId/onboarding-wizard/confirm-details')
  @ApiOperation({
    summary: 'Wizard step (a): advance past confirm/edit details',
    description:
      'Requires a confirmed business-profile version to already exist (POST .../business-profile/confirm). Advances the gate to "connecting-gsc" — at which point the report and the rest of the portal are already reachable (§2 corrected order); this call does not itself write any business-profile fields.',
  })
  @ApiResponse({ status: 200, description: '{ projectId, state: "connecting-gsc" }' })
  @ApiResponse({ status: 409, description: 'Wrong state, or no confirmed profile on file yet' })
  async confirmDetailsStep(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.confirmDetailsStep(this.clientId(req), projectId);
  }

  @Post('projects/:projectId/onboarding-wizard/connect-gsc-done')
  @ApiOperation({
    summary: 'Wizard step (b): advance past connecting Google Search Console',
    description: 'Gated on a real, live project-mapped GSC connection already existing (not merely "the client clicked next"). Advances to "connecting-ga4".',
  })
  @ApiResponse({ status: 200, description: '{ projectId, state: "connecting-ga4" }' })
  @ApiResponse({ status: 409, description: 'Wrong state, or GSC not actually connected yet' })
  async connectGscDoneStep(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.connectGscDoneStep(this.clientId(req), projectId);
  }

  @Post('projects/:projectId/onboarding-wizard/connect-ga4-done')
  @ApiOperation({
    summary: 'Wizard step (c): advance past connecting Google Analytics 4 — the terminal step into "done"',
    description: 'Gated the same way as GSC. This is the last transition — the wizard is complete once this succeeds.',
  })
  @ApiResponse({ status: 200, description: '{ projectId, state: "done" }' })
  @ApiResponse({ status: 409, description: 'Wrong state, or GA4 not actually connected yet' })
  async connectGa4DoneStep(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.connectGa4DoneStep(this.clientId(req), projectId);
  }

  @Get('projects/:projectId/content')
  @ApiOperation({ summary: 'This client\'s shared content for one project — only pieces with an explicitly shared revision (§13.5)' })
  @ApiResponse({ status: 200, description: '{ items }' })
  @ApiResponse({ status: 403, description: 'projectId does not belong to this client' })
  async listContent(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.listContent(this.clientId(req), projectId);
  }

  @Get('projects/:projectId/content/:assetId')
  @ApiOperation({ summary: 'One shared content piece — the explicitly shared revision only, never the latest internal draft' })
  @ApiResponse({ status: 404, description: 'Not found, wrong project, or never shared with this client' })
  async getContent(@Param('projectId') projectId: string, @Param('assetId') assetId: string, @Req() req: Request) {
    return this.portal.getContent(this.clientId(req), projectId, assetId);
  }

  @Get('projects/:projectId/writing-style')
  @ApiOperation({ summary: 'This client\'s active confirmed writing style, read-only (§13.8)' })
  @ApiResponse({ status: 403, description: 'projectId does not belong to this client' })
  async getWritingStyle(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.getWritingStyle(this.clientId(req), projectId);
  }

  @Get('messages')
  @ApiOperation({ summary: 'This client\'s message thread with the operator' })
  @ApiResponse({ status: 200, description: '{ messages: PortalMessageDto[] }' })
  async listMessages(@Req() req: Request) {
    return this.portal.listMessages(this.clientId(req));
  }

  @Post('messages')
  @ApiOperation({ summary: 'Post a message to the operator' })
  @ApiBody({ type: PostPortalMessageDto })
  @ApiResponse({ status: 201, description: 'The posted message' })
  @ApiResponse({ status: 403, description: 'projectId given does not belong to this client' })
  async postMessage(@Body() body: PostPortalMessageDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.portal.postMessage(this.clientId(req), user.userId, body);
  }

  private clientId(req: Request): string {
    const user = req.user as AuthedRequestUser;
    // Structurally guaranteed by RolesGuard (only a type="client" user with a
    // clientId ever reaches a @ClientPortal() route) — checked again here
    // defensively rather than trusted blindly two layers away.
    if (!user.clientId) throw new Error('Client-portal route reached by a user with no clientId — this is a guard bug, not a client error.');
    return user.clientId;
  }
}
