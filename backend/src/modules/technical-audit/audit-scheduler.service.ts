/**
 * Interval monitoring — the recurring half of the audit.
 *
 * A one-shot audit is a snapshot. The point of storing a composite score, a
 * delta set and a rolling narrative is that they form a *series*, and a series
 * needs something to keep running it. That is this.
 *
 * Why a cron and not the existing BullMQ path: BullMQ needs Redis, Redis is
 * not part of this deployment, and a scheduling feature that silently does
 * nothing whenever Redis is down is worse than none — the operator believes
 * they are being monitored. This runs in-process off `@nestjs/schedule`, needs
 * no infrastructure, and survives a restart because the next-run time lives in
 * the database rather than in a queue.
 *
 * Set `SCHEDULING_BACKEND=bullmq` to stand this down and let the queue own
 * recurring audits instead; the two must never both be armed, or every project
 * gets audited twice.
 *
 * @module technical-audit/audit-scheduler
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { TechnicalAuditService } from './technical-audit.service';

/** How far ahead of `nextRunAt` a due row is picked up, in ms. */
const DUE_WINDOW_MS = 60_000;

@Injectable()
export class AuditSchedulerService {
  private readonly logger = new Logger(AuditSchedulerService.name);

  /**
   * In-process guard. An audit takes ~2 minutes and the tick is hourly, so
   * overlap is unlikely — but a slow crawl on a large sitemap could still run
   * long, and two concurrent runs for one project would corrupt the
   * previous-run chain (both would diff against the same ancestor).
   */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audits: TechnicalAuditService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>('SCHEDULING_BACKEND', 'cron') !== 'bullmq';
  }

  /**
   * Hourly rather than per-cadence: cadences are daily, weekly or monthly, so the
   * tick only needs to be fine-grained enough that a due audit starts within
   * an hour of its slot. Polling the table is cheap.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'technical-audit-scheduler' })
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;

    this.running = true;
    try {
      const due = await this.prisma.scheduleConfig.findMany({
        where: {
          active: true,
          cadence: { in: ['daily', 'weekly', 'monthly'] },
          nextRunAt: { lte: new Date(Date.now() + DUE_WINDOW_MS) },
        },
      });
      if (!due.length) return;

      this.logger.log(`${due.length} scheduled audit(s) due`);

      // Sequential, deliberately. Each run drives Playwright, PSI and a
      // site-wide crawl; running several at once would blow the fetcher's rate
      // limits and the per-run cost ceiling at the same time.
      for (const row of due) {
        await this.runOne(row);
      }
    } catch (err) {
      this.logger.error(`Scheduler tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async runOne(row: {
    id: string;
    projectId: string;
    cadence: string;
    targetUrl: string | null;
  }): Promise<void> {
    const targetUrl = row.targetUrl || (await this.resolveFromProject(row.projectId));
    if (!targetUrl) {
      await this.mark(row.id, row.cadence, 'No target URL and the project has no domain');
      return;
    }

    try {
      const result = await this.audits.runAudit(targetUrl, row.projectId, 'scheduled');
      this.logger.log(`Scheduled audit for ${targetUrl} scored ${result.score ?? 'n/a'}`);
      await this.mark(row.id, row.cadence, null);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Scheduled audit failed for ${targetUrl}: ${message}`);
      // Still advance nextRunAt. A failing site must not pin the scheduler to
      // a permanently-due row that retries every hour forever.
      await this.mark(row.id, row.cadence, message);
    }
  }

  private async resolveFromProject(projectId: string): Promise<string | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    });
    if (!project?.domain) return null;
    const raw = project.domain.trim();
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  }

  /** Record the outcome and book the next slot. */
  private async mark(id: string, cadence: string, error: string | null): Promise<void> {
    await this.prisma.scheduleConfig.update({
      where: { id },
      data: {
        lastRunAt: new Date(),
        lastError: error,
        nextRunAt: this.nextSlot(cadence),
      },
    });
  }

  /**
   * Next run time, measured from now rather than from the previous slot — a
   * scheduler that was down for a fortnight should resume its cadence, not
   * fire a backlog of catch-up audits.
   */
  private nextSlot(cadence: string): Date {
    const now = Date.now();
    const days = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : 30;
    return new Date(now + days * 86_400_000);
  }
}
