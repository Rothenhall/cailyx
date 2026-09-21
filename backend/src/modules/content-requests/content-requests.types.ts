/**
 * Content Requests Types — the client's structured "request new content"
 * form (client-portal.md §14, §22; PLAN.md §11.4 Phase C4).
 *
 * @module content-requests.types
 */

export type ContentRequestPriority = 'low' | 'normal' | 'high';

export interface ContentRequestDto {
  id: string;
  projectId: string;
  clientId: string;
  requestedByUserId: string;
  contentType: string;
  topic: string;
  priority: ContentRequestPriority;
  note: string | null;
  growthAssetId: string;
  createdAt: string;
}

export interface CreateContentRequestInput {
  projectId: string;
  clientId: string;
  requestedByUserId: string;
  contentType: string;
  topic: string;
  priority?: ContentRequestPriority;
  note?: string;
}
