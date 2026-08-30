/**
 * QuerySet Service — Versioned buyer prompt set builder (SOP-1 / PRD FR-5).
 *
 * A QuerySet is a versioned list of natural-language buyer prompts, tagged by
 * persona (problem/solution/product/most-aware) and funnel stage. Immutable
 * once activated — mutations happen on drafts; editing an active set means
 * forking a new version. The subject (project) owns the set and can export it;
 * per the design principle "the query set is the asset."
 *
 * Seeded from real sources where available (sales questions, support tickets)
 * in paid tiers, manual on free tier.
 *
 * @module query-set.service
 */

import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { PromptPersona, QuerySetStatus, FunnelStage, QuerySetSource } from './query-set.types';

/** Input for creating a new (version 1, draft) query set. */
export interface CreateQuerySetInput {
  projectId: string;
  persona: PromptPersona;
  label?: string;
  source?: QuerySetSource;
  /** Optional first prompt to seed the set with. */
  prompt?: string;
  funnelStage?: FunnelStage;
}

/** Input for adding a prompt to a draft query set. */
export interface AddPromptInput {
  prompt: string;
  funnelStage: FunnelStage;
}

/**
 * Segment-inclusion validation rules — TS layer mirrors DTO `IsIn` checks.
 */
const PERSONAS: readonly PromptPersona[] = [
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

const FUNNEL_STAGES: readonly FunnelStage[] = [
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

@Injectable()
export class QuerySetService {
  private readonly logger = new Logger(QuerySetService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List all query sets for a project (newest first), each with its items.
   * @param projectId Project the sets belong to.
   * @param status Optional status filter (draft | active | archived).
   */
  async list(projectId: string, status?: QuerySetStatus) {
    return this.prisma.querySet.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      include: { items: true },
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Get one query set with its items.
   * @throws NotFoundException when the set does not exist.
   */
  async get(id: string) {
    const qs = await this.prisma.querySet.findUnique({ where: { id }, include: { items: true } });
    if (!qs) throw new NotFoundException('Query set not found: ' + id);
    return qs;
  }

  /**
   * Create a new query set at version 1 in draft status. Optionally seeds a
   * first prompt. Version 2+ is only reachable via {@link fork}.
   * @throws ConflictException when a v1 set already exists for this project + persona.
   * @throws NotFoundException when the project does not exist.
   */
  async create(input: CreateQuerySetInput) {
    await this.ensureProject(input.projectId);

    const existing = await this.prisma.querySet.findUnique({
      where: {
        projectId_version_persona: {
          projectId: input.projectId,
          version: 1,
          persona: input.persona,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        `Query set exists (projectId=${input.projectId}, v1, persona=${input.persona}). ` +
          'Fork the existing set to create a new version.',
      );
    }

    const created = await this.prisma.querySet.create({
      data: {
        projectId: input.projectId,
        version: 1,
        persona: input.persona,
        label: input.label ?? null,
        status: 'draft',
        source: input.source ?? 'manual',
      },
    });

    if (input.prompt) {
      await this.prisma.querySetItem.create({
        data: {
          querySetId: created.id,
          prompt: input.prompt,
          funnelStage: input.funnelStage ?? input.persona,
        },
      });
    }

    this.logger.log(`Query set created (project=${input.projectId}, persona=${input.persona}, v1)`);
    return this.get(created.id);
  }

  /**
   * Add a prompt to a draft query set.
   * @throws NotFoundException when the set does not exist.
   * @throws ConflictException when the set is not a draft.
   */
  async addPrompt(id: string, input: AddPromptInput) {
    await this.ensureDraft(id);
    return this.prisma.querySetItem.create({
      data: {
        querySetId: id,
        prompt: input.prompt,
        funnelStage: input.funnelStage,
      },
    });
  }

  /**
   * Remove a prompt from a draft query set.
   * @throws NotFoundException when the set or item does not exist.
   * @throws ConflictException when the set is not a draft.
   */
  async removePrompt(id: string, itemId: string) {
    await this.ensureDraft(id);
    const item = await this.prisma.querySetItem.findUnique({ where: { id: itemId } });
    if (!item || item.querySetId !== id) {
      throw new NotFoundException('Query set item not found: ' + itemId);
    }
    await this.prisma.querySetItem.delete({ where: { id: itemId } });
    return { removed: itemId };
  }

  /**
   * Activate a draft set — makes it immutable. Surfaces then measure against
   * this exact version. Requires at least one prompt.
   * @throws NotFoundException when the set does not exist.
   * @throws ConflictException when already active or empty.
   */
  async activate(id: string) {
    const qs = await this.ensureDraft(id);
    const itemCount = await this.prisma.querySetItem.count({ where: { querySetId: id } });
    if (itemCount === 0) {
      throw new ConflictException('Cannot activate an empty query set (id=' + id + ').');
    }
    const activated = await this.prisma.querySet.update({
      where: { id },
      data: { status: 'active', activatedAt: new Date() },
      include: { items: true },
    });
    this.logger.log(`Query set ${id} activated (project=${qs.projectId}, v${activated.version}, ${activated.items.length} prompts)`);
    return activated;
  }

  /**
   * Fork an existing set into the next version of the same project + persona.
   * The new version is a fresh draft pre-populated with every prompt of the
   * source — edit the draft, then activate to replace the measured baseline.
   * @throws NotFoundException when the source set does not exist.
   * @throws ConflictException when the source is itself an unactivated draft.
   */
  async fork(id: string) {
    const src = await this.prisma.querySet.findUnique({ where: { id }, include: { items: true } });
    if (!src) throw new NotFoundException('Query set not found: ' + id);
    if (src.status === 'draft') {
      throw new ConflictException(
        'Source v' + src.version + ' is still a draft — edit it in place instead of forking.',
      );
    }

    const prev = await this.prisma.querySet.findFirst({
      where: { projectId: src.projectId, persona: src.persona },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (prev?.version ?? 0) + 1;

    const forked = await this.prisma.querySet.create({
      data: {
        projectId: src.projectId,
        version: nextVersion,
        persona: src.persona,
        label: src.label,
        status: 'draft',
        source: src.source,
      },
    });

    for (const item of src.items) {
      await this.prisma.querySetItem.create({
        data: {
          querySetId: forked.id,
          prompt: item.prompt,
          funnelStage: item.funnelStage as FunnelStage,
        },
      });
    }

    this.logger.log(`Query set ${id} forked v${src.version} -> v${nextVersion}`);
    return this.get(forked.id);
  }

  /**
   * Export every query set of a project with all prompts — the client owns
   * the artifact. JSON shape is import-friendly (flat prompt rows via items).
   * @param projectId Project to export.
   */
  async export(projectId: string) {
    await this.ensureProject(projectId);
    return this.prisma.querySet.findMany({
      where: { projectId },
      include: { items: true },
      orderBy: [{ persona: 'asc' }, { version: 'desc' }],
    });
  }

  /**
   * Validate an incoming persona value against the Segment persona union.
   * @returns The value narrowed to {@link PromptPersona}, or undefined when invalid.
   */
  isPersona(value: unknown): value is PromptPersona {
    return PERSONAS.includes(value as PromptPersona);
  }

  /**
   * Validate an incoming funnel-stage value.
   * @returns The value narrowed to {@link FunnelStage}, or undefined when invalid.
   */
  isFunnelStage(value: unknown): value is FunnelStage {
    return FUNNEL_STAGES.includes(value as FunnelStage);
  }

  /**
   * Fetch the owning project or 404 — every query set hangs off a Project.
   */
  private async ensureProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return project;
  }

  /**
   * Fetch a set and assert it is still a draft (drafts are the only mutable
   * state; active sets fork instead).
   */
  private async ensureDraft(id: string) {
    const qs = await this.prisma.querySet.findUnique({ where: { id } });
    if (!qs) throw new NotFoundException('Query set not found: ' + id);
    if (qs.status !== 'draft') {
      throw new ConflictException(
        `Query set ${id} is ${qs.status} — immutable. Fork it to create a new version.`,
      );
    }
    return qs;
  }
}