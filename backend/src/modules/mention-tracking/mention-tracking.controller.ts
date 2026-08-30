/**
 * Mention Tracking Controller — REST surface for SOP-7 (FR-4.4).
 *
 * @module mention-tracking.controller
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MentionTrackingService } from './mention-tracking.service';
import {
  CheckTargetDto,
  CreateCampaignDto,
  CreateTargetDto,
  DecayQueryDto,
  ListTargetsQueryDto,
  UpdateTargetDto,
} from './dto/mention-tracking.dto';

@ApiTags('Mention Tracking')
@Controller('projects/:projectId/mentions')
export class MentionTrackingController {
  constructor(private readonly mentions: MentionTrackingService) {}

  // ─── Campaigns ───────────────────────────────────────────────

  @Post('campaigns')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an outreach campaign', description: 'Groups targets, optionally anchored to a "best X" hunt query (SOP-7).' })
  async createCampaign(@Param('projectId') projectId: string, @Body() body: CreateCampaignDto) {
    return this.mentions.createCampaign(projectId, body.name, body.listicleQuery);
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'List campaigns (with target counts)' })
  async listCampaigns(@Param('projectId') projectId: string) {
    return this.mentions.listCampaigns(projectId);
  }

  // ─── Targets ─────────────────────────────────────────────────

  @Post('targets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a mention target', description: 'Manual entry of a candidate page (listicle omitting the client, community thread, review platform). Semi-auto checks are a separate single-fetch call.' })
  @ApiResponse({ status: 201, description: 'Target created' })
  @ApiResponse({ status: 400, description: 'Invalid URL or type' })
  async createTarget(@Param('projectId') projectId: string, @Body() body: CreateTargetDto) {
    return this.mentions.createTarget(projectId, body.url, body.type ?? 'listicle', body.label, body.campaignId, body.notes);
  }

  @Get('targets')
  @ApiOperation({ summary: 'List targets (with latest check)', description: 'Filterable by outreach status; each target carries its latest MentionCheck.' })
  async listTargets(@Param('projectId') projectId: string, @Query() query: ListTargetsQueryDto) {
    return this.mentions.listTargets(projectId, query.status);
  }

  @Patch('targets/:targetId')
  @ApiOperation({ summary: 'Update a target (label / status / notes)' })
  async updateTarget(@Param('projectId') projectId: string, @Param('targetId') targetId: string, @Body() body: UpdateTargetDto) {
    return this.mentions.updateTarget(projectId, targetId, body);
  }

  @Delete('targets/:targetId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a target (checks cascade)' })
  async deleteTarget(@Param('projectId') projectId: string, @Param('targetId') targetId: string) {
    return this.mentions.deleteTarget(projectId, targetId);
  }

  // ─── Checks ──────────────────────────────────────────────────

  /** One semi-auto check: single fetch of the target page looking for the brand. */
  @Post('targets/:targetId/check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Run a semi-auto mention check', description: 'Fetches the target page once (low-ToS single fetch, fetcher-cached) and records whether the brand appears, with a ±60-char evidence excerpt. Appends to the check ledger (decay source).' })
  @ApiBody({ type: CheckTargetDto })
  async checkTarget(@Param('projectId') projectId: string, @Param('targetId') targetId: string, @Body() body: CheckTargetDto) {
    return this.mentions.checkTarget(projectId, targetId, body.brandToken);
  }

  @Get('targets/:targetId/checks')
  @ApiOperation({ summary: 'Check history for a target (newest first)' })
  async listChecks(@Param('projectId') projectId: string, @Param('targetId') targetId: string) {
    return this.mentions.listChecks(projectId, targetId);
  }

  /** Decay view (SOP-7): last-mentioned ages across all targets. */
  @Get('decay')
  @ApiOperation({ summary: 'Mention decay view', description: 'Per target: everMentioned, lastMentionedAt, daysSinceLastMention, and stale (≥90 days). Only checks whose evidence actually contains the brand token count as mentions.' })
  @ApiResponse({ status: 200, description: 'Decay rows per target' })
  async decay(@Param('projectId') projectId: string, @Query() query: DecayQueryDto) {
    return this.mentions.decayView(projectId, query.brandToken);
  }
}