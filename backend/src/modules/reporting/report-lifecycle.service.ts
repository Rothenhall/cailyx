/**
 * ReportLifecycleService — G05: the report editorial lifecycle, the share
 * policy and the delivery ledger.
 *
 * Contract source: `design_plan.md` line 1623 (G05), §8.3 (the state model),
 * §5.10 (report creation, client delivery, follow-up), §6.4 (comparison and
 * evidence policy) and §11.2 cases 11–12.
 *
 * The four things this service exists to make true, rather than describe:
 *
 *   1. **Public sharing and client release are different axes.** `Report.
 *      visibility` stays what it always was — "may anyone with the URL read
 *      this HTML". `Report.status` is the editorial state. Revoking a public
 *      link never un-releases a report; releasing never mints a public link.
 *      §6.4 and G19/D10 both call this out, and the plan explicitly warns
 *      against reusing `visibility` as a QA state.
 *   2. **A released revision is frozen.** `ReportRevision.snapshot` is written
 *      once, when the revision is locked for review, and is never rewritten —
 *      not by approve, not by publish, not by a later generation. New data
 *      produces a new revision; the old row is left byte-identical with
 *      `supersededBy` pointing at its replacement.
 *   3. **A draft can never reach the portal.** The client-facing reads in
 *      {@link getReleasedForClient} / {@link listReleasedForClient} resolve
 *      `status = "released"` and serve the frozen snapshot at
 *      `Report.releasedRevision` — never the mutable `Report` row.
 *   4. **A failed send does not roll back a release.** `ReportDeliveryAttempt`
 *      is a separate record in a separate table; the release states above are
 *      only ever written by release actions. `status = "sent"` means the
 *      provider accepted the message and is never presented as proof the
 *      recipient read it (§5.10 step 7).
 *
 * The release gate (G10) lives in `ApprovalsService.assertReadyToPublish`,
 * which this service calls before every publication. See the module README.
 *
 * @module report-lifecycle.service
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as bcryptjs from 'bcryptjs';
import type { Report, ReportDeliveryAttempt, ReportRevision, ReportShareLink } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { DeliveryService } from '../delivery/delivery.service';
import { ReportingService } from './reporting.service';
import type {
  ApproveReportDto,
  ClassifyLegacyReportsDto,
  CreateShareLinkDto,
  DeliverReportDto,
  ReviewReportDto,
  WithdrawReportDto,
} from './dto/reporting.dto';
import type {
  DeliveryAttemptDto,
  ReleasedReportDto,
  ReleasedReportSummaryDto,
  ReportEditorialStatus,
  ReportLifecycleDto,
  ReportRevisionDetailDto,
  ReportRevisionDto,
  ReportRevisionSnapshot,
  ReportRevisionStatus,
  ShareLinkCreatedDto,
  ShareLinkDto,
} from './reporting.types';

/**
 * G10 identifies a report by these two strings. Both are load-bearing: the
 * approval request is bound to `('report', Report.id, revision number)` and
 * any claim linked to the frozen revision uses `revisionType
 * 'report-revision'` (the value `RevisionClaimLink` documents for exactly
 * this case). A mismatch here would silently disconnect the gate from the
 * approvals it is supposed to find, so they are constants, not inline
 * literals.
 */
export const REPORT_ARTIFACT_TYPE = 'report';
export const REPORT_REVISION_TYPE = 'report-revision';

/**
 * C6 §31 — thrown when a password-protected share link is opened without a
 * correct password (or valid unlock cookie). A 401, deliberately distinct from
 * the dead-link 404: the link exists and is live, it is just locked, so the
 * public render route responds with a password prompt rather than "not found".
 */
export class ShareLinkPasswordRequiredException extends UnauthorizedException {
  constructor(wasAttempted: boolean) {
    super({
      error: wasAttempted ? 'password-invalid' : 'password-required',
      message: wasAttempted
        ? 'That password is not correct.'
        : 'This report link is password-protected.',
    });
  }
}

/** How long a legacy-classified report's note is allowed to be. Keeps `decisionNote` readable. */
const GRANDFATHER_NOTE =
  'Pre-G05 row. This report was already visible to its client before the editorial lifecycle existed; G05 classified it as released at its existing content so nothing a client may already have read disappears. No internal review was performed for it — reviewedBy is null, and every later revision goes through review/approve/publish normally.';

@Injectable()
export class ReportLifecycleService {
  private readonly logger = new Logger(ReportLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reporting: ReportingService,
    private readonly approvals: ApprovalsService,
    private readonly delivery: DeliveryService,
    private readonly config: ConfigService,
  ) {}

  /** bcrypt cost for a share-link password — matches the auth module's baseline for interactive secrets. */
  private static readonly SHARE_LINK_BCRYPT_ROUNDS = 10;

  /** How long a successful unlock is remembered by the recipient's browser (C6 §31). */
  private static readonly UNLOCK_GRANT_TTL_MS = 30 * 60 * 1000;

  // ─── Read: the operator's view of both axes ───────────────────

