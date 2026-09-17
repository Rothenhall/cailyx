/**
 * Scoring Module — PRD §8 weighted visibility roll-up (Wave 2, FR-8.1–8.4) and
 * the P14 Cailyx digital-performance score family (§5.2–§5.5).
 *
 * The two families are separate on purpose and share only this module boundary:
 *  - `ScoringService` (legacy)  — five fixed dimensions, `ScoreRubric`/`ScoreRun`.
 *  - `DigitalPerformanceService` — six configurable buckets, `ScoreMethodology`/
 *    `ScoreFamilyRun`/`ScoreBucketRun`. Old reports keep the old name/methodology.
 *
 * Depends on: DatabaseModule. The digital-performance source adapter reads stable
 * Prisma models directly (see `digital-performance.sources.ts`) rather than
 * binding to other modules' service signatures, so a concurrent change to a
 * source module only ever needs reconciling in one small file.
 *
 * @module scoring.module
 */

import { Module } from '@nestjs/common';
import { MeasurementModule } from '../measurement/measurement.module';
import { DigitalPerformanceController, DigitalPerformancePortalController } from './digital-performance.controller';
import { DigitalPerformanceService } from './digital-performance.service';
import { DigitalPerformanceSources } from './digital-performance.sources';
import { ScoringService } from './scoring.service';
import { ScoringController } from './scoring.controller';

@Module({
  imports: [MeasurementModule],
  controllers: [ScoringController, DigitalPerformanceController, DigitalPerformancePortalController],
  providers: [ScoringService, DigitalPerformanceService, DigitalPerformanceSources],
  exports: [ScoringService, DigitalPerformanceService],
})
export class ScoringModule {}
