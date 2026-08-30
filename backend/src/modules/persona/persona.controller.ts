/**
 * Persona Controller — REST API for synthetic buyer personas (Agent #1).
 *
 * Routes (nested under the owning project):
 *   GET    /api/projects/:projectId/personas                 — list (?status=)
 *   POST   /api/projects/:projectId/personas                 — hand-author one
 *   POST   /api/projects/:projectId/personas/generate        — generate N (deterministic; ?useLlm)
 *   GET    /api/projects/:projectId/personas/export          — export all
 *   GET    /api/projects/:projectId/personas/:personaId      — detail
 *   PATCH  /api/projects/:projectId/personas/:personaId      — patch (draft only)
 *   POST   /api/projects/:projectId/personas/:personaId/activate — draft → active
 *   POST   /api/projects/:projectId/personas/:personaId/archive  — → archived
 *   DELETE /api/projects/:projectId/personas/:personaId      — hard delete
 *
 * Protected by the global JwtAuthGuard (no @Public routes here).
 *
 * @module persona.controller
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PersonaService } from './persona.service';
import { CreatePersonaDto, GeneratePersonasDto, UpdatePersonaDto } from './dto/persona.dto';
import type {
  CreatePersonaInput,
  PersonaAwareness,
  PersonaCompanyStage,
  PersonaRole,
  PersonaSeniority,
  PersonaStatus,
  UpdatePersonaInput,
} from './persona.types';

@ApiTags('Persona')
@ApiBearerAuth()
@ApiParam({ name: 'projectId', description: 'Owning project ID', required: true })
@Controller('projects/:projectId/personas')
export class PersonaController {
  constructor(private readonly personaService: PersonaService) {}

  /** List the project's personas (every status unless filtered). */
  @Get()
  @ApiOperation({ summary: 'List personas for a project' })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'active', 'archived'] })
  @ApiResponse({ status: 200, description: 'Array of personas' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.personaService.list(projectId, status as PersonaStatus | undefined);
  }

  /** Hand-author a single persona (lands as a draft). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Create a persona manually' })
  @ApiBody({ type: CreatePersonaDto })
  @ApiResponse({ status: 201, description: 'Persona created (draft)' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Project persona cap reached' })
  async create(@Param('projectId') projectId: string, @Body() body: CreatePersonaDto) {
    const input: CreatePersonaInput = {
      label: body.label,
      role: body.role as PersonaRole,
      seniority: body.seniority as PersonaSeniority | undefined,
      companyStage: body.companyStage as PersonaCompanyStage | undefined,
      awareness: body.awareness as PersonaAwareness | undefined,
      primaryGoal: body.primaryGoal,
      researchObjective: body.researchObjective,
      painPoints: body.painPoints,
      buyingTriggers: body.buyingTriggers,
      objections: body.objections,
      vocabulary: body.vocabulary,
    };
    return this.personaService.create(projectId, input);
  }

  /**
   * Generate personas from the project's own context. Deterministic by default;
   * `useLlm: true` refines each with one constrained Anthropic call (needs a key).
   */
  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Generate personas',
    description:
      'Round-robins the requested roles (or the full catalogue) into new persona slots. ' +
      'Clamped to the project cap (PERSONA_MAX_PER_PROJECT). LLM refinement is cost-capped ' +
      '(PERSONA_MAX_COST_PER_GENERATE) — over budget, remaining personas keep deterministic copy.',
  })
  @ApiBody({ type: GeneratePersonasDto })
  @ApiResponse({ status: 201, description: '{ personas, llmRefined, llmCostUsd, capped }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Project persona cap reached' })
  @ApiResponse({ status: 503, description: 'useLlm requested but ANTHROPIC_API_KEY is not configured' })
  async generate(@Param('projectId') projectId: string, @Body() body: GeneratePersonasDto) {
    return this.personaService.generate(projectId, {
      count: body.count,
      roles: body.roles as PersonaRole[] | undefined,
      useLlm: body.useLlm,
    });
  }

  /** Export every persona for the project. */
  @Get('export')
  @ApiOperation({ summary: 'Export all personas for a project' })
  @ApiResponse({ status: 200, description: 'All personas' })
  async export(@Param('projectId') projectId: string) {
    return this.personaService.export(projectId);
  }

  /** One persona with its parsed lists. */
  @Get(':personaId')
  @ApiOperation({ summary: 'Get a persona by ID' })
  @ApiResponse({ status: 200, description: 'Persona' })
  @ApiResponse({ status: 404, description: 'Persona not found' })
  async getById(@Param('personaId') personaId: string) {
    return this.personaService.get(personaId);
  }

  /** Patch a draft persona. */
  @Patch(':personaId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Update a draft persona' })
  @ApiBody({ type: UpdatePersonaDto })
  @ApiResponse({ status: 200, description: 'Updated persona' })
  @ApiResponse({ status: 404, description: 'Persona not found' })
  @ApiResponse({ status: 409, description: 'Persona is not a draft' })
  async update(@Param('personaId') personaId: string, @Body() body: UpdatePersonaDto) {
    const patch: UpdatePersonaInput = {
      label: body.label,
      seniority: body.seniority as PersonaSeniority | undefined,
      companyStage: body.companyStage as PersonaCompanyStage | undefined,
      awareness: body.awareness as PersonaAwareness | undefined,
      primaryGoal: body.primaryGoal,
      researchObjective: body.researchObjective,
      painPoints: body.painPoints,
      buyingTriggers: body.buyingTriggers,
      objections: body.objections,
      vocabulary: body.vocabulary,
    };
    return this.personaService.update(personaId, patch);
  }

  /** Draft → active. */
  @Post(':personaId/activate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Activate a persona (draft → active)' })
  @ApiResponse({ status: 200, description: 'Activated persona' })
  @ApiResponse({ status: 404, description: 'Persona not found' })
  @ApiResponse({ status: 409, description: 'Persona is archived' })
  async activate(@Param('personaId') personaId: string) {
    return this.personaService.activate(personaId);
  }

  /** Any status → archived. */
  @Post(':personaId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a persona' })
  @ApiResponse({ status: 200, description: 'Archived persona' })
  @ApiResponse({ status: 404, description: 'Persona not found' })
  async archive(@Param('personaId') personaId: string) {
    return this.personaService.archive(personaId);
  }

  /** Hard-delete (reclaims a slot against the project cap). */
  @Delete(':personaId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a persona' })
  @ApiResponse({ status: 200, description: '{ removed: personaId }' })
  @ApiResponse({ status: 404, description: 'Persona not found' })
  async remove(@Param('personaId') personaId: string) {
    return this.personaService.remove(personaId);
  }
}
