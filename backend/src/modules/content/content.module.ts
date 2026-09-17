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
import { ApprovalsModule } from '../approvals/approvals.module';
import { AssetContentController, ContentBriefsController, GenerationJobsController } from './content.controller';
import { ContentService } from './content.service';

@Module({
  // ApprovalsModule supplies the §13.10 rule that a saved revision supersedes
  // earlier consent. It does not import this module, so there is no cycle.
  imports: [ApprovalsModule],
  controllers: [ContentBriefsController, AssetContentController, GenerationJobsController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
