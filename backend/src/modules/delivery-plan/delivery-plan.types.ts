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

// ─── P11 — Commitment (30-day plan) ─────────────────────────────────────

/** Commitment.status — §6.3's suggested transitions. */
export type CommitmentStatus =
  | 'draft'
  | 'proposed'
  | 'agreed'
  | 'active'
  | 'needs-attention'
  | 'completed'
  | 'closed'
  | 'cancelled'
  | 'superseded';

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = [
  'draft',
  'proposed',
  'agreed',
  'active',
  'needs-attention',
  'completed',
  'closed',
  'cancelled',
  'superseded',
];

/** Forward-biased transitions. "agreed" is never reachable through this
 * table — see `agreeCommitment`, the one path that records a confirmation.
 * cancelled/superseded are reachable from every open (non-terminal) state,
 * added programmatically rather than repeated on every row below. */
export const COMMITMENT_TRANSITIONS: Record<CommitmentStatus, CommitmentStatus[]> = {
  draft: ['proposed', 'cancelled'],
  proposed: ['draft', 'cancelled'], // "agreed" only via the dedicated action
  agreed: ['active', 'cancelled', 'superseded'],
  active: ['needs-attention', 'completed', 'cancelled', 'superseded'],
  'needs-attention': ['active', 'completed', 'cancelled', 'superseded'],
  completed: ['closed'],
  closed: [],
  cancelled: [],
  superseded: [],
};

/** §6.2's workstream tag — a section only renders when a commitment with
 * that tag exists, so there is no separate "purchased services" table to
 * keep in sync. */
export const COMMITMENT_WORKSTREAMS = ['website', 'content', 'email', 'ads', 'online-presence', 'other'] as const;

/** A single entry in Commitment.scopeChanges — §6.3: previous/new
 * target+date, reason, actor and whether reconfirmation is required.
 * Appended, never rewritten. */
export interface CommitmentScopeChangeEntry {
  at: string;
  by: string;
  reason: string;
  previousTarget: number | null;
  newTarget: number | null;
  previousDate: string | null;
  newDate: string | null;
  requiresReconfirmation: boolean;
}

/** Client-safe scope-change entry — no actor id, per §6.3 ("client-safe plan
 * history shows what changed and why, not internal actor IDs"), mirroring
 * `toPortalScopeChanges`'s discipline exactly. This writer always records
 * `requiresReconfirmation` as a real boolean, so there is no legacy
 * null-vs-false ambiguity to paper over here. */
export interface PortalCommitmentScopeChangeDto {
  at: string;
  reason: string;
  previousTarget: number | null;
  newTarget: number | null;
  previousDate: string | null;
  newDate: string | null;
  requiresReconfirmation: boolean;
}

/** Progress derived from linked verified deliverables — never a fabricated
 * percentage. `kind` says which flavor of evidence backs it. */
export interface CommitmentProgressDto {
  kind: 'countable' | 'outcome' | 'none';
  verifiedCount: number;
  linkedCount: number;
  targetCount: number | null;
  targetUnit: string | null;
  label: string;
  outcomeMetricLabel: string | null;
  outcomeMetricUnit: string | null;
  outcomeMetricBaseline: number | null;
  outcomeMetricTarget: number | null;
  outcomeMetricCurrent: number | null;
  outcomeMetricObservedAt: string | null;
}

/** Staff commitment DTO — full detail, staff-only expansion to execution
 * tasks stays in the linked WorkItem list, not duplicated here. */
export interface CommitmentDto {
  id: string;
  projectId: string;
  cycleId: string;
  title: string;
  reason: string | null;
  workstream: string;
  status: CommitmentStatus;
  targetCount: number | null;
  targetUnit: string | null;
  targetDate: string | null;
  outcomeMetricLabel: string | null;
  outcomeMetricUnit: string | null;
  outcomeMetricBaseline: number | null;
  outcomeMetricTarget: number | null;
  outcomeMetricCurrent: number | null;
  outcomeMetricObservedAt: string | null;
  accountableLead: string | null;
  clientVisibleLead: boolean;
  linkedWorkItemIds: string[];
  contentRef: string | null;
  agreedAt: string | null;
  agreedBy: string | null;
  scopeChanges: CommitmentScopeChangeEntry[];
  supersededBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  progress: CommitmentProgressDto;
  createdAt: string;
  updatedAt: string;
}

