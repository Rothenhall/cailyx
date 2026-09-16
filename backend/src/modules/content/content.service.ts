/**
 * ContentService — G09: editable briefs, versioned content revisions and
 * reliable generation jobs.
 *
 * Three sub-surfaces:
 *  - ContentBrief CRUD, with version-preserving edits (an approved brief is
 *    never mutated in place — editing it writes a new version row instead).
 *  - GrowthAsset content editing via ContentRevision, with an optimistic
 *    version precondition on PATCH (never silently overwrite a concurrent edit).
 *  - GenerationJob/GenerationItem batches: generation always records the
 *    EXACT briefId+briefVersion it used, so "regenerate" cannot silently
 *    drift onto different instructions, and a retry only re-runs (and only
 *    re-charges for) the items that failed.
 *
 * Generation reuses the same OpenRouter-preferred/Anthropic-fallback
 * LlmService every other module's constrained-LLM call goes through
 * (see common/llm/llm.service.ts) — NOT growth-execution's private
 * generateArticle/generateAdCopy (those take only a keyword+angle from
 * suggestTopics' top-N preview, not an approved brief's full instruction
 * set — claims, references, mustInclude, language, constraints — which is
 * exactly what G09 requires be honored exactly).
 *
 * @module content.service
 */

import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { LlmService } from '../../common/llm/llm.service';
import { PrismaService } from '../database/prisma.service';
import {
  ALL_ASSET_TYPES,
  GENERATABLE_ASSET_TYPES,
  type AssetContentDto,
  type ContentAssetType,
  type ContentBriefDto,
  type ContentRevisionDto,
  type GenerationItemDto,
  type GenerationJobDto,
  type GeneratableAssetType,
  type ReferenceSource,
} from './content.types';
import type {
  CreateContentBriefDto,
  CreateGenerationJobDto,
  ListContentBriefsQueryDto,
  ListGenerationJobsQueryDto,
  RetryGenerationJobDto,
  UpdateAssetContentDto,
  UpdateContentBriefDto,
} from './dto/content.dto';

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseReferences(raw: string | null | undefined): ReferenceSource[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseFields(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Stable digest of a revision's content, used to tell "the text actually
 * changed" apart from "the operator re-saved the same text".
 *
 * `fields` is typed `unknown` on purpose: callers pass both plain
 * `Record<string, unknown>` objects and named interfaces (`ArticleFields`,
 * `AdCopyFields`). Interfaces have no implicit index signature, so a
 * `Record<string, unknown>` parameter would reject them. The value only ever
 * reaches `JSON.stringify`, so its shape cannot affect correctness.
 */
function contentHash(title: string | null, body: string | null, fields: unknown): string {
  return createHash('sha256').update(JSON.stringify({ title, body, fields })).digest('hex');
}

function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

interface ArticleFields {
  metaDescription: string;
  slug: string;
  faq: Array<{ question: string; answer: string }>;
  jsonLd: Record<string, unknown>[];
}

interface AdCopyFields {
  variants: Array<{ headline: string; description: string }>;
}

/**
 * A `GenerationItem` as it leaves `runOneItem`. Both the success and failure
 * paths return this same row shape (the failure path records `status: 'failed'`
 * on the row rather than throwing), so one item failing never discards the
 * results of its siblings — the job is finalized as `partial`.
 */
type GenerationItemRow = Awaited<ReturnType<PrismaService['generationItem']['update']>>;

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    protected readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
  ) {}

  // ─── Content briefs ──────────────────────────────────────────────

  async createBrief(projectId: string, userId: string | undefined, dto: CreateContentBriefDto): Promise<ContentBriefDto> {
    await this.ensureProject(projectId);
    const existingMax = await this.prisma.contentBrief.findFirst({
      where: { projectId, title: dto.title },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = existingMax ? existingMax.version + 1 : 1;
    const row = await this.prisma.contentBrief.create({
      data: {
        projectId,
        version,
        title: dto.title,
        assetType: dto.assetType ?? 'article',
        targetQuery: dto.targetQuery ?? null,
        supportingQueries: JSON.stringify(dto.supportingQueries ?? []),
        audience: dto.audience ?? null,
        intent: dto.intent ?? null,
        angle: dto.angle ?? null,
        mustInclude: JSON.stringify(dto.mustInclude ?? []),
        claimIds: JSON.stringify(dto.claimIds ?? []),
        references: JSON.stringify(dto.references ?? []),
        sourceType: dto.sourceType ?? null,
        sourceId: dto.sourceId ?? null,
        wordTarget: dto.wordTarget ?? null,
        language: dto.language ?? 'en',
        createdBy: userId ?? null,
      },
    });
    return this.toBriefDto(row);
  }

  async listBriefs(projectId: string, query: ListContentBriefsQueryDto): Promise<{ briefs: ContentBriefDto[] }> {
    await this.ensureProject(projectId);
    const where: Record<string, unknown> = { projectId };
    if (query.status) where.status = query.status;
    if (query.assetType) where.assetType = query.assetType;
    const rows = await this.prisma.contentBrief.findMany({ where, orderBy: [{ title: 'asc' }, { version: 'desc' }] });

    if (!query.latestOnly) {
      return { briefs: rows.map((r) => this.toBriefDto(r)) };
    }
    const latestByTitle = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!latestByTitle.has(r.title)) latestByTitle.set(r.title, r); // rows already ordered version desc within each title
    }
    return { briefs: [...latestByTitle.values()].map((r) => this.toBriefDto(r)) };
  }

  async getBrief(projectId: string, briefId: string): Promise<ContentBriefDto> {
    const row = await this.prisma.contentBrief.findUnique({ where: { id: briefId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException(`Content brief ${briefId} not found for project ${projectId}`);
    return this.toBriefDto(row);
  }

  async listBriefVersions(projectId: string, briefId: string): Promise<{ versions: ContentBriefDto[] }> {
    const row = await this.prisma.contentBrief.findUnique({ where: { id: briefId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException(`Content brief ${briefId} not found for project ${projectId}`);
    const rows = await this.prisma.contentBrief.findMany({ where: { projectId, title: row.title }, orderBy: { version: 'asc' } });
    return { versions: rows.map((r) => this.toBriefDto(r)) };
  }

  /**
   * Draft briefs are edited in place. An approved/archived brief is never
   * mutated: a content-field change instead creates a new version row (so
   * a GenerationJob that already recorded briefId+briefVersion keeps
   * pointing at the exact instructions it used). Setting status:"archived"
   * is always an in-place transition — archiving does not need a new version.
   */
  async updateBrief(projectId: string, briefId: string, userId: string | undefined, dto: UpdateContentBriefDto): Promise<ContentBriefDto> {
    const existing = await this.prisma.contentBrief.findUnique({ where: { id: briefId } });
    if (!existing || existing.projectId !== projectId) throw new NotFoundException(`Content brief ${briefId} not found for project ${projectId}`);

    if (dto.status === 'archived') {
      const row = await this.prisma.contentBrief.update({ where: { id: briefId }, data: { status: 'archived' } });
      return this.toBriefDto(row);
    }

    const changingContent = Object.keys(dto).some((k) => k !== 'status' && (dto as Record<string, unknown>)[k] !== undefined);

    if (existing.status === 'draft') {
      const data: Record<string, unknown> = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.assetType !== undefined) data.assetType = dto.assetType;
      if (dto.targetQuery !== undefined) data.targetQuery = dto.targetQuery;
      if (dto.supportingQueries !== undefined) data.supportingQueries = JSON.stringify(dto.supportingQueries);
      if (dto.audience !== undefined) data.audience = dto.audience;
      if (dto.intent !== undefined) data.intent = dto.intent;
      if (dto.angle !== undefined) data.angle = dto.angle;
      if (dto.mustInclude !== undefined) data.mustInclude = JSON.stringify(dto.mustInclude);
      if (dto.claimIds !== undefined) data.claimIds = JSON.stringify(dto.claimIds);
      if (dto.references !== undefined) data.references = JSON.stringify(dto.references);
      if (dto.sourceType !== undefined) data.sourceType = dto.sourceType;
      if (dto.sourceId !== undefined) data.sourceId = dto.sourceId;
      if (dto.wordTarget !== undefined) data.wordTarget = dto.wordTarget;
      if (dto.language !== undefined) data.language = dto.language;
      if (dto.status === 'approved') {
        data.status = 'approved';
        data.approvedBy = userId ?? null;
        data.approvedAt = new Date();
      }
      const row = await this.prisma.contentBrief.update({ where: { id: briefId }, data });
      return this.toBriefDto(row);
    }

    // approved (or otherwise non-draft) brief: content changes fork a new version.
    if (!changingContent && dto.status === undefined) {
      return this.toBriefDto(existing); // no-op PATCH, nothing to fork for
    }
    const maxVersion = await this.prisma.contentBrief.findFirst({
      where: { projectId, title: dto.title ?? existing.title },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (maxVersion?.version ?? existing.version) + 1;
    const row = await this.prisma.contentBrief.create({
      data: {
        projectId,
        version: nextVersion,
        title: dto.title ?? existing.title,
        assetType: dto.assetType ?? existing.assetType,
        targetQuery: dto.targetQuery ?? existing.targetQuery,
        supportingQueries: dto.supportingQueries ? JSON.stringify(dto.supportingQueries) : existing.supportingQueries,
        audience: dto.audience ?? existing.audience,
        intent: dto.intent ?? existing.intent,
        angle: dto.angle ?? existing.angle,
        mustInclude: dto.mustInclude ? JSON.stringify(dto.mustInclude) : existing.mustInclude,
        claimIds: dto.claimIds ? JSON.stringify(dto.claimIds) : existing.claimIds,
        references: dto.references ? JSON.stringify(dto.references) : existing.references,
        sourceType: dto.sourceType ?? existing.sourceType,
        sourceId: dto.sourceId ?? existing.sourceId,
        wordTarget: dto.wordTarget ?? existing.wordTarget,
        language: dto.language ?? existing.language,
        status: dto.status === 'approved' ? 'draft' : 'draft', // a forked version always starts draft — it has not itself been approved yet, even if the caller passed status:"approved" in the same call
        createdBy: userId ?? null,
      },
    });
    return this.toBriefDto(row);
  }

  private toBriefDto(row: {
    id: string;
    projectId: string;
    version: number;
    title: string;
    assetType: string;
    targetQuery: string | null;
    supportingQueries: string;
    audience: string | null;
    intent: string | null;
    angle: string | null;
    mustInclude: string;
    claimIds: string;
    references: string;
    sourceType: string | null;
    sourceId: string | null;
    wordTarget: number | null;
    language: string;
    status: string;
    approvedBy: string | null;
    approvedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ContentBriefDto {
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      title: row.title,
      assetType: row.assetType as ContentAssetType,
      targetQuery: row.targetQuery,
      supportingQueries: parseJsonArray(row.supportingQueries),
      audience: row.audience,
      intent: row.intent,
      angle: row.angle,
      mustInclude: parseJsonArray(row.mustInclude),
      claimIds: parseJsonArray(row.claimIds),
      references: parseReferences(row.references),
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      wordTarget: row.wordTarget,
      language: row.language,
      status: row.status as ContentBriefDto['status'],
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ─── GrowthAsset editable content (ContentRevision) ────────────────

  async getAssetContent(projectId: string, assetId: string): Promise<AssetContentDto> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) throw new NotFoundException(`Asset ${assetId} not found for project ${projectId}`);

    const latest = await this.prisma.contentRevision.findFirst({ where: { assetId }, orderBy: { revision: 'desc' } });
    if (latest) {
      return {
        assetId: asset.id,
        projectId,
        assetType: asset.assetType as ContentAssetType,
        title: asset.title,
        status: asset.status,
        currentVersion: latest.revision,
        current: this.toRevisionDto(latest),
        legacyContentOnly: false,
      };
    }

    // No saved revision yet. If the (legacy, pre-G09) growth-execution
    // generator already wrote GrowthAsset.content, surface it as read-only
    // context at version 0 — never claim it as a saved ContentRevision.
    return {
      assetId: asset.id,
      projectId,
      assetType: asset.assetType as ContentAssetType,
      title: asset.title,
      status: asset.status,
      currentVersion: 0,
      current: asset.content
        ? {
            id: '',
            assetId: asset.id,
            revision: 0,
            title: asset.title,
            body: this.legacyBodyOf(asset.assetType as ContentAssetType, asset.content),
            fields: parseFields(asset.content),
            briefId: null,
            briefVersion: null,
            origin: 'generation',
            generationItemId: null,
            wordCount: wordCount(this.legacyBodyOf(asset.assetType as ContentAssetType, asset.content)),
            authorId: null,
            contentHash: null,
            createdAt: asset.createdAt.toISOString(),
          }
        : null,
      legacyContentOnly: !!asset.content,
    };
  }

  private legacyBodyOf(assetType: ContentAssetType, contentJson: string): string | null {
    try {
      const parsed = JSON.parse(contentJson);
      if (assetType === 'article') return typeof parsed.bodyMarkdown === 'string' ? parsed.bodyMarkdown : null;
      return null; // ad-copy has no single "body" — its variants live in `fields`
    } catch {
      return null;
    }
  }

  async listRevisions(projectId: string, assetId: string): Promise<{ revisions: ContentRevisionDto[] }> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId }, select: { projectId: true } });
    if (!asset || asset.projectId !== projectId) throw new NotFoundException(`Asset ${assetId} not found for project ${projectId}`);
    const rows = await this.prisma.contentRevision.findMany({ where: { assetId }, orderBy: { revision: 'desc' } });
    return { revisions: rows.map((r) => this.toRevisionDto(r)) };
  }

  /**
   * Save an edit. `expectedVersion` is the optimistic-concurrency
   * precondition: if the asset has moved past it since the caller last
   * read it, this throws 409 with the current version/state instead of
   * silently overwriting a concurrent revision.
   */
  async updateAssetContent(
    projectId: string,
    assetId: string,
    userId: string | undefined,
    userType: 'operator' | 'client' | undefined,
    dto: UpdateAssetContentDto,
  ): Promise<AssetContentDto> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) throw new NotFoundException(`Asset ${assetId} not found for project ${projectId}`);

    const latest = await this.prisma.contentRevision.findFirst({ where: { assetId }, orderBy: { revision: 'desc' } });
    const currentVersion = latest?.revision ?? 0;

    if (dto.expectedVersion !== currentVersion) {
      const current = await this.getAssetContent(projectId, assetId);
      throw new ConflictException({
        message: `Asset ${assetId} is at version ${currentVersion}, not the expected ${dto.expectedVersion} — reload and reapply your edit.`,
        currentVersion,
        current: current.current,
      });
    }

    const title = dto.title ?? latest?.title ?? asset.title;
    const body = dto.body ?? latest?.body ?? (currentVersion === 0 ? this.legacyBodyOf(asset.assetType as ContentAssetType, asset.content ?? '{}') : null);
    const fields = dto.fields ?? (latest ? parseFields(latest.fields) : currentVersion === 0 ? parseFields(asset.content) : {});
    const hash = contentHash(title, body, fields);

    const row = await this.prisma.contentRevision.create({
      data: {
        assetId,
        revision: currentVersion + 1,
        title,
        body,
        fields: JSON.stringify(fields),
        // An edit carries forward whichever brief the content was generated
        // from (if any) — a plain edit must not silently detach provenance.
        briefId: latest?.briefId ?? null,
        briefVersion: latest?.briefVersion ?? null,
        origin: userType === 'client' ? 'client-edit' : 'operator-edit',
        authorId: userId ?? null,
        wordCount: wordCount(body),
        contentHash: hash,
      },
    });

    return {
      assetId,
      projectId,
      assetType: asset.assetType as ContentAssetType,
      title: asset.title,
      status: asset.status,
      currentVersion: row.revision,
      current: this.toRevisionDto(row),
      legacyContentOnly: false,
    };
  }

  private toRevisionDto(row: {
    id: string;
    assetId: string;
    revision: number;
    title: string | null;
    body: string | null;
    fields: string;
    briefId: string | null;
    briefVersion: number | null;
    origin: string;
    generationItemId: string | null;
    wordCount: number;
    authorId: string | null;
    contentHash: string | null;
    createdAt: Date;
  }): ContentRevisionDto {
    return {
      id: row.id,
      assetId: row.assetId,
      revision: row.revision,
      title: row.title,
      body: row.body,
      fields: parseFields(row.fields),
      briefId: row.briefId,
      briefVersion: row.briefVersion,
      origin: row.origin as ContentRevisionDto['origin'],
      generationItemId: row.generationItemId,
      wordCount: row.wordCount,
      authorId: row.authorId,
      contentHash: row.contentHash,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ─── Generation jobs ─────────────────────────────────────────────

  async createGenerationJob(projectId: string, userId: string | undefined, dto: CreateGenerationJobDto): Promise<GenerationJobDto> {
    await this.ensureProject(projectId);

    const brief = await this.prisma.contentBrief.findUnique({ where: { id: dto.briefId } });
    if (!brief || brief.projectId !== projectId) throw new NotFoundException(`Content brief ${dto.briefId} not found for project ${projectId}`);
    if (brief.version !== dto.briefVersion) {
      throw new UnprocessableEntityException(
        `Requested briefVersion ${dto.briefVersion} does not match brief ${dto.briefId}'s actual version ${brief.version} — re-fetch the brief before generating.`,
      );
    }
    if (brief.status !== 'approved') {
      throw new UnprocessableEntityException(`Brief ${dto.briefId} v${brief.version} is not approved (status: ${brief.status}) — approve it before generating.`);
    }

    const assetType = (dto.assetType ?? brief.assetType) as ContentAssetType;
    if (!ALL_ASSET_TYPES.includes(assetType)) {
      throw new UnprocessableEntityException(`Unknown asset type "${assetType}"`);
    }
    if (!GENERATABLE_ASSET_TYPES.includes(assetType as GeneratableAssetType)) {
      throw new UnprocessableEntityException(
        `Asset type "${assetType}" stays brief-only until separately implemented — only ${GENERATABLE_ASSET_TYPES.join(', ')} can be generated today. The brief itself is still usable for a manual/external draft.`,
      );
    }

    const items = dto.items ?? [];
    if (items.length === 0) {
      // Zero requested because nothing was selected — distinct from a batch
      // where items were selected but generation failed per-item.
      const job = await this.prisma.generationJob.create({
        data: {
          projectId,
          briefId: brief.id,
          briefVersion: brief.version,
          assetType,
          requested: 0,
          succeeded: 0,
          failed: 0,
          status: 'completed',
          input: JSON.stringify(dto),
          requestedBy: userId ?? null,
        },
      });
      return this.toJobDto(job, [], 'No topics were selected — nothing was requested, so nothing failed.');
    }

    if (!this.llm.isAvailable()) {
      throw new ServiceUnavailableException('No LLM provider configured (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) — content generation has no deterministic fallback.');
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true, domain: true, category: true } });
    const claimIds = [...new Set([...(brief.claimIds ? JSON.parse(brief.claimIds) : []), ...(dto.sourceClaimIds ?? [])])] as string[];
    const claims =
      claimIds.length > 0
        ? await this.prisma.claim.findMany({ where: { projectId, id: { in: claimIds }, status: { not: 'blocked' } } })
        : [];

    const job = await this.prisma.generationJob.create({
      data: {
        projectId,
        briefId: brief.id,
        briefVersion: brief.version,
        assetType,
        requested: items.length,
        succeeded: 0,
        failed: 0,
        status: 'running',
        input: JSON.stringify(dto),
        requestedBy: userId ?? null,
      },
    });

    const itemRows = await Promise.all(
      items.map((it) =>
        this.prisma.generationItem.create({
          data: { generationJobId: job.id, subject: it.subject ?? it.topicId, topicId: it.topicId, status: 'pending' },
        }),
      ),
    );

    const results = await this.runItems(projectId, brief, project, claims, assetType, dto, itemRows);
    const updatedJob = await this.finalizeJob(job.id);
    return this.toJobDto(updatedJob, results);
  }

  private async runItems(
    projectId: string,
    brief: { id: string; version: number; title: string; targetQuery: string | null; audience: string | null; intent: string | null; angle: string | null; mustInclude: string; references: string; wordTarget: number | null; language: string },
    project: { name: string; domain: string; category: string | null } | null,
    claims: Array<{ statement: string; sourceUrl: string | null; grade: string | null }>,
    assetType: ContentAssetType,
    dto: CreateGenerationJobDto,
    itemRows: Array<{ id: string; subject: string | null; topicId: string | null }>,
  ): Promise<GenerationItemRow[]> {
    const out: GenerationItemRow[] = [];
    for (const item of itemRows) {
      out.push(await this.runOneItem(projectId, brief, project, claims, assetType, dto, item));
    }
    return out;
  }

  private async runOneItem(
    projectId: string,
    brief: { id: string; version: number; title: string; targetQuery: string | null; audience: string | null; intent: string | null; angle: string | null; mustInclude: string; references: string; wordTarget: number | null; language: string },
    project: { name: string; domain: string; category: string | null } | null,
    claims: Array<{ statement: string; sourceUrl: string | null; grade: string | null }>,
    assetType: ContentAssetType,
    dto: CreateGenerationJobDto,
    item: { id: string; subject: string | null; topicId: string | null },
  ): Promise<GenerationItemRow> {
    const subject = item.subject ?? item.topicId ?? brief.title;
    try {
      const generated =
        assetType === 'article'
          ? await this.generateArticleFromBrief(brief, project, claims, subject, dto)
          : await this.generateAdCopyFromBrief(brief, claims, subject, dto);

      const asset = await this.prisma.growthAsset.create({
        data: {
          projectId,
          assetType,
          title: generated.title,
          brief: brief.angle ?? brief.title,
          targetKeyword: brief.targetQuery ?? subject,
          sourceGapId: null,
          status: 'recommended',
          source: 'generated-llm',
          generationModel: generated.model,
          content: JSON.stringify(generated.contentJson),
        },
      });
      const hash = contentHash(generated.title, generated.body, generated.fields);
      const revision = await this.prisma.contentRevision.create({
        data: {
          assetId: asset.id,
          revision: 1,
          title: generated.title,
          body: generated.body,
          fields: JSON.stringify(generated.fields),
          briefId: brief.id,
          briefVersion: brief.version,
          origin: 'generation',
          generationItemId: item.id,
          wordCount: wordCount(generated.body),
          contentHash: hash,
        },
      });
      return this.prisma.generationItem.update({
        where: { id: item.id },
        data: { status: 'succeeded', assetId: asset.id, revisionId: revision.id, costUsd: generated.costUsd, retryable: false },
      });
    } catch (err) {
      const message = (err as Error).message || 'Generation failed';
      this.logger.warn(`content-jobs: item ${item.id} (${subject}) failed: ${message}`);
      return this.prisma.generationItem.update({
        where: { id: item.id },
        data: { status: 'failed', error: message, retryable: true },
      });
    }
  }

  private async finalizeJob(jobId: string) {
    const items = await this.prisma.generationItem.findMany({ where: { generationJobId: jobId } });
    const succeeded = items.filter((i) => i.status === 'succeeded').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const costUsd = items.reduce((sum, i) => sum + i.costUsd, 0);
    const requested = items.length;
    const status = failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial';
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: { succeeded, failed, costUsd, status },
    });
  }

  async getGenerationJob(projectId: string, jobId: string): Promise<GenerationJobDto> {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException(`Generation job ${jobId} not found for project ${projectId}`);
    const items = await this.prisma.generationItem.findMany({ where: { generationJobId: jobId }, orderBy: { createdAt: 'asc' } });
    return this.toJobDto(job, items);
  }

  async listGenerationJobs(projectId: string, query: ListGenerationJobsQueryDto): Promise<{ jobs: GenerationJobDto[] }> {
    await this.ensureProject(projectId);
    const where: Record<string, unknown> = { projectId };
    if (query.status) where.status = query.status;
    const jobs = await this.prisma.generationJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: query.limit ?? 50 });
    const withItems = await Promise.all(
      jobs.map(async (job) => {
        const items = await this.prisma.generationItem.findMany({ where: { generationJobId: job.id }, orderBy: { createdAt: 'asc' } });
        return this.toJobDto(job, items);
      }),
    );
    return { jobs: withItems };
  }

  /**
   * Retries only the failed+retryable items (or the caller-named subset of
   * them). Succeeded items are never touched, so a retry never re-charges
   * for work that already completed.
   */
  async retryGenerationJob(projectId: string, jobId: string, dto: RetryGenerationJobDto): Promise<GenerationJobDto> {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException(`Generation job ${jobId} not found for project ${projectId}`);

    const allItems = await this.prisma.generationItem.findMany({ where: { generationJobId: jobId } });
    const targets = allItems.filter((i) => i.status === 'failed' && i.retryable && (!dto.itemIds || dto.itemIds.includes(i.id)));
    if (targets.length === 0) {
      const items = await this.prisma.generationItem.findMany({ where: { generationJobId: jobId }, orderBy: { createdAt: 'asc' } });
      return this.toJobDto(job, items, 'No failed, retryable items matched this request — nothing was retried.');
    }

    if (!job.briefId) throw new UnprocessableEntityException('This job has no briefId recorded — it cannot be safely retried.');
    const brief = await this.prisma.contentBrief.findUnique({ where: { id: job.briefId } });
    if (!brief) throw new NotFoundException(`Original brief ${job.briefId} no longer exists — cannot retry with the same instructions.`);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true, domain: true, category: true } });
    const claimIds: string[] = brief.claimIds ? JSON.parse(brief.claimIds) : [];
    const claims = claimIds.length > 0 ? await this.prisma.claim.findMany({ where: { projectId, id: { in: claimIds }, status: { not: 'blocked' } } }) : [];
    const originalInput = job.input ? (JSON.parse(job.input) as CreateGenerationJobDto) : ({} as CreateGenerationJobDto);

    for (const item of targets) {
      await this.prisma.generationItem.update({ where: { id: item.id }, data: { status: 'pending', error: null } });
      // Same brief id/version the original job recorded — retry never
      // silently regenerates against a different, newer brief version.
      await this.runOneItem(projectId, brief, project, claims, job.assetType as ContentAssetType, originalInput, item);
    }

    const updatedJob = await this.finalizeJob(jobId);
    const items = await this.prisma.generationItem.findMany({ where: { generationJobId: jobId }, orderBy: { createdAt: 'asc' } });
    return this.toJobDto(updatedJob, items, `Retried ${targets.length} item(s).`);
  }

  private toJobDto(
    job: {
      id: string;
      projectId: string;
      briefId: string | null;
      briefVersion: number | null;
      assetType: string;
      requested: number;
      succeeded: number;
      failed: number;
      status: string;
      provider: string | null;
      model: string | null;
      costUsd: number;
      error: string | null;
      requestedBy: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    items: Array<{ id: string; generationJobId: string; subject: string | null; topicId: string | null; status: string; assetId: string | null; revisionId: string | null; error: string | null; retryable: boolean; costUsd: number; createdAt: Date; updatedAt: Date }>,
    note?: string,
  ): GenerationJobDto {
    const itemDtos: GenerationItemDto[] = items.map((i) => ({
      id: i.id,
      generationJobId: i.generationJobId,
      subject: i.subject,
      topicId: i.topicId,
      status: i.status as GenerationItemDto['status'],
      assetId: i.assetId,
      revisionId: i.revisionId,
      error: i.error,
      retryable: i.retryable,
      costUsd: i.costUsd,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    }));
    return {
      id: job.id,
      projectId: job.projectId,
      briefId: job.briefId,
      briefVersion: job.briefVersion,
      assetType: job.assetType as ContentAssetType,
      requested: job.requested,
      succeeded: job.succeeded,
      failed: job.failed,
      status: job.status as GenerationJobDto['status'],
      provider: job.provider,
      model: job.model,
      costUsd: job.costUsd,
      error: job.error,
      requestedBy: job.requestedBy,
      note: note ?? (job.requested === 0 ? 'No topics were selected — nothing was requested, so nothing failed.' : null),
      items: itemDtos,
      retryableItemIds: itemDtos.filter((i) => i.status === 'failed' && i.retryable).map((i) => i.id),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  // ─── Generation prompts ─────────────────────────────────────────

  private claimsBlock(claims: Array<{ statement: string; sourceUrl: string | null; grade: string | null }>): string {
    if (claims.length === 0) return '';
    return '\nApproved facts/claims this copy MAY assert (do not invent others):\n' + claims.map((c) => `- ${c.statement}${c.sourceUrl ? ` (source: ${c.sourceUrl})` : ''}`).join('\n');
  }

  private briefBlock(brief: { title: string; targetQuery: string | null; audience: string | null; intent: string | null; angle: string | null; mustInclude: string; references: string; wordTarget: number | null; language: string }, dto: CreateGenerationJobDto): string {
    const mustInclude = parseJsonArray(brief.mustInclude);
    const references = parseReferences(brief.references);
    const parts = [
      `Brief title: ${brief.title}`,
      brief.targetQuery ? `Target query: ${brief.targetQuery}` : null,
      brief.audience ? `Audience: ${brief.audience}` : null,
      brief.intent ? `Intent: ${brief.intent}` : null,
      brief.angle ? `Angle: ${brief.angle}` : null,
      mustInclude.length > 0 ? `Must include: ${mustInclude.join('; ')}` : null,
      references.length > 0 ? `Reference sources: ${references.map((r) => r.url).join(', ')}` : null,
      brief.wordTarget ? `Target length: ~${brief.wordTarget} words` : null,
      `Language: ${dto.language ?? brief.language}`,
      dto.constraints ? `Constraints: ${dto.constraints}` : null,
      dto.voiceContextVersion ? `Brand voice/context version: ${dto.voiceContextVersion}` : null,
    ].filter(Boolean);
    return parts.join('\n');
  }

  private async generateArticleFromBrief(
    brief: { id: string; version: number; title: string; targetQuery: string | null; audience: string | null; intent: string | null; angle: string | null; mustInclude: string; references: string; wordTarget: number | null; language: string },
    project: { name: string; domain: string; category: string | null } | null,
    claims: Array<{ statement: string; sourceUrl: string | null; grade: string | null }>,
    subject: string,
    dto: CreateGenerationJobDto,
  ): Promise<{ title: string; body: string; fields: ArticleFields; contentJson: Record<string, unknown>; model: string; costUsd: number }> {
    const result = await this.llm.json(
      {
        purpose: 'content brief-driven article generation',
        maxTokens: 4000,
        openRouterModel: this.config.get<string>('CONTENT_ARTICLE_MODEL') ?? this.config.get<string>('GROWTH_EXECUTION_ARTICLE_MODEL'),
        anthropicModel: this.config.get<string>('CONTENT_ARTICLE_ANTHROPIC_MODEL'),
        system:
          'You write publishable-draft-quality SEO blog articles from an approved editorial brief. Follow the brief exactly — ' +
          'cover every "must include" point, stay within the stated audience/intent/angle, and ground every fact ONLY in the ' +
          'approved claims given (or general, non-factual framing if none apply). Never invent product features, prices, ' +
          'customer names, or statistics not provided.\n' +
          'Output: title (SEO, 50-60 chars), metaDescription (150-160 chars), slug (lowercase-hyphenated), bodyMarkdown ' +
          '("## " subheadings, no FAQ section inline), and faq (3-4 question/answer pairs). ' +
          'Respond with ONLY JSON matching: {"title":string,"metaDescription":string,"slug":string,"bodyMarkdown":string,' +
          '"faq":[{"question":string,"answer":string}]}',
        user: `${this.briefBlock(brief, dto)}\nSubject/topic for this specific piece: ${subject}${this.claimsBlock(claims)}${project ? `\nBusiness: ${project.name} (${project.domain})` : ''}`,
      },
      (raw) => {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.title !== 'string' || obj.title.length < 5) throw new Error('Model returned no usable title');
        if (typeof obj.metaDescription !== 'string' || obj.metaDescription.length < 20) throw new Error('Model returned no usable metaDescription');
        if (typeof obj.bodyMarkdown !== 'string' || obj.bodyMarkdown.split(/\s+/).filter(Boolean).length < 150) {
          throw new Error('Model returned a body too short to be a real article — treating as failed, never saved as a full draft');
        }
        const faqRaw = Array.isArray(obj.faq) ? obj.faq : [];
        const faq = faqRaw
          .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
          .map((f) => ({ question: String(f.question ?? '').trim(), answer: String(f.answer ?? '').trim() }))
          .filter((f) => f.question && f.answer);
        return { title: obj.title, metaDescription: obj.metaDescription, slug: String(obj.slug ?? obj.title), bodyMarkdown: obj.bodyMarkdown, faq };
      },
    );

    const faqSection = result.data.faq.length > 0 ? '\n\n## Frequently Asked Questions\n\n' + result.data.faq.map((f) => `**${f.question}**\n\n${f.answer}`).join('\n\n') : '';
    const body = result.data.bodyMarkdown + faqSection;
    const now = new Date().toISOString();
    const jsonLd: Record<string, unknown>[] = [
      {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: result.data.title,
        description: result.data.metaDescription,
        datePublished: now,
        dateModified: now,
        author: project ? { '@type': 'Organization', name: project.name } : undefined,
      },
    ];
    if (result.data.faq.length > 0) {
      jsonLd.push({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: result.data.faq.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
      });
    }
    const fields: ArticleFields = { metaDescription: result.data.metaDescription, slug: result.data.slug, faq: result.data.faq, jsonLd };
    return {
      title: result.data.title,
      body,
      fields,
      contentJson: { title: result.data.title, metaDescription: result.data.metaDescription, slug: result.data.slug, bodyMarkdown: body, wordCount: wordCount(body), faq: result.data.faq, jsonLd },
      model: result.model,
      costUsd: result.costUsd ?? 0,
    };
  }

  private async generateAdCopyFromBrief(
    brief: { id: string; version: number; title: string; targetQuery: string | null; audience: string | null; intent: string | null; angle: string | null; mustInclude: string; references: string; wordTarget: number | null; language: string },
    claims: Array<{ statement: string; sourceUrl: string | null; grade: string | null }>,
    subject: string,
    dto: CreateGenerationJobDto,
  ): Promise<{ title: string; body: string; fields: AdCopyFields; contentJson: Record<string, unknown>; model: string; costUsd: number }> {
    const result = await this.llm.json(
      {
        purpose: 'content brief-driven ad copy generation',
        maxTokens: 700,
        openRouterModel: this.config.get<string>('CONTENT_AD_MODEL') ?? this.config.get<string>('GROWTH_EXECUTION_AD_MODEL'),
        anthropicModel: this.config.get<string>('CONTENT_AD_ANTHROPIC_MODEL'),
        system:
          'You write ready-to-run ad copy (Google/Meta search-ad style) from an approved editorial brief. Ground copy ONLY in ' +
          'the brief and the approved claims given — never invent prices, guarantees, or claims not provided. Produce exactly ' +
          '4 variants with genuinely distinct angles. Each headline <=30 characters (note in your own text if the brief\'s ' +
          'language would need more — do not silently truncate meaning). Each description <=90 characters. ' +
          'Respond with ONLY JSON matching: {"variants":[{"headline":string,"description":string}]}',
        user: `${this.briefBlock(brief, dto)}\nSubject/topic for this specific piece: ${subject}${this.claimsBlock(claims)}`,
      },
      (raw) => {
        const arr = (raw as { variants?: unknown }).variants;
        if (!Array.isArray(arr) || arr.length === 0) throw new Error('Model returned no ad variants');
        const variants = arr
          .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
          .map((v) => ({ headline: String(v.headline ?? '').trim(), description: String(v.description ?? '').trim() }))
          .filter((v) => v.headline && v.description);
        if (variants.length === 0) throw new Error('Model returned no usable ad variants — treating as failed, never saved as empty content');
        return { variants };
      },
    );
    const fields: AdCopyFields = { variants: result.data.variants };
    return {
      title: `Ad Copy: ${subject}`,
      body: null as unknown as string, // ad copy has no single prose body — its content lives entirely in `fields.variants`
      fields,
      contentJson: { variants: result.data.variants },
      model: result.model,
      costUsd: result.costUsd ?? 0,
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }
}
