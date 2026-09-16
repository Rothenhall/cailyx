/**
 * Shared constants, status vocabularies and view shapes for G16 (verified
 * commerce, public intake and sales handoff).
 *
 * SQLite has neither enums nor arrays: every status column is a `String` whose
 * permitted values live here as a `readonly` tuple, and every list/object
 * column is a JSON string parsed at the boundary. Nothing in this file holds a
 * secret — the credential references G11 uses are a publishing concern.
 *
 * @module billing.types
 */

// ── Status vocabularies (mirror the schema comments) ──────────────────────

/** `PaymentEvent.status` — the lifecycle of one provider event. */
export const PAYMENT_EVENT_STATUSES = ['pending', 'processed', 'ignored', 'rejected'] as const;
export type PaymentEventStatus = (typeof PAYMENT_EVENT_STATUSES)[number];

/** `Subscription.status` — the provider's subscription lifecycle. */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'past-due',
  'canceled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** `Entitlement.status`. */
export const ENTITLEMENT_STATUSES = ['active', 'expired', 'revoked'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/** `Offer.interval`. */
export const OFFER_INTERVALS = ['one-time', 'monthly', 'yearly'] as const;
export type OfferInterval = (typeof OFFER_INTERVALS)[number];

/**
 * `Offer.code` shape. A code is quoted in checkout metadata and matched
 * server-side, so it is deliberately a slug: lowercase, no spaces, no
 * punctuation that a URL or a JSON key would have to escape.
 */
export const OFFER_CODE_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * A checkout session id, treated as a **bearer capability** by the checkout
 * status read: the browser returning from the provider holds it, and the id is
 * the only thing that authorizes reading that session's status. Bounded and
 * charset-restricted so it cannot be used to smuggle a query.
 */
export const CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,200}$/;

/** Currencies this module will price in. Deliberately a closed set (no FX). */
export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud'] as const;

// ── Views returned over HTTP ──────────────────────────────────────────────

/** An offer, as returned to any caller. Prices are always the stored ones. */
export interface OfferView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Provider price id (`price_...`) this offer is mapped to, if configured. */
  providerPriceId: string | null;
  amountCents: number;
  currency: string;
  interval: string;
  /** Entitlement keys this offer grants when it is paid for. */
  entitlements: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a client is actually allowed to use. */
export interface EntitlementView {
  id: string;
  clientId: string;
  key: string;
  status: string;
  /** The verified PaymentEvent that authorized it. Null for pre-G16 rows. */
  grantedByEventId: string | null;
  subscriptionId: string | null;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface SubscriptionView {
  id: string;
  clientId: string;
  offerId: string | null;
  providerId: string | null;
  providerCustomerId: string | null;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of the payment-event ledger.
 *
 * `payload` is intentionally absent: it holds the provider's raw event, which
 * carries the customer's name, email and address. The list surface returns the
 * shape of the payload instead, and the single-event read (admin only) returns
 * the raw JSON.
 */
export interface PaymentEventView {
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
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
  /** Keys present in the stored payload — a summary, never the values. */
  payloadKeys: string[];
  /** True when this row's payload is retrievable from the single-event read. */
  payloadAvailable: boolean;
}

/** A single payment event including its raw payload (admin surface only). */
export interface PaymentEventDetailView extends PaymentEventView {
  payload: unknown;
}

/**
 * An invoice-shaped line derived from the **verified event ledger**.
 *
 * G16 has no provider invoice API: these rows are what Cailyx itself has
 * confirmed by signature, which is why they are labelled as ledger entries and
 * the response carries a `providerInvoices` disclosure saying whether real
 * provider invoices are available.
 */
export interface LedgerInvoiceView {
  eventId: string;
  clientId: string | null;
  /** Provider event type this line came from, e.g. `invoice.payment_succeeded`. */
  eventType: string;
  subscriptionId: string | null;
  amountCents: number | null;
  currency: string | null;
  status: 'paid' | 'failed' | 'refunded' | 'other';
  occurredAt: string;
  /** True only for events whose signature verified and that were acted on. */
  verified: boolean;
}

/** The verified checkout-status read (PB04). Grants nothing, ever. */
export interface CheckoutStatusView {
  sessionId: string;
  /**
   * `verified`  — a signature-verified event for this session was processed.
   * `pending`   — nothing has been confirmed yet: either no event has arrived
   *               at all (`onRecord: false`), or one arrived and is still being
   *               processed. **Not a failure, and not a grant.**
   * `rejected`  — an event for this session failed signature verification.
   * `ignored`   — a verified event that this server deliberately did not act on.
   */
  status: 'verified' | 'pending' | 'rejected' | 'ignored';
  /** True only for `verified`. A checkout-return page visit can never set it. */
  purchaseVerified: boolean;
  /** Whether any event referencing this session exists in the ledger yet. */
  onRecord: boolean;
  /** The server-side offer resolved from the event, if one matched. */
  offer: Pick<OfferView, 'code' | 'name' | 'amountCents' | 'currency' | 'interval'> | null;
  entitlements: Array<{ key: string; status: string }>;
  /** Why nothing has been granted (or why this event was not acted on). */
  reason: string | null;
  eventType: string | null;
  receivedAt: string | null;
  /** What the returning customer should do next, in plain words. */
  nextAction: string;
}

/** What the public diagnostic request returns (PB03 submission receipt). */
export interface DiagnosticReceiptView {
  /** Stable receipt id for this submission — the Lead row's id. */
  receiptId: string;
  projectId: string;
  leadId: string;
  /**
   * The background job-run id that will carry the work. Null when no run was
   * created (a run of this kind was already queued for the project).
   */
  jobRunId: string | null;
  status: 'queued' | 'received';
  domain: string;
  contactEmail: string;
  submittedAt: string;
  /** Plain-language statement of what happens next, and what does not. */
  nextStep: string;
  /**
   * Why the run will not start itself (no worker entry point for this task
   * kind, or a run already in flight). Null when it was handed to a worker.
   */
  runNotStartedReason: string | null;
  /** True when this exact challenge had already been redeemed (idempotent). */
  duplicate: boolean;
}

/** The capability read — explicit unconfigured states instead of silence. */
export interface BillingCapabilityView {
  webhook: {
    configured: boolean;
    /** Env var the signing secret is read from. Name only, never a value. */
    secretEnvVar: string;
    reason: string | null;
  };
  /** Where checkout links are issued from today (operator-side, pre-G16). */
  checkout: {
    configured: boolean;
    reason: string;
  };
  /** True when the raw request body is available for exact-byte HMAC. */
  rawBodyCapture: {
    enabled: boolean;
    reason: string | null;
  };
  publicIntake: {
    configured: boolean;
    reason: string | null;
    challengeDifficultyBits: number;
  };
}