/** Client-safe commitment — no accountableLead unless clientVisibleLead,
 * no internal work-item ids, no raw actor ids in scope history. */
export interface PortalCommitmentDto {
  id: string;
  cycleId: string;
  title: string;
  reason: string | null;
  workstream: string;
  status: CommitmentStatus;
  progress: CommitmentProgressDto;
  accountableLead: string;
  targetDate: string | null;
  contentRef: string | null;
  nextClientAction: PortalActionSummary | null;
  scopeChanges: PortalCommitmentScopeChangeDto[];
}

/**
 * P15 — the compact "30-day plan" progress figure §5.1 puts in the Overview
 * footer, and §14.5 item 8 freezes into a released report.
 *
 * One implementation, two consumers, on purpose: the live footer and the frozen
 * report section must never disagree about what "3 of 5" counted. It is derived
 * from the same client-visible commitment rows as `getPortalCommitments`, so a
 * commitment the client cannot see can never appear in the count either.
 */
export interface PortalPlanProgressCommitmentDto {
  id: string;
  title: string;
  workstream: string;
  status: CommitmentStatus;
  targetDate: string | null;
  progressLabel: string;
  /** False for cancelled/superseded rows — they are listed so the number is explainable, not counted. */
  countsTowardTotal: boolean;
  /** Why this row is not counted, in plain English. Null when it is counted. */
  excludedReason: string | null;
}

export interface PortalPlanProgressDto {
  /** Commitments the client was asked to hold us to. */
  totalCount: number;
  /** Of those, the ones finished. */
  completedCount: number;
  /** Rendered verbatim: "3 of 5 commitments completed". */
  label: string;
  commitments: PortalPlanProgressCommitmentDto[];
  /** The span the commitments fall in, from their cycles. Either bound may be null. */
  window: { start: string | null; end: string | null };
  cycleCount: number;
  /** Says what the count covers, so "5" is never mistaken for "everything we are doing". */
  scopeNote: string;
}

// ─── P11 — Needs-your-action queue (§5.6) ───────────────────────────────

export type ActionSourceType =
  | 'approval-request'
  | 'onboarding-request'
  | 'review-task'
  | 'delivery-blocker';

export type ActionAudience = 'client' | 'staff';
export type ActionSeverity = 'overdue' | 'blocking' | 'normal';

/** A minimal cross-reference used on a commitment's `nextClientAction`, and
 * as the shape of each item in the full queue. `sourceId`/`sourceType`
 * together are the stable identity — never a synthetic id minted just to
 * show a card. */
export interface PortalActionSummary {
  sourceType: ActionSourceType;
  sourceId: string;
  title: string;
  destination: string;
}

/** One row of the server-side action-needed projection (§5.6). Always
 * derived from its source's current state; never a duplicate task row. */
export interface ActionItemDto {
  sourceType: ActionSourceType;
  sourceId: string;
  audience: ActionAudience;
  /** Eligible actor(s): a client-owned item lists the clientId; a staff item
   * lists the assigned userId (or null when open to any staff with
   * permission on the project). */
  eligibleActorId: string | null;
  title: string;
  reason: string;
  deadline: string | null;
  severity: ActionSeverity;
  projectId: string;
  destination: string;
  /** Current version/state string of the source record, so a stale client
   * card can be told apart from a fresh one (e.g. ApprovalRequest.status). */
  currentVersion: string;
  completionCondition: string;
  createdAt: string;
}

export interface ActionQueueDto {
  items: ActionItemDto[];
  total: number;
}

/** Client-owned engagement summary; excludes staffing, hours, timezone and
 * operational notes. This is the exact allowlist portal-plan.smoke.sh checks:
 * `id name serviceTier endsOn status` — no `timezone`, no `startsOn`. */
export interface PortalEngagementDto {
  id: string;
  name: string;
  serviceTier: string;
  status: string;
  endsOn: Date | null;
}

