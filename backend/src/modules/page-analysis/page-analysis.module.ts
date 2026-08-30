/**
 * Page Analysis Module — SOP-6 copy-structure analysis (FR-3.3).
 *
 * PrismaService comes from the global DatabaseModule; all outbound fetching
 * goes through the FetcherModule (cache/rate-limit/retry shared).
 *
 * @module page-analysis.module
 */

import { Module } from '@nestjs/common';
import { FetcherModule } from '../fetcher/fetcher.module';
import { PageAnalysisService } from './page-analysis.service';
import { PageAnalysisController } from './page-analysis.controller';

@Module({
  imports: [FetcherModule],
  controllers: [PageAnalysisController],
  providers: [PageAnalysisService],
  exports: [PageAnalysisService],
})
export class PageAnalysisModule {}