/**
 * BillingService — G16's ledger: offers, subscriptions, payment events and
 * entitlements.
 *
 * This service owns the **only** writes that can grant a client access to a
 * paid feature. Three invariants shape every method here:
 *
 * 1. **An entitlement is created only from a verified `PaymentEvent`.**
 *    {@link grantEntitlements} refuses an event whose `signatureValid` is
 *    false, so a caller cannot grant by reaching a different method. Nothing on
 *    the public surface writes an entitlement, and no request field anywhere is
 *    read as "this was paid for".
 * 2. **Price mapping lives in `Offer`.** A webhook may name an offer code or a
 *    provider price id; the amount and the entitlement keys are read from the
 *    matching row, never from the payload. {@link resolveOfferForFacts}
 *    encodes that, and returns the reason when nothing matches instead of
 *    guessing.
 * 3. **A duplicate delivery is not a second grant.** `providerEventId` is
 *    unique; the webhook service consults it before acting, and
 *    {@link grantEntitlements} upserts on `(clientId, key)`, so even a racing
 *    double-delivery converges on one row per key.
 *
 * Reads are separated by audience: the raw provider payload is admin-only and
 * only on the single-event route, because it carries the customer's contact
 * details — the list surface returns the payload's *shape* instead.
 *
 * @module billing.service
 */

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import {
  CHECKOUT_SESSION_ID_RE,
  OFFER_CODE_RE,
  type BillingCapabilityView,
  type CheckoutStatusView,
  type EntitlementView,
  type LedgerInvoiceView,
  type OfferView,
  type PaymentEventDetailView,
  type PaymentEventView,
  type SubscriptionView,
} from './billing.types';
import {
  extractProviderEventFacts,
  referencesSession,
  unixSecondsToDate,
  type ProviderEventFacts,
} from './lib/provider-event.util';
import type {
  CreateOfferDto,
  ListEntitlementsQueryDto,
  ListPaymentEventsQueryDto,
  ListSubscriptionsQueryDto,
  UpdateOfferDto,
} from './dto/billing.dto';

/** Env var the webhook signing secret is read from. Name only, never a value. */
export const WEBHOOK_SECRET_ENV = 'STRIPE_WEBHOOK_SECRET';
/** Env var the challenge-signing secret is read from. */
export const INTAKE_CHALLENGE_SECRET_ENV = 'PUBLIC_INTAKE_CHALLENGE_SECRET';
/** How far a webhook timestamp may drift, in seconds. */
export const WEBHOOK_TOLERANCE_ENV = 'STRIPE_WEBHOOK_TOLERANCE_SECONDS';
/** Proof-of-work difficulty for the public challenge, in leading zero bits. */
export const INTAKE_CHALLENGE_BITS_ENV = 'PUBLIC_INTAKE_CHALLENGE_BITS';

