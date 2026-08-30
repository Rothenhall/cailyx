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
import { analyzeSerp } from './serp-analyzer';
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
