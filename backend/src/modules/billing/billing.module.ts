/**
 * Billing Module — offers, verified checkout, signed webhooks and entitlements.
 *
 * Contract source: design_plan.md Appendix A (G16).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * Imports:
 * - `JobsModule` — an accepted public diagnostic request is recorded as a
 *   durable `JobRun` (the "background receipt/job id" the contract asks for),
 *   so the receipt survives a restart and an operator can act on it. No worker
 *   handler exists for that task kind yet, and the run says so rather than
 *   pretending to be running.
 * - `ActivityModule` — grants, revocations and rejected deliveries are audit
 *   events (G15 names grants and rejections explicitly).
 *
 * There is no FetcherModule import: nothing in this module makes an outbound
 * request. Payments arrive over the webhook; the intake records and queues.
 *
 * @module billing.module
 */

import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { ActivityModule } from '../activity/activity.module';
import { BillingController } from './billing.controller';
import { StripeWebhookController } from './billing-webhooks.controller';
import { PublicCheckoutController, PublicIntakeController } from './billing-public.controller';
import { BillingPortalController } from './billing-portal.controller';
import { BillingService } from './billing.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { DiagnosticIntakeService } from './diagnostic-intake.service';

@Module({
  imports: [JobsModule, ActivityModule],
  controllers: [
    BillingController,
    StripeWebhookController,
    PublicCheckoutController,
    PublicIntakeController,
    BillingPortalController,
  ],
  providers: [BillingService, StripeWebhookService, DiagnosticIntakeService],
  exports: [BillingService],
})
export class BillingModule {}
