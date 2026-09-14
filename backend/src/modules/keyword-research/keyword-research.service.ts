/**
 * Keyword Research Service — search volume, competition/CPC and
 * related/long-tail expansion for a set of operator-supplied seed keywords,
 * via DataForSEO Keywords Data (decision D5, wave-6 step 4).
 *
 * Gated exactly like `serp-intelligence` on the same vendor account:
 * `SWARM_ALLOW_LIVE=1` (the paid-call master switch) AND
 * `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`. Missing either fails closed
 * with a typed `ServiceUnavailableException` (HTTP 503) naming exactly what
 * to set — never a silent empty/fake result.
 *
 * @module keyword-research.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { DataForSeoKeywordsProvider, RELATED_SEED_LIMIT, type KeywordVolumeItem } from './keyword-research.provider';
import { KEYWORD_RESEARCH_LIMITS } from './dto/keyword-research.dto';
import type { RunKeywordResearchDto, ListKeywordSetsQueryDto, PriorityKeywordsQueryDto } from './dto/keyword-research.dto';

export interface KeywordResult {
  id: string;
  keyword: string;
  searchVolume: number | null;
  competition: string | null;
  competitionIndex: number | null;
  cpc: number | null;
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
  isRelated: boolean;
  isLongTail: boolean;
  createdAt: Date;
}

export interface PriorityKeyword extends KeywordResult {
  /**
   * 0-100, disclosed weights (see `PRIORITY_WEIGHTS`): 55% search volume
   * (normalized against the max volume in the ranked set), 25% inverse
   * advertiser-competition (a demand-pressure proxy, not organic ranking
   * difficulty — see the module's SPEC.md caveat), 20% commercial intent
   * (CPC, capped). Never a black-box number — every input is a real,
   * disclosed field on the row.
   */
  priorityScore: number;
}

export interface PriorityKeywordsResult {
  setId: string;
  rankedAt: string;
  weights: typeof PRIORITY_WEIGHTS;
  keywords: PriorityKeyword[];
  /** Keywords with no `searchVolume` (a failed per-keyword lookup) — excluded from ranking, never silently dropped. */
  unscored: KeywordResult[];
}

export interface KeywordSetResult {
  id: string;
  projectId: string;
  seedInput: string[];
  locationName: string | null;
  languageCode: string | null;
  status: 'pending' | 'completed' | 'partial' | 'failed';
  error: string | null;
  costUsd: number;
  createdAt: Date;
  finishedAt: Date | null;
  keywords: KeywordResult[];
}

/** 4+ words is the auditable long-tail line — no vendor field for this. */
const LONG_TAIL_MIN_WORDS = 4;

/** Same fallback convention as `SERP_LIMITS.defaultMaxCostPerCapture` in serp-intelligence. */
const DEFAULT_MAX_COST_PER_RUN = 5;

/**
 * "Select Priority Keywords to Target" (stage 10's fourth flowchart leaf).
 * Weights are disclosed rather than baked silently into one opaque number —
 * same discipline `scoring`'s versioned rubric and `page-analysis`'s
 * structureScore already follow.
 */
const PRIORITY_WEIGHTS = { volume: 0.55, competition: 0.25, commercialIntent: 0.2 } as const;

/** Above this, more CPC stops meaningfully changing the commercial-intent signal. */
const CPC_CAP_USD = 20;

const DEFAULT_PRIORITY_LIMIT = 20;
const MAX_PRIORITY_LIMIT = 100;

@Injectable()
export class KeywordResearchService {
  private readonly logger = new Logger(KeywordResearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
  ) {}

