/**
 * Journey Controller — REST API for branching search journeys (Agent #2).
 *
 * Journeys (nested under the owning project):
 *   GET    /api/projects/:projectId/journeys                    — list (?status=)
 *   POST   /api/projects/:projectId/journeys/plan               — plan one for a persona
 *   GET    /api/projects/:projectId/journeys/:journeyId         — detail (+ step tree)
 *   POST   /api/projects/:projectId/journeys/:journeyId/execute — run pending steps
 *   DELETE /api/projects/:projectId/journeys/:journeyId         — delete
 *
 * Campaigns (fan-out under one budget):
 *   GET    /api/projects/:projectId/journey-campaigns                     — list
 *   POST   /api/projects/:projectId/journey-campaigns                     — create (+ auto-run)
 *   GET    /api/projects/:projectId/journey-campaigns/:campaignId         — detail
 *   POST   /api/projects/:projectId/journey-campaigns/:campaignId/execute — run remaining journeys
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module journey.controller
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JourneyService } from './journey.service';
import { PlanJourneyDto, CreateCampaignDto } from './dto/journey.dto';
import type { CreateCampaignInput, JourneySurface, PlanJourneyInput } from './journey.types';

@ApiTags('Journey')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId')
export class JourneyController {
  constructor(private readonly journeyService: JourneyService) {}

  // ─── journeys ──────────────────────────────────────────────

  @Get('journeys')
  @ApiOperation({ summary: 'List journeys for a project' })
  @ApiQuery({ name: 'status', required: false, enum: ['planned', 'running', 'completed', 'partial', 'failed'] })
  @ApiResponse({ status: 200, description: 'Array of journeys (no step bodies)' })
  async list(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.journeyService.listJourneys(projectId, status);
  }

  @Get('journeys/suggestions')
  @ApiOperation({
    summary: 'Buyer-query suggestion wheel',
    description:
      'A deterministic set of buyer search queries grouped by awareness stage (problem → solution → ' +
      'product → most aware), built from planner templates + the project\'s personas + queries real ' +
      'journeys produced. Feeds the Flywheel card. No LLM, no spend.',
  })
  @ApiResponse({ status: 200, description: '{ hub, spokes[], total }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async suggestions(@Param('projectId') projectId: string) {
    return this.journeyService.suggestionWheel(projectId);
  }

  @Post('journeys/plan')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Plan a branching journey for a persona',
    description:
      'Deterministic planner by default (seeded by the persona). `useLlm: true` swaps in one ' +
      'LLM-planned tree of the same shape (needs ANTHROPIC_API_KEY). Nothing is executed here.',
  })
  @ApiBody({ type: PlanJourneyDto })
  @ApiResponse({ status: 201, description: 'Journey + step tree (status = planned)' })
  @ApiResponse({ status: 404, description: 'Project or persona not found' })
  @ApiResponse({ status: 503, description: 'useLlm requested without ANTHROPIC_API_KEY' })
  async plan(@Param('projectId') projectId: string, @Body() body: PlanJourneyDto) {
    const input: PlanJourneyInput = {
      personaId: body.personaId,
      surface: body.surface as JourneySurface | undefined,
      geo: body.geo,
      maxDepth: body.maxDepth,
      maxBranches: body.maxBranches,
      useLlm: body.useLlm,
    };
    return this.journeyService.planJourney(projectId, input);
  }

  @Get('journeys/:journeyId')
  @ApiOperation({ summary: 'Get a journey with its full step tree' })
  @ApiResponse({ status: 200, description: 'Journey + ordered steps' })
  @ApiResponse({ status: 404, description: 'Journey not found' })
  async getOne(@Param('journeyId') journeyId: string) {
    return this.journeyService.getJourney(journeyId);
  }

  @Post('journeys/:journeyId/execute')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Execute a planned journey',
    description:
      'Walks pending steps against the journey\'s surface adapter, scoring each answer for ' +
      'subject/competitor presence. Stops at the cost cap (`maxCostUsd` override, else ' +
      'JOURNEY_MAX_COST_PER_RUN) — remaining steps → skipped, journey → partial. Live surfaces ' +
      'require SWARM_ALLOW_LIVE=1 + the surface key.',
  })
  @ApiQuery({ name: 'maxCostUsd', required: false, description: 'Override this run\'s USD cap (0 = stop before any spend)' })
  @ApiResponse({ status: 200, description: 'Execution rollup' })
  @ApiResponse({ status: 404, description: 'Journey not found' })
  @ApiResponse({ status: 409, description: 'Journey already running/completed' })
  @ApiResponse({ status: 503, description: 'Live surface blocked (SWARM_ALLOW_LIVE / key)' })
  async execute(@Param('journeyId') journeyId: string, @Query('maxCostUsd') maxCostUsd?: string) {
    const cap = maxCostUsd !== undefined && maxCostUsd !== '' ? Number(maxCostUsd) : undefined;
    return this.journeyService.executeJourney(journeyId, cap);
  }

  @Delete('journeys/:journeyId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a journey' })
  @ApiResponse({ status: 200, description: '{ removed: journeyId }' })
  @ApiResponse({ status: 404, description: 'Journey not found' })
  async remove(@Param('journeyId') journeyId: string) {
    return this.journeyService.deleteJourney(journeyId);
  }

  // ─── campaigns ─────────────────────────────────────────────

  @Get('journey-campaigns')
  @ApiOperation({ summary: 'List journey campaigns for a project' })
  @ApiResponse({ status: 200, description: 'Array of campaigns' })
  async listCampaigns(@Param('projectId') projectId: string) {
    return this.journeyService.listCampaigns(projectId);
  }

  @Post('journey-campaigns')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Create a journey campaign (fan-out under one budget)',
    description:
      'Plans one journey per matching active persona (up to journeyTarget). With autoRun (default) ' +
      'it executes them in order, halting the instant cumulative spend reaches budgetUsd. This is ' +
      'the single knob that bounds a large swarm run.',
  })
  @ApiBody({ type: CreateCampaignDto })
  @ApiResponse({ status: 201, description: 'Campaign with its journeys' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'No active personas match the filter' })
  @ApiResponse({ status: 503, description: 'Live surface blocked, or useLlm without key' })
  async createCampaign(@Param('projectId') projectId: string, @Body() body: CreateCampaignDto) {
    const input: CreateCampaignInput = {
      name: body.name,
      surface: body.surface as JourneySurface | undefined,
      geo: body.geo,
      journeyTarget: body.journeyTarget,
      maxDepth: body.maxDepth,
      maxBranches: body.maxBranches,
      personaRoles: body.personaRoles,
      budgetUsd: body.budgetUsd,
      useLlm: body.useLlm,
      autoRun: body.autoRun,
    };
    return this.journeyService.createCampaign(projectId, input);
  }

  @Get('journey-campaigns/:campaignId')
  @ApiOperation({ summary: 'Get a campaign with its journeys' })
  @ApiResponse({ status: 200, description: 'Campaign + journeys' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  async getCampaign(@Param('campaignId') campaignId: string) {
    return this.journeyService.getCampaign(campaignId);
  }

  @Post('journey-campaigns/:campaignId/execute')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Execute a campaign\'s remaining journeys',
    description: 'Runs not-yet-completed journeys in order, stopping when cumulative spend reaches budgetUsd.',
  })
  @ApiResponse({ status: 200, description: 'Updated campaign + journeys' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  @ApiResponse({ status: 409, description: 'Campaign already completed' })
  @ApiResponse({ status: 503, description: 'Live surface blocked' })
  async executeCampaign(@Param('campaignId') campaignId: string) {
    return this.journeyService.executeCampaign(campaignId);
  }
}
