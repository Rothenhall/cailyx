/**
 * Root application module.
 * Imports all feature modules and shared configuration.
 *
 * @module AppModule
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { HealthModule } from './modules/health/health.module';
import { DatabaseModule } from './modules/database/database.module';
import { FetcherModule } from './modules/fetcher/fetcher.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { TechnicalAuditModule } from './modules/technical-audit/technical-audit.module';
import { EntityAuditModule } from './modules/entity-audit/entity-audit.module';
import { GapAnalysisModule } from './modules/gap-analysis/gap-analysis.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { IntakeModule } from './modules/intake/intake.module';
import { QuerySetModule } from './modules/query-set/query-set.module';
import { AuthModule } from './modules/auth/auth.module';
import { MeasurementModule } from './modules/measurement/measurement.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { FindingsModule } from './modules/findings/findings.module';
import { CrawlerMonitorModule } from './modules/crawler-monitor/crawler-monitor.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { PageAnalysisModule } from './modules/page-analysis/page-analysis.module';
import { MentionTrackingModule } from './modules/mention-tracking/mention-tracking.module';
import { SleeperRefreshModule } from './modules/sleeper-refresh/sleeper-refresh.module';
import { DataAssetModule } from './modules/data-asset/data-asset.module';
import { PipelineMathModule } from './modules/pipeline-math/pipeline-math.module';
import { ScorecardModule } from './modules/scorecard/scorecard.module';
import { DeliveryModule } from './modules/delivery/delivery.module';

@Module({
  imports: [
    // Global configuration module — loads .env variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),

    // Global rate limiting — 100 requests per 60s per IP (default)
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

    // Infrastructure modules (global)
    DatabaseModule,

    // Foundation — all outbound network requests go through this
    // Internal module — no REST endpoints, injected via DI
    FetcherModule,

    // Scheduling — recurring task management via BullMQ
    // Internal module — no REST endpoints, injected via DI
    SchedulingModule,

    // Feature modules
    HealthModule,
    TechnicalAuditModule,
    EntityAuditModule,
    GapAnalysisModule,
    ReportingModule,
    ProjectsModule,
    IntakeModule,
    QuerySetModule,

    // Auth — registers global JwtAuthGuard + RolesGuard (APP_GUARD)
    AuthModule,

    // Measurement — AI-surface observation runs (the moat: n≥5, rates not positions)
    MeasurementModule,

    // Wave 2 — scoring rubric, claims discipline, findings copy
    ScoringModule,
    ClaimsModule,
    FindingsModule,

    // Wave 3 — AI-crawler log ingestion, health deltas + alerts
    CrawlerMonitorModule,
    MonitoringModule,

    // Wave 4 — content & outreach tools (SOP-6/7/10/8)
    PageAnalysisModule,
    MentionTrackingModule,
    SleeperRefreshModule,
    DataAssetModule,

    // Wave 5 — sales & qualification (PLAN Phase 4)
    PipelineMathModule,
    ScorecardModule,
    DeliveryModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
