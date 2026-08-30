/**
 * Data Asset Module — original-data-asset tracker (SOP-8, P3).
 *
 * Pure lifecycle tracking (no outbound fetches, no LLM). PrismaService comes
 * from the global DatabaseModule.
 *
 * @module data-asset.module
 */

import { Module } from '@nestjs/common';
import { DataAssetService } from './data-asset.service';
import { DataAssetController } from './data-asset.controller';

@Module({
  controllers: [DataAssetController],
  providers: [DataAssetService],
  exports: [DataAssetService],
})
export class DataAssetModule {}