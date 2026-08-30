/**
 * Projects Service — CRUD + engagement lifecycle for the backbone entity.
 *
 * Every other Cailyx module references a Project by id. This service
 * manages project records, lifecycle transitions (PLAN Phase 0), and
 * cross-module artifact stats.
 *
 * @module projects.service
 */

import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { ProjectDto, ProjectStats, EngagementStatus } from './projects.types';

/** Valid lifecycle transitions (scorecard → diagnostic → sprint → retainer) */
const LIFECYCLE: Record<EngagementStatus, EngagementStatus[]> = {
  scorecard: ['diagnostic', 'archived'],
  diagnostic: ['sprint', 'archived'],
  sprint: ['retainer', 'diagnostic', 'archived'],
  retainer: ['diagnostic', 'archived'],
  archived: ['diagnostic'],
};

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── CRUD ─────────────────────────────────────────────────────

  /**
   * Create a project. Domain is unique — prevents duplicate tracking.
   */
  async create(data: {
    name: string; domain: string; category?: string;
    clientName?: string; status?: string; notes?: string;
  }, userId?: string): Promise<ProjectDto> {
    const existing = await this.prisma.project.findUnique({ where: { domain: data.domain } });
    if (existing) {
      throw new ConflictException('A project for domain ' + data.domain + ' already exists: ' + existing.id);
    }

    const project = await this.prisma.project.create({
      data: {
        name: data.name,
        domain: data.domain,
        category: data.category || null,
        clientName: data.clientName || null,
        status: data.status || 'diagnostic',
        notes: data.notes || null,
        userId: userId || null,
        updatedAt: new Date(),
      },
    });

    this.logger.log('Project created: ' + project.name + ' (' + project.id + ') for ' + project.domain);
    return this.toDto(project);
  }

  /**
   * List projects, optionally filtered by status.
   */
  async list(filter?: { status?: string; search?: string }) {
    const where: any = {};
    if (filter?.status) where.status = filter.status;
    if (filter?.search) {
      where.OR = [
        { name: { contains: filter.search } },
        { domain: { contains: filter.search } },
        { clientName: { contains: filter.search } },
      ];
    }

    const projects = await this.prisma.project.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    return { projects: projects.map((p: any) => this.toDto(p)) };
  }

  /**
   * Get a project by ID with artifact stats.
   */
  async getById(id: string): Promise<ProjectDto & { stats: ProjectStats }> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project ' + id + ' not found');

    const stats = await this.getStats(id);
    return { ...this.toDto(project), stats };
  }

  /**
   * Update a project.
   */
  async update(id: string, data: { name?: string; category?: string; clientName?: string; notes?: string }): Promise<ProjectDto> {
    const project = await this.prisma.project.update({
      where: { id },
      data,
    });
    this.logger.log('Project updated: ' + id);
    return this.toDto(project);
  }

  /**
   * Overwrite the project's named-competitor list (JSON array of {name, domain}).
   * Called by intake enrichment; used by measurement share-of-voice.
   */
  async updateCompetitors(id: string, competitors: Array<{ name: string; domain: string | null; source?: string }>): Promise<void> {
    await this.prisma.project.update({
      where: { id },
      data: { competitors: JSON.stringify(competitors) },
    });
  }

  /**
   * Transition the engagement lifecycle (scorecard → diagnostic → sprint → retainer).
   * Validates the transition is legal per PLAN Phase 0.
   */
  async transition(id: string, to: EngagementStatus): Promise<ProjectDto> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project ' + id + ' not found');

    const from = project.status as EngagementStatus;
    const allowed = LIFECYCLE[from] || [];
    if (to !== from && !allowed.includes(to)) {
      throw new ConflictException('Invalid lifecycle transition: ' + from + ' → ' + to + '. Allowed: ' + allowed.join(', '));
    }

    const updated = await this.prisma.project.update({ where: { id }, data: { status: to } });
    this.logger.log('Project ' + id + ' lifecycle: ' + from + ' → ' + to);
    return this.toDto(updated);
  }

  /**
   * Delete a project (cascades: reports and any FK-bound records via SQLite).
   * Does not delete technical audits (they reference projectId as a plain string) —
   * they are cleaned explicitly via their own module if needed.
   */
  async delete(id: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project ' + id + ' not found');
    await this.prisma.project.delete({ where: { id } });
    this.logger.log('Project deleted: ' + id);
  }

  // ─── Stats ────────────────────────────────────────────────────

  async getStats(id: string): Promise<ProjectStats> {
    const [audits, reports, entityAudit, gaps, schedule] = await Promise.all([
      this.prisma.technicalAudit.count({ where: { projectId: id } }),
      this.prisma.report.count({ where: { projectId: id } }),
      this.prisma.entityAudit.findFirst({ where: { projectId: id }, include: { _count: { select: { entities: true } } } }),
      this.prisma.gap.count({ where: { gapAnalysis: { projectId: id } } }),
      this.prisma.scheduleConfig.findUnique({ where: { projectId: id } }),
    ]);

    return {
      technicalAudits: audits,
      reports,
      entities: entityAudit?._count?.entities || 0,
      gaps,
      scheduleActive: schedule?.active || false,
    };
  }

  private toDto(p: {
    id: string; name: string; domain: string; category: string | null;
    clientName: string | null; status: string; notes: string | null;
    userId?: string | null; createdAt: Date; updatedAt: Date;
  }): ProjectDto {
    return {
      id: p.id,
      name: p.name,
      domain: p.domain,
      category: p.category,
      clientName: p.clientName,
      status: p.status as EngagementStatus,
      notes: p.notes,
      userId: p.userId ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}