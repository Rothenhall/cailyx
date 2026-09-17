/**
 * AEO Audit Module — answer-engine visibility, ChatGPT first.
 *
 * Orchestrates existing modules rather than duplicating them:
 * - `FetcherModule` for the site crawl (UA rotation, rate limits, Playwright render)
 * - `DatabaseModule` for `SiteContext` / `AeoAudit` / `AeoStance` and the reused
 *   `QuerySet` tables
 * - `MeasurementModule` for execution — n>=5 enforcement, the `SurfaceAdapter`
 *   registry (including the gated `chatgpt-browser` surface) and deterministic
 *   mention/citation extraction
 *
 * Its three analysis passes (context synthesis, matrix phrasing, stance judging)
 * all run through `AeoLlmService`, which prefers OpenRouter with a small cheap
 * model and falls back to Anthropic.
 *
 * Analysis + approved decisions: `docs/analysis/aeo-audit.md`.
 *
 * @module aeo-audit.module
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FetcherModule } from '../fetcher/fetcher.module';
import { MeasurementModule } from '../measurement/measurement.module';
import { JobsModule } from '../jobs/jobs.module';
import { BusinessProfileModule } from '../business-profile/business-profile.module';
import { AeoAuditController } from './aeo-audit.controller';
import { AeoAuditService } from './aeo-audit.service';
import { AeoContextService } from './aeo-context.service';
import { AeoLlmService } from './aeo-llm.service';
import { AeoMatrixService } from './aeo-matrix.service';
import { AeoStanceService } from './aeo-stance.service';
import { AeoVisibilityService } from './aeo-visibility.service';

@Module({
  imports: [DatabaseModule, FetcherModule, MeasurementModule, JobsModule, BusinessProfileModule],
  controllers: [AeoAuditController],
  providers: [AeoAuditService, AeoContextService, AeoMatrixService, AeoStanceService, AeoLlmService, AeoVisibilityService],
  exports: [AeoAuditService, AeoContextService, AeoMatrixService, AeoStanceService, AeoLlmService, AeoVisibilityService],
})
export class AeoAuditModule {}
