/**
 * ApprovalsService — G10.
 *
 * Version-bound review requests and immutable decisions, plus the shared
 * "is this revision safe to publish" gate that other modules (reporting's
 * `publish()`, and any future content-publish path) must call before they
 * release anything to a client. Non-negotiables this service enforces:
 *
 *   1. An `ApprovalRequest` binds to one exact `artifactRevision`. When a
 *      newer revision of the same artifact appears, the caller that knows
 *      about the new revision (e.g. `ReportingService.review()`) calls
 *      {@link invalidateStaleRequests}, which flips every still-pending
 *      request bound to an older revision to `invalidated` — consent never
 *      silently carries forward to the new version.
 *   2. The server — never the caller — checks the approved version and the
 *      claim graph before release. {@link assertReadyToPublish} is the one
 *      place that check lives, so it can't be bypassed by hitting a
 *      different endpoint: reporting's `publish()` calls it, and any future
 *      publisher (content, plan) is expected to call it too rather than
 *      re-implement the check.
 *   3. Decisions are immutable. {@link decide} always inserts a new
 *      `ApprovalDecision` row; an earlier one is only ever updated to set
 *      `supersededBy`, never rewritten.
 *   4. A client can only decide on a request that is theirs (`clientId`
 *      match), still pending (not stale/cancelled/invalidated), and at the
 *      exact revision they say they reviewed (`DecideApprovalDto.revision`
 *      must equal `ApprovalRequest.artifactRevision` — see that DTO's
 *      jsdoc for why this stands in for "not an unseen version").
 *   5. Blocked claims gate publication. {@link assertReadyToPublish} refuses
 *      when any `RevisionClaimLink` on the revision points at a `Claim`
 *      whose `status` is `blocked`.
 *
 * @module approvals.service
 */

