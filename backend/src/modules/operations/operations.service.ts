/**
 * OperationsService — G14 portfolio aggregation.
 *
 * Every list here is computed with grouped/batched Prisma queries scoped to
 * the caller's assigned clients (or, for admins, the whole portfolio) — never
 * a per-row loop back out to the database and never a per-client round trip
 * from the caller. A page of 200 clients costs a handful of queries, not 200.
 *
 * Assignment scope: an operator's portfolio is the clients they are directly
 * assigned to via `OperatorAssignment` (role irrelevant — any assignment
 * grants visibility) plus the clients of any project they are assigned to.
 * `admin` always sees everything. This mirrors design_plan G14's "assignment
 * scope is enforced" acceptance criterion.
 *
 * @module operations.service
 */

import { Injectable } from '@nestjs/common';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import type {
  ClientsHealthQueryDto,
  CreateSavedViewDto,
  ReportsQueryDto,
  SalesLeadsQueryDto,
  UpdateSavedViewDto,
  WorkQueryDto,
} from './dto/operations.dto';
import type {
  ClientHealthDto,
  ClientHealthIssueDto,
  EvidenceLinkDto,
  OverviewDto,
  Page,
  ReportRowDto,
  SalesLeadRowDto,
  SavedViewDto,
  WorkRowDto,
} from './operations.types';

/** A source sync older than this counts as "stale" for the health view. */
const STALE_SOURCE_DAYS = 14;
const OPEN_WORK_STATUSES = ['backlog', 'committed', 'active', 'review', 'blocked'];
const OVERDUE_EXCLUDED_STATUSES = ['verified', 'cancelled'];

@Injectable()
export class OperationsService {
  constructor(protected readonly prisma: PrismaService) {}

  // ─── Scope ───────────────────────────────────────────────────────

