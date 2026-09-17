/**
 * Website deterministic insight rules (§7.5).
 *
 * Each rule is a pure function: given the fact inputs it needs, it returns
 * one `WebsiteInsight` or `null`. `null` means "disabled for this instance
 * because a required input is missing" — never a fabricated zero/false
 * reading. Wording is the exact phrasing from §7.5's table; nothing here
 * invents a causal claim the evidence does not support.
 *
 * @module website/website-insights.service
 */

import { Injectable } from '@nestjs/common';
import type { JoinedPageFacts, WebsiteInsight } from './website.types';

/** Bump when a rule's threshold or wording changes — stored on every emitted insight. */
export const RULE_VERSIONS: Record<string, number> = {
  'important-page-inaccessible': 1,
  'seen-often-clicked-infrequently': 1,
  'visitors-reach-outdated-page': 1,
  'new-content-no-measurement-yet': 1,
  'search-clicks-vs-organic-sessions-differ': 1,
  'query-opportunity-weak-page': 1,
  'technical-fix-followed-by-improvement': 1,
};

export interface TechnicalPageState {
  accessible: boolean | null; // null = no technical check has run for this page
  lastCheckedAt: string | null;
  sourceId: string | null;
}

export interface PageAnalysisState {
  exists: boolean;
  analyzedOrPublishedAt: string | null;
  structureScore: number | null;
  sourceId: string | null;
}

/** One dated, verified technical fix — the evidence `technical-fix-followed-by-improvement` requires. */
export interface FixEvent {
  date: string; // ISO
  description: string;
  sourceId: string;
  /**
   * "site" for a check that passes project-wide, "page" for an issue observed
   * to disappear on this specific URL. The rule reports whichever it was given
   * rather than implying every fix was measured on the page in question.
   */
  origin?: 'site' | 'page';
}

export interface InsightRuleInput {
  page: JoinedPageFacts;
  technical: TechnicalPageState;
  pageAnalysis: PageAnalysisState | null;
  fixes: FixEvent[];
  /** Site-average CTR across pages with search data, for a "comparable scope" CTR comparison. Null if too few pages. */
  siteAverageCtr: number | null;
}

const insight = (
  ruleId: keyof typeof RULE_VERSIONS,
  page: JoinedPageFacts,
  severity: WebsiteInsight['severity'],
  message: string,
  limitations: string,
  actionTarget: string,
  sourceIds: string[],
  facts: Record<string, unknown>,
): WebsiteInsight => ({
  ruleId,
  ruleVersion: RULE_VERSIONS[ruleId],
  severity,
  message,
  limitations,
  actionTarget,
  sourceIds,
  pageIdentityId: page.pageIdentityId,
  crossSource: new Set(sourceIds).size > 1,
  facts,
});

/**
 * Stable extract ids the rules reference, so every emitted insight points at
 * the exact source extract it fired on (§7.5 "source IDs").
 */
export const SOURCE_IDS = {
  gsc: 'gsc-page-query-date-facts',
  ga: 'ga-landing-session-facts',
} as const;

@Injectable()
export class WebsiteInsightsService {
  /** Runs all 7 rules for one page's joined facts. Missing-input rules simply produce nothing. */
  evaluatePage(input: InsightRuleInput): WebsiteInsight[] {
    const out: WebsiteInsight[] = [];
    for (const fn of [
      this.importantPageInaccessible,
      this.seenOftenClickedInfrequently,
      this.visitorsReachOutdatedPage,
      this.newContentNoMeasurementYet,
      this.searchClicksVsOrganicSessionsDiffer,
      this.queryOpportunityWeakPage,
      this.technicalFixFollowedByImprovement,
    ]) {
      const r = fn.call(this, input);
      if (r) out.push(r);
    }
    return out;
  }

  private importantPageInaccessible(i: InsightRuleInput): WebsiteInsight | null {
    const { page, technical } = i;
    if (technical.accessible !== false) return null; // no failed check → disabled, not "pass"
    if (!page.search.available) return null; // demand evidence required; no GSC → disabled
    const hadDemand = page.search.impressions > 0 || page.search.clicks > 0;
    if (!hadDemand) return null;
    return insight(
      'important-page-inaccessible',
      page,
      'high',
      'This page receives search interest but could not be opened in our latest check.',
      'Based on the most recent technical check and Search Console demand for the same page identity; a transient fetch failure cannot be ruled out.',
      'Inspect issue; assign fix',
      [technical.sourceId, SOURCE_IDS.gsc].filter(Boolean) as string[],
      { impressions: page.search.impressions, clicks: page.search.clicks, lastCheckedAt: technical.lastCheckedAt },
    );
  }

  private seenOftenClickedInfrequently(i: InsightRuleInput): WebsiteInsight | null {
    const { page, siteAverageCtr } = i;
    if (!page.search.available || siteAverageCtr == null) return null;
    const MIN_IMPRESSIONS = 500;
    if (page.search.impressions < MIN_IMPRESSIONS) return null;
    if (page.search.ctr >= siteAverageCtr * 0.5) return null; // not "infrequent" relative to comparable scope
    return insight(
      'seen-often-clicked-infrequently',
      page,
      'medium',
      'People see this page in Google, but relatively few click it.',
      `Compared against this project's average click-through rate (${(siteAverageCtr * 100).toFixed(1)}%) over the same window; does not account for intent mismatch or seasonal query mix.`,
      'Review title/description',
      [SOURCE_IDS.gsc],
      { impressions: page.search.impressions, ctr: page.search.ctr, siteAverageCtr },
    );
  }

