/**
 * ScopeValidationService — G03: the one place every module asks "does
 * resource X belong to project P, and does the caller have access to P?"
 *
 * Why this exists: design_plan.md Appendix A (G03) audited the source and
 * found nested-id handlers across technical-audit, seo-audit, aeo-audit,
 * reporting and measurement that read a child id (jobId/auditId/querySetId/
 * runId/slug) and act on it WITHOUT checking it belongs to the :projectId in
 * the URL. A caller who knows (or guesses/enumerates) another project's
 * child id can read or mutate it through a URL scoped to a project they do
 * have access to. Hiding the id in the UI does not fix this — the guard has
 * to be server-side, on every handler that resolves a nested id.
 *
 * This service is the reusable fix: two access checks (project/client
 * membership) plus one ownership assertion any module can call before it
 * touches a row. It does not wire itself into other modules' controllers —
 * each module owner injects it and calls the relevant method at the top of
 * every handler that resolves a nested id. See README.md "G03 adoption" for
 * the exact call sites that still need it (auth/users' own lane has none;
 * the remaining gaps are listed there for the owning agents to pick up).
 *
 * Access model:
 * - `type: "client"` caller — allowed only onto their own Client's projects
 *   (ClientMember/project scoping is G02's concern; this checks the client
 *   boundary, not per-project seat scope within a client).
 * - `type: "operator"`, `role: "admin"` — allowed everywhere.
 * - `type: "operator"`, any other role — allowed only onto a project/client
 *   they hold a live (`removedAt: null`) OperatorAssignment for, either
 *   directly (`projectId`) or via the project's owning `clientId`.
 *
 * @module scope-validation.service
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/database/prisma.service';
import type { AuthedRequestUser } from '../../modules/auth/strategies/jwt.strategy';

/** Minimal project shape this service needs — never the whole row. */
export interface ScopedProject {
  id: string;
  clientId: string | null;
}

