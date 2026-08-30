/**
 * Internal-Link Module — topical-architecture analysis (Agent #8, Swarm layer).
 *
 * Crawls the client's own site through FetcherService, builds the internal link
 * graph, and derives "add link A → B" recommendations. Client-site analysis
 * only. An offline `fixture://` source (gated by INTERNAL_LINK_ALLOW_FIXTURE)
 * exists purely for the smoke harness.
 *
 * Depends on: DatabaseModule (PrismaService), ConfigModule (global),
 *             FetcherModule (FetcherService).
 *
 * @module internal-link.module
 */

import { Module } from '@nestjs/common';
import { FetcherModule } from '../fetcher/fetcher.module';
import { InternalLinkService } from './internal-link.service';
import { InternalLinkController } from './internal-link.controller';

@Module({
  imports: [FetcherModule],
  controllers: [InternalLinkController],
  providers: [InternalLinkService],
  exports: [InternalLinkService],
})
export class InternalLinkModule {}
