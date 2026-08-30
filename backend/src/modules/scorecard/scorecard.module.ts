/**
 * Scorecard module — Rung 0 free diagnostic. Orchestrates the existing
 * technical-audit and scoring engines; adds only the ScorecardRun persistence
 * and the public launch flag (docs/analysis/wave-5.md §2, option B).
 *
 * @module scorecard.module
 */

import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { TechnicalAuditModule } from '../technical-audit/technical-audit.module';
import { ScorecardController } from './scorecard.controller';
import { ScorecardService } from './scorecard.service';

@Module({
  imports: [TechnicalAuditModule, ScoringModule],
  controllers: [ScorecardController],
  providers: [ScorecardService],
  exports: [ScorecardService],
})
export class ScorecardModule {}