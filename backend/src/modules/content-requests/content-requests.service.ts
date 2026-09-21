/**
 * Content Requests Service — the client's structured "request new content"
 * form (client-portal.md §14, §22; PLAN.md §11.4 Phase C4).
 *
 * Per §22's explicit decision, a request becomes a real `content-workspace`
 * item (a `GrowthAsset`) **immediately** — there is no separate triage inbox
 * an operator must convert first. `GrowthExecutionService.createFromClientRequest`
 * does the actual asset creation (mirrors its existing `createFromOpportunity`,
 * including its create-then-link two-step shape); this service validates the
 * structured-form input and links the two rows.
 *
 * @module content-requests.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GrowthExecutionService } from '../growth-execution/growth-execution.service';
import { CONTENT_WORKSPACE_ASSET_TYPES } from '../content-workspace/content-workspace.types';
import type { AssetType } from '../growth-execution/growth-execution.types';
import type { ContentRequestDto, ContentRequestPriority, CreateContentRequestInput } from './content-requests.types';

@Injectable()
export class ContentRequestsService {
  private readonly logger = new Logger(ContentRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly growthExecution: GrowthExecutionService,
  ) {}

  /**
   * Create a structured content request. Validates `contentType` against the
   * workspace's own asset-type taxonomy (`CONTENT_WORKSPACE_ASSET_TYPES`) —
   * never a separately invented list — then creates the `GrowthAsset`
   * directly via `GrowthExecutionService.createFromClientRequest` and links
   * it back onto the `ContentRequest` row (`growthAssetId`).
   */
  async create(input: CreateContentRequestInput): Promise<ContentRequestDto> {
    if (!(CONTENT_WORKSPACE_ASSET_TYPES as readonly string[]).includes(input.contentType)) {
      throw new BadRequestException(
        `Unknown content type "${input.contentType}" — must be one of ${CONTENT_WORKSPACE_ASSET_TYPES.join(', ')}`,
      );
    }
    const topic = input.topic.trim();
    if (!topic) throw new BadRequestException('topic is required');

    const project = await this.prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${input.projectId} not found`);

    // Same create-then-link shape as `OpportunitiesService.convertToContent`
    // -> `GrowthExecutionService.createFromOpportunity`: the request needs
    // the asset's id, and the asset needs the request's id
    // (`sourceClientRequestId`), so one must be created first and the other
    // patched. §22's requirement is satisfied either way — the asset exists
    // immediately, not after a separate triage/approval step.
    const request = await this.prisma.contentRequest.create({
      data: {
        projectId: input.projectId,
        clientId: input.clientId,
        requestedByUserId: input.requestedByUserId,
        contentType: input.contentType,
        topic,
        priority: input.priority ?? 'normal',
        note: input.note ?? null,
        growthAssetId: null,
      },
    });

    const asset = await this.growthExecution.createFromClientRequest(input.projectId, {
      sourceClientRequestId: request.id,
      assetType: input.contentType as AssetType,
      title: topic,
      brief: input.note?.trim() ? input.note.trim() : `Client-requested ${input.contentType}: ${topic}`,
      targetKeyword: topic,
    });

    const created = await this.prisma.contentRequest.update({
      where: { id: request.id },
      data: { growthAssetId: asset.id },
    });

    this.logger.log(
      `Content request ${created.id} created (project=${input.projectId}, type=${input.contentType}) -> asset ${created.growthAssetId}`,
    );
    return this.toDto(created);
  }

  async list(projectId: string): Promise<ContentRequestDto[]> {
    const rows = await this.prisma.contentRequest.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  async listForClient(clientId: string, projectId: string): Promise<ContentRequestDto[]> {
    const rows = await this.prisma.contentRequest.findMany({
      where: { clientId, projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  private toDto(row: {
    id: string;
    projectId: string;
    clientId: string;
    requestedByUserId: string;
    contentType: string;
    topic: string;
    priority: string;
    note: string | null;
    growthAssetId: string | null;
    createdAt: Date;
  }): ContentRequestDto {
    return {
      id: row.id,
      projectId: row.projectId,
      clientId: row.clientId,
      requestedByUserId: row.requestedByUserId,
      contentType: row.contentType,
      topic: row.topic,
      priority: row.priority as ContentRequestPriority,
      note: row.note,
      // Never actually null by the time a caller sees this row through
      // `create`/`list`/`listForClient` — the brief window is internal to
      // `create` above. Falling back to '' rather than widening the DTO's
      // public type to `string | null` for a state that should not be
      // observable.
      growthAssetId: row.growthAssetId ?? '',
      createdAt: row.createdAt.toISOString(),
    };
  }
}
