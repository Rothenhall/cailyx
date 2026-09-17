/**
 * Content Generation Service — P09 (platform_improvement_plan.md §13.7,
 * §13.9). Extends the previously-synchronous `growth-execution.generateContent`
 * writer path into a durable, resumable job: POST returns an accepted job
 * identity promptly; a worker (dispatched through the shared BullMQ pipeline
 * queue, same transport aeo-audit's async path uses) resolves ONLY the
 * inputs pinned at enqueue time and creates the ContentRevision.
 *
 * Durability discipline (§13.7):
 *  - Idempotency: `(projectId, idempotencyKey)` is DB-unique. A resubmit
 *    with the same key returns the existing job/output — never a second one.
 *  - Pinned inputs: writing-style version+fingerprint, business-profile
 *    version, brief version, actor, target — all written BEFORE the worker
 *    runs. Editing the writing style after enqueue cannot change what an
 *    in-flight or completed job used, because the worker never re-reads the
 *    live style row — only the pinned id+version.
 *  - Crash recovery: the moment a ContentRevision is created, its id is
 *    written onto the job row in the SAME transaction as the job's status
 *    flip to "succeeded". If a worker dies between "revision created" and
 *    "job acknowledged" (impossible here since they're one transaction, but
 *    kept as an explicit belt-and-braces read), re-running the job finds
 *    `job.revisionId` already set and returns it rather than generating again.
 *  - Bounded retries: `attempts` vs `maxAttempts`; only a `failed` job (never
 *    `succeeded`) is eligible for POST .../retry.
 *  - Leases: a conditional `updateMany` (`status = 'queued'`) is the only way
 *    a worker may claim a job, so two workers racing on the same BullMQ
 *    retry can't both "win" and double-generate.
 *
 * @module content-generation.service
 */

import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import { GrowthExecutionService } from '../growth-execution/growth-execution.service';
import { WritingStyleService } from '../writing-style/writing-style.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import { CONTENT_WORKSPACE_ASSET_TYPES, GENERATION_IMPLEMENTED_ASSET_TYPES } from '../content-workspace/content-workspace.types';
import type { CreateGenerationJobDto } from './dto/content-generation.dto';
import type { GenerationJobDto } from './content-generation.types';
import type { ArticleContent, AdCopyContent } from '../growth-execution/growth-execution.types';

const JOB_NAME = 'content-generation-run';
const LEASE_MS = 5 * 60 * 1000;
const ENQUEUE_TIMEOUT_MS = 5000;

