import { api, unwrap } from '@/lib/api';

/**
 * Client-side delivery-plan adapter (design_plan G06) — CP03 "current work",
 * CP06 "plan & progress" and CP16 "work handoff".
 *
 * Routes: `@ClientPortal() @Controller('portal/projects/:projectId')` in
 * `backend/src/modules/delivery-plan/delivery-plan.controller.ts`. There is no
 * `clientId` and no cross-project id anywhere in this module: the server
 * resolves the client from the session and every handler asserts the project in
 * the URL belongs to it.
 *
 * ## What is deliberately not in these types
 *
 * `toPortalWorkItemDto` on the backend (`delivery-plan.service.ts`) is an
 * explicit allowlist, not a row spread with fields subtracted: internal
 * notes, hours, assignee/reviewer/creator ids, source/dependency ids, cycle
 * linkage and the raw `category`/`discipline`/`priority` vocabulary never
 * leave the server. They are **absent from the interfaces below**, so a
 * screen cannot render one by accident: reading `item.assigneeId` or
 * `item.dependsOn` does not compile.
 *
 * `Cycle.scopeChanges[].by`/`added`/`removed` (actor and item ids) are left
 * out for the same reason — only `reason` survives.
 *
 * @module services/portal-plan
 */

export type PortalWorkStatus =
  | 'backlog'
  | 'committed'
  | 'active'
  | 'review'
  | 'blocked'
  | 'verified'
  | 'cancelled';

export type PortalCycleStatus = 'planning' | 'committed' | 'active' | 'review' | 'closed';
export type PortalMilestoneStatus = 'planned' | 'at-risk' | 'met' | 'missed';

/** Normalized, client-safe blocker category — never the raw operational text. */
export type PortalBlockedReason = 'client-action' | 'approval' | 'dependency' | 'other';

/**
 * One work item as the client may see it — `WorkItem` rows flagged
 * `clientVisible` only. An internal work item is never in this list, so there
 * is no "hidden item" state for a screen to render.
 */
export interface PortalWorkItem {
  id: string;
  projectId: string;
  title: string;
  /**
   * Implementation guidance, plus any evidence entries appended to it (see
   * {@link splitWorkDescription}). The server already strips the submitting
   * user's id out of these entries before this ever reaches the browser.
   */
  description: string | null;
  status: string;
  /** A coarser, verification-only view of `status`: "verified" | "pending" | "unverified". */
  verifyState: string;
  dueOn: string | null;
  /** Client-facing "area of work" label (design_plan §4.3), or null when the
   * underlying discipline has no mapped label. */
  capabilityLabel: string | null;
  /** Free text: who/what the item is waiting on (a client-caused blocker is distinguished from an internal one). */
  blockedOn: string | null;
  blockedReason: PortalBlockedReason | null;
}

/** One appended line of `Cycle.scopeChanges` — never rewritten after commit. */
export interface PortalScopeChange {
  at: string;
  reason: string;
  requiresReconfirmation: boolean;
}

export interface PortalCycle {
  id: string;
  name: string;
  status: string;
  startsOn: string;
  endsOn: string;
  goal: string | null;
  committedAt: string | null;
  /**
   * The frozen scope denominator, snapshotted at commit. Never recomputed —
   * that is what keeps "delivered 8 of 10 committed" true afterwards.
   */
  committedCount: number;
  scopeChanges: PortalScopeChange[];
  /** Work items in this cycle with status `verified` — a full-cycle aggregate,
   * counting hidden/internal items too, not just the ones shared with this client. */
  deliveredCount: number;
  /** Work items in this cycle that are not cancelled — same full-cycle aggregate. */
  currentCount: number;
}

export interface PortalMilestone {
  id: string;
  title: string;
  dueOn: string | null;
  status: string;
}

/** The commercial container, in the reduced form the portal serves. */
export interface PortalEngagement {
  id: string;
  name: string;
  serviceTier: string;
  status: string;
  endsOn: string | null;
}

/** P11 — a "plan commitment": what the team intends to accomplish in the
 * period, distinct from a WorkItem (a step) and a content-schedule entry
 * (when a piece publishes). Progress is always derived server-side from
 * linked verified deliverables or a recorded outcome metric — never a
 * fabricated percentage. */
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

export interface PortalCommitmentScopeChange {
  at: string;
  reason: string;
  previousTarget: number | null;
  newTarget: number | null;
  previousDate: string | null;
  newDate: string | null;
  requiresReconfirmation: boolean;
}

export interface CommitmentProgress {
  kind: 'countable' | 'outcome' | 'none';
  verifiedCount: number;
  linkedCount: number;
  targetCount: number | null;
  targetUnit: string | null;
  /** Pre-formatted, e.g. "3 of 10 articles" — render this directly rather
   * than computing a percentage from the parts. */
  label: string;
  outcomeMetricLabel: string | null;
  outcomeMetricUnit: string | null;
  outcomeMetricBaseline: number | null;
  outcomeMetricTarget: number | null;
  outcomeMetricCurrent: number | null;
  outcomeMetricObservedAt: string | null;
}

export interface PortalActionSummary {
  sourceType: 'approval-request' | 'onboarding-request' | 'review-task' | 'delivery-blocker';
  sourceId: string;
  title: string;
  destination: string;
}

export interface PortalCommitment {
  id: string;
  cycleId: string;
  title: string;
  reason: string | null;
  workstream: string;
  status: CommitmentStatus;
  progress: CommitmentProgress;
  /** "Your Cailyx team" unless the lead deliberately opted to be named. */
  accountableLead: string;
  targetDate: string | null;
  contentRef: string | null;
  nextClientAction: PortalActionSummary | null;
  scopeChanges: PortalCommitmentScopeChange[];
}

