/**
 * Authority Module — legitimate-mention discovery (Agent #6, Swarm layer).
 *
 * Discovers publications / communities / podcasts / directories where the client
 * could earn a mention (SERP listicles, AI-answer citations, optional LLM), and
 * promotes chosen ones into the `mention-tracking` outreach ledger. Discovery +
 * drafting only — no automated outreach.
 *
 * Depends on: DatabaseModule, ConfigModule, SerpIntelligenceModule (gated SERP
 *             provider), MentionTrackingModule (promotion target).
 *
 * @module authority.module
 */

import { Module } from '@nestjs/common';
import { SerpIntelligenceModule } from '../serp-intelligence/serp-intelligence.module';
import { MentionTrackingModule } from '../mention-tracking/mention-tracking.module';
import { AuthorityService } from './authority.service';
import { AuthorityController } from './authority.controller';

@Module({
  imports: [SerpIntelligenceModule, MentionTrackingModule],
  controllers: [AuthorityController],
  providers: [AuthorityService],
  exports: [AuthorityService],
})
export class AuthorityModule {}
