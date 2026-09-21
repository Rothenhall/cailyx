/**
 * Competitor cap — plan-tier limits on `BusinessProfile.competitors`
 * (`docs/analysis/client-portal.md` §29, `docs/PLAN.md` §11.6 Phase C6).
 *
 * §29 decided that the number of competitors a client can directly add is
 * capped, tied to plan tier, "same spirit as the prompt-quota enforcement
 * (§20), since each added competitor multiplies measurement-run cost" — but
 * explicitly left the actual per-tier numbers unset ("PRD's own FR-1.3
 * default is '3 to 8 named competitors' as a starting suggestion, not a hard
 * tier-based cap... whoever builds this needs to propose actual per-tier
 * limits").
 *
 * **Proposed numbers (this build, 2026-09-21):**
 *
 * | Tier       | Cap | Reasoning |
 * |------------|-----|-----------|
 * | starter    | 5   | Covers the PRD's own "3 to 8" starting-competitor range without going to its top end; a starter client is the most cost-sensitive tier and 5 tracked competitors is already enough for a first cut of share-of-voice. |
 * | growth     | 15  | 3x starter — mirrors the shape of `refresh-cadence`'s tier jump (starter=weekly -> growth=daily) and `prompt-requests`' §20 quota table (100 -> 300, a 3x step from starter to growth). Enough for a mid-market brand's real competitive set plus a few aspirational/adjacent names. |
 * | scale      | 50  | Another large step up (growth->scale is also 300->1000, ~3.3x, in §20's prompt table) — scale clients are typically tracking a full category, not just direct competitors. 50 is generous without being effectively unlimited (still bounds measurement-run cost predictably). |
 * | enterprise | unlimited (`null`) | Matches §20's own enterprise=unlimited precedent and `refresh-cadence`'s enterprise handling — the top tier is priced to not need a hard ceiling; cost control at that tier is a commercial conversation, not a product gate. |
 *
 * These mirror the existing tier-shaped quotas in the codebase
 * (`refresh-cadence.service.ts#cadenceForTier`, C4's
 * `prompt-requests/plan-tier.util.ts` §20 table: 100/300/1000/unlimited)
 * rather than inventing an unrelated shape. They are a judgment call, not
 * something client-portal.md specified — flagged here and in the module
 * README per that doc's own instruction, and easy to retune from this one
 * file if the real numbers turn out to be wrong.
 *
 * Unlike C4's prompt-request quota (which snapshots `overQuota: true` and
 * lets an admin decide — appropriate there because a prompt *request* is
 * itself a review step), a competitor is a direct, un-reviewed edit (§12).
 * There's no admin approval step in the loop, so this cap **rejects**
 * outright when a save would push the count over the limit, with a
 * dedicated, distinguishable error ({@link CompetitorCapExceededException})
 * the frontend renders as an upsell moment rather than a generic validation
 * failure. See `BusinessProfileService.saveDraft`'s cap check.
 *
 * @module competitor-cap.util
 */

import { HttpException, HttpStatus } from '@nestjs/common';

export type PlanTierSlug = 'starter' | 'growth' | 'scale' | 'enterprise';

const VALID_TIERS: readonly PlanTierSlug[] = ['starter', 'growth', 'scale', 'enterprise'];

/** §29's proposed per-tier competitor cap. `null` = unlimited (enterprise). */
export const COMPETITOR_CAP_BY_TIER: Record<PlanTierSlug, number | null> = {
  starter: 5,
  growth: 15,
  scale: 50,
  enterprise: null,
};

/**
 * Normalize an arbitrary `Client.planTier` string to a known tier slug,
 * defaulting to the most conservative (`starter`) for anything unrecognized —
 * never silently grants a higher limit than the client is known to be on.
 */
export function normalizePlanTier(tier: string | null | undefined): PlanTierSlug {
  return VALID_TIERS.includes(tier as PlanTierSlug) ? (tier as PlanTierSlug) : 'starter';
}

/** The competitor cap for a given plan tier. `null` = unlimited. */
export function competitorCapForTier(tier: string | null | undefined): number | null {
  return COMPETITOR_CAP_BY_TIER[normalizePlanTier(tier)];
}

/** The structured body carried by a {@link CompetitorCapExceededException}. */
export interface CompetitorCapExceededBody {
  /** Stable machine code the frontend switches on to render the upsell state. */
  error: 'competitor-cap-exceeded';
  /** Human-readable message, safe to show as a fallback. */
  message: string;
  /** The normalized plan tier the cap was resolved from. */
  planTier: PlanTierSlug;
  /** The tier's cap (never `null` here — an unlimited tier never throws). */
  competitorCap: number;
  /** The competitor count the rejected save would have produced. */
  requestedCount: number;
}

/**
 * Thrown by `BusinessProfileService.saveDraft` when a save would push the
 * competitor count past the owning client's plan-tier cap. Carries a
 * structured, machine-readable body (HTTP 422) so the client portal can
 * render a targeted "upgrade to track more competitors" upsell rather than a
 * generic validation error.
 */
export class CompetitorCapExceededException extends HttpException {
  constructor(tier: PlanTierSlug, cap: number, requestedCount: number) {
    const body: CompetitorCapExceededBody = {
      error: 'competitor-cap-exceeded',
      message: `The ${tier} plan allows up to ${cap} tracked competitors. Remove one, or upgrade the plan to track more.`,
      planTier: tier,
      competitorCap: cap,
      requestedCount,
    };
    super(body, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
