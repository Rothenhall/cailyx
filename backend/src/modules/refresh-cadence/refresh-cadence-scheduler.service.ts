/**
 * Interval poller for C7's automatic refresh cadence — same shape as
 * `technical-audit/audit-scheduler` and `seo-audit/seo-audit-scheduler`: an
 * in-process `@nestjs/schedule` cron reconciles cadence-vs-plan-tier, then
 * polls `ScheduleConfig` (the `refresh*` columns, so it cannot collide with
 * technical-audit's or monitoring's shared `cadence` column) and runs any
 * refresh that's due. No Redis required — this works under the default
 * `SCHEDULING_BACKEND=cron`, which is what this repo actually runs today
 * (see `technical-audit/audit-scheduler.service.ts`'s own doc comment on why
 * BullMQ is not the default path here).
 *
 * Stood down when `SCHEDULING_BACKEND=bullmq`, matching its siblings —
 * consistent behaviour is worth more here than wiring a second execution
 * path for a feature this new.
 *
 * @module refresh-cadence/refresh-cadence-scheduler
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { RefreshCadenceService } from './refresh-cadence.service';

const DUE_WINDOW_MS = 60_000;

@Injectable()
export class RefreshCadenceSchedulerService {
  private readonly logger = new Logger(RefreshCadenceSchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refresh: RefreshCadenceService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>('SCHEDULING_BACKEND', 'cron') !== 'bullmq';
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'refresh-cadence-scheduler' })
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      // 1. Reconcile: a plan-tier change (or a project just finishing Day-1)
      //    since the last tick gets its cadence row updated before we look
      //    for due rows, so a fresh upgrade doesn't wait a full cycle.
      await this.refresh.reconcileAll();

      // 2. Run whatever is due.
      const due = await this.prisma.scheduleConfig.findMany({
        where: {
          refreshActive: true,
          refreshCadence: { in: ['daily', 'weekly'] },
          refreshNextRunAt: { lte: new Date(Date.now() + DUE_WINDOW_MS) },
        },
      });
      if (!due.length) return;

      this.logger.log(`${due.length} scheduled refresh(es) due`);
      // Sequential, deliberately — a scoped refresh calls a real measurement
      // surface (cost per call) and this repo's per-run cost cap is a
      // per-run ceiling, not a global concurrency limiter.
      for (const row of due) {
        await this.runOne(row.id, row.projectId, row.refreshCadence);
      }
    } catch (err) {
      this.logger.error(`Refresh-cadence scheduler tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async runOne(id: string, projectId: string, cadence: string): Promise<void> {
    try {
      const result = await this.refresh.runScopedRefresh(projectId);
      if (result.ran) {
        this.logger.log(`Scheduled refresh for project ${projectId}: measurement run ${result.measurementRunId}, score run ${result.scoreRunId}`);
        await this.mark(id, cadence, null);
      } else {
        this.logger.log(`Scheduled refresh for project ${projectId} skipped: ${result.skippedReason}`);
        await this.mark(id, cadence, null);
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Scheduled refresh failed for project ${projectId}: ${message}`);
      // Still advance nextRunAt — a failing project must not pin the
      // scheduler to a permanently-due row that retries hourly forever.
      await this.mark(id, cadence, message);
    }
  }

  private async mark(id: string, cadence: string, error: string | null): Promise<void> {
    await this.prisma.scheduleConfig.update({
      where: { id },
      data: {
        refreshLastRunAt: new Date(),
        refreshLastError: error,
        refreshNextRunAt: this.refresh.nextSlot(cadence as 'daily' | 'weekly' | 'manual-only'),
      },
    });
  }
}
