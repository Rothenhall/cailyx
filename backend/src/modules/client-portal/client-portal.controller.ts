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
  constructor(private readonly portal: ClientPortalService) {}

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
