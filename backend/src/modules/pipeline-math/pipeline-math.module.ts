/**
 * Pipeline Math module — standalone qualification arithmetic (GTM Playbook).
 * No external dependencies: pure Prisma + arithmetic.
 *
 * @module pipeline-math.module
 */

import { Module } from '@nestjs/common';
import { PipelineMathController } from './pipeline-math.controller';
import { PipelineMathService } from './pipeline-math.service';

// PrismaModule is @Global — modules do not import DatabaseModule.
@Module({
  controllers: [PipelineMathController],
  providers: [PipelineMathService],
  exports: [PipelineMathService],
})
export class PipelineMathModule {}