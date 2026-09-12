/**
 * Digital Presence Module — where the client exists on the internet.
 *
 * Discovers social, listing and app-store accounts from the client's own site,
 * lets the operator supply what discovery cannot reach, and assembles the wider
 * footprint from the modules that already own each fact (`aeo-audit` for
 * identity, `technical-audit` for owned properties, `google` for connected data).
 *
 * Depends only on `FetcherModule` and `DatabaseModule` — discovery is the client's
 * own site plus at most one request per found URL, so the module costs nothing
 * external. Wave-6 step 5 adds the two external-data adapters this module was
 * built ahead of: `PresenceDataForSeoService` (Business Data — profiles,
 * reviews) and `PresenceApifyService` (social activity, opt-in only — see
 * their own doc comments for the spend-safety rules).
 *
 * Analysis + approved decisions: `docs/analysis/digital-presence.md`,
 * `docs/analysis/wave-6-audit-pipeline.md` (D2, D7).
 *
 * @module digital-presence.module
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FetcherModule } from '../fetcher/fetcher.module';
import { SerpIntelligenceModule } from '../serp-intelligence/serp-intelligence.module';
import { PresenceController } from './presence.controller';
import { PresenceApifyService } from './presence.apify.service';
import { PresenceBrandVoiceService } from './presence.brand-voice.service';
import { PresenceDataForSeoService } from './presence.dataforseo.service';
import { PresenceDirectoryRatingService } from './presence.directory-rating.service';
import { PresenceDiscoveryService } from './presence.discovery.service';
import { PresenceLlmService } from './presence.llm.service';
import { PresenceSerpService } from './presence.serp.service';
import { PresenceService } from './presence.service';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [DatabaseModule, FetcherModule, JobsModule, SerpIntelligenceModule],
  controllers: [PresenceController],
  providers: [
    PresenceService,
    PresenceDiscoveryService,
    PresenceSerpService,
    PresenceDataForSeoService,
    PresenceApifyService,
    // Built ahead of being wired in — see docs/analysis/digital-presence.md:
    // multi-variant SERP search lives inside PresenceSerpService already;
    // these two are the net-new pieces (directory ratings beyond DataForSEO's
    // google/trustpilot/yelp, and brand-voice synthesis over Apify captions).
    PresenceDirectoryRatingService,
    PresenceLlmService,
    PresenceBrandVoiceService,
  ],
  exports: [
    PresenceService,
    PresenceDiscoveryService,
    PresenceSerpService,
    PresenceDataForSeoService,
    PresenceApifyService,
    PresenceDirectoryRatingService,
    PresenceLlmService,
    PresenceBrandVoiceService,
  ],
})
export class DigitalPresenceModule {}
