/**
 * ResultsTabsService — the four client Results tabs (§3.3: Website, AI
 * visibility, Online presence, Competitors), phase P15.
 *
 * This service exists for one reason: **the client must read the same domain
 * read models as staff, without the staff-only halves.** Each tab calls the
 * owning module's exported read and narrows the result; none of them
 * re-queries a table the owning module already reads, and none of them
 * recomputes a number. The staff equivalents are `research/website`,
 * `research/ai`, `research/presence` and `research/competitors`, which read the
 * same services and show more.
 *
 * ## §5.7 is the sharp constraint here
 *
 * Two of the three reads have traps that make a naive "just call the service"
 * a violation:
 *
 *  - **Competitors**: `CompetitorsService.gap()` is NOT safe on a read path.
 *    When the project has no tech scan it calls `techStack.scanDomain()`, and
 *    it fetches and scores the client's homepage — a live external fetch and a
 *    scored artefact. So this tab reads the **stored** competitor rows
 *    (`list()`) plus the newest **frozen** comparison snapshot
 *    (`listComparisonSnapshots()` + `getComparisonSnapshot()`), both of which
 *    are pure storage reads. The gap report itself is still reachable — it is
 *    just built by an explicit staff action, not by a page load.
 *  - **Website**: `WebsiteService.overview()` reconciles derived
 *    `WebsiteInsightSnapshot` rows as a side effect (idempotent: an unchanged
 *    insight writes nothing). That is the read the staff website screen already
 *    performs, it is not an audit, a provider refresh, a score or a job, and
 *    re-implementing the health/insight composition here would be exactly the
 *    second read path this phase forbids. It is reused, and the reconcile is
 *    disclosed rather than hidden.
 *
 *  - **Online presence**: no projection is added at all. P05's
 *    `portalInventory()` is already the client-safe presence read, so the tab
 *    wraps that one call in the envelope.
 *
 * Every other read below is a plain storage read.
 *
 * @module results/results-tabs.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AeoVisibilityService } from '../aeo-audit/aeo-visibility.service';
import { CompetitorsService } from '../competitors/competitors.service';
import type { CompetitorWithProfile, GapDiffLine, GapResult } from '../competitors/competitors.service';
import { PresenceService } from '../digital-presence/presence.service';
import { WebsiteService } from '../website/website.service';
import type { OverviewSection, OverviewSectionReasonCode } from './overview.types';
import {
  HEALTH_STATE_LABEL,
  PRESENCE_STATUS_LABEL,
  SURFACE_STATUS_LABEL,
  stateLabel,
  type AiVisibilityTabData,
  type CompetitorsTabData,
  type CompetitorsTabDiffLine,
  type OnlinePresenceTabData,
  type WebsiteTabData,
} from './results-tabs.types';

/** §4.4 — a failed read says this, never the exception that caused it. */
const TAB_UNAVAILABLE_REASON =
  'We could not load this part of your results just now. Everything else on this page is up to date.';

@Injectable()
export class ResultsTabsService {
  private readonly logger = new Logger(ResultsTabsService.name);

  constructor(
    private readonly website: WebsiteService,
    private readonly aeo: AeoVisibilityService,
    private readonly presence: PresenceService,
    private readonly competitors: CompetitorsService,
  ) {}

  // ─── Website ───────────────────────────────────────────────────

