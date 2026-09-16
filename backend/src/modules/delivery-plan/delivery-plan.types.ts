/**
 * Shared types, status vocabularies and transition rules for G06 —
 * engagements, cycles, work items, capacity and verification.
 *
 * SQLite has no enums: every status column is a `String` whose permitted
 * values are documented on the Prisma model and re-validated here before
 * any write. This file is the single source of truth for those transition
 * tables so the controller/service never accepts an arbitrary status jump.
 *
 * @module delivery-plan.types
 */

/** Engagement.status */
export type EngagementStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = ['active', 'paused', 'completed', 'cancelled'];

/** Engagement.serviceTier */
export const SERVICE_TIERS = ['scorecard', 'diagnostic', 'sprint', 'retainer'] as const;

/** Cycle.status — planning -> committed -> active -> review -> closed. */
export type CycleStatus = 'planning' | 'committed' | 'active' | 'review' | 'closed';
export const CYCLE_STATUSES: readonly CycleStatus[] = ['planning', 'committed', 'active', 'review', 'closed'];

/** Forward-only cycle transitions. Committing is a separate, dedicated action
 * (POST .../commit) — never reachable through the generic status PATCH,
 * because commit also freezes committedCount/committedAt. */
export const CYCLE_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  planning: ['committed'],
  committed: ['active'],
  active: ['review'],
  review: ['closed'],
  closed: [],
};

/** WorkItem.status — the vocabulary this package's contract specifies. */
export type WorkItemStatus = 'backlog' | 'committed' | 'active' | 'review' | 'blocked' | 'verified' | 'cancelled';
export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'backlog',
  'committed',
  'active',
  'review',
  'blocked',
  'verified',
  'cancelled',
];

/**
 * Allowed manual status transitions. `review -> verified` and
 * `review|verified -> active` are reached only through the dedicated
 * `/verify` action (which also records the Verification row), never
 * through a bare PATCH — see `WorkItemsCore.setStatus`.
 */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  backlog: ['committed', 'active', 'cancelled'],
  committed: ['active', 'backlog', 'cancelled'],
  active: ['review', 'blocked', 'cancelled'],
  review: ['active', 'blocked', 'cancelled'],
  blocked: ['active', 'cancelled'],
  verified: ['active'],
  cancelled: [],
};

/** WorkItem.category */
export const WORK_CATEGORIES = ['fix', 'build', 'influence'] as const;
/** WorkItem.discipline */
export const WORK_DISCIPLINES = ['technical', 'content', 'authority', 'research', 'reporting', 'access'] as const;
/** WorkItem.priority */
export const WORK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/** AcceptanceCheck.status */
export const ACCEPTANCE_CHECK_STATUSES = ['pending', 'passed', 'failed'] as const;

/** Verification.decision */
export const VERIFICATION_DECISIONS = ['accepted', 'rejected'] as const;

/** Milestone.status */
export const MILESTONE_STATUSES = ['planned', 'at-risk', 'met', 'missed'] as const;

/** CapacityAllocation.absenceKind */
export const ABSENCE_KINDS = ['leave', 'holiday', 'reduced'] as const;

/** A single entry in Cycle.scopeChanges — appended, never rewritten, once a
 * cycle has committedAt set. */
export interface ScopeChangeEntry {
  at: string;
  by: string;
  reason: string;
  added: string[];
  removed: string[];
}
