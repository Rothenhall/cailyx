/**
 * Types for the Notifications module (G08) — notification inbox,
 * preferences, message-thread read state and attachments.
 *
 * @module notifications.types
 */

/** Kinds a Notification row can carry. Kept as a plain string in Prisma (SQLite has no enums). */
export type NotificationKind =
  | 'work-assigned'
  | 'approval-requested'
  | 'report-released'
  | 'run-failed'
  | 'message-received'
  | 'alert-raised'
  | 'request-due';

export interface NotificationDto {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  clientId: string | null;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceDto {
  kind: NotificationKind;
  inApp: boolean;
  email: boolean;
}

/** A safe, client-facing author label — never an operator's raw email. */
export interface SafeAuthorDto {
  userId: string;
  authorType: 'operator' | 'client';
  displayName: string;
}

export interface ThreadMessageDto {
  id: string;
  clientId: string;
  projectId: string | null;
  author: SafeAuthorDto;
  body: string;
  createdAt: string;
}

export interface ThreadPageDto {
  messages: ThreadMessageDto[];
  /** Opaque cursor to pass back as `?cursor=` for the next (older) page; null when no more pages. */
  nextCursor: string | null;
  /** This caller's real unread count for the thread, derived from MessageReadCursor — never guessed. */
  unreadCount: number;
}

export interface ReadCursorDto {
  clientId: string;
  lastReadAt: string;
  lastReadMessageId: string | null;
}

export interface AttachmentDto {
  id: string;
  clientId: string | null;
  projectId: string | null;
  contextType: string;
  contextId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  visibility: 'operator-only' | 'client-visible';
  uploadedBy: string;
  createdAt: string;
}

export interface DownloadedFileDto {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}
