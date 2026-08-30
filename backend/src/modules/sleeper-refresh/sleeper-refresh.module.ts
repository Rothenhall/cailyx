/**
 * Sleeper Refresh Module — declining-pages refresh tracker (SOP-10).
 *
 * Traffic evidence via manual entry / pasted GSC CSV; the GSC OAuth pull is an
 * external prerequisite (docs/analysis/wave-4.md §3). PrismaService comes from
 * the global DatabaseModule — no outbound fetching in this module.
 *
 * @module sleeper-refresh.module
 */

import { Module } from '@nestjs/common';
import { SleeperRefreshService } from './sleeper-refresh.service';
import { SleeperRefreshController } from './sleeper-refresh.controller';

@Module({
  controllers: [SleeperRefreshController],
  providers: [SleeperRefreshService],
  exports: [SleeperRefreshService],
})
export class SleeperRefreshModule {}