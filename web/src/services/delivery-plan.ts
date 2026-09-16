import { api, unwrap } from '@/lib/api';

/**
 * Delivery-plan adapter (G06) — design_plan.md screens OP12, OP13 and
 * PJ08–PJ10, plus the client-plan read the portal uses.
 *
 * Three rules from §7 and §8.2 are the reason this file exists as a typed
 * boundary rather than screens calling `api.*` directly:
 *
 *  1. **Commit freezes the denominator.** A cycle carries `committedCount`
 *     (snapshotted at commit) and an append-only `scopeChanges` history. The
 *     functions below never let a caller send a new count — a scope change
 *     goes through `scopeChangeReason` on the work item, and the server
 *     appends the entry. `deliveredCount` is *not* a field here for the same
 *     reason: it is computed by the reader from the work items it already has,
 *     so nothing can cache a stale ratio.
 *  2. **Dependencies are validated server-side for cycles.** `dependsOn` is
 *     sent and a 409 comes back when the graph would contain a loop. There is
 *     deliberately no client-side cycle check: a browser check would give a
 *     different answer than the server and the disagreement would surface as
 *     a silent data problem rather than a visible rejection.
 *  3. **Verification is evidence.** `verifyWorkItem` requires the observation
 *     (source URL, run id/type, artifact, observed date) and the reviewer, and
 *     a `rejected` decision reopens the item to `active` — so the caller must
 *     read back the returned `workItem.status` rather than assume anything.
 *
 * `WorkItem.internalNotes` is present only on operator routes. The backend
 * strips the field by construction on the portal routes, so the optional
 * marker below is a genuine reflection of the wire, not a UI convention.
 */

// ── Vocabularies (mirroring delivery-plan.types.ts exactly) ─────────────

export type EngagementStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = [
  'active',
  'paused',
  'completed',
  'cancelled',
];

export type ServiceTier = 'scorecard' | 'diagnostic' | 'sprint' | 'retainer';
export const SERVICE_TIERS: readonly ServiceTier[] = [
  'scorecard',
  'diagnostic',
  'sprint',
  'retainer',
];

/** planning → committed → active → review → closed. Forward-only. */
export type CycleStatus = 'planning' | 'committed' | 'active' | 'review' | 'closed';

/**
 * The forward transitions the generic status PATCH will accept. `committed` is
 * absent on purpose — committing is a dedicated action that also freezes the
 * denominator, and the server rejects it through the generic route.
 */
export const CYCLE_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  planning: ['committed'],
  committed: ['active'],
  active: ['review'],
  review: ['closed'],
  closed: [],
};

export type WorkItemStatus =
  | 'backlog'
  | 'committed'
  | 'active'
  | 'review'
  | 'blocked'
  | 'verified'
  | 'cancelled';

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
 * Transitions reachable through a bare PATCH. `review`, `verified` and
 * `blocked` are absent because they carry a record the PATCH cannot write —
 * the submission, the verification row, or the blocker's owner.
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

export type WorkCategory = 'fix' | 'build' | 'influence';
export const WORK_CATEGORIES: readonly WorkCategory[] = ['fix', 'build', 'influence'];

export type WorkDiscipline = 'technical' | 'content' | 'authority' | 'research' | 'reporting' | 'access';
export const WORK_DISCIPLINES: readonly WorkDiscipline[] = [
  'technical',
  'content',
  'authority',
  'research',
  'reporting',
  'access',
];

export type WorkPriority = 'low' | 'medium' | 'high' | 'critical';
export const WORK_PRIORITIES: readonly WorkPriority[] = ['low', 'medium', 'high', 'critical'];

export const WORK_CATEGORY_LABEL: Record<WorkCategory, string> = {
  fix: 'Fix',
  build: 'Build',
  influence: 'Influence',
};

export const WORK_DISCIPLINE_LABEL: Record<WorkDiscipline, string> = {
  technical: 'Technical',
  content: 'Content',
  authority: 'Authority',
  research: 'Research',
  reporting: 'Reporting',
  access: 'Access',
};

export const WORK_PRIORITY_LABEL: Record<WorkPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/**
 * The §8.2 lifecycle as the operator reads it. Deliberately distinct from
 * `@/types`' five-state `WorkStatus`: that view model collapses several of
 * these, which is right for a portfolio row and wrong for a cycle board where
 * "committed but not started" and "never scoped" are different columns.
 */
