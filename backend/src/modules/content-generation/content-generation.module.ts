/**
 * Content Generation Module — P09 (§13.7). Durable generation on top of the
 * existing GenerationJob ledger, the shared pipeline queue (JobsModule), the
 * real writer path (GrowthExecutionModule), the confirmed writing style
 * (WritingStyleModule), and the confirmed business profile (read-only,
 * BusinessProfileModule).
 *
 * @module content-generation.module
 */

import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { GrowthExecutionModule } from '../growth-execution/growth-execution.module';
import { WritingStyleModule } from '../writing-style/writing-style.module';
import { BusinessProfileModule } from '../business-profile/business-profile.module';
import { ContentGenerationService } from './content-generation.service';
import { ContentGenerationController } from './content-generation.controller';

@Module({
  imports: [JobsModule, GrowthExecutionModule, WritingStyleModule, BusinessProfileModule],
  controllers: [ContentGenerationController],
  providers: [ContentGenerationService],
  exports: [ContentGenerationService],
})
export class ContentGenerationModule {}
