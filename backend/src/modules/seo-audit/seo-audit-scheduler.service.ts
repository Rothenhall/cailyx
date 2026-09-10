/**
 * Interval monitoring for the SEO audit — the recurring half.
 *
 * Same shape as technical-audit/audit-scheduler: an in-process `@nestjs/schedule`
 * cron polls `ScheduleConfig` (the `seo*` columns) and runs any due audit. No
 * Redis. The one wrinkle vs the technical scheduler: an SEO run needs a Google
 * access token, which is per-operator, so the run is executed as whichever
 * user's Search Console connection is mapped to the project.
 *
 * Stood down when `SCHEDULING_BACKEND=bullmq`.
 *
 * @module seo-audit/seo-audit-scheduler
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { SeoAuditService } from './seo-audit.service';

const DUE_WINDOW_MS = 60_000;

@Injectable()
export class SeoAuditSchedulerService {
  private readonly logger = new Logger(SeoAuditSchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly seo: SeoAuditService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>('SCHEDULING_BACKEND', 'cron') !== 'bullmq';
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'seo-audit-scheduler' })
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.scheduleConfig.findMany({
        where: {
          seoActive: true,
          seoCadence: { in: ['daily', 'weekly', 'monthly'] },
          seoNextRunAt: { lte: new Date(Date.now() + DUE_WINDOW_MS) },
        },
      });
      if (!due.length) return;
      this.logger.log(`${due.length} scheduled SEO audit(s) due`);
      for (const row of due) await this.runOne(row.id, row.projectId, row.seoCadence);
    } catch (err) {
      this.logger.error(`SEO scheduler tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async runOne(id: string, projectId: string, cadence: string): Promise<void> {
    // Which operator's Search Console connection backs this project?
    const resource = await this.prisma.googleProjectResource.findUnique({
      where: { projectId_service: { projectId, service: 'search-console' } },
      include: { connection: { select: { userId: true } } },
    });
    if (!resource?.connection?.userId) {
      await this.mark(id, cadence, 'No Search Console connection mapped to this project');
      return;
    }

    try {
      const audit = await this.seo.run(projectId, resource.connection.userId, 'scheduled', 28);
      this.logger.log(`Scheduled SEO audit for ${projectId} scored ${audit?.score ?? 'n/a'}`);
      await this.mark(id, cadence, null);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Scheduled SEO audit failed for ${projectId}: ${message}`);
      await this.mark(id, cadence, message);
    }
  }

  private async mark(id: string, cadence: string, error: string | null): Promise<void> {
    await this.prisma.scheduleConfig.update({
      where: { id },
      data: { seoLastRunAt: new Date(), seoLastError: error, seoNextRunAt: this.nextSlot(cadence) },
    });
  }

  private nextSlot(cadence: string): Date {
    const days = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : 30;
    return new Date(Date.now() + days * 86_400_000);
  }
}