export const WORK_ITEM_STATUS_LABEL: Record<WorkItemStatus, string> = {
  backlog: 'Backlog',
  committed: 'Committed',
  active: 'Active',
  review: 'In review',
  blocked: 'Blocked',
  verified: 'Verified',
  cancelled: 'Cancelled',
};

export type AcceptanceCheckStatus = 'pending' | 'passed' | 'failed';
export const ACCEPTANCE_CHECK_STATUSES: readonly AcceptanceCheckStatus[] = [
  'pending',
  'passed',
  'failed',
];

export type VerificationDecision = 'accepted' | 'rejected';
export const VERIFICATION_DECISIONS: readonly VerificationDecision[] = ['accepted', 'rejected'];

export type MilestoneStatus = 'planned' | 'at-risk' | 'met' | 'missed';
export const MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  'planned',
  'at-risk',
  'met',
  'missed',
];

/** leave | holiday | reduced — a reason hours are unavailable, not a task kind. */
export type AbsenceKind = 'leave' | 'holiday' | 'reduced';
export const ABSENCE_KINDS: readonly AbsenceKind[] = ['leave', 'holiday', 'reduced'];

export const ABSENCE_KIND_LABEL: Record<AbsenceKind, string> = {
  leave: 'Leave',
  holiday: 'Holiday',
  reduced: 'Reduced hours',
};

// ── Records ─────────────────────────────────────────────────────────────

/**
 * One appended entry in `Cycle.scopeChanges`. It is appended, never rewritten,
 * once the cycle has `committedAt` set — which is what lets the frozen
 * `committedCount` and the current work list disagree honestly.
 */
export interface ScopeChangeEntry {
  at: string;
  /** User id of the operator who made the change. */
  by: string;
  reason: string;
  added: string[];
  removed: string[];
}

