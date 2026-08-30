/**
 * SERP Intelligence Module — ranking / competitor / AI-Overview tracking (Agent #3).
 *
 * Reads a licensed SERP data feed (DataForSEO) through FetcherService. No
 * headless-browser scraping and no user-simulated queries/clicks/impressions. A
 * `fixture` provider (gated by SERP_ALLOW_FIXTURE) backs the smoke harness.
 *
 * Depends on: DatabaseModule (PrismaService), ConfigModule (global),
 *             FetcherModule (FetcherService).
 *
 * @module serp-intelligence.module
 */

import { Module } from '@nestjs/common';
import { FetcherModule } from '../fetcher/fetcher.module';
import { SerpIntelligenceService } from './serp-intelligence.service';
import { SerpIntelligenceController } from './serp-intelligence.controller';

@Module({
  imports: [FetcherModule],
  controllers: [SerpIntelligenceController],
  providers: [SerpIntelligenceService],
  exports: [SerpIntelligenceService],
})
export class SerpIntelligenceModule {}
