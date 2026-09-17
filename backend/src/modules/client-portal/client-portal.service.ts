/**
 * Client Portal Service — what an authenticated client-type User can read
 * and write. Every method takes the caller's own `clientId` (off the JWT,
 * never a client-supplied value) and scopes every query to it — the one
 * class of bug that matters here, per client-portal.md's own security
 * section: no endpoint trusts a client-supplied account/project id.
 *
 * Read-only except: posting a message. No live engine access — this reads
 * already-computed rows (Report, Gap, Project), same "published snapshot,
 * not the live tables" instinct as the full client-portal.md plan, just
 * without that plan's separate publish-gate machinery.
 *
 * @module client-portal.service
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ReportLifecycleService } from '../reporting/report-lifecycle.service';
import { ContentWorkspaceService } from '../content-workspace/content-workspace.service';
import { WritingStyleService } from '../writing-style/writing-style.service';
import type { PortalProjectDto, PortalReportSummaryDto, PortalMessageDto } from './client-portal.types';

@Injectable()
export class ClientPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportLifecycle: ReportLifecycleService,
    private readonly contentWorkspace: ContentWorkspaceService,
    private readonly writingStyle: WritingStyleService,
  ) {}

  /** Every client-project route re-checks ownership here — never trusts a client-supplied projectId. */
  private async assertOwnsProject(clientId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
    if (!project || project.clientId !== clientId) {
      throw new ForbiddenException('That project does not belong to this client');
    }
  }

  /**
   * P08 §13.5 client-safe content list. Only pieces with an explicitly
   * shared revision appear at all (§13.5 exit gate) — an unshared draft is
   * never included, not merely hidden by the UI.
   */
  async listContent(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const items = await this.contentWorkspace.listClientSafeItems(projectId);
    return { items };
  }

  /**
   * P08 §13.5 client-safe content detail. Defaults to the explicitly shared
   * revision, never the latest internal draft; 404s (rather than a filtered
   * 200) when nothing has ever been shared, so "no content" and "not shared
   * with you" are never confused by the response shape.
   */
  async getContent(clientId: string, projectId: string, assetId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const item = await this.contentWorkspace.getClientSafeItem(projectId, assetId);
    if (!item) throw new NotFoundException(`Content ${assetId} not found or not shared with this client`);
    return item;
  }

  /**
   * P09 §13.8 client-safe writing-style read: the ACTIVE CONFIRMED style
   * only, never a draft — client-edit rights are a §22 D04 decision with no
   * evidence a prior phase settled it, so this stays read-only.
   */
  async getWritingStyle(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    return this.writingStyle.getActive(projectId);
  }

  async listProjects(clientId: string): Promise<{ projects: PortalProjectDto[] }> {
    const rows = await this.prisma.project.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });

    // G05 — "latest" means the latest **released** report. A draft or an
    // unreleased revision is not the client's to see, and showing its score
    // here would leak exactly what the editorial gate holds back. The score
    // must come from the frozen released `ReportRevision` snapshot, not the
    // mutable `Report.scoreTotal` columns: an operator editing a draft
    // revision after release must not change the client's project card, and
    // this is the same snapshot discipline `listReleasedForClient` applies
    // to the report list/detail.
    const projectIds = rows.map((p) => p.id);
    const releasedReports = projectIds.length
      ? await this.prisma.report.findMany({
          where: {
            projectId: { in: projectIds },
            status: 'released',
            releasedRevision: { not: null },
            releasedAt: { not: null },
          },
          orderBy: { releasedAt: 'desc' },
          select: { id: true, projectId: true, releasedRevision: true, releasedAt: true },
        })
      : [];
    const latestReleasedPerProject = new Map<string, (typeof releasedReports)[number]>();
    for (const report of releasedReports) {
      // Ordered by releasedAt desc, so the first seen per project is the latest.
      if (!latestReleasedPerProject.has(report.projectId)) {
        latestReleasedPerProject.set(report.projectId, report);
      }
    }
    // One batched read for every released revision referenced above; each
    // revision is fetched at its exact released number and status — a
    // disagreeing row (status ≠ released) serves nothing, matching the
    // lifecycle service's "serve nothing rather than a guess" rule.
    const revisions = await this.prisma.reportRevision.findMany({
      where: {
        OR: [...latestReleasedPerProject.values()].map((report) => ({
          reportId: report.id,
          revision: report.releasedRevision ?? -1,
          status: 'released',
        })),
      },
      select: { reportId: true, revision: true, snapshot: true },
    });
    const latestScoreByProject = new Map<string, { scoreTotal: number | null; scoreBand: string | null; releasedAt: Date | null }>();
    for (const report of latestReleasedPerProject.values()) {
      const revision = revisions.find((r) => r.reportId === report.id && r.revision === report.releasedRevision);
      if (!revision) continue;
      try {
        const snapshot = JSON.parse(revision.snapshot) as { scoreTotal?: number; scoreBand?: string };
        latestScoreByProject.set(report.projectId, {
          scoreTotal: typeof snapshot.scoreTotal === 'number' ? snapshot.scoreTotal : null,
          scoreBand: typeof snapshot.scoreBand === 'string' ? snapshot.scoreBand : null,
          releasedAt: report.releasedAt,
        });
      } catch {
        // Unreadable snapshot: leave the card without a score rather than
        // falling back to mutable columns or a fabricated value.
      }
    }

    const projects = await Promise.all(
      rows.map(async (p) => {
        const released = latestScoreByProject.get(p.id);
        return {
          id: p.id,
          name: p.name,
          domain: p.domain,
          onboardingStatus: p.onboardingStatus,
          onboardingStep: p.onboardingStep,
          latestScore: released?.scoreTotal ?? null,
          latestBand: released?.scoreBand ?? null,
          lastAuditAt: released?.releasedAt?.toISOString() ?? null,
        };
      }),
    );
    return { projects };
  }

  /**
   * The client's released reports.
   *
   * G05 — delegated to `ReportLifecycleService`, which filters on
   * `status = "released"` **and** a non-null `releasedRevision` and reads each
   * report's title/score from its frozen revision. Before G05 this listed every
   * report row for the client's projects, drafts included (§5.10 step 4).
   */
  async listReports(clientId: string): Promise<{ reports: PortalReportSummaryDto[] }> {
    const { reports } = await this.reportLifecycle.listReleasedForClient(clientId);
    return {
      reports: reports.map((r) => ({
        id: r.reportId,
        projectId: r.projectId,
        slug: r.slug,
        title: r.title,
        scoreTotal: r.scoreTotal,
        scoreBand: r.scoreBand,
        createdAt: r.contentUpdatedAt,
        revision: r.revision,
        releasedAt: r.releasedAt,
      })),
    };
  }

  /**
   * The full report by slug — release-gated, not merely ownership-checked.
   *
   * G05 changed what "the client's report" means: this serves the report's
   * frozen released revision, and a report that is a draft, in review,
   * approved-but-unreleased or withdrawn is answered with the same 404 as one
   * that does not exist. `Report.visibility` is deliberately **not** the gate
   * here — it governs the unauthenticated HTML link, and a released report is
   * routinely private.
   */
  async getReport(clientId: string, slug: string) {
    return this.reportLifecycle.getReleasedForClient(clientId, slug);
  }

  async listMessages(clientId: string): Promise<{ messages: PortalMessageDto[] }> {
    const rows = await this.prisma.clientMessage.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    return {
      messages: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        authorType: r.authorType as PortalMessageDto['authorType'],
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /** Posted by the authenticated CLIENT — authorType is always "client" here, never trusted from the caller. */
  async postMessage(clientId: string, authorUserId: string, dto: { projectId?: string; body: string }): Promise<PortalMessageDto> {
    if (dto.projectId) {
      const owns = await this.prisma.project.findUnique({ where: { id: dto.projectId }, select: { clientId: true } });
      if (!owns || owns.clientId !== clientId) {
        throw new ForbiddenException('That project does not belong to this client');
      }
    }
    const row = await this.prisma.clientMessage.create({
      data: { clientId, projectId: dto.projectId ?? null, authorUserId, authorType: 'client', body: dto.body },
    });
    return {
      id: row.id,
      projectId: row.projectId,
      authorType: 'client',
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
