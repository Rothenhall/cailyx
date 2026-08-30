/**
 * Journey Module — branching multi-step search journeys (Agent #2, Swarm layer).
 *
 * Plans realistic buyer journeys from personas and executes them against AI
 * surface adapters (reused from MeasurementModule). Default surface is the
 * deterministic `mock`; a live surface needs SWARM_ALLOW_LIVE=1 + its key.
 * Campaigns fan out planning + execution over many personas under one budget.
 *
 * Depends on: DatabaseModule (PrismaService), ConfigModule (global),
 *             MeasurementModule (surface adapters).
 *
 * @module journey.module
 */

import { Module } from '@nestjs/common';
import { MeasurementModule } from '../measurement/measurement.module';
import { JourneyService } from './journey.service';
import { JourneyController } from './journey.controller';

@Module({
  imports: [MeasurementModule],
  controllers: [JourneyController],
  providers: [JourneyService],
  exports: [JourneyService],
})
export class JourneyModule {}
