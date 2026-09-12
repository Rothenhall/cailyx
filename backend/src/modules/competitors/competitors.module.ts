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

@Module({
  imports: [FetcherModule, TechStackModule, DigitalPresenceModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService],
  exports: [CompetitorsService],
})
export class CompetitorsModule {}