  /**
   * Both axes for one report: the editorial state, the revision history and
   * whether a release would currently be refused.
   *
   * `publishBlocked` is a *disclosure*, not a decision: it runs the real gate
   * ({@link ApprovalsService.assertReadyToPublish}) and keeps its refusal
   * message, so RP04 can say why release is unavailable before the operator
   * presses the button. The gate itself still runs again inside
   * {@link publish} — a disclosure that could be stale is not a permission.
   */
  async getLifecycle(projectId: string, slug: string): Promise<ReportLifecycleDto> {
    const report = await this.requireReport(projectId, slug);
    const revisions = await this.prisma.reportRevision.findMany({
      where: { reportId: report.id },
      orderBy: { revision: 'desc' },
    });
    const inFlight = revisions.find((r) => !isSettled(r.status)) ?? null;

    return {
      reportId: report.id,
      slug: report.slug,
      status: report.status as ReportEditorialStatus,
      visibility: report.visibility as 'private' | 'public',
      releasedRevision: report.releasedRevision,
      releasedAt: iso(report.releasedAt),
      releasedBy: report.releasedBy,
      inFlightRevision: inFlight ? toRevisionDto(inFlight) : null,
      revisions: revisions.map(toRevisionDto),
      publishBlocked: await this.peekPublishGate(report, inFlight),
    };
  }

  /** Every revision of one report, newest first. Snapshots are omitted here; use {@link getRevision} for the frozen payload. */
  async listRevisions(projectId: string, slug: string): Promise<{ revisions: ReportRevisionDto[] }> {
    const report = await this.requireReport(projectId, slug);
    const rows = await this.prisma.reportRevision.findMany({
      where: { reportId: report.id },
      orderBy: { revision: 'desc' },
    });
    return { revisions: rows.map(toRevisionDto) };
  }

  /**
   * One revision including its frozen snapshot — what a reviewer reads and
   * what a released client is served. The revision number is resolved
   * *within* the report named by the slug, so a revision number from another
   * project's report 404s rather than resolving (G03).
   */
  async getRevision(projectId: string, slug: string, revision: number): Promise<ReportRevisionDetailDto> {
    const report = await this.requireReport(projectId, slug);
    const row = await this.prisma.reportRevision.findFirst({ where: { reportId: report.id, revision } });
    if (!row) throw new NotFoundException(`Revision ${revision} not found for report ${slug}`);
    return toRevisionDetailDto(row);
  }

  // ─── Lifecycle transitions ─────────────────────────────────────

  /**
   * Lock this report's current content for review (§8.3 "InReview: Snapshot
   * locked").
   *
   * Three cases, in the order they are checked:
   *
   *  - **Nothing in flight and this is the first review** → revision 1 is
   *    created with a fresh snapshot of the report's content.
   *  - **A draft revision exists** (a previous review was sent back with
   *    changes requested) → that same revision is re-locked: its snapshot is
   *    rewritten from the current content. This is the one place a snapshot
   *    is ever overwritten, and it is safe because nothing has been approved
   *    or released from that revision — there is no frozen artifact to
   *    preserve, and numbering a new revision for every editorial round trip
   *    would make the history claim the client saw six versions when it saw
   *    none.
   *  - **The newest revision is settled** (released, superseded or withdrawn)
   *    → a *new* revision N+1 is created. The settled ones are left exactly
   *    as they are. This is how "new data produces a new version" happens.
   *
   * An in-review or approved revision is refused with 409 rather than
   * re-locked: a reviewer looking at revision N must not have it change under
   * them, and an approved revision is a decision someone already made.
   */
  async review(projectId: string, slug: string, actorUserId: string, dto: ReviewReportDto): Promise<ReportRevisionDetailDto> {
    const report = await this.requireReport(projectId, slug);
    const newest = await this.newestRevision(report.id);

    if (newest && (newest.status === 'in-review' || newest.status === 'approved')) {
      throw new ConflictException({
        error: 'revision-not-editable',
        message: `Revision ${newest.revision} is "${newest.status}". A revision under review cannot be re-locked, and an approved one is a recorded decision — publish it, or withdraw it and start the next version.`,
        revision: newest.revision,
      });
    }

    const snapshot = assertUsableSnapshot(await this.reporting.buildRevisionSnapshot(report), report.slug);
    const now = new Date();
    const note = dto.note ?? null;

    const row = newest && newest.status === 'draft'
      ? await this.prisma.reportRevision.update({
          where: { id: newest.id },
          data: { status: 'in-review', title: report.title, snapshot: JSON.stringify(snapshot), manifestId: report.manifestId, reviewedBy: actorUserId, reviewedAt: now, decision: null, decisionNote: note },
        })
      : await this.prisma.reportRevision.create({
          data: {
            reportId: report.id,
            revision: (newest?.revision ?? 0) + 1,
            status: 'in-review',
            title: report.title,
            snapshot: JSON.stringify(snapshot),
            manifestId: report.manifestId,
            reviewedBy: actorUserId,
            reviewedAt: now,
            decision: null,
            decisionNote: note,
            createdBy: actorUserId,
          },
        });

    // G10 rule 1 — a request bound to an older revision must not stay usable
    // for this one. The invalidation is the artifact owner's job, and this is
    // the artifact owner.
    const invalidated = await this.approvals.invalidateStaleRequests(
      REPORT_ARTIFACT_TYPE,
      report.id,
      row.revision,
      `Report ${report.slug} locked revision ${row.revision} for review`,
    );

    await this.prisma.report.update({
      where: { id: report.id },
      data: { status: this.summaryStatusAfter(report, 'in-review') },
    });
    this.logger.log(
      `Report ${report.slug} revision ${row.revision} locked for review by ${actorUserId}` +
        (invalidated > 0 ? ` (${invalidated} stale approval request(s) invalidated)` : ''),
    );
    return toRevisionDetailDto(row);
  }

