/**
 * Reporting Module — Branded diagnostic report generation.
 *
 * Aggregates data from technical-audit (Prisma), entity-audit (Prisma),
 * gap-analysis (Prisma) and — as of the stage-12 completion pass — strategy
 * (stage 9's ranked action plan) and findings (stage 8's LLM what/why/fix
 * copy) into scored reports with executive/detailed HTML rendering. This is
 * the flowchart's "Comprehensive Audit & Growth Report" → "Prioritized
 * Growth Roadmap" (stage 12, "Final Output").
 *
 * Built (FR-10):
 *   - Report generation with PRD §8 scoring
 *   - Executive + detailed HTML views
 *   - Stable slug URLs, visibility control
 *   - Branding config (white-label ready)
 *   - Growth plan section: strategy's ranked ActionPlan + findings' copy
 *   - Backlinks section: the project's latest DataForSEO backlinks snapshot
 *
 * `StrategyService.getActionPlan()`, `FindingsService.list()` and
 * `BacklinksService.latest()` are all pure reads (no rebuild, no LLM call,
 * no vendor call) — report generation must never trigger a paid call or a
 * gap-analysis re-sync as a side effect.
 *
 * Depends on: DatabaseModule (PrismaService reports/audits/gaps access)
 *
 * @module reporting.module
 */

import { Module } from '@nestjs/common';
import { forwardRef } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { StrategyModule } from '../strategy/strategy.module';
import { FindingsModule } from '../findings/findings.module';
import { BacklinksModule } from '../backlinks/backlinks.module';
import { AuthModule } from '../auth/auth.module';
import { DigitalPresenceModule } from '../digital-presence/digital-presence.module';
import { CompetitorsModule } from '../competitors/competitors.module';
import { ReportingService } from './reporting.service';
import { ReportLifecycleService } from './report-lifecycle.service';
import { ReportMigrationController, ReportingController, SharedReportController } from './reporting.controller';
import { ResultsModule } from '../results/results.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DeliveryPlanModule } from '../delivery-plan/delivery-plan.module';

@Module({
  imports: [
    ScoringModule,
    StrategyModule,
    FindingsModule,
    BacklinksModule,
    AuthModule,
    DigitalPresenceModule,
    CompetitorsModule,
    // G13 — provides PeriodService (exact/derived window) and EvidenceService
    // (the frozen source manifest a report pins). `forwardRef` because P15's
    // Overview lives in the results module and reads released reports through
    // `ReportLifecycleService` — the cycle is real and documented on both sides
    // rather than worked around with a second copy of the release gate.
    forwardRef(() => ResultsModule),
    // G10 — the release gate. `assertReadyToPublish` is called by
    // ReportLifecycleService before every publication, which is what makes
    // G10's README claim about report release true.
    ApprovalsModule,
    // The existing Plunk adapter, reused rather than re-implemented: a report
    // delivery attempt sends through the same provider path as
    // `POST /projects/:id/delivery/send`, and records the outcome in its own
    // ledger (ReportDeliveryAttempt) instead of inferring anything from it.
    DeliveryModule,
    // P15 — §14.5 item 8's frozen plan-progress section comes from the module
    // that owns commitments, so the released figure and the live Overview
    // footer are the same calculation. `DeliveryPlanModule` imports nothing, so
    // this adds no cycle.
    DeliveryPlanModule,
  ],
  controllers: [ReportingController, ReportMigrationController, SharedReportController],
  providers: [ReportingService, ReportLifecycleService],
  exports: [ReportingService, ReportLifecycleService],
})
export class ReportingModule {}