/**
 * Plan-tier resolution for prompt-request quota checks (client-portal.md
 * §20).
 *
 * §20 names four tiers with tracked-prompt limits (Starter 100 / Growth 300 /
 * Scale 1,000 / Enterprise unlimited). `Client.planTier` (added by Phase C7,
 * merged after this module was first written) is now the real source of
 * truth — see `prompt-requests.service.ts#resolvePlanTier`. The
 * Offer-code-derivation helpers below are kept as the fallback for a client
 * whose `planTier` value is somehow unrecognized (legacy/bad data), not as
 * the primary path anymore.
 *
 * @module plan-tier.util
 */

import type { PlanTierSlug } from './prompt-requests.types';

/** §20's tracked-prompt limits. `null` = unlimited (Enterprise). */
export const PLAN_TIER_PROMPT_LIMITS: Record<PlanTierSlug, number | null> = {
  starter: 100,
  growth: 300,
  scale: 1000,
  enterprise: null,
};

const TIER_MATCH_ORDER: PlanTierSlug[] = ['enterprise', 'scale', 'growth', 'starter'];

/** Type guard for a raw `Client.planTier` string read from the DB. */
export function isPlanTierSlug(value: string | null | undefined): value is PlanTierSlug {
  return value === 'starter' || value === 'growth' || value === 'scale' || value === 'enterprise';
}

/** Matches an `Offer.code`/`Offer.name` against a tier slug by substring, longest/most-specific tier names first so "scale" doesn't accidentally match inside another word. */
export function tierSlugFromOfferText(text: string | null | undefined): PlanTierSlug | null {
  if (!text) return null;
  const normalized = text.toLowerCase();
  for (const tier of TIER_MATCH_ORDER) {
    if (normalized.includes(tier)) return tier;
  }
  return null;
}

export function promptLimitForTier(tier: PlanTierSlug): number | null {
  return PLAN_TIER_PROMPT_LIMITS[tier];
}
