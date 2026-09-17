/**
 * Writing Style Module — P09 (§13.8).
 *
 * @module writing-style.module
 */

import { Module } from '@nestjs/common';
import { WritingStyleService } from './writing-style.service';
import { WritingStyleController } from './writing-style.controller';

@Module({
  controllers: [WritingStyleController],
  providers: [WritingStyleService],
  exports: [WritingStyleService],
})
export class WritingStyleModule {}