  async websiteTab(projectId: string): Promise<OverviewSection<WebsiteTabData>> {
    return this.section('website', projectId, async () => {
      const overview = await this.website.overview(projectId);
      const hasCheck = overview.health.state !== 'unknown';

      const data: WebsiteTabData = {
        health: {
          state: overview.health.state,
          label: stateLabel(HEALTH_STATE_LABEL, overview.health.state),
          issueCount: overview.health.issueCount,
        },
        google: {
          clicks: overview.google.clicks,
          impressions: overview.google.impressions,
          position: overview.google.position,
          sessions: overview.google.sessions,
          clicksWindow: overview.google.clicksWindow,
          sessionsWindow: overview.google.sessionsWindow,
        },
        windows: {
          aligned: overview.windows.aligned,
          note: overview.windows.note,
          coarserComparison: overview.windows.coarserComparison,
          gsc: overview.windows.gsc,
          ga: overview.windows.ga,
        },
        // `ruleId`, `sourceIds` and `pageIdentityId` are dropped: they are
        // storage handles. `sourceCount` survives as a count, because "backed
        // by three sources" is the fact a reader can act on (§4.6).
        insights: overview.insights.map((insight) => ({
          severity: insight.severity,
          message: insight.message,
          limitations: insight.limitations,
          actionTarget: insight.actionTarget,
          sourceCount: insight.sourceIds.length,
          crossSource: insight.crossSource,
        })),
        importantPages: overview.importantPages.map((page) => ({
          title: page.title,
          canonicalUrl: page.canonicalUrl,
          health: page.health,
          healthLabel: stateLabel(HEALTH_STATE_LABEL, page.health),
          clicks: page.clicks,
          organicSessions: page.organicSessions,
          nextAction: page.nextAction,
        })),
        sourceAvailability: {
          technicalCheck: overview.sourceAvailability.technicalCheck,
          searchConsole: overview.sourceAvailability.searchConsole,
          analytics: overview.sourceAvailability.analytics,
        },
        joinLimitation: overview.joinLimitation,
        connectGuidance: overview.connectGuidance,
        hasCheck,
      };

      return hasCheck
        ? this.ok(data)
        : this.empty(data, 'We have not checked your website yet. This fills in after the first check runs.', 'no-data-yet');
    });
  }

  // ─── AI visibility ─────────────────────────────────────────────

  async aiVisibilityTab(projectId: string): Promise<OverviewSection<AiVisibilityTabData>> {
    return this.section(
      'ai',
      projectId,
      async () => {
        const summary = await this.aeo.summary(projectId);
        const data: AiVisibilityTabData = {
          headline: summary.headline,
          status: summary.status,
          statusLabel: stateLabel(SURFACE_STATUS_LABEL, summary.status),
          generatedAt: summary.generatedAt,
          period: summary.period,
          markets: summary.markets,
          appeared: summary.appeared,
          recommended: summary.recommended,
          questionsChecked: summary.questionsChecked,
          totalQuestions: summary.totalQuestions,
          headlines: summary.headlines,
          disclosedFailures: summary.disclosedFailures.map((failure) => ({
            label: failure.label,
            market: failure.market,
            reason: failure.reason,
          })),
          // `accessMode` (api / browser-automation / test-only) is dropped —
          // it is how we collect, not what the client gets.
          surfaces: summary.methodology.surfaces.map((surface) => ({
            label: surface.label,
            status: surface.status,
            statusLabel: stateLabel(SURFACE_STATUS_LABEL, surface.status),
            market: surface.market,
          })),
          details: {
            questionSetVersion: summary.methodology.questionSetVersion,
            tier: summary.methodology.samplingConfig.tier,
            runCount: summary.methodology.samplingConfig.runCount,
          },
          hasAudit: true,
        };
        return this.ok(data);
      },
      // "No audit has run yet" is a fact about the project, not a failure: the
      // owning service reports it as a 404 and the tab renders its empty state.
      (err) => (err instanceof NotFoundException ? 'empty' : 'unavailable'),
    );
  }

  // ─── Online presence ───────────────────────────────────────────

