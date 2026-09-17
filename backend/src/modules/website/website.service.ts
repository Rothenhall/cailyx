/**
 * Website (P12) — unified read model over technical checks, Google Search
 * Console, Google Analytics and page-analysis, joined through a shared page
 * identity.
 *
 * Read paths (`overview`, `pages`, `pageDetail`) are 100% from storage —
 * TechnicalAudit/AuditPage, PageAnalysis, and GoogleDataSnapshot rows this
 * module already has. They never call Google or re-run a crawl (§7.6: a
 * read must never trigger a new paid/live audit or provider refresh).
 *
 * `syncGoogleData` is the one place that calls Google, and it is only ever
 * invoked from an explicit sync endpoint, never from a GET.
 *
 * §7.4's two hard rules are enforced structurally, not by convention:
 *
 *  - **No fanout.** GSC rows are summed to page grain *within GSC's own rows
 *    only*; GA rows are summed to page grain *within GA's own rows only*.
 *    The two page-level totals are then attached side by side and are never
 *    combined arithmetically. A page with N query rows and one session row
 *    therefore has N queries and one-session-count sessions — the query count
 *    cannot multiply the session count, because the GA loop never reads a GSC
 *    row. Clicks, sessions, users and page views stay in their own units and
 *    are never summed interchangeably.
 *  - **No fabrication.** No code path attaches a query to an individual
 *    session, and no per-query session/conversion figure exists anywhere in
 *    this module — the aggregate APIs cannot support one. The two extracts are
 *    presented as related aggregate evidence under `JOIN_LIMITATION`.
 *
 * @module website/website.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SearchConsoleService } from '../google/search-console.service';
import { AnalyticsService } from '../google/analytics.service';
import { GoogleConnectionService } from '../google/google-connection.service';
import { normalizePageUrl } from './page-identity.util';
import { WebsiteInsightsService, type FixEvent, type PageAnalysisState, type TechnicalPageState } from './website-insights.service';
import type {
  FactScope,
  HealthState,
  JoinLimitation,
  JoinedPageFacts,
  PageAnalysisRowLike,
  RefreshRecommendation,
  SourceAvailability,
  SourceAvailabilityEntry,
  WebsiteInsight,
  WebsiteOverview,
  WebsitePageChange,
  WebsitePageDetail,
  WindowAlignment,
} from './website.types';

interface FactWindow {
  startDate: string;
  endDate: string;
  timezoneNote: string;
}

/** §7.4's no-fabrication statement, stated once for every screen that shows both extracts. */
export const JOIN_LIMITATION: JoinLimitation = {
  querySideLabel: 'Queries leading to this page',
  sessionSideLabel: 'Visitors landing on this page',
  statement:
    'These are two related aggregate extracts, not a per-visit link. Search Console returns grouped question-level rows for a page; Analytics returns landing sessions for a page. Neither API can attach a specific organic query to an individual session, and UTM parameters do not supply that missing linkage — so no per-query session or conversion figure is shown here, and none should be inferred.',
};

const GSC_CLOCK = 'Pacific time (America/Los_Angeles) per the Search Analytics API';

@Injectable()
export class WebsiteService {
  private readonly logger = new Logger(WebsiteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gsc: SearchConsoleService,
    private readonly ga: AnalyticsService,
    private readonly connections: GoogleConnectionService,
    private readonly insights: WebsiteInsightsService,
  ) {}

  /* ── page identity ──────────────────────────────────────────────────── */

  /** Idempotent upsert of a normalized page identity, keeping every raw URL it was built from. */
  private async upsertIdentity(projectId: string, rawUrl: string) {
    const n = normalizePageUrl(rawUrl);
    const existing = await this.prisma.websitePageIdentity.findUnique({
      where: { projectId_canonicalUrl: { projectId, canonicalUrl: n.canonicalUrl } },
    });
    if (existing) {
      const raws: string[] = JSON.parse(existing.sourceUrls || '[]');
      if (!raws.includes(rawUrl)) {
        await this.prisma.websitePageIdentity.update({
          where: { id: existing.id },
          data: { sourceUrls: JSON.stringify([...raws, rawUrl]) },
        });
      }
      return existing;
    }
    return this.prisma.websitePageIdentity.create({
      data: { projectId, canonicalUrl: n.canonicalUrl, host: n.host, path: n.path, sourceUrls: JSON.stringify([rawUrl]) },
    });
  }

  /* ── Google data extension sync (the only live-call path) ─────────────── */

