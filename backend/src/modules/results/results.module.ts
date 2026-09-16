/**
 * Results Module — comparable outcomes, report periods and evidence manifests.
 *
 * Contract source: design_plan.md Appendix A (G13, line 1671); metric dictionary
 * §6.3 (line 792) and comparison/evidence policy §6.4 (line 819).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is global (DatabaseModule); ScopeValidationService is global
 * (ScopeValidationModule, activated in AuthModule) — neither is imported here.
 *
 * @module results.module
 */

import { Module } from '@nestjs/common';
import {
  CohortsController,
  EvidenceManifestsController,
  PeriodsController,
  ResultsController,
  ResultsPortalController,
} from './results.controller';
import { CohortService } from './cohort.service';
import { EvidenceService } from './evidence.service';
import { PeriodService } from './period.service';
import { ResultsService } from './results.service';

@Module({
  controllers: [
    ResultsController,
    CohortsController,
    PeriodsController,
    EvidenceManifestsController,
    ResultsPortalController,
  ],
  providers: [ResultsService, CohortService, PeriodService, EvidenceService],
  exports: [ResultsService, CohortService, PeriodService, EvidenceService],
})
export class ResultsModule {}
