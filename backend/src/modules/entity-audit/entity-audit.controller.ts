/**
 * Entity Audit Controller — REST API endpoints.
 *
 * Provides entity CRUD (create/read/update/delete), schema check execution,
 * platform record management (manual + semi-auto verify), and audit summary.
 * Model-diff endpoint is stubbed (deferred — see LEFT-OUT.md) but has a
 * list endpoint for persisted diffs.
 *
 * All entity-scoped routes verify that the entity belongs to the projectId
 * (404 if cross-project).
 *
 * @module entity-audit.controller
 */

import { Controller, Post, Get, Patch, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EntityAuditService } from './entity-audit.service';
import {
  CreateEntityDto,
  UpdateEntityDto,
  CreatePlatformRecordDto,
  UpdatePlatformRecordDto,
  RunSchemaCheckDto,
} from './dto/entity-audit.dto';

@ApiTags('Entity Audit')
@Controller('projects/:projectId/entity-audit')
export class EntityAuditController {
  constructor(private readonly entityAuditService: EntityAuditService) {}

  // ─── Entity CRUD ───────────────────────────────────────────────

  /**
   * Add a new entity to track for a project.
   */
  @Post('entities')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an entity to track', description: 'Creates an entity (brand, product, founder, metric) scoped to the project' })
  @ApiBody({ type: CreateEntityDto })
  @ApiResponse({ status: 201, description: 'Entity created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async createEntity(
    @Param('projectId') projectId: string,
    @Body() body: CreateEntityDto,
  ) {
    return this.entityAuditService.createEntity(projectId, body.name, body.type, body.descriptor);
  }

  /**
   * List all entities for a project with their schema checks and platform records.
   */
  @Get('entities')
  @ApiOperation({ summary: 'List all entities for a project' })
  @ApiResponse({ status: 200, description: 'Array of entities with checks and records' })
  async listEntities(@Param('projectId') projectId: string) {
    return this.entityAuditService.listEntities(projectId);
  }

  /**
   * Get a specific entity with all its data. 404 if not in this project.
   */
  @Get('entities/:entityId')
  @ApiOperation({ summary: 'Get entity detail' })
  @ApiParam({ name: 'entityId', description: 'Entity ID' })
  @ApiResponse({ status: 200, description: 'Entity with schema checks and platform records' })
  @ApiResponse({ status: 404, description: 'Entity not found in this project' })
  async getEntity(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
  ) {
    return this.entityAuditService.getEntity(projectId, entityId);
  }

  /**
   * Update an entity (name/descriptor/type). Partial update.
   */
  @Patch('entities/:entityId')
  @ApiOperation({ summary: 'Update an entity', description: 'Patch name, descriptor, or type. Ownership verified.' })
  @ApiBody({ type: UpdateEntityDto })
  @ApiResponse({ status: 200, description: 'Entity updated' })
  @ApiResponse({ status: 404, description: 'Entity not found in this project' })
  async updateEntity(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Body() body: UpdateEntityDto,
  ) {
    return this.entityAuditService.updateEntity(projectId, entityId, body);
  }

  /**
   * Delete an entity and all its dependent records.
   */
  @Delete('entities/:entityId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an entity', description: 'Removes entity and cascades to schema checks, platform records, and model diffs' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Entity not found in this project' })
  async deleteEntity(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
  ) {
    return this.entityAuditService.deleteEntity(projectId, entityId);
  }

  // ─── Schema Check ──────────────────────────────────────────────

  /**
   * Run a schema check on a URL — extract JSON-LD, validate fields, verify sameAs links.
   * Rate-limited to 5 per 60s (schema check involves multiple fetches + sameAs verification).
   */
  @Post('entities/:entityId/schema-check/run')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Run schema check',
    description: 'Fetches JSON-LD schema from the URL, validates required fields, and verifies each sameAs link resolves and matches the entity identity. Handles @graph and string/array sameAs.',
  })
  @ApiBody({ type: RunSchemaCheckDto })
  @ApiResponse({ status: 200, description: 'Schema check completed' })
  @ApiResponse({ status: 400, description: 'Invalid URL' })
  @ApiResponse({ status: 404, description: 'Entity not found in this project' })
  @ApiResponse({ status: 429, description: 'Rate limited to 5/minute' })
  async runSchemaCheck(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Body() body: RunSchemaCheckDto,
  ) {
    return this.entityAuditService.runSchemaCheck(projectId, entityId, body.url);
  }

