/**
 * Approvals Types — G10 version-specific review/approval shapes.
 *
 * @module approvals.types
 */

/** report | content | plan | cycle | claim — what kind of row `artifactId` points at. */
export type ApprovalArtifactType = 'report' | 'content' | 'plan' | 'cycle' | 'claim';

/** operator | client — who is being asked to decide. */
export type ApprovalReviewerType = 'operator' | 'client';

/** pending | approved | changes-requested | cancelled | invalidated */
export type ApprovalStatus = 'pending' | 'approved' | 'changes-requested' | 'cancelled' | 'invalidated';

export type ApprovalDecisionValue = 'approved' | 'changes-requested';

export interface ApprovalDecisionDto {
  id: string;
  approvalRequestId: string;
  decision: ApprovalDecisionValue;
  comment: string | null;
  decidedBy: string;
  decidedByType: 'operator' | 'client';
  decidedRevision: number | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface ApprovalRequestDto {
  id: string;
  projectId: string;
  clientId: string | null;
  artifactType: ApprovalArtifactType;
  artifactId: string;
  artifactRevision: number | null;
  revisionId: string | null;
  title: string;
  detail: string | null;
  reviewerType: ApprovalReviewerType;
  requiredReviewerId: string | null;
  requestedBy: string;
  dueAt: string | null;
  status: ApprovalStatus;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestDetailDto extends ApprovalRequestDto {
  /** Newest first; only the head (not-yet-superseded) row is the current decision. */
  decisions: ApprovalDecisionDto[];
}

export interface CheckResultDto {
  id: string;
  subjectType: string;
  subjectId: string;
  checkKind: string;
  status: string;
  detail: string | null;
  payload: unknown;
  checkedBy: string | null;
  checkedVia: 'automated' | 'human';
  createdAt: string;
}

/** Thrown (as the `detail` of a ConflictException) by {@link ApprovalsService.assertReadyToPublish}. */
export interface PublishBlockedDetail {
  reason: 'unresolved-approval' | 'blocked-claims';
  message: string;
  approvalRequestIds?: string[];
  blockedClaimIds?: string[];
}
