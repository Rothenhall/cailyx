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
   * The competitor benchmark list plus candidates discovered from data already
   * on file.
   *
   * Discovery is deterministic: `SerpResult.topDomains` records the first-page
   * organic domains for every keyword this project tracks, so the domains that
   * keep out-ranking it *are* the competitive set. No NLP, no extra fetching,
   * no spend. The project's own domain and anything already tracked are
   * excluded, and candidates are ranked by how often they appear and how high.
   */
  async listCompetitors(id: string): Promise<{
    tracked: Array<{ name: string; domain: string | null; source?: string }>;
    discovered: Array<{ domain: string; appearances: number; bestRank: number | null; keyword: string | null }>;
    readiness: { rivals: number; runs: number; observations: number };
    you: { total: number; mentioned: number; cited: number };
    rivals: Array<{ name: string; appearances: number; share: number; beatYou: number }>;
    losing: Array<{ prompt: string; surface: string; rivals: string[] }>;
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: { domain: true, competitors: true },
    });
    if (!project) throw new NotFoundException('Project not found: ' + id);

    const tracked = this.parseCompetitorList(project.competitors);
    const own = project.domain.replace(/^www\./i, '').toLowerCase();
    const taken = new Set(
      tracked.map((c) => (c.domain ?? '').replace(/^www\./i, '').toLowerCase()).filter(Boolean),
    );
    taken.add(own);

    const results = await this.prisma.serpResult.findMany({
      where: { snapshot: { tracker: { projectId: id } } },
      select: { topDomains: true, keyword: true },
      take: 500,
      orderBy: { id: 'desc' },
    });

    const agg = new Map<string, { appearances: number; bestRank: number | null; keyword: string | null }>();
    for (const r of results) {
      let rows: Array<{ domain?: unknown; rank?: unknown }>;
      try {
        const parsed: unknown = JSON.parse(r.topDomains);
        rows = Array.isArray(parsed) ? (parsed as Array<{ domain?: unknown; rank?: unknown }>) : [];
      } catch {
        continue;
      }
      for (const row of rows) {
        if (typeof row?.domain !== 'string') continue;
        const d = row.domain.replace(/^www\./i, '').toLowerCase();
        if (!d || taken.has(d)) continue;
        const rank = typeof row.rank === 'number' ? row.rank : null;
        const cur = agg.get(d);
        if (!cur) {
          agg.set(d, { appearances: 1, bestRank: rank, keyword: r.keyword });
        } else {
          cur.appearances += 1;
          if (rank !== null && (cur.bestRank === null || rank < cur.bestRank)) {
            cur.bestRank = rank;
            cur.keyword = r.keyword;
          }
        }
      }
    }

    const discovered = [...agg.entries()]
      .map(([domain, v]) => ({ domain, ...v }))
      .sort((a, b) => b.appearances - a.appearances || (a.bestRank ?? 999) - (b.bestRank ?? 999))
      .slice(0, 20);

    /* ── head-to-head ────────────────────────────────────────────────────
       Every observation records whether the subject was mentioned and which
       named rivals appeared in the same answer. That is enough to say which
       prompts are being lost and to whom — the one competitive view the
       console could not previously produce. */
    const [runs, observations] = await Promise.all([
      this.prisma.measurementRun.count({ where: { projectId: id } }),
      this.prisma.observation.findMany({
        where: { run: { projectId: id } },
        select: {
          prompt: true,
          mentioned: true,
          cited: true,
          competitors: true,
          run: { select: { surface: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);

    const names = (raw: string): string[] => {
      try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };

    const you = {
      total: observations.length,
      mentioned: observations.filter((o) => o.mentioned).length,
      cited: observations.filter((o) => o.cited).length,
    };

    const rivalAgg = new Map<string, { appearances: number; beatYou: number }>();
    const losing: Array<{ prompt: string; surface: string; rivals: string[] }> = [];

    for (const o of observations) {
      const seen = names(o.competitors);
      for (const n of seen) {
        const cur = rivalAgg.get(n) ?? { appearances: 0, beatYou: 0 };
        cur.appearances += 1;
        // "beat you" = they were named in an answer where you were not
        if (!o.mentioned) cur.beatYou += 1;
        rivalAgg.set(n, cur);
      }
      if (!o.mentioned && seen.length > 0 && losing.length < 40) {
        losing.push({ prompt: o.prompt, surface: o.run.surface, rivals: seen });
      }
    }

    const rivals = [...rivalAgg.entries()]
      .map(([name, v]) => ({
        name,
        appearances: v.appearances,
        share: observations.length ? v.appearances / observations.length : 0,
        beatYou: v.beatYou,
      }))
      .sort((a, b) => b.beatYou - a.beatYou || b.appearances - a.appearances);

    return {
      tracked,
      discovered,
      readiness: { rivals: tracked.length, runs, observations: observations.length },
      you,
      rivals,
      losing,
    };
  }

  /** Parse the competitors column, tolerating the plain-string legacy shape. */
  private parseCompetitorList(raw: string | null | undefined): Array<{ name: string; domain: string | null; source?: string }> {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((c) => {
          if (typeof c === 'string') return { name: c, domain: null };
          if (c && typeof c === 'object') {
            const o = c as { name?: unknown; domain?: unknown; source?: unknown };
            if (typeof o.name !== 'string' || !o.name.trim()) return null;
            return {
              name: o.name.trim(),
              domain: typeof o.domain === 'string' && o.domain.trim() ? o.domain.trim() : null,
              ...(typeof o.source === 'string' ? { source: o.source } : {}),
            };
          }
          return null;
        })
        .filter((c): c is { name: string; domain: string | null; source?: string } => c !== null);
    } catch {
      return [];
    }
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
    competitors?: string | null;
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
      competitors: p.competitors ?? null,
      userId: p.userId ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}