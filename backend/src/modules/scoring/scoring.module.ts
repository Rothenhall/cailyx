/**
 * Scoring Module — PRD §8 weighted visibility roll-up (Wave 2, FR-8.1–8.4).
 *
 * Versioned rubrics (weights + bands), persisted score runs with
 * evidence-linked sub-scores, and honest `partial` marking when an evidence
 * source is missing. Reporting and (later) monitoring consume this as a library.
 *
 * Depends on: DatabaseModule, MeasurementModule (for shortlist-presence inputs)
 *
 * @module scoring.module
 */

import { Module } from '@nestjs/common';
import { MeasurementModule } from '../measurement/measurement.module';
import { ScoringService } from './scoring.service';
import { ScoringController } from './scoring.controller';

@Module({
  imports: [MeasurementModule],
  controllers: [ScoringController],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}