@Injectable()
export class ScopeValidationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Assert the caller may act on `projectId`, and return the project's id +
   * owning clientId for further checks (e.g. cross-checking a nested id).
   * @throws NotFoundException the project does not exist.
   * @throws ForbiddenException the project exists but the caller has no access.
   */
  async assertProjectAccess(user: AuthedRequestUser, projectId: string): Promise<ScopedProject> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, clientId: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    if (user.type === 'client') {
      if (!user.clientId || project.clientId !== user.clientId) {
        throw new ForbiddenException('This project does not belong to your client account');
      }
      return project;
    }

    if (user.role === 'admin') return project;

    const assigned = await this.isOperatorAssignedToProject(user.userId, project);
    if (!assigned) {
      throw new ForbiddenException('You are not assigned to this project');
    }
    return project;
  }

  /**
   * Assert the caller may act on `clientId` directly (client-list/detail
   * routes, message threads, seat management — anything scoped to the
   * client rather than one of its projects).
   * @throws NotFoundException the client does not exist.
   * @throws ForbiddenException the client exists but the caller has no access.
   */
  async assertClientAccess(user: AuthedRequestUser, clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    if (user.type === 'client') {
      if (user.clientId !== clientId) {
        throw new ForbiddenException('This client does not belong to your account');
      }
      return;
    }
    if (user.role === 'admin') return;

    const count = await this.prisma.operatorAssignment.count({
      where: { userId: user.userId, clientId, removedAt: null },
    });
    if (count === 0) throw new ForbiddenException('You are not assigned to this client');
  }

  /**
   * Assert `dto.projectId` — a project id supplied in a request BODY, not the
   * URL (e.g. a message's optional projectId) — belongs to `clientId`. This
   * is the exact check design_plan.md G03 found present in
   * `client-portal.service.ts#postMessage` and missing from
   * `clients.service.ts#postMessage` (the operator-side equivalent).
   * @throws ForbiddenException the project exists but belongs to a different client.
   * @throws NotFoundException the project id does not exist at all.
   */
  async assertProjectBelongsToClient(projectId: string, clientId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    if (project.clientId !== clientId) {
      throw new ForbiddenException(`Project ${projectId} does not belong to client ${clientId}`);
    }
  }

  /**
   * The generic nested-id fix: given a row fetched by its own id (an audit,
   * a query set, a report, an observation...) and the :projectId from the
   * URL, assert the row actually belongs to that project. Throws
   * NotFoundException (not Forbidden) so a caller cannot use the error to
   * distinguish "exists in another project" from "does not exist at all" —
   * matching the pattern already used by technical-audit's own
   * `getAudit`/`getComparison` (`findFirst({ where: { id, projectId } })`),
   * just usable everywhere a handler fetches by id first and checks after.
   * @throws NotFoundException `row` is null/undefined, or its `projectId` does not match.
   */
  assertOwnedByProject<T extends { projectId: string | null } | null | undefined>(
    row: T,
    projectId: string,
    resourceLabel = 'Resource',
  ): asserts row is NonNullable<T> {
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`${resourceLabel} not found for project ${projectId}`);
    }
  }

  /**
   * Same idea as {@link assertOwnedByProject}, for a background-job payload
   * (BullMQ `job.data`) rather than a Prisma row — the fix for the
   * `GET run/jobs/:jobId` handlers in technical-audit and seo-audit, which
   * currently call `pipelineQueue.getStatus(jobId)` with no relation at all
   * to the URL's :projectId. `PipelineQueueService.getStatus` now reports the
   * job's own `projectId` (G07 added it), which is what this reads. Both
   * audit-job status routes
   * (`technical-audit` and `seo-audit` `GET run/jobs/:jobId`) call it.
   * @throws NotFoundException job data is missing or its projectId does not match.
   */
  assertJobBelongsToProject(
    jobData: Record<string, unknown> | null | undefined,
    projectId: string,
    jobLabel = 'Job',
  ): void {
    const jobProjectId = jobData?.projectId;
    if (!jobData || typeof jobProjectId !== 'string' || jobProjectId !== projectId) {
      throw new NotFoundException(`${jobLabel} not found for project ${projectId}`);
    }
  }

  /**
   * Every project id the caller may see, for list endpoints that must
   * exclude other clients'/other operators' projects. `null` means
   * unrestricted (admin) — callers should skip the `projectId IN (...)`
   * filter entirely rather than passing an empty-vs-null array through
   * Prisma's `in`, which behave differently.
   */
  async getAccessibleProjectIds(user: AuthedRequestUser): Promise<string[] | null> {
    if (user.type === 'operator' && user.role === 'admin') return null;

    if (user.type === 'client') {
      if (!user.clientId) return [];
      const projects = await this.prisma.project.findMany({
        where: { clientId: user.clientId },
        select: { id: true },
      });
      return projects.map((p) => p.id);
    }

    const assignments = await this.prisma.operatorAssignment.findMany({
      where: { userId: user.userId, removedAt: null },
      select: { projectId: true, clientId: true },
    });
    const directProjectIds = assignments.map((a) => a.projectId).filter((id): id is string => Boolean(id));
    const clientIds = assignments.map((a) => a.clientId).filter((id): id is string => Boolean(id));

    let viaClientProjectIds: string[] = [];
    if (clientIds.length > 0) {
      const projects = await this.prisma.project.findMany({
        where: { clientId: { in: clientIds } },
        select: { id: true },
      });
      viaClientProjectIds = projects.map((p) => p.id);
    }
    return Array.from(new Set([...directProjectIds, ...viaClientProjectIds]));
  }

  /** Live (non-removed) OperatorAssignment covering this project, directly or via its client. */
  private async isOperatorAssignedToProject(userId: string, project: ScopedProject): Promise<boolean> {
    const count = await this.prisma.operatorAssignment.count({
      where: {
        userId,
        removedAt: null,
        OR: [{ projectId: project.id }, ...(project.clientId ? [{ clientId: project.clientId }] : [])],
      },
    });
    return count > 0;
  }
}
