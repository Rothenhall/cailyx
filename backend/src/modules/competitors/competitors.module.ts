/**
 * Competitors Module — competitor discovery + light profiling (wave-6,
 * D4/step 6).
 *
 * Promotes `Project.competitors` (JSON) into first-class `Competitor` rows,
 * profiles each one with a homepage tech-stack scan + schema read + attached
 * SERP/AEO presence, and produces a gap comparison.
 *
 * Depends on: FetcherModule (schema read), TechStackModule (reused unchanged
 * for the per-competitor tech scan) and DigitalPresenceModule (its discovery
 * service, reused unchanged, to find each rival's own external profiles).
 *
 * @module competitors.module
 */

import { Module } from '@nestjs/common';
import { CompetitorsService } from './competitors.service';
import { CompetitorsController } from './competitors.controller';
import { FetcherModule } from '../fetcher/fetcher.module';
import { TechStackModule } from '../tech-stack/tech-stack.module';
import { DigitalPresenceModule } from '../digital-presence/digital-presence.module';
import { BusinessProfileModule } from '../business-profile/business-profile.module';
import { SerpIntelligenceModule } from '../serp-intelligence/serp-intelligence.module';
import { AeoAuditModule } from '../aeo-audit/aeo-audit.module';

@Module({
  // BusinessProfileModule and SerpIntelligenceModule back §12.2's
  // service/market-based discovery: confirmed services/segments/target
  // markets are read-only from BusinessProfileService (that module's own
  // code is untouched), and bounded searches go through the same gated
  // SERP provider `serp-intelligence` already exposes for `capture()`.
  // AeoAuditModule provides AeoStanceService — read-only, for Stage 4 competitor
  // ranking over stored stances (aeo-audit does not import competitors, so no cycle).
  imports: [FetcherModule, TechStackModule, DigitalPresenceModule, BusinessProfileModule, SerpIntelligenceModule, AeoAuditModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService],
  exports: [CompetitorsService],
})
export class CompetitorsModule {}
