/**
 * SERP Intelligence Service — track Google SERP rankings, competitors, SERP
 * features, and AI-Overview presence for a set of queries over time (Agent #3).
 *
 * Data source is a **licensed SERP API (DataForSEO)** via FetcherService — no
 * headless-browser scraping, no user-simulated queries/clicks. A `fixture`
 * provider (gated by `SERP_ALLOW_FIXTURE=1`) serves canned SERPs so the
 * pipeline is smoke-testable with no vendor account.
 *
 * A live capture requires the `SWARM_ALLOW_LIVE=1` master switch AND
 * `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`; it is cost-capped per capture.
 *
 * @module serp-intelligence.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { parseCompetitors } from '../../common/utils/subject-match';
import { DataForSeoProvider, FixtureSerpProvider } from './providers';
import { analyzeLocalPack, analyzeSerp } from './serp-analyzer';
import { SERP_LIMITS } from './serp-intelligence.types';
import type { CaptureResult, CreateTrackerInput, SerpProvider, SerpProviderName } from './serp-intelligence.types';

@Injectable()
export class SerpIntelligenceService {
  private readonly logger = new Logger(SerpIntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
  ) {}

  // ─── trackers ──────────────────────────────────────────────

  async createTracker(projectId: string, input: CreateTrackerInput) {
    await this.ensureProject(projectId);
    const keywords = this.normalizeKeywords(input.keywords);
    if (keywords.length === 0) throw new BadRequestException('At least one keyword is required.');

    const provider = (input.provider ?? this.defaultProviderName()) as SerpProviderName;
    const tracker = await this.prisma.serpTracker.create({
      data: {
        projectId,
        name: input.name,
        locationName: input.locationName?.trim() || 'United States',
        languageCode: input.languageCode?.trim() || 'en',
        device: input.device === 'mobile' ? 'mobile' : 'desktop',
        provider,
        status: 'active',
        queries: { create: keywords.map((keyword) => ({ keyword })) },
      },
      include: { queries: true },
    });
    this.logger.log(`serp tracker ${tracker.id} created (${keywords.length} queries, provider=${provider})`);
    return tracker;
  }

  async listTrackers(projectId: string) {
    await this.ensureProject(projectId);
    return this.prisma.serpTracker.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { queries: true },
    });
  }

  async getTracker(trackerId: string) {
    const tracker = await this.prisma.serpTracker.findUnique({
      where: { id: trackerId },
      include: {
        queries: true,
        snapshots: { orderBy: { capturedAt: 'desc' }, take: 5 },
      },
    });
    if (!tracker) throw new NotFoundException('SERP tracker not found: ' + trackerId);
    return tracker;
  }

  async addQueries(trackerId: string, keywords: string[]) {
    const tracker = await this.getTrackerOr404(trackerId);
    const existing = new Set(
      (await this.prisma.serpQuery.findMany({ where: { trackerId }, select: { keyword: true } })).map((q) => q.keyword),
    );
    const toAdd = this.normalizeKeywords(keywords).filter((k) => !existing.has(k));
    if (existing.size + toAdd.length > SERP_LIMITS.keywordsPerTracker.max) {
      throw new ConflictException(`Tracker keyword cap (${SERP_LIMITS.keywordsPerTracker.max}) would be exceeded.`);
    }
    if (toAdd.length > 0) {
      await this.prisma.serpQuery.createMany({ data: toAdd.map((keyword) => ({ trackerId, keyword })) });
    }
    return this.getTracker(tracker.id);
  }

  async removeQuery(trackerId: string, queryId: string) {
    await this.getTrackerOr404(trackerId);
    const q = await this.prisma.serpQuery.findUnique({ where: { id: queryId } });
    if (!q || q.trackerId !== trackerId) throw new NotFoundException('Query not found: ' + queryId);
    await this.prisma.serpQuery.delete({ where: { id: queryId } });
    return { removed: queryId };
  }

  async deleteTracker(trackerId: string) {
    await this.getTrackerOr404(trackerId);
    await this.prisma.serpTracker.delete({ where: { id: trackerId } });
    return { removed: trackerId };
  }

  // ─── capture ───────────────────────────────────────────────

  /**
   * Run one snapshot: fetch every query's SERP through the provider, analyse,
   * persist. Stops at `SERP_MAX_COST_PER_CAPTURE`.
   * @throws ServiceUnavailableException live provider without SWARM_ALLOW_LIVE + creds.
   * @throws BadRequestException          fixture provider without SERP_ALLOW_FIXTURE.
   */
  async capture(trackerId: string, providerOverride?: SerpProviderName): Promise<CaptureResult> {
    const tracker = await this.prisma.serpTracker.findUnique({
      where: { id: trackerId },
      include: { queries: true },
    });
    if (!tracker) throw new NotFoundException('SERP tracker not found: ' + trackerId);
    if (tracker.queries.length === 0) throw new ConflictException('Tracker has no queries to capture.');

    const providerName = (providerOverride ?? tracker.provider) as SerpProviderName;
    const provider = this.resolveProvider(providerName);
    const project = await this.prisma.project.findUnique({ where: { id: tracker.projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + tracker.projectId);

    const subject = { name: project.name, domain: project.domain };
    const competitors = parseCompetitors(project.competitors);
    const costCap = this.maxCostPerCapture();

    const snapshot = await this.prisma.serpSnapshot.create({
      data: { trackerId, provider: providerName, status: 'running' },
    });

    let cost = 0;
    let run = 0;
    let stopNote: string | null = null;
    let anyFailure = false;

    for (const q of tracker.queries) {
      if (cost >= costCap) {
        stopNote = `cost cap $${costCap.toFixed(2)} reached — ${tracker.queries.length - run} query(ies) unrun`;
        break;
      }
      try {
        const resp = await provider.fetchSerp(q.keyword, {
          locationName: tracker.locationName,
          languageCode: tracker.languageCode,
          device: tracker.device,
        });
        const a = analyzeSerp(resp, subject, competitors);
        // Local pack is read from the SAME response — DataForSEO returns it
        // inline on any query Google shows one for, no extra fetch/cost — and
        // gated on the client's own business type, never run "for everyone".
        const local = analyzeLocalPack(resp.items, subject.name, project.category);
        cost += resp.costUsd;
        run += 1;
        await this.prisma.serpResult.create({
          data: {
            snapshotId: snapshot.id,
            queryId: q.id,
            keyword: q.keyword,
            subjectRank: a.subjectRank,
            subjectUrl: a.subjectUrl,
            aiOverviewPresent: a.aiOverviewPresent,
            aiOverviewMentionsSubject: a.aiOverviewMentionsSubject,
            featuredSnippetDomain: a.featuredSnippetDomain,
            topDomains: JSON.stringify(a.topDomains),
            competitorsSeen: JSON.stringify(a.competitorsSeen),
            sourceCount: a.sourceCount,
            rawItemCount: a.rawItemCount,
            costUsd: Number(resp.costUsd.toFixed(6)),
            localPackApplicable: local.applicable,
            localPackReason: local.reason,
            localPackPresent: local.present,
            localPackRank: local.rank,
            localPackEntries: JSON.stringify(local.entries),
          },
        });
      } catch (err) {
        anyFailure = true;
        this.logger.warn(`serp capture ${snapshot.id} query "${q.keyword}" failed: ${(err as Error).message}`);
      }
    }

    const status = run === 0 ? 'failed' : stopNote || anyFailure ? 'partial' : 'complete';
    await this.prisma.serpSnapshot.update({
      where: { id: snapshot.id },
      data: {
        status,
        queriesRun: run,
        costUsd: Number(cost.toFixed(6)),
        note: stopNote,
        finishedAt: new Date(),
      },
    });
    this.logger.log(`serp snapshot ${snapshot.id} ${status}: ${run}/${tracker.queries.length} queries, $${cost.toFixed(4)}`);
    return { snapshotId: snapshot.id, status, queriesRun: run, costUsd: Number(cost.toFixed(6)), note: stopNote };
  }

  /**
   * Fetch one SERP through the gated provider — used by the `authority` module's
   * discovery scans. Applies the same SWARM_ALLOW_LIVE / credential / fixture
   * rules as {@link capture}.
   */
  async serpForDiscovery(
    keyword: string,
    opts: { locationName: string; languageCode: string; device: string },
    providerName?: SerpProviderName,
  ) {
    const provider = this.resolveProvider((providerName ?? this.defaultProviderName()) as SerpProviderName);
    return provider.fetchSerp(keyword, opts);
  }

  /**
   * Stage 6's "Run Geographic/Market Visibility Analysis" → "Visibility by
   * Area/Market" + "Competitors by Area/Market", in one read.
   *
   * Groups every tracker's latest-per-keyword result by `locationName` — an
   * operator gets this for free the moment they run more than one tracker
   * with a different location, which is exactly how multi-market visibility
   * is set up today (one `SerpTracker` per market, decision D8's "operator
   * picks the markets" precedent for AEO). No new fetch: this reads only
   * what `capture()` already persisted.
   */
  async marketVisibility(projectId: string) {
    await this.ensureProject(projectId);
    const trackers = await this.prisma.serpTracker.findMany({ where: { projectId } });
    if (trackers.length === 0) {
      return { projectId, markets: [], note: 'No SERP trackers for this project yet — create one to start tracking visibility by market.' };
    }

    // Latest captured result per query, across every tracker — a query's
    // history is not this view's concern, only its current state.
    const results = await this.prisma.serpResult.findMany({
      where: { snapshot: { trackerId: { in: trackers.map((t) => t.id) } } },
      orderBy: { capturedAt: 'desc' },
      include: { query: { select: { id: true, trackerId: true } } },
    });
    const latestByQuery = new Map<string, (typeof results)[number]>();
    for (const r of results) {
      if (!r.query) continue;
      if (!latestByQuery.has(r.query.id)) latestByQuery.set(r.query.id, r);
    }

    const trackerById = new Map(trackers.map((t) => [t.id, t]));
    const byLocation = new Map<string, { trackerNames: Set<string>; rows: (typeof results)[number][] }>();
    for (const r of latestByQuery.values()) {
      const tracker = trackerById.get(r.query!.trackerId);
      if (!tracker) continue;
      const bucket = byLocation.get(tracker.locationName) ?? { trackerNames: new Set<string>(), rows: [] };
      bucket.trackerNames.add(tracker.name);
      bucket.rows.push(r);
      byLocation.set(tracker.locationName, bucket);
    }

    const markets = [...byLocation.entries()].map(([location, bucket]) => {
      const ranked = bucket.rows.filter((r) => r.subjectRank != null);
      const averageRank = ranked.length
        ? Math.round((ranked.reduce((s, r) => s + (r.subjectRank as number), 0) / ranked.length) * 10) / 10
        : null;

      // "Competitors by Area/Market" — how often each named competitor shows
      // up across this market's tracked keywords, worst-for-the-client first.
      const competitorCounts = new Map<string, number>();
      for (const r of bucket.rows) {
        let seen: string[] = [];
        try {
          seen = JSON.parse(r.competitorsSeen || '[]') as string[];
        } catch {
          continue;
        }
        for (const name of seen) competitorCounts.set(name, (competitorCounts.get(name) ?? 0) + 1);
      }
      const topCompetitors = [...competitorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, keywordsAppearedIn]) => ({ name, keywordsAppearedIn }));

      const localApplicable = bucket.rows.filter((r) => r.localPackApplicable);
      const localPresent = localApplicable.filter((r) => r.localPackPresent === true);

      return {
        location,
        trackers: [...bucket.trackerNames],
        keywordsTracked: bucket.rows.length,
        keywordsRanked: ranked.length,
        averageRank,
        aiOverviewKeywords: bucket.rows.filter((r) => r.aiOverviewPresent).length,
        aiOverviewMentioned: bucket.rows.filter((r) => r.aiOverviewPresent && r.aiOverviewMentionsSubject).length,
        // `applicable: false` means this location's business type made a local
        // pack question meaningless (analyzeLocalPack's own gate) — never
        // rendered as "0 of 0 found", which would read as a fabricated zero.
        localPack:
          localApplicable.length > 0
            ? { applicable: true as const, keywordsChecked: localApplicable.length, keywordsPresent: localPresent.length }
            : { applicable: false as const },
        topCompetitors,
      };
    });

    markets.sort((a, b) => b.keywordsTracked - a.keywordsTracked);

    return {
      projectId,
      markets,
      note:
        "Aggregated from each tracker's latest captured result per keyword, grouped by tracker locationName — " +
        'never a fresh SERP fetch. A market with no tracker yet simply does not appear; that is "not measured", not "no visibility".',
    };
  }

  async listSnapshots(trackerId: string) {
    await this.getTrackerOr404(trackerId);
    return this.prisma.serpSnapshot.findMany({ where: { trackerId }, orderBy: { capturedAt: 'desc' } });
  }

  async getSnapshot(trackerId: string, snapshotId: string) {
    await this.getTrackerOr404(trackerId);
    const snap = await this.prisma.serpSnapshot.findUnique({
      where: { id: snapshotId },
      include: { results: { orderBy: { keyword: 'asc' } } },
    });
    if (!snap || snap.trackerId !== trackerId) throw new NotFoundException('Snapshot not found: ' + snapshotId);
    return snap;
  }

  // ─── internals ─────────────────────────────────────────────

  private resolveProvider(name: SerpProviderName): SerpProvider {
    if (name === 'fixture') {
      if (this.config.get<string>('SERP_ALLOW_FIXTURE') !== '1') {
        throw new BadRequestException('fixture provider requires SERP_ALLOW_FIXTURE=1 (offline test only)');
      }
      return new FixtureSerpProvider();
    }
    // dataforseo — live, costs money
    if (this.config.get<string>('SWARM_ALLOW_LIVE') !== '1') {
      throw new ServiceUnavailableException(
        'Live SERP provider blocked — set SWARM_ALLOW_LIVE=1 to allow paid DataForSEO calls (or use the fixture provider).',
      );
    }
    const login = this.config.get<string>('DATAFORSEO_LOGIN');
    const password = this.config.get<string>('DATAFORSEO_PASSWORD');
    if (!login || !password) {
      throw new ServiceUnavailableException('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not configured.');
    }
    return new DataForSeoProvider(this.fetcher, login, password);
  }

  private defaultProviderName(): SerpProviderName {
    return this.config.get<string>('SERP_ALLOW_FIXTURE') === '1' &&
      this.config.get<string>('SWARM_ALLOW_LIVE') !== '1'
      ? 'fixture'
      : 'dataforseo';
  }

  private maxCostPerCapture(): number {
    const raw = this.config.get<string>('SERP_MAX_COST_PER_CAPTURE');
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : SERP_LIMITS.defaultMaxCostPerCapture;
  }

  private normalizeKeywords(keywords: string[]): string[] {
    const out = new Set<string>();
    for (const k of keywords ?? []) {
      const norm = (k ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, SERP_LIMITS.maxKeywordLen);
      if (norm.length >= 2) out.add(norm);
    }
    return [...out].slice(0, SERP_LIMITS.keywordsPerTracker.max);
  }

  private async ensureProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return project;
  }

  private async getTrackerOr404(trackerId: string) {
    const t = await this.prisma.serpTracker.findUnique({ where: { id: trackerId } });
    if (!t) throw new NotFoundException('SERP tracker not found: ' + trackerId);
    return t;
  }
}