  /**
   * Explicit sync — fetches GSC page/query/date/country/device facts + GA
   * landing-session facts and stores them at the source's own grain. Never
   * called from a GET (§7.6).
   */
  async syncGoogleData(userId: string, projectId: string, days = 28): Promise<{ gsc: boolean; ga: boolean }> {
    const result = { gsc: false, ga: false };

    const gscResource = await this.connections.getProjectResource(projectId, 'search-console');
    if (gscResource) {
      try {
        const facts = await this.gsc.pageFacts(userId, gscResource.resourceId, {
          days,
          // §7.3's approved grain: page/query/date/country/device. Country and
          // device are carried so the page detail can state the actual
          // location/device scope of the observation rather than implying
          // site-wide, all-device coverage it did not measure.
          dimensions: ['page', 'query', 'date', 'country', 'device'],
          rowLimit: 5000,
        });
        await this.prisma.googleDataSnapshot.create({
          data: {
            projectId,
            service: 'search-console',
            kind: 'page-query-date',
            windowStart: facts.range.startDate,
            windowEnd: facts.range.endDate,
            timezoneNote: facts.timezoneNote,
            rows: JSON.stringify(facts.rows),
            rowCount: facts.rowCount,
            complete: facts.complete,
          },
        });
        for (const r of facts.rows) if (r.page) await this.upsertIdentity(projectId, r.page);
        result.gsc = true;
      } catch (e) {
        this.logger.warn(`GSC sync failed for project ${projectId}: ${(e as Error).message}`);
      }
    }

    const gaResource = await this.connections.getProjectResource(projectId, 'analytics');
    if (gaResource) {
      try {
        const facts = await this.ga.landingSessionFacts(userId, gaResource.resourceId, { days, limit: 5000 });
        await this.prisma.googleDataSnapshot.create({
          data: {
            projectId,
            service: 'analytics',
            kind: 'landing-session',
            windowStart: facts.range.startDate,
            windowEnd: facts.range.endDate,
            timezoneNote: facts.timezoneNote,
            rows: JSON.stringify(facts.rows),
            rowCount: facts.rowCount,
            complete: facts.complete,
          },
        });
        for (const r of facts.rows) if (r.landingPage) await this.upsertIdentity(projectId, r.landingPage);
        result.ga = true;
      } catch (e) {
        this.logger.warn(`GA sync failed for project ${projectId}: ${(e as Error).message}`);
      }
    }

    return result;
  }

  /* ── read model ─────────────────────────────────────────────────────── */

  private async latestSnapshot(projectId: string, service: string, kind: string) {
    return this.prisma.googleDataSnapshot.findFirst({
      where: { projectId, service, kind },
      orderBy: { fetchedAt: 'desc' },
    });
  }

  /** §7.4: how the two extracts' periods relate — disclosed, never relabeled as equal. */
  private windowAlignment(
    gscSnap: { windowStart: string; windowEnd: string; timezoneNote: string } | null,
    gaSnap: { windowStart: string; windowEnd: string; timezoneNote: string } | null,
  ): WindowAlignment {
    const gsc = gscSnap ? { startDate: gscSnap.windowStart, endDate: gscSnap.windowEnd, timezoneNote: gscSnap.timezoneNote } : null;
    const ga = gaSnap ? { startDate: gaSnap.windowStart, endDate: gaSnap.windowEnd, timezoneNote: gaSnap.timezoneNote } : null;

    if (!gsc || !ga) {
      return {
        aligned: false,
        note:
          gsc && !ga
            ? 'Only Google Search data is available. Search Console reports in Pacific time; there is no Analytics extract to compare it against, so no visitor figures are shown.'
            : ga && !gsc
              ? 'Only Google Analytics data is available. Analytics reports in the property timezone; there is no Search Console extract to compare it against, so no query/click figures are shown.'
              : 'No Google data has been synced for this project yet, so there is no common period to compare.',
        coarserComparison: true,
        gsc,
        ga,
      };
    }

    const sameRange = gsc.startDate === ga.startDate && gsc.endDate === ga.endDate;

    if (sameRange) {
      // The periods match, so whole-window totals are comparable. The two
      // clocks are still named: Search Console counts in Pacific time and
      // Analytics in the property timezone, so a *daily* breakdown would not
      // line up even here — which is exactly why no daily comparison is
      // offered against these extracts.
      return {
        aligned: true,
        note: `Google Search and Google Analytics both cover ${gsc.startDate}–${gsc.endDate}, so the two totals describe the same period. They still count on different clocks (${gsc.timezoneNote}; ${ga.timezoneNote}), so day-by-day figures in that period would not line up and are not compared.`,
        coarserComparison: false,
        gsc,
        ga,
      };
    }

    // §7.4: when exact alignment is impossible, disclose it and compare at
    // whole-window scope only — never per-day, and never as if the windows
    // were the same period.
    return {
      aligned: false,
      note: `Google Search (${gsc.startDate}–${gsc.endDate}) counts in ${gsc.timezoneNote}. Google Analytics (${ga.startDate}–${ga.endDate}) counts in ${ga.timezoneNote}. The two cover overlapping but not identical date ranges on different day boundaries, so they are compared at whole-window scope only and are not treated as the same period.`,
      coarserComparison: true,
      gsc,
      ga,
    };
  }

  private static readonly ADDED_BY: Record<'searchConsole' | 'analytics', string> = {
    searchConsole:
      'Connecting Google Search adds the questions people use to find you, how often your pages appear in Google, and which pages get clicked.',
    analytics:
      'Connecting Google Analytics adds how many visitors land on each page, where they came from, and whether they engaged.',
  };

