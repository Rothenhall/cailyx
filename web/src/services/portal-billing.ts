import { api, unwrap } from '@/lib/api';

/**
 * Client-side billing adapter (design_plan G16) — CP15's "service scope" and
 * invoices section.
 *
 * Route: `@ClientPortal() @Controller('portal/billing')` in
 * `backend/src/modules/billing/billing-portal.controller.ts`. Everything here
 * is **read-only by design**: a client cannot buy, cancel or revoke from the
 * portal. Purchases happen at the provider, and a cancellation is either driven
 * by a signed provider event or performed by an operator — letting the portal
 * change its own entitlement state would create a second way to grant access.
 *
 * Three disclosures are part of this surface rather than optional extras:
 *
 *  - `providerInvoices.configured: false` — these lines are Cailyx's own
 *    signature-verified payment events, **not** provider-issued invoice
 *    documents. A screen must say so.
 *  - `customerPortal.available: false` with a reason — never a URL that does
 *    not work.
 *  - Every entitlement row, including expired and revoked ones: a revoked
 *    entitlement is a fact the client is entitled to see, not something to hide.
 *
 * Provider identifiers (`providerId`, `providerCustomerId`) are deliberately
 * absent from the interfaces below — they are not the client's account
 * reference and have no place on this surface.
 *
 * @module services/portal-billing
 */

export interface PortalSubscription {
  id: string;
  offerId: string | null;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortalEntitlement {
  id: string;
  /** The capability key the client is allowed to use. */
  key: string;
  status: string;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * An invoice-shaped line built from the **verified** payment-event ledger.
 * Carries no provider customer details — the ledger view never exposes the
 * stored payload.
 */
export interface PortalInvoiceLine {
  eventId: string;
  eventType: string;
  subscriptionId: string | null;
  amountCents: number | null;
  currency: string | null;
  status: string;
  occurredAt: string;
  /** True when the provider's signature on the event was verified. */
  verified: boolean;
}

export interface PortalInvoices {
  invoices: PortalInvoiceLine[];
  providerInvoices: { configured: boolean; reason: string };
}

export interface PortalCustomerPortalState {
  available: boolean;
  /** Why it is unavailable, when it is — never a dead link. */
  reason: string;
  subscription: PortalSubscription | null;
  entitlements: PortalEntitlement[];
}

export async function listPortalSubscriptions(options?: { signal?: AbortSignal }) {
  const payload = await api.get<unknown>('/portal/billing/subscriptions', options);
  return unwrap<PortalSubscription[]>(payload, 'subscriptions');
}

export async function listPortalEntitlements(options?: { signal?: AbortSignal }) {
  const payload = await api.get<unknown>('/portal/billing/entitlements', options);
  return unwrap<PortalEntitlement[]>(payload, 'entitlements');
}

export async function listPortalInvoices(options?: { signal?: AbortSignal }) {
  return api.get<PortalInvoices>('/portal/billing/invoices', options);
}

export async function getPortalCustomerPortalState(options?: { signal?: AbortSignal }) {
  return api.get<PortalCustomerPortalState>('/portal/billing/customer-portal', options);
}
