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
import { ContentWorkspaceModule } from '../content-workspace/content-workspace.module';
import { WritingStyleModule } from '../writing-style/writing-style.module';
import { QuerySetModule } from '../query-set/query-set.module';
import { PromptRequestsModule } from '../prompt-requests/prompt-requests.module';
import { ContentRequestsModule } from '../content-requests/content-requests.module';
import { ClientPortalService } from './client-portal.service';
import { ClientPortalController } from './client-portal.controller';

@Module({
  // AuthModule supplies `AuthService.getPortalMe`, which existed but had no
  // route exposing it — so `GET /api/portal/me` 404'd and the web client shell
  // resolved every client session as anonymous. ContentWorkspaceModule (P08)
  // supplies the client-safe shared-revision read for `GET .../content*`.
  // WritingStyleModule (P09) supplies the read-only active-style route.
  // QuerySetModule (C4) supplies the read-only active-prompt list (§13).
  // PromptRequestsModule/ContentRequestsModule (C4) supply the two request
  // mechanisms (§13/§20, §14/§22).
  imports: [
    ReportingModule,
    AuthModule,
    ContentWorkspaceModule,
    WritingStyleModule,
    QuerySetModule,
    PromptRequestsModule,
    ContentRequestsModule,
  ],
  controllers: [ClientPortalController],
  providers: [ClientPortalService],
  exports: [ClientPortalService],
})
export class ClientPortalModule {}
