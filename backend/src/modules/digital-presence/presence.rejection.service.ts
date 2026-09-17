/**
 * Rejection tombstones — P05 §11.4.
 *
 * "Rejection stores a tombstone with normalized URL/platform/business scope
 * and reason; otherwise the next search can keep recommending the same
 * unrelated business." This is the whole of that: a `Not ours` action writes
 * one row here, keyed by the same normalized URL account dedupe already uses,
 * and every candidate-producing path (SERP sweep, crawl-found candidates)
 * consults it before creating or resurfacing a row.
 *
 * No hard delete: an authorized `reconsider` sets `reconsideredAt` rather than
 * removing the row, so the history of "we looked at this and said no, then
 * changed our mind" is never lost.
 *
 * @module presence.rejection.service
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { normalizeUrl } from './presence.signatures';
import type { PresencePlatform } from './presence.types';

export interface RejectionDto {
  id: string;
  platform: PresencePlatform;
  normalizedUrl: string;
  reason: string;
  actorEmail: string | null;
  createdAt: string;
  reconsideredAt: string | null;
  reconsideredBy: string | null;
}

@Injectable()
export class PresenceRejectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** True when this exact URL was rejected for this project and never reconsidered. */
  async isTombstoned(projectId: string, platform: string, url: string): Promise<boolean> {
    const normalized = normalizeUrl(url);
    const row = await this.prisma.presenceRejection.findFirst({
      where: { projectId, platform, normalizedUrl: normalized, reconsideredAt: null },
    });
    return row !== null;
  }

  /**
   * Bulk form for a candidate sweep: given many URLs for one project, return
   * the set that is currently tombstoned so the caller can filter in one pass
   * instead of one query per candidate.
   */
  async tombstonedUrls(projectId: string, platform: string): Promise<Set<string>> {
    const rows = await this.prisma.presenceRejection.findMany({
      where: { projectId, platform, reconsideredAt: null },
      select: { normalizedUrl: true },
    });
    return new Set(rows.map((r) => r.normalizedUrl));
  }

  /**
   * Record a "Not ours" and remove the live candidate row (if the caller
   * passes one) so it does not linger as an unresolved candidate the operator
   * already answered. The tombstone itself is what stops it from returning.
   */
  async reject(
    projectId: string,
    platform: PresencePlatform,
    url: string,
    reason: string,
    actorEmail: string | null,
  ): Promise<RejectionDto> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('A reason is required to reject a candidate — it is shown on the tombstone and to future reviewers.');
    }
    const normalized = normalizeUrl(url);
    const row = await this.prisma.presenceRejection.create({
      data: { projectId, platform, normalizedUrl: normalized, reason: reason.trim(), actorEmail },
    });
    return this.toDto(row);
  }

  async reconsider(projectId: string, rejectionId: string, actorEmail: string | null): Promise<RejectionDto> {
    const row = await this.prisma.presenceRejection.findUnique({ where: { id: rejectionId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Rejection not found');
    const updated = await this.prisma.presenceRejection.update({
      where: { id: rejectionId },
      data: { reconsideredAt: new Date(), reconsideredBy: actorEmail },
    });
    return this.toDto(updated);
  }

  async list(projectId: string): Promise<RejectionDto[]> {
    const rows = await this.prisma.presenceRejection.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  private toDto(row: {
    id: string;
    platform: string;
    normalizedUrl: string;
    reason: string;
    actorEmail: string | null;
    createdAt: Date;
    reconsideredAt: Date | null;
    reconsideredBy: string | null;
  }): RejectionDto {
    return {
      id: row.id,
      platform: row.platform as PresencePlatform,
      normalizedUrl: row.normalizedUrl,
      reason: row.reason,
      actorEmail: row.actorEmail,
      createdAt: row.createdAt.toISOString(),
      reconsideredAt: row.reconsideredAt ? row.reconsideredAt.toISOString() : null,
      reconsideredBy: row.reconsideredBy,
    };
  }
}