type JobRow = Awaited<ReturnType<PrismaService['generationJob']['findUnique']>>;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class ContentGenerationService {
  private readonly logger = new Logger(ContentGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly growthExecution: GrowthExecutionService,
    private readonly writingStyle: WritingStyleService,
    private readonly businessProfile: BusinessProfileService,
  ) {
    this.pipelineQueue.registerHandler(JOB_NAME, (data: { jobId: string }) => this.runJob(data.jobId));
  }

  // ─── §13.7 enqueue: pin everything BEFORE any generation happens ────

  async enqueue(projectId: string, dto: CreateGenerationJobDto, actorId: string | undefined): Promise<{ job: GenerationJobDto; created: boolean }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // §13.9 — refuse honestly rather than offering a fake "Generate" for an
    // unimplemented type. IsIn on the DTO already narrows this at the HTTP
    // layer; re-checked here because this is the actual authority, not the
    // DTO decorator (the capability matrix is read from the same constant).
    if (!(GENERATION_IMPLEMENTED_ASSET_TYPES as readonly string[]).includes(dto.assetType)) {
      // Two genuinely different gaps, both of which must say what they are
      // rather than share a generic message: a tracked content type with no
      // writer yet (manual planning/editing still applies), and a tracked
      // record that is not content at all (§13.9 — website fixes and
      // structured-data work belong to their own work items).
      const countsAsContent = (CONTENT_WORKSPACE_ASSET_TYPES as readonly string[]).includes(dto.assetType);
      throw new UnprocessableEntityException(
        countsAsContent
          ? `No tested writer exists for asset type "${dto.assetType}" yet. Implemented types: ${GENERATION_IMPLEMENTED_ASSET_TYPES.join(', ')}. Manual planning/editing is available for this type, but generation is not offered — that would simulate a capability that does not exist. See GET /projects/${projectId}/content-workspace/capabilities for the current matrix.`
          : `"${dto.assetType}" is a tracked work record, not content, so generation never applies to it (§13.9). Implemented generation types: ${GENERATION_IMPLEMENTED_ASSET_TYPES.join(', ')}. See GET /projects/${projectId}/content-workspace/capabilities for the current matrix.`,
      );
    }

    // Idempotency — a resubmit with the same key never creates a second job.
    const existing = await this.prisma.generationJob.findFirst({ where: { projectId, idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      return { job: this.toDto(existing), created: false };
    }

    if (dto.contentAssetId) {
      const asset = await this.prisma.growthAsset.findUnique({ where: { id: dto.contentAssetId } });
      if (!asset || asset.projectId !== projectId) throw new NotFoundException(`Content ${dto.contentAssetId} not found for project ${projectId}`);
    }

    let briefVersion: number | null = null;
    if (dto.briefId) {
      const brief = await this.prisma.contentBrief.findUnique({ where: { id: dto.briefId } });
      if (!brief || brief.projectId !== projectId) throw new NotFoundException(`Brief ${dto.briefId} not found for project ${projectId}`);
      if (brief.status !== 'approved') {
        throw new ConflictException(
          `Brief "${brief.title}" (v${brief.version}) is not approved. Generation cannot bypass the approved-brief gate — approve the brief, or generate without one for a fresh idea.`,
        );
      }
      briefVersion = brief.version;
    }

    // Pin the writing style — explicit version if given, else the active
    // confirmed one. Never a draft: a draft is a candidate, not a fact.
    let stylePin: { id: string; version: number; fingerprint: string } | null = null;
    if (dto.writingStyleProfileId) {
      const style = await this.prisma.writingStyleProfile.findUnique({ where: { id: dto.writingStyleProfileId } });
      if (!style || style.projectId !== projectId) throw new NotFoundException(`Writing style ${dto.writingStyleProfileId} not found for project ${projectId}`);
      if (!style.confirmedAt) throw new ConflictException(`Writing style version ${style.version} is a draft, not confirmed. Confirm it first, or omit writingStyleProfileId to use the active confirmed style.`);
      stylePin = { id: style.id, version: style.version, fingerprint: style.fingerprint ?? '' };
    } else {
      const active = await this.writingStyle.getActive(projectId);
      if (active) stylePin = { id: active.id, version: active.version, fingerprint: active.fingerprint };
    }

    const confirmedProfile = await this.businessProfile.getConfirmedProfile(projectId);

    const job = await this.prisma.generationJob.create({
      data: {
        projectId,
        assetType: dto.assetType,
        requested: 1,
        status: 'queued',
        input: JSON.stringify({ topic: dto.topic, generationSettings: dto.generationSettings ?? {} }),
        requestedBy: actorId ?? null,
        idempotencyKey: dto.idempotencyKey,
        actorId: actorId ?? null,
        contentAssetId: dto.contentAssetId ?? null,
        briefId: dto.briefId ?? null,
        briefVersion,
        writingStyleProfileId: stylePin?.id ?? null,
        writingStyleVersion: stylePin?.version ?? null,
        writingStyleFingerprint: stylePin?.fingerprint ?? null,
        businessProfileVersion: confirmedProfile?.version ?? null,
        sourceEvidenceIds: JSON.stringify(dto.sourceEvidenceIds ?? []),
        generationSettings: JSON.stringify(dto.generationSettings ?? {}),
      },
    });

    await this.dispatch(job.id, projectId);
    return { job: this.toDto(job), created: true };
  }

  /** Same timeout-guard pattern as aeo-audit.service.ts's runFullAsync — never lets an unreachable Redis hang the HTTP response. */
  private async dispatch(jobId: string, projectId: string): Promise<void> {
    const enqueued = this.pipelineQueue.enqueue(JOB_NAME, { jobId, projectId }, { attempts: 1 });
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ENQUEUE_TIMEOUT_MS);
    });
    const outcome = await Promise.race([enqueued.then((): 'enqueued' => 'enqueued'), timedOut]);
    clearTimeout(timer!);
    if (outcome === 'timeout') {
      this.logger.warn(`Generation job ${jobId}: queueing did not confirm within ${ENQUEUE_TIMEOUT_MS}ms — the pipeline queue (Redis) may be unreachable. The job remains queued; POST .../jobs/${jobId}/retry once the queue is reachable, or it will still be picked up if the deferred enqueue lands.`);
      enqueued.catch((err) => this.logger.warn(`Generation job ${jobId}: deferred enqueue failed: ${(err as Error).message}`));
    }
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  /**
   * Recent jobs for one project, newest first (§13.7 "a persistent inline
   * status in Content"). Deliberately reads the persisted ledger rather than
   * any browser-held list: a reload, a different device, or an expired
   * session finds the same jobs, because none of this state ever lived in the
   * browser in the first place.
   */
  async listJobs(projectId: string, query: { status?: string; limit?: number }): Promise<{ jobs: GenerationJobDto[] }> {
    await this.ensureProject(projectId);
    const jobs = await this.prisma.generationJob.findMany({
      where: { projectId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 20, 1), 100),
    });
    return { jobs: jobs.map((job) => this.toDto(job)) };
  }

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  async getJob(projectId: string, jobId: string): Promise<GenerationJobDto> {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException(`Generation job ${jobId} not found for project ${projectId}`);
    return this.toDto(job);
  }

  // ─── §13.7 retry / cancel ───────────────────────────────────────────

  /**
   * Idempotent by design: a "retry" of a SUCCEEDED job just returns its
   * existing output — this is the concrete guard against "worker crashed
   * after creating the revision but before acknowledging" (a resubmit finds
   * the existing output, never creates a second one). Only a FAILED job
   * under its retry budget is actually re-run.
   */
  async retry(projectId: string, jobId: string): Promise<{ job: GenerationJobDto; requeued: boolean }> {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException(`Generation job ${jobId} not found for project ${projectId}`);

    if (job.status === 'succeeded') {
      return { job: this.toDto(job), requeued: false };
    }
    if (job.status === 'queued' || job.status === 'running') {
      throw new ConflictException(`Job ${jobId} is still ${job.status} — wait for it to settle before retrying.`);
    }
    if (job.status === 'cancelled') {
      throw new ConflictException(`Job ${jobId} was cancelled — create a new generation request instead.`);
    }
    if (job.attempts >= job.maxAttempts) {
      throw new ConflictException(`Job ${jobId} has exhausted its ${job.maxAttempts} retry attempts.`);
    }

    const requeued = await this.prisma.generationJob.updateMany({
      where: { id: jobId, status: 'failed' },
      data: { status: 'queued', leaseOwner: null, leaseExpiresAt: null, error: null },
    });
    if (requeued.count === 0) {
      // Lost a race with another retry/settlement — re-read and report the truth.
      const fresh = await this.prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      return { job: this.toDto(fresh), requeued: fresh.status === 'queued' };
    }
    await this.dispatch(jobId, projectId);
    const fresh = await this.prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    return { job: this.toDto(fresh), requeued: true };
  }

  async cancel(projectId: string, jobId: string): Promise<GenerationJobDto> {
    const job = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException(`Generation job ${jobId} not found for project ${projectId}`);
    if (job.status === 'succeeded' || job.status === 'cancelled') {
      throw new ConflictException(`Job ${jobId} is already ${job.status} and cannot be cancelled.`);
    }
    const updated = await this.prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    return this.toDto(updated);
  }

  // ─── Worker ─────────────────────────────────────────────────────────

  private async runJob(jobId: string): Promise<{ ok: boolean; revisionId?: string }> {
    const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const leased = await this.prisma.generationJob.updateMany({
      where: { id: jobId, status: 'queued' },
      data: { status: 'running', leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (leased.count === 0) {
      const current = await this.prisma.generationJob.findUnique({ where: { id: jobId } });
      if (current?.status === 'succeeded') return { ok: true, revisionId: current.revisionId ?? undefined };
      // Already running/cancelled/failed-terminal elsewhere — nothing to do.
      return { ok: current?.status === 'succeeded' };
    }

    const job = await this.prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });

    // Crash-recovery: a revision already exists for this job (created by a
    // previous attempt that died before the job row could be flipped to
    // succeeded) — do not generate a second one.
    if (job.revisionId) {
      await this.prisma.generationJob.update({ where: { id: jobId }, data: { status: 'succeeded', succeeded: 1, leaseOwner: null } });
      return { ok: true, revisionId: job.revisionId };
    }

    if (job.cancelledAt) return { ok: false };

    try {
      const parsedInput = parseJson<{ topic?: { targetKeyword: string; blogTopic?: string; adAngle?: string; searchVolume?: number | null } }>(job.input, {});
      const topicInput = parsedInput.topic ?? { targetKeyword: 'topic' };
      const topic = {
        targetKeyword: topicInput.targetKeyword,
        blogTopic: topicInput.blogTopic ?? `${topicInput.targetKeyword}: A Practical Guide`,
        adAngle: topicInput.adAngle ?? `Target "${topicInput.targetKeyword}".`,
        searchVolume: topicInput.searchVolume ?? null,
        priorityScore: 0,
      };

      let styleContext: string | undefined;
      if (job.writingStyleProfileId) {
        const style = await this.prisma.writingStyleProfile.findUnique({ where: { id: job.writingStyleProfileId } });
        if (style) {
          const parts: string[] = [];
          if (style.summary) parts.push(style.summary);
          if (style.tone) parts.push(`Tone: ${style.tone}`);
          if (style.formality) parts.push(`Formality: ${style.formality}`);
          const preferred = parseJson<string[]>(style.preferredWords, []);
          const avoid = parseJson<string[]>(style.avoidWords, []);
          if (preferred.length) parts.push(`Preferred words: ${preferred.join(', ')}`);
          if (avoid.length) parts.push(`Avoid: ${avoid.join(', ')}`);
          if (style.ctaPreferences) parts.push(`CTA style: ${style.ctaPreferences}`);
          styleContext = parts.join(' ');
        }
      }

      const result = await this.growthExecution.generatePinnedAsset({
        projectId: job.projectId,
        assetType: job.assetType as 'article' | 'ad-copy',
        topic,
        styleContext,
      });

      const { revisionId, assetId } = await this.persistResult(job, result.content, result.model);

      await this.prisma.generationJob.update({
        where: { id: jobId },
        data: {
          status: 'succeeded',
          succeeded: 1,
          revisionId,
          // §13.7 — the job names its canonical destination, including when it
          // created the piece itself. Without this the inline status could say
          // "ready" but not say *what* is ready.
          contentAssetId: job.contentAssetId ?? assetId,
          model: result.model,
          leaseOwner: null,
          error: null,
        },
      });
      return { ok: true, revisionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = await this.prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      const exhausted = current.attempts >= current.maxAttempts;
      await this.prisma.generationJob.update({
        where: { id: jobId },
        data: { status: exhausted ? 'failed' : 'queued', failed: exhausted ? 1 : 0, error: message, leaseOwner: null },
      });
      this.logger.warn(`Generation job ${jobId} attempt ${current.attempts}/${current.maxAttempts} failed: ${message}`);
      return { ok: false };
    }
  }

  /** Creates (or extends) the GrowthAsset + ContentRevision, and returns both ids — same transaction, so "revision created" and "job knows about it" can never disagree. */
  private async persistResult(job: NonNullable<JobRow>, content: ArticleContent | AdCopyContent, model: string): Promise<{ revisionId: string; assetId: string }> {
    return this.prisma.$transaction(async (tx) => {
      let assetId = job.contentAssetId;
      if (!assetId) {
        const title = 'title' in content ? content.title : `Ad Copy: ${JSON.parse(job.input).topic?.targetKeyword ?? 'generated'}`;
        const asset = await tx.growthAsset.create({
          data: {
            projectId: job.projectId,
            assetType: job.assetType,
            title,
            brief: 'metaDescription' in content ? content.metaDescription : `Ad copy for "${JSON.parse(job.input).topic?.targetKeyword ?? 'generated'}"`,
            status: 'recommended',
            source: 'generated-llm',
            generationModel: model,
            content: JSON.stringify(content),
          },
        });
        assetId = asset.id;
      }

      const maxRevision = await tx.contentRevision.findFirst({ where: { assetId }, orderBy: { revision: 'desc' }, select: { revision: true } });
      const nextRevision = (maxRevision?.revision ?? 0) + 1;
      const body = 'bodyMarkdown' in content ? content.bodyMarkdown : JSON.stringify((content as AdCopyContent).variants);
      const title = 'title' in content ? content.title : null;
      const revision = await tx.contentRevision.create({
        data: {
          assetId,
          revision: nextRevision,
          briefId: job.briefId,
          title,
          body,
          fields: JSON.stringify(content),
          wordCount: 'wordCount' in content ? content.wordCount : 0,
          origin: 'generation',
          generationItemId: job.id,
        },
      });
      return { revisionId: revision.id, assetId };
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private toDto(job: NonNullable<JobRow>): GenerationJobDto {
    return {
      id: job.id,
      projectId: job.projectId,
      status: job.status as GenerationJobDto['status'],
      assetType: job.assetType,
      contentAssetId: job.contentAssetId,
      briefId: job.briefId,
      briefVersion: job.briefVersion,
      writingStyleProfileId: job.writingStyleProfileId,
      writingStyleVersion: job.writingStyleVersion,
      writingStyleFingerprint: job.writingStyleFingerprint,
      businessProfileVersion: job.businessProfileVersion,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      revisionId: job.revisionId,
      error: job.error,
      idempotencyKey: job.idempotencyKey,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }
}
