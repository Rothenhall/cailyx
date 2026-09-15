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
import { ClientsService } from './clients.service';
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
    // Opt-in Day-1 pipeline stages (checkbox on "Add Client") — real spend
    // per run, so they never run unless the operator explicitly asks.
    AeoAuditModule,
    KeywordResearchModule,
    GrowthExecutionModule,
    BacklinksModule,
  ],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
