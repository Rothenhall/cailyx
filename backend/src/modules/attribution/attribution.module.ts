/**
 * Attribution Module — self-reported acquisition source (GEO measurement
 * layer 4). One public capture endpoint plus the operator roll-up.
 *
 * Depends on: DatabaseModule
 *
 * @module attribution.module
 */

import { Module } from '@nestjs/common';
import { AttributionService } from './attribution.service';
import { AttributionController } from './attribution.controller';

@Module({
  controllers: [AttributionController],
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
