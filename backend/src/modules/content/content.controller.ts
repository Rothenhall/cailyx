/**
 * ContentController — G09: editable briefs, versioned content revisions and
 * reliable generation jobs.
 *
 * Three route groups in one file, because they share the service and the
 * project-scoped addressing every handler passes straight through:
 *
 *   Operator  /api/projects/:projectId/content-briefs   — the instruction sets
 *   Operator  /api/projects/:projectId/growth-execution/assets/:assetId
 *                                                       — editable asset content
 *   Operator  /api/projects/:projectId/content-jobs     — generation batches
 *
 * Every handler passes the URL's `projectId` down to the service rather than
 * resolving a bare `briefId`/`assetId`/`jobId` on its own — the service
 * compares the row's own `projectId` and throws 404 when they disagree, so a
 * foreign id in the URL fails the ownership check instead of being fetched
 * (design_plan.md G03, line 1613).
 *
 * Two deliberate deviations from the suggested route list, both forced by
 * routes that already exist elsewhere in the app:
 *
 *  1. `PATCH .../growth-execution/assets/:assetId` is **already owned** by
 *     `growth-execution.controller.ts` (API-122: move an asset through
 *     recommended → in-progress → published). `GrowthExecutionModule` is
 *     registered before `ContentModule` in `app.module.ts`, so a second
 *     handler on that exact method+path would register second and never be
 *     reached. The content edit therefore lives at
 *     `PATCH .../growth-execution/assets/:assetId/content`. Two different
 *     edits to the same row — its lifecycle vs its text — each need their
 *     own URL until the two handlers are merged into one.
 *  2. `GET .../growth-execution/assets/:assetId` is free (growth-execution
 *     only defines list/create/patch), so the asset's editable-content read
 *     keeps the suggested path.
 *
 * Roles: mutations are admin / delivery-lead / content, matching design_plan
 * §2.2's "Generate/edit content" row. Brief `status: "approved"` is an
 * internal marker on the instruction set, not the client-facing approval —
 * that is an ApprovalRequest (G10), which is admin/delivery-lead only.
 *
 * @module content.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ContentService } from './content.service';
import {
  CreateContentBriefDto,
  CreateGenerationJobDto,
  ListContentBriefsQueryDto,
  ListGenerationJobsQueryDto,
  RetryGenerationJobDto,
  UpdateAssetContentDto,
  UpdateContentBriefDto,
} from './dto/content.dto';

/** design_plan §2.2 — the roles that may create or edit content. */
const CONTENT_EDITOR_ROLES = ['admin', 'delivery-lead', 'content'] as const;

// ── Content briefs ──────────────────────────────────────────────────────

@ApiTags('content: briefs')
@ApiBearerAuth()
@Controller('projects/:projectId/content-briefs')
export class ContentBriefsController {
  constructor(private readonly service: ContentService) {}

