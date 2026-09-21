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
import type { Commitment, Cycle, Milestone, WorkItem } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type {
  ActionItemDto,
  ActionQueueDto,
  CommitmentDto,
  CommitmentProgressDto,
  CommitmentScopeChangeEntry,
  CommitmentStatus,
  PhaseDto,
  PhaseStatus,
  PortalActionSummary,
  PortalBlockedReason,
  PortalCommitmentDto,
  PortalCommitmentScopeChangeDto,
  PortalCycleDto,
  PortalMilestoneDto,
  PortalPhaseDto,
  PortalPlanDto,
  PortalPlanProgressCommitmentDto,
  PortalPlanProgressDto,
  PortalScopeChangeDto,
  PortalWorkItemDto,
  PortalWorkItemsDto,
} from './delivery-plan.types';
import { resolveDueAt } from './lib/timezone.util';
import {
  COMMITMENT_TRANSITIONS,
  CYCLE_TRANSITIONS,
  CycleStatus,
  ScopeChangeEntry,
  WORK_ITEM_TRANSITIONS,
  WorkItemStatus,
} from './delivery-plan.types';
import type { CreateEngagementDto, SetEngagementStatusDto, UpdateEngagementDto } from './dto/engagement.dto';
import type { CommitCycleDto, CreateCycleDto, ScopeChangeDto, SetCycleStatusDto, UpdateCycleDto } from './dto/cycle.dto';
import type { AssignToPhaseDto, CreatePhaseDto, UpdatePhaseDto } from './dto/phase.dto';
import type {
  AgreeCommitmentDto,
  CancelCommitmentDto,
  CommitmentScopeChangeDto,
  CompleteCommitmentDto,
  CreateCommitmentDto,
  RecordOutcomeMetricDto,
  SetCommitmentStatusDto,
  UpdateCommitmentDto,
} from './dto/commitment.dto';
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
    committedCount: number; scopeChanges: string; closedAt: Date | null; phaseId?: string | null;
    createdAt: Date; updatedAt: Date;
  }) {
    return { ...row, scopeChanges: this.parseScopeChanges(row.scopeChanges) };
  }

  // ── Phases (C3, Option B) ────────────────────────────────────────────
  //
  // A thin grouping label above Cycle/Commitment for client-facing display
  // only — docs/analysis/engagement-timeline.md §2. Phase has no lifecycle
  // of its own: `status` is a plain admin-set hint (PHASE_STATUSES has no
  // transition table, unlike Cycle/Commitment), and assigning/clearing a
  // Cycle or Commitment's phaseId never touches that row's own status or
  // approval state.

  private toPhaseDto(row: { id: string; projectId: string; name: string; order: number; status: string; createdAt: Date; updatedAt: Date }): PhaseDto {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      order: row.order,
      status: row.status as PhaseStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listPhases(projectId: string): Promise<{ phases: PhaseDto[] }> {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.phase.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
    return { phases: rows.map((r) => this.toPhaseDto(r)) };
  }

  async getPhase(projectId: string, id: string): Promise<PhaseDto> {
    const row = await this.prisma.phase.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Phase not found');
    return this.toPhaseDto(row);
  }

  /** Order defaults to one past the current highest, so a phase created
   * without an explicit order lands at the end of the sequence rather than
   * colliding with an existing one at 0. */
  async createPhase(projectId: string, dto: CreatePhaseDto): Promise<PhaseDto> {
    await this.assertProjectExists(projectId);
    let order = dto.order;
    if (order === undefined) {
      const last = await this.prisma.phase.findFirst({ where: { projectId }, orderBy: { order: 'desc' }, select: { order: true } });
      order = last ? last.order + 1 : 0;
    }
    const row = await this.prisma.phase.create({
      data: { projectId, name: dto.name, order, status: dto.status ?? 'upcoming' },
    });
    return this.toPhaseDto(row);
  }

  async updatePhase(projectId: string, id: string, dto: UpdatePhaseDto): Promise<PhaseDto> {
    await this.getPhase(projectId, id);
    const row = await this.prisma.phase.update({
      where: { id },
      data: { name: dto.name, order: dto.order, status: dto.status },
    });
    return this.toPhaseDto(row);
  }

  /**
   * Assigns exactly one existing Cycle or Commitment to this phase (both or
   * neither in the body is a 400 — an ambiguous request is refused rather
   * than guessed at). Passing `phaseId: null`-equivalent is not this
   * method's job: clearing an assignment is `removeFromPhase` below, kept
   * separate so "assign" never silently means "unassign".
   *
   * Deliberately does not touch the target's own status/lifecycle fields —
   * a Cycle in `planning` or a Commitment in `draft` stays exactly as it
   * was; Phase is a label, not a gate.
   */
  async assignToPhase(projectId: string, phaseId: string, dto: AssignToPhaseDto): Promise<{ assigned: true }> {
    await this.getPhase(projectId, phaseId);
    const hasCycle = !!dto.cycleId;
    const hasCommitment = !!dto.commitmentId;
    if (hasCycle === hasCommitment) {
      throw new ConflictException('Provide exactly one of cycleId or commitmentId to assign to a phase.');
    }
    if (hasCycle) {
      const cycle = await this.prisma.cycle.findUnique({ where: { id: dto.cycleId }, select: { id: true, projectId: true } });
      if (!cycle || cycle.projectId !== projectId) throw new NotFoundException('Cycle not found');
      await this.prisma.cycle.update({ where: { id: dto.cycleId }, data: { phaseId } });
    } else {
      const commitment = await this.prisma.commitment.findUnique({ where: { id: dto.commitmentId }, select: { id: true, projectId: true } });
      if (!commitment || commitment.projectId !== projectId) throw new NotFoundException('Commitment not found');
      await this.prisma.commitment.update({ where: { id: dto.commitmentId }, data: { phaseId } });
    }
    return { assigned: true };
  }

  /** Clears a Cycle's or Commitment's phaseId — the row goes back to being
   * unphased, exactly like data that predates this feature. */
  async removeFromPhase(projectId: string, dto: AssignToPhaseDto): Promise<{ assigned: false }> {
    const hasCycle = !!dto.cycleId;
    const hasCommitment = !!dto.commitmentId;
    if (hasCycle === hasCommitment) {
      throw new ConflictException('Provide exactly one of cycleId or commitmentId to unassign.');
    }
    if (hasCycle) {
      const cycle = await this.prisma.cycle.findUnique({ where: { id: dto.cycleId }, select: { id: true, projectId: true } });
      if (!cycle || cycle.projectId !== projectId) throw new NotFoundException('Cycle not found');
      await this.prisma.cycle.update({ where: { id: dto.cycleId }, data: { phaseId: null } });
    } else {
      const commitment = await this.prisma.commitment.findUnique({ where: { id: dto.commitmentId }, select: { id: true, projectId: true } });
      if (!commitment || commitment.projectId !== projectId) throw new NotFoundException('Commitment not found');
      await this.prisma.commitment.update({ where: { id: dto.commitmentId }, data: { phaseId: null } });
    }
    return { assigned: false };
  }

  // ── Commitments (P11 — §6.1-6.3) ────────────────────────────────────

  private parseCommitmentScopeChanges(raw: string | null | undefined): CommitmentScopeChangeEntry[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private async appendCommitmentScopeChange(
    commitmentId: string,
    entry: Omit<CommitmentScopeChangeEntry, 'at'>,
  ): Promise<void> {
    const row = await this.prisma.commitment.findUnique({ where: { id: commitmentId }, select: { scopeChanges: true } });
    if (!row) return;
    const entries = this.parseCommitmentScopeChanges(row.scopeChanges);
    entries.push({ at: new Date().toISOString(), ...entry });
    await this.prisma.commitment.update({ where: { id: commitmentId }, data: { scopeChanges: JSON.stringify(entries) } });
  }

  private async getCommitmentRow(projectId: string, id: string): Promise<Commitment> {
    const row = await this.prisma.commitment.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Commitment not found');
    return row;
  }

  /**
   * Progress is always derived at read time, never stored. A countable
   * commitment (targetCount set) counts linked WorkItems whose status is
   * "verified" — the same verification concept G06 established for cycle
   * deliveredCount, never a second one. An outcome commitment reports its
   * recorded metric instead, and is never inferred from linked WorkItems
   * closing (§6.2's "cannot become completed solely because tasks are
   * closed").
   */
  private toCommitmentProgress(row: Commitment, linkedWork: readonly WorkItem[]): CommitmentProgressDto {
    const verifiedCount = linkedWork.filter((w) => w.status === 'verified').length;
    const linkedCount = linkedWork.length;
    let kind: CommitmentProgressDto['kind'] = 'none';
    let label = 'No measurable progress recorded yet.';
    if (row.targetCount != null) {
      kind = 'countable';
      label = `${verifiedCount} of ${row.targetCount}${row.targetUnit ? ` ${row.targetUnit}` : ''}`;
    } else if (row.outcomeMetricLabel) {
      kind = 'outcome';
      label = row.outcomeMetricCurrent != null
        ? `${row.outcomeMetricLabel}: ${row.outcomeMetricCurrent}${row.outcomeMetricUnit ? ` ${row.outcomeMetricUnit}` : ''}${row.outcomeMetricTarget != null ? ` of ${row.outcomeMetricTarget}` : ''}`
        : `${row.outcomeMetricLabel}: not yet observed`;
    } else if (linkedCount > 0) {
      // No explicit target set, but work is linked — report the raw count
      // rather than a percentage, per §6.2.
      kind = 'countable';
      label = `${verifiedCount} of ${linkedCount} linked item(s) verified`;
    }
    return {
      kind,
      verifiedCount,
      linkedCount,
      targetCount: row.targetCount,
      targetUnit: row.targetUnit,
      label,
      outcomeMetricLabel: row.outcomeMetricLabel,
      outcomeMetricUnit: row.outcomeMetricUnit,
      outcomeMetricBaseline: row.outcomeMetricBaseline,
      outcomeMetricTarget: row.outcomeMetricTarget,
      outcomeMetricCurrent: row.outcomeMetricCurrent,
      outcomeMetricObservedAt: row.outcomeMetricObservedAt ? row.outcomeMetricObservedAt.toISOString() : null,
    };
  }

  private async linkedWorkItemsFor(row: Commitment): Promise<WorkItem[]> {
    const ids = this.parseJsonArray(row.linkedWorkItemIds);
    if (ids.length === 0) return [];
    return this.prisma.workItem.findMany({ where: { id: { in: ids }, projectId: row.projectId } });
  }

  private toCommitmentDto(row: Commitment, linkedWork: readonly WorkItem[]): CommitmentDto {
    return {
      id: row.id,
      projectId: row.projectId,
      cycleId: row.cycleId,
      title: row.title,
      reason: row.reason,
      workstream: row.workstream,
      status: row.status as CommitmentStatus,
      targetCount: row.targetCount,
      targetUnit: row.targetUnit,
      targetDate: row.targetDate ? row.targetDate.toISOString() : null,
      outcomeMetricLabel: row.outcomeMetricLabel,
      outcomeMetricUnit: row.outcomeMetricUnit,
      outcomeMetricBaseline: row.outcomeMetricBaseline,
      outcomeMetricTarget: row.outcomeMetricTarget,
      outcomeMetricCurrent: row.outcomeMetricCurrent,
      outcomeMetricObservedAt: row.outcomeMetricObservedAt ? row.outcomeMetricObservedAt.toISOString() : null,
      accountableLead: row.accountableLead,
      clientVisibleLead: row.clientVisibleLead,
      linkedWorkItemIds: this.parseJsonArray(row.linkedWorkItemIds),
      contentRef: row.contentRef,
      agreedAt: row.agreedAt ? row.agreedAt.toISOString() : null,
      agreedBy: row.agreedBy,
      scopeChanges: this.parseCommitmentScopeChanges(row.scopeChanges),
      supersededBy: row.supersededBy,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      cancelReason: row.cancelReason,
      progress: this.toCommitmentProgress(row, linkedWork),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Client-safe projection: real lead name only when clientVisibleLead is
   * set, no work-item ids, scope history stripped of actor ids (mirrors
   * `toPortalScopeChanges`'s discipline exactly). */
  private toPortalCommitmentDto(row: Commitment, linkedWork: readonly WorkItem[], nextClientAction: PortalActionSummary | null): PortalCommitmentDto {
    const changes = this.parseCommitmentScopeChanges(row.scopeChanges);
    const portalChanges: PortalCommitmentScopeChangeDto[] = changes.map((c) => ({
      at: c.at,
      reason: c.reason,
      previousTarget: c.previousTarget,
      newTarget: c.newTarget,
      previousDate: c.previousDate,
      newDate: c.newDate,
      requiresReconfirmation: c.requiresReconfirmation,
    }));
    return {
      id: row.id,
      cycleId: row.cycleId,
      title: row.title,
      reason: row.reason,
      workstream: row.workstream,
      status: row.status as CommitmentStatus,
      progress: this.toCommitmentProgress(row, linkedWork),
      accountableLead: row.clientVisibleLead && row.accountableLead ? row.accountableLead : 'Your Cailyx team',
      targetDate: row.targetDate ? row.targetDate.toISOString() : null,
      contentRef: row.contentRef,
      nextClientAction,
      scopeChanges: portalChanges,
    };
  }

  async listCommitments(projectId: string, filters: { cycleId?: string; status?: string } = {}): Promise<CommitmentDto[]> {
    await this.assertProjectExists(projectId);
    const rows = await this.prisma.commitment.findMany({
      where: { projectId, ...(filters.cycleId ? { cycleId: filters.cycleId } : {}), ...(filters.status ? { status: filters.status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map(async (r) => this.toCommitmentDto(r, await this.linkedWorkItemsFor(r))));
  }

  async getCommitment(projectId: string, id: string): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    return this.toCommitmentDto(row, await this.linkedWorkItemsFor(row));
  }

  async createCommitment(projectId: string, dto: CreateCommitmentDto, actorId: string): Promise<CommitmentDto> {
    await this.assertProjectExists(projectId);
    const cycle = await this.prisma.cycle.findUnique({ where: { id: dto.cycleId }, select: { id: true, projectId: true } });
    if (!cycle || cycle.projectId !== projectId) throw new NotFoundException('Cycle not found for this project');

    const linkedWorkItemIds = dto.linkedWorkItemIds ?? [];
    if (linkedWorkItemIds.length) {
      const found = await this.prisma.workItem.findMany({ where: { id: { in: linkedWorkItemIds }, projectId }, select: { id: true } });
      const known = new Set(found.map((w) => w.id));
      const foreign = linkedWorkItemIds.filter((id) => !known.has(id));
      if (foreign.length) throw new NotFoundException(`linkedWorkItemIds references work item(s) not found on this project: ${foreign.join(', ')}`);
    }

    const row = await this.prisma.commitment.create({
      data: {
        projectId,
        cycleId: dto.cycleId,
        title: dto.title,
        reason: dto.reason,
        workstream: dto.workstream ?? 'other',
        targetCount: dto.targetCount,
        targetUnit: dto.targetUnit,
        targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
        outcomeMetricLabel: dto.outcomeMetricLabel,
        outcomeMetricUnit: dto.outcomeMetricUnit,
        outcomeMetricBaseline: dto.outcomeMetricBaseline,
        outcomeMetricTarget: dto.outcomeMetricTarget,
        accountableLead: dto.accountableLead,
        clientVisibleLead: dto.clientVisibleLead ?? false,
        linkedWorkItemIds: JSON.stringify(linkedWorkItemIds),
        contentRef: dto.contentRef,
        createdBy: actorId,
      },
    });
    return this.toCommitmentDto(row, await this.linkedWorkItemsFor(row));
  }

  async updateCommitment(projectId: string, id: string, dto: UpdateCommitmentDto): Promise<CommitmentDto> {
    const existing = await this.getCommitmentRow(projectId, id);
    if (['completed', 'closed', 'cancelled', 'superseded'].includes(existing.status)) {
      throw new ConflictException(`A "${existing.status}" commitment cannot be edited — supersede it instead.`);
    }
    let linkedWorkItemIds: string[] | undefined;
    if (dto.linkedWorkItemIds) {
      const found = await this.prisma.workItem.findMany({ where: { id: { in: dto.linkedWorkItemIds }, projectId }, select: { id: true } });
      const known = new Set(found.map((w) => w.id));
      const foreign = dto.linkedWorkItemIds.filter((wid) => !known.has(wid));
      if (foreign.length) throw new NotFoundException(`linkedWorkItemIds references work item(s) not found on this project: ${foreign.join(', ')}`);
      linkedWorkItemIds = dto.linkedWorkItemIds;
    }
    const row = await this.prisma.commitment.update({
      where: { id },
      data: {
        title: dto.title,
        reason: dto.reason,
        workstream: dto.workstream,
        accountableLead: dto.accountableLead,
        clientVisibleLead: dto.clientVisibleLead,
        linkedWorkItemIds: linkedWorkItemIds ? JSON.stringify(linkedWorkItemIds) : undefined,
        contentRef: dto.contentRef,
      },
    });
    return this.toCommitmentDto(row, await this.linkedWorkItemsFor(row));
  }

  /** Forward-biased transitions only. "agreed" is never reachable here — see
   * `agreeCommitment`. "completed" is never reachable here either — see
   * `completeCommitment`, which enforces the verified-progress/outcome-metric
   * gate so a commitment cannot be marked done by fiat. */
  async setCommitmentStatus(projectId: string, id: string, dto: SetCommitmentStatusDto): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    const target = dto.status as CommitmentStatus;
    if (target === 'agreed') {
      throw new ConflictException('Use POST .../commitments/:id/agree — "agreed" requires a recorded confirmation, not a status PATCH.');
    }
    if (target === 'completed') {
      throw new ConflictException('Use POST .../commitments/:id/complete — completion requires verified progress or an outcome metric.');
    }
    const allowed = COMMITMENT_TRANSITIONS[row.status as CommitmentStatus] ?? [];
    if (!allowed.includes(target)) {
      throw new ConflictException(`Cannot move commitment from "${row.status}" to "${target}"`);
    }
    const updated = await this.prisma.commitment.update({ where: { id }, data: { status: target } });
    return this.toCommitmentDto(updated, await this.linkedWorkItemsFor(updated));
  }

  /**
   * The one path to "agreed". An operator writing/saving the plan is never
   * enough — §6.3 explicitly rules that out. `confirm: true` is the
   * deliberate act; the actor and timestamp are recorded.
   */
  async agreeCommitment(projectId: string, id: string, actor: Actor, dto: AgreeCommitmentDto): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    if (!dto.confirm) throw new ConflictException('Agreement requires confirm: true — an operator save alone is not client agreement.');
    if (row.status !== 'proposed' && row.status !== 'draft') {
      throw new ConflictException(`Only a "draft" or "proposed" commitment can be agreed (currently "${row.status}")`);
    }
    const updated = await this.prisma.commitment.update({
      where: { id },
      data: { status: 'agreed', agreedAt: new Date(), agreedBy: actor.userId },
    });
    return this.toCommitmentDto(updated, await this.linkedWorkItemsFor(updated));
  }

  /**
   * §6.3: previous/new target+date, reason, actor and whether reconfirmation
   * is required. Also applies the new target/date to the row — updating a
   * plan date never silently reschedules linked content (P10's concern, not
   * touched here) and this call is the only writer of targetCount/targetDate
   * once a commitment has left "draft".
   */
  async recordCommitmentScopeChange(projectId: string, id: string, actor: Actor, dto: CommitmentScopeChangeDto): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    if (['completed', 'closed', 'cancelled', 'superseded'].includes(row.status)) {
      throw new ConflictException(`A "${row.status}" commitment's scope cannot change.`);
    }
    const previousTarget = row.targetCount;
    const previousDate = row.targetDate ? row.targetDate.toISOString() : null;
    const newTarget = dto.newTarget ?? previousTarget ?? null;
    const newDate = dto.newDate ?? previousDate;

    await this.appendCommitmentScopeChange(id, {
      by: actor.userId,
      reason: dto.reason,
      previousTarget,
      newTarget,
      previousDate,
      newDate,
      requiresReconfirmation: dto.requiresReconfirmation ?? false,
    });

    const updated = await this.prisma.commitment.update({
      where: { id },
      data: {
        targetCount: dto.newTarget !== undefined ? dto.newTarget : undefined,
        targetDate: dto.newDate !== undefined ? new Date(dto.newDate) : undefined,
        // A scope change that requires reconfirmation knocks an already-agreed
        // commitment to "needs-attention" — it cannot stay "agreed" against
        // terms the client has not seen, but it must STAY client-visible (a
        // client cannot reconfirm something that disappeared from their
        // plan), so it never falls back to "proposed"/"draft".
        status: dto.requiresReconfirmation && (row.status === 'agreed' || row.status === 'active') ? 'needs-attention' : undefined,
      },
    });
    return this.toCommitmentDto(updated, await this.linkedWorkItemsFor(updated));
  }

  /** Records an observed outcome-metric value. Never inferred from linked
   * WorkItems — always a deliberate write. */
  async recordOutcomeMetric(projectId: string, id: string, dto: RecordOutcomeMetricDto): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    if (!row.outcomeMetricLabel) {
      throw new ConflictException('This commitment has no outcome metric configured.');
    }
    const updated = await this.prisma.commitment.update({
      where: { id },
      data: {
        outcomeMetricCurrent: dto.value,
        outcomeMetricObservedAt: dto.observedAt ? new Date(dto.observedAt) : new Date(),
      },
    });
    return this.toCommitmentDto(updated, await this.linkedWorkItemsFor(updated));
  }

  /**
   * The only path to "completed". A countable commitment must have verified
   * >= targetCount, or an explicit `force`+`forceReason` override (recorded
   * in scope history). An outcome-style commitment (outcomeMetricLabel set)
   * REQUIRES a metric observation from this call — it can never auto-flip to
   * completed merely because its linked WorkItems closed (§6.2).
   */
  async completeCommitment(projectId: string, id: string, actor: Actor, dto: CompleteCommitmentDto): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    if (row.status !== 'active' && row.status !== 'needs-attention') {
      throw new ConflictException(`Only "active" or "needs-attention" work can be completed (currently "${row.status}")`);
    }
    const linkedWork = await this.linkedWorkItemsFor(row);
    const verifiedCount = linkedWork.filter((w) => w.status === 'verified').length;

    let outcomeCurrent = row.outcomeMetricCurrent;
    let outcomeObservedAt = row.outcomeMetricObservedAt;
    if (row.outcomeMetricLabel) {
      if (dto.outcomeMetricCurrent === undefined) {
        throw new ConflictException(
          'This is an outcome commitment — completing it requires its own outcome metric (outcomeMetricCurrent), never just because linked tasks closed.',
        );
      }
      outcomeCurrent = dto.outcomeMetricCurrent;
      outcomeObservedAt = dto.outcomeMetricObservedAt ? new Date(dto.outcomeMetricObservedAt) : new Date();
    } else if (row.targetCount != null && verifiedCount < row.targetCount) {
      if (!dto.force) {
        throw new ConflictException(
          `Only ${verifiedCount} of ${row.targetCount} target deliverables are verified — pass force+forceReason to complete anyway.`,
        );
      }
      if (!dto.forceReason) throw new ConflictException('force requires forceReason.');
      await this.appendCommitmentScopeChange(id, {
        by: actor.userId,
        reason: `Force-completed with ${verifiedCount}/${row.targetCount} verified: ${dto.forceReason}`,
        previousTarget: row.targetCount,
        newTarget: row.targetCount,
        previousDate: null,
        newDate: null,
        requiresReconfirmation: false,
      });
    }

    const updated = await this.prisma.commitment.update({
      where: { id },
      data: {
        status: 'completed',
        outcomeMetricCurrent: outcomeCurrent,
        outcomeMetricObservedAt: outcomeObservedAt,
      },
    });
    return this.toCommitmentDto(updated, await this.linkedWorkItemsFor(updated));
  }

  async cancelCommitment(projectId: string, id: string, dto: CancelCommitmentDto): Promise<CommitmentDto> {
    const row = await this.getCommitmentRow(projectId, id);
    if (['completed', 'closed', 'cancelled', 'superseded'].includes(row.status)) {
      throw new ConflictException(`A "${row.status}" commitment cannot be cancelled.`);
    }
    const updated = await this.prisma.commitment.update({
      where: { id },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: dto.reason },
    });
    return this.toCommitmentDto(updated, await this.linkedWorkItemsFor(updated));
  }

  /** Client-visible commitments for a project: everything not draft/proposed
   * (unpublished internal drafting stays staff-only), grouped implicitly by
   * cycle — the caller (getPortalPlan) already scopes cycles to client-visible
   * work. Completed work is never dropped from this list to make progress
   * look better (§6.3). */
  private async listPortalCommitmentsForCycles(cycleIds: string[]): Promise<PortalCommitmentDto[]> {
    if (cycleIds.length === 0) return [];
    const rows = await this.prisma.commitment.findMany({
      where: { cycleId: { in: cycleIds }, status: { notIn: ['draft', 'proposed'] } },
      orderBy: { createdAt: 'asc' },
    });
    const out: PortalCommitmentDto[] = [];
    for (const row of rows) {
      const linkedWork = await this.linkedWorkItemsFor(row);
      const nextAction = await this.nextClientActionForCommitment(row);
      out.push(this.toPortalCommitmentDto(row, linkedWork, nextAction));
    }
    return out;
  }

  /** The next client action linking to this commitment, if any: the nearest
   * open approval request against its linked content/work. Best-effort —
   * commitments are not required to have one. */
  private async nextClientActionForCommitment(row: Commitment): Promise<PortalActionSummary | null> {
    if (!row.contentRef) return null;
    const approval = await this.prisma.approvalRequest.findFirst({
      where: {
        projectId: row.projectId,
        reviewerType: 'client',
        status: { in: ['pending', 'changes-requested'] },
        artifactId: row.contentRef,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) return null;
    return {
      sourceType: 'approval-request',
      sourceId: approval.id,
      title: approval.title,
      destination: `/client/approvals/${approval.id}`,
    };
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

  /**
   * Removes the actor attribution generated by formatEvidenceEntry, including
   * historical operator and client submissions, at the portal boundary only.
   * Stored evidence and staff responses remain unchanged; guidance, timestamp,
   * note and URL survive. UI-only redaction cannot protect the JSON response.
   */
  private toPortalText(text: string | null): string | null {
    return text?.replace(
      /\[((?:Submitted|Client evidence submitted)) (\d{4}-\d{2}-\d{2}T[\d:.]+Z) by [^\]\r\n]*\]/g,
      '[$1 $2]',
    ) ?? null;
  }

  /** discipline -> client-facing "Area of work" label, per the plan's §4.3
   * language dictionary row ("Workstream / discipline" -> "Area of work",
   * examples: Website, Content, Email, Ads, Online presence). research/
   * reporting/access have no dictionary entry; given sensible client-facing
   * names here. */
  private static readonly CAPABILITY_LABELS: Readonly<Record<string, string>> = {
    technical: 'Website',
    content: 'Content',
    authority: 'Online presence',
    research: 'Research',
    reporting: 'Reporting',
    access: 'Connected accounts',
  };

  private toPortalCapabilityLabel(discipline: string): string | null {
    return DeliveryPlanService.CAPABILITY_LABELS[discipline] ?? null;
  }

  /** WorkItem.status collapsed to a purely verification-focused synonym: has
   * this actually been checked off, is it under review, or not yet. See the
   * PortalWorkItemDto doc comment for why both `status` and `verifyState`
   * are emitted. */
  private toPortalVerifyState(status: string): string {
    if (status === 'verified') return 'verified';
    if (status === 'review') return 'pending';
    return 'unverified';
  }

  /** Normalizes the free-text, staff-only WorkItem.blockedReason into one of
   * four client-safe categories, using the already-coarse `blockedOn` owner
   * tag rather than parsing the raw operational text (which must never reach
   * the client — see portal-plan.smoke.sh's PORTAL_PLAN_PRIVATE_BLOCKER
   * fixture). No blocker text at all means "not blocked" -> null. */
  private toPortalBlockedReason(blockedOn: string | null, blockedReason: string | null): PortalBlockedReason | null {
    if (!blockedReason) return null;
    if (blockedOn === 'client') return 'client-action';
    if (blockedOn === 'approval') return 'approval';
    if (blockedOn === 'dependency' || blockedOn === 'vendor') return 'dependency';
    return 'other';
  }

  /**
   * Client work projection, deliberately independent of the staff serializer.
   * No row spread: notes, hours, actor IDs, provenance, dependencies, cycle
   * linkage and category/discipline/priority (collapsed to capabilityLabel)
   * never cross here.
   */
  private toPortalWorkItemDto(row: WorkItem): PortalWorkItemDto {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      description: this.toPortalText(row.description),
      status: row.status,
      verifyState: this.toPortalVerifyState(row.status),
      dueOn: row.dueAt,
      capabilityLabel: this.toPortalCapabilityLabel(row.discipline),
      blockedOn: row.blockedOn,
      blockedReason: this.toPortalBlockedReason(row.blockedOn, row.blockedReason),
    };
  }

  /** Only client-visible milestone fields, never the raw database row.
   * `description` is deliberately excluded — see PortalMilestoneDto. */
  private toPortalMilestoneDto(row: Milestone): PortalMilestoneDto {
    return {
      id: row.id,
      title: row.title,
      dueOn: row.dueAt,
      status: row.status,
    };
  }

  /**
   * Scope history is operational JSON, not a client DTO. `reason` is already
   * a client-safe human description written by staff, so it passes through
   * unchanged; `by`/`added`/`removed` (actor and item IDs) are dropped
   * entirely, never resolved to titles. `requiresReconfirmation` is always
   * emitted as a boolean (defaulting to false), since the legacy writer never
   * records it but the portal contract requires the key.
   */
  private toPortalScopeChanges(raw: string): PortalScopeChangeDto[] {
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];

    const changes: PortalScopeChangeDto[] = [];
    for (const value of entries as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue;
      if (typeof entry.reason !== 'string' || !entry.reason) continue;
      changes.push({
        at: entry.at,
        reason: entry.reason,
        requiresReconfirmation: typeof entry.requiresReconfirmation === 'boolean' ? entry.requiresReconfirmation : false,
      });
    }
    return changes;
  }

  /**
   * Only cycles containing shared work are eligible without a cycle release
   * flag in the legacy schema. committedCount is the persisted frozen
   * denominator (never a live recount); deliveredCount/currentCount are
   * full-cycle aggregates over ALL work items in the cycle, including hidden
   * ones — portal-plan.smoke.sh asserts these counts include the internal
   * item, so they must not be narrowed to the client-visible subset. No
   * committer, project id, timestamps or raw scope audit entry is serialized.
   */
  private toPortalCycleDto(row: Cycle, allWork: readonly WorkItem[]): PortalCycleDto {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      goal: this.toPortalText(row.goal),
      committedAt: row.committedAt,
      committedCount: row.committedCount,
      deliveredCount: allWork.filter((item) => item.status === 'verified').length,
      currentCount: allWork.filter((item) => item.status !== 'cancelled').length,
      scopeChanges: this.toPortalScopeChanges(row.scopeChanges),
    };
  }

  /**
   * Client-owned plan composed exclusively from explicit allowlisted DTOs.
   * Unshared cycles/items/milestones stay private, but a surfaced cycle's
   * aggregate counts are computed over ALL of its work items (see
   * toPortalCycleDto). The linked engagement is independently checked
   * against the client's ID.
   */
  async getPortalPlan(clientId: string, projectId: string): Promise<PortalPlanDto> {
    const project = await this.assertPortalProject(clientId, projectId);
    const engagement = project.engagementId
      ? await this.prisma.engagement.findFirst({ where: { id: project.engagementId, clientId } })
      : null;
    const workItems = await this.prisma.workItem.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueAt: 'asc' } });
    const cycleIds = [...new Set(workItems.map((item) => item.cycleId).filter((id): id is string => !!id))];
    const cycles = cycleIds.length
      ? await this.prisma.cycle.findMany({ where: { projectId, id: { in: cycleIds } }, orderBy: { startsOn: 'desc' } })
      : [];
    const allCycleWork = cycleIds.length
      ? await this.prisma.workItem.findMany({ where: { cycleId: { in: cycleIds } } })
      : [];
    const cycleWork = new Map<string, WorkItem[]>();
    for (const item of allCycleWork) {
      if (!item.cycleId) continue;
      const items = cycleWork.get(item.cycleId) ?? [];
      items.push(item);
      cycleWork.set(item.cycleId, items);
    }
    const milestones = await this.prisma.milestone.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueAt: 'asc' } });

    return {
      engagement: engagement
        ? { id: engagement.id, name: engagement.name, serviceTier: engagement.serviceTier, status: engagement.status, endsOn: engagement.endsOn }
        : null,
      cycles: cycles.map((cycle) => this.toPortalCycleDto(cycle, cycleWork.get(cycle.id) ?? [])),
      milestones: milestones.map((milestone) => this.toPortalMilestoneDto(milestone)),
      workItems: workItems.map((item) => this.toPortalWorkItemDto(item)),
    };
  }

  /**
   * Client-visible commitments for a project, served separately from
   * `getPortalPlan` so that endpoint's response shape never changes (see
   * `PortalPlanDto`'s doc comment). Scoped the same way: only cycles that
   * hold at least one client-visible work item are eligible.
   */
  async getPortalCommitments(clientId: string, projectId: string): Promise<{ commitments: PortalCommitmentDto[] }> {
    await this.assertPortalProject(clientId, projectId);
    const workItems = await this.prisma.workItem.findMany({ where: { projectId, clientVisible: true }, select: { cycleId: true } });
    const cycleIds = [...new Set(workItems.map((item) => item.cycleId).filter((id): id is string => !!id))];
    return { commitments: await this.listPortalCommitmentsForCycles(cycleIds) };
  }

  /**
   * C3, Option B — the client-facing Phase groupings for a project, each
   * carrying its assigned Cycles/Commitments through the exact same
   * client-safe DTOs `/plan` and `/plan/commitments` already use (never a
   * second, parallel serializer). Served from its own route rather than
   * folded into `getPortalPlan`, matching P11's "commitments got their own
   * route so /plan's shape never changes" precedent.
   *
   * Eligibility mirrors `getPortalPlan`/`getPortalCommitments` exactly: a
   * Cycle only appears if it holds at least one client-visible work item,
   * and a Commitment only appears if its own Cycle clears that same bar and
   * its status is not draft/proposed. A Phase with nothing eligible under
   * it is still listed (empty groups are real information — "this stage
   * has nothing shared with you yet" — not hidden).
   */
  async getPortalPhases(clientId: string, projectId: string): Promise<{ phases: PortalPhaseDto[] }> {
    await this.assertPortalProject(clientId, projectId);
    const phases = await this.prisma.phase.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
    if (phases.length === 0) return { phases: [] };
    const phaseIds = phases.map((p) => p.id);

    const clientVisibleWork = await this.prisma.workItem.findMany({ where: { projectId, clientVisible: true }, select: { cycleId: true } });
    const eligibleCycleIds = [...new Set(clientVisibleWork.map((item) => item.cycleId).filter((id): id is string => !!id))];

    const cycles = eligibleCycleIds.length
      ? await this.prisma.cycle.findMany({ where: { projectId, phaseId: { in: phaseIds }, id: { in: eligibleCycleIds } } })
      : [];
    const cycleIdsInPhases = cycles.map((c) => c.id);
    const allCycleWork = cycleIdsInPhases.length
      ? await this.prisma.workItem.findMany({ where: { cycleId: { in: cycleIdsInPhases } } })
      : [];
    const cycleWork = new Map<string, WorkItem[]>();
    for (const item of allCycleWork) {
      if (!item.cycleId) continue;
      const items = cycleWork.get(item.cycleId) ?? [];
      items.push(item);
      cycleWork.set(item.cycleId, items);
    }

    const commitmentRows = eligibleCycleIds.length
      ? await this.prisma.commitment.findMany({
          where: { projectId, phaseId: { in: phaseIds }, cycleId: { in: eligibleCycleIds }, status: { notIn: ['draft', 'proposed'] } },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const commitmentsByPhase = new Map<string, PortalCommitmentDto[]>();
    for (const row of commitmentRows) {
      if (!row.phaseId) continue;
      const linkedWork = await this.linkedWorkItemsFor(row);
      const nextAction = await this.nextClientActionForCommitment(row);
      const list = commitmentsByPhase.get(row.phaseId) ?? [];
      list.push(this.toPortalCommitmentDto(row, linkedWork, nextAction));
      commitmentsByPhase.set(row.phaseId, list);
    }

    return {
      phases: phases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        order: phase.order,
        status: phase.status as PhaseStatus,
        cycles: cycles
          .filter((c) => c.phaseId === phase.id)
          .map((c) => this.toPortalCycleDto(c, cycleWork.get(c.id) ?? [])),
        commitments: commitmentsByPhase.get(phase.id) ?? [],
      })),
    };
  }

  /**
   * P15 — §5.1's "30-day plan: 3 of 5 commitments completed", and the same
   * figure §14.5 item 8 freezes into a released report.
   *
   * Deliberately one implementation with two consumers: a live footer that
   * counted differently from the frozen report section would be a quiet
   * contradiction between two screens about the same commitments.
   *
   * The denominator is the set the client was actually asked to hold us to —
   * `draft`/`proposed` rows are private and already excluded by
   * `listPortalCommitmentsForCycles`, and `cancelled`/`superseded` rows are
   * listed but not counted, because "we cancelled one" is not "you have four
   * commitments". Both exclusions are named in the response rather than
   * silently applied.
   */
  async getPortalPlanProgress(clientId: string, projectId: string): Promise<PortalPlanProgressDto> {
    await this.assertPortalProject(clientId, projectId);
    const workItems = await this.prisma.workItem.findMany({
      where: { projectId, clientVisible: true },
      select: { cycleId: true },
    });
    const cycleIds = [...new Set(workItems.map((item) => item.cycleId).filter((id): id is string => !!id))];

    const rows = cycleIds.length ? await this.listPortalCommitmentsForCycles(cycleIds) : [];
    const cycles = cycleIds.length
      ? await this.prisma.cycle.findMany({ where: { id: { in: cycleIds } }, orderBy: { startsOn: 'asc' } })
      : [];

    const countsTowardTotal = (status: CommitmentStatus): boolean =>
      status !== 'cancelled' && status !== 'superseded';
    const isComplete = (status: CommitmentStatus): boolean => status === 'completed' || status === 'closed';

    const commitments: PortalPlanProgressCommitmentDto[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      workstream: row.workstream,
      status: row.status,
      targetDate: row.targetDate,
      // The same progress label the plan screen shows, so a commitment cannot
      // read "1 of 3" here and "2 of 3" there.
      progressLabel: row.progress.label,
      countsTowardTotal: countsTowardTotal(row.status),
      excludedReason: countsTowardTotal(row.status)
        ? null
        : row.status === 'cancelled'
          ? 'This commitment was cancelled, so it is not counted.'
          : 'This commitment was replaced by a later one, so it is not counted twice.',
    }));

    const counted = commitments.filter((item) => item.countsTowardTotal);
    const completedCount = counted.filter((item) => isComplete(item.status)).length;
    const totalCount = counted.length;
    const starts = cycles.map((cycle) => cycle.startsOn.getTime()).filter((value) => Number.isFinite(value));
    const ends = cycles.map((cycle) => cycle.endsOn.getTime()).filter((value) => Number.isFinite(value));

    return {
      totalCount,
      completedCount,
      label: `${completedCount} of ${totalCount} commitments completed`,
      commitments,
      window: {
        start: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
        end: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
      },
      cycleCount: cycles.length,
      scopeNote:
        'This counts the commitments we agreed with you in your plan cycles. Work we track internally, ' +
        'and anything not yet agreed, is not included.',
    };
  }

  /** Client-visible work only, using the same allowlist as plan and write responses. */
  async listPortalWorkItems(clientId: string, projectId: string): Promise<PortalWorkItemsDto> {
    await this.assertPortalProject(clientId, projectId);
    const rows = await this.prisma.workItem.findMany({ where: { projectId, clientVisible: true }, orderBy: { dueAt: 'asc' } });
    return { workItems: rows.map((item) => this.toPortalWorkItemDto(item)) };
  }

  /** Client (as assignee — the "client developer" implementation owner of
   * §7.2) records what they did. active -> review, same transition as
   * `/submit`; see PortalEvidenceDto for why this does not fabricate a
   * Verification row. The response uses the same portal work-item allowlist
   * as every other client-facing read — never the staff serializer. */
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
    return this.toPortalWorkItemDto(updated);
  }

  // ── Needs-your-action queue (P11 — §5.6) ─────────────────────────────

  /** Overdue -> blocking others -> ordinary, then soonest deadline first.
   * A stable order, not a UI-side sort, so pagination in "View all" is
   * consistent. */
  private sortActionItems(items: ActionItemDto[]): ActionItemDto[] {
    const rank: Record<ActionItemDto['severity'], number> = { overdue: 0, blocking: 1, normal: 2 };
    return [...items].sort((a, b) => {
      const r = rank[a.severity] - rank[b.severity];
      if (r !== 0) return r;
      const ad = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
      const bd = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
      return ad - bd;
    });
  }

  private severityFor(deadline: Date | null, blocksOthers: boolean): ActionItemDto['severity'] {
    if (deadline && deadline.getTime() < Date.now()) return 'overdue';
    if (blocksOthers) return 'blocking';
    return 'normal';
  }

  private approvalToActionItem(
    row: {
      id: string; projectId: string; clientId: string | null; title: string; detail: string | null;
      dueAt: Date | null; status: string; artifactType: string; requiredReviewerId: string | null; createdAt: Date;
    },
    audience: 'client' | 'staff',
  ): ActionItemDto {
    const destination = audience === 'client' ? `/client/approvals/${row.id}` : `/projects/${row.projectId}/reviews?requestId=${row.id}`;
    return {
      sourceType: 'approval-request',
      sourceId: row.id,
      audience,
      eligibleActorId: audience === 'client' ? row.clientId : row.requiredReviewerId,
      title: row.title,
      reason: `Review requested for this ${row.artifactType}${row.detail ? `: ${row.detail}` : ''}`,
      deadline: row.dueAt ? row.dueAt.toISOString() : null,
      severity: this.severityFor(row.dueAt, false),
      projectId: row.projectId,
      destination,
      currentVersion: row.status,
      completionCondition: 'Resolves when the request is approved, changes-requested, cancelled or invalidated by a newer revision.',
      createdAt: row.createdAt.toISOString(),
    };
  }

  private onboardingToActionItem(row: {
    id: string; projectId: string; title: string; detail: string | null; dueAt: Date | null; status: string; kind: string; createdAt: Date;
  }): ActionItemDto {
    return {
      sourceType: 'onboarding-request',
      sourceId: row.id,
      audience: 'client',
      eligibleActorId: null,
      title: row.title,
      reason: row.detail ?? `We need this (${row.kind}) to keep work moving.`,
      deadline: row.dueAt ? row.dueAt.toISOString() : null,
      severity: this.severityFor(row.dueAt, false),
      projectId: row.projectId,
      destination: `/client/account?requestId=${row.id}`,
      currentVersion: row.status,
      completionCondition: 'Resolves when the request is marked done, waived, or reassigned.',
      createdAt: row.createdAt.toISOString(),
    };
  }

  private workItemToStaffActionItem(row: WorkItem, kind: 'review-task' | 'delivery-blocker'): ActionItemDto {
    const blocksOthers = kind === 'delivery-blocker';
    return {
      sourceType: kind,
      sourceId: row.id,
      audience: 'staff',
      eligibleActorId: row.reviewerId ?? row.assigneeId,
      title: row.title,
      reason: kind === 'review-task' ? 'Submitted work is waiting on your review/verification.' : (row.blockedReason ?? 'This work item is blocked.'),
      deadline: row.dueAt ? row.dueAt.toISOString() : null,
      severity: this.severityFor(row.dueAt, blocksOthers),
      projectId: row.projectId,
      destination: `/projects/${row.projectId}/work-items/${row.id}`,
      currentVersion: row.status,
      completionCondition: kind === 'review-task'
        ? 'Resolves when the work item is verified or sent back to active.'
        : 'Resolves when the work item is unblocked or cancelled.',
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Client-facing queue for one project. Eligible sources only (§5.6):
   * assigned approval requests, onboarding/profile-confirmation requests,
   * and explicit client-owned blockers surfaced as a blocked WorkItem's
   * onboarding request (already covered above — a blocker without a
   * standing request is a staff finding, not a client action, and is
   * deliberately excluded). Audit findings never appear here. Every row is
   * derived live from its source; nothing is duplicated into a task table,
   * and an item disappears the moment its source resolves.
   */
  async getPortalActions(clientId: string, projectId: string): Promise<ActionQueueDto> {
    await this.assertPortalProject(clientId, projectId);
    const [approvals, onboarding] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where: { projectId, clientId, reviewerType: 'client', status: { in: ['pending', 'changes-requested'] } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.onboardingRequest.findMany({
        where: { projectId, status: { in: ['open', 'in-progress'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const items = this.sortActionItems([
      ...approvals.map((a) => this.approvalToActionItem(a, 'client')),
      ...onboarding.map((o) => this.onboardingToActionItem(o)),
    ]);
    return { items, total: items.length };
  }

  /** §5.6's capped overview: at most `limit` cards, with the true total. */
  async getPortalActionsOverview(clientId: string, projectId: string, limit = 3): Promise<ActionQueueDto> {
    const { items, total } = await this.getPortalActions(clientId, projectId);
    return { items: items.slice(0, limit), total };
  }

  /**
   * §3.4's client-list column **"waiting on client"**, as a count across every
   * project a client owns.
   *
   * Deliberately derived from the SAME two sources and the SAME predicates
   * `getPortalActions` uses — pending/changes-requested client-reviewer
   * approval requests, and open/in-progress onboarding requests — so the
   * portfolio number can never disagree with the per-project queue an operator
   * sees after clicking through. It counts *sources*, not rendered cards: the
   * queue caps what it displays, never what it counts.
   *
   * `OnboardingRequest` carries only a `projectId` (no client relation), hence
   * the project-id list; `ApprovalRequest` carries `clientId` directly.
   */
  async countWaitingOnClient(clientId: string): Promise<number> {
    const projects = await this.prisma.project.findMany({ where: { clientId }, select: { id: true } });
    const [approvals, onboarding] = await Promise.all([
      this.prisma.approvalRequest.count({
        where: { clientId, reviewerType: 'client', status: { in: ['pending', 'changes-requested'] } },
      }),
      projects.length > 0
        ? this.prisma.onboardingRequest.count({
            where: { projectId: { in: projects.map((p) => p.id) }, status: { in: ['open', 'in-progress'] } },
          })
        : 0,
    ]);
    return approvals + onboarding;
  }

  /**
   * §3.4's **"delivery lead"** column: the accountable staff member on this
   * client's most recent engagement, by name.
   *
   * Read from `Engagement.deliveryLead` (a User id) rather than from any
   * project-level field, because the engagement is where ownership is
   * actually recorded. Null when no engagement names one — that is "nobody
   * recorded", not "no lead exists", and the column must render it that way.
   */
  async getClientDeliveryLeadName(clientId: string): Promise<string | null> {
    const engagement = await this.prisma.engagement.findFirst({
      where: { clientId, deliveryLead: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { deliveryLead: true },
    });
    if (!engagement?.deliveryLead) return null;
    const lead = await this.prisma.user.findUnique({
      where: { id: engagement.deliveryLead },
      select: { name: true },
    });
    return lead?.name ?? null;
  }

  /**
   * §3.4's **"current plan progress"** and **"overdue commitments"** columns.
   *
   * Progress is taken from the client's most recent committed-or-later cycle:
   * `delivered` counts work items that reached `verified`, `committed` is the
   * cycle's **frozen** denominator. Both come straight off the cycle the plan
   * screen shows, so the list column and the plan screen cannot report
   * different numbers — and the frozen denominator is never recomputed into a
   * live count here (§6.3).
   *
   * "Overdue" means a commitment with a target date in the past that has not
   * reached a settled status. Settled = completed/closed/cancelled/superseded.
   */
  async getClientPlanProgress(clientId: string): Promise<{
    delivered: number;
    committed: number;
    overdueCommitments: number;
  }> {
    const projects = await this.prisma.project.findMany({ where: { clientId }, select: { id: true } });
    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) return { delivered: 0, committed: 0, overdueCommitments: 0 };

    const cycle = await this.prisma.cycle.findFirst({
      where: { projectId: { in: projectIds }, status: { in: ['committed', 'active', 'review'] } },
      orderBy: { startsOn: 'desc' },
      select: { id: true, committedCount: true },
    });

    const delivered = cycle
      ? await this.prisma.workItem.count({ where: { cycleId: cycle.id, status: 'verified' } })
      : 0;

    const overdueCommitments = await this.prisma.commitment.count({
      where: {
        projectId: { in: projectIds },
        targetDate: { lt: new Date() },
        status: { notIn: ['completed', 'closed', 'cancelled', 'superseded'] },
      },
    });

    return { delivered, committed: cycle?.committedCount ?? 0, overdueCommitments };
  }

  /**
   * Staff queue for one project: their own assigned review/verification
   * tasks and delivery blockers, plus operator-reviewer approval requests
   * assigned to them (or unassigned, which any admin/delivery-lead may
   * pick up). Scope is the caller's own actor id — this is not a portfolio
   * view.
   */
  async getStaffActions(projectId: string, actor: Actor): Promise<ActionQueueDto> {
    await this.assertProjectExists(projectId);
    const isAdmin = actor.role === 'admin';
    const [approvals, reviewItems, blockedItems] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where: {
          projectId,
          reviewerType: 'operator',
          status: { in: ['pending', 'changes-requested'] },
          ...(isAdmin ? {} : { OR: [{ requiredReviewerId: actor.userId }, { requiredReviewerId: null }] }),
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workItem.findMany({
        where: {
          projectId,
          status: 'review',
          ...(isAdmin ? {} : { OR: [{ reviewerId: actor.userId }, { assigneeId: actor.userId }] }),
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workItem.findMany({
        where: {
          projectId,
          status: 'blocked',
          ...(isAdmin ? {} : { OR: [{ reviewerId: actor.userId }, { assigneeId: actor.userId }] }),
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const items = this.sortActionItems([
      ...approvals.map((a) => this.approvalToActionItem(a, 'staff')),
      ...reviewItems.map((w) => this.workItemToStaffActionItem(w, 'review-task')),
      ...blockedItems.map((w) => this.workItemToStaffActionItem(w, 'delivery-blocker')),
    ]);
    return { items, total: items.length };
  }
}
