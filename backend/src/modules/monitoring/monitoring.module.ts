/**
 * Monitoring Module — pipeline health, deltas, alerts (PRD 6.12) and the G07
 * alert triage surface.
 *
 * Wires the MonitoringService (snapshot / delta / checkDeltas / alerts) to the
 * shared SchedulingService: the `monitoring` task handler registered in the
 * service constructor re-runs the alert check on cadence (FR-12.1).
 *
 * `AlertsService` sits beside it as the *triage* half — alert lifecycle rows,
 * deduplication and acknowledge/assign/resolve — so generation and triage do
 * not have to know about each other's rules. `MonitoringService.raise` is the
 * only call from one into the other.
 *
 * PrismaService comes from the global DatabaseModule; ScopeValidationService
 * from the global ScopeValidationModule (activated in AuthModule).
 * CrawlerMonitorModule is imported so crawler-hit counts feed the snapshot.
 *
 * @module monitoring.module
 */

import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CrawlerMonitorModule } from '../crawler-monitor/crawler-monitor.module';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';

@Module({
  imports: [SchedulingModule, CrawlerMonitorModule],
  controllers: [MonitoringController, AlertsController],
  providers: [MonitoringService, AlertsService],
  exports: [MonitoringService, AlertsService],
})
export class MonitoringModule {}
