/**
 * Growth Execution Module — stage 11, "Marketing & Growth Execution".
 *
 * The flowchart's last unbuilt stage before Final Output: turns stage 10's
 * priority keywords into topic/ad-angle suggestions, and stage 8's open
 * gaps into recommended-asset briefs across the nine asset types.
 *
 * Depends on `GapAnalysisModule` (stage 8, read-only) and
 * `KeywordResearchModule` (stage 10, read-only via its pure `priority()`
 * compute) — never triggers a re-sync or a fresh vendor call.
 *
 * @module growth-execution.module
 */

import { Module } from '@nestjs/common';
import { GapAnalysisModule } from '../gap-analysis/gap-analysis.module';
import { KeywordResearchModule } from '../keyword-research/keyword-research.module';
import { GrowthExecutionService } from './growth-execution.service';
import { GrowthExecutionController } from './growth-execution.controller';

@Module({
  imports: [GapAnalysisModule, KeywordResearchModule],
  controllers: [GrowthExecutionController],
  providers: [GrowthExecutionService],
  exports: [GrowthExecutionService],
})
export class GrowthExecutionModule {}
