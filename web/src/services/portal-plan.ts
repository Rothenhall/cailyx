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
 * `toWorkItemDto(w, { includeInternal: false })` strips `internalNotes` — and
 * that is the only field it strips. The row still carries `assigneeId`,
 * `reviewerId`, `createdBy`, `estimateHours` and `actualHours`. Those are raw
 * user identifiers and internal effort figures, and design_plan §4.5's client
 * rules (and the G06 portal contract) keep operator identifiers and commercial
 * internals off the client surface. They are **absent from the interfaces
 * below**, so a screen cannot render one by accident: reading `item.assigneeId`
 * does not compile.
 *
 * `Cycle.scopeChanges[].by` is left out for the same reason.
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

/**
 * One work item as the client may see it — `WorkItem` rows flagged
 * `clientVisible` only. An internal work item is never in this list, so there
 * is no "hidden item" state for a screen to render.
 */
export interface PortalWorkItem {
  id: string;
  projectId: string;
  cycleId: string | null;
  title: string;
  /**
   * Implementation guidance, plus any evidence entries appended to it (see
   * {@link splitWorkDescription}). Those entries embed the submitting user's
   * id inside the text — the screen must render them through the parser, never
   * raw.
   */
  description: string | null;
  category: string;
  discipline: string;
  status: string;
  priority: string;
  dueAt: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Ids of work items this one waits on. */
  dependsOn: string[];
  blockedReason: string | null;
  /** Free text: who/what the item is waiting on (a client-caused blocker is distinguished from an internal one). */
  blockedOn: string | null;
  clientVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One appended line of `Cycle.scopeChanges` — never rewritten after commit. */
export interface PortalScopeChange {
  at: string;
  reason: string;
  /** Ids added to the committed scope. Counts are rendered; ids are not. */
  added: string[];
  /** Ids removed from the committed scope. */
  removed: string[];
}

export interface PortalCycle {
  id: string;
  projectId: string;
  engagementId: string | null;
  name: string;
  startsOn: string;
  endsOn: string;
  status: string;
  goal: string | null;
  committedAt: string | null;
  /**
   * The frozen scope denominator, snapshotted at commit. Never recomputed —
   * that is what keeps "delivered 8 of 10 committed" true afterwards.
   */
  committedCount: number;
  scopeChanges: PortalScopeChange[];
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Work items in this cycle with status `verified`. */
  deliveredCount: number;
  /** Work items in this cycle that are not cancelled. */
  currentCount: number;
}

export interface PortalMilestone {
  id: string;
  projectId: string;
  engagementId: string | null;
  title: string;
  description: string | null;
  dueAt: string | null;
  status: string;
  clientVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The commercial container, in the reduced form the portal serves. */
export interface PortalEngagement {
  id: string;
  name: string;
  serviceTier: string;
  status: string;
  timezone: string;
  startsOn: string | null;
  endsOn: string | null;
}

export interface PortalPlan {
  /** Null when the project has no engagement attached. */
  engagement: PortalEngagement | null;
  cycles: PortalCycle[];
  milestones: PortalMilestone[];
  workItems: PortalWorkItem[];
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
  /**
   * True when at least one entry carried a `by <user id>` token that was
   * dropped. The screen says so in words rather than silently editing the
   * server's text.
   */
  redactedActor: boolean;
}

/**
 * Splits a portal work item's `description` into guidance and evidence entries.
 *
 * `DeliveryPlanService.formatEvidenceEntry` writes entries as
 * `[<label> <iso timestamp> by <actorId>] <note> — <url>`, and `actorId` is a
 * raw `User.id` — an operator or a client user identifier that §4.5 keeps off
 * the client surface. The portal projection does not strip it, so this parser
 * is where it is removed, and it reports that it removed something so the
 * screen can disclose the edit instead of quietly rewriting the field.
 *
 * Everything that is not an entry line is returned untouched as guidance.
 */
export function splitWorkDescription(description: string | null | undefined): ParsedWorkDescription {
  const text = (description ?? '').trim();
  if (!text) return { guidance: '', entries: [], redactedActor: false };

  const chunks = text.split(/\n{2,}/);
  const guidanceParts: string[] = [];
  const entries: WorkDescriptionEntry[] = [];
  let redactedActor = false;

  for (const chunk of chunks) {
    const match = /^\[(?<label>[^\]]*?)\s+(?<at>\d{4}-\d{2}-\d{2}T[\d:+.]+Z?)\s+by\s+(?<actor>[^\]]+)\]\s*(?<rest>[\s\S]*)$/.exec(
      chunk.trim(),
    );
    if (!match?.groups) {
      guidanceParts.push(chunk.trim());
      continue;
    }
    redactedActor = true;
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

  return { guidance: guidanceParts.join('\n\n').trim(), entries, redactedActor };
}
