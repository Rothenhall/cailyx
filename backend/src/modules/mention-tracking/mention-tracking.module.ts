/**
 * Mention Tracking Module — external mention ledger + decay (SOP-7, FR-4.4).
 *
 * PrismaService comes from the global DatabaseModule; page fetches go through
 * the FetcherModule (single-fetch semi-auto posture, no crawling).
 *
 * @module mention-tracking.module
 */

import { Module } from '@nestjs/common';
import { FetcherModule } from '../fetcher/fetcher.module';
import { MentionTrackingService } from './mention-tracking.service';
import { MentionTrackingController } from './mention-tracking.controller';

@Module({
  imports: [FetcherModule],
  controllers: [MentionTrackingController],
  providers: [MentionTrackingService],
  exports: [MentionTrackingService],
})
export class MentionTrackingModule {}