export interface PortalPlan {
  /** Null when the project has no engagement attached. */
  engagement: PortalEngagement | null;
  cycles: PortalCycle[];
  milestones: PortalMilestone[];
  workItems: PortalWorkItem[];
}

/** Served from a separate route so `/plan`'s response shape never changes
 * (an existing smoke test allowlists it exactly). */
export async function getPortalCommitments(projectId: string, options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ commitments: PortalCommitment[] }>(
    `/portal/projects/${encodeURIComponent(projectId)}/plan/commitments`,
    options,
  );
  return unwrap<PortalCommitment[]>(payload, 'commitments');
}

/** §5.6 needs-your-action queue, client-scoped to one project. Derived
 * server-side from source records (approvals, onboarding requests) — never a
 * duplicate task row, and an item disappears when its source resolves. */
export interface PortalActionItem {
  sourceType: 'approval-request' | 'onboarding-request' | 'review-task' | 'delivery-blocker';
  sourceId: string;
  audience: 'client' | 'staff';
  eligibleActorId: string | null;
  title: string;
  reason: string;
  deadline: string | null;
  severity: 'overdue' | 'blocking' | 'normal';
  projectId: string;
  destination: string;
  currentVersion: string;
  completionCondition: string;
  createdAt: string;
}

export interface PortalActionQueue {
  items: PortalActionItem[];
  total: number;
}

export async function getPortalActionsOverview(
  projectId: string,
  options?: { signal?: AbortSignal; limit?: number },
) {
  const limit = options?.limit ?? 3;
  return api.get<PortalActionQueue>(
    `/portal/projects/${encodeURIComponent(projectId)}/actions/overview?limit=${limit}`,
    { signal: options?.signal },
  );
}

export async function getPortalActions(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<PortalActionQueue>(
    `/portal/projects/${encodeURIComponent(projectId)}/actions`,
    options,
  );
}

export async function getPortalPlan(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<PortalPlan>(
    `/portal/projects/${encodeURIComponent(projectId)}/plan`,
    options,
  );
}

export async function listPortalWorkItems(projectId: string, options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ workItems: PortalWorkItem[] }>(
    `/portal/projects/${encodeURIComponent(projectId)}/work`,
    options,
  );
  return unwrap<PortalWorkItem[]>(payload, 'workItems');
}

/**
 * The client submits evidence for a work item **they are assigned**.
 *
 * The server refuses (403) unless the caller is the item's assignee, and (409)
 * unless it is currently `active`; a successful submission moves it to
 * `review`. That status change is why the screen must re-read after posting
 * rather than assume.
 */
export async function submitPortalEvidence(
  projectId: string,
  workItemId: string,
  input: { note: string; sourceUrl?: string },
) {
  return api.post<PortalWorkItem>(
    `/portal/projects/${encodeURIComponent(projectId)}/work/${encodeURIComponent(workItemId)}/evidence`,
    input,
  );
}

export interface WorkDescriptionEntry {
  /** e.g. "Submitted", "Client evidence submitted". */
  label: string;
  /** ISO 8601, parsed out of the entry's own stamp. */
  at: string;
  /** The note, with any trailing source URL removed. */
  note: string;
  /** Trailing `http(s)` URL, when the entry carries one. */
  sourceUrl: string | null;
}

export interface ParsedWorkDescription {
  /** The guidance the author wrote, before any evidence lines. */
  guidance: string;
  /** Evidence entries, newest last (they are appended in order). */
  entries: WorkDescriptionEntry[];
}

/**
 * Splits a portal work item's `description` into guidance and evidence entries.
 *
 * `DeliveryPlanService.formatEvidenceEntry` writes entries as
 * `[<label> <iso timestamp> by <actorId>] <note> — <url>`, but the portal
 * projection's `toPortalText` strips the `by <actorId>` token server-side
 * before the response is ever built — a raw `User.id` must never reach the
 * client. What arrives here is always the already-redacted
 * `[<label> <iso timestamp>] <note> — <url>` form, so this parser matches
 * that shape directly rather than removing anything itself.
 *
 * Everything that is not an entry line is returned untouched as guidance.
 */
export function splitWorkDescription(description: string | null | undefined): ParsedWorkDescription {
  const text = (description ?? '').trim();
  if (!text) return { guidance: '', entries: [] };

  const chunks = text.split(/\n{2,}/);
  const guidanceParts: string[] = [];
  const entries: WorkDescriptionEntry[] = [];

  for (const chunk of chunks) {
    const match = /^\[(?<label>[^\]]*?)\s+(?<at>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(?<rest>[\s\S]*)$/.exec(
      chunk.trim(),
    );
    if (!match?.groups) {
      guidanceParts.push(chunk.trim());
      continue;
    }
    const rest = (match.groups.rest ?? '').trim();
    const urlMatch = /(https?:\/\/\S+)\s*$/.exec(rest);
    const sourceUrl = urlMatch ? urlMatch[1] : null;
    const note = (sourceUrl ? rest.slice(0, urlMatch!.index) : rest)
      .replace(/[\s—–-]+$/, '')
      .trim();
    entries.push({
      label: (match.groups.label ?? '').trim(),
      at: match.groups.at ?? '',
      note,
      sourceUrl,
    });
  }

  return { guidance: guidanceParts.join('\n\n').trim(), entries };
}