  private visitorsReachOutdatedPage(i: InsightRuleInput): WebsiteInsight | null {
    const { page, pageAnalysis } = i;
    if (!page.visitors.available || page.visitors.sessions <= 0) return null;
    if (!pageAnalysis?.analyzedOrPublishedAt) return null; // no dated content evidence → disabled
    const ageDays = (Date.now() - new Date(pageAnalysis.analyzedOrPublishedAt).getTime()) / 86_400_000;
    const STALE_DAYS = 365;
    if (ageDays < STALE_DAYS) return null;
    return insight(
      'visitors-reach-outdated-page',
      page,
      'medium',
      'People are landing on a page due for an update.',
      'Based on landing sessions for this page identity and the last content analysis date; page-analysis date may lag a manual edit made outside Cailyx.',
      'Open refresh',
      [pageAnalysis.sourceId ?? 'page-analysis', SOURCE_IDS.ga],
      { sessions: page.visitors.sessions, contentAgeDays: Math.round(ageDays) },
    );
  }

  private newContentNoMeasurementYet(i: InsightRuleInput): WebsiteInsight | null {
    const { page, pageAnalysis } = i;
    if (!pageAnalysis?.analyzedOrPublishedAt) return null;
    const ageDays = (Date.now() - new Date(pageAnalysis.analyzedOrPublishedAt).getTime()) / 86_400_000;
    const NEW_DAYS = 14;
    if (ageDays > NEW_DAYS) return null;
    // "No eligible search observation window" — either no GSC connected, or
    // the GSC window's start predates or is within the publish date (too
    // little post-publish signal to have accumulated yet).
    const hasEligibleWindow =
      page.search.available && page.search.window != null && new Date(page.search.window.startDate) > new Date(pageAnalysis.analyzedOrPublishedAt);
    if (hasEligibleWindow) return null;
    return insight(
      'new-content-no-measurement-yet',
      page,
      'low',
      'This page is new. We need more data before assessing its performance.',
      'Publication/analysis date is recent enough that a full search-observation window has not yet elapsed.',
      'Monitor, not declare failure',
      [pageAnalysis.sourceId ?? 'page-analysis'],
      { ageDays: Math.round(ageDays) },
    );
  }

  private searchClicksVsOrganicSessionsDiffer(i: InsightRuleInput): WebsiteInsight | null {
    const { page } = i;
    if (!page.search.available || !page.visitors.available) return null;
    if (!page.search.window || !page.visitors.window) return null;
    const clicks = page.search.clicks;
    const sessions = page.visitors.sessions;
    const denom = Math.max(clicks, sessions, 1);
    const relDiff = Math.abs(clicks - sessions) / denom;
    if (relDiff < 0.3) return null; // both extracts agree closely enough not to call out
    return insight(
      'search-clicks-vs-organic-sessions-differ',
      page,
      'low',
      'Google clicks and website visits use different counting methods.',
      `Search Console counts in ${page.search.window.timezoneNote}; Analytics counts in ${page.visitors.window.timezoneNote}. Day boundaries and definitions (a click vs. a session) are not identical, so totals are expected to diverge — this is not flagged as a defect.`,
      'Explain; do not flag every mismatch as a bug',
      [SOURCE_IDS.gsc, SOURCE_IDS.ga],
      { clicks, sessions },
    );
  }

  private queryOpportunityWeakPage(i: InsightRuleInput): WebsiteInsight | null {
    const { page, pageAnalysis } = i;
    if (!page.search.available || !pageAnalysis || pageAnalysis.structureScore == null) return null;
    const candidate = page.search.topQueries.find((q) => q.impressions >= 50 && q.position <= 20);
    if (!candidate) return null;
    const WEAK_SCORE = 60;
    if (pageAnalysis.structureScore >= WEAK_SCORE) return null;
    return insight(
      'query-opportunity-weak-page',
      page,
      'medium',
      'This page appears for a useful search, but its content could answer the question more clearly.',
      'Based on an observed query/page relation from Search Console and this page\'s deterministic content-structure score; the query is related evidence, not a proven cause of the score.',
      'Open content plan',
      [SOURCE_IDS.gsc, pageAnalysis.sourceId ?? 'page-analysis'],
      { query: candidate.query, impressions: candidate.impressions, position: candidate.position, structureScore: pageAnalysis.structureScore },
    );
  }

  private technicalFixFollowedByImprovement(i: InsightRuleInput): WebsiteInsight | null {
    const { page, fixes } = i;
    if (!fixes.length) return null;
    if (!page.search.available && !page.visitors.available) return null;
    const fix = fixes[0]; // most recent verified fix
    const fixTime = new Date(fix.date).getTime();
    // Require the observation window to start at/after the fix, i.e. the
    // extract is actually "later" evidence, not incidentally overlapping.
    const searchLater = page.search.window && new Date(page.search.window.startDate).getTime() >= fixTime;
    const visitorsLater = page.visitors.window && new Date(page.visitors.window.startDate).getTime() >= fixTime;
    if (!searchLater && !visitorsLater) return null;
    const improved = (page.search.clicks > 0 && searchLater) || (page.visitors.sessions > 0 && visitorsLater);
    if (!improved) return null;
    return insight(
      'technical-fix-followed-by-improvement',
      page,
      'low',
      'Results improved after this change; other factors may also have contributed.',
      `Correlational: a verified fix date precedes a later observation window showing activity. This is not a controlled comparison and does not prove the fix caused the change. The fix was recorded ${fix.origin === 'page' ? 'on this page' : 'site-wide'}, and the later evidence is the whole-window extract rather than a like-for-like before/after period.`,
      'Review supporting history',
      [fix.sourceId],
      { fixDate: fix.date, fixDescription: fix.description, fixOrigin: fix.origin ?? 'site' },
    );
  }
}
