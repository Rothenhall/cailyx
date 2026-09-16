/**
 * MessageThreadsService — G08 cursor-paginated reads over the existing
 * `ClientMessage` thread (owned/written by the `clients` and `client-portal`
 * modules), plus per-user read cursors.
 *
 * This module does not own ClientMessage and does not write to it — it only
 * adds a read path with pagination, safe author display names and real read
 * state on top of the existing append-only thread. See README.md for the
 * one thing this module could not do itself (an `internal` write endpoint)
 * because that belongs to `clients`/`client-portal`.
 *
 * Internal-note exclusion for client reads is enforced in the WHERE clause
 * of `forClient`, never in the DTO mapping — an internal row must never be
 * fetched in the first place for a client-scoped read.
 *
 * @module message-threads.service
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { ReadCursorDto, SafeAuthorDto, ThreadMessageDto, ThreadPageDto } from './notifications.types';

@Injectable()
export class MessageThreadsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Operator-side read: sees internal notes and client messages both. */
  async forOperator(
    clientId: string,
    caller: { userId: string },
    opts: { limit?: number; cursor?: string; projectId?: string },
  ): Promise<ThreadPageDto> {
    return this.readThread(clientId, caller.userId, opts, /* includeInternal */ true);
  }

  /** Client-portal read: internal notes are excluded at the query level, never post-filtered. */
  async forClient(
    clientId: string,
    caller: { userId: string },
    opts: { limit?: number; cursor?: string; projectId?: string },
  ): Promise<ThreadPageDto> {
    return this.readThread(clientId, caller.userId, opts, /* includeInternal */ false);
  }

  async markRead(clientId: string, userId: string, lastReadMessageId?: string): Promise<ReadCursorDto> {
    const now = new Date();
    let resolvedMessageId = lastReadMessageId ?? null;
    if (!resolvedMessageId) {
      const latest = await this.prisma.clientMessage.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      resolvedMessageId = latest?.id ?? null;
    } else {
      const exists = await this.prisma.clientMessage.findUnique({ where: { id: resolvedMessageId }, select: { clientId: true } });
      if (!exists || exists.clientId !== clientId) throw new NotFoundException(`Message ${resolvedMessageId} not found in this thread`);
    }

    const row = await this.prisma.messageReadCursor.upsert({
      where: { userId_clientId: { userId, clientId } },
      create: { userId, clientId, lastReadAt: now, lastReadMessageId: resolvedMessageId },
      update: { lastReadAt: now, lastReadMessageId: resolvedMessageId },
    });
    return { clientId: row.clientId, lastReadAt: row.lastReadAt.toISOString(), lastReadMessageId: row.lastReadMessageId };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async readThread(
    clientId: string,
    userId: string,
    opts: { limit?: number; cursor?: string; projectId?: string },
    includeInternal: boolean,
  ): Promise<ThreadPageDto> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const cursorRow = opts.cursor
      ? await this.prisma.clientMessage.findUnique({ where: { id: opts.cursor }, select: { createdAt: true } })
      : null;

    const rows = await this.prisma.clientMessage.findMany({
      where: {
        clientId,
        ...(includeInternal ? {} : { internal: false }),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(cursorRow ? { createdAt: { lt: cursorRow.createdAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1]?.id ?? null : null;

    const authorIds = Array.from(new Set(page.map((r) => r.authorUserId)));
    const authors = authorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, type: true } })
      : [];
    const authorById = new Map(authors.map((a) => [a.id, a]));

    const cursor = await this.prisma.messageReadCursor.findUnique({ where: { userId_clientId: { userId, clientId } } });
    const unreadCount = await this.prisma.clientMessage.count({
      where: {
        clientId,
        ...(includeInternal ? {} : { internal: false }),
        createdAt: cursor ? { gt: cursor.lastReadAt } : undefined,
      },
    });

    // Chronological ascending in the response (oldest-first, matching the
    // existing listMessages contract); pagination walks backward in time via
    // `cursor`, so re-reverse after slicing the descending page.
    const messages = [...page].reverse().map((r) => this.toDto(r, authorById.get(r.authorUserId)));

    return { messages, nextCursor, unreadCount };
  }

  private toDto(
    row: { id: string; clientId: string; projectId: string | null; authorUserId: string; authorType: string; body: string; createdAt: Date },
    author: { id: string; name: string; type: string } | undefined,
  ): ThreadMessageDto {
    return {
      id: row.id,
      clientId: row.clientId,
      projectId: row.projectId,
      author: this.safeAuthor(row.authorUserId, row.authorType, author),
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Safe display name: an operator's real name is fine to show a client
   * ("Jordan from Rothenhall replied"), but never their raw email. A
   * client's own author label is their contact name only, never surfaced to
   * other clients (this method is only ever called within one client's own
   * thread, so that cross-client leak is structurally impossible here).
   * If the User row is gone (deleted login), fall back to a role label
   * rather than an id.
   */
  private safeAuthor(userId: string, authorType: string, user: { id: string; name: string; type: string } | undefined): SafeAuthorDto {
    const displayName = user?.name ?? (authorType === 'operator' ? 'Rothenhall team' : 'Client');
    return { userId, authorType: authorType as SafeAuthorDto['authorType'], displayName };
  }
}