/** Row shapes this service reads. Declared narrowly so no view leaks a column. */
interface OfferRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  providerPriceId: string | null;
  amountCents: number;
  currency: string;
  interval: string;
  entitlements: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface EntitlementRow {
  id: string;
  clientId: string;
  key: string;
  status: string;
  grantedByEventId: string | null;
  subscriptionId: string | null;
  startsAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface SubscriptionRow {
  id: string;
  clientId: string;
  offerId: string | null;
  providerId: string | null;
  providerCustomerId: string | null;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  canceledAt: Date | null;
  pastDueSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PaymentEventRow {
  id: string;
  providerEventId: string;
  provider: string;
  eventType: string;
  signatureValid: boolean;
  status: string;
  clientId: string | null;
  subscriptionId: string | null;
  amountCents: number | null;
  currency: string | null;
  payload: string;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

/** The offer a provider event maps to, plus how the mapping was made. */
export interface OfferResolution {
  offer: OfferRow | null;
  /** How the offer was identified. `none` means it was not. */
  basis: 'metadata-offer-code' | 'provider-price-id' | 'none';
  /** Why no offer was resolved. Null when one was. */
  reason: string | null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly activity: ActivityService,
    protected readonly config: ConfigService,
  ) {}

  // ── parsing helpers ─────────────────────────────────────────────────

  /** Parse a JSON string[] column, dropping anything that is not a string. */
  private parseStringArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    } catch {
      return [];
    }
  }

  /**
   * The entitlement keys an offer grants, from its stored JSON.
   * Public because the webhook needs exactly this list and nothing else from
   * the offer row — handing it the whole row would invite reading the price
   * from the wrong place.
   */
  entitlementKeysOf(offer: { entitlements: string }): string[] {
    return this.parseStringArray(offer.entitlements);
  }

  /** Parse a JSON column to an object, or `{}` when it is not one. */
  private parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private toOfferView(row: OfferRow): OfferView {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      providerPriceId: row.providerPriceId,
      amountCents: row.amountCents,
      currency: row.currency,
      interval: row.interval,
      entitlements: this.parseStringArray(row.entitlements),
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toEntitlementView(row: EntitlementRow): EntitlementView {
    return {
      id: row.id,
      clientId: row.clientId,
      key: row.key,
      status: row.status,
      grantedByEventId: row.grantedByEventId,
      subscriptionId: row.subscriptionId,
      startsAt: row.startsAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toSubscriptionView(row: SubscriptionRow): SubscriptionView {
    return {
      id: row.id,
      clientId: row.clientId,
      offerId: row.offerId,
      providerId: row.providerId,
      providerCustomerId: row.providerCustomerId,
      status: row.status,
      currentPeriodStart: row.currentPeriodStart ? row.currentPeriodStart.toISOString() : null,
      currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
      cancelAt: row.cancelAt ? row.cancelAt.toISOString() : null,
      canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
      pastDueSince: row.pastDueSince ? row.pastDueSince.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toPaymentEventView(row: PaymentEventRow): PaymentEventView {
    return {
      id: row.id,
      providerEventId: row.providerEventId,
      provider: row.provider,
      eventType: row.eventType,
      signatureValid: row.signatureValid,
      status: row.status,
      clientId: row.clientId,
      subscriptionId: row.subscriptionId,
      amountCents: row.amountCents,
      currency: row.currency,
      error: row.error,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      payloadKeys: Object.keys(this.parseJsonObject(row.payload)).sort(),
      payloadAvailable: true,
    };
  }

  // ── Offers ──────────────────────────────────────────────────────────

  /** Every offer, newest first, optionally filtered by code or active flag. */
  async listOffers(filter: { active?: string; code?: string } = {}): Promise<{ offers: OfferView[] }> {
    const where: { active?: boolean; code?: string } = {};
    if (filter.active === 'true') where.active = true;
    if (filter.active === 'false') where.active = false;
    if (filter.code) where.code = filter.code;

    const rows = await this.prisma.offer.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { offers: rows.map((row) => this.toOfferView(row)) };
  }

  /** One offer by its code — the key the checkout flow quotes. */
  async getOfferByCode(code: string): Promise<OfferView> {
    const row = await this.prisma.offer.findUnique({ where: { code } });
    if (!row) throw new NotFoundException(`No offer with code "${code}"`);
    return this.toOfferView(row);
  }

  /** Create a price mapping. Admin-only at the route; the money is server-side. */
  async createOffer(dto: CreateOfferDto, actorId: string): Promise<OfferView> {
    if (!OFFER_CODE_RE.test(dto.code)) {
      throw new ConflictException('code must be a lowercase slug (letters, digits, . _ -), 2-64 characters');
    }
    const existing = await this.prisma.offer.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`An offer with code "${dto.code}" already exists`);

    const row = await this.prisma.offer.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        providerPriceId: dto.providerPriceId ?? null,
        amountCents: dto.amountCents,
        currency: (dto.currency ?? 'usd').toLowerCase(),
        interval: dto.interval ?? 'monthly',
        entitlements: JSON.stringify(dto.entitlements),
        active: dto.active ?? true,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actorId },
      action: 'created',
      resource: { type: 'offer', id: row.id, version: row.code },
      summary: `Offer "${row.code}" created at ${row.amountCents} ${row.currency} ${row.interval}`,
      changes: { amountCents: row.amountCents, entitlements: dto.entitlements },
      origin: 'api',
    });

    return this.toOfferView(row);
  }

  /** Edit a price mapping. Deactivating is the supported removal — rows stay. */
  async updateOffer(id: string, dto: UpdateOfferDto, actorId: string): Promise<OfferView> {
    const current = await this.prisma.offer.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Offer ${id} not found`);

    const row = await this.prisma.offer.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        description: dto.description ?? undefined,
        providerPriceId: dto.providerPriceId ?? undefined,
        amountCents: dto.amountCents ?? undefined,
        currency: dto.currency ? dto.currency.toLowerCase() : undefined,
        interval: dto.interval ?? undefined,
        entitlements: dto.entitlements ? JSON.stringify(dto.entitlements) : undefined,
        active: dto.active ?? undefined,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actorId },
      action: 'updated',
      resource: { type: 'offer', id: row.id, version: row.code },
      summary: `Offer "${row.code}" updated`,
      changes: {
        amountCents: { before: current.amountCents, after: row.amountCents },
        active: { before: current.active, after: row.active },
      },
      origin: 'api',
    });

    return this.toOfferView(row);
  }

  /**
   * Map a provider event onto an `Offer` — the server-side price mapping.
   *
   * Only two things are trusted as identifying an offer, in this order:
   * `metadata.offerCode` (an exact `Offer.code`) and the provider price id
   * (`Offer.providerPriceId`). The amount is never used to *guess* an offer:
   * an event that names neither is `basis: 'none'` with a reason, and the
   * caller must not grant anything from it.
   */
  async resolveOfferForFacts(facts: ProviderEventFacts): Promise<OfferResolution> {
    if (facts.offerCodeHint) {
      const byCode = await this.prisma.offer.findUnique({ where: { code: facts.offerCodeHint } });
      if (byCode) return { offer: byCode, basis: 'metadata-offer-code', reason: null };
      return {
        offer: null,
        basis: 'none',
        reason: `offer code "${facts.offerCodeHint}" from the event metadata does not match any offer`,
      };
    }

    if (facts.priceIds.length > 0) {
      const matches = await this.prisma.offer.findMany({
        where: { providerPriceId: { in: facts.priceIds } },
      });
      if (matches.length === 1) {
        return { offer: matches[0], basis: 'provider-price-id', reason: null };
      }
      if (matches.length > 1) {
        return {
          offer: null,
          basis: 'none',
          reason: `price id ${facts.priceIds.join(', ')} maps to ${matches.length} offers — ambiguous, so nothing was granted`,
        };
      }
      return {
        offer: null,
        basis: 'none',
        reason: `no offer is mapped to price id ${facts.priceIds.join(', ')}`,
      };
    }

    return {
      offer: null,
      basis: 'none',
      reason: 'the event names neither an offer code nor a provider price id',
    };
  }

  /**
   * Is the amount the customer paid acceptable for this offer?
   *
   * A discount or a coupon legitimately produces a payment **below** list
   * price, so under-payment is not treated as fraud. Paying *more* than list
   * price is not something the offer authorizes, so it is refused rather than
   * silently upgraded. A currency mismatch is always refused — this module has
   * no FX rates and will not invent one.
   */
  evaluateAmount(facts: ProviderEventFacts, offer: OfferRow): { acceptable: boolean; reason: string | null } {
    if (facts.currency && facts.currency !== offer.currency.toLowerCase()) {
      return {
        acceptable: false,
        reason: `currency mismatch: event is ${facts.currency}, offer is ${offer.currency}`,
      };
    }
    if (facts.amountPaidCents === null) {
      // No amount in the payload: the offer's own price is still the authority
      // for what was bought, so this is not a reason to withhold.
      return { acceptable: true, reason: null };
    }
    if (facts.amountPaidCents > offer.amountCents) {
      return {
        acceptable: false,
        reason: `amount paid (${facts.amountPaidCents}) exceeds the offer's price (${offer.amountCents}) — refusing to grant`,
      };
    }
    return { acceptable: true, reason: null };
  }

  // ── Entitlements ────────────────────────────────────────────────────

  /** Entitlements, filterable by client/key/status. Newest first. */
  async listEntitlements(filter: ListEntitlementsQueryDto = {}): Promise<{ entitlements: EntitlementView[] }> {
    const rows = await this.prisma.entitlement.findMany({
      where: {
        clientId: filter.clientId || undefined,
        key: filter.key || undefined,
        status: filter.status || undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { entitlements: rows.map((row) => this.toEntitlementView(row)) };
  }

  /** What this client may currently use — the client-portal read. */
  async entitlementsForClient(clientId: string): Promise<EntitlementView[]> {
    const rows = await this.prisma.entitlement.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toEntitlementView(row));
  }

  /**
   * Grant (or re-grant) a set of entitlement keys for a client.
   *
   * Refuses when `event.signatureValid` is false: this is the last line of
   * defence behind the webhook's own check, so that no future caller can grant
   * from a rejected event by taking a different path to the same table.
   *
   * Upserts on the `(clientId, key)` unique constraint, which makes a
   * concurrent double-delivery converge on one active row rather than
   * conflicting — a renewal re-activates the row and clears `revokedAt`.
   */
  async grantEntitlements(input: {
    clientId: string;
    keys: string[];
    event: { id: string; signatureValid: boolean };
    subscriptionId?: string | null;
    expiresAt?: Date | null;
  }): Promise<EntitlementView[]> {
    if (!input.event.signatureValid) {
      throw new ConflictException(
        `Refusing to grant entitlements from payment event ${input.event.id}: its signature did not verify.`,
      );
    }

    const granted: EntitlementView[] = [];
    for (const key of input.keys) {
      const row = await this.prisma.entitlement.upsert({
        where: { clientId_key: { clientId: input.clientId, key } },
        create: {
          clientId: input.clientId,
          key,
          status: 'active',
          grantedByEventId: input.event.id,
          subscriptionId: input.subscriptionId ?? null,
          expiresAt: input.expiresAt ?? null,
        },
        update: {
          status: 'active',
          grantedByEventId: input.event.id,
          subscriptionId: input.subscriptionId ?? null,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
          startsAt: new Date(),
        },
      });
      granted.push(this.toEntitlementView(row));

      await this.activity.record({
        actor: { type: 'webhook', id: 'stripe' },
        action: 'granted',
        resource: { type: 'entitlement', id: row.id, version: key },
        clientId: input.clientId,
        summary: `Entitlement "${key}" granted from verified payment event ${input.event.id}`,
        changes: { status: 'active', grantedByEventId: input.event.id },
        origin: 'webhook',
        result: 'success',
      });
    }
    return granted;
  }

  /**
   * Revoke one entitlement by hand. This is the operator's tool for a refund or
   * a contract term Cailyx decided on — provider-driven cancellation revokes
   * through {@link revokeEntitlementsForSubscription} instead.
   */
  async revokeEntitlement(id: string, reason: string, actorId: string): Promise<EntitlementView> {
    const current = await this.prisma.entitlement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Entitlement ${id} not found`);
    if (current.status === 'revoked') {
      throw new ConflictException(`Entitlement ${id} is already revoked`);
    }

    const row = await this.prisma.entitlement.update({
      where: { id },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    await this.activity.record({
      actor: { type: 'user', id: actorId },
      action: 'revoked',
      resource: { type: 'entitlement', id: row.id, version: row.key },
      clientId: row.clientId,
      summary: `Entitlement "${row.key}" revoked: ${reason}`,
      changes: { status: { before: current.status, after: 'revoked' } },
      origin: 'api',
    });

    return this.toEntitlementView(row);
  }

  /**
   * Revoke every entitlement tied to a subscription. Called when the provider
   * says the subscription ended, so a cancellation actually stops the service
   * rather than leaving the client with access until someone notices.
   */
  async revokeEntitlementsForSubscription(subscriptionId: string, reason: string): Promise<number> {
    const rows = await this.prisma.entitlement.findMany({
      where: { subscriptionId, status: { not: 'revoked' } },
    });
    if (rows.length === 0) return 0;

    await this.prisma.entitlement.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    for (const row of rows) {
      await this.activity.record({
        actor: { type: 'webhook', id: 'stripe' },
        action: 'revoked',
        resource: { type: 'entitlement', id: row.id, version: row.key },
        clientId: row.clientId,
        summary: `Entitlement "${row.key}" revoked: ${reason}`,
        changes: { status: { before: row.status, after: 'revoked' } },
        origin: 'webhook',
        result: 'success',
      });
    }
    return rows.length;
  }

  // ── Subscriptions ───────────────────────────────────────────────────

  /** Subscriptions, filterable by client/status. */
  async listSubscriptions(filter: ListSubscriptionsQueryDto = {}): Promise<{ subscriptions: SubscriptionView[] }> {
    const rows = await this.prisma.subscription.findMany({
      where: { clientId: filter.clientId || undefined, status: filter.status || undefined },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { subscriptions: rows.map((row) => this.toSubscriptionView(row)) };
  }

  /** One subscription by id. */
  async getSubscription(id: string): Promise<SubscriptionView> {
    const row = await this.prisma.subscription.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Subscription ${id} not found`);
    return this.toSubscriptionView(row);
  }

  /** This client's subscriptions — the client-portal read. */
  async subscriptionsForClient(clientId: string): Promise<SubscriptionView[]> {
    const rows = await this.prisma.subscription.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toSubscriptionView(row));
  }

  /**
   * C5 (`docs/analysis/client-portal.md` §30) — subscriptions still `past-due`
   * whose grace period (`pastDueSince` + `graceDays`) has elapsed. Read by
   * `PaymentFailureSweepService`; this method only reads, it never suspends
   * anything itself (that stays `ClientsService.suspendClient`'s job).
   */
  async listPastDueBeyondGracePeriod(graceDays: number): Promise<SubscriptionView[]> {
    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.subscription.findMany({
      where: { status: 'past-due', pastDueSince: { not: null, lte: cutoff } },
      orderBy: { pastDueSince: 'asc' },
    });
    return rows.map((row) => this.toSubscriptionView(row));
  }

  /**
   * Create or update the local subscription row for a provider event.
   *
   * Keyed on `Subscription.providerId` (unique). `clientId` is required and
   * must have been resolved from the event; when it could not be, the caller
   * reports that rather than attaching a subscription to a guessed client.
   */
  async upsertSubscriptionFromProvider(input: {
    providerId: string;
    clientId: string;
    offerId?: string | null;
    customerId?: string | null;
    status?: string | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelAt?: Date | null;
    canceledAt?: Date | null;
    /**
     * C5 (`docs/analysis/client-portal.md` §30) — when this subscription
     * FIRST went past-due. Omit (`undefined`) to leave the column untouched
     * (the common case: most status transitions have nothing to say about
     * it); pass `null` to explicitly clear it (subscription seen
     * active/paid again); pass a `Date` to set it. Callers, not this method,
     * decide which — this method never infers it from `status` on its own,
     * so "set once, not bumped on retries" stays a caller-level decision
     * (`StripeWebhookService`) rather than being silently re-derived here.
     */
    pastDueSince?: Date | null;
  }): Promise<SubscriptionView> {
    const data = {
      clientId: input.clientId,
      offerId: input.offerId ?? null,
      providerCustomerId: input.customerId ?? null,
      status: input.status ?? 'incomplete',
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAt: input.cancelAt ?? null,
      canceledAt: input.canceledAt ?? null,
      ...(input.pastDueSince !== undefined ? { pastDueSince: input.pastDueSince } : {}),
    };

    const row = await this.prisma.subscription.upsert({
      where: { providerId: input.providerId },
      create: { providerId: input.providerId, ...data },
      update: data,
    });
    return this.toSubscriptionView(row);
  }

  // ── Payment event ledger ────────────────────────────────────────────

  /**
   * The ledger, newest first. `payload` is **not** included — see
   * {@link getPaymentEvent} for the admin-only read that returns it.
   */
  async listPaymentEvents(filter: ListPaymentEventsQueryDto = {}): Promise<{ events: PaymentEventView[] }> {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const rows = await this.prisma.paymentEvent.findMany({
      where: {
        status: filter.status || undefined,
        clientId: filter.clientId || undefined,
        providerEventId: filter.providerEventId || undefined,
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
    return { events: rows.map((row) => this.toPaymentEventView(row)) };
  }

  /**
   * One event **including its raw payload**. Admin-only at the route: the
   * payload is the provider's own event and carries the customer's name, email
   * and billing address.
   */
  async getPaymentEvent(id: string): Promise<PaymentEventDetailView> {
    const row = await this.prisma.paymentEvent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Payment event ${id} not found`);
    return { ...this.toPaymentEventView(row), payload: this.parseJsonObject(row.payload) };
  }

  /** The stored payload of an event, parsed. For internal callers. */
  async loadEventPayload(id: string): Promise<unknown> {
    const row = await this.prisma.paymentEvent.findUnique({ where: { id }, select: { payload: true } });
    return row ? this.parseJsonObject(row.payload) : null;
  }

  // ── Invoices (ledger-derived) ───────────────────────────────────────

  /**
   * Invoice-shaped lines built from **verified** payment events.
   *
   * Cailyx has no provider invoice API in this pass, so these are the payment
   * events it has actually confirmed by signature. The envelope says exactly
   * that — `providerInvoices.configured: false` with the reason — so a screen
   * cannot present a ledger line as a provider-issued invoice.
   */
  async listInvoices(clientId?: string): Promise<{
    invoices: LedgerInvoiceView[];
    providerInvoices: { configured: boolean; reason: string };
  }> {
    const rows = await this.prisma.paymentEvent.findMany({
      where: {
        clientId: clientId || undefined,
        signatureValid: true,
        status: { in: ['processed', 'ignored'] },
        eventType: {
          in: ['invoice.payment_succeeded', 'invoice.payment_failed', 'charge.refunded', 'invoice.paid'],
        },
      },
      orderBy: { receivedAt: 'desc' },
      take: 200,
    });

    return {
      invoices: rows.map((row) => ({
        eventId: row.id,
        clientId: row.clientId,
        eventType: row.eventType,
        subscriptionId: row.subscriptionId,
        amountCents: row.amountCents,
        currency: row.currency,
        status: this.invoiceStatusFor(row.eventType, row.status),
        occurredAt: row.receivedAt.toISOString(),
        verified: row.signatureValid,
      })),
      providerInvoices: {
        configured: false,
        reason:
          'No provider invoice API client is configured in this build — these lines come from Cailyx\'s own signature-verified payment-event ledger, not from the provider\'s invoice objects.',
      },
    };
  }

  private invoiceStatusFor(eventType: string, eventStatus: string): LedgerInvoiceView['status'] {
    if (eventType === 'invoice.payment_failed') return 'failed';
    if (eventType === 'charge.refunded') return 'refunded';
    if (eventType === 'invoice.payment_succeeded' || eventType === 'invoice.paid') {
      return eventStatus === 'processed' ? 'paid' : 'other';
    }
    return 'other';
  }

  // ── Verified checkout status (PB04) ─────────────────────────────────

  /**
   * The checkout-return read: "did the payment for this session actually land?"
   *
   * Answering from the **signature-verified ledger** and nothing else is the
   * point of this endpoint. A browser arriving at `/checkout/result?session=…`
   * has proven nothing — the query string is user-editable — so a visit here
   * can never create an entitlement, can never flip a status to paid, and
   * writes nothing at all.
   *
   * `pending` is a first-class answer: a webhook that has not arrived yet is
   * not a failure and not a grant, and the response says which it is and what
   * to do next.
   */
  async getCheckoutStatus(sessionId: string): Promise<CheckoutStatusView> {
    if (!CHECKOUT_SESSION_ID_RE.test(sessionId)) {
      throw new NotFoundException('Unknown checkout session');
    }

    // `contains` narrows the candidate set; the exact check is done on the
    // parsed payload, because a substring hit is not a match.
    const candidates = await this.prisma.paymentEvent.findMany({
      where: {
        provider: 'stripe',
        OR: [{ providerEventId: sessionId }, { payload: { contains: sessionId } }],
      },
      orderBy: { receivedAt: 'desc' },
      take: 50,
    });

    const referencing = candidates.filter((row) => referencesSession(this.parseJsonObject(row.payload), sessionId));

    if (referencing.length === 0) {
      return {
        sessionId,
        // A session the provider redirected to, with no event on record, is
        // exactly "the webhook has not arrived yet": pending, not failed, and
        // certainly not granted. `onRecord: false` is the honest sub-case, so a
        // screen can distinguish "waiting on the provider" from "no confirmation
        // has ever been received for this id".
        status: 'pending',
        purchaseVerified: false,
        onRecord: false,
        offer: null,
        entitlements: [],
        reason: null,
        eventType: null,
        receivedAt: null,
        nextAction:
          'No payment event for this checkout session is on record yet. If a payment was just made, the provider may still be delivering the confirmation — check again shortly. Nothing is granted until a signed event arrives.',
      };
    }

    // Prefer the row that actually decided something: a genuine processed
    // event outranks a rejected forgery for the same session id.
    const precedence = ['processed', 'pending', 'ignored', 'rejected'];
    const event = referencing.slice().sort((a, b) => {
      const byStatus = precedence.indexOf(a.status) - precedence.indexOf(b.status);
      return byStatus !== 0 ? byStatus : b.receivedAt.getTime() - a.receivedAt.getTime();
    })[0];

    const facts = extractProviderEventFacts(this.parseJsonObject(event.payload));
    const resolution = await this.resolveOfferForFacts(facts);

    if (event.status !== 'processed') {
      const entitlements =
        event.status === 'rejected'
          ? []
          : await this.entitlementsGrantedBy(event.id);
      return {
        sessionId,
        status: event.status === 'pending' ? 'pending' : event.status === 'rejected' ? 'rejected' : 'ignored',
        purchaseVerified: false,
        onRecord: true,
        offer: resolution.offer ? this.offerSummary(resolution.offer) : null,
        entitlements,
        reason: event.error ?? resolution.reason,
        eventType: event.eventType,
        receivedAt: event.receivedAt.toISOString(),
        nextAction:
          event.status === 'pending'
            ? 'The provider has delivered an event for this session and it is still being processed. Nothing is granted until it is verified.'
            : event.status === 'rejected'
              ? 'An event for this session failed signature verification and was rejected. If you believe you were charged, contact Cailyx with your receipt — a rejected event grants nothing.'
              : 'The event for this session was verified but deliberately not acted on. Cailyx support can explain why.',
      };
    }

    return {
      sessionId,
      status: 'verified',
      purchaseVerified: true,
      onRecord: true,
      offer: resolution.offer ? this.offerSummary(resolution.offer) : null,
      entitlements: await this.entitlementsGrantedBy(event.id),
      reason: event.error,
      eventType: event.eventType,
      receivedAt: event.receivedAt.toISOString(),
      nextAction:
        'Payment verified. Your access is active — sign in to use it. Nothing else is required from you.',
    };
  }

  /** Offer fields the checkout-return screen needs. Never the internal id. */
  private offerSummary(offer: OfferRow): CheckoutStatusView['offer'] {
    return {
      code: offer.code,
      name: offer.name,
      amountCents: offer.amountCents,
      currency: offer.currency,
      interval: offer.interval,
    };
  }

  /** Entitlements this event actually granted, as key/status pairs. */
  private async entitlementsGrantedBy(eventId: string): Promise<Array<{ key: string; status: string }>> {
    const rows = await this.prisma.entitlement.findMany({
      where: { grantedByEventId: eventId },
      select: { key: true, status: true },
      orderBy: { key: 'asc' },
    });
    return rows;
  }

  // ── Capability ──────────────────────────────────────────────────────

  /**
   * What this module can and cannot do right now, in explicit terms.
   *
   * The design plan's §3.5 rule is that a capability which does not exist
   * renders as an unavailable state with its prerequisite — not as an empty
   * list, and not as a screen that looks configured. This read is where a
   * screen gets that state, including which env var is missing (by name).
   */
  capability(bodyIntegrity: 'raw' | 'reserialized' | null): BillingCapabilityView {
    const webhookSecret = this.config.get<string>(WEBHOOK_SECRET_ENV);
    const challengeSecret = this.config.get<string>(INTAKE_CHALLENGE_SECRET_ENV);

    return {
      webhook: {
        configured: !!webhookSecret,
        secretEnvVar: WEBHOOK_SECRET_ENV,
        reason: webhookSecret
          ? null
          : `${WEBHOOK_SECRET_ENV} is not set — every delivery is refused and recorded as rejected. No payment is ever trusted from an unsigned payload.`,
      },
      checkout: {
        configured: false,
        reason:
          'Checkout links are issued operator-side (delivery module) from provider-hosted URLs. Creating a checkout session from the API needs a provider client, which is not configured in this build — and adding one is a decision, not a default.',
      },
      rawBodyCapture: {
        enabled: bodyIntegrity === 'raw',
        reason:
          bodyIntegrity === 'raw'
            ? null
            : bodyIntegrity === 'reserialized'
              ? 'The last delivery was verified over a canonical re-serialization of the parsed body, not the raw bytes (main.ts does not set `rawBody: true`). That still cannot be forged without the secret — but a payload the re-serialization alters would be rejected, so raw capture is the correct configuration.'
              : 'No webhook delivery has been processed yet, so the capture mode has not been observed. Each webhook response reports `bodyIntegrity` for its own delivery.',
      },
      publicIntake: {
        configured: !!challengeSecret,
        reason: challengeSecret
          ? null
          : `${INTAKE_CHALLENGE_SECRET_ENV} is not set — the public diagnostic request is closed and says so rather than accepting unverified submissions.`,
        challengeDifficultyBits: Number(this.config.get<string>(INTAKE_CHALLENGE_BITS_ENV) ?? 0) || 0,
      },
    };
  }
}