  /**
   * Schema-check history for an entity (newest first).
   */
  @Get('entities/:entityId/schema-checks')
  @ApiOperation({ summary: 'List schema-check history for an entity' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (1-50, default 20)' })
  @ApiResponse({ status: 200, description: 'History of schema checks' })
  async listSchemaChecks(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Query('limit') limit?: string,
  ) {
    return this.entityAuditService.getSchemaChecks(projectId, entityId, limit ? parseInt(limit, 10) : 20);
  }

  // ─── Platform Records ──────────────────────────────────────────

  /**
   * Add a platform record (manual entry by delivery lead).
   * If verifySource=true and sourceUrl is set, does a single-page fetch (semi-auto, low ToS risk)
   * and auto-infers consistencyStatus from the fetched title.
   */
  @Post('entities/:entityId/platform-record')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a platform record (manual + semi-auto)',
    description: 'Records how a platform describes the entity. Pass verifySource=true with sourceUrl to single-fetch the page and auto-verify title match.',
  })
  @ApiBody({ type: CreatePlatformRecordDto })
  @ApiResponse({ status: 201, description: 'Platform record created' })
  @ApiResponse({ status: 404, description: 'Entity not found in this project' })
  async createPlatformRecord(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Body() body: CreatePlatformRecordDto,
  ) {
    return this.entityAuditService.createPlatformRecord(
      projectId,
      entityId,
      body.platform,
      body.recordedName,
      body.recordedDescriptor,
      body.sourceUrl,
      body.consistencyStatus || 'not-checked',
      (body as any).verifySource === true,
    );
  }

  @Patch('entities/:entityId/platform-records/:recordId')
  @ApiOperation({ summary: 'Update a platform record' })
  @ApiBody({ type: UpdatePlatformRecordDto })
  @ApiResponse({ status: 200, description: 'Record updated' })
  @ApiResponse({ status: 404, description: 'Record or entity not found' })
  async updatePlatformRecord(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Param('recordId') recordId: string,
    @Body() body: UpdatePlatformRecordDto,
  ) {
    return this.entityAuditService.updatePlatformRecord(projectId, entityId, recordId, body);
  }

  @Delete('entities/:entityId/platform-records/:recordId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a platform record' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Record or entity not found' })
  async deletePlatformRecord(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Param('recordId') recordId: string,
  ) {
    return this.entityAuditService.deletePlatformRecord(projectId, entityId, recordId);
  }

  /**
   * Check platform consistency — compare recorded names with entity name.
   */
  @Get('entities/:entityId/platform-consistency')
  @ApiOperation({ summary: 'Check platform consistency', description: 'Compares recorded platform names/descriptors with the entity name (respects stored match/mismatch, falls back to normalized name compare)' })
  @ApiResponse({ status: 200, description: 'Consistency check results' })
  @ApiResponse({ status: 404, description: 'Entity not found in this project' })
  async checkPlatformConsistency(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
  ) {
    return this.entityAuditService.checkPlatformConsistency(projectId, entityId);
  }

  // ─── Audit Summary ─────────────────────────────────────────────

  /**
   * Get the full entity audit summary for a project.
   */
  @Get()
  @ApiOperation({ summary: 'Get full entity audit summary' })
  @ApiResponse({ status: 200, description: 'Full audit with entities, schema checks, platform records, and model diffs' })
  async getAuditSummary(@Param('projectId') projectId: string) {
    return this.entityAuditService.getAuditSummary(projectId);
  }

  // ─── Model-Diff (deferred) ─────────────────────────────────────

  /**
   * List persisted model-diffs for an entity (empty until feature built, but schema exists).
   */
  @Get('entities/:entityId/model-diffs')
  @ApiOperation({ summary: 'List model-diffs for an entity', description: 'Returns persisted model-diff runs. Empty until LLM integration is built — see LEFT-OUT.md.' })
  @ApiResponse({ status: 200, description: 'List of model diffs (may be empty)' })
  async listModelDiffs(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
  ) {
    return this.entityAuditService.listModelDiffs(projectId, entityId);
  }

  /**
   * Model-diff — sends "What is {entity}?" to every keyed surface (Claude +
   * Perplexity), then runs the Claude judge pass for descriptor divergence.
   */
  @Post('entities/:entityId/model-diff/run')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Run model-diff for an entity', description: 'Asks every keyed surface (Claude, Perplexity) the identity prompt, stores per-provider ModelDiff rows, then runs the Claude judge for divergence ("Aligned:"/"Divergent:"). 503 without API keys.' })
  @ApiResponse({ status: 200, description: 'Divergence verdict + per-provider status' })
  @ApiResponse({ status: 503, description: 'No surface API keys configured' })
  async runModelDiff(
    @Param('projectId') projectId: string,
    @Param('entityId') entityId: string,
    @Body() body?: { prompt?: string },
  ) {
    return this.entityAuditService.runModelDiff(projectId, entityId, body?.prompt);
  }
}
