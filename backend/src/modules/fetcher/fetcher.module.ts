/**
 * Fetcher Module — The single source of all outbound network requests in Cailyx.
 *
 * Exports FetcherService which other modules inject to:
 *   - fetch URLs with custom User-Agents
 *   - probe sites for AI crawler access
 *   - render pages with headless browser
 *   - extract JSON-LD schema
 *   - verify URLs (sameAs check)
 *   - call Google PageSpeed Insights API
 *
 * @module fetcher.module
 */

import { Module } from '@nestjs/common';
import { FetcherService } from './fetcher.service';
import { HttpClientService } from './clients/http-client.service';
import { BrowserClientService } from './clients/browser-client.service';
import { CacheService } from './services/cache.service';
import { RateLimiterService } from './services/rate-limiter.service';
import { RetryService } from './services/retry.service';
import { CostTrackerService } from './services/cost-tracker.service';
import { PsiAdapter } from './adapters/psi.adapter';

@Module({
  providers: [
    FetcherService,
    HttpClientService,
    BrowserClientService,
    CacheService,
    RateLimiterService,
    RetryService,
    CostTrackerService,
    PsiAdapter,
  ],
  exports: [FetcherService],
})
export class FetcherModule {}