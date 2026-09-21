/**
 * Prompt Requests Types — the lightweight prompt add/delete request queue
 * (client-portal.md §13, §20, PLAN.md §11.4 Phase C4).
 *
 * Deliberately NOT the Approval primitive (§9/§10): the client proposes a
 * new prompt or flags an existing one for removal, it lands in a simple
 * admin-facing queue, and an admin acts on it directly using the existing
 * `query-set` module's own edit/versioning mechanics (fork -> add/remove ->
 * activate). This module only tracks the request and its quota context —
 * it never mutates a QuerySet itself.
 *
 * @module prompt-requests.types
 */

export type PromptRequestAction = 'add' | 'remove';
export type PromptRequestStatus = 'pending' | 'approved' | 'declined';

/** §20 — Starter/Growth/Scale/Enterprise tracked-prompt limits. */
export type PlanTierSlug = 'starter' | 'growth' | 'scale' | 'enterprise';

export interface PromptRequestDto {
  id: string;
  projectId: string;
  clientId: string;
  requestedByUserId: string;
  action: PromptRequestAction;
  prompt: string | null;
  persona: string | null;
  targetItemId: string | null;
  targetPromptText: string | null;
  note: string | null;
  status: PromptRequestStatus;
  activePromptCount: number;
  planPromptLimit: number | null;
  planTier: PlanTierSlug;
  overQuota: boolean;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  resultQuerySetItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePromptRequestInput {
  projectId: string;
  clientId: string;
  requestedByUserId: string;
  action: PromptRequestAction;
  prompt?: string;
  persona?: string;
  targetItemId?: string;
  note?: string;
}

export interface DecidePromptRequestInput {
  decidedByUserId: string;
  decision: 'approved' | 'declined';
  decisionNote?: string;
  resultQuerySetItemId?: string;
}
