/**
 * Opportunities Module — P07, platform_improvement_plan.md §12.5-§12.7.
 *
 * Canonical `Opportunity` ("idea") records: an observed-corpus keyword-gap
 * engine (reading `Competitor`/`SerpResult`/`KeywordSet` rows this project
 * already has, via `PrismaService` directly — same read-only discipline
 * `competitors.service.ts` documents for itself, never a new SERP/AEO/vendor
 * call), plus the §12.7 opportunity -> content conversion contract, which
 * reuses `GrowthExecutionModule`'s existing `GrowthAsset` creation
 * (extended with an optional `sourceOpportunityId` + `idempotencyKey`).
 *
 * Depends on: GrowthExecutionModule (idempotent asset creation),
 * KeywordResearchModule (the "Research a search term" secondary action,
 * §12.6 R29 — reuses its existing vendor call + cost gates unchanged).
 *
 * @module opportunities.module
 */

import { Module } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { OpportunitiesController, OpportunitiesPortalController } from './opportunities.controller';
import { GrowthExecutionModule } from '../growth-execution/growth-execution.module';
import { KeywordResearchModule } from '../keyword-research/keyword-research.module';

@Module({
  imports: [GrowthExecutionModule, KeywordResearchModule],
  // OpportunitiesPortalController (2026-09-21) is the read-only client-portal
  // surface for "Digital Marketing → Ideation". ScopeValidationService is
  // global (see business-profile.module.ts's note on the same pattern) so it
  // is not imported here.
  controllers: [OpportunitiesController, OpportunitiesPortalController],
  providers: [OpportunitiesService],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}
