/**
 * Keyword Research Module — search volume, competition/CPC, and
 * related/long-tail expansion for seed keywords via DataForSEO Keywords Data
 * (wave-6, D5/step 4). Same vendor account as `serp-intelligence`.
 *
 * Depends on: FetcherModule (all outbound HTTP)
 *
 * @module keyword-research.module
 */

import { Module } from '@nestjs/common';
import { KeywordResearchService } from './keyword-research.service';
import { KeywordResearchController } from './keyword-research.controller';
import { FetcherModule } from '../fetcher/fetcher.module';

@Module({
  imports: [FetcherModule],
  controllers: [KeywordResearchController],
  providers: [KeywordResearchService],
  exports: [KeywordResearchService],
})
export class KeywordResearchModule {}