  /**
   * Run a keyword-research pass: seed volumes always, related/long-tail
   * expansion optionally (default on). Persists one `KeywordSet` + its
   * `Keyword` rows regardless of outcome once past the credential gate.
   *
   * @throws NotFoundException            unknown project
   * @throws BadRequestException          no usable keywords after normalization
   * @throws ServiceUnavailableException  DATAFORSEO_LOGIN/PASSWORD or SWARM_ALLOW_LIVE missing
   */
  async research(projectId: string, dto: RunKeywordResearchDto): Promise<KeywordSetResult> {
    await this.ensureProject(projectId);

    const keywords = this.normalizeKeywords(dto.keywords);
    if (keywords.length === 0) {
      throw new BadRequestException('At least one keyword is required.');
    }

    // Resolve (and gate) the provider BEFORE writing anything — a missing
    // credential must never leave a half-created row behind.
    const provider = this.resolveProvider();
    const lookupOpts = { locationName: dto.locationName?.trim(), languageCode: dto.languageCode?.trim() };

    const set = await this.prisma.keywordSet.create({
      data: {
        projectId,
        seedInput: JSON.stringify(keywords),
        locationName: lookupOpts.locationName || null,
        languageCode: lookupOpts.languageCode || null,
        status: 'pending',
      },
    });

    let costUsd = 0;
    let error: string | null = null;
    const rows: { keyword: string; item: KeywordVolumeItem | null; isRelated: boolean }[] = [];
    const seen = new Set<string>();

    try {
      const seedResp = await provider.searchVolume(keywords, lookupOpts);
      costUsd += seedResp.costUsd;
      const byKeyword = new Map(seedResp.items.map((it) => [it.keyword.toLowerCase(), it]));
      for (const kw of keywords) {
        seen.add(kw);
        rows.push({ keyword: kw, item: byKeyword.get(kw) ?? null, isRelated: false });
      }

      // The DTO's 200-keyword / 20-related-seed caps bound request SIZE, but
      // nothing previously bounded actual vendor-reported SPEND the way
      // `serp-intelligence`'s SERP_MAX_COST_PER_CAPTURE does for its own
      // DataForSEO calls — an audit flagged this as the one real gap against
      // that established pattern. Checked between the two calls (this module
      // only ever makes at most two) rather than pre-loop, since there is no
      // loop to gate mid-run.
      if (dto.includeRelated !== false && costUsd < this.maxCostPerRun()) {
        try {
          const relResp = await provider.relatedKeywords(keywords.slice(0, RELATED_SEED_LIMIT), lookupOpts);
          costUsd += relResp.costUsd;
          for (const item of relResp.items) {
            const norm = item.keyword.toLowerCase().trim();
            if (!norm || seen.has(norm)) continue; // don't shadow a seed row with a related one
            seen.add(norm);
            rows.push({ keyword: norm, item, isRelated: true });
          }
        } catch (relErr) {
          error = `Seed volumes saved; related-keyword expansion failed: ${(relErr as Error).message}`;
          this.logger.warn(`keyword set ${set.id} related-expansion failed: ${(relErr as Error).message}`);
        }
      } else if (dto.includeRelated !== false) {
        // Distinguish "not requested" from "skipped to stay under budget" —
        // an operator seeing partial results should know why, not guess.
        error = `Seed volumes saved; related-keyword expansion skipped — cost cap ($${this.maxCostPerRun().toFixed(2)}) reached after the seed call ($${costUsd.toFixed(4)}).`;
        this.logger.warn(`keyword set ${set.id} related-expansion skipped — cost cap reached ($${costUsd.toFixed(4)} spent)`);
      }
    } catch (err) {
      error = (err as Error).message;
      this.logger.warn(`keyword set ${set.id} search-volume call failed: ${error}`);
    }

    // `rows` is only ever empty when the seed call threw before pushing
    // anything — the `some(r => r.item)` half of the old condition was
    // redundant with `rows.length > 0` given the control flow above.
    const status: 'completed' | 'partial' | 'failed' = rows.length > 0 ? (error ? 'partial' : 'completed') : 'failed';

    const updated = await this.prisma.keywordSet.update({
      where: { id: set.id },
      data: {
        status,
        error,
        costUsd: Number(costUsd.toFixed(6)),
        finishedAt: new Date(),
        keywords: {
          create: rows.map(({ keyword, item, isRelated }) => ({
            keyword,
            searchVolume: item?.searchVolume ?? null,
            competition: item?.competition ?? null,
            competitionIndex: item?.competitionIndex ?? null,
            cpc: item?.cpc ?? null,
            lowTopOfPageBid: item?.lowTopOfPageBid ?? null,
            highTopOfPageBid: item?.highTopOfPageBid ?? null,
            isRelated,
            isLongTail: keyword.trim().split(/\s+/).filter(Boolean).length >= LONG_TAIL_MIN_WORDS,
          })),
        },
      },
      include: { keywords: true },
    });

    this.logger.log(`keyword set ${updated.id} ${status}: ${rows.length} keyword(s), $${costUsd.toFixed(4)}`);
    return this.toSetResult(updated);
  }

