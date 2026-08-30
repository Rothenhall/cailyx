/**
 * Monitoring Module — pipeline health, deltas, and alerts (PRD 6.12).
 *
 * Wires the MonitoringService (snapshot / delta / checkDeltas / alerts) to the
 * shared SchedulingService: the `monitoring` task handler registered in the
 * service constructor re-runs the alert check on cadence (FR-12.1).
 *
 * PrismaService comes from the global DatabaseModule. CrawlerMonitorModule is
 * imported so crawler-hit counts feed the snapshot.
 *
 * @module monitoring.module
 */

import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrawlerMonitorModule } from '../crawler-monitor/crawler-monitor.module';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

@Module({
  imports: [SchedulingModule, CrawlerMonitorModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}