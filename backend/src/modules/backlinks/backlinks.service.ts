/**
 * Backlinks Service — DataForSEO Backlinks API (backlinks-overview), gated
 * exactly like `serp-intelligence`/`keyword-research` on the same vendor
 * account: `SWARM_ALLOW_LIVE=1` (the paid-call master switch) AND
 * `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`. Missing either fails closed with
 * a typed 503 naming exactly what to set — never a silent empty/fake result.
 *
 * Two vendor calls per refresh: `summary/live` (one billed row — overall
 * profile) and `backlinks/live` (a small sample of actual backlinks, so a
 * report shows evidence, not just a count). Real vendor-reported cost
 * (`tasks[].cost`) persisted, never estimated.
 *
 * @module backlinks.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { DataForSeoBacklinksProvider } from './backlinks.provider';
import type { BacklinksSummaryDto } from './backlinks.types';
import type { RefreshBacklinksDto } from './dto/backlinks.dto';

const DEFAULT_SAMPLE_LIMIT = 10;
const DEFAULT_MAX_COST_PER_RUN = 1.0;

@Injectable()
export class BacklinksService {
  private readonly logger = new Logger(BacklinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
  ) {}

  /**
   * Pull a fresh backlinks summary (+ a sample of top backlinks) for a
   * project and persist it. Two vendor calls, both billed.
   *
   * @throws NotFoundException           unknown project
   * @throws ServiceUnavailableException  SWARM_ALLOW_LIVE / DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD missing
   */
  async refresh(projectId: string, dto: RefreshBacklinksDto): Promise<BacklinksSummaryDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // Resolve (and gate) the provider BEFORE writing anything.
    const provider = this.resolveProvider();
    const target = (dto.target?.trim() || project.domain || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!target) throw new BadRequestException('No target domain — set dto.target or the project\'s own domain first.');
    const sampleLimit = dto.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;

    let costUsd = 0;
    let error: string | null = null;
    let status: 'completed' | 'partial' | 'failed' = 'completed';

    const summaryResult = await provider.summary(target).catch((err) => {
      error = (err as Error).message;
      return null;
    });
    if (summaryResult) costUsd += summaryResult.costUsd;

    if (!summaryResult || !summaryResult.item) {
      status = 'failed';
      error = error ?? 'No summary data returned for this target';
      const row = await this.prisma.backlinksSummary.create({
        data: { projectId, target, status, error, costUsd },
      });
      this.logger.warn(`backlinks refresh failed for ${projectId} (${target}): ${error}`);
      return this.toDto(row);
    }

    let sampleItems: Awaited<ReturnType<DataForSeoBacklinksProvider['topBacklinks']>>['items'] = [];
    if (sampleLimit > 0 && costUsd < this.maxCostPerRun()) {
      const sampleResult = await provider.topBacklinks(target, sampleLimit).catch((err) => {
        status = 'partial';
        error = `Summary saved; backlink sample failed: ${(err as Error).message}`;
        this.logger.warn(`backlinks sample failed for ${projectId} (${target}): ${(err as Error).message}`);
        return null;
      });
      if (sampleResult) {
        costUsd += sampleResult.costUsd;
        sampleItems = sampleResult.items;
      }
    } else if (sampleLimit > 0) {
      status = 'partial';
      error = `Summary saved; backlink sample skipped — cost cap ($${this.maxCostPerRun().toFixed(2)}) reached after the summary call.`;
    }

    const item = summaryResult.item;
    const row = await this.prisma.backlinksSummary.create({
      data: {
        projectId,
        target,
        status,
        error,
        costUsd: Number(costUsd.toFixed(6)),
        rank: item.rank,
        backlinks: item.backlinks,
        backlinksSpamScore: item.backlinksSpamScore,
        referringDomains: item.referringDomains,
        referringMainDomains: item.referringMainDomains,
        referringPages: item.referringPages,
        referringIps: item.referringIps,
        referringSubnets: item.referringSubnets,
        brokenBacklinks: item.brokenBacklinks,
        brokenPages: item.brokenPages,
        firstSeen: item.firstSeen ? new Date(item.firstSeen) : null,
        lostDate: item.lostDate ? new Date(item.lostDate) : null,
        referringLinksTld: item.referringLinksTld ? JSON.stringify(item.referringLinksTld) : null,
        referringLinksTypes: item.referringLinksTypes ? JSON.stringify(item.referringLinksTypes) : null,
        referringLinksAttributes: item.referringLinksAttributes ? JSON.stringify(item.referringLinksAttributes) : null,
        referringLinksPlatformTypes: item.referringLinksPlatformTypes ? JSON.stringify(item.referringLinksPlatformTypes) : null,
        referringLinksCountries: item.referringLinksCountries ? JSON.stringify(item.referringLinksCountries) : null,
        topBacklinks: JSON.stringify(sampleItems),
      },
    });

    this.logger.log(`backlinks ${row.id} ${status} for ${projectId} (${target}): $${costUsd.toFixed(4)}`);
    return this.toDto(row);
  }

  /** Most recent summary for a project, or null when none has been pulled yet. */
  async latest(projectId: string): Promise<BacklinksSummaryDto | null> {
    const row = await this.prisma.backlinksSummary.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    return row ? this.toDto(row) : null;
  }

  /** History, newest first. */
  async list(projectId: string): Promise<{ summaries: BacklinksSummaryDto[] }> {
    const rows = await this.prisma.backlinksSummary.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    return { summaries: rows.map((r) => this.toDto(r)) };
  }

  // ─── Internals ─────────────────────────────────────────────

  /** Mirrors `KeywordResearchService.resolveProvider` exactly — same vendor account, same master switch. */
  private resolveProvider(): DataForSeoBacklinksProvider {
    if (this.config.get<string>('SWARM_ALLOW_LIVE') !== '1') {
      throw new ServiceUnavailableException(
        'Live DataForSEO calls are blocked — set SWARM_ALLOW_LIVE=1 to allow paid Backlinks API requests.',
      );
    }
    const login = this.config.get<string>('DATAFORSEO_LOGIN');
    const password = this.config.get<string>('DATAFORSEO_PASSWORD');
    if (!login || !password) {
      throw new ServiceUnavailableException(
        'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not configured — set both env vars to pull backlinks data.',
      );
    }
    return new DataForSeoBacklinksProvider(this.fetcher, login, password);
  }

  private maxCostPerRun(): number {
    const raw = this.config.get<string>('BACKLINKS_MAX_COST_PER_RUN');
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_COST_PER_RUN;
  }

  private toDto(row: {
    id: string;
    projectId: string;
    target: string;
    status: string;
    error: string | null;
    costUsd: number;
    rank: number | null;
    backlinks: number | null;
    backlinksSpamScore: number | null;
    referringDomains: number | null;
    referringMainDomains: number | null;
    referringPages: number | null;
    referringIps: number | null;
    referringSubnets: number | null;
    brokenBacklinks: number | null;
    brokenPages: number | null;
    firstSeen: Date | null;
    lostDate: Date | null;
    referringLinksTld: string | null;
    referringLinksTypes: string | null;
    referringLinksAttributes: string | null;
    referringLinksPlatformTypes: string | null;
    referringLinksCountries: string | null;
    topBacklinks: string;
    createdAt: Date;
  }): BacklinksSummaryDto {
    const parseDist = (v: string | null) => (v ? (JSON.parse(v) as Record<string, number>) : null);
    return {
      id: row.id,
      projectId: row.projectId,
      target: row.target,
      status: row.status as BacklinksSummaryDto['status'],
      error: row.error,
      costUsd: row.costUsd,
      rank: row.rank,
      backlinks: row.backlinks,
      backlinksSpamScore: row.backlinksSpamScore,
      referringDomains: row.referringDomains,
      referringMainDomains: row.referringMainDomains,
      referringPages: row.referringPages,
      referringIps: row.referringIps,
      referringSubnets: row.referringSubnets,
      brokenBacklinks: row.brokenBacklinks,
      brokenPages: row.brokenPages,
      firstSeen: row.firstSeen ? row.firstSeen.toISOString() : null,
      lostDate: row.lostDate ? row.lostDate.toISOString() : null,
      referringLinksTld: parseDist(row.referringLinksTld),
      referringLinksTypes: parseDist(row.referringLinksTypes),
      referringLinksAttributes: parseDist(row.referringLinksAttributes),
      referringLinksPlatformTypes: parseDist(row.referringLinksPlatformTypes),
      referringLinksCountries: parseDist(row.referringLinksCountries),
      topBacklinks: JSON.parse(row.topBacklinks || '[]'),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
