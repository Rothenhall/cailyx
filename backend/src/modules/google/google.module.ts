/**
 * Google Module — Search Console + Analytics via 3-legged OAuth.
 *
 * Inert until `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` are set:
 * `authorize` / `callback` return a clean 503, `GET /connections` reports
 * everything not-connected. Drop the credentials in, add the redirect URI to
 * the OAuth client, restart — nothing else changes.
 *
 * Depends on DatabaseModule (Prisma) and the global ConfigModule.
 *
 * @module google/google.module
 */

import { Module } from '@nestjs/common';
import { GoogleController } from './google.controller';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleConnectionService } from './google-connection.service';
import { SearchConsoleService } from './search-console.service';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [GoogleController],
  providers: [GoogleOAuthService, GoogleConnectionService, SearchConsoleService, AnalyticsService],
  exports: [GoogleConnectionService, SearchConsoleService, AnalyticsService],
})
export class GoogleModule {}
