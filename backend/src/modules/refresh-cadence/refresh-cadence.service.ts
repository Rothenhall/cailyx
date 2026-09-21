/**
 * Refresh-Cadence Service — C7 (`docs/analysis/client-portal.md` §19,
 * `docs/PLAN.md` §11.7).
 *
 * Keeps each project's `ScheduleConfig.refresh*` row in sync with its
 * client's plan tier, and runs the scoped re-measurement when a cadence
 * comes due. See the module README for the full scoping write-up; the short
 * version:
 *
 * - **Cadence is derived, never operator-set.** starter=weekly,
 *   growth/scale=daily, enterprise=daily (see `cadenceForTier` for why
 *   enterprise is not literally real-time).
 * - **Scope of the re-run.** Only `measurement` (one new run against the
 *   project's current ACTIVE query set, replaying the most recently used
 *   surface + geo) + `scoring` (`ScoringService.scoreProject`) — never the
 *   full Day-1 pipeline (competitor discovery, backlinks, tech-stack scan,
 *   etc. stay one-time/manual). `MeasurementService.executeRun` already
 *   enforces `MEASUREMENT_MAX_COST_PER_RUN`; this module does not bypass or
 *   duplicate that check.
 *
 * @module refresh-cadence.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MeasurementService } from '../measurement/measurement.service';
import { ScoringService } from '../scoring/scoring.service';
import type { Surface } from '../measurement/measurement.types';
import type { PlanTier, RefreshCadence, RefreshCadenceStatusDto, RefreshRunResultDto } from './refresh-cadence.types';

const VALID_TIERS: PlanTier[] = ['starter', 'growth', 'scale', 'enterprise'];

@Injectable()
export class RefreshCadenceService {
  private readonly logger = new Logger(RefreshCadenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly measurement: MeasurementService,
    private readonly scoring: ScoringService,
  ) {}

  /**
   * Plan-tier -> cadence mapping (`docs/analysis/client-portal.md` §19,
   * `docs/PLAN.md` §11.7): starter=weekly, growth/scale=daily.
   *
   * Enterprise is mapped to `daily` — the tightest cadence this module's
   * infrastructure (an hourly DB poll, see `refresh-cadence-scheduler.service.ts`)
   * actually supports today. `docs/PLAN.md`'s own architecture notes say
   * plainly: "Real-time monitoring... is future" (Phase 1 is batch runs on
   * cadence) — so a literal real-time cadence for Enterprise is a documented
   * gap, not silently invented here. See the module README's "Known gap"
   * section.
   */
  cadenceForTier(tier: string | null | undefined): RefreshCadence {
    switch (tier) {
      case 'starter':
        return 'weekly';
      case 'growth':
      case 'scale':
      case 'enterprise':
        return 'daily';
      default:
        // Unknown/missing tier: do not guess a spend-incurring cadence.
        return 'manual-only';
    }
  }

  /**
   * Ensure one project's `ScheduleConfig.refresh*` row matches its client's
   * current plan tier. Idempotent — a no-op when the row already agrees.
   * Never throws; a resolution failure is logged and the row is left as-is.
   */
  async syncProjectCadence(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, clientId: true, onboardingStatus: true },
    });
    if (!project) return;

    // Day-1 pipeline not finished yet — nothing to refresh, and setting a
    // cadence now would just mean the first tick finds no baseline and
    // skips (see runScopedRefresh). Still worth waiting so `active` doesn't
    // flip true before there is anything for the poller to find due.
    if (project.onboardingStatus !== 'completed') return;

    let tier: string | null = null;
    if (project.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: project.clientId },
        select: { planTier: true },
      });
      tier = client?.planTier ?? null;
    }

    const cadence = this.cadenceForTier(tier);
    const existing = await this.prisma.scheduleConfig.findUnique({ where: { projectId } });

    if (existing && existing.refreshCadence === cadence && existing.refreshActive === (cadence !== 'manual-only')) {
      return; // already in sync
    }

    const active = cadence !== 'manual-only';
    const nextRunAt = active ? this.nextSlot(cadence) : null;

    await this.prisma.scheduleConfig.upsert({
      where: { projectId },
      create: { projectId, refreshCadence: cadence, refreshActive: active, refreshNextRunAt: nextRunAt },
      update: { refreshCadence: cadence, refreshActive: active, refreshNextRunAt: active ? existing?.refreshNextRunAt ?? nextRunAt : null },
    });
    this.logger.log(`Refresh cadence for project ${projectId} set to ${cadence} (tier=${tier ?? 'none'})`);
  }

  /** Reconcile every completed project's cadence against its client's current tier. */
  async reconcileAll(): Promise<number> {
    const projects = await this.prisma.project.findMany({
      where: { onboardingStatus: 'completed', clientId: { not: null } },
      select: { id: true },
    });
    for (const p of projects) {
      await this.syncProjectCadence(p.id);
    }
    return projects.length;
  }

  /**
   * The scoped re-run itself: one new measurement run (current active query
   * set + the most recently used surface/geo) + a scoring run. Skips
   * cleanly (does not throw) when there is nothing yet to replay — a
   * project that has never been measured has no "most recently used
   * surface" to pick, and re-running is not this module's job to invent.
   */
  async runScopedRefresh(projectId: string): Promise<RefreshRunResultDto> {
    const lastRun = await this.prisma.measurementRun.findFirst({
      where: { projectId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { surface: true, geo: true },
    });
    if (!lastRun) {
      return { projectId, ran: false, skippedReason: 'No prior completed measurement run — nothing to replay yet' };
    }

    const activeQuerySet = await this.prisma.querySet.findFirst({
      where: { projectId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!activeQuerySet) {
      return { projectId, ran: false, skippedReason: 'No active query set — nothing to measure' };
    }

    const run = await this.measurement.createRun(projectId, {
      querySetId: activeQuerySet.id,
      surface: lastRun.surface as Surface,
      geo: lastRun.geo,
    });
    const executed = await this.measurement.executeRun(run.id);

    // executeRun does not throw on a run that ends `failed` (e.g. the
    // MEASUREMENT_MAX_COST_PER_RUN cap was hit, or every observation
    // errored) — it just records the reason on the run. Silently scoring
    // afterwards would report success for a refresh that measured nothing
    // new, so this module treats that the same as a thrown error: the
    // scheduler's `mark()` records it in `refreshLastError`, and a manual
    // `run-now` surfaces it as a failed request rather than a quiet 200.
    if (executed?.status === 'failed') {
      throw new Error(`Measurement run ${run.id} failed: ${executed.error ?? 'unknown reason'}`);
    }

    const score = await this.scoring.scoreProject(projectId);

    this.logger.log(`Scoped refresh complete for project ${projectId}: run ${run.id}, score run ${score.id}`);
    return { projectId, ran: true, measurementRunId: run.id, scoreRunId: score.id };
  }

  /** Read-only cadence status for a project — no config performed here. */
  async getStatus(projectId: string): Promise<RefreshCadenceStatusDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
    const config = await this.prisma.scheduleConfig.findUnique({ where: { projectId } });
    let tier: PlanTier | null = null;
    if (project?.clientId) {
      const client = await this.prisma.client.findUnique({ where: { id: project.clientId }, select: { planTier: true } });
      tier = (client?.planTier as PlanTier) ?? null;
      if (tier && !VALID_TIERS.includes(tier)) tier = null;
    }

    return {
      projectId,
      clientId: project?.clientId ?? null,
      planTier: tier,
      cadence: (config?.refreshCadence as RefreshCadence) ?? 'manual-only',
      active: config?.refreshActive ?? false,
      nextRunAt: config?.refreshNextRunAt?.toISOString() ?? null,
      lastRunAt: config?.refreshLastRunAt?.toISOString() ?? null,
      lastError: config?.refreshLastError ?? null,
    };
  }

  /** Next cadence slot, measured from now (a downed poller resumes cadence, never catches up a backlog). */
  nextSlot(cadence: RefreshCadence): Date {
    const days = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : 30;
    return new Date(Date.now() + days * 86_400_000);
  }
}