export interface Engagement {
  id: string;
  clientId: string;
  name: string;
  serviceTier: string;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  /** IANA. Every due date on this engagement resolves against this zone. */
  timezone: string;
  deliveryLead: string | null;
  hoursPerCycle: number | null;
  notes: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Cycle {
  id: string;
  projectId: string;
  engagementId: string | null;
  name: string;
  startsOn: string;
  endsOn: string;
  status: string;
  goal: string | null;
  committedAt: string | null;
  committedBy: string | null;
  /**
   * The frozen denominator: the work-item count at the moment of commit. It
   * does **not** move when scope changes afterwards — that is the whole point.
   */
  committedCount: number;
  scopeChanges: ScopeChangeEntry[];
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  cycleId: string | null;
  title: string;
  description: string | null;
  category: string;
  discipline: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  reviewerId: string | null;
  /** Resolved server-side against the engagement/project timezone. */
  dueAt: string | null;
  estimateHours: number | null;
  actualHours: number | null;
  /** Provenance — a Gap.id, Finding.id or Alert.id. */
  sourceType: string | null;
  sourceId: string | null;
  /** Work-item ids that must finish first. A loop is a 409 on write. */
  dependsOn: string[];
  blockedReason: string | null;
  blockedOn: string | null;
  /** Gates the client portal. Server-controlled, never inferred from the UI. */
  clientVisible: boolean;
  /** Present on operator routes only; never returned by a portal route. */
  internalNotes?: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceCheck {
  id: string;
  workItemId: string;
  description: string;
  status: string;
  checkedBy: string | null;
  checkedAt: string | null;
  note: string | null;
  position: number;
}

/** A reviewer's recorded observation — evidence, not a checkbox. */
export interface Verification {
  id: string;
  workItemId: string;
  sourceUrl: string | null;
  runId: string | null;
  runType: string | null;
  artifact: string | null;
  observedAt: string | null;
  reviewerId: string | null;
  decision: string;
  note: string | null;
  createdAt: string;
}

export interface WorkItemDetail extends WorkItem {
  acceptanceChecks: AcceptanceCheck[];
  /** Newest first. A `rejected` row is what reopened the item. */
  verifications: Verification[];
}

export interface CycleDetail extends Cycle {
  workItems: WorkItem[];
}

export interface Milestone {
  id: string;
  projectId: string;
  engagementId: string | null;
  title: string;
  description: string | null;
  dueAt: string | null;
  status: string;
  clientVisible: boolean;
  metAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityAllocation {
  id: string;
  userId: string;
  cycleId: string | null;
  projectId: string | null;
  startsOn: string;
  endsOn: string;
  availableHours: number;
  allocatedHours: number;
  absenceKind: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Server-summed across the rows the caller asked for. */
export interface CapacitySummary {
  availableHours: number;
  allocatedHours: number;
  remainingHours: number;
}

export interface CapacityView extends CapacitySummary {
  allocations: CapacityAllocation[];
}

// ── Engagements ─────────────────────────────────────────────────────────

export async function listEngagements(
  clientId: string,
  options?: { signal?: AbortSignal },
): Promise<Engagement[]> {
  const payload = await api.get<{ engagements: Engagement[] }>(
    `/clients/${clientId}/engagements`,
    options,
  );
  return unwrap<Engagement[]>(payload, 'engagements');
}

export async function getEngagement(
  clientId: string,
  engagementId: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<Engagement>(`/clients/${clientId}/engagements/${engagementId}`, options);
}

export interface CreateEngagementInput {
  name: string;
  serviceTier?: ServiceTier;
  /** IANA zone, e.g. "America/New_York". */
  timezone?: string;
  startsOn?: string;
  endsOn?: string;
  deliveryLead?: string;
  hoursPerCycle?: number;
  notes?: string;
}

export async function createEngagement(clientId: string, input: CreateEngagementInput) {
  return api.post<Engagement>(`/clients/${clientId}/engagements`, input);
}

export async function updateEngagement(
  clientId: string,
  engagementId: string,
  input: Partial<CreateEngagementInput>,
) {
  return api.patch<Engagement>(`/clients/${clientId}/engagements/${engagementId}`, input);
}

/**
 * Pause / resume / complete / cancel an engagement.
 *
 * Pausing records `pausedAt` and a reason, and stops *future* committed work
 * from auto-progressing. It never cascades onto in-flight work, which stays
 * exactly where it was — §7.6's pause policy.
 */
export async function setEngagementStatus(
  clientId: string,
  engagementId: string,
  input: { status: EngagementStatus; reason?: string },
) {
  return api.patch<Engagement>(`/clients/${clientId}/engagements/${engagementId}/status`, input);
}

// ── Cycles ──────────────────────────────────────────────────────────────

export async function listCycles(
  projectId: string,
  status?: CycleStatus,
  options?: { signal?: AbortSignal },
): Promise<Cycle[]> {
  const payload = await api.get<{ cycles: Cycle[] }>(`/projects/${projectId}/cycles`, {
    ...options,
    query: { status },
  });
  return unwrap<Cycle[]>(payload, 'cycles');
}

/** A cycle with its work items and the frozen committed count attached. */
export async function getCycleDetail(
  projectId: string,
  cycleId: string,
  options?: { signal?: AbortSignal },
): Promise<CycleDetail> {
  return api.get<CycleDetail>(`/projects/${projectId}/cycles/${cycleId}/detail`, options);
}

export interface CreateCycleInput {
  name: string;
  engagementId?: string;
  startsOn: string;
  endsOn: string;
  goal?: string;
}

export async function createCycle(projectId: string, input: CreateCycleInput) {
  return api.post<Cycle>(`/projects/${projectId}/cycles`, input);
}

export async function updateCycle(
  projectId: string,
  cycleId: string,
  input: { name?: string; startsOn?: string; endsOn?: string; goal?: string },
) {
  return api.patch<Cycle>(`/projects/${projectId}/cycles/${cycleId}`, input);
}

/**
 * A forward lifecycle move (committed → active → review → closed).
 *
 * `committed` is not a valid target here — the server answers 409 and points
 * at `commitCycle`. That is deliberate: the generic route cannot freeze the
 * denominator, so it must not be able to reach the state that has one.
 */
export async function setCycleStatus(
  projectId: string,
  cycleId: string,
  status: Exclude<CycleStatus, 'committed'>,
) {
  return api.patch<Cycle>(`/projects/${projectId}/cycles/${cycleId}/status`, { status });
}

/**
 * Commit a cycle — freezes the scope denominator.
 *
 * Snapshots how many non-cancelled work items are attached right now and moves
 * every `backlog` item to `committed`. A 409 comes back when the cycle is not
 * in `planning`, when there is nothing to commit, or when the funding
 * engagement is paused.
 */
export async function commitCycle(projectId: string, cycleId: string, note?: string) {
  return api.post<Cycle>(`/projects/${projectId}/cycles/${cycleId}/commit`, { note });
}

// ── Work items ──────────────────────────────────────────────────────────

export async function listWorkItems(
  projectId: string,
  filter?: { status?: WorkItemStatus; cycleId?: string; assigneeId?: string },
  options?: { signal?: AbortSignal },
): Promise<WorkItem[]> {
  const payload = await api.get<{ workItems: WorkItem[] }>(
    `/projects/${projectId}/work-items`,
    { ...options, query: filter },
  );
  return unwrap<WorkItem[]>(payload, 'workItems');
}

export async function getWorkItem(
  projectId: string,
  workItemId: string,
  options?: { signal?: AbortSignal },
): Promise<WorkItemDetail> {
  return api.get<WorkItemDetail>(`/projects/${projectId}/work-items/${workItemId}`, options);
}

export interface CreateWorkItemInput {
  title: string;
  description?: string;
  category?: WorkCategory;
  discipline?: WorkDiscipline;
  priority?: WorkPriority;
  cycleId?: string;
  /**
   * Required when `cycleId` targets an already-committed cycle. The server
   * appends it to `Cycle.scopeChanges` — there is no way to change the frozen
   * denominator itself.
   */
  scopeChangeReason?: string;
  assigneeId?: string;
  reviewerId?: string;
  /** Bare `YYYY-MM-DD` (end-of-day in the project timezone) or a full ISO instant. */
  dueOn?: string;
  estimateHours?: number;
  sourceType?: string;
  sourceId?: string;
  /** A loop in this graph is rejected with 409 — no client-side pre-check. */
  dependsOn?: string[];
  clientVisible?: boolean;
  /** Never returned on a client-scoped route. */
  internalNotes?: string;
  acceptanceChecklist?: string[];
}

export async function createWorkItem(projectId: string, input: CreateWorkItemInput) {
  return api.post<WorkItem>(`/projects/${projectId}/work-items`, input);
}

export type UpdateWorkItemInput = Partial<
  Omit<CreateWorkItemInput, 'acceptanceChecklist' | 'sourceType' | 'sourceId'>
> & {
  /** Direct transitions only. A 409 comes back for review/verified/blocked. */
  status?: WorkItemStatus;
  actualHours?: number;
};

export async function updateWorkItem(
  projectId: string,
  workItemId: string,
  input: UpdateWorkItemInput,
) {
  return api.patch<WorkItem>(`/projects/${projectId}/work-items/${workItemId}`, input);
}

/** Refused with 409 once the item belongs to a committed cycle — cancel it instead. */
export async function deleteWorkItem(projectId: string, workItemId: string) {
  return api.delete<{ deleted: true }>(`/projects/${projectId}/work-items/${workItemId}`);
}

/** active → review. The exact deliverable, with the optional live URL. */
export async function submitWorkItem(
  projectId: string,
  workItemId: string,
  input: { note?: string; sourceUrl?: string },
) {
  return api.post<WorkItem>(`/projects/${projectId}/work-items/${workItemId}/submit`, input);
}

export interface VerifyWorkItemInput {
  decision: VerificationDecision;
  sourceUrl?: string;
  /** The audit/measurement run that observed the change. */
  runId?: string;
  runType?: string;
  /** Exactly what was checked. */
  artifact?: string;
  /** When the evidence was observed. Defaults to now server-side. */
  observedAt?: string;
  /** Required on a rejection — what reopened the work. */
  note?: string;
}

/**
 * Records verification evidence.
 *
 * The response is `{ workItem, verification }` — read `workItem.status` from
 * it rather than predicting: an `accepted` decision moves the item to
 * `verified`, and a `rejected` one reopens it to `active`.
 */
export async function verifyWorkItem(
  projectId: string,
  workItemId: string,
  input: VerifyWorkItemInput,
) {
  return api.post<{ workItem: WorkItem; verification: Verification }>(
    `/projects/${projectId}/work-items/${workItemId}/verify`,
    input,
  );
}

/** Records the reason and who it is waiting on, so a client blocker is distinguishable. */
export async function blockWorkItem(
  projectId: string,
  workItemId: string,
  input: { blockedReason: string; blockedOn?: string },
) {
  return api.post<WorkItem>(`/projects/${projectId}/work-items/${workItemId}/block`, input);
}

export async function unblockWorkItem(projectId: string, workItemId: string) {
  return api.post<WorkItem>(`/projects/${projectId}/work-items/${workItemId}/unblock`);
}

export async function addAcceptanceCheck(
  projectId: string,
  workItemId: string,
  description: string,
) {
  return api.post<AcceptanceCheck>(
    `/projects/${projectId}/work-items/${workItemId}/checks`,
    { description },
  );
}

export async function setAcceptanceCheck(
  projectId: string,
  workItemId: string,
  checkId: string,
  input: { status: AcceptanceCheckStatus; note?: string },
) {
  return api.patch<AcceptanceCheck>(
    `/projects/${projectId}/work-items/${workItemId}/checks/${checkId}`,
    input,
  );
}

// ── Milestones ──────────────────────────────────────────────────────────

export async function listMilestones(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<Milestone[]> {
  const payload = await api.get<{ milestones: Milestone[] }>(
    `/projects/${projectId}/milestones`,
    options,
  );
  return unwrap<Milestone[]>(payload, 'milestones');
}

export async function createMilestone(
  projectId: string,
  input: {
    title: string;
    description?: string;
    engagementId?: string;
    dueOn?: string;
    clientVisible?: boolean;
  },
) {
  return api.post<Milestone>(`/projects/${projectId}/milestones`, input);
}

export async function updateMilestone(
  projectId: string,
  milestoneId: string,
  input: {
    title?: string;
    description?: string;
    dueOn?: string;
    status?: MilestoneStatus;
    clientVisible?: boolean;
  },
) {
  return api.patch<Milestone>(`/projects/${projectId}/milestones/${milestoneId}`, input);
}

export async function deleteMilestone(projectId: string, milestoneId: string) {
  return api.delete<{ deleted: true }>(`/projects/${projectId}/milestones/${milestoneId}`);
}

// ── Capacity ────────────────────────────────────────────────────────────

/**
 * Whole-team capacity across a date range.
 *
 * The totals are the server's, summed over the same rows it returns — the
 * screen does not add them up itself, because a client-side sum over a
 * filtered subset would silently disagree with the ledger.
 */
export async function listTeamCapacity(
  filter?: { userId?: string; from?: string; to?: string },
  options?: { signal?: AbortSignal },
): Promise<CapacityView> {
  return api.get<CapacityView>('/team/capacity', { ...options, query: filter });
}

export async function listProjectCapacity(
  projectId: string,
  cycleId?: string,
  options?: { signal?: AbortSignal },
): Promise<CapacityView> {
  return api.get<CapacityView>(`/team/capacity/projects/${projectId}`, {
    ...options,
    query: { cycleId },
  });
}

export async function createCapacityAllocation(
  projectId: string | null,
  input: {
    userId: string;
    cycleId?: string;
    startsOn: string;
    endsOn: string;
    availableHours?: number;
    allocatedHours?: number;
    absenceKind?: AbsenceKind;
    note?: string;
  },
) {
  const path = projectId ? `/team/capacity/projects/${projectId}` : '/team/capacity/org';
  return api.post<CapacityAllocation>(path, input);
}

export async function deleteCapacityAllocation(allocationId: string) {
  return api.delete<{ deleted: true }>(`/team/capacity/${allocationId}`);
}

// ── Team directory ──────────────────────────────────────────────────────

/** One operator, as the directory route returns them. */
export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  type: string;
  clientId: string | null;
  createdAt: string;
}

/**
 * The operator directory — **admin only** (`GET /users` is `@Roles('admin')`
 * at the class level).
 *
 * OP12 needs people-by-role, and G03 records that a non-admin owner directory
 * does not exist yet. So a non-admin calling this gets a 403, and the screen
 * must render `insufficient-role` rather than an empty team: "no people" and
 * "you may not see the people" are different facts and only one of them is
 * true. Capacity rows themselves are readable by any operator, so the screen
 * still shows allocations when this read fails.
 */
export async function listTeamMembers(options?: { signal?: AbortSignal }): Promise<TeamMember[]> {
  const payload = await api.get<{ users: TeamMember[] }>('/users', options);
  return unwrap<TeamMember[]>(payload, 'users');
}

export const OPERATOR_ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  'delivery-lead': 'Delivery lead',
  content: 'Content',
  technical: 'Technical',
  outreach: 'Outreach',
  sales: 'Sales',
};
