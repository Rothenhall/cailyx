/**
 * Agents Module — the dashboard Agents Feed.
 *
 * Read-only aggregation over the platform's models. Depends on DatabaseModule
 * (PrismaService) only.
 *
 * @module agents.module
 */

import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';

@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
