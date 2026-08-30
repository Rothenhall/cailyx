/**
 * QuerySet Module — Versioned buyer prompt set builder (SOP-1, PRD FR-5).
 *
 * Builds, versions, and tags buyer prompt sets per persona and funnel stage.
 * Drafts are mutable; activation freezes a version for measurement; edits to
 * an active set fork a new version. The project owns the set and can export
 * it ("the query set is the asset").
 *
 * Depends on: DatabaseModule (PrismaService)
 *
 * @module query-set.module
 */

import { Module } from '@nestjs/common';
import { QuerySetService } from './query-set.service';
import { QuerySetController } from './query-set.controller';

@Module({
  controllers: [QuerySetController],
  providers: [QuerySetService],
  exports: [QuerySetService],
})
export class QuerySetModule {}