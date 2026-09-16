/**
 * NotificationsService — G08 notification inbox and per-user preferences.
 *
 * Other modules call `record()` to raise a notification (e.g. work-assigned,
 * approval-requested, report-released). It is deliberately idempotent per
 * (userId, kind, resourceType, resourceId): a retried caller (job retry,
 * at-least-once webhook, double-click) that raises the same notification
 * again does not create a second unread row for the same event — see
 * `findExistingUnread` below. Pass an explicit `dedupeKey` when the same
 * (userId, kind, resource) legitimately recurs (e.g. daily digest ticks).
 *
 * @module notifications.service
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { NotificationDto, NotificationKind, NotificationPreferenceDto } from './notifications.types';

export interface RecordNotificationInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  /**
   * When true (default), a retry that matches an existing UNREAD
   * notification for the same (userId, kind, resourceType, resourceId) is
   * treated as the same send and returns the existing row instead of
   * inserting a duplicate. Set false only for notifications that
   * legitimately recur (e.g. periodic digests) and are expected to stack.
   */
  dedupe?: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(protected readonly prisma: PrismaService) {}

  // ─── Raising notifications (called by other modules) ──────────────

  /**
   * Create (or, for a duplicate retry, return) a notification. This is the
   * one entry point other G01-G20 packages should use to notify a user —
   * exported from NotificationsModule for injection.
   */
  async record(input: RecordNotificationInput): Promise<NotificationDto> {
    const dedupe = input.dedupe ?? true;
    if (dedupe && input.resourceType && input.resourceId) {
      const existing = await this.prisma.notification.findFirst({
        where: {
          userId: input.userId,
          kind: input.kind,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          readAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return this.toDto(existing);
    }

    const row = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
      },
    });
    return this.toDto(row);
  }

  // ─── Inbox ──────────────────────────────────────────────────────────

  async list(
    userId: string,
    opts: { unreadOnly?: boolean; limit?: number; cursor?: string },
  ): Promise<{ notifications: NotificationDto[]; nextCursor: string | null; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(opts.unreadOnly ? { readAt: null } : {}),
        ...(opts.cursor ? { createdAt: { lt: await this.cursorTimestamp(opts.cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1]?.id ?? null : null;
    const unreadCount = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { notifications: page.map((r) => this.toDto(r)), nextCursor, unreadCount };
  }

  /** Marking-read is idempotent: an already-read notification just returns its existing readAt. */
  async markRead(userId: string, notificationId: string): Promise<NotificationDto> {
    const row = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!row || row.userId !== userId) throw new NotFoundException(`Notification ${notificationId} not found`);
    if (row.readAt) return this.toDto(row);
    const updated = await this.prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
    return this.toDto(updated);
  }

  // ─── Preferences ────────────────────────────────────────────────────

  async getPreferences(userId: string): Promise<{ preferences: NotificationPreferenceDto[] }> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    return {
      preferences: rows.map((r) => ({ kind: r.kind as NotificationKind, inApp: r.inApp, email: r.email })),
    };
  }

  async putPreferences(
    userId: string,
    preferences: { kind: NotificationKind; inApp: boolean; email: boolean }[],
  ): Promise<{ preferences: NotificationPreferenceDto[] }> {
    // Upsert one row per kind — a PUT of the whole preference set is the
    // documented contract, so this is deliberately not a delete-then-insert
    // (which would race a concurrent read into seeing zero preferences).
    await Promise.all(
      preferences.map((p) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_kind: { userId, kind: p.kind } },
          create: { userId, kind: p.kind, inApp: p.inApp, email: p.email },
          update: { inApp: p.inApp, email: p.email },
        }),
      ),
    );
    return this.getPreferences(userId);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async cursorTimestamp(cursor: string): Promise<Date> {
    const row = await this.prisma.notification.findUnique({ where: { id: cursor }, select: { createdAt: true } });
    return row?.createdAt ?? new Date();
  }

  private toDto(row: {
    id: string;
    userId: string;
    kind: string;
    title: string;
    body: string | null;
    href: string | null;
    clientId: string | null;
    projectId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: row.id,
      userId: row.userId,
      kind: row.kind as NotificationKind,
      title: row.title,
      body: row.body,
      href: row.href,
      clientId: row.clientId,
      projectId: row.projectId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
