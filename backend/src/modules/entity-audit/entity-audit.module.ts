/**
 * Entity Audit Module — AI entity consistency diagnostic.
 *
 * Checks how the client entity is described in structured data (JSON-LD schema)
 * and on third-party platforms. Detects inconsistencies that cause AI assistants
 * to mischaracterize or fail to recognize the entity.
 *
 * Built:
 *   - Entity CRUD (create, list, get, update, delete)
 *   - Schema checker (JSON-LD extraction + field validation + sameAs verification)
 *   - Platform record management (manual entry by delivery lead)
 *   - Platform consistency checker (name/descriptor comparison)
 *   - Model-diff (Wave 3): asks every keyed surface "What is {entity}?" via the
 *     measurement SurfaceAdapters, then runs the Claude judge for divergence.
 *     503 without API keys — see LEFT-OUT.md section 1.
 *
 * Deferred (see LEFT-OUT.md):
 *   - Platform auto-scraping (needs data source decision)
 *
 * Depends on: FetcherModule (schema fetch + sameAs verify), MeasurementModule
 * (SurfaceAdapters for model-diff), DatabaseModule (global — PrismaService)
 *
 * @module entity-audit.module
 */

import { Module } from '@nestjs/common';
import { EntityAuditService } from './entity-audit.service';
import { EntityAuditController } from './entity-audit.controller';
import { FetcherModule } from '../fetcher/fetcher.module';
import { MeasurementModule } from '../measurement/measurement.module';

@Module({
  imports: [FetcherModule, MeasurementModule],
  controllers: [EntityAuditController],
  providers: [EntityAuditService],
  exports: [EntityAuditService],
})
export class EntityAuditModule {}