/**
 * Applicability policy — P05 §11.2.
 *
 * Extends the existing category-based `EXPECTED_BY_PROFILE` inference (still
 * the base signal) into the structured shape the plan asks for: every platform
 * gets `{ status, reason, ruleVersion }`, not just a yes/no "expected" flag.
 *
 * This is the ONE place that decides whether a platform matters for a given
 * project. Every other consumer — the collector's SERP targeting, the missing-
 * profile gap list, the UI groups, and the assessment/coverage notes — reads
 * this output rather than re-deriving its own opinion. That is the exit gate:
 * "hiding a Google Business Profile tab but still subtracting points for its
 * absence is a bug." Nothing here computes or contributes to a score; absence
 * of a `not-relevant` platform is never treated as a finding.
 *
 * Two layers:
 *  1. A pure, deterministic default computed from business type + delivery
 *     model + local-customer-presence + markets (all heuristics over text
 *     already on file — this module does not invent new structured fields).
 *  2. A persisted override (`PresenceApplicabilityOverride`) that a staff/
 *     client action can set. Overrides are versioned (superseded, never
 *     mutated in place) and always win over the computed default — and,
 *     because they are a separate table, they survive rediscovery runs, which
 *     only ever touch `PresenceAccount`.
 *
 * @module presence.applicability.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import {
  BusinessProfile,
  EXPECTED_BY_PROFILE,
  inferBusinessProfile,
  PLATFORM_LABELS,
  PRESENCE_PLATFORMS,
  type PresencePlatform,
} from './presence.types';

/** Current rules engine version. Bump when the heuristics below change meaning. */
export const APPLICABILITY_RULE_VERSION = 'applicability-v1';

export type ApplicabilityStatus = 'relevant' | 'optional' | 'not-relevant' | 'needs-confirmation';

export interface PlatformApplicability {
  platform: PresencePlatform;
  label: string;
  status: ApplicabilityStatus;
  reason: string;
  ruleVersion: string;
  /** True when a staff/client override is in force for this platform. */
  overridden: boolean;
}

@Injectable()
export class PresenceApplicabilityService {
  private readonly logger = new Logger(PresenceApplicabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProfile: BusinessProfileService,
  ) {}

  /**
   * Full per-platform applicability for a project: computed default, then
   * active overrides applied on top.
   */
  async forProject(projectId: string, category: string | null): Promise<PlatformApplicability[]> {
    const [confirmed, countries, overrides] = await Promise.all([
      this.businessProfile.getConfirmedProfile(projectId).catch(() => null),
      this.businessProfile.getConfirmedTargetCountries(projectId).catch(() => [] as string[]),
      this.activeOverrides(projectId),
    ]);

    const businessType = inferBusinessProfile(category ?? confirmed?.data.description ?? null);
    const signals = this.deliverySignals(category, confirmed?.data.description ?? null, confirmed?.data.services ?? []);
    const hasMultipleMarkets = countries.length > 1;
    const hasNoConfirmedMarket = countries.length === 0;

    const computed = PRESENCE_PLATFORMS.filter((p) => p !== 'other').map((platform) =>
      this.computeDefault(platform, businessType, signals, hasMultipleMarkets, hasNoConfirmedMarket),
    );

    const overrideByPlatform = new Map(overrides.map((o) => [o.platform, o]));
    return computed.map((c) => {
      const ov = overrideByPlatform.get(c.platform);
      if (!ov) return c;
      return {
        platform: c.platform,
        label: c.label,
        status: ov.status as ApplicabilityStatus,
        reason: ov.reason,
        ruleVersion: ov.ruleVersion,
        overridden: true,
      };
    });
  }

  /** Convenience: only the platforms currently `relevant` or `optional`. */
  async relevantOrOptional(projectId: string, category: string | null): Promise<PresencePlatform[]> {
    const all = await this.forProject(projectId, category);
    return all.filter((a) => a.status === 'relevant' || a.status === 'optional').map((a) => a.platform);
  }

  // ─── Default computation ────────────────────────────────────────────────

  private deliverySignals(
    category: string | null,
    description: string | null,
    services: string[],
  ) {
    const text = [category ?? '', description ?? '', services.join(' ')].join(' ').toLowerCase();
    return {
      // "Delivery model" — remote/online-only vs a business with a physical,
      // walk-in customer presence. Heuristic over the same client-authored text
      // the existing business-type inference already uses; no new structured
      // field is invented here.
      onlineOnly: /\b(saas|software|platform|api|remote|online-only|cloud|app|digital product)\b/.test(text)
        && !/\b(store|shop|clinic|office|showroom|walk-in|in-person|branch|location)\b/.test(text),
      hasLocalPresence: /\b(store|shop|clinic|office|showroom|walk-in|in-person|branch|location|near you|local)\b/.test(text),
      isMobileApp: /\b(mobile app|ios app|android app|app store|play store)\b/.test(text),
      isConsultancy: /\b(consult|advisor|agency|firm|professional services)\b/.test(text),
    };
  }