/**
 * Public scope history, never the operational audit record. The legacy
 * schema's `reason` is already a client-safe description (it is written by
 * staff as the human-facing rationale, not an internal ID dump), so it is
 * carried through as-is; `by`/`added`/`removed` (actor and item IDs) are
 * dropped entirely rather than resolved to titles, per portal-plan.smoke.sh's
 * `assert_no_leaks`, which forbids those keys outright. `requiresReconfirmation`
 * is a required boolean in the smoke contract; the legacy writer never records
 * it, so it defaults to `false` (never `null`) when absent.
 */
export interface PortalScopeChangeDto {
  at: string;
  reason: string;
  requiresReconfirmation: boolean;
}

/**
 * A cycle shared through client-visible work. No committer, operational audit
 * fields, project/engagement linkage or closedAt/timestamps — see
 * portal-plan.smoke.sh's cycle allowlist. committedCount keeps the original
 * frozen denominator; deliveredCount/currentCount are full-cycle aggregates
 * (they include hidden/internal work items in the cycle, not just the
 * client-visible ones) per the smoke test's explicit 5/5/2-including-hidden
 * assertion.
 */
export interface PortalCycleDto {
  id: string;
  name: string;
  status: string;
  startsOn: Date;
  endsOn: Date;
  goal: string | null;
  committedAt: Date | null;
  committedCount: number;
  deliveredCount: number;
  currentCount: number;
  scopeChanges: PortalScopeChangeDto[];
}

/** Client-visible milestone; excludes description (milestone descriptions may
 * carry internal-only detail — the smoke fixture marks a visible milestone's
 * description private on purpose), visibility controls and operational
 * linkage/timestamps. Allowlist: `id title dueOn status`. */
export interface PortalMilestoneDto {
  id: string;
  title: string;
  dueOn: Date | null;
  status: string;
}

/** Normalized, client-safe blocker category. The raw `WorkItem.blockedReason`
 * column is free-text operational detail (never shown to clients); it is
 * mapped down to one of these four categories via `blockedOn` (a coarse,
 * already client-safe owner tag such as "client"/"approval"/"dependency"). */
export type PortalBlockedReason = 'client-action' | 'approval' | 'dependency' | 'other';

/**
 * Explicit portal work allowlist, shared by both reads and evidence
 * submission. Excludes internal notes, effort, user IDs, provenance/
 * dependency IDs, category/discipline/priority (collapsed into
 * `capabilityLabel`) and cycleId. Descriptions retain client guidance/
 * evidence but not the generated actor attribution (see `toPortalText`).
 *
 * `status` and `verifyState` are both required by portal-plan.smoke.sh.
 * `status` is the raw WorkItem.status value (backlog/committed/active/
 * review/blocked/verified/cancelled) — clients need the real workflow state
 * to know what's next. `verifyState` is a coarser, purely verification-
 * focused synonym derived from the same column ("verified" | "pending" |
 * "unverified"), useful anywhere the UI wants to ask "has this actually been
 * checked off?" without exposing/relying on the full status vocabulary.
 * There is no separate Verification-derived value backing it in this slice.
 */
export interface PortalWorkItemDto {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  verifyState: string;
  dueOn: Date | null;
  capabilityLabel: string | null;
  blockedOn: string | null;
  blockedReason: PortalBlockedReason | null;
}

/**
 * Exact response body of GET /portal/projects/:projectId/plan.
 *
 * P11 deliberately does NOT add a `commitments` key to this shape: that
 * response is checked by portal-plan.smoke.sh's recursive allowlist (an
 * unrelated, already-shipped P01 smoke test this phase must not modify or
 * regress), which rejects any key it does not know about. Commitments are
 * served from their own `GET .../plan/commitments` route instead — see
 * `PortalCommitmentsDto`.
 */
export interface PortalPlanDto {
  engagement: PortalEngagementDto | null;
  cycles: PortalCycleDto[];
  milestones: PortalMilestoneDto[];
  workItems: PortalWorkItemDto[];
}

/** Exact response body of GET /portal/projects/:projectId/plan/commitments. */
export interface PortalCommitmentsDto {
  commitments: PortalCommitmentDto[];
}

/** Exact response body of GET /portal/projects/:projectId/work. */
export interface PortalWorkItemsDto {
  workItems: PortalWorkItemDto[];
}
