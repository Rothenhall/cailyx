/**
 * Website Module (P12) — unified website health/Google/visitors screen.
 *
 * Depends on DatabaseModule (Prisma) and GoogleModule (Search Console +
 * Analytics extension calls, connection state). Reads TechnicalAudit and
 * PageAnalysis rows directly via Prisma rather than importing those modules'
 * services — this module never triggers a crawl or an analysis run itself.
 *
 * @module website/website.module
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GoogleModule } from '../google/google.module';
import { WebsiteController } from './website.controller';
import { WebsiteService } from './website.service';
import { WebsiteInsightsService } from './website-insights.service';

@Module({
  imports: [DatabaseModule, GoogleModule],
  controllers: [WebsiteController],
  providers: [WebsiteService, WebsiteInsightsService],
  exports: [WebsiteService, WebsiteInsightsService],
})
export class WebsiteModule {}