  /**
   * List keyword sets for a project, or one set (with its keywords) when
   * `setId` is given. `minVolume` filters the keyword rows either way.
   */
  async list(projectId: string, query: ListKeywordSetsQueryDto): Promise<{ sets: KeywordSetResult[] }> {
    await this.ensureProject(projectId);

    const keywordWhere = query.minVolume != null ? { searchVolume: { gte: query.minVolume } } : {};

    if (query.setId) {
      const set = await this.prisma.keywordSet.findUnique({
        where: { id: query.setId },
        include: { keywords: { where: keywordWhere, orderBy: { searchVolume: 'desc' } } },
      });
      if (!set || set.projectId !== projectId) {
        throw new NotFoundException(`Keyword set ${query.setId} not found for project ${projectId}`);
      }
      return { sets: [this.toSetResult(set)] };
    }

    const sets = await this.prisma.keywordSet.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { keywords: { where: keywordWhere, orderBy: { searchVolume: 'desc' } } },
    });
    return { sets: sets.map((s) => this.toSetResult(s)) };
  }

  /**
   * Rank a set's keywords into a priority-to-target order — the flowchart's
   * "Select Priority Keywords to Target" leaf, which had no implementation
   * anywhere before this. Deterministic: same rows in, same ranking out,
   * every input a disclosed field (see `PriorityKeyword.priorityScore`).
   *
   * Defaults to the project's most recent set with at least one scored
   * keyword (`completed` or `partial`) when `setId` is omitted.
   *
   * @throws NotFoundException  unknown project, unknown/foreign setId, or no eligible set exists yet
   */
  async priority(projectId: string, query: PriorityKeywordsQueryDto): Promise<PriorityKeywordsResult> {
    await this.ensureProject(projectId);

    const set = query.setId
      ? await this.prisma.keywordSet.findUnique({ where: { id: query.setId }, include: { keywords: true } })
      : await this.prisma.keywordSet.findFirst({
          where: { projectId, status: { in: ['completed', 'partial'] } },
          orderBy: { createdAt: 'desc' },
          include: { keywords: true },
        });

    if (!set || set.projectId !== projectId) {
      throw new NotFoundException(
        query.setId
          ? `Keyword set ${query.setId} not found for project ${projectId}`
          : `No completed/partial keyword set exists yet for project ${projectId} — POST .../keyword-research first`,
      );
    }

    const limit = Math.min(query.limit ?? DEFAULT_PRIORITY_LIMIT, MAX_PRIORITY_LIMIT);
    const results = set.keywords.map((k) => this.toKeywordResult(k));
    const scorable = results.filter((k) => k.searchVolume != null && k.searchVolume > 0);
    const unscored = results.filter((k) => k.searchVolume == null || k.searchVolume <= 0);

    const maxVolume = scorable.reduce((max, k) => Math.max(max, k.searchVolume ?? 0), 0) || 1;

    const ranked: PriorityKeyword[] = scorable
      .map((k) => {
        const volumeNorm = (k.searchVolume ?? 0) / maxVolume;
        // competitionIndex is 0-100 advertiser-competition pressure; missing
        // data is treated as mid-competition (50) rather than best-case (0),
        // so an unscored gap can never inflate a keyword's priority.
        const competitionNorm = 1 - (k.competitionIndex ?? 50) / 100;
        const cpcNorm = Math.min(k.cpc ?? 0, CPC_CAP_USD) / CPC_CAP_USD;
        const priorityScore = Math.round(
          100 *
            (PRIORITY_WEIGHTS.volume * volumeNorm +
              PRIORITY_WEIGHTS.competition * competitionNorm +
              PRIORITY_WEIGHTS.commercialIntent * cpcNorm),
        );
        return { ...k, priorityScore };
      })
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, limit);

    return { setId: set.id, rankedAt: new Date().toISOString(), weights: PRIORITY_WEIGHTS, keywords: ranked, unscored };
  }

  // ─── internals ─────────────────────────────────────────────

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  /** Trim, lowercase, dedupe, drop empties — same discipline as `serp-intelligence`. */
  private normalizeKeywords(keywords: string[]): string[] {
    const out = new Set<string>();
    for (const k of keywords ?? []) {
      const norm = (k ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, KEYWORD_RESEARCH_LIMITS.maxKeywordLen);
      if (norm.length >= 2) out.add(norm);
    }
    return [...out];
  }

  /**
   * Gate + construct the DataForSEO client. Mirrors
   * `SerpIntelligenceService.resolveProvider` exactly — same vendor account,
   * same master switch, so an operator who has already enabled live SERP
   * calls does not have to configure anything new for keyword research.
   */
  private resolveProvider(): DataForSeoKeywordsProvider {
    if (this.config.get<string>('SWARM_ALLOW_LIVE') !== '1') {
      throw new ServiceUnavailableException(
        'Live DataForSEO calls are blocked — set SWARM_ALLOW_LIVE=1 to allow paid Keywords Data requests.',
      );
    }
    const login = this.config.get<string>('DATAFORSEO_LOGIN');
    const password = this.config.get<string>('DATAFORSEO_PASSWORD');
    if (!login || !password) {
      throw new ServiceUnavailableException(
        'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not configured — set both env vars to run keyword research.',
      );
    }
    return new DataForSeoKeywordsProvider(this.fetcher, login, password);
  }

  /** Same env-var-with-fallback pattern as `serp-intelligence.service.ts`'s `maxCostPerCapture()`. */
  private maxCostPerRun(): number {
    const raw = this.config.get<string>('KEYWORD_RESEARCH_MAX_COST_PER_RUN');
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_COST_PER_RUN;
  }

  private toSetResult(set: {
    id: string;
    projectId: string;
    seedInput: string;
    locationName: string | null;
    languageCode: string | null;
    status: string;
    error: string | null;
    costUsd: number;
    createdAt: Date;
    finishedAt: Date | null;
    keywords: {
      id: string;
      keyword: string;
      searchVolume: number | null;
      competition: string | null;
      competitionIndex: number | null;
      cpc: number | null;
      lowTopOfPageBid: number | null;
      highTopOfPageBid: number | null;
      isRelated: boolean;
      isLongTail: boolean;
      createdAt: Date;
    }[];
  }): KeywordSetResult {
    return {
      id: set.id,
      projectId: set.projectId,
      seedInput: JSON.parse(set.seedInput) as string[],
      locationName: set.locationName,
      languageCode: set.languageCode,
      status: set.status as KeywordSetResult['status'],
      error: set.error,
      costUsd: set.costUsd,
      createdAt: set.createdAt,
      finishedAt: set.finishedAt,
      keywords: set.keywords.map((k) => this.toKeywordResult(k)),
    };
  }

  private toKeywordResult(k: {
    id: string;
    keyword: string;
    searchVolume: number | null;
    competition: string | null;
    competitionIndex: number | null;
    cpc: number | null;
    lowTopOfPageBid: number | null;
    highTopOfPageBid: number | null;
    isRelated: boolean;
    isLongTail: boolean;
    createdAt: Date;
  }): KeywordResult {
    return {
      id: k.id,
      keyword: k.keyword,
      searchVolume: k.searchVolume,
      competition: k.competition,
      competitionIndex: k.competitionIndex,
      cpc: k.cpc,
      lowTopOfPageBid: k.lowTopOfPageBid,
      highTopOfPageBid: k.highTopOfPageBid,
      isRelated: k.isRelated,
      isLongTail: k.isLongTail,
      createdAt: k.createdAt,
    };
  }
}
