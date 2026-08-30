/**
 * QuerySet Controller — REST API for versioned buyer prompt sets (SOP-1).
 *
 * Routes (nested under the owning project):
 *   GET    /api/projects/:projectId/query-sets              — list sets
 *   POST   /api/projects/:projectId/query-sets              — create v1 draft
 *   GET    /api/projects/:projectId/query-sets/export       — export all sets
 *   GET    /api/projects/:projectId/query-sets/:setId       — set detail (+items)
 *   POST   /api/projects/:projectId/query-sets/:setId/prompts — add prompt (draft only)
 *   DELETE /api/projects/:projectId/query-sets/:setId/prompts/:itemId — remove (draft only)
 *   POST   /api/projects/:projectId/query-sets/:setId/activate — activate (immutable)
 *   POST   /api/projects/:projectId/query-sets/:setId/fork  — fork next version
 *
 * @module query-set.controller
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
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { QuerySetService } from './query-set.service';
import { CreateQuerySetDto, AddPromptDto } from './dto/query-set.dto';
import type { PromptPersona, QuerySetSource, QuerySetStatus, FunnelStage } from './query-set.types';

@ApiTags('Query Set')
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/query-sets')
export class QuerySetController {
  constructor(private readonly querySetService: QuerySetService) {}

  /**
   * List the project's query sets (every version, every persona).
   */
  @Get()
  @ApiOperation({
    summary: 'List query sets for a project',
    description: 'Returns all versions of all persona sets, newest first, with items included.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'active', 'archived'] })
  @ApiResponse({ status: 200, description: 'Array of query sets with items' })
  async list(@Param('projectId') projectId: string, @Query('status') status?: string) {
    const typed = status as QuerySetStatus | undefined;
    return this.querySetService.list(projectId, typed);
  }

  /**
   * Create a version-1 draft set for one persona. Optionally seeds a first prompt.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Create a query set (v1 draft)',
    description:
      'Creates the version-1 draft for one persona. One v1 per project + persona — ' +
      'fork an activated set for the next version. Optionally seeds a first prompt.',
  })
  @ApiBody({ type: CreateQuerySetDto })
  @ApiResponse({ status: 201, description: 'Draft query set created' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'A v1 set for this persona already exists' })
  async create(@Param('projectId') projectId: string, @Body() body: CreateQuerySetDto) {
    const persona = body.persona as PromptPersona;
    return this.querySetService.create({
      projectId,
      persona,
      label: body.label,
      source: body.source as QuerySetSource | undefined,
      prompt: body.prompt,
      funnelStage: body.funnelStage as FunnelStage | undefined,
    });
  }

  /**
   * Export every set for the project — the client owns the query set.
   */
  @Get('export')
  @ApiOperation({
    summary: 'Export all query sets for a project',
    description: 'Full export of every persona/version with all prompt rows.',
  })
  @ApiResponse({ status: 200, description: 'All query sets with items' })
  async export(@Param('projectId') projectId: string) {
    return this.querySetService.export(projectId);
  }

  /**
   * Get one set with its prompts.
   */
  @Get(':setId')
  @ApiOperation({ summary: 'Get a query set by ID (with items)' })
  @ApiResponse({ status: 200, description: 'Query set with items' })
  @ApiResponse({ status: 404, description: 'Query set not found' })
  async getById(@Param('setId') setId: string) {
    return this.querySetService.get(setId);
  }

  /**
   * Add a prompt to a draft set.
   */
  @Post(':setId/prompts')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Add a prompt to a draft query set' })
  @ApiBody({ type: AddPromptDto })
  @ApiResponse({ status: 201, description: 'Prompt added' })
  @ApiResponse({ status: 404, description: 'Query set not found' })
  @ApiResponse({ status: 409, description: 'Set is not a draft' })
  async addPrompt(
    @Param('setId') setId: string,
    @Body() body: AddPromptDto,
  ) {
    return this.querySetService.addPrompt(setId, {
      prompt: body.prompt,
      funnelStage: body.funnelStage as FunnelStage,
    });
  }

  /**
   * Remove a prompt from a draft set.
   */
  @Delete(':setId/prompts/:itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a prompt from a draft query set' })
  @ApiResponse({ status: 200, description: 'Item id removed' })
  @ApiResponse({ status: 404, description: 'Query set or item not found' })
  @ApiResponse({ status: 409, description: 'Set is not a draft' })
  async removePrompt(@Param('setId') setId: string, @Param('itemId') itemId: string) {
    return this.querySetService.removePrompt(setId, itemId);
  }

  /**
   * Activate a draft — freezes it for measurement.
   */
  @Post(':setId/activate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Activate a draft query set',
    description: 'Activation makes the set immutable — measurement runs against this exact version. Requires >= 1 prompt.',
  })
  @ApiResponse({ status: 200, description: 'Query set activated' })
  @ApiResponse({ status: 404, description: 'Query set not found' })
  @ApiResponse({ status: 409, description: 'Already active, still archived, or empty' })
  async activate(@Param('setId') setId: string) {
    return this.querySetService.activate(setId);
  }

  /**
   * Fork an active/archived set into the next draft version.
   */
  @Post(':setId/fork')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Fork a query set into the next version',
    description: 'Copies the source set into a new draft at version+1 (same project + persona). Editing an active set always goes through a fork.',
  })
  @ApiResponse({ status: 201, description: 'New draft version created with copied items' })
  @ApiResponse({ status: 404, description: 'Query set not found' })
  @ApiResponse({ status: 409, description: 'Source set is still a draft' })
  async fork(@Param('setId') setId: string) {
    return this.querySetService.fork(setId);
  }
}