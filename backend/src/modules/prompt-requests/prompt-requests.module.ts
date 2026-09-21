/**
 * Prompt Requests Module — the lightweight prompt add/delete request queue
 * (client-portal.md §13, §20; PLAN.md §11.4 Phase C4).
 *
 * @module prompt-requests.module
 */

import { Module } from '@nestjs/common';
import { PromptRequestsService } from './prompt-requests.service';
import { PromptRequestsController } from './prompt-requests.controller';

@Module({
  controllers: [PromptRequestsController],
  providers: [PromptRequestsService],
  exports: [PromptRequestsService],
})
export class PromptRequestsModule {}