  @Get()
  @ApiOperation({
    summary: "A project's content briefs, filterable by status/asset type",
    description: 'Pass latestOnly=true to collapse to the highest version of each title.',
  })
  @ApiResponse({ status: 200, description: '{ briefs: ContentBriefDto[] }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('projectId') projectId: string, @Query() query: ListContentBriefsQueryDto) {
    return this.service.listBriefs(projectId, query);
  }

  @Post()
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({
    summary: 'Create a content brief — the instruction set a generation job is bound to',
    description:
      'The version is assigned server-side (one past the highest version of the same title in this project). Seven asset types are brief-only: they can be created and edited here but not generated.',
  })
  @ApiBody({ type: CreateContentBriefDto })
  @ApiResponse({ status: 201, description: 'The created brief, at version 1 with status "draft"' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async create(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateContentBriefDto,
  ) {
    return this.service.createBrief(projectId, user.userId, dto);
  }

  @Get(':briefId')
  @ApiOperation({ summary: 'One brief version' })
  @ApiResponse({ status: 200, description: 'The brief' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@Param('projectId') projectId: string, @Param('briefId') briefId: string) {
    return this.service.getBrief(projectId, briefId);
  }

  @Get(':briefId/versions')
  @ApiOperation({
    summary: 'Every version of the same title, oldest first',
    description: 'A generation job records the exact briefId + briefVersion it used; this is how a caller sees what changed since.',
  })
  @ApiResponse({ status: 200, description: '{ versions: ContentBriefDto[] }' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async versions(@Param('projectId') projectId: string, @Param('briefId') briefId: string) {
    return this.service.listBriefVersions(projectId, briefId);
  }

  @Patch(':briefId')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({
    summary: 'Edit a brief / move it through draft → approved → archived',
    description:
      'A draft brief is edited in place. An approved or archived brief is never rewritten: a content-field change forks a NEW version row (starting at status "draft") so a generation job that already recorded briefId+briefVersion keeps pointing at the exact instructions it used. status:"archived" is always an in-place transition.',
  })
  @ApiBody({ type: UpdateContentBriefDto })
  @ApiResponse({ status: 200, description: 'The updated brief — possibly a newly forked version' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async update(
    @Param('projectId') projectId: string,
    @Param('briefId') briefId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: UpdateContentBriefDto,
  ) {
    return this.service.updateBrief(projectId, briefId, user.userId, dto);
  }
}

// ── Editable asset content and revisions ────────────────────────────────

@ApiTags('content: asset content')
@ApiBearerAuth()
@Controller('projects/:projectId/growth-execution/assets')
export class AssetContentController {
  constructor(private readonly service: ContentService) {}

  @Get(':assetId')
  @ApiOperation({
    summary: "A growth asset's current editable content and the version a save must quote",
    description:
      'currentVersion is the number a PATCH must supply as expectedVersion. 0 means no ContentRevision has been saved yet; legacyContentOnly then says whether pre-G09 generated content exists on the asset row itself (read-only context, never claimed as a saved revision).',
  })
  @ApiResponse({ status: 200, description: '{ assetId, projectId, assetType, title, status, currentVersion, current, legacyContentOnly }' })
  @ApiResponse({ status: 404, description: 'Asset not found for this project' })
  async get(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.service.getAssetContent(projectId, assetId);
  }

  @Get(':assetId/revisions')
  @ApiOperation({ summary: 'Every saved revision of an asset, newest first' })
  @ApiResponse({ status: 200, description: '{ revisions: ContentRevisionDto[] }' })
  @ApiResponse({ status: 404, description: 'Asset not found for this project' })
  async revisions(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.service.listRevisions(projectId, assetId);
  }

  @Patch(':assetId/content')
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({
    summary: "Save an edit to an asset's content",
    description:
      'Optimistic concurrency: expectedVersion must equal the asset\'s current revision. A mismatch is rejected with 409 (never a silent overwrite of a concurrent edit); the 409 body carries currentVersion and the current content so the caller can reapply. A successful save always writes a new immutable revision — the previous revision row is never mutated — carrying forward the brief provenance of the revision it was based on.',
  })
  @ApiBody({ type: UpdateAssetContentDto })
  @ApiResponse({ status: 200, description: 'The saved content at its new revision' })
  @ApiResponse({ status: 404, description: 'Asset not found for this project' })
  @ApiResponse({
    status: 409,
    description: 'expectedVersion does not match the asset\'s current revision — body: { message, currentVersion, current }',
  })
  async save(
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: UpdateAssetContentDto,
  ) {
    return this.service.updateAssetContent(projectId, assetId, user.userId, 'operator', dto);
  }
}

// ── Generation jobs ─────────────────────────────────────────────────────

@ApiTags('content: generation jobs')
@ApiBearerAuth()
@Controller('projects/:projectId/content-jobs')
export class GenerationJobsController {
  constructor(private readonly service: ContentService) {}

  @Get()
  @ApiOperation({ summary: "A project's generation jobs, newest first" })
  @ApiResponse({ status: 200, description: '{ jobs: GenerationJobDto[] } — each with its items, retryableItemIds, cost and note' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('projectId') projectId: string, @Query() query: ListGenerationJobsQueryDto) {
    return this.service.listGenerationJobs(projectId, query);
  }

  @Post()
  @Roles(...CONTENT_EDITOR_ROLES)
  @ApiOperation({
    summary: 'Generate one artifact per selected topic from an approved brief',
    description:
      'briefVersion must equal the brief\'s actual version — "regenerate" never silently uses a different instruction set. A zero-item request is valid and records a completed job with requested 0, distinct from a batch whose items each failed. Per-item failures are recorded on the item and counted in a "partial" job; they are never discarded to report a clean success.',
  })
  @ApiBody({ type: CreateGenerationJobDto })
  @ApiResponse({ status: 201, description: 'The finished job: requested/succeeded/failed counts, per-item asset ids, cost, errors, retryableItemIds' })
  @ApiResponse({ status: 404, description: 'Project or brief not found for this project' })
  @ApiResponse({
    status: 422,
    description:
      'briefVersion is stale, the brief is not approved, or the brief\'s own asset type is one of the seven brief-only types (the body\'s assetType is already limited to article/ad-copy, so this fires when no override is passed for a brief whose type cannot be generated)',
  })
  @ApiResponse({ status: 503, description: 'No LLM provider configured — generation has no deterministic fallback' })
  async create(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthedRequestUser,
    @Body() dto: CreateGenerationJobDto,
  ) {
    return this.service.createGenerationJob(projectId, user.userId, dto);
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'One generation job with every item it produced' })
  @ApiResponse({ status: 200, description: 'The job' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to a different project' })
  async get(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.service.getGenerationJob(projectId, jobId);
  }

  @Post(':jobId/retry')
  @Roles(...CONTENT_EDITOR_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry the failed, retryable items of a job',
    description:
      'Only items that failed AND are retryable are re-run — items that already succeeded are never re-run or re-charged. Retrying uses the briefId + briefVersion the original job recorded, never a newer one. When nothing matches, the job is returned unchanged with a note saying so, rather than erroring.',
  })
  @ApiBody({ type: RetryGenerationJobDto })
  @ApiResponse({ status: 200, description: 'The updated job, with a note stating how many items were retried' })
  @ApiResponse({ status: 404, description: 'Job not found for this project, or its original brief no longer exists' })
  @ApiResponse({ status: 422, description: 'The job recorded no briefId, so it cannot be retried with the same instructions' })
  async retry(
    @Param('projectId') projectId: string,
    @Param('jobId') jobId: string,
    @Body() dto: RetryGenerationJobDto,
  ) {
    return this.service.retryGenerationJob(projectId, jobId, dto);
  }
}
