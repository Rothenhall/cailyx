/**
 * Attribution Service — self-reported acquisition source.
 *
 * The buyer tells you where they came from. This exists because the inferred
 * signal is structurally broken: AI referrals mostly land as Direct in
 * analytics, and agentic browsers present as ordinary Chrome at the HTTP
 * layer, so no amount of log parsing recovers them. Asking is the only channel
 * that survives — and it is the one number a CFO accepts.
 *
 * @module attribution.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AI_SOURCES } from './attribution.types';
import type { AttributionResponseDto, AttributionSummary } from './attribution.types';

@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one self-reported answer. Called by the public endpoint, so it
   * validates the project exists but reveals nothing about it to the caller.
   * @throws NotFoundException when the project id does not resolve.
   */
  async capture(
    projectId: string,
    input: { source: string; prompt?: string; note?: string; contactEmail?: string; page?: string },
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');

    await this.prisma.attributionResponse.create({
      data: {
        projectId,
        source: input.source,
        prompt: input.prompt?.trim() || null,
        note: input.note?.trim() || null,
        contactEmail: input.contactEmail?.trim() || null,
        page: input.page?.trim() || null,
      },
    });
    this.logger.log(`Attribution captured for ${projectId}: ${input.source}`);
  }

  /** Every response for a project, newest first. */
  async list(projectId: string, take = 200): Promise<AttributionResponseDto[]> {
    const rows = await this.prisma.attributionResponse.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 500),
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * The roll-up the console reads: how many said an AI assistant sent them,
   * the split by source, and the prompts they reported using.
   */
  async summary(projectId: string): Promise<AttributionSummary> {
    const rows = await this.prisma.attributionResponse.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const total = rows.length;
    const aiTotal = rows.filter((r) => AI_SOURCES.includes(r.source)).length;

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);

    const bySource = [...counts.entries()]
      .map(([source, count]) => ({ source, count, share: total ? count / total : 0 }))
      .sort((a, b) => b.count - a.count);

    const prompts = rows
      .filter((r) => r.prompt && r.prompt.trim().length > 0)
      .slice(0, 25)
      .map((r) => ({ prompt: r.prompt as string, source: r.source, createdAt: r.createdAt.toISOString() }));

    return {
      total,
      aiTotal,
      aiShare: total ? aiTotal / total : 0,
      bySource,
      prompts,
      recent: rows.slice(0, 12).map((r) => this.toDto(r)),
      firstAt: total ? rows[rows.length - 1].createdAt.toISOString() : null,
      lastAt: total ? rows[0].createdAt.toISOString() : null,
    };
  }

  private toDto(r: {
    id: string;
    source: string;
    prompt: string | null;
    note: string | null;
    contactEmail: string | null;
    page: string | null;
    createdAt: Date;
  }): AttributionResponseDto {
    return {
      id: r.id,
      source: r.source,
      prompt: r.prompt,
      note: r.note,
      contactEmail: r.contactEmail,
      page: r.page,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
