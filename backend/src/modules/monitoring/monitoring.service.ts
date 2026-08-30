/**
 * Monitoring Service — scheduled re-run checks, deltas, and alerts (PRD 6.12).
 *
 * Reads whatever the pipeline has already produced (score runs, measurement
 * observations, crawler hits), computes deltas between the two latest score
 * runs, raises `Alert` rows on regressions (score-drop / mention-drop beyond
 * thresholds), and registers a `monitoring` scheduled task with the
 * SchedulingService for cadence-driven re-checks (FR-12.1).
 *
 * @module monitoring.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CrawlerMonitorService } from '../crawler-monitor/crawler-monitor.service';
import type { MonitorDelta, MonitorSnapshot } from './monitoring.types';

/** Score-drop alert threshold in points. */
const SCORE_DROP_THRESHOLD = 10;

/** Mention-rate drop alert threshold (absolute, e.g. 0.15 = 15 points). */
const MENTION_DROP_THRESHOLD = 0.15;

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crawlerMonitor: CrawlerMonitorService,
    private readonly scheduling: SchedulingService,
  ) {
    // Scheduled re-runs (FR-12.1): the monitoring cadence re-checks deltas
    // and raises alerts — reuses the shared BullMQ scheduling infrastructure.
    this.scheduling.registerHandler('monitoring', async (projectId) => {
      try {
        const alerts = await this.checkDeltas(projectId);
        this.logger.log('Scheduled monitoring check for ' + projectId + ': ' + alerts.length + ' alert(s)');
      } catch (err) {
        this.logger.error('Scheduled monitoring check failed for ' + projectId + ': ' + (err as Error).message);
        await this.raise(projectId, 'scheduled-run-failed', 'critical', 'Scheduled monitoring check failed: ' + (err as Error).message, {}).catch(() => undefined);
      }
    });
  }

  /** Point-in-time snapshot of the pipeline's visible health (FR-12.4). */
  async snapshot(projectId: string): Promise<MonitorSnapshot> {
    const [latestScore, latestRun, crawlerHits] = await Promise.all([
      this.prisma.scoreRun.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.measurementRun.findFirst({ where: { projectId, status: 'completed' }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { observations: true } } } }),
      this.prisma.crawlerHit.count({ where: { projectId } }),
    ]);

    let mentionRate: number | null = null;
    let citationRate: number | null = null;
    if (latestRun) {
      const agg = await this.prisma.observation.aggregate({
        where: { runId: latestRun.id },
        _count: { _all: true },
      });
      const total = agg._count._all;
      if (total > 0) {
        const mentioned = await this.prisma.observation.count({ where: { runId: latestRun.id, mentioned: true } });
        const cited = await this.prisma.observation.count({ where: { runId: latestRun.id, cited: true } });
        mentionRate = Number((mentioned / total).toFixed(4));
        citationRate = Number((cited / total).toFixed(4));
      }
    }

    if (!latestScore && !latestRun) {
      throw new NotFoundException('Nothing to monitor yet — run scoring or measurement first');
    }

    return {
      projectId,
      scoreTotal: latestScore?.total ?? null,
      scoreBand: latestScore?.band ?? null,
      scoreRunId: latestScore?.id ?? null,
      mentionRate,
      citationRate,
      observations: latestRun?._count.observations ?? 0,
      crawlerHits,
      takenAt: new Date().toISOString(),
    };
  }

  /** Delta between the two latest score runs (FR-12.2), null-safe. */
  async getDelta(projectId: string): Promise<MonitorDelta> {
    const scores = await this.prisma.scoreRun.findMany({
      where: { projectId },
      orderBy: [createdAtOrder],
      take: 2,
    });
    const runs = await this.prisma.measurementRun.findMany({
      where: { projectId, status: 'completed' },
      orderBy: [createdAtOrder],
      take: 2,
      include: { _count: { select: { observations: true } } },
    });

    return {
      projectId,
      score:
        scores.length >= 1
          ? {
              before: scores[1]?.total ?? null,
              after: scores[0].total,
              change: scores[1] ? scores[0].total - scores[1].total : null,
            }
          : null,
      measurement:
        runs.length >= 1
          ? {
              observationsBefore: runs[1]?._count.observations ?? null,
              observationsAfter: runs[0]._count.observations,
            }
          : null,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Compare the two latest score runs + measurement observation counts and
   * raise alerts on regressions (FR-12.3). Manual or scheduled.
   */
  async checkDeltas(projectId: string): Promise<Array<{ kind: string; severity: string; message: string }>> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    const alerts: Array<{ kind: string; severity: string; message: string }> = [];

    const scores = await this.prisma.scoreRun.findMany({ where: { projectId }, orderBy: [createdAtOrder], take: 2 });
    if (scores.length === 2) {
      const drop = scores[1].total - scores[0].total;
      if (drop >= SCORE_DROP_THRESHOLD) {
        alerts.push({
          kind: 'score-drop',
          severity: drop >= 20 ? 'critical' : 'warning',
          message: 'Visibility score dropped ' + drop + ' points: ' + scores[1].total + ' → ' + scores[0].total,
        });
      }
    }

    const runs = await this.prisma.measurementRun.findMany({ where: { projectId, status: 'completed' }, orderBy: [createdAtOrder], take: 2 });
    if (runs.length === 2) {
      const before = await this.mentionRate(runs[1].id);
      const after = await this.mentionRate(runs[0].id);
      if (before !== null && after !== null && before - after >= MENTION_DROP_THRESHOLD) {
        alerts.push({
          kind: 'mention-drop',
          severity: before - after >= 0.3 ? 'critical' : 'warning',
          message: 'Mention rate dropped ' + ((before - after) * 100).toFixed(1) + ' points: ' + (before * 100).toFixed(1) + '% → ' + (after * 100).toFixed(1) + '%',
        });
      }
    }

    for (const a of alerts) {
      await this.raise(projectId, a.kind as 'score-drop' | 'mention-drop' | 'scheduled-run-failed', a.severity as 'info' | 'warning' | 'critical', a.message, {});
    }
    return alerts;
  }

  /** List alerts, newest first. */
  async listAlerts(projectId: string) {
    return this.prisma.alert.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  // ─── Privates ─────────────────────────────────────────────────

  private mentionRate(runId: string): Promise<number | null> {
    return this.prisma.observation
      .aggregate({ where: { runId }, _count: { _all: true } })
      .then(async (agg) => {
        const total = agg._count._all;
        if (total === 0) return null;
        const mentioned = await this.prisma.observation.count({ where: { runId, mentioned: true } });
        return mentioned / total;
      });
  }

  private async raise(projectId: string, kind: 'score-drop' | 'mention-drop' | 'scheduled-run-failed', severity: 'info' | 'warning' | 'critical', message: string, payload: Record<string, unknown>) {
    const created = await this.prisma.alert.create({
      data: { projectId, kind, severity, message, payload: JSON.stringify(payload) },
    });
    this.logger.warn('Alert [' + severity + '] ' + kind + ': ' + message);
    return created;
  }
}

/** Shared ordering literal (SQLite-safe: orderBy by single field). */
const createdAtOrder = { createdAt: 'desc' as const };