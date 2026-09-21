/**
 * PaymentFailureSweepService — the grace-period half of §30's payment-failure
 * handling.
 *
 * `StripeWebhookService` marks a subscription `past-due` and stamps
 * `Subscription.pastDueSince` on the FIRST `invoice.payment_failed` /
 * `customer.subscription.past_due` event it sees for it, then does nothing
 * further — cutting access on the spot would ignore Stripe's own retry
 * schedule (Smart Retries) and the grace period this decision explicitly
 * wants (`docs/analysis/client-portal.md` §30). Something still has to check
 * the clock, though, or a subscription that never recovers stays "past-due
 * forever" with no consequence. This is that something: an in-process cron
 * (`@nestjs/schedule`, already registered globally in `app.module.ts`),
 * matching the pattern already used by `PublicationSchedulerService` and
 * `SeoAuditSchedulerService` — no Redis/BullMQ needed, the schedule lives in
 * the database (`pastDueSince`) so it survives a restart.
 *
 * Every subscription this sweep finds still `past-due` with `pastDueSince`
 * older than `BILLING_GRACE_PERIOD_DAYS` (default 21 — Stripe's own retry
 * window is the natural default per §30, not a bespoke schedule) has its
 * owning `Client` suspended via `ClientsService.suspendClient` — the SAME
 * path an admin's manual suspend uses, so Google-token revocation (§23) and
 * the audit trail (§33) both happen identically either way. This service
 * never suspends directly; it only decides *when*, and readies the "system"
 * actor label that shows up in the audit event.
 *
 * Set `BILLING_GRACE_PERIOD_SWEEP_ENABLED=false` to stand it down (a second
 * instance, or an environment where nothing should auto-suspend).
 *
 * @module payment-failure-sweep.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { BillingService } from './billing.service';
import { ClientsService } from '../clients/clients.service';

/** Env var naming the grace period, in days. */
export const GRACE_PERIOD_DAYS_ENV = 'BILLING_GRACE_PERIOD_DAYS';
/** Default grace period when the env var is unset — Stripe's own Smart Retries window, per §30. */
export const DEFAULT_GRACE_PERIOD_DAYS = 21;
/** Env var to stand the sweep down entirely. */
const SWEEP_ENABLED_ENV = 'BILLING_GRACE_PERIOD_SWEEP_ENABLED';

@Injectable()
export class PaymentFailureSweepService {
  private readonly logger = new Logger(PaymentFailureSweepService.name);

  /** In-process overlap guard — a sweep tick that is still suspending clients must not overlap the next hour's tick. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly clients: ClientsService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>(SWEEP_ENABLED_ENV, 'true') !== 'false';
  }

  get gracePeriodDays(): number {
    const raw = this.config.get<string>(GRACE_PERIOD_DAYS_ENV);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRACE_PERIOD_DAYS;
  }

  /**
   * Hourly: find every subscription past its grace period and suspend its
   * client. Idempotent — a client already `suspended` is skipped rather than
   * re-suspended (still resolves its Google connections a second time
   * harmlessly if called directly, but the sweep itself avoids the redundant
   * work and the redundant audit event).
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'billing-grace-period-sweep' })
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  /** Extracted from `tick()` so a test/smoke script can invoke exactly one sweep pass on demand. */
  async runOnce(): Promise<{ checked: number; suspended: string[] }> {
    const graceDays = this.gracePeriodDays;
    const expired = await this.billing.listPastDueBeyondGracePeriod(graceDays);
    const suspended: string[] = [];

    for (const subscription of expired) {
      const client = await this.prisma.client.findUnique({ where: { id: subscription.clientId }, select: { status: true } });
      if (!client) {
        this.logger.warn(`Grace-period sweep: subscription ${subscription.id} names client ${subscription.clientId}, which no longer exists.`);
        continue;
      }
      if (client.status === 'suspended') continue; // already suspended — nothing to do

      try {
        await this.clients.suspendClient(
          subscription.clientId,
          { type: 'scheduler', id: null, label: 'billing-grace-period-sweep' },
          `Payment grace period (${graceDays}d) elapsed — subscription ${subscription.id} has been past-due since ${subscription.pastDueSince}.`,
        );
        suspended.push(subscription.clientId);
        this.logger.log(`Grace-period sweep: suspended client ${subscription.clientId} (subscription ${subscription.id}, past-due since ${subscription.pastDueSince})`);
      } catch (err) {
        this.logger.error(`Grace-period sweep: failed to suspend client ${subscription.clientId}: ${(err as Error).message}`);
      }
    }

    return { checked: expired.length, suspended };
  }
}
