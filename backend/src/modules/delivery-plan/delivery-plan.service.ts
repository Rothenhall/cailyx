/**
 * DeliveryPlanService — G06: engagements, cycles, work items, acceptance
 * checks, verification, milestones and capacity.
 *
 * Ownership is always derived from the URL, never trusted from the body:
 * every method takes the scoping id(s) (`clientId`/`projectId`) from its
 * caller and checks the row actually belongs to them before returning or
 * mutating it (404/409 otherwise) — see AGENT-BRIEF "scope is enforced on
 * the server".
 *
 * @module delivery-plan.service
 */

import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { resolveDueAt } from './lib/timezone.util';
import {
  CYCLE_TRANSITIONS,
  CycleStatus,
  ScopeChangeEntry,
  WORK_ITEM_TRANSITIONS,
  WorkItemStatus,
} from './delivery-plan.types';
import type { CreateEngagementDto, SetEngagementStatusDto, UpdateEngagementDto } from './dto/engagement.dto';
import type { CommitCycleDto, CreateCycleDto, ScopeChangeDto, SetCycleStatusDto, UpdateCycleDto } from './dto/cycle.dto';
import type {
  AddAcceptanceCheckDto,
  BlockWorkItemDto,
  CreateWorkItemDto,
  PortalEvidenceDto,
  SetAcceptanceCheckDto,
  SubmitWorkItemDto,
  UpdateWorkItemDto,
  VerifyWorkItemDto,
} from './dto/work-item.dto';
import type {
  CreateCapacityAllocationDto,
  CreateMilestoneDto,
  UpdateCapacityAllocationDto,
  UpdateMilestoneDto,
} from './dto/capacity.dto';

/** Minimal shape of the authenticated caller this service needs — matches
 * `AuthedRequestUser` without importing the auth module for one field set. */
export interface Actor {
  userId: string;
  role: string;
  type: 'operator' | 'client';
}

@Injectable()
export class DeliveryPlanService {
  constructor(protected readonly prisma: PrismaService) {}

  // ── shared helpers ──────────────────────────────────────────────────

