/**
 * ClientAccess Module — client seats, invitations and delegated Google connections.
 *
 * Contract source: design_plan.md Appendix A (G02).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * @module client-access.module
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GoogleModule } from '../google/google.module';
import {
  ClientInvitesController,
  ClientMembersController,
  ClientPortalGoogleController,
  ClientPortalInvitesController,
  ClientPortalMembersController,
  InviteAcceptanceController,
} from './client-access.controller';
import { ClientAccessService } from './client-access.service';
import { GoogleDelegationService } from './google-delegation.service';

@Module({
  imports: [
    // Registered empty, matching AuthModule: signing config is read per-call
    // from ConfigService, so there is no secret to share through the module.
    JwtModule.register({}),
    // Supplies SearchConsoleService / AnalyticsService / GoogleConnectionService
    // to GoogleDelegationService. Delegated reads are proxied through the
    // connection OWNER's grant — never the grantee's own tokens.
    GoogleModule,
  ],
  controllers: [
    ClientMembersController,
    ClientInvitesController,
    InviteAcceptanceController,
    ClientPortalMembersController,
    ClientPortalInvitesController,
    ClientPortalGoogleController,
  ],
  providers: [ClientAccessService, GoogleDelegationService],
  exports: [ClientAccessService, GoogleDelegationService],
})
export class ClientAccessModule {}