  /**
   * Record the QA decision for the revision currently in review.
   *
   * `changes-requested` returns the revision to `draft` (§8.3) — it is not
   * discarded, so the next {@link review} re-locks the same revision rather
   * than inventing a new number. `approved` is what {@link publish} requires.
   */
  async approve(projectId: string, slug: string, actorUserId: string, dto: ApproveReportDto): Promise<ReportRevisionDetailDto> {
    const report = await this.requireReport(projectId, slug);
    const newest = await this.newestRevision(report.id);
    if (!newest || newest.status !== 'in-review') {
      throw new ConflictException({
        error: 'nothing-in-review',
        message: newest
          ? `Revision ${newest.revision} is "${newest.status}" — only a revision in review can be decided.`
          : 'This report has no revision in review. Lock one first with review().',
      });
    }

    const nextStatus: ReportRevisionStatus = dto.decision === 'approved' ? 'approved' : 'draft';
    const row = await this.prisma.reportRevision.update({
      where: { id: newest.id },
      data: { status: nextStatus, decision: dto.decision, decisionNote: dto.note ?? null },
    });

    await this.prisma.report.update({
      where: { id: report.id },
      data: { status: this.summaryStatusAfter(report, nextStatus === 'approved' ? 'approved' : 'draft') },
    });
    this.logger.log(`Report ${report.slug} revision ${row.revision} decided "${dto.decision}" by ${actorUserId}`);
    return toRevisionDetailDto(row);
  }

  /**
   * Release an approved revision to the client (§8.3 "Approved →
   * PublishedToClient").
   *
   * The G10 gate runs **before** anything is written, and its refusal is
   * propagated verbatim: an unresolved approval on this exact revision, or a
   * blocked claim linked to it, refuses the release. It cannot be satisfied
   * by calling another endpoint because it reads `ApprovalRequest` /
   * `RevisionClaimLink` / `Claim` directly.
   *
   * Release is one transaction: the revision is marked released, any earlier
   * released revision of the same report is superseded (its snapshot row is
   * not touched — only its status pointer moves), and `Report` is repointed at
   * the new release. Nothing here can fail *after* the release because of a
   * delivery problem: sending is a separate action with its own ledger
   * ({@link deliver}).
   */
  async publish(projectId: string, slug: string, actorUserId: string, note?: string): Promise<ReportRevisionDetailDto> {
    const report = await this.requireReport(projectId, slug);
    const newest = await this.newestRevision(report.id);
    if (!newest || newest.status !== 'approved') {
      throw new ConflictException({
        error: 'not-approved',
        message: newest
          ? `Revision ${newest.revision} is "${newest.status}". Only an approved revision can be released.`
          : 'This report has no revision to release. Lock one with review() and approve it first.',
      });
    }

    // The one served release gate (G10 rules 2 & 5).
    await this.approvals.assertReadyToPublish(
      REPORT_ARTIFACT_TYPE,
      report.id,
      newest.revision,
      newest.id,
      REPORT_REVISION_TYPE,
    );

    const now = new Date();
    const released = await this.prisma.$transaction(async (tx) => {
      // Supersede whatever was released before. `supersededBy` stores the
      // superseding revision's **id** (the same convention
      // `ApprovalDecision.supersededBy` uses), so the pointer resolves to a
      // row rather than to a number that could be reused.
      const prior = await tx.reportRevision.findMany({
        where: { reportId: report.id, status: 'released' },
        select: { id: true },
      });
      if (prior.length > 0) {
        await tx.reportRevision.updateMany({
          where: { id: { in: prior.map((p) => p.id) } },
          data: { status: 'superseded', supersededBy: newest.id },
        });
      }

      const row = await tx.reportRevision.update({
        where: { id: newest.id },
        data: {
          status: 'released',
          publishedBy: actorUserId,
          publishedAt: now,
          decisionNote: note ?? newest.decisionNote,
          // Carry the pinned manifest onto the released row even for reports
          // generated before pinning existed: it stays null there, which is
          // the honest answer, rather than a fabricated one.
          manifestId: newest.manifestId ?? report.manifestId,
        },
      });

      await tx.report.update({
        where: { id: report.id },
        data: { status: 'released', releasedRevision: row.revision, releasedAt: now, releasedBy: actorUserId },
      });
      return row;
    });

    this.logger.log(`Report ${report.slug} revision ${released.revision} released to the client by ${actorUserId}`);
    return toRevisionDetailDto(released);
  }