import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { CreateApprovalRequestDto, DecideApprovalDto } from './dto/approvals.dto';
import type {
  ApprovalDecisionDto,
  ApprovalRequestDetailDto,
  ApprovalRequestDto,
  ApprovalStatus,
  CheckResultDto,
} from './approvals.types';

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(protected readonly prisma: PrismaService) {}

  // ─── Create / read ──────────────────────────────────────────────

  /**
   * `clientId` on the request is validated against the project when
   * `reviewerType === 'client'` — a caller cannot bind a client-facing
   * approval to a client that doesn't own this project (scope enforced
   * server-side per the brief's hard rule 1, not trusted from the body).
   */
  async create(projectId: string, requestedByUserId: string, dto: CreateApprovalRequestDto): Promise<ApprovalRequestDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const reviewerType = dto.reviewerType ?? 'client';
    let clientId: string | null = null;
    if (reviewerType === 'client') {
      clientId = dto.clientId ?? project.clientId ?? null;
      if (!clientId) {
        throw new ConflictException('This project has no client attached; a client-reviewer approval needs an explicit clientId, or reviewerType "operator".');
      }
      if (project.clientId && clientId !== project.clientId) {
        throw new ForbiddenException(`Client ${clientId} does not own project ${projectId}`);
      }
    }

    const row = await this.prisma.approvalRequest.create({
      data: {
        projectId,
        clientId,
        artifactType: dto.artifactType,
        artifactId: dto.artifactId,
        artifactRevision: dto.artifactRevision,
        revisionId: dto.revisionId ?? null,
        title: dto.title,
        detail: dto.detail ?? null,
        reviewerType,
        requiredReviewerId: dto.requiredReviewerId ?? null,
        requestedBy: requestedByUserId,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
      },
    });
    this.logger.log(`Approval request ${row.id} created for ${dto.artifactType}:${dto.artifactId}@${dto.artifactRevision} (project ${projectId})`);
    return this.toRequestDto(row);
  }

  async get(projectId: string, id: string): Promise<ApprovalRequestDetailDto> {
    const row = await this.requireOwned(projectId, id);
    const decisions = await this.prisma.approvalDecision.findMany({
      where: { approvalRequestId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { ...this.toRequestDto(row), decisions: decisions.map((d) => this.toDecisionDto(d)) };
  }

  async list(projectId: string, filters: { status?: string; artifactType?: string; artifactId?: string }) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        projectId,
        status: filters.status || undefined,
        artifactType: filters.artifactType || undefined,
        artifactId: filters.artifactId || undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { requests: rows.map((r) => this.toRequestDto(r)) };
  }

  // ─── Operator decision / cancel ─────────────────────────────────

  async decide(projectId: string, id: string, actorUserId: string, dto: DecideApprovalDto): Promise<ApprovalRequestDetailDto> {
    const row = await this.requireOwned(projectId, id);
    await this.applyDecision(row, dto, actorUserId, 'operator');
    return this.get(projectId, id);
  }

  async cancel(projectId: string, id: string, reason?: string): Promise<ApprovalRequestDto> {
    const row = await this.requireOwned(projectId, id);
    if (row.status !== 'pending' && row.status !== 'changes-requested') {
      throw new ConflictException(`Approval request ${id} is "${row.status}" and cannot be cancelled`);
    }
    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: 'cancelled', invalidatedAt: new Date(), invalidatedReason: reason ?? 'Cancelled by operator' },
    });
    return this.toRequestDto(updated);
  }

  // ─── Client portal ───────────────────────────────────────────────

  async portalList(clientId: string) {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { clientId, reviewerType: 'client' },
      orderBy: { createdAt: 'desc' },
    });
    return { requests: rows.map((r) => this.toRequestDto(r)) };
  }

  async portalGet(clientId: string, id: string): Promise<ApprovalRequestDetailDto> {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row || row.reviewerType !== 'client' || row.clientId !== clientId) {
      // Same 404 for "does not exist" and "belongs to someone else" — never
      // confirm another client's request exists.
      throw new NotFoundException(`Approval request ${id} not found`);
    }
    const decisions = await this.prisma.approvalDecision.findMany({ where: { approvalRequestId: id }, orderBy: { createdAt: 'desc' } });
    return { ...this.toRequestDto(row), decisions: decisions.map((d) => this.toDecisionDto(d)) };
  }

  async portalDecide(clientId: string, id: string, actorUserId: string, dto: DecideApprovalDto): Promise<ApprovalRequestDetailDto> {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row || row.reviewerType !== 'client' || row.clientId !== clientId) {
      throw new NotFoundException(`Approval request ${id} not found`);
    }
    await this.applyDecision(row, dto, actorUserId, 'client');
    return this.portalGet(clientId, id);
  }

  // ─── Shared decision logic (rules 3 & 4) ────────────────────────

  private async applyDecision(
    row: { id: string; status: string; artifactRevision: number | null },
    dto: DecideApprovalDto,
    actorUserId: string,
    decidedByType: 'operator' | 'client',
  ): Promise<void> {
    if (row.status !== 'pending' && row.status !== 'changes-requested') {
      throw new ConflictException(`Approval request ${row.id} is "${row.status}" — it cannot be decided (stale, cancelled, or already resolved)`);
    }
    // Rule 4: reject an unseen/stale version — the decider must echo back
    // the exact revision the request is currently bound to.
    if (row.artifactRevision != null && dto.revision !== row.artifactRevision) {
      throw new ConflictException(
        `You are reviewing revision ${dto.revision}, but this request is bound to revision ${row.artifactRevision}. Reload the request before deciding.`,
      );
    }

    // Rule 3: immutability — supersede the current head decision (if any)
    // rather than rewrite it.
    const priorHead = await this.prisma.approvalDecision.findFirst({
      where: { approvalRequestId: row.id, supersededBy: null },
      orderBy: { createdAt: 'desc' },
    });

    const created = await this.prisma.approvalDecision.create({
      data: {
        approvalRequestId: row.id,
        decision: dto.decision,
        comment: dto.comment ?? null,
        decidedBy: actorUserId,
        decidedByType,
        decidedRevision: dto.revision,
      },
    });
    if (priorHead) {
      await this.prisma.approvalDecision.update({ where: { id: priorHead.id }, data: { supersededBy: created.id } });
    }

    await this.prisma.approvalRequest.update({
      where: { id: row.id },
      data: { status: dto.decision === 'approved' ? 'approved' : 'changes-requested' },
    });
    this.logger.log(`Approval request ${row.id} decided "${dto.decision}" by ${decidedByType} ${actorUserId} at revision ${dto.revision}`);
  }

  // ─── Revision invalidation (rule 1) ─────────────────────────────

  /**
   * Called by an artifact owner (e.g. `ReportingService`) whenever it locks
   * a new revision. Any request still `pending`/`changes-requested` and
   * bound to an OLDER revision of the same artifact is invalidated —
   * consent for revision N never silently authorizes revision N+1.
   */
  async invalidateStaleRequests(artifactType: string, artifactId: string, currentRevision: number, reason: string): Promise<number> {
    const stale = await this.prisma.approvalRequest.findMany({
      where: {
        artifactType,
        artifactId,
        status: { in: ['pending', 'changes-requested'] },
        artifactRevision: { lt: currentRevision },
      },
      select: { id: true },
    });
    if (stale.length === 0) return 0;
    await this.prisma.approvalRequest.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'invalidated', invalidatedAt: new Date(), invalidatedReason: reason },
    });
    this.logger.log(`Invalidated ${stale.length} stale approval request(s) for ${artifactType}:${artifactId} (< revision ${currentRevision}): ${reason}`);
    return stale.length;
  }

  // ─── Publish gate (rules 2 & 5) ──────────────────────────────────

  /**
   * The one place "is this revision safe to release" is decided. Any
   * publisher (reporting's `publish()` today; content/plan publishers
   * later) must call this and propagate its rejection — it cannot be
   * satisfied by calling a different endpoint, because it reads directly
   * from `ApprovalRequest`/`RevisionClaimLink`/`Claim`, not from anything
   * the caller supplies.
   *
   * Throws `ConflictException` with a {@link PublishBlockedDetail} payload
   * when blocked; resolves silently when clear.
   */
  async assertReadyToPublish(artifactType: string, artifactId: string, artifactRevision: number, revisionId: string, revisionType: string): Promise<void> {
    // Rule 2 — an unresolved review at THIS exact revision blocks release.
    // Approvals at older revisions are irrelevant (already invalidated by
    // rule 1); approvals at this revision that are still pending/awaiting
    // changes mean consent has not been given yet.
    const unresolved = await this.prisma.approvalRequest.findMany({
      where: {
        artifactType,
        artifactId,
        artifactRevision,
        status: { in: ['pending', 'changes-requested'] },
      },
      select: { id: true },
    });
    if (unresolved.length > 0) {
      throw new ConflictException({
        reason: 'unresolved-approval',
        message: `${unresolved.length} approval request(s) for this exact revision are not resolved yet.`,
        approvalRequestIds: unresolved.map((u) => u.id),
      });
    }

    // Rule 5 — a blocked claim linked to this revision refuses publication,
    // full stop; there is no override flag on this method or any other.
    const links = await this.prisma.revisionClaimLink.findMany({
      where: { revisionId, revisionType },
      select: { claimId: true },
    });
    if (links.length > 0) {
      const claims = await this.prisma.claim.findMany({
        where: { id: { in: links.map((l) => l.claimId) }, status: 'blocked' },
        select: { id: true },
      });
      if (claims.length > 0) {
        throw new ConflictException({
          reason: 'blocked-claims',
          message: `${claims.length} claim(s) linked to this revision are blocked and must be resolved before publication.`,
          blockedClaimIds: claims.map((c) => c.id),
        });
      }
    }
  }

  // ─── Check results (source/claim review records) ────────────────

  async recordCheckResult(input: {
    subjectType: string;
    subjectId: string;
    checkKind: string;
    status: string;
    detail?: string;
    payload?: unknown;
    checkedBy?: string;
    checkedVia?: 'automated' | 'human';
    /**
     * The project (and, when known, the client) this check ran against.
     *
     * Stored on the row rather than resolved at read time: the subject is a
     * polymorphic (subjectType, subjectId) pair, so the owning project cannot
     * be joined — only inferred from a subjectType → table mapping, which is a
     * guess that breaks silently when a subject type is added.
     */
    projectId?: string;
    clientId?: string;
  }): Promise<CheckResultDto> {
    const row = await this.prisma.checkResult.create({
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        checkKind: input.checkKind,
        status: input.status,
        detail: input.detail ?? null,
        payload: JSON.stringify(input.payload ?? {}),
        checkedBy: input.checkedBy ?? null,
        checkedVia: input.checkedVia ?? 'automated',
        projectId: input.projectId ?? null,
        clientId: input.clientId ?? null,
      },
    });
    return this.toCheckResultDto(row);
  }

  /**
   * Every check recorded against one subject.
   *
   * Unscoped by intent — this is the operator-only read, and a subject id is
   * already the narrowest thing the caller can name.
   */
  async listCheckResults(subjectType: string, subjectId: string): Promise<{ results: CheckResultDto[] }> {
    const rows = await this.prisma.checkResult.findMany({ where: { subjectType, subjectId }, orderBy: { createdAt: 'desc' } });
    return { results: rows.map((r) => this.toCheckResultDto(r)) };
  }

  /**
   * Every check recorded against a project.
   *
   * This is the read that was impossible before `CheckResult.projectId`
   * existed. Rows written before the column do not appear here — they carry no
   * scope and cannot be attributed after the fact, so they stay reachable only
   * through {@link listCheckResults}. That is a real limit, not a bug, and the
   * route documents it.
   */
  async listCheckResultsForProject(projectId: string): Promise<{ results: CheckResultDto[] }> {
    const rows = await this.prisma.checkResult.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return { results: rows.map((r) => this.toCheckResultDto(r)) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private async requireOwned(projectId: string, id: string) {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Approval request ${id} not found for project ${projectId}`);
    }
    return row;
  }

  private toRequestDto(row: {
    id: string;
    projectId: string;
    clientId: string | null;
    artifactType: string;
    artifactId: string;
    artifactRevision: number | null;
    revisionId: string | null;
    title: string;
    detail: string | null;
    reviewerType: string;
    requiredReviewerId: string | null;
    requestedBy: string;
    dueAt: Date | null;
    status: string;
    invalidatedAt: Date | null;
    invalidatedReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ApprovalRequestDto {
    return {
      id: row.id,
      projectId: row.projectId,
      clientId: row.clientId,
      artifactType: row.artifactType as ApprovalRequestDto['artifactType'],
      artifactId: row.artifactId,
      artifactRevision: row.artifactRevision,
      revisionId: row.revisionId,
      title: row.title,
      detail: row.detail,
      reviewerType: row.reviewerType as ApprovalRequestDto['reviewerType'],
      requiredReviewerId: row.requiredReviewerId,
      requestedBy: row.requestedBy,
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      status: row.status as ApprovalStatus,
      invalidatedAt: row.invalidatedAt ? row.invalidatedAt.toISOString() : null,
      invalidatedReason: row.invalidatedReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDecisionDto(row: {
    id: string;
    approvalRequestId: string;
    decision: string;
    comment: string | null;
    decidedBy: string;
    decidedByType: string;
    decidedRevision: number | null;
    supersededBy: string | null;
    createdAt: Date;
  }): ApprovalDecisionDto {
    return {
      id: row.id,
      approvalRequestId: row.approvalRequestId,
      decision: row.decision as ApprovalDecisionDto['decision'],
      comment: row.comment,
      decidedBy: row.decidedBy,
      decidedByType: row.decidedByType as ApprovalDecisionDto['decidedByType'],
      decidedRevision: row.decidedRevision,
      supersededBy: row.supersededBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toCheckResultDto(row: {
    id: string;
    subjectType: string;
    subjectId: string;
    checkKind: string;
    status: string;
    detail: string | null;
    payload: string;
    checkedBy: string | null;
    checkedVia: string;
    createdAt: Date;
  }): CheckResultDto {
    let payload: unknown = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      checkKind: row.checkKind,
      status: row.status,
      detail: row.detail,
      payload,
      checkedBy: row.checkedBy,
      checkedVia: row.checkedVia as CheckResultDto['checkedVia'],
      createdAt: row.createdAt.toISOString(),
    };
  }
}
