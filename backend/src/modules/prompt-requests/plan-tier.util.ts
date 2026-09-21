/**
 * Plan-tier resolution for prompt-request quota checks (client-portal.md
 * §20).
 *
 * §20 names four tiers with tracked-prompt limits (Starter 100 / Growth 300 /
 * Scale 1,000 / Enterprise unlimited), but — per a direct check of `Client`,
 * `Subscription`, `Offer` and `Entitlement` in `backend/prisma/schema.prisma`
 * — **no model has a clean, queryable "plan tier" field anywhere in this
 * codebase.** `Offer.code` is the closest thing to a price-tier identity
 * (`billing/README.md`: "`Offer` is the only price authority"), so this is
 * the smallest-correct read: resolve the client's most recent subscription
 * with `status` in ('active', 'trialing', 'past-due') -> its `Offer.code`,
 * and match that code, case-insensitively, against the four tier slugs. A
 * client with no matching subscription/offer is treated as Starter (the most
 * conservative default — never silently grants a higher limit than paid
 * for).
 *
 * This is a judgment call, flagged here and in the module README, not a
 * discovery of an existing field. If a real `planTier` field is added to
 * `Client`/`Subscription` later, this is the only file that needs to change.
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
