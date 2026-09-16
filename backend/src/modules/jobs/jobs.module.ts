/**
 * Jobs Module — the durable job ledger (G07) plus the shared BullMQ queue that
 * runs the audit pipelines (technical audit, SEO audit, presence discovery,
 * AEO audit) in the background instead of inline on the HTTP request.
 *
 * Two things live here and they are deliberately separate:
 *
 * - `PipelineQueueService` — transport. It runs a handler and forgets it.
 * - `JobsService` / `CadenceService` / `OnboardingService` — the ledger. What
 *   ran, what it cost, what it produced, what is scheduled and what is left.
 *
 * The queue does not depend on the ledger: `JobsService` registers itself as
 * the queue's `JobRunTracker` on init, so a job that carries a `jobRunId` is
 * tracked and a job that does not is unaffected.
 *
 * PrismaService is global (DatabaseModule); ScopeValidationService is global
 * (ScopeValidationModule, activated in AuthModule) — neither is imported here.
 *
 * @module jobs.module
 */

import { Module } from '@nestjs/common';
import { PipelineQueueService } from './pipeline-queue.service';
import { JobsService } from './jobs.service';
import { CadenceService } from './cadence.service';
import { OnboardingService } from './onboarding.service';
import { CadencesController, JobsController, OnboardingController } from './jobs.controller';

@Module({
  controllers: [JobsController, OnboardingController, CadencesController],
  providers: [PipelineQueueService, JobsService, CadenceService, OnboardingService],
  exports: [PipelineQueueService, JobsService, CadenceService, OnboardingService],
})
export class JobsModule {}
