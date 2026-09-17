/**
 * Results Module — comparable outcomes, report periods and evidence manifests.
 *
 * Contract source: design_plan.md Appendix A (G13, line 1671); metric dictionary
 * §6.3 (line 792) and comparison/evidence policy §6.4 (line 819).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * ## P15 — the Overview and the client Results tabs
 *
 * §5.7 puts the Overview composition in "an existing project/results
 * read-model owner", and this module is that owner: `OverviewService` composes
 * §5.1's page from the modules that own each panel's data, and
 * `ResultsTabsService` projects the §3.3 domain reads for clients. Both are
 * pure reads of stored state (see the service headers for the two side-effect
 * traps that were deliberately avoided).
 *
 * `ReportingModule` is a **circular** dependency — it already imports this
 * module for `PeriodService`/`EvidenceService`, and the Overview's report panel
 * needs `ReportLifecycleService` (the release gate). `forwardRef` on both sides
 * is the honest resolution: the alternative, reading released reports directly
 * from Prisma here, would be a second implementation of the release gate, and
 * that discipline is exactly what P15's exit gate tests.
 *
 * PrismaService is global (DatabaseModule); ScopeValidationService is global
 * (ScopeValidationModule, activated in AuthModule) — neither is imported here.
 *
 * @module results.module
 */

import { Module, forwardRef } from '@nestjs/common';
import {
  CohortsController,
  EvidenceManifestsController,
  PeriodsController,
  ResultsController,
  ResultsPortalController,
} from './results.controller';
import { OverviewController } from './overview.controller';
import { CohortService } from './cohort.service';
import { EvidenceService } from './evidence.service';
import { PeriodService } from './period.service';
import { ResultsService } from './results.service';
import { OverviewService } from './overview.service';
import { ResultsTabsService } from './results-tabs.service';
import { AeoAuditModule } from '../aeo-audit/aeo-audit.module';
import { CompetitorsModule } from '../competitors/competitors.module';
import { ContentCalendarModule } from '../content-calendar/content-calendar.module';
import { DeliveryPlanModule } from '../delivery-plan/delivery-plan.module';
import { DigitalPresenceModule } from '../digital-presence/digital-presence.module';
import { ReportingModule } from '../reporting/reporting.module';
import { ScoringModule } from '../scoring/scoring.module';
import { WebsiteModule } from '../website/website.module';

@Module({
  imports: [
    // Each panel's data comes from the module that owns it.
    ScoringModule, // the Cailyx score family (stored runs only)
    DeliveryPlanModule, // the §5.6 action queue and the 30-day plan
    ContentCalendarModule, // §5.1's upcoming content
    WebsiteModule, // Results tab: Website
    AeoAuditModule, // Results tab: AI visibility
    // Results tab: Online presence. Only `PresenceService.portalInventory` is
    // called — P05's existing client projection — and `DigitalPresenceModule`
    // imports nothing from this one, so this adds no cycle.
    DigitalPresenceModule,
    CompetitorsModule, // Results tab: Competitors
    forwardRef(() => ReportingModule), // the released report (and its frozen score)
  ],
  controllers: [
    ResultsController,
    CohortsController,
    PeriodsController,
    EvidenceManifestsController,
    ResultsPortalController,
    OverviewController,
  ],
  providers: [ResultsService, CohortService, PeriodService, EvidenceService, OverviewService, ResultsTabsService],
  exports: [ResultsService, CohortService, PeriodService, EvidenceService, OverviewService, ResultsTabsService],
})
export class ResultsModule {}
