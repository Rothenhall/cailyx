/**
 * Client Portal Module — client-facing surface. Imports ReportingModule only
 * (to reuse `getBySlug` after this module's own ownership check) — every
 * other read goes straight through Prisma, same convention `gap-analysis`
 * and `clients` follow.
 *
 * @module client-portal.module
 */

import { Module } from '@nestjs/common';
import { ReportingModule } from '../reporting/reporting.module';
import { ClientPortalService } from './client-portal.service';
import { ClientPortalController } from './client-portal.controller';

@Module({
  imports: [ReportingModule],
  controllers: [ClientPortalController],
  providers: [ClientPortalService],
  exports: [ClientPortalService],
})
export class ClientPortalModule {}
