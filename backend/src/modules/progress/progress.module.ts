/**
 * Progress Module — what moved across a project's comparable AEO audits, and
 * the verified work that came before it.
 *
 * Depends on nothing but the database and its own `AeoLlmService` instance
 * (stateless; provided here rather than imported so `AeoAuditModule` can
 * import this module to trigger generation without an import cycle).
 * PrismaService is global.
 *
 * @module progress.module
 */

import { Module } from '@nestjs/common';
import { AeoLlmService } from '../aeo-audit/aeo-llm.service';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

@Module({
  controllers: [ProgressController],
  providers: [ProgressService, AeoLlmService],
  exports: [ProgressService],
})
export class ProgressModule {}
