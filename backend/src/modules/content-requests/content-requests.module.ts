/**
 * Content Requests Module — the client's structured "request new content"
 * form (client-portal.md §14, §22; PLAN.md §11.4 Phase C4).
 *
 * @module content-requests.module
 */

import { Module } from '@nestjs/common';
import { GrowthExecutionModule } from '../growth-execution/growth-execution.module';
import { ContentRequestsService } from './content-requests.service';
import { ContentRequestsController } from './content-requests.controller';

@Module({
  imports: [GrowthExecutionModule],
  controllers: [ContentRequestsController],
  providers: [ContentRequestsService],
  exports: [ContentRequestsService],
})
export class ContentRequestsModule {}
