/**
 * Intake Module — Subject onboarding + auto-enrichment (PRD §6.1, PLAN Phase 1).
 *
 * Subject accepted via public form / operator console / bulk CSV / API.
 * Minimum input is a domain. Auto-enriches: category, description, country,
 * named competitors, own entities from homepage + schema.
 *
 * Depends on: FetcherModule, ProjectsModule, DatabaseModule
 *
 * @module intake.module
 */

import { Module } from '@nestjs/common';
import { IntakeService } from './intake.service';
import { IntakeController } from './intake.controller';
import { FetcherModule } from '../fetcher/fetcher.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [FetcherModule, ProjectsModule],
  controllers: [IntakeController],
  providers: [IntakeService],
  exports: [IntakeService],
})
export class IntakeModule {}