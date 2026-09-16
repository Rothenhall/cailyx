/**
 * StripeWebhookService — the signed provider webhook, and the only place a
 * payment becomes an entitlement.
 *
 * The order of operations is the whole design, so it is stated once here and
 * followed literally below:
 *
 * ```
 *  1. secret configured?          no  -> 503, nothing stored, nothing trusted
 *  2. verify HMAC + timestamp     bad -> store status "rejected", 400, never acted on
 *  3. providerEventId seen before?     -> idempotent 200, no re-grant, no re-charge
 *  4. act on the event            -> status "processed" | "ignored"
 * ```
 *
 * Four properties this buys, mapped to the acceptance test in design_plan
 * §11.2 case 16 ("checkout-return visit or replayed unsigned event cannot grant
 * an entitlement"):
 *
 * - **Unsigned / mismatched / stale** → `signatureValid: false`, `status:
 *   "rejected"`. Nothing downstream reads a rejected event (and
 *   `BillingService.grantEntitlements` refuses one even if something tried).
 * - **Replay** → step 3. `PaymentEvent.providerEventId` is unique; a second
 *   delivery of the same event returns 200 without granting again.
 * - **A forged event cannot poison the replay guard.** This is the subtle one.
 *   A rejected event is stored (the ledger should show the attempt), which
 *   means an attacker who guesses a *real* event id could otherwise occupy the
 *   unique key and block the genuine delivery forever. So a later event with a
 *   valid signature **supersedes** a rejected row for the same id instead of
 *   being treated as a duplicate: only rows that were actually processed are
 *   duplicates.
 * - **Nothing is granted from the payload's own claims.** The offer — and with
 *   it the price and the entitlement keys — comes from the `Offer` table; the
 *   payload only says *which* offer it means.
 *
 * @module stripe-webhook.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { BillingService, WEBHOOK_SECRET_ENV, WEBHOOK_TOLERANCE_ENV } from './billing.service';
import { verifyStripeSignature } from './lib/stripe-signature.util';
import { extractProviderEventFacts, unixSecondsToDate, type ProviderEventFacts } from './lib/provider-event.util';

/** What a delivery produced. The controller turns this into an HTTP response. */
export interface WebhookOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** The final state of one delivery's processing. */
interface ProcessResult {
  status: 'processed' | 'ignored';
  clientId: string | null;
  subscriptionId: string | null;
  amountCents: number | null;
  currency: string | null;
  /** Why nothing was granted, when nothing was. Shown in the ledger. */
  note: string | null;
}

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  /**
   * Which bytes the **last** delivery's signature was computed over.
   *
   * Observed rather than configured: `rawBody` capture is an application-level
   * setting this module cannot read, so it reports what it actually saw on the
   * last request instead of asserting something about main.ts. Null until a
   * delivery arrives.
   */
  private observedBodyIntegrity: 'raw' | 'reserialized' | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly billing: BillingService,
    private readonly activity: ActivityService,
  ) {}

  /** See {@link observedBodyIntegrity}. */
  get lastBodyIntegrity(): 'raw' | 'reserialized' | null {
    return this.observedBodyIntegrity;
  }

  private get secret(): string | undefined {
    return this.config.get<string>(WEBHOOK_SECRET_ENV) || undefined;
  }

  private get toleranceSeconds(): number | undefined {
    const raw = this.config.get<string>(WEBHOOK_TOLERANCE_ENV);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  /**
   * Handle one delivery.
   *
   * @param input.rawBody the exact request bytes when the app captured them.
   * @param input.parsedBody the parsed JSON body, used only to read the event
   *   id for the ledger — never as the authority for anything.
   * @param input.signatureHeader the verbatim `Stripe-Signature` header.
   */
  async handle(input: {
    rawBody: Buffer | null;
    parsedBody: unknown;
    signatureHeader: string | undefined;
  }): Promise<WebhookOutcome> {
    const secret = this.secret;
    if (!secret) {
      // Nothing is stored: without a secret an event id is unverified input,
      // and writing an attacker-chosen id into a unique column would let a
      // forgery occupy the replay guard's key.
      this.logger.warn(`${WEBHOOK_SECRET_ENV} is not set — refusing webhook delivery without reading it.`);
      return {
        httpStatus: 503,
        body: {
          received: false,
          error: 'webhook-unconfigured',
          message: `${WEBHOOK_SECRET_ENV} is not set on this server, so no delivery can be verified. Nothing was stored and nothing was granted.`,
        },
      };
    }

    const parsed = this.asObject(input.parsedBody);
    const bodyBytes = input.rawBody ?? Buffer.from(JSON.stringify(parsed ?? {}), 'utf8');
    const bodyIntegrity: 'raw' | 'reserialized' = input.rawBody ? 'raw' : 'reserialized';
    this.observedBodyIntegrity = bodyIntegrity;

    const verdict = verifyStripeSignature({
      header: input.signatureHeader,
      rawBody: bodyBytes,
      secret,
      toleranceSeconds: this.toleranceSeconds,
    });

    if (!verdict.valid) {
      const stored = await this.storeRejected(bodyBytes, parsed, verdict.reason);
      return {
        httpStatus: 400,
        body: {
          received: false,
          error: 'invalid-signature',
          reason: verdict.reason,
          /** The ledger row that records the attempt. No payload detail is echoed back. */
          paymentEventId: stored.id,
          message:
            'The signature did not verify. The delivery was recorded as rejected and will never be acted on.',
        },
      };
    }

    const facts = extractProviderEventFacts(parsed);
    if (!facts.eventId) {
      const stored = await this.storeRejected(bodyBytes, parsed, 'verified event carries no id — cannot de-duplicate');
      return {
        httpStatus: 400,
        body: {
          received: false,
          error: 'missing-event-id',
          paymentEventId: stored.id,
          message: 'A verified event without an id cannot be de-duplicated, so it was recorded and not acted on.',
        },
      };
    }

    // ── Step 3: replay guard ───────────────────────────────────────────
    const existing = await this.prisma.paymentEvent.findUnique({
      where: { providerEventId: facts.eventId },
    });

    if (existing && (existing.status === 'processed' || existing.status === 'ignored')) {
      // The genuine duplicate: already decided. Say so and change nothing.
      return {
        httpStatus: 200,
        body: {
          received: true,
          duplicate: true,
          status: existing.status,
          eventType: existing.eventType,
          message: 'This event was already handled. Nothing was granted a second time.',
        },
      };
    }

    const bodySha = createHash('sha256').update(bodyBytes).digest('hex');
    const claim = await this.claimEvent({
      facts,
      existingId: existing?.id ?? null,
      bodySha,
      payload: parsed ?? {},
      supersededRejected: existing?.status === 'rejected',
    });

    // ── Step 4: act ────────────────────────────────────────────────────
    let result: ProcessResult;
    try {
      result = await this.process(claim.id, facts, parsed);
    } catch (err) {
      // Left in "pending": a visible in-flight row rather than a silent loss.
      // The provider retries a 500, and the retry re-claims this same row.
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Webhook ${facts.eventId} (${facts.eventType}) failed while processing: ${message}`);
      await this.prisma.paymentEvent.update({
        where: { id: claim.id },
        data: { error: `processing failed: ${message}`, status: 'pending' },
      });
      return {
        httpStatus: 500,
        body: {
          received: false,
          error: 'processing-failed',
          paymentEventId: claim.id,
          message: 'The event verified but could not be processed. It is recorded as pending; a retry will resume it.',
        },
      };
    }

    const updated = await this.prisma.paymentEvent.update({
      where: { id: claim.id },
      data: {
        status: result.status,
        clientId: result.clientId,
        subscriptionId: result.subscriptionId,
        amountCents: result.amountCents,
        currency: result.currency,
        error: result.note,
        processedAt: new Date(),
      },
    });

    const granted = await this.prisma.entitlement.count({ where: { grantedByEventId: updated.id } });

    return {
      httpStatus: 200,
      body: {
        received: true,
        duplicate: false,
        status: updated.status,
        eventType: updated.eventType,
        /** How many entitlement keys this event is now the authority for. */
        entitlementsGranted: granted,
        note: result.note,
        bodyIntegrity,
        paymentEventId: updated.id,
      },
    };
  }

  /**
   * Record a delivery that could not be trusted.
   *
   * The row's `providerEventId` is the claimed id when the body carried one —
   * so that a *later genuine* delivery can supersede it — and otherwise a
   * deterministic digest of the body, which keeps a flood of junk from
   * growing the table without bound.
   */
  private async storeRejected(
    bodyBytes: Buffer,
    parsed: Record<string, unknown> | null,
    reason: string,
  ): Promise<{ id: string }> {
    const claimedId = typeof parsed?.id === 'string' && parsed.id.trim() !== '' ? parsed.id.trim() : null;
    const providerEventId =
      claimedId ?? `unverified:${createHash('sha256').update(bodyBytes).digest('hex').slice(0, 40)}`;
    const eventType = typeof parsed?.type === 'string' && parsed.type.trim() !== '' ? parsed.type.trim() : 'unknown';

    const row = await this.prisma.paymentEvent.upsert({
      where: { providerEventId },
      create: {
        providerEventId,
        provider: 'stripe',
        eventType,
        signatureValid: false,
        status: 'rejected',
        payload: JSON.stringify(parsed ?? {}),
        error: `signature rejected: ${reason}`,
      },
      // An already-rejected row is not rewritten into a fresh one: a repeated
      // forgery should not keep churning the ledger.
      update: {},
    });

    await this.activity.record({
      actor: { type: 'webhook', id: 'stripe' },
      action: 'rejected',
      resource: { type: 'payment-event', id: row.id, version: eventType },
      summary: `Rejected a webhook delivery (${reason})`,
      changes: { reason, claimedEventId: claimedId },
      origin: 'webhook',
      result: 'failure',
    });

    return { id: row.id };
  }

  /**
   * Claim the ledger row for a verified event, moving it to `pending`.
   *
   * A row that exists in `rejected` state is **superseded**, not skipped: it
   * was written by something that failed verification, and this delivery has
   * not. A row already in `pending` (a previous attempt that crashed) is
   * re-claimed so the provider's retry resumes it.
   */
  private async claimEvent(input: {
    facts: ProviderEventFacts;
    existingId: string | null;
    bodySha: string;
    payload: Record<string, unknown>;
    supersededRejected: boolean;
  }): Promise<{ id: string }> {
    // The real payload is stored here, at claim time, so a crash during
    // processing leaves a `pending` row that still carries the event rather
    // than a summary of it.
    const storedPayload = JSON.stringify({ ...input.payload, bodySha256: input.bodySha });

    if (input.existingId) {
      const row = await this.prisma.paymentEvent.update({
        where: { id: input.existingId },
        data: {
          signatureValid: true,
          status: 'pending',
          eventType: input.facts.eventType ?? 'unknown',
          payload: storedPayload,
          error: null,
        },
      });
      if (input.supersededRejected) {
        this.logger.warn(
          `Verified event ${input.facts.eventId} supersedes an earlier rejected delivery with the same id.`,
        );
      }
      return { id: row.id };
    }

    const created = await this.prisma.paymentEvent.create({
      data: {
        providerEventId: input.facts.eventId as string,
        provider: 'stripe',
        eventType: input.facts.eventType ?? 'unknown',
        signatureValid: true,
        status: 'pending',
        payload: storedPayload,
      },
    });
    return { id: created.id };
  }

  // ── Event handling ──────────────────────────────────────────────────

  /**
   * Act on a verified event. Every branch either grants from the `Offer` table
   * or returns `ignored` with the reason — there is no branch that grants from
   * something the payload asserted about itself.
   */
  private async process(
    eventRowId: string,
    facts: ProviderEventFacts,
    parsed: Record<string, unknown> | null,
  ): Promise<ProcessResult> {
    const payload = parsed ?? {};

    const base: Omit<ProcessResult, 'status' | 'note'> = {
      clientId: null,
      subscriptionId: null,
      amountCents: facts.amountPaidCents,
      currency: facts.currency,
    };

    switch (facts.eventType) {
      case 'checkout.session.completed':
        return this.onCheckoutCompleted(eventRowId, facts, base);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return this.onSubscriptionUpserted(facts, base);
      case 'customer.subscription.deleted':
        return this.onSubscriptionDeleted(facts, base);
      case 'invoice.payment_succeeded':
      case 'invoice.paid':
        return this.onInvoicePaid(facts, base);
      case 'invoice.payment_failed':
        return this.onInvoiceFailed(facts, base);
      case 'charge.refunded':
        return {
          status: 'processed',
          ...base,
          note:
            'Refund recorded. Entitlements are NOT revoked automatically — a partial refund is not a cancellation. Use the admin revoke action to end access.',
        };
      default:
        return {
          status: 'ignored',
          ...base,
          note: `No handler for event type "${facts.eventType}" — recorded for the ledger, no state changed.`,
        };
    }
  }

  /**
   * The purchase event. This is the only path that creates an entitlement.
   */
  private async onCheckoutCompleted(
    eventRowId: string,
    facts: ProviderEventFacts,
    base: Omit<ProcessResult, 'status' | 'note'>,
  ): Promise<ProcessResult> {
    if (facts.paymentStatus && !['paid', 'no_payment_required'].includes(facts.paymentStatus)) {
      return {
        status: 'ignored',
        ...base,
        note: `Checkout completed with payment_status "${facts.paymentStatus}" — nothing is granted until the provider reports it paid.`,
      };
    }

    const clientId = await this.resolveClientId(facts);
    if (!clientId) {
      return {
        status: 'ignored',
        ...base,
        note: 'No Client could be resolved from the event (client_reference_id / metadata.clientId) — nothing was granted, because a subscription must belong to a real client.',
      };
    }

    const resolution = await this.billing.resolveOfferForFacts(facts);
    if (!resolution.offer) {
      return { status: 'ignored', ...base, clientId, note: resolution.reason };
    }

    const amount = this.billing.evaluateAmount(facts, resolution.offer);
    if (!amount.acceptable) {
      return { status: 'ignored', ...base, clientId, note: amount.reason };
    }

    let subscriptionId: string | null = null;
    if (facts.subscriptionId) {
      const subscription = await this.billing.upsertSubscriptionFromProvider({
        providerId: facts.subscriptionId,
        clientId,
        offerId: resolution.offer.id,
        customerId: facts.customerId,
        status: this.subscriptionStatus(facts.subscriptionStatus) ?? 'active',
        currentPeriodStart: unixSecondsToDate(facts.currentPeriodStart),
        currentPeriodEnd: unixSecondsToDate(facts.currentPeriodEnd),
        cancelAt: unixSecondsToDate(facts.cancelAt),
        canceledAt: unixSecondsToDate(facts.canceledAt),
      });
      subscriptionId = subscription.id;
    }

    const keys = this.billing.entitlementKeysOf(resolution.offer);
    if (keys.length === 0) {
      return {
        status: 'ignored',
        ...base,
        clientId,
        subscriptionId,
        note: `Offer "${resolution.offer.code}" grants no entitlement keys — nothing to grant.`,
      };
    }

    await this.billing.grantEntitlements({
      clientId,
      keys,
      event: { id: eventRowId, signatureValid: true },
      subscriptionId,
      // No period-end expiry: a subscription-backed entitlement lives until the
      // subscription is canceled (which revokes it), not until a date a sweep
      // job would have to keep extending.
      expiresAt: null,
    });

    return {
      status: 'processed',
      ...base,
      clientId,
      subscriptionId,
      note: `Granted ${keys.join(', ')} from offer "${resolution.offer.code}" (mapped by ${resolution.basis}).`,
    };
  }

  private async onSubscriptionUpserted(
    facts: ProviderEventFacts,
    base: Omit<ProcessResult, 'status' | 'note'>,
  ): Promise<ProcessResult> {
    if (!facts.subscriptionId) {
      return { status: 'ignored', ...base, note: 'Subscription event carries no subscription id.' };
    }
    const existing = await this.prisma.subscription.findUnique({
      where: { providerId: facts.subscriptionId },
    });
    const clientId = existing?.clientId ?? (await this.resolveClientId(facts));
    if (!clientId) {
      return {
        status: 'ignored',
        ...base,
        note: 'No existing subscription row and no resolvable client — nothing to attach this subscription to.',
      };
    }

    const status = this.subscriptionStatus(facts.subscriptionStatus) ?? existing?.status ?? 'incomplete';
    const subscription = await this.billing.upsertSubscriptionFromProvider({
      providerId: facts.subscriptionId,
      clientId,
      offerId: existing?.offerId ?? null,
      customerId: facts.customerId,
      status,
      currentPeriodStart: unixSecondsToDate(facts.currentPeriodStart),
      currentPeriodEnd: unixSecondsToDate(facts.currentPeriodEnd),
      cancelAt: unixSecondsToDate(facts.cancelAt),
      canceledAt: unixSecondsToDate(facts.canceledAt),
    });

    // A subscription that reaches a terminal state ends access; a
    // cancel-at-period-end does not, because the period was paid for.
    if (status === 'canceled') {
      const revoked = await this.billing.revokeEntitlementsForSubscription(
        subscription.id,
        `subscription ${facts.subscriptionId} is canceled`,
      );
      return {
        status: 'processed',
        ...base,
        clientId,
        subscriptionId: subscription.id,
        note: `Subscription canceled; ${revoked} entitlement(s) revoked.`,
      };
    }

    return {
      status: 'processed',
      ...base,
      clientId,
      subscriptionId: subscription.id,
      note: `Subscription status now "${status}"${facts.cancelAtPeriodEnd ? '; cancels at period end (access continues to period end)' : ''}.`,
    };
  }

  private async onSubscriptionDeleted(
    facts: ProviderEventFacts,
    base: Omit<ProcessResult, 'status' | 'note'>,
  ): Promise<ProcessResult> {
    if (!facts.subscriptionId) {
      return { status: 'ignored', ...base, note: 'Subscription deletion carries no subscription id.' };
    }
    const existing = await this.prisma.subscription.findUnique({
      where: { providerId: facts.subscriptionId },
    });
    if (!existing) {
      return {
        status: 'ignored',
        ...base,
        note: `No local subscription row for ${facts.subscriptionId} — nothing to cancel or revoke.`,
      };
    }

    const subscription = await this.billing.upsertSubscriptionFromProvider({
      providerId: facts.subscriptionId,
      clientId: existing.clientId,
      offerId: existing.offerId,
      customerId: facts.customerId ?? existing.providerCustomerId,
      status: 'canceled',
      currentPeriodStart: unixSecondsToDate(facts.currentPeriodStart) ?? existing.currentPeriodStart,
      currentPeriodEnd: unixSecondsToDate(facts.currentPeriodEnd) ?? existing.currentPeriodEnd,
      cancelAt: unixSecondsToDate(facts.cancelAt) ?? existing.cancelAt,
      canceledAt: unixSecondsToDate(facts.canceledAt) ?? new Date(),
    });

    const revoked = await this.billing.revokeEntitlementsForSubscription(
      subscription.id,
      `subscription ${facts.subscriptionId} ended`,
    );

    return {
      status: 'processed',
      ...base,
      clientId: existing.clientId,
      subscriptionId: subscription.id,
      note: `Subscription ended; ${revoked} entitlement(s) revoked.`,
    };
  }

  private async onInvoicePaid(
    facts: ProviderEventFacts,
    base: Omit<ProcessResult, 'status' | 'note'>,
  ): Promise<ProcessResult> {
    if (!facts.subscriptionId) {
      return {
        status: 'processed',
        ...base,
        note: 'Payment recorded. No subscription id on the invoice, so no subscription state changed.',
      };
    }
    const existing = await this.prisma.subscription.findUnique({
      where: { providerId: facts.subscriptionId },
    });
    if (!existing) {
      return {
        status: 'ignored',
        ...base,
        note: `Invoice paid for unknown subscription ${facts.subscriptionId} — recorded, no state changed.`,
      };
    }

    const subscription = await this.billing.upsertSubscriptionFromProvider({
      providerId: facts.subscriptionId,
      clientId: existing.clientId,
      offerId: existing.offerId,
      customerId: facts.customerId ?? existing.providerCustomerId,
      status: 'active',
      currentPeriodStart: unixSecondsToDate(facts.currentPeriodStart) ?? existing.currentPeriodStart,
      currentPeriodEnd: unixSecondsToDate(facts.currentPeriodEnd) ?? existing.currentPeriodEnd,
      cancelAt: unixSecondsToDate(facts.cancelAt) ?? existing.cancelAt,
      canceledAt: existing.canceledAt,
    });

    return {
      status: 'processed',
      ...base,
      clientId: existing.clientId,
      subscriptionId: subscription.id,
      note: 'Invoice paid; subscription refreshed to active. Entitlements already held by this subscription are unchanged.',
    };
  }

  private async onInvoiceFailed(
    facts: ProviderEventFacts,
    base: Omit<ProcessResult, 'status' | 'note'>,
  ): Promise<ProcessResult> {
    const existing = facts.subscriptionId
      ? await this.prisma.subscription.findUnique({ where: { providerId: facts.subscriptionId } })
      : null;
    if (!existing) {
      return {
        status: 'processed',
        ...base,
        note: 'Failed payment recorded. No matching local subscription, so no state changed.',
      };
    }

    const subscription = await this.billing.upsertSubscriptionFromProvider({
      providerId: facts.subscriptionId as string,
      clientId: existing.clientId,
      offerId: existing.offerId,
      customerId: facts.customerId ?? existing.providerCustomerId,
      status: 'past-due',
      currentPeriodStart: existing.currentPeriodStart,
      currentPeriodEnd: existing.currentPeriodEnd,
      cancelAt: existing.cancelAt,
      canceledAt: existing.canceledAt,
    });

    return {
      status: 'processed',
      ...base,
      clientId: existing.clientId,
      subscriptionId: subscription.id,
      note: 'Payment failed; subscription marked past-due. Access is NOT cut here — the grace policy is an operator decision.',
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /** Map a provider subscription status onto our vocabulary, or null. */
  private subscriptionStatus(status: string | null): string | null {
    switch (status) {
      case 'incomplete':
        return 'incomplete';
      case 'trialing':
        return 'trialing';
      case 'active':
        return 'active';
      case 'past_due':
      case 'unpaid':
        return 'past-due';
      case 'canceled':
      case 'incomplete_expired':
        return 'canceled';
      default:
        return null;
    }
  }

  /**
   * Resolve the event's client hint against the `Client` table. A hint that
   * names no real client resolves to null, and the caller records why rather
   * than inventing a client.
   */
  private async resolveClientId(
    facts: ProviderEventFacts,
  ): Promise<string | null> {
    if (!facts.clientIdHint) return null;
    const client = await this.prisma.client.findUnique({
      where: { id: facts.clientIdHint },
      select: { id: true },
    });
    return client?.id ?? null;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
