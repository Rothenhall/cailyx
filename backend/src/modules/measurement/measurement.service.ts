/**
 * Measurement Service — runs buyer prompts across AI surfaces and scores the
 * answers into structured Observations (PRD §6.6–6.7, SOP-2).
 *
 * Hard rules enforced here (PLAN §7):
 * - Design principle 2: n ≥ 5 runs per prompt per surface per geo — blocked below.
 * - Design principle 4: name the surface — every record carries its surface.
 * - Rates, never positions — summary reports normalized rates; `position` is
 *   stored for diagnostics only, never headline output.
 *
 * @module measurement.service
 */

import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AnthropicSurfaceAdapter } from './adapters/anthropic.adapter';
import { PerplexitySurfaceAdapter } from './adapters/perplexity.adapter';
import { MockSurfaceAdapter } from './adapters/mock.adapter';
import type { Surface, SurfaceAdapter, MeasurementSummary } from './measurement.types';

/** Absolute minimum observations per prompt (design principle — n≥5, no exceptions). */
export const MIN_RUN_COUNT = 5;

/** Competitor entry shape persisted on the Project.competitors column. */
interface StoredCompetitor {
  name: string;
  domain?: string | null;
}

@Injectable()
export class MeasurementService {
  private readonly logger = new Logger(MeasurementService.name);
  private readonly adapters: Map<Surface, SurfaceAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    anthropic: AnthropicSurfaceAdapter,
    perplexity: PerplexitySurfaceAdapter,
    mock: MockSurfaceAdapter,
  ) {
    this.adapters = new Map<Surface, SurfaceAdapter>([
      ['claude', anthropic],
      ['perplexity', perplexity],
      ['mock', mock],
    ]);
  }

  /**
   * Create a measurement run for an ACTIVE query set.
   * @param runCount Repeat count per prompt — PRD hard floor of 5.
   * @throws NotFoundException on missing project/query set.
   * @throws ConflictException when the query set is not active (only activated sets measure).
   * @throws BadRequestException when runCount < 5 (n≥5, no exceptions) or surface unknown.
   */
  async createRun(
    projectId: string,
    input: { querySetId: string; surface: Surface; geo?: string; runCount?: number },
  ) {
    if (!this.adapters.has(input.surface)) {
      throw new BadRequestException(
        `Unknown surface '${input.surface}'. Available: ${[...this.adapters.keys()].join(', ')}`,
      );
    }
    if (input.runCount !== undefined && input.runCount < MIN_RUN_COUNT) {
      throw new BadRequestException(`n>=5, no exceptions: runCount must be >= ${MIN_RUN_COUNT}`);
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const querySet = await this.prisma.querySet.findUnique({
      where: { id: input.querySetId },
      include: { items: true },
    });
    if (!querySet || querySet.projectId !== projectId) {
      throw new NotFoundException('Query set not found in this project: ' + input.querySetId);
    }
    if (querySet.status !== 'active') {
      throw new ConflictException(
        `Query set is ${querySet.status} — only ACTIVE sets are measured (immutable versions)`,
      );
    }
    if (querySet.items.length === 0) {
      throw new BadRequestException('Cannot measure an empty query set');
    }

    const run = await this.prisma.measurementRun.create({
      data: {
        projectId,
        querySetId: input.querySetId,
        surface: input.surface,
        geo: input.geo ?? 'US',
        runCount: input.runCount ?? MIN_RUN_COUNT,
        status: 'pending',
      },
    });
    this.logger.log(
      `Run created ${run.id} (surface=${input.surface}, geo=${run.geo}, n=${run.runCount}, prompts=${querySet.items.length})`,
    );
    return run;
  }

  /**
   * Execute every pending observation of a run sequentially: for each prompt
   * item × runNumber, call the surface, extract mentioned/cited/competitors,
   * store the Observation. Cost-capped via MEASUREMENT_MAX_COST_PER_RUN —
   * exceeding the cap stops the run and marks it failed with the reason.
   * @returns The finished run with its observations.
   * @throws NotFoundException on unknown run / vanished set / vanished project.
   * @throws BadRequestException when no adapter exists for the run's surface.
   */
  async executeRun(runId: string) {
    const run = await this.prisma.measurementRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found: ' + runId);
    if (run.status === 'running') throw new ConflictException('Run is already executing');
    if (run.status === 'completed') {
      throw new ConflictException('Run is already completed — create a new version instead of re-executing');
    }
    if (run.status === 'failed') {
      // Retry a failed run: wipe partial observations so rates never double-count.
      await this.prisma.observation.deleteMany({ where: { runId: run.id } });
      await this.prisma.measurementRun.update({
        where: { id: run.id },
        data: { totalRequests: 0, completedRequests: 0, failedRequests: 0, costTotal: 0 },
      });
    }

    const adapter = this.adapters.get(run.surface as Surface);
    if (!adapter) throw new BadRequestException(`No adapter for surface '${run.surface}'`);

    const querySet = await this.prisma.querySet.findUnique({
      where: { id: run.querySetId },
      include: { items: true },
    });
    if (!querySet) throw new NotFoundException('Query set for run no longer exists: ' + run.querySetId);
    if (querySet.items.length === 0) throw new BadRequestException('Query set has no prompts');

    const project = await this.prisma.project.findUnique({ where: { id: run.projectId } });
    if (!project) throw new NotFoundException('Project for run no longer exists: ' + run.projectId);

    const competitorNames = this.parseCompetitors(project.competitors).map((c) => c.name);

    await this.prisma.measurementRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: new Date(), error: null },
    });

    let costExceeded: string | null = null;

    try {
      for (const item of querySet.items) {
        if (costExceeded) break;
        for (let runNumber = 1; runNumber <= run.runCount; runNumber++) {
          if (costExceeded) break;
          try {
            const answer = await adapter.runPrompt(item.prompt, run.geo);
            const costUsd = answer.costUsd ?? 0;
            const extracted = this.extractObservation(
              answer,
              { name: project.name, domain: project.domain },
              competitorNames,
            );

            await this.prisma.observation.create({
              data: {
                runId: run.id,
                itemId: item.id,
                runNumber,
                prompt: item.prompt,
                ...extracted,
                rawAnswer: answer.text,
                costUsd,
                latencyMs: answer.latencyMs,
                model: answer.model,
              },
            });

            await this.prisma.measurementRun.update({
              where: { id: run.id },
              data: {
                totalRequests: { increment: 1 },
                completedRequests: { increment: 1 },
                costTotal: { increment: costUsd },
              },
            });

            const current = await this.prisma.measurementRun.findUnique({ where: { id: run.id } });
            if (current && current.costTotal > this.costCap()) {
              costExceeded = `Cost cap exceeded: $${current.costTotal.toFixed(2)} > $${this.costCap().toFixed(2)} (MEASUREMENT_MAX_COST_PER_RUN)`;
              this.logger.warn(costExceeded);
            }
          } catch (err) {
            await this.prisma.measurementRun.update({
              where: { id: run.id },
              data: { totalRequests: { increment: 1 }, failedRequests: { increment: 1 } },
            });
            this.logger.error(
              `Observation failed (run=${run.id}, item=${item.id}, n=${runNumber}): ${(err as Error).message}`,
            );
          }
        }
      }
    } finally {
      const finished = await this.prisma.measurementRun.findUnique({ where: { id: run.id } });
      if (finished) {
        await this.prisma.measurementRun.update({
          where: { id: run.id },
          data: {
            status: costExceeded ? 'failed' : finished.completedRequests > 0 ? 'completed' : 'failed',
            error: costExceeded,
            finishedAt: new Date(),
          },
        });
      }
    }

    return this.prisma.measurementRun.findUnique({ where: { id: run.id }, include: { observations: true } });
  }

  /**
   * List the project's runs (newest first), optionally filtered by surface.
   */
  async listRuns(projectId: string, surface?: string) {
    return this.prisma.measurementRun.findMany({
      where: { projectId, ...(surface ? { surface } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * One run with its observations (project-ownership checked).
   */
  async getRun(projectId: string, runId: string) {
    const run = await this.prisma.measurementRun.findFirst({
      where: { id: runId, projectId },
      include: { observations: { orderBy: [{ itemId: 'asc' }, { runNumber: 'asc' }] } },
    });
    if (!run) throw new NotFoundException('Run not found in this project: ' + runId);
    return run;
  }

  /**
   * Aggregate rates + share of voice for the project (optionally scoped to one run).
   *
   * Share of voice (PRD FR-7): the subject's presence share against every
   * named competitor seen in the same observations. Mention/citation rates
   * are the headline; positions never appear in the summary (rates, never positions).
   */
  async summary(projectId: string, runId?: string): Promise<MeasurementSummary> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const obsWhere = runId ? { runId } : { run: { projectId } };
    const observations = await this.prisma.observation.findMany({ where: obsWhere });
    const runs = await this.prisma.measurementRun.count({ where: { projectId } });

    if (observations.length === 0) {
      return {
        runs,
        observations: 0,
        mentionRate: 0,
        citationRate: 0,
        bySurface: [],
        byFunnelStage: [],
        shareOfVoice: [],
      };
    }

    const items = await this.prisma.querySetItem.findMany({
      where: { querySet: { projectId } },
      select: { id: true, funnelStage: true },
    });
    const stageByItem = new Map(items.map((i) => [i.id, i.funnelStage]));
    const runRows = await this.prisma.measurementRun.findMany({
      where: { projectId },
      select: { id: true, surface: true },
    });
    const surfaceByRun = new Map(runRows.map((r) => [r.id, r.surface]));

    const surfRows = new Map<string, { n: number; m: number; c: number }>();
    const stRows = new Map<string, { n: number; m: number; c: number }>();
    let mentionCount = 0;
    let citeCount = 0;
    let subjectCount = 0;
    const competitorCounts = new Map<string, number>();

    for (const o of observations) {
      if (o.mentioned) {
        mentionCount += 1;
        subjectCount += 1;
      }
      if (o.cited) citeCount += 1;

      const surf = surfaceByRun.get(o.runId) ?? 'unknown';
      const surfRow = surfRows.get(surf) ?? { n: 0, m: 0, c: 0 };
      surfRow.n += 1;
      if (o.mentioned) surfRow.m += 1;
      if (o.cited) surfRow.c += 1;
      surfRows.set(surf, surfRow);

      const stage = stageByItem.get(o.itemId) ?? 'unknown';
      const stRow = stRows.get(stage) ?? { n: 0, m: 0, c: 0 };
      stRow.n += 1;
      if (o.mentioned) stRow.m += 1;
      if (o.cited) stRow.c += 1;
      stRows.set(stage, stRow);

      for (const name of this.parseCompetitors(o.competitors).map((c) => c.name)) {
        competitorCounts.set(name, (competitorCounts.get(name) ?? 0) + 1);
      }
    }

    const totalPresence = subjectCount + [...competitorCounts.values()].reduce((a, b) => a + b, 0) || 1;
    const shareOfVoice = [
      { name: project.name + ' (you)', share: Number((subjectCount / totalPresence).toFixed(4)) },
      ...[...competitorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, share: Number((count / totalPresence).toFixed(4)) })),
    ].slice(0, 10);

    return {
      runs,
      observations: observations.length,
      mentionRate: Number((mentionCount / observations.length).toFixed(4)),
      citationRate: Number((citeCount / observations.length).toFixed(4)),
      bySurface: [...surfRows.entries()].map(([surface, r]) => ({
        surface,
        observations: r.n,
        mentionRate: Number((r.m / r.n).toFixed(4)),
        citationRate: Number((r.c / r.n).toFixed(4)),
      })),
      byFunnelStage: [...stRows.entries()].map(([funnelStage, r]) => ({
        funnelStage,
        observations: r.n,
        mentionRate: Number((r.m / r.n).toFixed(4)),
        citationRate: Number((r.c / r.n).toFixed(4)),
      })),
      shareOfVoice,
    };
  }

  /**
   * Deterministic observation extraction from a raw surface answer:
   * subject mention (name or domain), citation to the subject's domain with
   * its 1-based position among the surface's citations, and competitor presence.
   */
  private extractObservation(
    answer: { text: string; citations: string[] },
    subject: { name: string; domain: string },
    competitorNames: string[],
  ): {
    mentioned: boolean;
    cited: boolean;
    citedUrl: string | null;
    position: number | null;
    competitors: string;
    characterization: string;
  } {
    const textLower = answer.text.toLowerCase();
    const hostOf = (url: string): string => {
      try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      } catch {
        return '';
      }
    };
    const subjectHost = subject.domain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();
    const nameLower = (subject.name || '').toLowerCase();

    // Mention = full name appears, OR the longest brand token (>= 4 chars,
    // whole-word) appears — surfaces commonly use the bare brand ("SampleCo")
    // even when the project is recorded as "SampleCo E2E".
    let nameMatch = false;
    if (nameLower.length > 2 && textLower.includes(nameLower)) {
      nameMatch = true;
    } else {
      const tokens = nameLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
      if (tokens.length > 0) {
        const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
        nameMatch = new RegExp('(?:^|[^a-z0-9])' + longest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)').test(textLower);
      }
    }

    const mentioned =
      nameMatch || (subjectHost.length > 3 && textLower.includes(subjectHost));

    let cited = false;
    let citedUrl: string | null = null;
    let position: number | null = null;
    answer.citations.forEach((url, idx) => {
      if (!cited && hostOf(url).endsWith(subjectHost)) {
        cited = true;
        citedUrl = url;
        position = idx + 1;
      }
    });

    const seenCompetitors = competitorNames.filter(
      (name) => name.length > 2 && textLower.includes(name.toLowerCase()),
    );

    return {
      mentioned,
      cited,
      citedUrl,
      position,
      competitors: JSON.stringify(seenCompetitors),
      characterization: mentioned ? 'present' : 'absent',
    };
  }

  /** Parse the competitors column (JSON array of {name,domain} objects or plain names). */
  private parseCompetitors(raw: string | null | undefined): StoredCompetitor[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const mapped: StoredCompetitor[] = [];
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          mapped.push({ name: entry });
        } else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
          mapped.push({ name: entry.name as string, domain: ((entry as { domain?: unknown }).domain as string) ?? null });
        }
      }
      return mapped;
    } catch {
      return [];
    }
  }

  /** Per-run cost ceiling in USD from config. */
  private costCap(): number {
    return Number(this.config.get<string>('MEASUREMENT_MAX_COST_PER_RUN', '5.00'));
  }
}