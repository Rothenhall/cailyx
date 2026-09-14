/**
 * Backlinks Module — DataForSEO Backlinks API (backlinks-overview).
 *
 * Depends on: FetcherModule (all outbound HTTP)
 *
 * @module backlinks.module
 */

import { Module } from '@nestjs/common';
import { FetcherModule } from '../fetcher/fetcher.module';
import { BacklinksService } from './backlinks.service';
import { BacklinksController } from './backlinks.controller';

@Module({
  imports: [FetcherModule],
  controllers: [BacklinksController],
  providers: [BacklinksService],
  exports: [BacklinksService],
})
export class BacklinksModule {}
