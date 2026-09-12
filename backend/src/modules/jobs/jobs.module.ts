/**
 * Jobs Module — provides PipelineQueueService, the shared BullMQ queue that
 * runs the audit pipelines (technical audit, SEO audit, presence discovery,
 * AEO audit) in the background instead of inline on the HTTP request.
 *
 * @module jobs.module
 */

import { Module } from '@nestjs/common';
import { PipelineQueueService } from './pipeline-queue.service';

@Module({
  providers: [PipelineQueueService],
  exports: [PipelineQueueService],
})
export class JobsModule {}
