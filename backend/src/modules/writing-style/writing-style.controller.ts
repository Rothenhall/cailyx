/**
 * Writing Style Controller — P09 (§13.8). Staff can draft/confirm; client
 * gets read-only access to the active confirmed style (D04 "decision
 * requiring confirmation" per §22 — no evidence a prior phase settled
 * client-edit rights, so this defaults to the conservative staff-edit /
 * client-view-only split, same as most of the client portal).
 *
 * @module writing-style.controller
 */

import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { WritingStyleService } from './writing-style.service';
import { ConfirmWritingStyleDto, SaveWritingStyleDraftDto } from './dto/writing-style.dto';

const CONTENT_EDITOR_ROLES = ['admin', 'delivery-lead', 'content'] as const;

@ApiTags('Writing Style')
@Controller('projects/:projectId/writing-style')
export class WritingStyleController {
  constructor(private readonly writingStyle: WritingStyleService) {}

  @Get()
  @ApiOperation({ summary: 'Active confirmed style, or null if none confirmed yet (§13.8)' })
  async getActive(@Param('projectId') projectId: string) {
    return this.writingStyle.getActive(projectId);
  }

  @Get('versions')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'All draft/confirmed versions — confirming never mutates a prior confirmed row' })
  async versions(@Param('projectId') projectId: string) {
    return this.writingStyle.listVersions(projectId);
  }

  @Get('suggestions')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'PresenceBrandVoice read-only extracted suggestions, shown separately from the confirmed style' })
  async suggestions(@Param('projectId') projectId: string) {
    return this.writingStyle.getSuggestions(projectId);
  }

  @Post('draft')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'Save a new draft version (staff-edit only)' })
  @ApiBody({ type: SaveWritingStyleDraftDto })
  async saveDraft(@Param('projectId') projectId: string, @Body() body: SaveWritingStyleDraftDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser | undefined;
    return this.writingStyle.saveDraft(projectId, body, user?.userId);
  }

  @Post('confirm')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({ summary: 'Confirm a draft — inserts a new confirmed row, never mutates the draft' })
  @ApiBody({ type: ConfirmWritingStyleDto })
  async confirm(@Param('projectId') projectId: string, @Body() body: ConfirmWritingStyleDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser | undefined;
    return this.writingStyle.confirm(projectId, body.version, user?.userId ?? 'unknown');
  }
}
