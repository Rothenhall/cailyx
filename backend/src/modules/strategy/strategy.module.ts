/**
 * Strategy Module — stage 9, "Strategy & Recommendations".
 *
 * Depends on `GapAnalysisModule` (stage 8) for its already-consolidated,
 * categorised, impact/effort-scored gaps — this module only sequences and
 * frames them into an action plan, it never reads another audit module directly.
 *
 * @module strategy.module
 */

import { Module } from '@nestjs/common';
import { GapAnalysisModule } from '../gap-analysis/gap-analysis.module';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';

@Module({
  imports: [GapAnalysisModule],
  controllers: [StrategyController],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