  private parseJsonArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseScopeChanges(raw: string | null | undefined): ScopeChangeEntry[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const c = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!c) throw new NotFoundException('Client not found');
  }

  private async assertProjectExists(projectId: string): Promise<{ id: string; clientId: string | null; engagementId: string | null; timezone: string }> {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, clientId: true, engagementId: true, timezone: true },
    });
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  /** The IANA zone every due date on this project resolves against: the
   * engagement's (if one funds this work), else the project's own. */
  private async resolveTimezone(projectId: string, engagementIdOverride?: string | null): Promise<string> {
    const project = await this.assertProjectExists(projectId);
    const engagementId = engagementIdOverride ?? project.engagementId;
    if (engagementId) {
      const eng = await this.prisma.engagement.findUnique({ where: { id: engagementId }, select: { timezone: true } });
      if (eng?.timezone) return eng.timezone;
    }
    return project.timezone || 'UTC';
  }

  private hasRights(actor: Actor, item: { assigneeId: string | null; reviewerId: string | null }): boolean {
    if (actor.role === 'admin') return true;
    return actor.userId === item.assigneeId || actor.userId === item.reviewerId;
  }

  // ── Engagements ──────────────────────────────────────────────────────

  async listEngagements(clientId: string) {
    await this.assertClientExists(clientId);
    const rows = await this.prisma.engagement.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });
    return { engagements: rows };
  }

  async getEngagement(clientId: string, id: string) {
    const row = await this.prisma.engagement.findUnique({ where: { id } });
    if (!row || row.clientId !== clientId) throw new NotFoundException('Engagement not found');
    return row;
  }

  async createEngagement(clientId: string, dto: CreateEngagementDto) {
    await this.assertClientExists(clientId);
    return this.prisma.engagement.create({
      data: {
        clientId,
        name: dto.name,
        serviceTier: dto.serviceTier ?? 'retainer',
        timezone: dto.timezone ?? 'UTC',
        startsOn: dto.startsOn ? new Date(dto.startsOn) : null,
        endsOn: dto.endsOn ? new Date(dto.endsOn) : null,
        deliveryLead: dto.deliveryLead,
        hoursPerCycle: dto.hoursPerCycle,
        notes: dto.notes,
      },
    });
  }

  async updateEngagement(clientId: string, id: string, dto: UpdateEngagementDto) {
    await this.getEngagement(clientId, id);
    return this.prisma.engagement.update({
      where: { id },
      data: {
        name: dto.name,
        serviceTier: dto.serviceTier,
        timezone: dto.timezone,
        startsOn: dto.startsOn ? new Date(dto.startsOn) : undefined,
        endsOn: dto.endsOn ? new Date(dto.endsOn) : undefined,
        deliveryLead: dto.deliveryLead,
        hoursPerCycle: dto.hoursPerCycle,
        notes: dto.notes,
      },
    });
  }

  /**
   * Dedicated pause/resume/complete/cancel action — design_plan §7.6 pause
   * policy: pausing stops FUTURE committed work from auto-progressing (see
   * `assertEngagementNotPaused`, checked on commit and on any transition
   * into "active"); it never cascades onto in-flight work, which stays
   * exactly where it was, explicitly, rather than vanishing.
   */
  async setEngagementStatus(clientId: string, id: string, dto: SetEngagementStatusDto) {
    const row = await this.getEngagement(clientId, id);
    if (dto.status === 'paused' && row.status !== 'paused') {
      return this.prisma.engagement.update({
        where: { id },
        data: { status: 'paused', pausedAt: new Date(), pauseReason: dto.reason ?? null },
      });
    }
    if (row.status === 'paused' && dto.status !== 'paused') {
      return this.prisma.engagement.update({
        where: { id },
        data: { status: dto.status, pausedAt: null, pauseReason: null },
      });
    }
    return this.prisma.engagement.update({ where: { id }, data: { status: dto.status } });
  }

  /** Throws 409 if the engagement funding `engagementId` is currently
   * paused. Used to block cycle commit and backlog/committed -> active
   * transitions; never applied to in-flight (already active/review/blocked)
   * work, which is left explicit rather than force-stopped. */
  private async assertEngagementNotPaused(engagementId: string | null): Promise<void> {
    if (!engagementId) return;
    const eng = await this.prisma.engagement.findUnique({ where: { id: engagementId }, select: { status: true, pausedAt: true } });
    if (eng?.status === 'paused') {
      throw new ConflictException('Engagement is paused — future committed work cannot be started. In-flight work is unaffected; resume the engagement to continue.');
    }
  }

  // ── Cycles ───────────────────────────────────────────────────────────

  async listCycles(projectId: string, status?: string) {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.cycle.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: { startsOn: 'desc' },
    });
    return { cycles: rows.map((r) => this.toCycleDto(r)) };
  }

  async getCycle(projectId: string, id: string) {
    const row = await this.prisma.cycle.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Cycle not found');
    return row;
  }

  async getCycleDetail(projectId: string, id: string) {
    const cycle = await this.getCycle(projectId, id);
    const workItems = await this.prisma.workItem.findMany({ where: { cycleId: id }, orderBy: { createdAt: 'asc' } });
    return { ...this.toCycleDto(cycle), workItems: workItems.map((w) => this.toWorkItemDto(w, { includeInternal: true })) };
  }

  async createCycle(projectId: string, dto: CreateCycleDto) {
    await this.assertProjectExists(projectId);
    if (dto.engagementId) {
      const eng = await this.prisma.engagement.findUnique({ where: { id: dto.engagementId }, select: { id: true } });
      if (!eng) throw new NotFoundException('Engagement not found');
    }
    const row = await this.prisma.cycle.create({
      data: {
        projectId,
        engagementId: dto.engagementId,
        name: dto.name,
        startsOn: new Date(dto.startsOn),
        endsOn: new Date(dto.endsOn),
        goal: dto.goal,
      },
    });
    return this.toCycleDto(row);
  }

  async updateCycle(projectId: string, id: string, dto: UpdateCycleDto) {
    const cycle = await this.getCycle(projectId, id);
    if (cycle.status === 'closed') throw new ConflictException('A closed cycle cannot be edited');
    const row = await this.prisma.cycle.update({
      where: { id },
      data: {
        name: dto.name,
        startsOn: dto.startsOn ? new Date(dto.startsOn) : undefined,
        endsOn: dto.endsOn ? new Date(dto.endsOn) : undefined,
        goal: dto.goal,
      },
    });
    return this.toCycleDto(row);
  }

  /** Forward-only transitions (active/review/closed). Committing is a
   * separate action — see `commitCycle`. */
  async setCycleStatus(projectId: string, id: string, dto: SetCycleStatusDto) {
    const cycle = await this.getCycle(projectId, id);
    const target = dto.status as CycleStatus;
    if (target === 'committed') {
      throw new ConflictException('Use POST .../cycles/:id/commit to commit a cycle — it also freezes the denominator.');
    }
    const allowed = CYCLE_TRANSITIONS[cycle.status as CycleStatus] ?? [];
    if (!allowed.includes(target)) {
      throw new ConflictException(`Cannot move cycle from "${cycle.status}" to "${target}"`);
    }
    const row = await this.prisma.cycle.update({
      where: { id },
      data: { status: target, closedAt: target === 'closed' ? new Date() : undefined },
    });
    return this.toCycleDto(row);
  }

  /**
   * Commit freezes the denominator: `committedCount` snapshots how many
   * (non-cancelled) work items are attached right now, and `committedAt`
   * is set. Every later scope change is an *append* to `scopeChanges`,
   * never a silent edit of the count — so "we delivered 8 of 10
   * committed" stays true no matter what happens to scope afterwards.
   */
  async commitCycle(projectId: string, id: string, actorId: string, _dto: CommitCycleDto) {
    const cycle = await this.getCycle(projectId, id);
    if (cycle.status !== 'planning') {
      throw new ConflictException(`Only a "planning" cycle can be committed (currently "${cycle.status}")`);
    }
    await this.assertEngagementNotPaused(cycle.engagementId);
    const items = await this.prisma.workItem.findMany({
      where: { cycleId: id, status: { not: 'cancelled' } },
      select: { id: true },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.workItem.updateMany({
        where: { id: { in: items.map((i) => i.id) }, status: 'backlog' },
        data: { status: 'committed' },
      });
      return tx.cycle.update({
        where: { id },
        data: {
          status: 'committed',
          committedAt: new Date(),
          committedBy: actorId,
          committedCount: items.length,
        },
      });
    });
    return this.toCycleDto(row);
  }

  /** Appends one entry to `Cycle.scopeChanges`. Called whenever a work
   * item's cycle membership changes (or the item is cancelled) after the
   * cycle has been committed. Never rewrites `committedCount`. */
  private async appendScopeChange(cycleId: string, actorId: string, reason: string, added: string[], removed: string[]): Promise<void> {
    const cycle = await this.prisma.cycle.findUnique({ where: { id: cycleId }, select: { scopeChanges: true } });
    if (!cycle) return;
    const entries = this.parseScopeChanges(cycle.scopeChanges);
    entries.push({ at: new Date().toISOString(), by: actorId, reason, added, removed });
    await this.prisma.cycle.update({ where: { id: cycleId }, data: { scopeChanges: JSON.stringify(entries) } });
  }

  private toCycleDto(row: {
    id: string; projectId: string; engagementId: string | null; name: string; startsOn: Date; endsOn: Date;
    status: string; goal: string | null; committedAt: Date | null; committedBy: string | null;
    committedCount: number; scopeChanges: string; closedAt: Date | null; createdAt: Date; updatedAt: Date;
  }) {
    return { ...row, scopeChanges: this.parseScopeChanges(row.scopeChanges) };
  }

  // ── Work items ───────────────────────────────────────────────────────

  async listWorkItems(projectId: string, filters: { status?: string; cycleId?: string; assigneeId?: string }) {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.workItem.findMany({
      where: {
        projectId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
        ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      // No `include` here. `AcceptanceCheck` reaches its work item through a
      // plain `workItemId` column rather than a Prisma relation (the schema's
      // convention throughout), so it cannot be included — and the clause that
      // used to sit here asked for it with `false`, which is the default
      // anyway. It was written `as never`, which is why the compiler did not
      // catch an invalid query until it ran.
      //
      // `getWorkItem` reads the checks and verifications separately, which is
      // the correct shape for a list endpoint regardless.
    });
    return { workItems: rows.map((r) => this.toWorkItemDto(r, { includeInternal: true })) };
  }

  async getWorkItem(projectId: string, id: string) {
    const row = await this.getWorkItemRow(projectId, id);
    const checks = await this.prisma.acceptanceCheck.findMany({ where: { workItemId: id }, orderBy: { position: 'asc' } });
    const verifications = await this.prisma.verification.findMany({ where: { workItemId: id }, orderBy: { createdAt: 'desc' } });
    return { ...this.toWorkItemDto(row, { includeInternal: true }), acceptanceChecks: checks, verifications };
  }

  private async getWorkItemRow(projectId: string, id: string) {
    const row = await this.prisma.workItem.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Work item not found');
    return row;
  }

  /** DFS cycle check over `WorkItem.dependsOn`. `dependsOn` = "must finish
   * before this one", scoped to the project (dependencies crossing project
   * boundaries are out of scope for this model). Cycle -> 409. */
  private async assertNoDependencyCycle(projectId: string, workItemId: string, newDeps: string[]): Promise<void> {
    const items = await this.prisma.workItem.findMany({ where: { projectId }, select: { id: true, dependsOn: true } });
    const graph = new Map<string, string[]>();
    for (const it of items) graph.set(it.id, this.parseJsonArray(it.dependsOn));
    graph.set(workItemId, newDeps);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const dep of graph.get(node) ?? []) {
        if (dfs(dep)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    if (dfs(workItemId)) {
      throw new ConflictException('This dependency set creates a cycle');
    }
  }

  /** Validates a cycleId belongs to the project and, if it is already
   * committed, that a `scopeChangeReason` was supplied — then returns the
   * cycle row (or null) and the resolved initial WorkItem status. */
  private async resolveCycleAttachment(projectId: string, cycleId: string | undefined | null, scopeChangeReason: string | undefined) {
    if (!cycleId) return { cycle: null as null | { id: string; status: string; engagementId: string | null }, status: 'backlog' as WorkItemStatus };
    const cycle = await this.prisma.cycle.findUnique({ where: { id: cycleId }, select: { id: true, projectId: true, status: true, engagementId: true } });
    if (!cycle || cycle.projectId !== projectId) throw new NotFoundException('Cycle not found');
    if (cycle.status === 'closed') throw new ConflictException('Cannot attach work to a closed cycle');
    const isCommitted = cycle.status !== 'planning';
    if (isCommitted && !scopeChangeReason) {
      throw new ConflictException('Attaching work to an already-committed cycle requires scopeChangeReason');
    }
    return { cycle, status: (isCommitted ? 'committed' : 'backlog') as WorkItemStatus };
  }

  async createWorkItem(projectId: string, dto: CreateWorkItemDto, actorId: string) {
    const project = await this.assertProjectExists(projectId);
    const { cycle, status } = await this.resolveCycleAttachment(projectId, dto.cycleId, dto.scopeChangeReason);
    if (cycle) await this.assertEngagementNotPaused(cycle.engagementId ?? project.engagementId);

    const dependsOn = dto.dependsOn ?? [];
    if (dependsOn.length) {
      // Validate against a temp id since the row does not exist yet.
      const items = await this.prisma.workItem.findMany({ where: { projectId }, select: { id: true, dependsOn: true } });
      for (const depId of dependsOn) {
        if (!items.some((i) => i.id === depId)) throw new NotFoundException(`dependsOn references unknown work item ${depId}`);
      }
    }

    let dueAt: Date | undefined;
    if (dto.dueOn) {
      const tz = await this.resolveTimezone(projectId, cycle?.engagementId ?? project.engagementId);
      dueAt = resolveDueAt(dto.dueOn, tz);
    }

    const row = await this.prisma.workItem.create({
      data: {
        projectId,
        cycleId: dto.cycleId,
        title: dto.title,
        description: dto.description,
        category: dto.category ?? 'fix',
        discipline: dto.discipline ?? 'technical',
        status,
        priority: dto.priority ?? 'medium',
        assigneeId: dto.assigneeId,
        reviewerId: dto.reviewerId,
        dueAt,
        estimateHours: dto.estimateHours,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        dependsOn: JSON.stringify(dependsOn),
        clientVisible: dto.clientVisible ?? false,
        internalNotes: dto.internalNotes,
        createdBy: actorId,
      },
    });

    if (dto.acceptanceChecklist?.length) {
      await this.prisma.acceptanceCheck.createMany({
        data: dto.acceptanceChecklist.map((description, position) => ({ workItemId: row.id, description, position })),
      });
    }

    if (cycle && cycle.status !== 'planning') {
      await this.appendScopeChange(cycle.id, actorId, dto.scopeChangeReason!, [row.id], []);
    }

    return this.toWorkItemDto(row, { includeInternal: true });
  }

  async updateWorkItem(projectId: string, id: string, dto: UpdateWorkItemDto, actor: Actor) {
    const existing = await this.getWorkItemRow(projectId, id);
    const project = await this.assertProjectExists(projectId);

    let cycleChange: { fromCycle: { id: string; status: string; engagementId: string | null } | null; toCycle: { id: string; status: string; engagementId: string | null } | null } | null = null;
    if (dto.cycleId !== undefined && dto.cycleId !== existing.cycleId) {
      const from = existing.cycleId
        ? await this.prisma.cycle.findUnique({ where: { id: existing.cycleId }, select: { id: true, status: true, engagementId: true } })
        : null;
      const { cycle: toCycle } = await this.resolveCycleAttachment(projectId, dto.cycleId || null, dto.scopeChangeReason);
      // Leaving an already-committed cycle is also a scope change.
      if (from && from.status !== 'planning' && !dto.scopeChangeReason) {
        throw new ConflictException('Removing work from an already-committed cycle requires scopeChangeReason');
      }
      cycleChange = { fromCycle: from, toCycle };
    }

    if (dto.dependsOn) {
      await this.assertNoDependencyCycle(projectId, id, dto.dependsOn);
    }

    let targetStatus: WorkItemStatus | undefined;
    if (dto.status) {
      const target = dto.status as WorkItemStatus;
      if (target === 'review' || target === 'verified' || target === 'blocked') {
        throw new ConflictException('Use /submit, /verify or /block for this transition');
      }
      const allowed = WORK_ITEM_TRANSITIONS[existing.status as WorkItemStatus] ?? [];
      if (!allowed.includes(target)) {
        throw new ConflictException(`Cannot move work item from "${existing.status}" to "${target}"`);
      }
      if (target === 'active') {
        const engagementId = cycleChange?.toCycle?.engagementId ?? project.engagementId;
        await this.assertEngagementNotPaused(engagementId);
      }
      targetStatus = target;
    }

    let dueAt: Date | undefined;
    if (dto.dueOn) {
      const tz = await this.resolveTimezone(projectId, cycleChange?.toCycle?.engagementId ?? project.engagementId);
      dueAt = resolveDueAt(dto.dueOn, tz);
    }

    const row = await this.prisma.workItem.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        category: dto.category,
        discipline: dto.discipline,
        priority: dto.priority,
        cycleId: dto.cycleId !== undefined ? dto.cycleId || null : undefined,
        status: targetStatus,
        assigneeId: dto.assigneeId,
        reviewerId: dto.reviewerId,
        dueAt,
        estimateHours: dto.estimateHours,
        actualHours: dto.actualHours,
        dependsOn: dto.dependsOn ? JSON.stringify(dto.dependsOn) : undefined,
        clientVisible: dto.clientVisible,
        internalNotes: dto.internalNotes,
      },
    });

    if (cycleChange) {
      if (cycleChange.fromCycle && cycleChange.fromCycle.status !== 'planning') {
        await this.appendScopeChange(cycleChange.fromCycle.id, actor.userId, dto.scopeChangeReason!, [], [id]);
      }
      if (cycleChange.toCycle && cycleChange.toCycle.status !== 'planning') {
        await this.appendScopeChange(cycleChange.toCycle.id, actor.userId, dto.scopeChangeReason!, [id], []);
      }
    }

    return this.toWorkItemDto(row, { includeInternal: true });
  }

  /** Hard delete only for scope never committed (backlog, no committed
   * cycle) — once a cycle is committed the item must be cancelled instead,
   * so the frozen denominator's history stays intact. */
  async deleteWorkItem(projectId: string, id: string) {
    const row = await this.getWorkItemRow(projectId, id);
    if (row.cycleId) {
      const cycle = await this.prisma.cycle.findUnique({ where: { id: row.cycleId }, select: { status: true } });
      if (cycle && cycle.status !== 'planning') {
        throw new ConflictException('Work item belongs to a committed cycle — cancel it instead of deleting, so the delivered/committed ratio stays accurate.');
      }
    }
    await this.prisma.acceptanceCheck.deleteMany({ where: { workItemId: id } });
    await this.prisma.verification.deleteMany({ where: { workItemId: id } });
    await this.prisma.workItem.delete({ where: { id } });
    return { deleted: true };
  }

  /** Assignee/reviewer/admin submits the exact deliverable for review.
   * active -> review. */
  async submitWorkItem(projectId: string, id: string, actor: Actor, dto: SubmitWorkItemDto) {
    const row = await this.getWorkItemRow(projectId, id);
    if (!this.hasRights(actor, row)) throw new ForbiddenException('Only the assignee, reviewer, or an admin may submit this work');
    if (row.status !== 'active') throw new ConflictException(`Only "active" work can be submitted (currently "${row.status}")`);
    const evidence = this.formatEvidenceEntry('Submitted', actor.userId, dto.note, dto.sourceUrl);
    return this.toWorkItemDto(
      await this.prisma.workItem.update({
        where: { id },
        data: { status: 'review', description: this.appendEvidence(row.description, evidence) },
      }),
      { includeInternal: true },
    );
  }

  private formatEvidenceEntry(label: string, actorId: string, note?: string, sourceUrl?: string): string {
    const parts = [note, sourceUrl].filter(Boolean).join(' — ');
    return `[${label} ${new Date().toISOString()} by ${actorId}] ${parts}`.trim();
  }

  private appendEvidence(description: string | null, entry: string): string {
    return description ? `${description}\n\n${entry}` : entry;
  }

  /**
   * Records a Verification (evidence, not a checkbox — source URL, run,
   * artifact, observed date, reviewer). `decision: "rejected"` reopens the
   * work item back to "active"; `"accepted"` moves it to "verified".
   */
  async verifyWorkItem(projectId: string, id: string, actor: Actor, dto: VerifyWorkItemDto) {
    const row = await this.getWorkItemRow(projectId, id);
    if (!this.hasRights(actor, row)) throw new ForbiddenException('Only the assignee, reviewer, or an admin may verify this work');
    if (row.status !== 'review' && row.status !== 'verified') {
      throw new ConflictException(`Only work in "review" (or re-verifying "verified") can be verified (currently "${row.status}")`);
    }
    const verification = await this.prisma.verification.create({
      data: {
        workItemId: id,
        sourceUrl: dto.sourceUrl,
        runId: dto.runId,
        runType: dto.runType,
        artifact: dto.artifact,
        observedAt: dto.observedAt ? new Date(dto.observedAt) : new Date(),
        reviewerId: actor.userId,
        decision: dto.decision,
        note: dto.note,
      },
    });
    const nextStatus: WorkItemStatus = dto.decision === 'accepted' ? 'verified' : 'active';
    const workItem = await this.prisma.workItem.update({ where: { id }, data: { status: nextStatus } });
    return { workItem: this.toWorkItemDto(workItem, { includeInternal: true }), verification };
  }

  async blockWorkItem(projectId: string, id: string, actor: Actor, dto: BlockWorkItemDto) {
    const row = await this.getWorkItemRow(projectId, id);
    if (!this.hasRights(actor, row)) throw new ForbiddenException('Only the assignee, reviewer, or an admin may block this work');
    if (!['active', 'committed', 'review'].includes(row.status)) {
      throw new ConflictException(`Cannot block work in status "${row.status}"`);
    }
    return this.toWorkItemDto(
      await this.prisma.workItem.update({
        where: { id },
        data: { status: 'blocked', blockedReason: dto.blockedReason, blockedOn: dto.blockedOn },
      }),
      { includeInternal: true },
    );
  }

  async unblockWorkItem(projectId: string, id: string, actor: Actor) {
    const row = await this.getWorkItemRow(projectId, id);
    if (!this.hasRights(actor, row)) throw new ForbiddenException('Only the assignee, reviewer, or an admin may unblock this work');
    if (row.status !== 'blocked') throw new ConflictException('Work item is not blocked');
    return this.toWorkItemDto(
      await this.prisma.workItem.update({
        where: { id },
        data: { status: 'active', blockedReason: null, blockedOn: null },
      }),
      { includeInternal: true },
    );
  }

  async addAcceptanceCheck(projectId: string, workItemId: string, dto: AddAcceptanceCheckDto) {
    await this.getWorkItemRow(projectId, workItemId);
    const count = await this.prisma.acceptanceCheck.count({ where: { workItemId } });
    return this.prisma.acceptanceCheck.create({ data: { workItemId, description: dto.description, position: count } });
  }

  async setAcceptanceCheck(projectId: string, workItemId: string, checkId: string, actor: Actor, dto: SetAcceptanceCheckDto) {
    const workItem = await this.getWorkItemRow(projectId, workItemId);
    if (!this.hasRights(actor, workItem)) throw new ForbiddenException('Only the assignee, reviewer, or an admin may set acceptance checks');
    const check = await this.prisma.acceptanceCheck.findUnique({ where: { id: checkId } });
    if (!check || check.workItemId !== workItemId) throw new NotFoundException('Acceptance check not found');
    return this.prisma.acceptanceCheck.update({
      where: { id: checkId },
      data: { status: dto.status, note: dto.note, checkedBy: actor.userId, checkedAt: new Date() },
    });
  }

  private toWorkItemDto(
    row: {
      id: string; projectId: string; cycleId: string | null; title: string; description: string | null;
      category: string; discipline: string; status: string; priority: string; assigneeId: string | null;
      reviewerId: string | null; dueAt: Date | null; estimateHours: number | null; actualHours: number | null;
      sourceType: string | null; sourceId: string | null; dependsOn: string; blockedReason: string | null;
      blockedOn: string | null; clientVisible: boolean; internalNotes: string | null; createdBy: string | null;
      createdAt: Date; updatedAt: Date;
    },
    opts: { includeInternal: boolean },
  ) {
    const { internalNotes, ...rest } = row;
    return {
      ...rest,
      dependsOn: this.parseJsonArray(row.dependsOn),
      ...(opts.includeInternal ? { internalNotes } : {}),
    };
  }

  // ── Milestones ───────────────────────────────────────────────────────

  async listMilestones(projectId: string, clientVisibleOnly = false) {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.milestone.findMany({
      where: { projectId, ...(clientVisibleOnly ? { clientVisible: true } : {}) },
      orderBy: { dueAt: 'asc' },
    });
    return { milestones: rows };
  }

  async createMilestone(projectId: string, dto: CreateMilestoneDto) {
    const project = await this.assertProjectExists(projectId);
    let dueAt: Date | undefined;
    if (dto.dueOn) {
      const tz = await this.resolveTimezone(projectId, dto.engagementId ?? project.engagementId);
      dueAt = resolveDueAt(dto.dueOn, tz);
    }
    return this.prisma.milestone.create({
      data: {
        projectId,
        engagementId: dto.engagementId,
        title: dto.title,
        description: dto.description,
        dueAt,
        clientVisible: dto.clientVisible ?? true,
      },
    });
  }

  async updateMilestone(projectId: string, id: string, dto: UpdateMilestoneDto) {
    const row = await this.prisma.milestone.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Milestone not found');
    let dueAt: Date | undefined;
    if (dto.dueOn) {
      const tz = await this.resolveTimezone(projectId, row.engagementId);
      dueAt = resolveDueAt(dto.dueOn, tz);
    }
    return this.prisma.milestone.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        dueAt,
        status: dto.status,
        clientVisible: dto.clientVisible,
        metAt: dto.status === 'met' ? new Date() : undefined,
      },
    });
  }

  async deleteMilestone(projectId: string, id: string) {
    const row = await this.prisma.milestone.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Milestone not found');
    await this.prisma.milestone.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Capacity ─────────────────────────────────────────────────────────

  async listProjectCapacity(projectId: string, cycleId?: string) {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.capacityAllocation.findMany({
      where: { projectId, ...(cycleId ? { cycleId } : {}) },
      orderBy: { startsOn: 'asc' },
    });
    return { allocations: rows, ...this.summarizeCapacity(rows) };
  }

  /** Whole-team calendar read — not scoped to one project, per the "team
   * capacity and calendar" requirement. Operator-only (see controller). */
  async listTeamCapacity(filters: { userId?: string; from?: string; to?: string }) {
    const rows = await this.prisma.capacityAllocation.findMany({
      where: {
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.from ? { endsOn: { gte: new Date(filters.from) } } : {}),
        ...(filters.to ? { startsOn: { lte: new Date(filters.to) } } : {}),
      },
      orderBy: { startsOn: 'asc' },
    });
    return { allocations: rows, ...this.summarizeCapacity(rows) };
  }

  private summarizeCapacity(rows: { availableHours: number; allocatedHours: number }[]) {
    const availableHours = rows.reduce((s, r) => s + r.availableHours, 0);
    const allocatedHours = rows.reduce((s, r) => s + r.allocatedHours, 0);
    return { availableHours, allocatedHours, remainingHours: availableHours - allocatedHours };
  }

  async createCapacityAllocation(projectId: string | null, dto: CreateCapacityAllocationDto) {
    if (projectId) await this.assertProjectExists(projectId);
    return this.prisma.capacityAllocation.create({
      data: {
        userId: dto.userId,
        projectId: projectId ?? undefined,
        cycleId: dto.cycleId,
        startsOn: new Date(dto.startsOn),
        endsOn: new Date(dto.endsOn),
        availableHours: dto.availableHours ?? 0,
        allocatedHours: dto.allocatedHours ?? 0,
        absenceKind: dto.absenceKind,
        note: dto.note,
      },
    });
  }

  async updateCapacityAllocation(id: string, dto: UpdateCapacityAllocationDto) {
    const row = await this.prisma.capacityAllocation.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Capacity allocation not found');
    return this.prisma.capacityAllocation.update({
      where: { id },
      data: {
        startsOn: dto.startsOn ? new Date(dto.startsOn) : undefined,
        endsOn: dto.endsOn ? new Date(dto.endsOn) : undefined,
        availableHours: dto.availableHours,
        allocatedHours: dto.allocatedHours,
        absenceKind: dto.absenceKind,
        note: dto.note,
      },
    });
  }

  async deleteCapacityAllocation(id: string) {
    const row = await this.prisma.capacityAllocation.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Capacity allocation not found');
    await this.prisma.capacityAllocation.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Client portal ────────────────────────────────────────────────────

  private async assertPortalProject(clientId: string, projectId: string) {
    const project = await this.assertProjectExists(projectId);
    if (project.clientId !== clientId) throw new NotFoundException('Project not found');
    return project;
  }

  /** Client-scoped plan: engagement summary, cycles (with the frozen
   * committed/delivered counts, never a live recount), client-visible
   * milestones, and client-visible work items with `internalNotes`
   * stripped by construction (never by field-omission at the response
   * layer alone). */
  async getPortalPlan(clientId: string, projectId: string) {
    const project = await this.assertPortalProject(clientId, projectId);
    const engagement = project.engagementId
      ? await this.prisma.engagement.findUnique({ where: { id: project.engagementId } })
      : null;

    const cycles = await this.prisma.cycle.findMany({ where: { projectId }, orderBy: { startsOn: 'desc' } });
    const cycleDtos = await Promise.all(
      cycles.map(async (c) => {
        const [delivered, total] = await Promise.all([
          this.prisma.workItem.count({ where: { cycleId: c.id, status: 'verified' } }),
          this.prisma.workItem.count({ where: { cycleId: c.id, status: { not: 'cancelled' } } }),
        ]);
        return { ...this.toCycleDto(c), deliveredCount: delivered, currentCount: total };
      }),
    );

    const milestones = await this.prisma.milestone.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueAt: 'asc' } });
    const workItems = await this.prisma.workItem.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueAt: 'asc' } });

    return {
      engagement: engagement ? { id: engagement.id, name: engagement.name, serviceTier: engagement.serviceTier, status: engagement.status, timezone: engagement.timezone, startsOn: engagement.startsOn, endsOn: engagement.endsOn } : null,
      cycles: cycleDtos,
      milestones,
      workItems: workItems.map((w) => this.toWorkItemDto(w, { includeInternal: false })),
    };
  }

  async listPortalWorkItems(clientId: string, projectId: string) {
    await this.assertPortalProject(clientId, projectId);
    const rows = await this.prisma.workItem.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueAt: 'asc' } });
    return { workItems: rows.map((w) => this.toWorkItemDto(w, { includeInternal: false })) };
  }

  /** Client (as assignee — the "client developer" implementation owner of
   * §7.2) records what they did. active -> review, same transition as
   * `/submit`; see PortalEvidenceDto for why this does not fabricate a
   * Verification row. */
  async submitPortalEvidence(clientId: string, projectId: string, workItemId: string, actorUserId: string, dto: PortalEvidenceDto) {
    await this.assertPortalProject(clientId, projectId);
    const row = await this.getWorkItemRow(projectId, workItemId);
    if (!row.clientVisible) throw new NotFoundException('Work item not found');
    if (row.assigneeId !== actorUserId) throw new ForbiddenException('Only the assigned owner may submit evidence for this work item');
    if (row.status !== 'active') throw new ConflictException(`Only "active" work can have evidence submitted (currently "${row.status}")`);
    const evidence = this.formatEvidenceEntry('Client evidence submitted', actorUserId, dto.note, dto.sourceUrl);
    const updated = await this.prisma.workItem.update({
      where: { id: workItemId },
      data: { status: 'review', description: this.appendEvidence(row.description, evidence) },
    });
    return this.toWorkItemDto(updated, { includeInternal: false });
  }
}