  private async sourceAvailability(projectId: string): Promise<SourceAvailability> {
    const [audit, gscResource, gaResource, gscSnap, gaSnap] = await Promise.all([
      this.prisma.technicalAudit.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.googleProjectResource.findUnique({
        where: { projectId_service: { projectId, service: 'search-console' } },
        include: { connection: true },
      }),
      this.prisma.googleProjectResource.findUnique({
        where: { projectId_service: { projectId, service: 'analytics' } },
        include: { connection: true },
      }),
      this.latestSnapshot(projectId, 'search-console', 'page-query-date'),
      this.latestSnapshot(projectId, 'analytics', 'landing-session'),
    ]);

    const expiredOf = (r: typeof gscResource) => (r ? r.connection.expiresAt.getTime() < Date.now() : false);
    const retainedOf = (s: typeof gscSnap) =>
      s ? { windowStart: s.windowStart, windowEnd: s.windowEnd, fetchedAt: s.fetchedAt.toISOString() } : null;

    const entry = (
      key: 'searchConsole' | 'analytics',
      resource: typeof gscResource,
      snap: typeof gscSnap,
      connectedLabel: string,
      disconnectedLabel: string,
      reconnectLabel: string,
    ): SourceAvailabilityEntry => {
      const expired = expiredOf(resource);
      const retained = retainedOf(snap);
      // §7.6: on expiry the last authorized snapshot is retained and served,
      // labeled with its own date — never silently presented as current.
      const retainedNote =
        expired && retained ? ` — showing the last authorized data from ${retained.windowEnd}` : '';
      return {
        connected: !!resource,
        lastSyncAt: snap?.fetchedAt.toISOString() ?? null,
        expired,
        label: !resource ? disconnectedLabel : expired ? `${reconnectLabel}${retainedNote}` : connectedLabel,
        retainedSnapshot: retained,
        addsWhat: WebsiteService.ADDED_BY[key],
      };
    };

    return {
      technicalCheck: {
        available: !!audit,
        lastCheckedAt: audit?.createdAt.toISOString() ?? null,
        // §7.6: public website checks render with no Google connected at all.
        label: audit ? `Website check updated ${audit.createdAt.toISOString().slice(0, 10)}` : 'No website check has run yet',
      },
      searchConsole: entry(
        'searchConsole',
        gscResource,
        gscSnap,
        'Google Search connected',
        'Google Search not connected',
        'Google Search needs reconnection',
      ),
      analytics: entry(
        'analytics',
        gaResource,
        gaSnap,
        'Google Analytics connected',
        'Google Analytics not connected',
        'Google Analytics needs reconnection',
      ),
    };
  }