  /** null = unrestricted (admin). Otherwise the exact client ids this caller may see. */
  private async assignedClientIds(user: AuthedRequestUser): Promise<string[] | null> {
    if (user.role === 'admin') return null;
    const assignments = await this.prisma.operatorAssignment.findMany({
      where: { userId: user.userId, removedAt: null },
      select: { clientId: true, projectId: true },
    });
    const direct = assignments.map((a) => a.clientId).filter((x): x is string => !!x);
    const projectIds = assignments.map((a) => a.projectId).filter((x): x is string => !!x);
    let viaProject: string[] = [];
    if (projectIds.length > 0) {
      const projects = await this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { clientId: true },
      });
      viaProject = projects.map((p) => p.clientId).filter((x): x is string => !!x);
    }
    return Array.from(new Set([...direct, ...viaProject]));
  }

  /** Resolves the project-id universe visible to `user`, honoring an optional client/project filter. */
  private async scopedProjectIds(
    user: AuthedRequestUser,
    filter?: { clientId?: string; projectId?: string },
  ): Promise<{ projectIds: string[]; clientById: Map<string, { id: string; name: string } | null> }> {
    const assigned = await this.assignedClientIds(user);
    if (assigned !== null && filter?.clientId && !assigned.includes(filter.clientId)) {
      throw new ForbiddenException('Client is outside your assigned portfolio');
    }
    if (assigned !== null && assigned.length === 0 && !filter?.projectId) {
      return { projectIds: [], clientById: new Map() };
    }

    const where: { clientId?: { in: string[] } | string; id?: string } = {};
    if (filter?.projectId) where.id = filter.projectId;
    if (filter?.clientId) where.clientId = filter.clientId;
    else if (assigned !== null) where.clientId = { in: assigned };

    const projects = await this.prisma.project.findMany({
      where,
      select: { id: true, clientId: true, client: { select: { id: true, name: true } } },
    });

    if (filter?.projectId && projects.length === 0) {
      throw new NotFoundException(`Project ${filter.projectId} not found`);
    }
    // Non-admin caller named a specific project outside their scope: NotFound, not
    // Forbidden — never confirms the id exists to someone who cannot see it.
    if (filter?.projectId && assigned !== null) {
      const proj = projects[0];
      if (!proj?.clientId || !assigned.includes(proj.clientId)) {
        throw new NotFoundException(`Project ${filter.projectId} not found`);
      }
    }

    const clientById = new Map<string, { id: string; name: string } | null>();
    for (const p of projects) clientById.set(p.id, p.client ? { id: p.client.id, name: p.client.name } : null);
    return { projectIds: projects.map((p) => p.id), clientById };
  }

  // ─── Overview ────────────────────────────────────────────────────

  async getOverview(user: AuthedRequestUser): Promise<OverviewDto> {
    const assigned = await this.assignedClientIds(user);
    const clientWhere = assigned === null ? {} : { id: { in: assigned } };
    const { projectIds } = await this.scopedProjectIds(user);

    const [clientsTotal, clientsActive, clientsPaused, clientsChurned] = await Promise.all([
      this.prisma.client.count({ where: clientWhere }),
      this.prisma.client.count({ where: { ...clientWhere, status: 'active' } }),
      this.prisma.client.count({ where: { ...clientWhere, status: 'paused' } }),
      this.prisma.client.count({ where: { ...clientWhere, status: 'churned' } }),
    ]);

    const projectStatusGroups = projectIds.length
      ? await this.prisma.project.groupBy({ by: ['status'], where: { id: { in: projectIds } }, _count: true })
      : [];
    const byStatus: Record<string, number> = {};
    for (const g of projectStatusGroups) byStatus[g.status] = g._count;

    const now = new Date();
    const [openWork, overdueWork, blockedWork, awaitingApprovals, staleSources] = await Promise.all([
      projectIds.length
        ? this.prisma.workItem.count({ where: { projectId: { in: projectIds }, status: { in: OPEN_WORK_STATUSES } } })
        : 0,
      projectIds.length
        ? this.prisma.workItem.count({
            where: {
              projectId: { in: projectIds },
              dueAt: { lt: now },
              status: { notIn: OVERDUE_EXCLUDED_STATUSES },
            },
          })
        : 0,
      projectIds.length ? this.prisma.workItem.count({ where: { projectId: { in: projectIds }, status: 'blocked' } }) : 0,
      projectIds.length
        ? this.prisma.approvalRequest.count({ where: { projectId: { in: projectIds }, status: 'pending' } })
        : 0,
      projectIds.length ? this.countStaleSources(projectIds) : 0,
    ]);

    const reportGroups = projectIds.length
      ? await this.prisma.report.groupBy({ by: ['status'], where: { projectId: { in: projectIds } }, _count: true })
      : [];
    const reportsByStatus: Record<string, number> = {};
    let reportsTotal = 0;
    for (const g of reportGroups) {
      reportsByStatus[g.status] = g._count;
      reportsTotal += g._count;
    }

    const leadGroups = projectIds.length
      ? await this.prisma.lead.groupBy({ by: ['status'], where: { projectId: { in: projectIds } }, _count: true })
      : [];
    const leadsByStatus: Record<string, number> = {};
    let leadsTotal = 0;
    for (const g of leadGroups) {
      leadsByStatus[g.status] = g._count;
      leadsTotal += g._count;
    }

    const alertGroups = projectIds.length
      ? await this.prisma.alert.groupBy({ by: ['severity'], where: { projectId: { in: projectIds } }, _count: true })
      : [];
    const alertsBySeverity = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
    for (const g of alertGroups) alertsBySeverity[g.severity] = g._count;

    return {
      scope: assigned === null ? 'all' : 'assigned',
      assignedClientCount: assigned === null ? null : assigned.length,
      clients: { total: clientsTotal, active: clientsActive, paused: clientsPaused, churned: clientsChurned },
      projects: { total: projectIds.length, byStatus },
      work: { open: openWork, overdue: overdueWork, blocked: blockedWork, awaitingReview: awaitingApprovals },
      approvals: { pending: awaitingApprovals },
      reports: { total: reportsTotal, byStatus: reportsByStatus },
      leads: { total: leadsTotal, byStatus: leadsByStatus },
      alerts: { critical: alertsBySeverity.critical ?? 0, warning: alertsBySeverity.warning ?? 0, info: alertsBySeverity.info ?? 0 },
      staleSources,
    };
  }

  // ─── Clients / health ────────────────────────────────────────────

  async getClientsHealth(user: AuthedRequestUser, query: ClientsHealthQueryDto): Promise<Page<ClientHealthDto>> {
    const assigned = await this.assignedClientIds(user);
    if (assigned !== null && assigned.length === 0) return this.emptyPage(query);

    const where: Record<string, unknown> = {};
    if (assigned !== null) where.id = { in: assigned };
    if (query.status) where.status = query.status;
    if (query.ownerUserId) where.ownerUserId = query.ownerUserId;
    if (query.search) where.name = { contains: query.search };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    // Fetch a superset when boolean flags are set, since those flags depend on
    // aggregates computed below and cannot be pushed into the Client `where`.
    const needsPostFilter = Boolean(query.hasOverdueWork || query.hasAwaitingDecisions || query.hasStaleSources);
    const clients = await this.prisma.client.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      ...(needsPostFilter ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
    });

    const total = needsPostFilter ? undefined : await this.prisma.client.count({ where });

    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) return this.emptyPage(query);

    const projects = await this.prisma.project.findMany({
      where: { clientId: { in: clientIds } },
      select: { id: true, clientId: true },
    });
    const projectIds = projects.map((p) => p.id);
    const projectsByClient = new Map<string, string[]>();
    for (const p of projects) {
      if (!p.clientId) continue;
      const arr = projectsByClient.get(p.clientId) ?? [];
      arr.push(p.id);
      projectsByClient.set(p.clientId, arr);
    }

    // Prisma's groupBy return type is not exported, so the grouped shapes are
    // declared here. Without these annotations `Promise.all` widens the `[]`
    // arms of the `projectIds.length ? query : []` guards to `never[]`, which
    // collapses the whole tuple to `any[]` — `_count` then types as `{}` and the
    // per-project sums quietly become NaN instead of failing to compile.
    const latestReports = await this.latestReportPerProject(projectIds);
    const openGaps = projectIds.length
      ? await this.prisma.gap.findMany({
          where: { gapAnalysis: { projectId: { in: projectIds } }, status: 'open' },
          select: { id: true, gapAnalysisId: true, title: true, severity: true, priorityScore: true, gapAnalysis: { select: { projectId: true } } },
          orderBy: { priorityScore: 'desc' },
        })
      : [];
    const overdueWorkGroups: Array<{ projectId: string; _count: number }> = [];
    if (projectIds.length) {
      overdueWorkGroups.push(
        ...(await this.prisma.workItem.groupBy({
          by: ['projectId'],
          where: { projectId: { in: projectIds }, dueAt: { lt: new Date() }, status: { notIn: OVERDUE_EXCLUDED_STATUSES } },
          _count: true,
        })),
      );
    }
    const approvalGroups: Array<{ projectId: string; _count: number }> = [];
    if (projectIds.length) {
      approvalGroups.push(
        ...(await this.prisma.approvalRequest.groupBy({ by: ['projectId'], where: { projectId: { in: projectIds }, status: 'pending' }, _count: true })),
      );
    }
    const deliveryLeads = await this.prisma.operatorAssignment.findMany({
      where: { clientId: { in: clientIds }, role: 'delivery-lead', removedAt: null },
      select: { clientId: true, userId: true },
    });
    const staleResources: Map<string, number> = projectIds.length ? await this.staleSourcesByProject(projectIds) : new Map<string, number>();
    const milestones = projectIds.length
      ? await this.prisma.milestone.findMany({
          where: { projectId: { in: projectIds }, dueAt: { gte: new Date() }, status: { in: ['planned', 'at-risk'] } },
          orderBy: { dueAt: 'asc' },
          select: { id: true, projectId: true, title: true, dueAt: true },
        })
      : [];
    const workDue = projectIds.length
      ? await this.prisma.workItem.findMany({
          where: { projectId: { in: projectIds }, dueAt: { gte: new Date() }, status: { notIn: OVERDUE_EXCLUDED_STATUSES } },
          orderBy: { dueAt: 'asc' },
          select: { id: true, projectId: true, title: true, dueAt: true },
        })
      : [];
    const latestScoreRuns = projectIds.length
      ? await this.prisma.scoreRun.findMany({ where: { projectId: { in: projectIds } }, orderBy: { createdAt: 'desc' }, select: { id: true, projectId: true, createdAt: true } })
      : [];

    const userIds = Array.from(new Set(deliveryLeads.map((d) => d.userId)));
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const overdueByProject = new Map(overdueWorkGroups.map((g) => [g.projectId, g._count]));
    const approvalsByProject = new Map(approvalGroups.map((g) => [g.projectId, g._count]));
    const leadByClient = new Map(deliveryLeads.map((d) => [d.clientId as string, d.userId]));
    const latestReportByProject = new Map(latestReports.map((r) => [r.projectId, r]));
    const firstMilestoneByProject = new Map<string, { id: string; title: string; dueAt: Date }>();
    for (const m of milestones) if (!firstMilestoneByProject.has(m.projectId) && m.dueAt) firstMilestoneByProject.set(m.projectId, { id: m.id, title: m.title, dueAt: m.dueAt });
    const firstWorkByProject = new Map<string, { id: string; title: string; dueAt: Date }>();
    for (const w of workDue) if (!firstWorkByProject.has(w.projectId) && w.dueAt) firstWorkByProject.set(w.projectId, { id: w.id, title: w.title, dueAt: w.dueAt });
    const firstScoreRunByProject = new Map<string, string>();
    for (const s of latestScoreRuns) if (!firstScoreRunByProject.has(s.projectId)) firstScoreRunByProject.set(s.projectId, s.id);
    const gapsByProject = new Map<string, typeof openGaps>();
    for (const g of openGaps) {
      const pid = g.gapAnalysis.projectId;
      const arr = gapsByProject.get(pid) ?? [];
      arr.push(g);
      gapsByProject.set(pid, arr);
    }

    const rows: ClientHealthDto[] = clients.map((c) => {
      const pIds = projectsByClient.get(c.id) ?? [];

      let overdueWorkCount = 0;
      let awaitingDecisionsCount = 0;
      let staleSourceCount = 0;
      let currentOpenIssueCount = 0;
      let worstOpenIssue: ClientHealthIssueDto | null = null;
      let bestScore: { projectId: string; score: number; band: string } | null = null;
      let nextCommitment: ClientHealthDto['nextCommitment'] = null;
      const evidence: EvidenceLinkDto[] = [];

      for (const pid of pIds) {
        overdueWorkCount += overdueByProject.get(pid) ?? 0;
        awaitingDecisionsCount += approvalsByProject.get(pid) ?? 0;
        staleSourceCount += staleResources.get(pid) ?? 0;

        const gaps = gapsByProject.get(pid) ?? [];
        currentOpenIssueCount += gaps.length;
        for (const g of gaps) {
          const score = g.priorityScore ?? -1;
          if (!worstOpenIssue || score > (worstOpenIssue.priorityScore ?? -1)) {
            worstOpenIssue = { gapId: g.id, projectId: pid, title: g.title, severity: g.severity, priorityScore: g.priorityScore };
          }
        }

        const report = latestReportByProject.get(pid);
        if (report && (!bestScore || report.scoreTotal > bestScore.score)) {
          bestScore = { projectId: pid, score: report.scoreTotal, band: report.scoreBand };
        }
        if (report) evidence.push({ type: 'report', id: report.id, label: `Report — ${report.slug}` });

        const scoreRunId = firstScoreRunByProject.get(pid);
        if (scoreRunId) evidence.push({ type: 'scoreRun', id: scoreRunId, label: 'Latest score run' });

        const milestone = firstMilestoneByProject.get(pid);
        const work = firstWorkByProject.get(pid);
        const candidate =
          milestone && (!work || milestone.dueAt <= work.dueAt)
            ? { type: 'milestone' as const, id: milestone.id, title: milestone.title, dueAt: milestone.dueAt }
            : work
              ? { type: 'work' as const, id: work.id, title: work.title, dueAt: work.dueAt }
              : null;
        if (candidate && (!nextCommitment || candidate.dueAt < new Date(nextCommitment.dueAt))) {
          nextCommitment = { type: candidate.type, id: candidate.id, title: candidate.title, dueAt: candidate.dueAt.toISOString() };
        }
      }

      const leadUserId = leadByClient.get(c.id);
      const leadUser = leadUserId ? userById.get(leadUserId) : undefined;

      const healthReasons: string[] = [];
      if (overdueWorkCount > 0) healthReasons.push(`${overdueWorkCount} overdue work item${overdueWorkCount === 1 ? '' : 's'}`);
      if (awaitingDecisionsCount > 0) healthReasons.push(`${awaitingDecisionsCount} decision${awaitingDecisionsCount === 1 ? '' : 's'} awaiting review`);
      if (staleSourceCount > 0) healthReasons.push(`${staleSourceCount} stale source${staleSourceCount === 1 ? '' : 's'}`);
      if (worstOpenIssue?.severity) healthReasons.push(`Worst open issue: ${worstOpenIssue.severity}`);
      if (healthReasons.length === 0) healthReasons.push('No open issues, overdue work or stale sources found');

      return {
        id: c.id,
        name: c.name,
        status: c.status,
        projectCount: pIds.length,
        highestLatestProjectScore: bestScore?.score ?? null,
        highestLatestProjectScoreBand: bestScore?.band ?? null,
        healthReasons,
        worstOpenIssue,
        currentOpenIssueCount,
        overdueWorkCount,
        awaitingDecisionsCount,
        staleSourceCount,
        deliveryLead: leadUserId ? { userId: leadUserId, name: leadUser?.name ?? null, email: leadUser?.email ?? '' } : null,
        nextCommitment,
        evidence,
      };
    });

    let filtered = rows;
    if (query.hasOverdueWork) filtered = filtered.filter((r) => r.overdueWorkCount > 0);
    if (query.hasAwaitingDecisions) filtered = filtered.filter((r) => r.awaitingDecisionsCount > 0);
    if (query.hasStaleSources) filtered = filtered.filter((r) => r.staleSourceCount > 0);

    if (needsPostFilter) {
      const finalTotal = filtered.length;
      const start = (page - 1) * pageSize;
      return { items: filtered.slice(start, start + pageSize), page, pageSize, total: finalTotal };
    }

    return { items: filtered, page, pageSize, total: total ?? filtered.length };
  }

  private async latestReportPerProject(projectIds: string[]) {
    if (projectIds.length === 0) return [] as { id: string; projectId: string; slug: string; scoreTotal: number; scoreBand: string; createdAt: Date }[];
    const reports = await this.prisma.report.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, projectId: true, slug: true, scoreTotal: true, scoreBand: true, createdAt: true },
    });
    const seen = new Set<string>();
    const latest: typeof reports = [];
    for (const r of reports) {
      if (seen.has(r.projectId)) continue;
      seen.add(r.projectId);
      latest.push(r);
    }
    return latest;
  }

  /** GoogleProjectResource rows whose lastSyncAt is null or older than STALE_SOURCE_DAYS, grouped by project. */
  private async staleSourcesByProject(projectIds: string[]): Promise<Map<string, number>> {
    const threshold = new Date(Date.now() - STALE_SOURCE_DAYS * 24 * 60 * 60 * 1000);
    const resources = await this.prisma.googleProjectResource.findMany({
      where: { projectId: { in: projectIds }, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: threshold } }] },
      select: { projectId: true },
    });
    const map = new Map<string, number>();
    for (const r of resources) map.set(r.projectId, (map.get(r.projectId) ?? 0) + 1);
    return map;
  }

  private async countStaleSources(projectIds: string[]): Promise<number> {
    const map = await this.staleSourcesByProject(projectIds);
    let total = 0;
    for (const v of map.values()) total += v;
    return total;
  }

  // ─── Work ────────────────────────────────────────────────────────

  async getWork(user: AuthedRequestUser, query: WorkQueryDto): Promise<Page<WorkRowDto>> {
    const { projectIds, clientById } = await this.scopedProjectIds(user, { clientId: query.clientId, projectId: query.projectId });
    if (projectIds.length === 0) return this.emptyPage(query);

    const where: Record<string, unknown> = { projectId: { in: projectIds } };
    if (query.status) where.status = query.status;
    if (query.category) where.category = query.category;
    if (query.discipline) where.discipline = query.discipline;
    if (query.priority) where.priority = query.priority;
    if (query.assigneeId) where.assigneeId = query.assigneeId;
    if (query.search) where.title = { contains: query.search };
    if (query.overdue) {
      where.dueAt = { lt: new Date() };
      where.status = { ...(where.status ? { equals: where.status } : {}), notIn: OVERDUE_EXCLUDED_STATUSES };
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const [rows, total] = await Promise.all([
      this.prisma.workItem.findMany({ where, orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.workItem.count({ where }),
    ]);

    const projects = await this.prisma.project.findMany({ where: { id: { in: rows.map((r) => r.projectId) } }, select: { id: true, name: true } });
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
    const now = new Date();

    const items: WorkRowDto[] = rows.map((r) => {
      const client = clientById.get(r.projectId) ?? null;
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        category: r.category,
        discipline: r.discipline,
        priority: r.priority,
        assigneeId: r.assigneeId,
        dueAt: r.dueAt ? r.dueAt.toISOString() : null,
        overdue: Boolean(r.dueAt && r.dueAt < now && !OVERDUE_EXCLUDED_STATUSES.includes(r.status)),
        projectId: r.projectId,
        projectName: projectNameById.get(r.projectId) ?? r.projectId,
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
      };
    });

    return { items, page, pageSize, total };
  }

  // ─── Reports ─────────────────────────────────────────────────────

  async getReports(user: AuthedRequestUser, query: ReportsQueryDto): Promise<Page<ReportRowDto>> {
    const { projectIds, clientById } = await this.scopedProjectIds(user, { clientId: query.clientId, projectId: query.projectId });
    if (projectIds.length === 0) return this.emptyPage(query);

    const where: Record<string, unknown> = { projectId: { in: projectIds } };
    if (query.status) where.status = query.status;
    if (query.visibility) where.visibility = query.visibility;
    if (query.search) where.title = { contains: query.search };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.report.count({ where }),
    ]);

    const projects = await this.prisma.project.findMany({ where: { id: { in: rows.map((r) => r.projectId) } }, select: { id: true, name: true } });
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

    const items: ReportRowDto[] = rows.map((r) => {
      const client = clientById.get(r.projectId) ?? null;
      return {
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        visibility: r.visibility,
        scoreTotal: r.scoreTotal,
        scoreBand: r.scoreBand,
        projectId: r.projectId,
        projectName: projectNameById.get(r.projectId) ?? r.projectId,
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return { items, page, pageSize, total };
  }

  // ─── Sales leads ─────────────────────────────────────────────────

  async getSalesLeads(user: AuthedRequestUser, query: SalesLeadsQueryDto): Promise<Page<SalesLeadRowDto>> {
    const { projectIds, clientById } = await this.scopedProjectIds(user, { projectId: query.projectId });
    if (projectIds.length === 0) return this.emptyPage(query);

    const where: Record<string, unknown> = { projectId: { in: projectIds } };
    if (query.status) where.status = query.status;
    if (query.source) where.source = query.source;
    if (query.search) where.email = { contains: query.search };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const [rows, total] = await Promise.all([
      this.prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.lead.count({ where }),
    ]);

    const projects = await this.prisma.project.findMany({ where: { id: { in: rows.map((r) => r.projectId) } }, select: { id: true, name: true } });
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

    const items: SalesLeadRowDto[] = rows.map((r) => {
      const client = clientById.get(r.projectId) ?? null;
      return {
        id: r.id,
        email: r.email,
        name: r.name,
        source: r.source,
        status: r.status,
        projectId: r.projectId,
        projectName: projectNameById.get(r.projectId) ?? r.projectId,
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return { items, page, pageSize, total };
  }

  private emptyPage<T>(query: { page?: number; pageSize?: number }): Page<T> {
    return { items: [], page: query.page ?? 1, pageSize: query.pageSize ?? 25, total: 0 };
  }

  // ─── Saved views ─────────────────────────────────────────────────

  async listSavedViews(user: AuthedRequestUser, surface?: string): Promise<SavedViewDto[]> {
    const rows = await this.prisma.savedView.findMany({
      where: { userId: user.userId, ...(surface ? { surface } : {}) },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.toSavedViewDto(r));
  }

  async createSavedView(user: AuthedRequestUser, body: CreateSavedViewDto): Promise<SavedViewDto> {
    const row = await this.prisma.savedView.create({
      data: {
        userId: user.userId,
        surface: body.surface,
        name: body.name,
        filters: JSON.stringify(body.filters ?? {}),
        isDefault: Boolean(body.isDefault),
      },
    });
    return this.toSavedViewDto(row);
  }

  async updateSavedView(user: AuthedRequestUser, id: string, body: UpdateSavedViewDto): Promise<SavedViewDto> {
    const existing = await this.prisma.savedView.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.userId) throw new NotFoundException(`Saved view ${id} not found`);
    const row = await this.prisma.savedView.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.filters !== undefined ? { filters: JSON.stringify(body.filters) } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
    });
    return this.toSavedViewDto(row);
  }

  async deleteSavedView(user: AuthedRequestUser, id: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.prisma.savedView.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.userId) throw new NotFoundException(`Saved view ${id} not found`);
    await this.prisma.savedView.delete({ where: { id } });
    return { id, deleted: true };
  }

  private toSavedViewDto(row: {
    id: string;
    surface: string;
    name: string;
    filters: string;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): SavedViewDto {
    let filters: Record<string, unknown> = {};
    try {
      filters = JSON.parse(row.filters) as Record<string, unknown>;
    } catch {
      filters = {};
    }
    return {
      id: row.id,
      surface: row.surface,
      name: row.name,
      filters,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
