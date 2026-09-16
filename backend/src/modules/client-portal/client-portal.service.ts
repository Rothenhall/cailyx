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

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ReportLifecycleService } from '../reporting/report-lifecycle.service';
import type { PortalProjectDto, PortalReportSummaryDto, PortalMessageDto } from './client-portal.types';

@Injectable()
export class ClientPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportLifecycle: ReportLifecycleService,
  ) {}

  async listProjects(clientId: string): Promise<{ projects: PortalProjectDto[] }> {
    const rows = await this.prisma.project.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    const projects = await Promise.all(
      rows.map(async (p) => {
        // G05 — "latest" means the latest **released** report. A draft or an
        // unreleased revision is not the client's to see, and showing its
        // score here would leak exactly what the editorial gate holds back.
        const latestReport = await this.prisma.report.findFirst({
          where: { projectId: p.id, status: 'released', releasedRevision: { not: null } },
          orderBy: { releasedAt: 'desc' },
          select: { scoreTotal: true, scoreBand: true, releasedAt: true },
        });
        return {
          id: p.id,
          name: p.name,
          domain: p.domain,
          onboardingStatus: p.onboardingStatus,
          onboardingStep: p.onboardingStep,
          latestScore: latestReport?.scoreTotal ?? null,
          latestBand: latestReport?.scoreBand ?? null,
          lastAuditAt: latestReport?.releasedAt?.toISOString() ?? null,
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
