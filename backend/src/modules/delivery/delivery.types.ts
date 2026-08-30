/**
 * Types for the Delivery module (PRD §6.11 — email, Lead CRM, CTA logging,
 * Stripe monetization).
 *
 * @module delivery.types
 */

export const LEAD_SOURCES = ['bulk', 'api', 'form', 'scorecard'] as const;
export const LEAD_STATUSES = ['new', 'reached', 'booked', 'won', 'lost'] as const;
export const CTA_EVENT_TYPES = ['book-call', 'review-ask', 'upgrade-click'] as const;
export const UPGRADE_TIERS = ['full', 'monitoring'] as const;
export const UPGRADE_STATUSES = ['created', 'clicked', 'completed', 'abandoned'] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type CtaEventType = (typeof CTA_EVENT_TYPES)[number];
export type UpgradeTier = (typeof UPGRADE_TIERS)[number];
export type UpgradeStatus = (typeof UPGRADE_STATUSES)[number];

/** One logged CTA click (FR-11.3) inside the lead's event log. */
export interface CtaEvent {
  type: CtaEventType;
  at: string;
  meta?: Record<string, unknown>;
}

export interface DeliveryEmailResult {
  delivered: boolean;
  messageId?: string;
  to: string;
  reportUrl: string;
  /** Set when Plunk is configured but the send failed — never a silent loss. */
  error?: string;
}

export interface UpgradeView {
  id: string;
  projectId: string;
  leadId?: string | null;
  /** Validated enum at the boundary; plain string on the wire view. */
  tier: string;
  status: string;
  checkoutUrl?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

/** Slack/checkout env mapping per tier (option A in docs/analysis/wave-5.md §3.3). */
export const CHECKOUT_URL_ENV: Record<UpgradeTier, string> = {
  full: 'STRIPE_CHECKOUT_URL_FULL',
  monitoring: 'STRIPE_CHECKOUT_URL_MONITORING',
};