  /**
   * Build the joined per-page fact set for every page identity seen this
   * project, strictly at each source's own grain — see the module doc.
   *
   * GSC rows are aggregated to page level by summing across query+date+
   * country+device *for that page only* (the GA map is never read in that
   * loop). GA rows are aggregated to page level by summing across
   * channel+date for that page only (the GSC map is never read in that loop).
   * The two page-level totals are then attached side by side — never combined
   * arithmetically. That is the no-fanout guarantee: an extra GSC query row
   * adds a row to `queries`, and cannot add a session.
   */
  private async joinedPages(projectId: string): Promise<{
    pages: JoinedPageFacts[];
    siteAverageCtr: number | null;
    sitePosition: number | null;
    gscSnap: Awaited<ReturnType<WebsiteService['latestSnapshot']>>;
    gaSnap: Awaited<ReturnType<WebsiteService['latestSnapshot']>>;
  }> {
    const [identities, latestAudit, gscSnap, gaSnap, analyses] = await Promise.all([
      this.prisma.websitePageIdentity.findMany({ where: { projectId } }),
      this.prisma.technicalAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { pages: true, pageMetadata: true },
      }),
      this.latestSnapshot(projectId, 'search-console', 'page-query-date'),
      this.latestSnapshot(projectId, 'analytics', 'landing-session'),
      this.prisma.pageAnalysis.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    ]);

    const gscRows: Array<{ page: string | null; query: string | null; country: string | null; device: string | null; clicks: number; impressions: number; ctr: number; position: number }> = gscSnap
      ? JSON.parse(gscSnap.rows)
      : [];
    const gaRows: Array<{ landingPage: string | null; channelGroup: string | null; sessionSource: string | null; sessions: number; totalUsers: number; engagedSessions: number }> = gaSnap
      ? JSON.parse(gaSnap.rows)
      : [];

    const gscWindow: FactWindow | null = gscSnap ? { startDate: gscSnap.windowStart, endDate: gscSnap.windowEnd, timezoneNote: gscSnap.timezoneNote } : null;
    const gaWindow: FactWindow | null = gaSnap ? { startDate: gaSnap.windowStart, endDate: gaSnap.windowEnd, timezoneNote: gaSnap.timezoneNote } : null;

    // ── GSC: page-level aggregate, grouped within GSC's own rows only ──────
    interface QueryAgg { clicks: number; impressions: number; positionWeight: number; n: number }
    const gscByPage = new Map<
      string,
      { clicks: number; impressions: number; positionWeight: number; countries: Set<string>; devices: Set<string>; queries: Map<string, QueryAgg> }
    >();
    for (const r of gscRows) {
      if (!r.page) continue;
      const key = normalizePageUrl(r.page).canonicalUrl;
      const bucket =
        gscByPage.get(key) ??
        { clicks: 0, impressions: 0, positionWeight: 0, countries: new Set<string>(), devices: new Set<string>(), queries: new Map<string, QueryAgg>() };
      bucket.clicks += r.clicks;
      bucket.impressions += r.impressions;
      // Position is itself an average, so it is combined impression-weighted
      // rather than by a plain mean of means.
      bucket.positionWeight += (r.position ?? 0) * (r.impressions ?? 0);
      if (r.country) bucket.countries.add(r.country);
      if (r.device) bucket.devices.add(r.device);
      if (r.query) {
        const q = bucket.queries.get(r.query) ?? { clicks: 0, impressions: 0, positionWeight: 0, n: 0 };
        q.clicks += r.clicks;
        q.impressions += r.impressions;
        q.positionWeight += (r.position ?? 0) * (r.impressions ?? 0);
        q.n += 1;
        bucket.queries.set(r.query, q);
      }
      gscByPage.set(key, bucket);
    }

    // ── GA: page-level aggregate, grouped within GA's own rows only ────────
    // This loop reads `gaRows` and nothing else. No GSC row can reach it, so
    // the query-row count cannot multiply `sessions`.
    const gaByPage = new Map<string, { sessions: number; totalUsers: number; engagedSessions: number; bySource: Map<string, number> }>();
    for (const r of gaRows) {
      if (!r.landingPage) continue;
      const key = normalizePageUrl(r.landingPage).canonicalUrl;
      const bucket = gaByPage.get(key) ?? { sessions: 0, totalUsers: 0, engagedSessions: 0, bySource: new Map<string, number>() };
      bucket.sessions += r.sessions;
      bucket.totalUsers += r.totalUsers;
      bucket.engagedSessions += r.engagedSessions;
      const src = r.channelGroup ?? r.sessionSource ?? '(unknown)';
      bucket.bySource.set(src, (bucket.bySource.get(src) ?? 0) + r.sessions);
      gaByPage.set(key, bucket);
    }

    const auditPageByKey = new Map<string, any>();
    for (const p of latestAudit?.pages ?? []) auditPageByKey.set(normalizePageUrl(p.url).canonicalUrl, p);

    const analysisByKey = new Map<string, (typeof analyses)[number]>();
    for (const a of analyses) {
      const key = normalizePageUrl(a.url).canonicalUrl;
      if (!analysisByKey.has(key)) analysisByKey.set(key, a); // most recent first (orderBy desc)
    }

    let ctrSum = 0;
    let ctrN = 0;
    let positionWeightTotal = 0;
    let positionImpressionsTotal = 0;

    const pages: JoinedPageFacts[] = identities.map((id) => {
      const gscB = gscByPage.get(id.canonicalUrl);
      const gaB = gaByPage.get(id.canonicalUrl);
      const auditPage = auditPageByKey.get(id.canonicalUrl);
      const analysis = analysisByKey.get(id.canonicalUrl);

      const searchAvailable = !!gscSnap && !!gscB;
      const visitorsAvailable = !!gaSnap && !!gaB;

      const ctr = searchAvailable && gscB!.impressions > 0 ? gscB!.clicks / gscB!.impressions : 0;
      if (searchAvailable && gscB!.impressions > 0) {
        ctrSum += ctr;
        ctrN += 1;
        positionWeightTotal += gscB!.positionWeight;
        positionImpressionsTotal += gscB!.impressions;
      }

      const health: HealthState = auditPage ? (auditPage.status >= 200 && auditPage.status < 400 ? 'healthy' : 'inaccessible') : 'unknown';
      let issueCount = 0;
      if (auditPage?.issues) {
        try {
          const parsed = JSON.parse(auditPage.issues);
          issueCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          issueCount = 0;
        }
      }

      const topQueries = gscB
        ? [...gscB.queries.entries()]
            .map(([query, q]) => ({
              query,
              clicks: q.clicks,
              impressions: q.impressions,
              position: q.impressions > 0 ? q.positionWeight / q.impressions : q.n ? q.positionWeight / q.n : 0,
            }))
            .sort((a, b) => b.clicks - a.clicks)
            .slice(0, 10)
        : [];

      const bySource = gaB ? [...gaB.bySource.entries()].map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions) : [];

      const scope: FactScope | null = searchAvailable
        ? { countries: [...gscB!.countries].sort(), devices: [...gscB!.devices].sort(), complete: gscSnap!.complete }
        : null;

      return {
        pageIdentityId: id.id,
        canonicalUrl: id.canonicalUrl,
        title: auditPage?.title ?? latestAudit?.pageMetadata?.title ?? null,
        health,
        issueCount,
        search: {
          available: searchAvailable,
          clicks: gscB?.clicks ?? 0,
          impressions: gscB?.impressions ?? 0,
          ctr,
          position: searchAvailable && gscB!.impressions > 0 ? gscB!.positionWeight / gscB!.impressions : 0,
          window: searchAvailable ? gscWindow : null,
          scope,
          topQueries,
        },
        visitors: {
          available: visitorsAvailable,
          sessions: gaB?.sessions ?? 0,
          totalUsers: gaB?.totalUsers ?? 0,
          engagedSessions: gaB?.engagedSessions ?? 0,
          engagementRate: visitorsAvailable && gaB!.sessions > 0 ? gaB!.engagedSessions / gaB!.sessions : null,
          window: visitorsAvailable ? gaWindow : null,
          scope: visitorsAvailable ? { complete: gaSnap!.complete } : null,
          bySource,
        },
        contentUpdatedAt: analysis ? (analysis.fetchedAt ?? analysis.createdAt).toISOString() : null,
        contentStructureScore: analysis?.structureScore ?? null,
        nextAction: health === 'inaccessible' ? 'Inspect issue; assign fix' : issueCount > 0 ? 'Review issues' : 'No action needed',
      };
    });

    return {
      pages,
      siteAverageCtr: ctrN > 0 ? ctrSum / ctrN : null,
      sitePosition: positionImpressionsTotal > 0 ? positionWeightTotal / positionImpressionsTotal : null,
      gscSnap,
      gaSnap,
    };
  }

  /**
   * §7.3: stored insight snapshots that reference exact source extracts and
   * rule versions. Rewriting the same insight on every page load would grow
   * the table without adding evidence, so an unchanged insight is reused and a
   * changed one closes its predecessor's validity window — which is where each
   * insight's "validity period" comes from.
   */
  private async persistInsights(projectId: string, rows: Array<{ pageIdentityId: string | null; ins: WebsiteInsight }>) {
    if (!rows.length) return;
    const open = await this.prisma.websiteInsightSnapshot.findMany({
      where: { projectId, validUntil: null },
      orderBy: { createdAt: 'desc' },
    });
    const openByKey = new Map<string, (typeof open)[number]>();
    for (const s of open) {
      const key = `${s.pageIdentityId ?? ''}::${s.ruleId}`;
      if (!openByKey.has(key)) openByKey.set(key, s);
    }

    const ops: Array<ReturnType<typeof this.prisma.websiteInsightSnapshot.create>> = [];
    const now = new Date();
    for (const { pageIdentityId, ins } of rows) {
      const key = `${pageIdentityId ?? ''}::${ins.ruleId}`;
      const prior = openByKey.get(key);
      const factsJson = JSON.stringify(ins.facts);
      if (prior && prior.ruleVersion === ins.ruleVersion && prior.message === ins.message && prior.factsJson === factsJson) {
        continue; // unchanged evidence and wording — keep the open snapshot
      }
      if (prior) {
        ops.push(
          this.prisma.websiteInsightSnapshot.update({ where: { id: prior.id }, data: { validUntil: now } }) as never,
        );
      }
      ops.push(
        this.prisma.websiteInsightSnapshot.create({
          data: {
            projectId,
            pageIdentityId,
            ruleId: ins.ruleId,
            ruleVersion: ins.ruleVersion,
            severity: ins.severity,
            message: ins.message,
            limitations: ins.limitations,
            actionTarget: ins.actionTarget,
            sourceIds: JSON.stringify(ins.sourceIds),
            factsJson,
            validFrom: now,
          },
        }) as never,
      );
    }
    if (ops.length) await this.prisma.$transaction(ops);
  }

  async overview(projectId: string): Promise<WebsiteOverview> {
    const [{ pages, siteAverageCtr, sitePosition, gscSnap, gaSnap }, availability, latestAudit] = await Promise.all([
      this.joinedPages(projectId),
      this.sourceAvailability(projectId),
      this.prisma.technicalAudit.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, include: { findings: true, pages: true } }),
    ]);

    // §7.5: "verified fix date". Page-level fixes are the strong evidence —
    // an issue that was present on this URL in the previous run and is gone
    // now, dated by the run that no longer finds it. Site-wide checks that
    // pass are included too, but described as site-wide so a page never takes
    // credit for a fix that was not observed on it.
    const siteFixes: FixEvent[] = (latestAudit?.findings ?? [])
      .filter((f) => f.status === 'pass')
      .map((f) => ({ date: latestAudit!.createdAt.toISOString(), description: `${f.type} check now passes site-wide`, sourceId: f.id, origin: 'site' as const }));

    const allInsights: Array<{ pageIdentityId: string | null; ins: WebsiteInsight }> = [];
    for (const page of pages) {
      const technical: TechnicalPageState = {
        accessible: page.health === 'unknown' ? null : page.health === 'healthy',
        lastCheckedAt: availability.technicalCheck.lastCheckedAt,
        sourceId: latestAudit?.id ?? null,
      };
      const pa: PageAnalysisState | null = page.contentUpdatedAt
        ? {
            exists: true,
            analyzedOrPublishedAt: page.contentUpdatedAt,
            structureScore: page.contentStructureScore,
            sourceId: page.pageIdentityId ? `page-analysis:${page.pageIdentityId}` : 'page-analysis',
          }
        : null;
      const ruleInsights = this.insights.evaluatePage({ page, technical, pageAnalysis: pa, fixes: siteFixes, siteAverageCtr });
      for (const ins of ruleInsights) allInsights.push({ pageIdentityId: page.pageIdentityId, ins });
    }

    await this.persistInsights(projectId, allInsights);

    const totalIssues = pages.reduce((s, p) => s + (p.health === 'inaccessible' ? 1 : 0) + p.issueCount, 0);
    const state: HealthState = pages.some((p) => p.health === 'inaccessible') ? 'inaccessible' : totalIssues > 0 ? 'needs-attention' : pages.length ? 'healthy' : 'unknown';

    // §7.4: these are per-page totals summed across *distinct* pages — each
    // page's clicks are disjoint, and a session lands on exactly one page — so
    // this is a site total, not a repeated page total. Nothing here multiplies
    // or mixes units.
    const clicksTotal = pages.reduce((s, p) => s + (p.search.available ? p.search.clicks : 0), 0);
    const impressionsTotal = pages.reduce((s, p) => s + (p.search.available ? p.search.impressions : 0), 0);
    const sessionsTotal = pages.reduce((s, p) => s + (p.visitors.available ? p.visitors.sessions : 0), 0);
    const anySearch = pages.some((p) => p.search.available);
    const anySessions = pages.some((p) => p.visitors.available);

    // §7.1: three to five useful cross-source insights. Cross-source evidence
    // sorts first; single-source observations fill the remaining slots rather
    // than being dropped, and ties break on severity.
    const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const insights = allInsights
      .map((r) => r.ins)
      .sort((a, b) => {
        if (a.crossSource !== b.crossSource) return a.crossSource ? -1 : 1;
        return (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
      })
      .slice(0, 5);

    const connectGuidance: string[] = [];
    if (!availability.searchConsole.connected) {
      connectGuidance.push(
        'No Google Search account is connected, so this screen shows only public website checks. Connecting Google Search adds the questions people search, how often your pages appear, and which get clicked.',
      );
    } else if (availability.searchConsole.expired) {
      connectGuidance.push(
        'Google Search access has expired. The last authorized data is still shown below, labeled with its date — reconnect to refresh it.',
      );
    }
    if (!availability.analytics.connected) {
      connectGuidance.push(
        'No Google Analytics account is connected, so no visitor figures are shown. Connecting Analytics adds how many visitors land on each page, where they came from, and whether they engaged.',
      );
    } else if (availability.analytics.expired) {
      connectGuidance.push(
        'Google Analytics access has expired. The last authorized visitor data is still shown below, labeled with its date — reconnect to refresh it.',
      );
    }
    if (!pages.length) {
      connectGuidance.push('No pages have been discovered yet — run a website check, or sync Google data once an account is connected.');
    }

    const latestWindow = this.windowAlignment(gscSnap, gaSnap);
    const staffBase = `/projects/${projectId}/research/website/runs`;

    return {
      projectId,
      health: { state, issueCount: totalIssues },
      google: {
        clicks: anySearch ? clicksTotal : null,
        impressions: anySearch ? impressionsTotal : null,
        position: anySearch ? sitePosition : null,
        clicksWindow: gscSnap ? { startDate: gscSnap.windowStart, endDate: gscSnap.windowEnd, timezoneNote: gscSnap.timezoneNote } : null,
        sessions: anySessions ? sessionsTotal : null,
        sessionsWindow: gaSnap ? { startDate: gaSnap.windowStart, endDate: gaSnap.windowEnd, timezoneNote: gaSnap.timezoneNote } : null,
      },
      windows: latestWindow,
      insights,
      importantPages: pages
        .slice()
        .sort((a, b) => {
          const aScore = (a.search.available ? a.search.clicks : 0) + (a.visitors.available ? a.visitors.sessions : 0);
          const bScore = (b.search.available ? b.search.clicks : 0) + (b.visitors.available ? b.visitors.sessions : 0);
          return bScore - aScore;
        })
        .slice(0, 10)
        .map((p) => ({
          pageIdentityId: p.pageIdentityId,
          title: p.title,
          canonicalUrl: p.canonicalUrl,
          health: p.health,
          clicks: p.search.available ? p.search.clicks : null,
          organicSessions: p.visitors.available ? p.visitors.sessions : null,
          nextAction: p.nextAction,
        })),
      sourceAvailability: availability,
      joinLimitation: JOIN_LIMITATION,
      connectGuidance,
      staffPanels: {
        latestCheckId: latestAudit?.id ?? null,
        checkHistoryHref: latestAudit ? `${staffBase}/${latestAudit.id}` : staffBase,
        technicalDetailsHref: latestAudit ? `${staffBase}/${latestAudit.id}` : staffBase,
      },
    };
  }

  async pages(projectId: string): Promise<JoinedPageFacts[]> {
    const { pages } = await this.joinedPages(projectId);
    return pages;
  }

  /**
   * §7.2 "Update this page": start or open the real refresh workflow for this
   * page. The workflow is sleeper-refresh (SOP-10) — the same mechanism
   * `/content/refreshes` drives — so this creates a `SleeperPage` candidate
   * rather than a parallel one-off. Idempotent: an already-open record is
   * returned unchanged, so a second click cannot queue the page twice.
   *
   * `pageDetailHref` comes back on the response so the caller can return to
   * exactly the page context it came from.
   */
  async startPageRefresh(
    projectId: string,
    pageIdentityId: string,
  ): Promise<{
    created: boolean;
    refresh: { id: string; url: string; status: string; createdAt: string; refreshedAt: string | null };
    refreshWorkflowHref: string;
    pageDetailHref: string;
  } | null> {
    const identity = await this.prisma.websitePageIdentity.findFirst({ where: { id: pageIdentityId, projectId } });
    if (!identity) return null;
    const sourceUrls: string[] = JSON.parse(identity.sourceUrls || '[]');
    const lookupUrls = sourceUrls.length ? sourceUrls : [identity.canonicalUrl];

    const existing = await this.prisma.sleeperPage.findFirst({
      where: { projectId, url: { in: lookupUrls }, status: { notIn: ['refreshed', 'abandoned'] } },
      orderBy: { createdAt: 'desc' },
    });

    const row =
      existing ??
      (await this.prisma.sleeperPage.create({
        data: {
          projectId,
          // The canonical address is the stable identity; a raw source URL
          // would tie the refresh to whichever variant happened to be seen
          // first.
          url: sourceUrls[0] ?? identity.canonicalUrl,
          label: identity.path,
          status: 'flagged',
          notes: 'Opened from the Website page detail ("Update this page").',
        },
      }));

    return {
      created: !existing,
      refresh: {
        id: row.id,
        url: row.url,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        refreshedAt: row.refreshedAt ? row.refreshedAt.toISOString() : null,
      },
      refreshWorkflowHref: `/projects/${projectId}/content/refreshes`,
      pageDetailHref: `/projects/${projectId}/research/website/pages/${pageIdentityId}`,
    };
  }

  async pageDetail(projectId: string, pageIdentityId: string): Promise<WebsitePageDetail | null> {
    const identity = await this.prisma.websitePageIdentity.findFirst({ where: { id: pageIdentityId, projectId } });
    if (!identity) return null;

    const sourceUrls: string[] = JSON.parse(identity.sourceUrls || '[]');
    const { pages, gscSnap, gaSnap } = await this.joinedPages(projectId);
    const facts = pages.find((p) => p.pageIdentityId === pageIdentityId) ?? null;

    // §7.2 Content: the existing Page Analysis capability, preserved — every
    // run for this page's known source URLs, newest first, plus the source
    // URL each run came from so history and provenance survive the move.
    const analyses = await this.prisma.pageAnalysis.findMany({
      where: { projectId, url: { in: sourceUrls } },
      orderBy: { createdAt: 'desc' },
    });
    const content: PageAnalysisRowLike[] = analyses.map((a) => ({
      id: a.id,
      url: a.url,
      title: a.title,
      wordCount: a.wordCount,
      blufScore: a.blufScore,
      questionH2Score: a.questionH2Score,
      formatScore: a.formatScore,
      claimsScore: a.claimsScore,
      structureScore: a.structureScore,
      status: a.status,
      fetchedAt: a.fetchedAt ? a.fetchedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    }));

    const [linkedRefresh, linkedAssets, audits] = await Promise.all([
      // The real refresh mechanism is sleeper-refresh (SOP-10): a SleeperPage
      // row is the refresh workflow for a URL.
      this.prisma.sleeperPage.findFirst({ where: { projectId, url: { in: sourceUrls } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.growthAsset.findMany({
        where: { projectId, assetUrl: { in: sourceUrls } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, assetType: true, status: true, assetUrl: true },
      }),
      this.prisma.technicalAudit.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, createdAt: true, pages: { where: { url: { in: sourceUrls } }, select: { url: true, status: true, issues: true } } },
      }),
    ]);

    const changes = this.buildChanges({ sourceUrls, analyses, linkedRefresh, audits });

    return {
      identity: { id: identity.id, canonicalUrl: identity.canonicalUrl, sourceUrls },
      facts,
      content,
      refreshRecommendation: this.refreshRecommendation(facts, analyses[0] ?? null, linkedRefresh),
      linkedRefresh: linkedRefresh
        ? {
            id: linkedRefresh.id,
            url: linkedRefresh.url,
            status: linkedRefresh.status,
            trafficDeclinePct: linkedRefresh.trafficDeclinePct,
            refreshedAt: linkedRefresh.refreshedAt ? linkedRefresh.refreshedAt.toISOString() : null,
            createdAt: linkedRefresh.createdAt.toISOString(),
          }
        : null,
      linkedContent: linkedAssets.map((a) => ({ id: a.id, title: a.title, assetType: a.assetType, status: a.status, url: a.assetUrl ?? null })),
      changes,
      joinLimitation: JOIN_LIMITATION,
    };
  }

  /**
   * §7.2 "Changes": observed fixes and content revisions with dates. Every
   * entry is an observation with a date and a source id. None of them carries
   * an improvement claim — the UI is required to keep the correlational
   * wording, and `causal` is typed `false` so a future edit cannot quietly
   * turn this into an attribution.
   */
  private buildChanges(input: {
    sourceUrls: string[];
    analyses: Array<{ id: string; createdAt: Date; fetchedAt: Date | null; structureScore: number; status: string }>;
    linkedRefresh: { id: string; status: string; refreshedAt: Date | null; createdAt: Date; dateModifiedAfter: string | null } | null;
    audits: Array<{ id: string; createdAt: Date; pages: Array<{ url: string; status: number; issues: string | null }> }>;
  }): WebsitePageChange[] {
    const changes: WebsitePageChange[] = [];
    const issueCountOf = (p: { issues: string | null }) => {
      try {
        const parsed = JSON.parse(p.issues ?? '[]');
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        return 0;
      }
    };

    for (const a of input.analyses) {
      changes.push({
        date: (a.fetchedAt ?? a.createdAt).toISOString(),
        kind: 'content-analysis',
        description: `Page analysis recorded: structure score ${a.structureScore}/100 (${a.status}).`,
        sourceId: `page-analysis:${a.id}`,
        causal: false,
      });
    }

    // `audits` is newest first: compare each run's observation of this URL
    // with the next-older run's. A page-level fix is an issue that was present
    // then and is absent now — dated by the run that no longer finds it.
    for (let i = 0; i < input.audits.length; i++) {
      const run = input.audits[i];
      const page = run.pages[0];
      if (!page) continue;
      const issuesNow = issueCountOf(page);

      changes.push({
        date: run.createdAt.toISOString(),
        kind: 'technical-check',
        description: `Website check ran for this page: HTTP ${page.status}${issuesNow ? `, ${issuesNow} open issue${issuesNow === 1 ? '' : 's'}` : ', no open issues'}.`,
        sourceId: `technical-audit:${run.id}`,
        causal: false,
      });

      const older = input.audits[i + 1]?.pages[0];
      if (!older) continue;
      const issuesBefore = issueCountOf(older);
      if (issuesBefore > 0 && issuesNow === 0) {
        changes.push({
          date: run.createdAt.toISOString(),
          kind: 'technical-fix',
          description: `This page previously had ${issuesBefore} open issue${issuesBefore === 1 ? '' : 's'}; the check that ran on this date found none.`,
          sourceId: `technical-audit:${run.id}`,
          causal: false,
        });
      }
    }

    if (input.linkedRefresh) {
      const r = input.linkedRefresh;
      changes.push({
        date: r.createdAt.toISOString(),
        kind: 'content-revision',
        description: `Added to the content refresh queue (status: ${r.status}).`,
        sourceId: `sleeper-page:${r.id}`,
        causal: false,
      });
      if (r.refreshedAt) {
        changes.push({
          date: r.refreshedAt.toISOString(),
          kind: 'refresh-shipped',
          description: `Refresh recorded as shipped${r.dateModifiedAfter ? `, with a visible dateModified of ${r.dateModifiedAfter}` : ''}. This records that the page moved, not that traffic improved.`,
          sourceId: `sleeper-page:${r.id}`,
          causal: false,
        });
      }
    }

    return changes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  /**
   * §7.2 "Content": a refresh recommendation with its inputs attached. A
   * recommendation is only made from facts that exist — a page with no
   * analysis and no refresh record gets `recommended: false, reason: null`,
   * never a recommendation invented from a missing figure.
   */
  private refreshRecommendation(
    facts: JoinedPageFacts | null,
    latestAnalysis: { structureScore: number; fetchedAt: Date | null; createdAt: Date } | null,
    linkedRefresh: { status: string } | null,
  ): RefreshRecommendation {
    const evidence: Record<string, unknown> = {};
    const reasons: string[] = [];

    if (facts?.health === 'inaccessible') {
      reasons.push('the latest website check could not open this page');
      evidence.health = facts.health;
    }

    if (latestAnalysis) {
      evidence.structureScore = latestAnalysis.structureScore;
      evidence.analyzedAt = (latestAnalysis.fetchedAt ?? latestAnalysis.createdAt).toISOString();
      if (latestAnalysis.structureScore < 60) {
        reasons.push(`its content-structure score is ${latestAnalysis.structureScore}/100`);
      }
      const ageDays = (Date.now() - (latestAnalysis.fetchedAt ?? latestAnalysis.createdAt).getTime()) / 86_400_000;
      evidence.contentAgeDays = Math.round(ageDays);
      if (ageDays >= 365) reasons.push(`its last analysis is ${Math.round(ageDays)} days old`);
    }

    if (facts?.visitors.available && facts.visitors.sessions > 0) {
      evidence.landingSessions = facts.visitors.sessions;
    }

    // A refresh already in flight is not recommended again — it is reported.
    const alreadyOpen = linkedRefresh && linkedRefresh.status !== 'refreshed' && linkedRefresh.status !== 'abandoned';
    if (alreadyOpen) {
      evidence.refreshStatus = linkedRefresh!.status;
      return {
        recommended: false,
        reason: `A content refresh is already open for this page (status: ${linkedRefresh!.status}).`,
        evidence,
      };
    }

    if (!reasons.length) {
      return {
        recommended: false,
        reason: latestAnalysis || facts?.health !== 'unknown'
          ? 'Nothing in the available evidence indicates this page needs a content refresh.'
          : null,
        evidence,
      };
    }

    return {
      recommended: true,
      reason: `A refresh is worth considering because ${reasons.join(' and ')}.`,
      evidence,
    };
  }
}
