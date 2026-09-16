/**
 * Content Module — editable briefs, versioned content revisions and generation jobs.
 *
 * Contract source: design_plan.md Appendix A (G09).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * @module content.module
 */

import { Module } from '@nestjs/common';
import { AssetContentController, ContentBriefsController, GenerationJobsController } from './content.controller';
import { ContentService } from './content.service';

@Module({
  controllers: [ContentBriefsController, AssetContentController, GenerationJobsController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
