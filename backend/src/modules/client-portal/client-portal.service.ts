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
import { ReportingService } from '../reporting/reporting.service';
import type { PortalProjectDto, PortalReportSummaryDto, PortalMessageDto } from './client-portal.types';

@Injectable()
export class ClientPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reporting: ReportingService,
  ) {}

  async listProjects(clientId: string): Promise<{ projects: PortalProjectDto[] }> {
    const rows = await this.prisma.project.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    const projects = await Promise.all(
      rows.map(async (p) => {
        const latestReport = await this.prisma.report.findFirst({
          where: { projectId: p.id },
          orderBy: { createdAt: 'desc' },
          select: { scoreTotal: true, scoreBand: true, createdAt: true },
        });
        return {
          id: p.id,
          name: p.name,
          domain: p.domain,
          onboardingStatus: p.onboardingStatus,
          onboardingStep: p.onboardingStep,
          latestScore: latestReport?.scoreTotal ?? null,
          latestBand: latestReport?.scoreBand ?? null,
          lastAuditAt: latestReport?.createdAt.toISOString() ?? null,
        };
      }),
    );
    return { projects };
  }

  async listReports(clientId: string): Promise<{ reports: PortalReportSummaryDto[] }> {
    const projectIds = await this.ownProjectIds(clientId);
    if (projectIds.length === 0) return { reports: [] };
    const rows = await this.prisma.report.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, projectId: true, slug: true, title: true, scoreTotal: true, scoreBand: true, createdAt: true },
    });
    return {
      reports: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        slug: r.slug,
        title: r.title,
        scoreTotal: r.scoreTotal,
        scoreBand: r.scoreBand,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The full report by slug — reuses `reporting.getBySlug`, but ownership is
   * checked here FIRST. `includePrivate: true` is passed deliberately: a
   * report generated for this client defaults to `visibility: "private"`
   * (that flag means "not publicly link-shareable", not "hidden from the
   * client it's about") — the client reads their own report either way.
   */
  async getReport(clientId: string, slug: string) {
    const record = await this.prisma.report.findUnique({ where: { slug }, select: { projectId: true } });
    if (!record) throw new NotFoundException(`Report ${slug} not found`);
    const project = await this.prisma.project.findUnique({ where: { id: record.projectId }, select: { clientId: true } });
    if (!project || project.clientId !== clientId) {
      throw new NotFoundException(`Report ${slug} not found`); // 404, not 403 — never confirm another client's report exists
    }
    return this.reporting.getBySlug(slug, true);
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

  private async ownProjectIds(clientId: string): Promise<string[]> {
    const rows = await this.prisma.project.findMany({ where: { clientId }, select: { id: true } });
    return rows.map((r) => r.id);
  }
}
