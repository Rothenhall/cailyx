/**
 * Publishing Module — CMS/channel destinations, publications and remote verification.
 *
 * Contract source: design_plan.md Appendix A (G11).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; ScopeValidationService
 * is global via ScopeValidationModule (activated in AuthModule) — neither is
 * imported here.
 *
 * Imports:
 * - `ApprovalsModule` — the publish gate (`assertReadyToPublish`) and the
 *   verification evidence record (`recordCheckResult`). G10 owns both; this
 *   module calls them rather than keeping its own copy of either rule.
 * - `FetcherModule` — the single approved outbound-HTTP path, used by the
 *   `custom-webhook` adapter for its test/push/verify calls. No other HTTP
 *   client is used anywhere in this module.
 * - `ActivityModule` — destination and publication lifecycle events (G15 names
 *   external sends and publications explicitly).
 *
 * `ScheduleModule.forRoot()` is already registered in `app.module.ts`, so the
 * dispatch cron needs no import here.
 *
 * @module publishing.module
 */

import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ActivityModule } from '../activity/activity.module';
import { FetcherModule } from '../fetcher/fetcher.module';
import {
  PublishDestinationsController,
  PublicationsController,
  PublishingProvidersController,
} from './publishing.controller';
import { PublishingService } from './publishing.service';
import { PublicationSchedulerService } from './publication-scheduler.service';
import { CustomWebhookAdapter } from './lib/custom-webhook.adapter';

@Module({
  imports: [ApprovalsModule, ActivityModule, FetcherModule],
  controllers: [PublishingProvidersController, PublishDestinationsController, PublicationsController],
  providers: [PublishingService, PublicationSchedulerService, CustomWebhookAdapter],
  exports: [PublishingService],
})
export class PublishingModule {}