  /**
   * Where the client already exists online.
   *
   * This tab writes no projection of its own on purpose: P05's
   * `PresenceService.portalInventory()` **is** the client-safe read of the
   * presence inventory (it drops the candidate confidence score, the discovery
   * run ids, the internal `foundOn` queries and every spend figure) and the
   * existing `GET /portal/projects/:id/presence` serves it. Wrapping the same
   * call in the section envelope gives the fourth tab the same failure shape as
   * the other three without a second definition of "what a client may see".
   */
  async presenceTab(projectId: string): Promise<OverviewSection<OnlinePresenceTabData>> {
    return this.section('presence', projectId, async () => {
      const inventory = await this.presence.portalInventory(projectId);
      const data: OnlinePresenceTabData = {
        domain: inventory.domain,
        accounts: inventory.accounts.map((account) => ({
          platform: account.platform,
          label: account.label,
          group: account.group,
          url: account.url,
          state: account.state,
          statusLabel: account.statusLabel,
        })),
        relevantNotFound: inventory.relevantNotFound.map((gap) => ({
          platform: gap.platform,
          label: gap.label,
          group: gap.group,
        })),
        counts: inventory.counts,
        hasAccounts: inventory.accounts.length > 0,
      };

      // "We have not found any profile yet" is a fact about the project, not a
      // failure, and the panel keeps its data so it can still say what we looked
      // for. An empty list is never rendered as a zero count.
      return data.hasAccounts
        ? this.ok(data)
        : this.empty(
            data,
            'We have not found any of your online profiles yet. This fills in after the first search runs.',
            'no-data-yet',
          );
    });
  }

  // ─── Competitors ───────────────────────────────────────────────

  /**
   * Competitor rows and the newest **frozen** comparison, both read from
   * storage.
   *
   * Deliberately not `gap()`: that read can scan a domain, fetch a homepage and
   * score it, which §5.7 forbids on a page load. The frozen snapshot is also
   * the better answer for a client — it is the comparison that was actually
   * published, and it stays identical as rivals are added later (§12.3).
   */
  async competitorsTab(projectId: string): Promise<OverviewSection<CompetitorsTabData>> {
    return this.section('competitors', projectId, async () => {
      const rows = await this.competitors.list(projectId);
      if (rows.length === 0) {
        const data = this.emptyCompetitorsData('');
        return this.empty(
          data,
          'We are not tracking any competitors for you yet. Once we are, this is where you will see how you compare.',
          'no-data-yet',
        );
      }

      const snapshots = await this.competitors.listComparisonSnapshots(projectId);
      const latest = snapshots[0] ?? null;
      const gap: GapResult | null = latest
        ? await this.competitors.getComparisonSnapshot(projectId, latest.id)
        : null;

      const data: CompetitorsTabData = {
        domain: gap?.domain ?? '',
        generatedAt: gap?.generatedAt ?? latest?.generatedAt?.toISOString() ?? new Date().toISOString(),
        note: gap?.note
          ? gap.note
          : 'We have not built a full comparison yet. What is here is what our checks have recorded so far.',
        competitors: rows.map((row) => this.toCompetitorRow(row, gap)),
        diffs: {
          presence: this.toDiffBlock(gap?.presence),
          tech: this.toDiffBlock(gap?.tech),
          schema: this.toDiffBlock(gap?.schema),
        },
        reviews: {
          client: (gap?.reviews.client ?? []).map((review) => ({
            label: review.label,
            url: review.url,
            found: review.found,
            rating: review.rating,
            ratingCount: review.ratingCount,
            scale: review.scale,
          })),
          note: gap?.reviews.note ?? '',
        },
        hasCompetitors: true,
      };
      return this.ok(data);
    });
  }

  private toCompetitorRow(row: CompetitorWithProfile, gap: GapResult | null): CompetitorsTabData['competitors'][number] {
    const profile = row.latestProfile;
    // The frozen snapshot is the published comparison, so its row wins where it
    // exists; the stored profile fills anything the snapshot does not carry.
    const fromGap = gap?.competitors.find((candidate) => candidate.name.toLowerCase() === row.name.toLowerCase()) ?? null;
    const aeoStatus = fromGap?.aeoStatus ?? profile?.aeoStatus ?? 'unknown';
    const serpStatus = fromGap?.serpStatus ?? profile?.serpStatus ?? 'unknown';
    const serp = fromGap?.serpPresence ?? profile?.serpPresence ?? null;

    return {
      name: row.name,
      domain: row.domain,
      aeoStatus,
      aeoStatusLabel: stateLabel(PRESENCE_STATUS_LABEL, aeoStatus),
      serpStatus,
      serpStatusLabel: stateLabel(PRESENCE_STATUS_LABEL, serpStatus),
      serp: serp
        ? {
            occurrences: serp.occurrences,
            bestRank: serp.bestRank,
            sampleKeyword: serp.sampleKeyword,
            capturedAt: serp.capturedAt,
          }
        : null,
      presencePlatforms: fromGap?.presencePlatforms ?? profile?.presenceAccounts?.map((account) => account.platform) ?? [],
      seoScore: fromGap?.seoScore ?? profile?.seoScore ?? null,
      seoIssues: fromGap?.seoIssues ?? [],
      // Neither `profile.error` nor `profile.presenceError` is copied: they are
      // provider exception text (§4.4).
      reviews: (fromGap?.reviewRatings ?? []).map((review) => ({
        label: review.label,
        url: review.url,
        found: review.found,
        rating: review.rating,
        ratingCount: review.ratingCount,
        scale: review.scale,
      })),
    };
  }

