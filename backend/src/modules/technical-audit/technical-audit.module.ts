/**
 * Technical Audit Module — AI visibility access diagnostic.
 *
 * Detects AI-crawler access blockers and performance issues that prevent
 * a site from being crawled/cited by AI assistants.
 *
 * Four checks:
 *   1. robots.txt AI-bot blocks
 *   2. CDN AI-bot blocking probe (header-sniffing, inferred confidence)
 *   3. JS render dependency (Playwright headless browser)
 *   4. Core Web Vitals (Google PageSpeed Insights API)
 *
 * Depends on: FetcherModule (all HTTP/browser/API calls go through it)
 *
 * @module technical-audit.module
 */

import { Module } from '@nestjs/common';
import { TechnicalAuditService } from './technical-audit.service';
import { TechnicalAuditController } from './technical-audit.controller';
import { FetcherModule } from '../fetcher/fetcher.module';
import { SchedulingModule } from '../scheduling/scheduling.module';

@Module({
  imports: [FetcherModule, SchedulingModule],
  controllers: [TechnicalAuditController],
  providers: [TechnicalAuditService],
  exports: [TechnicalAuditService],
})
export class TechnicalAuditModule {}