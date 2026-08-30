/**
 * Projects Module — Backbone entity management (PLAN Phase 0).
 *
 * Project CRUD, engagement lifecycle (scorecard → diagnostic → sprint → retainer),
 * cross-module artifact stats. Every other Cailyx module references a Project.
 *
 * Depends on: DatabaseModule (PrismaService)
 *
 * @module projects.module
 */

import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}