  private toDiffBlock(block: { client: string[]; clientOnly: GapDiffLine[]; competitorsOnly: GapDiffLine[]; shared: GapDiffLine[] } | undefined) {
    const map = (lines: GapDiffLine[]): CompetitorsTabDiffLine[] =>
      lines.map((line) => ({ key: line.key, competitors: line.competitors, client: line.client }));
    return {
      client: block?.client ?? [],
      // "Where you are ahead" is kept, not hidden: it is the same comparison
      // read in the client's favour, and dropping it would make the tab
      // systematically one-sided.
      clientOnly: map(block?.clientOnly ?? []),
      competitorsOnly: map(block?.competitorsOnly ?? []),
      shared: map(block?.shared ?? []),
    };
  }

  private emptyCompetitorsData(domain: string): CompetitorsTabData {
    return {
      domain,
      generatedAt: new Date().toISOString(),
      note: '',
      competitors: [],
      diffs: {
        presence: { client: [], clientOnly: [], competitorsOnly: [], shared: [] },
        tech: { client: [], clientOnly: [], competitorsOnly: [], shared: [] },
        schema: { client: [], clientOnly: [], competitorsOnly: [], shared: [] },
      },
      reviews: { client: [], note: '' },
      hasCompetitors: false,
    };
  }

  // ─── Envelope ──────────────────────────────────────────────────

  /**
   * One tab is one section, exactly as on the Overview: a failed read produces
   * an `unavailable` tab with a safe sentence and a stable code, never a thrown
   * error and never provider text.
   *
   * `classify` lets a tab say that a particular error means "nothing here yet"
   * rather than "we broke" — the AI visibility read reports a never-run audit
   * as a 404, and showing a client an error for "we have not checked yet"
   * would be both alarming and wrong.
   */
  private async section<T>(
    tab: string,
    projectId: string,
    load: () => Promise<OverviewSection<T>>,
    classify?: (err: unknown) => 'empty' | 'unavailable',
  ): Promise<OverviewSection<T>> {
    try {
      return await load();
    } catch (err) {
      const error = err as Error;
      const kind = classify?.(err) ?? 'unavailable';
      if (kind === 'empty') {
        this.logger.log(`Results tab "${tab}" has nothing yet for project ${projectId}: ${error?.message ?? ''}`);
        return { status: 'empty', data: null, reason: 'We have not checked this yet. It fills in after the first run.', reasonCode: 'no-data-yet' as OverviewSectionReasonCode };
      }
      this.logger.error(
        `Results tab "${tab}" failed for project ${projectId}: ${error?.message ?? String(err)}`,
        error?.stack,
      );
      return { status: 'unavailable', data: null, reason: TAB_UNAVAILABLE_REASON, reasonCode: 'read-failed' };
    }
  }

  private ok<T>(data: T): OverviewSection<T> {
    return { status: 'ok', data, reason: null, reasonCode: null };
  }

  private empty<T>(data: T | null, reason: string, reasonCode: OverviewSectionReasonCode): OverviewSection<T> {
    return { status: 'empty', data, reason, reasonCode };
  }
}