  private computeDefault(
    platform: PresencePlatform,
    businessType: BusinessProfile,
    signals: ReturnType<PresenceApplicabilityService['deliverySignals']>,
    hasMultipleMarkets: boolean,
    hasNoConfirmedMarket: boolean,
  ): PlatformApplicability {
    const label = PLATFORM_LABELS[platform];
    const expectedSet = EXPECTED_BY_PROFILE[businessType] ?? EXPECTED_BY_PROFILE.default;
    const ruleVersion = APPLICABILITY_RULE_VERSION;

    // Local, physical-location-dependent listings: relevant for a local-services
    // business, actively NOT presumed for an online-only SaaS (plan §11.2's own
    // worked example), needs-confirmation otherwise.
    const LOCAL_LISTING: PresencePlatform[] = ['yelp'];
    if (LOCAL_LISTING.includes(platform)) {
      if (signals.hasLocalPresence) {
        return { platform, label, status: 'relevant', reason: 'This business has a physical/local customer presence.', ruleVersion, overridden: false };
      }
      if (signals.onlineOnly) {
        return {
          platform,
          label,
          status: 'not-relevant',
          reason: 'Online-only delivery with no physical customer presence — a local listing is not presumed required.',
          ruleVersion,
          overridden: false,
        };
      }
      if (businessType === 'default') {
        return { platform, label, status: 'needs-confirmation', reason: 'Business type not yet confirmed — local relevance is unclear.', ruleVersion, overridden: false };
      }
      return { platform, label, status: expectedSet.includes(platform) ? 'relevant' : 'optional', reason: `Default expectation for ${businessType}.`, ruleVersion, overridden: false };
    }

    // App-store listings: relevant only when a mobile app is actually indicated.
    if (platform === 'app-store' || platform === 'play-store') {
      if (signals.isMobileApp) {
        return { platform, label, status: 'relevant', reason: 'A mobile app is described for this business.', ruleVersion, overridden: false };
      }
      return { platform, label, status: 'not-relevant', reason: 'No mobile app is described for this business.', ruleVersion, overridden: false };
    }

    // Personal-identity hosts are never a company applicability question.
    if (platform === 'scholar' || platform === 'orcid') {
      return { platform, label, status: 'not-relevant', reason: 'Personal-identity host, not part of the company footprint.', ruleVersion, overridden: false };
    }

    // Everything else: business-type expected set is `relevant`; a short list of
    // near-neighbours is `optional`; the rest is `not-relevant` unless the
    // business type itself is unconfirmed, in which case ask rather than guess
    // (plan: "uncertain classification asks a question; it does not penalize
    // the score").
    if (expectedSet.includes(platform)) {
      return { platform, label, status: 'relevant', reason: `Default expectation for ${PROFILE_REASON[businessType]}.`, ruleVersion, overridden: false };
    }

    if (businessType === 'default') {
      return {
        platform,
        label,
        status: hasNoConfirmedMarket ? 'needs-confirmation' : 'optional',
        reason: 'Business type not yet confirmed, so relevance cannot be decided with confidence.',
        ruleVersion,
        overridden: false,
      };
    }

    // A consultancy: consumer social channels matter less than professional
    // directories (plan's own example) — mark the consumer-social set optional
    // rather than not-relevant, since it can still matter.
    if (businessType === 'b2b-services' && (platform === 'instagram' || platform === 'tiktok' || platform === 'pinterest')) {
      return { platform, label, status: 'optional', reason: 'Consumer social channels matter less for a consultancy than professional directories.', ruleVersion, overridden: false };
    }

    void hasMultipleMarkets; // reserved for a future market-specific directory rule
    return { platform, label, status: 'optional', reason: `Not in the default expected set for ${PROFILE_REASON[businessType]}, but may still be worth holding.`, ruleVersion, overridden: false };
  }

  // ─── Overrides ───────────────────────────────────────────────────────────

  private async activeOverrides(projectId: string) {
    return this.prisma.presenceApplicabilityOverride.findMany({
      where: { projectId, supersededAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Staff/client sets an explicit applicability status for one platform.
   * Versioned: the prior active override (if any) is marked superseded, never
   * deleted or mutated, and the new row becomes the one every read sees —
   * including after a rediscovery run, since discovery never touches this table.
   */
  async setOverride(
    projectId: string,
    platform: PresencePlatform,
    status: ApplicabilityStatus,
    reason: string,
    actorEmail: string | null,
  ): Promise<PlatformApplicability> {
    await this.prisma.presenceApplicabilityOverride.updateMany({
      where: { projectId, platform, supersededAt: null },
      data: { supersededAt: new Date() },
    });
    const row = await this.prisma.presenceApplicabilityOverride.create({
      data: { projectId, platform, status, reason, ruleVersion: APPLICABILITY_RULE_VERSION, actorEmail },
    });
    this.logger.log(`Applicability override set: project=${projectId} platform=${platform} status=${status} by=${actorEmail ?? 'unknown'}`);
    return {
      platform,
      label: PLATFORM_LABELS[platform],
      status: row.status as ApplicabilityStatus,
      reason: row.reason,
      ruleVersion: row.ruleVersion,
      overridden: true,
    };
  }
}

const PROFILE_REASON: Record<BusinessProfile, string> = {
  'b2b-services': 'a B2B services / consultancy business',
  'b2b-saas': 'a B2B software business',
  'local-services': 'a local services business',
  'consumer-brand': 'a consumer brand',
  default: 'the generic default set (business type not identified)',
};
