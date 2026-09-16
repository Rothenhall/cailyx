/**
 * Client Portal Module — client-facing surface. Imports ReportingModule (to
 * reuse `getBySlug` after this module's own ownership check) and AuthModule
 * (for `getPortalMe`) — every other read goes straight through Prisma, same
 * convention `gap-analysis` and `clients` follow.
 *
 * @module client-portal.module
 */

import { Module } from '@nestjs/common';
import { ReportingModule } from '../reporting/reporting.module';
import { AuthModule } from '../auth/auth.module';
import { ClientPortalService } from './client-portal.service';
import { ClientPortalController } from './client-portal.controller';

@Module({
  // AuthModule supplies `AuthService.getPortalMe`, which existed but had no
  // route exposing it — so `GET /api/portal/me` 404'd and the web client shell
  // resolved every client session as anonymous.
  imports: [ReportingModule, AuthModule],
  controllers: [ClientPortalController],
  providers: [ClientPortalService],
  exports: [ClientPortalService],
})
export class ClientPortalModule {}
