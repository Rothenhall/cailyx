/**
 * Clients Module — admin side of the lean client-management layer.
 *
 * Orchestrates the Day-1 pipeline by importing every module it calls into
 * directly: JobsModule (PipelineQueueService, for technical-audit polling),
 * DigitalPresenceModule, TechStackModule, CompetitorsModule, GapAnalysisModule,
 * StrategyModule, ReportingModule (which itself pulls in ScoringModule/
 * FindingsModule). No new audit logic lives here — this module only sequences
 * calls into modules that already exist.
 *
 * `ClientsOnboardingExecutors` (G07/A7) registers one executor per Day-1 stage
 * with `OnboardingService`, so the durable onboarding run can advance without
 * this module being imported by `jobs/`. It calls the same services the
 * background pipeline does.
 *
 * @module clients.module
 */

import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { DigitalPresenceModule } from '../digital-presence/digital-presence.module';
import { TechStackModule } from '../tech-stack/tech-stack.module';
import { CompetitorsModule } from '../competitors/competitors.module';
import { GapAnalysisModule } from '../gap-analysis/gap-analysis.module';
import { StrategyModule } from '../strategy/strategy.module';
import { ReportingModule } from '../reporting/reporting.module';
import { IntakeModule } from '../intake/intake.module';
import { AeoAuditModule } from '../aeo-audit/aeo-audit.module';
import { KeywordResearchModule } from '../keyword-research/keyword-research.module';
import { GrowthExecutionModule } from '../growth-execution/growth-execution.module';
import { EntityAuditModule } from '../entity-audit/entity-audit.module';
import { BacklinksModule } from '../backlinks/backlinks.module';
import { FindingsModule } from '../findings/findings.module';
// §3.4's client-list delivery columns read DeliveryPlanService's own
// definitions (frozen cycle denominator, the action queue's sources) rather
// than re-deriving them in this module.
import { DeliveryPlanModule } from '../delivery-plan/delivery-plan.module';
// C1 — ActivityService.record() is how the "waive onboarding-wizard gate"
// action (§15) writes to the shared admin-action audit log (§33). No new
// audit-log module was built: `activity` (G15) already IS that shared
// mechanism (actor, action, target, timestamp, redacted metadata, plus
// admin-only read/export routes) — see clients.service.ts's import comment.
import { ActivityModule } from '../activity/activity.module';
// C5 (`docs/analysis/client-portal.md` §5/§23) — suspendClient() revokes
// Google access for every project of the client via GoogleDelegationService's
// own disconnect path (never re-implemented here). No circular dependency:
// ClientAccessModule imports only GoogleModule.
// C2 (`docs/analysis/client-portal.md` §2/§18) — the auto-email-on-Day-1-
// completion hook calls ClientAccessService.createSystemInvite() directly,
// not the HTTP endpoint.
import { ClientAccessModule } from '../client-access/client-access.module';
import { ClientsService } from './clients.service';
import { ClientsOnboardingExecutors } from './clients.onboarding-executors';
import { ClientsController } from './clients.controller';

@Module({
  imports: [
    JobsModule,
    DigitalPresenceModule,
    TechStackModule,
    CompetitorsModule,
    GapAnalysisModule,
    StrategyModule,
    ReportingModule,
    IntakeModule,
    // Free, always-on stages — no external spend, so no opt-in checkbox.
    EntityAuditModule,
    FindingsModule,
    DeliveryPlanModule,
    // Opt-in Day-1 pipeline stages (checkbox on "Add Client") — real spend
    // per run, so they never run unless the operator explicitly asks.
    AeoAuditModule,
    KeywordResearchModule,
    GrowthExecutionModule,
    BacklinksModule,
    ActivityModule,
    ClientAccessModule,
  ],
  controllers: [ClientsController],
  providers: [ClientsService, ClientsOnboardingExecutors],
  exports: [ClientsService],
})
export class ClientsModule {}
