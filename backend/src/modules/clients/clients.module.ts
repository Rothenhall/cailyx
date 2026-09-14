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
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';

@Module({
  imports: [JobsModule, DigitalPresenceModule, TechStackModule, CompetitorsModule, GapAnalysisModule, StrategyModule, ReportingModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
