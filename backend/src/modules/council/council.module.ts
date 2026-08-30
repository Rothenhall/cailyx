/**
 * Council Module — multi-agent intervention debate (Agent #10, Swarm layer).
 *
 * Reads existing artefacts across the platform and runs a role-agent debate +
 * synthesis to rank which interventions will most improve AI visibility. Adds no
 * new measurement. Deterministic engine by default; optional cost-capped LLM
 * debate.
 *
 * Depends on: DatabaseModule (PrismaService), ConfigModule (global).
 *
 * @module council.module
 */

import { Module } from '@nestjs/common';
import { CouncilService } from './council.service';
import { CouncilController } from './council.controller';

@Module({
  controllers: [CouncilController],
  providers: [CouncilService],
  exports: [CouncilService],
})
export class CouncilModule {}
