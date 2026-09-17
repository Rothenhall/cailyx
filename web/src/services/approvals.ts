import { api } from '@/lib/api';

/**
 * Approval adapter (G10) — operator CL01/CT05 and client CP09/CP10.
 *
 * The whole point of this package is that **an approval binds to one exact
 * version**. `artifactRevision` is on every request, and the server invalidates
 * a pending request when a newer revision appears rather than transferring the
 * consent. Every type and comment below keeps that visible, because the failure
 * mode — approving revision 2 and having revision 3 publish under it — is
 * silent.
 *
 * Note the two surfaces take different routes: the operator one is scoped by
 * `projectId`, the client one by the session. The client functions therefore
 * take **no client id at all**, so there is nothing for a caller to pass
 * wrongly.
 */

export type ApprovalArtifactType = 'report' | 'content' | 'plan' | 'cycle' | 'claim';
export type ApprovalReviewerType = 'operator' | 'client';
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'changes-requested'
  | 'cancelled'
  | 'invalidated';

export interface ApprovalDecision {
  id: string;
  approvalRequestId: string;
  decision: 'approved' | 'changes-requested';
  comment: string | null;
  decidedBy: string;
  decidedByType: ApprovalReviewerType;
  /** The revision actually seen at decision time. */
  decidedRevision: number | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  projectId: string;
  clientId: string | null;
  artifactType: ApprovalArtifactType;
  artifactId: string;
  /**
   * The exact revision under review. A newer revision invalidates the request
   * rather than silently transferring consent.
   */
  artifactRevision: number | null;
  revisionId: string | null;
  title: string;
  detail: string | null;
  reviewerType: ApprovalReviewerType;
  requiredReviewerId: string | null;
  requestedBy: string;
  dueAt: string | null;
  status: ApprovalStatus;
  /** Set when a newer revision superseded the artifact under review. */
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestDetail extends ApprovalRequest {
  /** Newest first. Only the head row is the current decision. */
  decisions: ApprovalDecision[];
}

// ── Operator surface ────────────────────────────────────────────────────

export async function listApprovals(
  projectId: string,
  filter?: { status?: string; artifactType?: string },
  options?: { signal?: AbortSignal },
) {
  // The controller's own `@ApiResponse` names this field `requests`, not
  // `approvals` — verified against `ApprovalsService.list`, which returns
  // `{ requests: [...] }`. A mismatched field here reads back as `undefined`
  // rather than a fetch error, which is exactly the failure §10.2 warns about.
  return api.get<{ requests: ApprovalRequest[] }>(`/projects/${projectId}/approvals`, {
    ...options,
    query: filter,
  });
}

export async function getApproval(projectId: string, id: string, options?: { signal?: AbortSignal }) {
  return api.get<ApprovalRequestDetail>(`/projects/${projectId}/approvals/${id}`, options);
}

export async function createApproval(
  projectId: string,
  input: {
    artifactType: ApprovalArtifactType;
    artifactId: string;
    /** Required: an approval without a pinned revision is not one. */
    artifactRevision: number;
    revisionId?: string;
    title: string;
    detail?: string;
    reviewerType: ApprovalReviewerType;
    requiredReviewerId?: string;
    dueAt?: string;
  },
) {
  return api.post<ApprovalRequest>(`/projects/${projectId}/approvals`, input);
}

export async function decideApproval(
  projectId: string,
  id: string,
  input: {
    decision: 'approved' | 'changes-requested';
    /** The `artifactRevision` the reviewer confirms they read. Required. */
    revision: number;
    comment?: string;
  },
) {
  return api.post<ApprovalRequestDetail>(`/projects/${projectId}/approvals/${id}/decision`, input);
}

export async function cancelApproval(projectId: string, id: string, reason?: string) {
  return api.post<ApprovalRequest>(`/projects/${projectId}/approvals/${id}/cancel`, { reason });
}

// ── Client surface ──────────────────────────────────────────────────────

/**
 * What a client receives for one of their own approval requests.
 *
 * A different type from {@link ApprovalRequest} because the server sends a
 * different body: the portal projection is an explicit allowlist that omits
 * `requestedBy` and `requiredReviewerId` — both raw `User.id` values, which
 * §4.6 keeps off the client surface. Modelling it as its own interface (rather
 * than reusing the staff type and hoping a screen ignores the extra fields)
 * means reading `request.requestedBy` in a client component **does not
 * compile**.
 */
export interface PortalApprovalRequest {
  id: string;
  projectId: string;
  artifactType: ApprovalArtifactType;
  /** Same id the client already uses to open the artifact in their own URLs. */
  artifactId: string;
  artifactRevision: number | null;
  revisionId: string | null;
  title: string;
  detail: string | null;
  dueAt: string | null;
  status: ApprovalStatus;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortalApprovalRequestDetail extends PortalApprovalRequest {
  /** Newest first. Only the head row is the current decision. */
  decisions: ApprovalDecision[];
}

/**
 * Pending and decided requests for the signed-in client. No id arguments —
 * the server derives the client from the session.
 */
export async function listPortalApprovals(options?: { signal?: AbortSignal }) {
  return api.get<{ requests: PortalApprovalRequest[] }>('/portal/approvals', options);
}

export async function getPortalApproval(id: string, options?: { signal?: AbortSignal }) {
  return api.get<PortalApprovalRequestDetail>(`/portal/approvals/${id}`, options);
}

/**
 * Records the client's decision.
 *
 * `revision` is **required by the server** and must equal the request's current
 * `artifactRevision`. It is not a convenience: it is the mechanism that proves
 * the decision was made against the version the client actually read, and the
 * server compares it and rejects a mismatch with a 409. Without it the route
 * 400s, which is exactly what happened before this signature carried it.
 *
 * A 409 means the revision moved under them (or the request was already
 * decided) — §10.4's conflict rule, not a failure to retry blindly. The caller
 * should reload and show what changed.
 */
export async function decidePortalApproval(
  id: string,
  input: {
    decision: 'approved' | 'changes-requested';
    /** The `artifactRevision` the client reviewed. Must match the server's. */
    revision: number;
    comment?: string;
  },
) {
  return api.post<PortalApprovalRequestDetail>(`/portal/approvals/${id}/decision`, input);
}
