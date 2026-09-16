/**
 * Types for the Activity module (G15) — append-only activity/provenance/
 * audit trail.
 *
 * @module activity.types
 */

export type ActorType = 'user' | 'system' | 'scheduler' | 'webhook';

export type ActivityAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'released'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'sent'
  | 'started'
  | 'cancelled'
  | 'granted'
  | 'revoked'
  | 'logged-in';

export type ActivityOrigin = 'api' | 'ui' | 'scheduler' | 'webhook';
export type ActivityResult = 'success' | 'failure';

export interface ActivityEventDto {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: ActivityAction;
  resourceType: string;
  resourceId: string | null;
  resourceVersion: string | null;
  clientId: string | null;
  projectId: string | null;
  summary: string | null;
  /** Parsed JSON — already redacted by RecordActivityInput.changes before it was ever written. */
  changes: Record<string, unknown>;
  result: ActivityResult;
  requestId: string | null;
  jobRunId: string | null;
  origin: ActivityOrigin;
  clientVisible: boolean;
  createdAt: string;
}

export interface ActivityPageDto {
  events: ActivityEventDto[];
  nextCursor: string | null;
}
