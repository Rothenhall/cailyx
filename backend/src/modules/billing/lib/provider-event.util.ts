/**
 * Defensive extraction of the facts this module needs from a provider webhook
 * payload.
 *
 * Everything here is a *pure read* of an already signature-verified payload,
 * kept in one place so the webhook handler and the checkout-status read agree
 * on what a payload says. Two rules:
 *
 * - **Never throws.** A malformed or unexpected payload yields nulls, and the
 *   caller decides what to do. A webhook handler that 500s on an unfamiliar
 *   provider shape is a webhook handler that silently drops real purchases.
 * - **Never decides anything.** This file says what the payload *contains*
 *   (a price id, an amount, a metadata hint). Which offer that maps to, and
 *   whether the amount is acceptable, is a server-side policy decision made in
 *   `BillingService` against the `Offer` table — never here, and never from a
 *   caller-supplied field.
 *
 * The shape is Stripe's (`data.object`), because that is the configured
 * provider; `provider` on the ledger row keeps the door open for a second one.
 *
 * @module billing/lib/provider-event.util
 */

/** Facts read out of a provider event payload. Missing facts are null/empty. */
export interface ProviderEventFacts {
  eventId: string | null;
  eventType: string | null;
  /** The `object` discriminator of `data.object` (`checkout.session`, `subscription`, …). */
  objectType: string | null;
  objectId: string | null;
  /** `client_reference_id` or `metadata.clientId` — a *hint* to be validated. */
  clientIdHint: string | null;
  /** `metadata.offerCode` — a *hint* to be resolved against `Offer.code`. */
  offerCodeHint: string | null;
  /** Every price id the payload references (metadata, subscription items, invoice lines). */
  priceIds: string[];
  /** Provider subscription id this event concerns. */
  subscriptionId: string | null;
  customerId: string | null;
  /** What the customer actually paid, in minor units, when the event says. */
  amountPaidCents: number | null;
  /** Pre-discount subtotal, when the event says. */
  amountSubtotalCents: number | null;
  currency: string | null;
  subscriptionStatus: string | null;
  /** `checkout.session.payment_status` — the provider's own "was this paid". */
  paymentStatus: string | null;
  cancelAtPeriodEnd: boolean;
  /** Unix seconds. */
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAt: number | null;
  canceledAt: number | null;
  /** Checkout session ids this event references. */
  sessionIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a key from a nested record without trusting its type. */
function at(source: unknown, ...path: string[]): unknown {
  let cursor: unknown = source;
  for (const key of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return cursor;
}

function obj(value: unknown, ...path: string[]): Record<string, unknown> | null {
  const found = at(value, ...path);
  return isRecord(found) ? found : null;
}

/** Every `price.id` under a Stripe list wrapper (`items.data[]`, `lines.data[]`). */
function priceIdsInList(list: unknown): string[] {
  if (!isRecord(list) || !Array.isArray(list.data)) return [];
  const out: string[] = [];
  for (const entry of list.data) {
    const id = str(at(entry, 'price', 'id'));
    if (id) out.push(id);
  }
  return out;
}

/**
 * Read the facts out of a parsed webhook payload.
 * Accepts the whole event (`{ id, type, data: { object } }`) and tolerates a
 * bare object (`{ … checkout session … }`) so the same reader works for a
 * stored ledger row and for a live event.
 */
export function extractProviderEventFacts(payload: unknown): ProviderEventFacts {
  const eventObject = obj(payload, 'data', 'object') ?? (isRecord(payload) ? payload : null);
  const root = isRecord(payload) ? payload : null;

  const metadata = obj(eventObject, 'metadata');
  const clientIdHint =
    str(at(eventObject, 'client_reference_id')) ??
    str(at(metadata, 'clientId')) ??
    str(at(metadata, 'client_id'));

  const offerCodeHint = str(at(metadata, 'offerCode')) ?? str(at(metadata, 'offer_code'));

  const priceIds = new Set<string>();
  const metadataPriceId = str(at(metadata, 'priceId')) ?? str(at(metadata, 'price_id'));
  if (metadataPriceId) priceIds.add(metadataPriceId);
  for (const id of priceIdsInList(at(eventObject, 'items'))) priceIds.add(id);
  for (const id of priceIdsInList(at(eventObject, 'lines'))) priceIds.add(id);
  const directPriceId = str(at(eventObject, 'price', 'id'));
  if (directPriceId) priceIds.add(directPriceId);

  const objectType = str(at(eventObject, 'object'));
  const objectId = str(at(eventObject, 'id'));
  const subscriptionFromObject = str(at(eventObject, 'subscription'));

  const sessionIds = new Set<string>();
  if (objectType === 'checkout.session' && objectId) sessionIds.add(objectId);
  const metadataSessionId =
    str(at(metadata, 'checkoutSessionId')) ?? str(at(metadata, 'checkout_session_id'));
  if (metadataSessionId) sessionIds.add(metadataSessionId);

  return {
    eventId: str(at(root, 'id')),
    eventType: str(at(root, 'type')),
    objectType,
    objectId,
    clientIdHint,
    offerCodeHint,
    priceIds: Array.from(priceIds),
    subscriptionId: subscriptionFromObject ?? (objectType === 'subscription' ? objectId : null),
    customerId: str(at(eventObject, 'customer')),
    amountPaidCents:
      num(at(eventObject, 'amount_total')) ??
      num(at(eventObject, 'amount_paid')) ??
      num(at(eventObject, 'amount')),
    amountSubtotalCents: num(at(eventObject, 'amount_subtotal')) ?? num(at(eventObject, 'amount_due')),
    currency: str(at(eventObject, 'currency'))?.toLowerCase() ?? null,
    subscriptionStatus: objectType === 'subscription' ? str(at(eventObject, 'status')) : null,
    paymentStatus: str(at(eventObject, 'payment_status')),
    cancelAtPeriodEnd: at(eventObject, 'cancel_at_period_end') === true,
    currentPeriodStart: num(at(eventObject, 'current_period_start')),
    currentPeriodEnd: num(at(eventObject, 'current_period_end')),
    cancelAt: num(at(eventObject, 'cancel_at')),
    canceledAt: num(at(eventObject, 'canceled_at')),
    sessionIds: Array.from(sessionIds),
  };
}

/** Unix seconds -> Date, or null. Provider timestamps are seconds, not ms. */
export function unixSecondsToDate(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1000);
}

/**
 * Does this payload reference `sessionId`?
 * Exact match against the ids the payload actually carries — a substring hit
 * on the raw JSON is a candidate filter, never the answer.
 */
export function referencesSession(payload: unknown, sessionId: string): boolean {
  return extractProviderEventFacts(payload).sessionIds.includes(sessionId);
}