  /**
   * Pull a released revision back from the client, with a recorded reason
   * (§8.3 "PublishedToClient → Withdrawn", terminal).
   *
   * `releasedRevision` is cleared because nothing is currently shown to the
   * client — "withdrawn" means the client's read stops resolving, not that it
   * still resolves to something. The revision row keeps its frozen snapshot
   * and gains `withdrawnAt`, so what was pulled is still auditable. Every
   * share link for the report stops resolving immediately, because links
   * resolve the report's current release rather than a copy.
   */
  async withdraw(projectId: string, slug: string, actorUserId: string, dto: WithdrawReportDto): Promise<ReportRevisionDetailDto> {
    const report = await this.requireReport(projectId, slug);
    const released = await this.prisma.reportRevision.findFirst({
      where: { reportId: report.id, status: 'released' },
      orderBy: { revision: 'desc' },
    });
    if (!released) {
      throw new ConflictException({
        error: 'nothing-released',
        message: 'Nothing is released for this report, so there is nothing to withdraw.',
      });
    }

    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.reportRevision.update({
        where: { id: released.id },
        data: { status: 'withdrawn', withdrawnAt: now, decisionNote: `Withdrawn by ${actorUserId}: ${dto.reason}` },
      });
      await tx.report.update({
        where: { id: report.id },
        data: { status: 'withdrawn', releasedRevision: null },
      });
      return updated;
    });

    this.logger.warn(`Report ${report.slug} revision ${row.revision} withdrawn by ${actorUserId}: ${dto.reason}`);
    return toRevisionDetailDto(row);
  }

  // ─── Share links (public axis — independent of release) ────────

  /**
   * Mint an expiring, revocable public link for a released report.
   *
   * Only a **released** report can be shared: §6.4 requires the public
   * projection to exclude "unpublished drafts", so a share link is a
   * capability to read the current release — not a way to publish content the
   * client has not received. The functions stay independent in the other
   * direction: this never changes `visibility`, and revoking never changes
   * `status` or `releasedRevision`.
   *
   * The token is returned exactly once. Only its sha256 is stored, so a
   * database read cannot reconstruct a working link (the same reasoning the
   * auth module applies to refresh tokens).
   */
  async createShareLink(projectId: string, slug: string, actorUserId: string, dto: CreateShareLinkDto): Promise<ShareLinkCreatedDto> {
    const report = await this.requireReport(projectId, slug);
    if (report.status !== 'released' || report.releasedRevision == null) {
      throw new ConflictException({
        error: 'not-released',
        message:
          `Report ${slug} is "${report.status}" and has no released revision. A public link may only point at a released report — ` +
          'review, approve and release it first. (Public sharing is a separate axis from release, but it is not a way around it.)',
      });
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = dto.expiresInHours ? new Date(Date.now() + dto.expiresInHours * 60 * 60 * 1000) : null;
    // C6 §31 — bcrypt the optional password (a user-chosen secret). Never store
    // it in cleartext, and never return the hash.
    const passwordHash = dto.password
      ? await bcryptjs.hash(dto.password, ReportLifecycleService.SHARE_LINK_BCRYPT_ROUNDS)
      : null;
    const row = await this.prisma.reportShareLink.create({
      data: {
        reportId: report.id,
        // Which revision was current when the link was minted. Resolution
        // serves the report's *current* release (see `resolveShareToken`), so
        // this is an audit record, not a pin.
        revisionId: await this.currentReleasedRevisionId(report),
        tokenHash: hashCode(token),
        passwordHash,
        createdBy: actorUserId,
        expiresAt,
      },
    });

    this.logger.log(
      `Share link ${row.id} created for report ${report.slug}` +
        `${expiresAt ? ` (expires ${expiresAt.toISOString()})` : ' (no expiry)'}` +
        `${passwordHash ? ' (password-protected)' : ''}`,
    );
    return { ...toShareLinkDto(row), token, url: `/api/reports/shared/${token}` };
  }

  /** Every share link for a report, newest first. Tokens are never included — only the fact that a link exists and whether it still resolves. */
  async listShareLinks(projectId: string, slug: string, includeRevoked = true): Promise<{ links: ShareLinkDto[] }> {
    const report = await this.requireReport(projectId, slug);
    const rows = await this.prisma.reportShareLink.findMany({
      where: { reportId: report.id, ...(includeRevoked ? {} : { revokedAt: null }) },
      orderBy: { createdAt: 'desc' },
    });
    return { links: rows.map(toShareLinkDto) };
  }

  /**
   * Revoke a share link. A revoked link stops resolving on the next request —
   * resolution checks `revokedAt` before it reads anything — and the report's
   * release state is untouched, because the two axes are independent.
   */
  async revokeShareLink(projectId: string, slug: string, linkId: string, actorUserId: string): Promise<ShareLinkDto> {
    const report = await this.requireReport(projectId, slug);
    const row = await this.prisma.reportShareLink.findFirst({ where: { id: linkId, reportId: report.id } });
    if (!row) throw new NotFoundException(`Share link ${linkId} not found for report ${slug}`);
    if (row.revokedAt) return toShareLinkDto(row); // idempotent — revoking twice is not an error

    const updated = await this.prisma.reportShareLink.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`Share link ${row.id} for report ${report.slug} revoked by ${actorUserId}`);
    return toShareLinkDto(updated);
  }

  /**
   * The one 404 every dead-link case collapses to, so a response never
   * discloses which of unknown / revoked / expired / nothing-released it was.
   */
  private get shareNotFound(): NotFoundException {
    return new NotFoundException('This share link is not available. It may have been revoked or expired.');
  }

  /**
   * Load the live share-link row for a token, or throw the single 404. Applies
   * the unknown / revoked / expired gate but **not** the password check — the
   * caller uses the returned `id`/`requiresPassword` to decide whether to
   * prompt (HTML) or refuse (PDF). C6 §31.
   */
  async peekShareLink(token: string): Promise<{ id: string; requiresPassword: boolean }> {
    const row = await this.prisma.reportShareLink.findUnique({ where: { tokenHash: hashCode(token) } });
    if (!row || row.revokedAt) throw this.shareNotFound;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw this.shareNotFound;
    return { id: row.id, requiresPassword: row.passwordHash != null };
  }

  /**
   * Resolve a raw share token for the unauthenticated render route.
   *
   * Returns the report's **current released revision** — never a draft, never
   * the mutable `Report` row, and never a superseded copy. A link that is
   * unknown, expired, revoked, or attached to a report with nothing released
   * (withdrawn included) resolves to 404 with one message, so the answer does
   * not disclose which of those it was.
   *
   * C6 §31: a password-protected link additionally requires proof — either a
   * correct `password`, or an `unlockedLinkId` matching this link's id (a valid
   * unlock cookie the recipient already earned by typing the password). Without
   * proof it throws {@link ShareLinkPasswordRequiredException} (401), which the
   * caller turns into a password prompt rather than the 404 above — the link
   * *does* exist, it is just locked.
   *
   * The view counter is written best-effort after the decision to serve: a
   * failed counter write must not turn a working link into a broken one.
   */
  async resolveShareToken(
    token: string,
    opts: { password?: string; unlockedLinkId?: string } = {},
  ): Promise<{ report: Report; revision: ReportRevision }> {
    const row = await this.prisma.reportShareLink.findUnique({ where: { tokenHash: hashCode(token) } });
    if (!row || row.revokedAt) throw this.shareNotFound;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw this.shareNotFound;

    // C6 §31 password gate — a locked link that exists is a 401, not a 404.
    if (row.passwordHash) {
      const unlockedByCookie = opts.unlockedLinkId != null && opts.unlockedLinkId === row.id;
      const unlockedByPassword =
        opts.password != null && (await bcryptjs.compare(opts.password, row.passwordHash));
      if (!unlockedByCookie && !unlockedByPassword) {
        throw new ShareLinkPasswordRequiredException(opts.password != null);
      }
    }

    const report = await this.prisma.report.findUnique({ where: { id: row.reportId } });
    if (!report || report.status !== 'released' || report.releasedRevision == null) throw this.shareNotFound;

    const revision = await this.prisma.reportRevision.findFirst({
      where: { reportId: report.id, revision: report.releasedRevision, status: 'released' },
    });
    if (!revision) throw this.shareNotFound;

    try {
      await this.prisma.reportShareLink.update({
        where: { id: row.id },
        data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`Share link ${row.id} served but its view counter was not updated: ${(err as Error).message}`);
    }
    return { report, revision };
  }

  // ─── C6 §31: unlock grant (short-lived proof of a correct password) ───

  /**
   * Mint a signed, short-lived grant proving the recipient entered the correct
   * password for `linkId`. Stored in an HttpOnly cookie so the follow-up PDF
   * download and page refreshes do not re-prompt, and so the password itself
   * never travels in a URL. Signed with `JWT_SECRET` (HMAC-SHA256) — a leaked
   * grant only unlocks the one link, and only until it expires.
   */
  mintUnlockGrant(linkId: string): string {
    const exp = Date.now() + ReportLifecycleService.UNLOCK_GRANT_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ linkId, exp })).toString('base64url');
    return `${payload}.${this.signGrant(payload)}`;
  }

  /** Verify an unlock-grant cookie value against `linkId`, in constant time, honoring its expiry. */
  verifyUnlockGrant(value: string | undefined, linkId: string): boolean {
    if (!value) return false;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return false;
    const payload = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    const expected = this.signGrant(payload);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return false;
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        linkId?: unknown;
        exp?: unknown;
      };
      return decoded.linkId === linkId && typeof decoded.exp === 'number' && decoded.exp > Date.now();
    } catch {
      return false;
    }
  }

  /** How long an unlock grant stays valid, in seconds — for the cookie Max-Age. */
  get unlockGrantMaxAgeSeconds(): number {
    return Math.floor(ReportLifecycleService.UNLOCK_GRANT_TTL_MS / 1000);
  }

  private signGrant(payload: string): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  // ─── Delivery ledger ───────────────────────────────────────────

  /** The send attempts recorded for a report, newest first. Never a claim about the inbox. */
  async listDeliveryAttempts(projectId: string, slug: string, limit = 50): Promise<{ attempts: DeliveryAttemptDto[] }> {
    const report = await this.requireReport(projectId, slug);
    const rows = await this.prisma.reportDeliveryAttempt.findMany({
      where: { reportId: report.id },
      orderBy: { attemptedAt: 'desc' },
      take: limit,
    });
    return { attempts: rows.map(toDeliveryAttemptDto) };
  }

  /**
   * Record a delivery attempt — and, for the `email` channel, actually attempt
   * it through the configured provider.
   *
   * The row is written as `queued` *before* the provider is called and then
   * updated to its outcome, so an attempt that dies mid-flight is visible as
   * `queued` ("attempted, outcome unknown") instead of silently vanishing.
   *
   * **The release is never touched here.** A failed send leaves the report
   * released, because the client can still read it in the portal; the failure
   * is a fact about the email, not about the report. Only a released report
   * can be delivered at all — sending a draft would hand a client something
   * their portal will not show them.
   */
  async deliver(projectId: string, slug: string, actorUserId: string, dto: DeliverReportDto): Promise<DeliveryAttemptDto> {
    const report = await this.requireReport(projectId, slug);
    if (report.status !== 'released' || report.releasedRevision == null) {
      throw new ConflictException({
        error: 'not-released',
        message: `Report ${slug} is "${report.status}". Only a released report can be delivered — release it first, or the client would receive a link that opens nothing.`,
      });
    }

    const channel = dto.channel ?? 'email';
    if (channel === 'email' && !isEmail(dto.recipient)) {
      throw new ConflictException({ error: 'invalid-recipient', message: `"${dto.recipient}" is not an email address, so nothing was sent.` });
    }
    // The link the recipient opens is the operator's choice (§5.10 step 6: a
    // public URL, or the client-portal URL that requires a sign-in). Sending an
    // email with no link would be a delivery attempt that cannot work, so it is
    // refused before a row is written rather than recorded as a failed send.
    if (channel === 'email' && !dto.reportUrl) {
      throw new BadRequestException({
        error: 'missing-report-url',
        message: 'reportUrl is required for the email channel: it is the link the recipient opens. Use the report\'s share link or its portal URL.',
      });
    }

    const released = await this.prisma.reportRevision.findFirst({
      where: { reportId: report.id, revision: report.releasedRevision },
      select: { id: true },
    });

    const attempt = await this.prisma.reportDeliveryAttempt.create({
      data: {
        reportId: report.id,
        revisionId: released?.id ?? null,
        channel,
        recipient: dto.recipient,
        subject: dto.subject ?? null,
        status: 'queued',
        attemptedBy: actorUserId,
      },
    });

    if (channel !== 'email') {
      // The operator did this themselves, outside Cailyx. `sent` here is
      // their record of it — there is no provider answer to report.
      const recorded = await this.prisma.reportDeliveryAttempt.update({
        where: { id: attempt.id },
        data: { status: 'sent' },
      });
      return toDeliveryAttemptDto(recorded);
    }

    let status = 'sent';
    let error: string | null = null;
    try {
      await this.delivery.sendReport(projectId, {
        reportUrl: dto.reportUrl ?? '',
        to: dto.recipient,
        subject: dto.subject,
      });
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Report ${report.slug} delivery attempt ${attempt.id} failed: ${error}`);
    }

    const settled = await this.prisma.reportDeliveryAttempt.update({
      where: { id: attempt.id },
      data: { status, error },
    });
    return toDeliveryAttemptDto(settled);
  }

  // ─── Client surface (release-gated reads) ──────────────────────

  /**
   * The released reports of one project, for a client login.
   *
   * Gated on `status = "released"` **and** a non-null `releasedRevision`: a
   * draft, a report awaiting review, an approved-but-unreleased report and a
   * withdrawn one are all absent, and the list says nothing about them
   * existing. §11.2 case 11.
   */
  async listReleasedForClient(clientId: string, projectId?: string): Promise<{ reports: ReleasedReportSummaryDto[] }> {
    if (projectId) await this.assertClientOwnsProject(clientId, projectId);
    const projectIds = projectId ? [projectId] : await this.ownProjectIds(clientId);
    if (projectIds.length === 0) return { reports: [] };
    const rows = await this.prisma.report.findMany({
      where: { projectId: { in: projectIds }, status: 'released', releasedRevision: { not: null } },
      orderBy: { releasedAt: 'desc' },
    });
    const summaries: ReleasedReportSummaryDto[] = [];
    for (const report of rows) {
      const revision = await this.prisma.reportRevision.findFirst({
        where: { reportId: report.id, revision: report.releasedRevision ?? -1, status: 'released' },
      });
      if (!revision) continue; // status and revision disagree — serve nothing rather than a guess
      const snapshot = parseSnapshot(revision.snapshot);
      summaries.push({
        reportId: report.id,
        projectId: report.projectId,
        slug: report.slug,
        title: snapshot.title || revision.title || report.title,
        revision: revision.revision,
        scoreTotal: snapshot.scoreTotal,
        scoreBand: snapshot.scoreBand,
        releasedAt: iso(report.releasedAt),
        contentUpdatedAt: snapshot.contentUpdatedAt,
        // P15 — the frozen sections travel with the summary so the Overview can
        // show what the released report says without a second read and without
        // ever touching the live score tables. `?? null` covers a snapshot
        // written before P15.
        digitalPerformance: snapshot.digitalPerformance ?? null,
        planProgress: snapshot.planProgress ?? null,
      });
    }
    return { reports: summaries };
  }

  /**
   * One released report for a client login, served from the frozen snapshot.
   *
   * Ownership is checked first and answered with the same 404 as "does not
   * exist" (never confirming another client's report), and the release gate
   * is checked second — a report that exists but is not released is also a
   * 404, so the portal cannot be used to discover drafts.
   */
  async getReleasedForClient(clientId: string, slug: string): Promise<ReleasedReportDto> {
    const notFound = new NotFoundException(`Report ${slug} not found`);
    const report = await this.prisma.report.findUnique({ where: { slug } });
    if (!report) throw notFound;
    await this.assertClientOwnsProject(clientId, report.projectId, notFound);
    if (report.status !== 'released' || report.releasedRevision == null) throw notFound;

    const revision = await this.prisma.reportRevision.findFirst({
      where: { reportId: report.id, revision: report.releasedRevision, status: 'released' },
    });
    if (!revision) throw notFound;

    // Served from the **snapshot**, not the live row: this is the read that
    // makes "a released revision is frozen" observable to the person it
    // matters for.
    return this.reporting.buildReleasedView(report, revision);
  }

  // ─── D11 migration ─────────────────────────────────────────────

  /**
   * Classify the reports that predate G05.
   *
   * Every report created before this pass is `status = "draft"` and readable
   * by its client's portal (`§5.10` step 4: "the new private report is
   * immediately accessible to the client's portal"). Two policies were
   * available: hide them all until someone reviews them, or keep them visible
   * and say so.
   *
   * **Chosen: keep them visible, and label them.** Hiding them would delete
   * content a client may already have read, been sent, or discussed with the
   * delivery lead — the app cannot know which, and silently pulling a
   * delivered report back is exactly the kind of unannounced change G05
   * exists to prevent. Keeping them visible also adds no new exposure: they
   * were already in the portal.
   *
   * What the label is careful about: the classification is stored as
   * `decision = "grandfathered"` with a note saying no internal review
   * happened, and `reviewedBy` stays null. It does **not** claim an approval
   * that never took place. The frozen snapshot is taken from the row's
   * existing content, `publishedAt` is the row's own `createdAt` (when the
   * client could first read it), and later edits go through the normal
   * review/approve/publish path as new revisions.
   *
   * Idempotent: a report that already has any revision row is skipped, so
   * re-running classifies nothing twice.
   */
  async classifyLegacyReports(dto: ClassifyLegacyReportsDto): Promise<{
    dryRun: boolean;
    classified: number;
    skipped: number;
    reports: Array<{ slug: string; status: string; visibility: string; releasedAt: string; reason: string }>;
  }> {
    const candidates = await this.prisma.report.findMany({
      where: { status: 'draft' },
      orderBy: { createdAt: 'asc' },
    });
    // `Report` has no relation field to `ReportRevision` (the revision rows
    // carry `reportId`), so this is a second query rather than an include —
    // and it is what makes the method idempotent: a report that already has
    // any revision is left alone.
    const alreadyClassified = await this.prisma.reportRevision.findMany({
      where: { reportId: { in: candidates.map((r) => r.id) } },
      select: { reportId: true },
      distinct: ['reportId'],
    });
    const classifiedIds = new Set(alreadyClassified.map((r) => r.reportId));

    const pending = candidates.filter((r) => !classifiedIds.has(r.id));
    const skipped = candidates.length - pending.length;
    const preview = pending.map((r) => ({
      slug: r.slug,
      status: r.status,
      visibility: r.visibility,
      releasedAt: r.createdAt.toISOString(),
      reason: 'Visible to its client before G05; classified as released at its existing content, un-reviewed (reviewedBy stays null).',
    }));

    if (dto.dryRun) return { dryRun: true, classified: 0, skipped, reports: preview };

    let classified = 0;
    for (const report of pending) {
      const snapshot = assertUsableSnapshot(await this.reporting.buildRevisionSnapshot(report), report.slug);
      await this.prisma.$transaction(async (tx) => {
        const revision = await tx.reportRevision.create({
          data: {
            reportId: report.id,
            revision: 1,
            status: 'released',
            title: report.title,
            snapshot: JSON.stringify(snapshot),
            manifestId: report.manifestId,
            reviewedBy: null,
            reviewedAt: null,
            decision: 'grandfathered',
            decisionNote: GRANDFATHER_NOTE,
            publishedBy: null,
            publishedAt: report.createdAt,
            createdBy: null,
          },
        });
        await tx.report.update({
          where: { id: report.id },
          data: {
            status: 'released',
            releasedRevision: revision.revision,
            releasedAt: report.createdAt,
            releasedBy: null,
          },
        });
      });
      classified += 1;
    }
    this.logger.log(`G05 migration: classified ${classified} pre-G05 report(s) as released at their existing content (${skipped} skipped — already classified)`);
    return { dryRun: false, classified, skipped, reports: preview };
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * The report's summary state after a revision transition.
   *
   * Deliberately sticky once released: while a newer revision is in flight,
   * `status` stays `released` so the client keeps reading the version they
   * were given. The in-flight revision's own state is on its row (and on
   * {@link ReportLifecycleDto.inFlightRevision}) — reporting it by blanking
   * the report back to `draft` would take a live report away from its client.
   */
  private summaryStatusAfter(report: Report, revisionStatus: ReportRevisionStatus): ReportEditorialStatus {
    const hasLiveRelease = report.status === 'released' && report.releasedRevision != null;
    if (hasLiveRelease) return 'released';
    if (revisionStatus === 'superseded') return report.status as ReportEditorialStatus;
    return revisionStatus as ReportEditorialStatus;
  }

  /** Resolve a report by slug *within* the URL's project — a foreign project's slug does not resolve (G03). */
  private async requireReport(projectId: string, slug: string): Promise<Report> {
    const report = await this.prisma.report.findFirst({ where: { slug, projectId } });
    if (!report) throw new NotFoundException(`Report ${slug} not found for project ${projectId}`);
    return report;
  }

  private async newestRevision(reportId: string): Promise<ReportRevision | null> {
    return this.prisma.reportRevision.findFirst({ where: { reportId }, orderBy: { revision: 'desc' } });
  }

  /** Every project id this client owns — the scope every portal read is filtered by, never a client-supplied id. */
  private async ownProjectIds(clientId: string): Promise<string[]> {
    const rows = await this.prisma.project.findMany({ where: { clientId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private async currentReleasedRevisionId(report: Report): Promise<string | null> {
    if (report.releasedRevision == null) return null;
    const row = await this.prisma.reportRevision.findFirst({
      where: { reportId: report.id, revision: report.releasedRevision },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Client boundary for every portal read: the project must belong to this client, and a mismatch is answered as "not found". */
  private async assertClientOwnsProject(clientId: string, projectId: string, notFound?: NotFoundException): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
    if (!project || project.clientId !== clientId) {
      throw notFound ?? new NotFoundException(`Project ${projectId} not found`);
    }
  }

  /**
   * Run the real gate and keep its refusal, for disclosure only. Anything the
   * gate throws that is *not* a structured refusal (a database error, say) is
   * reported as "unknown" rather than as a pass — a disclosure that renders a
   * broken check as green would be worse than no disclosure.
   */
  private async peekPublishGate(report: Report, revision: ReportRevision | null): Promise<{ reason: string; message: string } | null> {
    if (!revision || revision.status !== 'approved') return null;
    try {
      await this.approvals.assertReadyToPublish(REPORT_ARTIFACT_TYPE, report.id, revision.revision, revision.id, REPORT_REVISION_TYPE);
      return null;
    } catch (err) {
      const response = (err as { getResponse?: () => unknown }).getResponse?.();
      if (response && typeof response === 'object' && 'reason' in response && 'message' in response) {
        const detail = response as { reason: unknown; message: unknown };
        return { reason: String(detail.reason), message: String(detail.message) };
      }
      return { reason: 'unknown', message: `The release gate could not be evaluated: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────

/**
 * Refuse to freeze a snapshot that carries no content.
 *
 * This exists because the first version of this service called the async
 * `buildRevisionSnapshot` without awaiting it: `JSON.stringify(promise)` is
 * `"{}"`, so every revision was frozen empty and the type checker had nothing
 * to complain about. A freeze boundary that silently stores nothing is worse
 * than one that fails loudly — the release would look successful while the
 * client's frozen report said nothing at all — so the emptiness is checked
 * here, at the one place a snapshot is written.
 */
function assertUsableSnapshot(snapshot: ReportRevisionSnapshot, slug: string): ReportRevisionSnapshot {
  const empty = !snapshot || (typeof snapshot !== 'object') || (!snapshot.title && !snapshot.executiveSummary);
  if (empty) {
    throw new Error(
      `Refusing to freeze report ${slug}: the revision snapshot came back empty. This is a server bug, not a report problem — nothing was written.`,
    );
  }
  return snapshot;
}

/** A revision is "settled" once it is released, superseded or withdrawn — the states review() will not re-lock. */
function isSettled(status: string): boolean {
  return status === 'released' || status === 'superseded' || status === 'withdrawn';
}

/**
 * sha256, hex. The raw token is never stored: a database leak must not hand
 * an attacker a working public link, and revocation must work by hash.
 */
function hashCode(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Pragmatic email shape check — the provider is the real validator; this only stops an obvious mistake before a send is attempted. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Parse a stored snapshot defensively: a row whose JSON is unreadable renders as an empty snapshot rather than crashing a client read. */
function parseSnapshot(value: string): ReportRevisionSnapshot {
  try {
    return JSON.parse(value) as ReportRevisionSnapshot;
  } catch {
    return { ...EMPTY_SNAPSHOT };
  }
}

const EMPTY_SNAPSHOT: ReportRevisionSnapshot = {
  title: '',
  targetUrl: '',
  executiveSummary: '',
  scoreTotal: 0,
  scoreBand: 'invisible',
  subScores: [],
  findings: [],
  roadmap: [],
  growthPlan: null,
  backlinks: null,
  presence: null,
  competitors: null,
  aeoVisibility: null,
  branding: null,
  rubricVersion: null,
  scoreRunId: null,
  manifestId: null,
  periodId: null,
  cohortId: null,
  digitalPerformance: null,
  planProgress: null,
  contentCreatedAt: '',
  contentUpdatedAt: '',
  snapshotAt: '',
};

function toRevisionDto(row: ReportRevision): ReportRevisionDto {
  return {
    id: row.id,
    reportId: row.reportId,
    revision: row.revision,
    status: row.status as ReportRevisionStatus,
    title: row.title,
    manifestId: row.manifestId,
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    decision: row.decision,
    decisionNote: row.decisionNote,
    publishedBy: row.publishedBy,
    publishedAt: iso(row.publishedAt),
    withdrawnAt: iso(row.withdrawnAt),
    supersededBy: row.supersededBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRevisionDetailDto(row: ReportRevision): ReportRevisionDetailDto {
  return { ...toRevisionDto(row), snapshot: parseSnapshot(row.snapshot) };
}

function toShareLinkDto(row: ReportShareLink): ShareLinkDto {
  return {
    id: row.id,
    reportId: row.reportId,
    revisionId: row.revisionId,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    lastViewedAt: iso(row.lastViewedAt),
    viewCount: row.viewCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    hasPassword: row.passwordHash != null,
  };
}

function toDeliveryAttemptDto(row: ReportDeliveryAttempt): DeliveryAttemptDto {
  return {
    id: row.id,
    reportId: row.reportId,
    revisionId: row.revisionId,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status,
    error: row.error,
    attemptedBy: row.attemptedBy,
    attemptedAt: row.attemptedAt.toISOString(),
  };
}
