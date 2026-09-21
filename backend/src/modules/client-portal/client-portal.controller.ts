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
import { CreatePromptRequestDto } from '../prompt-requests/dto/prompt-requests.dto';
import { CreateContentRequestDto } from '../content-requests/dto/content-requests.dto';

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

  @Get('projects/:projectId/prompts')
  @ApiOperation({ summary: "This client's active query-set prompts, read-only (§3/§13) — the real prompts measurement runs, not a summary" })
  @ApiResponse({ status: 200, description: '{ sets: QuerySetDto[] }' })
  @ApiResponse({ status: 403, description: 'projectId does not belong to this client' })
  async listPrompts(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.listPrompts(this.clientId(req), projectId);
  }

  @Get('projects/:projectId/prompt-requests')
  @ApiOperation({ summary: "This client's own prompt add/delete requests and their status (§13)" })
  @ApiResponse({ status: 200, description: '{ requests: PromptRequestDto[] }' })
  async listPromptRequests(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.listPromptRequests(this.clientId(req), projectId);
  }

  @Post('projects/:projectId/prompt-requests')
  @ApiOperation({
    summary: 'Propose a new prompt or flag an existing one for removal (§13)',
    description:
      'Lightweight request queue only — never edits the QuerySet directly. Carries a §20 quota snapshot; overQuota is a flag for the admin, never a rejection.',
  })
  @ApiBody({ type: CreatePromptRequestDto })
  @ApiResponse({ status: 201, description: 'The created prompt request' })
  @ApiResponse({ status: 403, description: 'projectId does not belong to this client' })
  async createPromptRequest(
    @Param('projectId') projectId: string,
    @Body() body: CreatePromptRequestDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthedRequestUser;
    return this.portal.createPromptRequest(this.clientId(req), projectId, user.userId, {
      action: body.action,
      prompt: body.prompt,
      persona: body.persona,
      targetItemId: body.targetItemId,
      note: body.note,
    });
  }

  @Get('projects/:projectId/content-requests')
  @ApiOperation({ summary: "This client's own structured content requests (§14/§22)" })
  @ApiResponse({ status: 200, description: '{ requests: ContentRequestDto[] }' })
  async listContentRequests(@Param('projectId') projectId: string, @Req() req: Request) {
    return this.portal.listContentRequests(this.clientId(req), projectId);
  }

  @Post('projects/:projectId/content-requests')
  @ApiOperation({
    summary: 'Request new content via the structured form (§14/§22)',
    description: 'Creates a real content-workspace item immediately, tagged client-originated — no separate triage inbox.',
  })
  @ApiBody({ type: CreateContentRequestDto })
  @ApiResponse({ status: 201, description: 'The created content request, linked to its new content-workspace item' })
  @ApiResponse({ status: 403, description: 'projectId does not belong to this client' })
  async createContentRequest(
    @Param('projectId') projectId: string,
    @Body() body: CreateContentRequestDto,
    @Req() req: Request,
  ) {
    const user = req.user as AuthedRequestUser;
    return this.portal.createContentRequest(this.clientId(req), projectId, user.userId, {
      contentType: body.contentType,
      topic: body.topic,
      priority: body.priority,
      note: body.note,
    });
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
