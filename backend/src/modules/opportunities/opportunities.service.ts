/**
 * Opportunities Service — P07, platform_improvement_plan.md §12.5-§12.7.
 *
 * The canonical `Opportunity` ("idea") record, and the **observed-corpus**
 * keyword-gap engine that feeds it (§12.6). This is explicitly NOT a claim of
 * discovering a rival's complete ranking universe — every gap is computed
 * only within keywords/queries this project has actually captured (tracked
 * SERP snapshots + keyword-research sets), and every result preserves the
 * exact checked depth / query / location / device / capture date it came
 * from.
 *
 * Four gap rules (§12.6), each with its own `evidenceSourceFamily`:
 *
 *   (a) `serp-keyword-gap-absent`  — client not found within checked depth
 *       on a tracked query where a confirmed competitor IS observed.
 *   (b) `serp-keyword-gap-below`   — client observed, but below a confirmed
 *       rival by >= `marginThreshold` positions.
 *   (c) `serp-keyword-gap-unknown` — the capture itself failed
 *       (`SerpSnapshot.status === 'failed'`), so the client's position is
 *       genuinely unknown. Carried as its own family with wording that
 *       never asserts a gap: §12.6 requires a null rank from a failed
 *       capture to be `unknown`, not "not ranking". Deliberately kept
 *       separate from (a), which needs a clean capture to mean anything.
 *   (d) `keyword-research-topic-suggestion` — a relevant keyword this
 *       project's own keyword research identified, that has no tracked SERP
 *       query at all yet. Labeled a **topic suggestion**, never a verified
 *       ranking gap — per §12.6's requirement to distinguish "a topic
 *       observed in rival content/AI answers but not yet measured as a
 *       Google keyword" from a real gap. This build has no per-topic rival
 *       AI-answer/content corpus to mine (that is `aeo-audit`'s territory,
 *       explicitly off limits here) — the honest analogue available today is
 *       "relevant per keyword-research, not yet SERP-tracked", so that is
 *       exactly what is labeled, nothing stronger.
 *
 * Rival data comes from what `competitors`/`serp-intelligence` ALREADY store
 * (`Competitor.status = 'tracked'`, `SerpResult.topDomains`/`competitorsSeen`)
 * — this module never triggers a new SERP or AEO run, matching the read-only
 * discipline `competitors.service.ts` documents for itself.
 *
 * Dedup identity (§12.6's last paragraph): (projectId, topic, market,
 * language, intent, evidenceSourceFamily) is a DB unique constraint
 * (`Opportunity.opportunityIdentity`) — re-running analysis always upserts
 * onto the same row. A `dismissed` row's status is never touched by
 * `analyze()`; only an explicit `dismiss`/`reopen` call (each requiring its
 * own reason) can change it.
 *
 * @module opportunities.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GrowthExecutionService } from '../growth-execution/growth-execution.service';
import { hostOf } from '../../common/utils/subject-match';
import type {
  AnalyzeOpportunitiesDto,
  ConvertOpportunityDto,
  DismissOpportunityDto,
  ListOpportunitiesQueryDto,
  ReopenOpportunityDto,
} from './dto/opportunities.dto';
import type {
  AnalyzeOpportunitiesResult,
  OpportunityDto,
  OpportunityEvidence,
  OpportunityOrigin,
  OpportunityStatus,
  PositionStatus,
} from './opportunities.types';

const DEFAULT_MARGIN_THRESHOLD = 5;
/** §12.6's "not-measured" line: a keyword-research keyword this far above the floor, with no tracked SERP query, is worth surfacing as a topic suggestion. Keeps the pass bounded and relevant rather than dumping every unscored keyword. */
const TOPIC_SUGGESTION_MIN_VOLUME = 10;
const MAX_TOPIC_SUGGESTIONS_PER_RUN = 30;

interface Candidate {
  origin: OpportunityOrigin;
  topic: string;
  topicDisplay: string;
  /** Never stored as SQL NULL — SQLite treats NULL as distinct per row in a unique index, which would silently break dedup identity for opportunities with no market/language. '' means "unspecified", exposed as null in the DTO. */
  market: string;
  language: string;
  intent: string;
  evidenceSourceFamily: string;
  reason: string;
  evidence: OpportunityEvidence;
  clientPositionStatus: PositionStatus;
  clientPosition: number | null;
  rivalPositionStatus: PositionStatus;
  rivalPosition: number | null;
  rivalName: string | null;
  rivalCompetitorId: string | null;
  suggestedContentType: string | null;
}

function normalizeTopic(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

@Injectable()
export class OpportunitiesService {
  private readonly logger = new Logger(OpportunitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly growthExecution: GrowthExecutionService,
  ) {}

  private async requireProject(projectId: string): Promise<{ id: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  // ─── Keyword-gap analysis (§12.6) ───────────────────────────────────

  async analyze(projectId: string, dto: AnalyzeOpportunitiesDto): Promise<AnalyzeOpportunitiesResult> {
    await this.requireProject(projectId);
    const marginThreshold = dto.marginThreshold ?? DEFAULT_MARGIN_THRESHOLD;

    const competitors = await this.prisma.competitor.findMany({
      where: { projectId, status: 'tracked' },
    });
    const competitorByName = new Map(competitors.map((c) => [c.name.toLowerCase(), c]));
    const competitorByHost = new Map(
      competitors.filter((c) => c.domain).map((c) => [hostOf(c.domain!) ?? c.domain!, c]),
    );

    const trackers = await this.prisma.serpTracker.findMany({ where: { projectId } });
    const candidates: Candidate[] = [];
    let queriesConsidered = 0;

    for (const tracker of trackers) {
      const queries = await this.prisma.serpQuery.findMany({
        where: { trackerId: tracker.id },
        include: { results: { orderBy: { capturedAt: 'desc' }, take: 1, include: { snapshot: true } } },
      });

      for (const query of queries) {
        const result = query.results[0];
        if (!result) continue;
        queriesConsidered++;

        const checkedDepth = (() => {
          try {
            return (JSON.parse(result.topDomains || '[]') as unknown[]).length;
          } catch {
            return 0;
          }
        })();

        // A null subjectRank from a FAILED capture is `unknown`, never
        // coerced into "not ranking" (§12.6). `SerpSnapshot.status` is the
        // only signal this schema has for a failed vs. clean capture.
        const captureFailed = result.snapshot?.status === 'failed';
        const clientPositionStatus: PositionStatus = captureFailed
          ? 'unknown'
          : result.subjectRank != null
            ? 'ranked'
            : 'not-observed';
        const clientPosition = clientPositionStatus === 'ranked' ? result.subjectRank : null;

        let topDomains: Array<{ domain: string; rank: number }> = [];
        let competitorsSeen: string[] = [];
        try {
          topDomains = JSON.parse(result.topDomains || '[]');
        } catch {
          topDomains = [];
        }
        try {
          competitorsSeen = JSON.parse(result.competitorsSeen || '[]');
        } catch {
          competitorsSeen = [];
        }

        for (const entry of topDomains) {
          const host = hostOf(entry.domain) ?? entry.domain;
          const byHost = competitorByHost.get(host);
          const byName = competitorsSeen
            .map((n) => competitorByName.get(n.toLowerCase()))
            .find((c) => c && (!byHost || c.id === byHost.id));
          const competitor = byHost ?? byName;
          if (!competitor) continue;

          const evidenceBase: Omit<OpportunityEvidence, 'kind' | 'note'> = {
            capturedAt: result.capturedAt.toISOString(),
            query: query.keyword,
            locationName: tracker.locationName,
            languageCode: tracker.languageCode,
            device: tracker.device,
            checkedDepth,
            competitorId: competitor.id,
            competitorName: competitor.name,
            competitorPosition: entry.rank,
            clientPosition,
            sourceId: result.id,
          };

          if (clientPositionStatus === 'not-observed') {
            // Rule (a): client not found within checked depth (a clean
            // capture that just didn't see it); confirmed rival IS observed.
            candidates.push({
              origin: 'search-gap',
              topic: normalizeTopic(query.keyword),
              topicDisplay: query.keyword,
              market: tracker.locationName ?? '',
              language: tracker.languageCode ?? '',
              intent: 'unspecified',
              evidenceSourceFamily: 'serp-keyword-gap-absent',
              reason: `${competitor.name} ranks #${entry.rank} for "${query.keyword}" (checked top ${checkedDepth}); this project was not found within the same checked depth.`,
              evidence: { ...evidenceBase, kind: 'serp-keyword-gap-absent', note: 'Client absent within checked depth; confirmed rival observed.' },
              clientPositionStatus,
              clientPosition,
              rivalPositionStatus: 'ranked',
              rivalPosition: entry.rank,
              rivalName: competitor.name,
              rivalCompetitorId: competitor.id,
              suggestedContentType: 'article',
            });
          } else if (clientPositionStatus === 'unknown') {
            // A FAILED capture — §12.6: "Null rank from a failed capture is
            // unknown, not 'not ranking'." This is surfaced (a rival is
            // genuinely observed here, worth a human's attention) but with
            // its own evidenceSourceFamily and honest wording — it is never
            // asserted as a confirmed absence/gap the way rule (a) is.
            candidates.push({
              origin: 'search-gap',
              topic: normalizeTopic(query.keyword),
              topicDisplay: query.keyword,
              market: tracker.locationName ?? '',
              language: tracker.languageCode ?? '',
              intent: 'unspecified',
              evidenceSourceFamily: 'serp-keyword-gap-unknown',
              reason: `${competitor.name} ranks #${entry.rank} for "${query.keyword}", but this project's own capture failed — its position is unknown, not a confirmed absence, and should be re-checked.`,
              evidence: { ...evidenceBase, kind: 'serp-keyword-gap-unknown', note: "Client capture failed; position unknown — never coerced to 'not ranking'." },
              clientPositionStatus,
              clientPosition,
              rivalPositionStatus: 'ranked',
              rivalPosition: entry.rank,
              rivalName: competitor.name,
              rivalCompetitorId: competitor.id,
              suggestedContentType: null,
            });
          } else if (clientPosition != null && clientPositionStatus === 'ranked' && clientPosition - entry.rank >= marginThreshold) {
            // Rule (b): client observed below rival by a meaningful margin.
            candidates.push({
              origin: 'search-gap',
              topic: normalizeTopic(query.keyword),
              topicDisplay: query.keyword,
              market: tracker.locationName ?? '',
              language: tracker.languageCode ?? '',
              intent: 'unspecified',
              evidenceSourceFamily: 'serp-keyword-gap-below',
              reason: `${competitor.name} ranks #${entry.rank} for "${query.keyword}" vs. this project's #${clientPosition} — a ${clientPosition - entry.rank}-position gap (checked top ${checkedDepth}).`,
              evidence: { ...evidenceBase, kind: 'serp-keyword-gap-below', note: `Client below confirmed rival by ${clientPosition - entry.rank} position(s).` },
              clientPositionStatus,
              clientPosition,
              rivalPositionStatus: 'ranked',
              rivalPosition: entry.rank,
              rivalName: competitor.name,
              rivalCompetitorId: competitor.id,
              suggestedContentType: 'seo-fix',
            });
          }
        }
      }
    }

    // Rule (c): relevant keyword-research topics with no tracked SERP query
    // at all — labeled a topic suggestion, never a verified gap (see header).
    const trackedKeywords = new Set(
      (await this.prisma.serpQuery.findMany({ where: { tracker: { projectId } }, select: { keyword: true } })).map(
        (q) => normalizeTopic(q.keyword),
      ),
    );
    const keywordSet = dto.keywordSetId
      ? await this.prisma.keywordSet.findUnique({ where: { id: dto.keywordSetId }, include: { keywords: true } })
      : await this.prisma.keywordSet.findFirst({
          where: { projectId, status: { in: ['completed', 'partial'] } },
          orderBy: { createdAt: 'desc' },
          include: { keywords: true },
        });

    if (keywordSet && keywordSet.projectId === projectId) {
      const topicRows = keywordSet.keywords
        .filter((k) => !trackedKeywords.has(normalizeTopic(k.keyword)))
        .filter((k) => (k.searchVolume ?? 0) >= TOPIC_SUGGESTION_MIN_VOLUME)
        .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0))
        .slice(0, MAX_TOPIC_SUGGESTIONS_PER_RUN);

      for (const k of topicRows) {
        candidates.push({
          origin: 'search-gap',
          topic: normalizeTopic(k.keyword),
          topicDisplay: k.keyword,
          market: keywordSet.locationName ?? '',
          language: keywordSet.languageCode ?? '',
          intent: 'unspecified',
          evidenceSourceFamily: 'keyword-research-topic-suggestion',
          reason: `Keyword research found real search demand (~${k.searchVolume}/mo) for "${k.keyword}", but this project has no tracked SERP query for it yet — a topic suggestion, not a verified ranking gap.`,
          evidence: {
            kind: 'keyword-research-topic-suggestion',
            capturedAt: keywordSet.finishedAt?.toISOString() ?? keywordSet.createdAt.toISOString(),
            query: k.keyword,
            locationName: keywordSet.locationName,
            languageCode: keywordSet.languageCode,
            device: null,
            checkedDepth: null,
            competitorId: null,
            competitorName: null,
            competitorPosition: null,
            clientPosition: null,
            sourceId: k.id,
            note: 'Relevant per keyword research; not yet a tracked Google keyword. Not a verified ranking gap.',
          },
          clientPositionStatus: 'unknown',
          clientPosition: null,
          rivalPositionStatus: 'unknown',
          rivalPosition: null,
          rivalName: null,
          rivalCompetitorId: null,
          suggestedContentType: 'article',
        });
      }
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const results: OpportunityDto[] = [];

    for (const c of candidates) {
      const { row, wasCreated, wasUpdated } = await this.upsertCandidate(projectId, c);
      if (wasCreated) created++;
      else if (wasUpdated) updated++;
      else unchanged++;
      results.push(this.toDto(row));
    }

    this.logger.log(
      `opportunities: analyzed ${projectId} — ${queriesConsidered} SERP quer(y/ies), ${competitors.length} confirmed competitor(s), ${created} created / ${updated} updated / ${unchanged} unchanged`,
    );

    return {
      projectId,
      analyzedAt: new Date().toISOString(),
      serpQueriesConsidered: queriesConsidered,
      confirmedCompetitorsConsidered: competitors.length,
      created,
      updated,
      unchanged,
      opportunities: results,
      note:
        'Gaps are computed strictly within the observed keyword corpus (tracked SERP queries + keyword research) — this does not claim to know a rival\'s full ranking universe. keyword-research-topic-suggestion rows are topic suggestions, not verified ranking gaps.',
    };
  }

  private async upsertCandidate(
    projectId: string,
    c: Candidate,
  ): Promise<{ row: Awaited<ReturnType<typeof this.prisma.opportunity.create>>; wasCreated: boolean; wasUpdated: boolean }> {
    const existing = await this.prisma.opportunity.findUnique({
      where: {
        opportunityIdentity: {
          projectId,
          topic: c.topic,
          market: c.market,
          language: c.language,
          intent: c.intent,
          evidenceSourceFamily: c.evidenceSourceFamily,
        },
      },
    });

    const demand = await this.lookupDemand(projectId, c.topic);
    const existingContentMatchId = await this.lookupExistingContent(projectId, c.topic);
    const relevance = this.scoreRelevance(c, demand.demandVolume);

    if (!existing) {
      const row = await this.prisma.opportunity.create({
        data: {
          projectId,
          origin: c.origin,
          topic: c.topic,
          topicDisplay: c.topicDisplay,
          market: c.market,
          language: c.language,
          intent: c.intent,
          evidenceSourceFamily: c.evidenceSourceFamily,
          reason: c.reason,
          evidence: JSON.stringify([c.evidence]),
          measuredAt: new Date(c.evidence.capturedAt),
          clientPositionStatus: c.clientPositionStatus,
          clientPosition: c.clientPosition,
          rivalPositionStatus: c.rivalPositionStatus,
          rivalPosition: c.rivalPosition,
          rivalName: c.rivalName,
          rivalCompetitorId: c.rivalCompetitorId,
          relevance,
          demandVolume: demand.demandVolume,
          demandCpc: demand.demandCpc,
          demandCompetition: demand.demandCompetition,
          suggestedContentType: c.suggestedContentType,
          existingContentMatchId,
          status: 'new',
        },
      });
      return { row, wasCreated: true, wasUpdated: false };
    }

    // §12.6: re-running analysis updates evidence/current recommendation on
    // the SAME row — never a duplicate — and never reopens a deliberately
    // dismissed idea. `status`/`dismissedReason`/`dismissedAt` are therefore
    // never touched here, for ANY existing status.
    let evidenceList: OpportunityEvidence[] = [];
    try {
      evidenceList = JSON.parse(existing.evidence) as OpportunityEvidence[];
    } catch {
      evidenceList = [];
    }
    evidenceList.push(c.evidence);

    const row = await this.prisma.opportunity.update({
      where: { id: existing.id },
      data: {
        topicDisplay: c.topicDisplay,
        reason: c.reason,
        evidence: JSON.stringify(evidenceList),
        measuredAt: new Date(c.evidence.capturedAt),
        clientPositionStatus: c.clientPositionStatus,
        clientPosition: c.clientPosition,
        rivalPositionStatus: c.rivalPositionStatus,
        rivalPosition: c.rivalPosition,
        rivalName: c.rivalName,
        rivalCompetitorId: c.rivalCompetitorId,
        relevance,
        demandVolume: demand.demandVolume,
        demandCpc: demand.demandCpc,
        demandCompetition: demand.demandCompetition,
        suggestedContentType: c.suggestedContentType,
        existingContentMatchId,
      },
    });
    return { row, wasCreated: false, wasUpdated: true };
  }

  private async lookupDemand(
    projectId: string,
    topic: string,
  ): Promise<{ demandVolume: number | null; demandCpc: number | null; demandCompetition: string | null }> {
    const row = await this.prisma.keyword.findFirst({
      where: { keyword: topic, set: { projectId } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return { demandVolume: null, demandCpc: null, demandCompetition: null };
    // Missing volume/CPC stays `unavailable` (null), never coerced to zero (§12.6).
    return { demandVolume: row.searchVolume, demandCpc: row.cpc, demandCompetition: row.competition };
  }

  /**
   * SQLite's Prisma client has no `mode: 'insensitive'` filter (Postgres
   * only), so this matches the same convention `competitors.service.ts` uses
   * for case-insensitive identity: fetch the small candidate set and compare
   * lowercased in JS rather than relying on an unsupported query mode.
   */
  private async lookupExistingContent(projectId: string, topic: string): Promise<string | null> {
    const assets = await this.prisma.growthAsset.findMany({
      where: { projectId, targetKeyword: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, targetKeyword: true },
    });
    return assets.find((a) => (a.targetKeyword ?? '').toLowerCase() === topic)?.id ?? null;
  }

  /** Disclosed formula, not a promise: demand (0-60) + gap-type weight (0-40). Same discipline as keyword-research's priorityScore. */
  private scoreRelevance(c: Candidate, demandVolume: number | null): number {
    const demandComponent = demandVolume != null ? Math.min(60, Math.round((Math.log10(demandVolume + 1) / 4) * 60)) : 20;
    const typeComponent =
      c.evidenceSourceFamily === 'serp-keyword-gap-absent' ? 40 : c.evidenceSourceFamily === 'serp-keyword-gap-below' ? 30 : 15;
    return Math.min(100, demandComponent + typeComponent);
  }

  // ─── List / read ─────────────────────────────────────────────────────

  async list(projectId: string, query: ListOpportunitiesQueryDto): Promise<{ total: number; page: number; pageSize: number; opportunities: OpportunityDto[] }> {
    await this.requireProject(projectId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const where: any = { projectId };
    if (query.status) where.status = query.status;
    if (query.origin) where.origin = query.origin;
    // SQLite's LIKE (what Prisma's `contains` compiles to here) is already
    // case-insensitive for ASCII, and sqlite's Prisma client has no `mode`
    // filter option (Postgres-only) — see `lookupExistingContent`'s note.
    if (query.search) where.topicDisplay = { contains: query.search };

    const [total, rows] = await Promise.all([
      this.prisma.opportunity.count({ where }),
      this.prisma.opportunity.findMany({
        where,
        orderBy: [{ relevance: 'desc' }, { measuredAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { total, page, pageSize, opportunities: rows.map((r) => this.toDto(r)) };
  }

  async get(projectId: string, opportunityId: string): Promise<OpportunityDto> {
    const row = await this.requireOpportunity(projectId, opportunityId);
    return this.toDto(row);
  }

  private async requireOpportunity(projectId: string, opportunityId: string) {
    const row = await this.prisma.opportunity.findUnique({ where: { id: opportunityId } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Opportunity ${opportunityId} not found for project ${projectId}`);
    }
    return row;
  }

  // ─── Dismiss / reopen ────────────────────────────────────────────────

  async dismiss(projectId: string, opportunityId: string, dto: DismissOpportunityDto): Promise<OpportunityDto> {
    await this.requireOpportunity(projectId, opportunityId);
    const row = await this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: { status: 'dismissed', dismissedReason: dto.reason, dismissedAt: new Date() },
    });
    return this.toDto(row);
  }

  /** Explicit human reopen — always requires its OWN new reason, distinct from the analysis engine's silent-preserve behavior. */
  async reopen(projectId: string, opportunityId: string, dto: ReopenOpportunityDto): Promise<OpportunityDto> {
    await this.requireOpportunity(projectId, opportunityId);
    const row = await this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: { status: 'new', dismissedReason: null, dismissedAt: null, reason: `Reopened: ${dto.reason}` },
    });
    return this.toDto(row);
  }

  // ─── §12.7: Opportunity -> content conversion contract (DESIGN + basic wiring only) ──
  //
  // Full brief-family/stable-identity rework is P08's job (§13.2) — this is
  // deliberately the minimal real thing: an idempotent create-from-opportunity
  // action against the EXISTING `GrowthAsset` identity
  // (`GrowthExecutionService.createFromOpportunity`), which itself already
  // checks idempotencyKey uniqueness and any pre-existing linked draft before
  // writing. This method only adds the opportunity-side bookkeeping: mark the
  // source `in-progress`/linked, never delete it.
  async convertToContent(projectId: string, opportunityId: string, dto: ConvertOpportunityDto): Promise<{ opportunity: OpportunityDto; asset: unknown; created: boolean }> {
    const existing = await this.requireOpportunity(projectId, opportunityId);

    const { asset, created } = await this.growthExecution.createFromOpportunity(projectId, {
      sourceOpportunityId: opportunityId,
      idempotencyKey: dto.idempotencyKey,
      assetType: dto.assetType ?? 'article',
      title: `${existing.topicDisplay}`,
      brief: `${existing.reason} Suggested type: ${existing.suggestedContentType ?? 'article'}.`,
      targetKeyword: existing.topic,
    });

    const row = await this.prisma.opportunity.update({
      where: { id: opportunityId },
      data:
        existing.status === 'converted' || existing.linkedGrowthAssetId
          ? {}
          : { status: 'converted', linkedGrowthAssetId: asset.id },
    });

    return { opportunity: this.toDto(row), asset, created };
  }

  // ─── DTO mapping ─────────────────────────────────────────────────────

  private toDto(row: {
    id: string;
    projectId: string;
    origin: string;
    topic: string;
    topicDisplay: string;
    market: string | null;
    language: string | null;
    intent: string;
    evidenceSourceFamily: string;
    reason: string;
    evidence: string;
    measuredAt: Date;
    clientPositionStatus: string;
    clientPosition: number | null;
    rivalPositionStatus: string;
    rivalPosition: number | null;
    rivalName: string | null;
    rivalCompetitorId: string | null;
    relevance: number;
    demandVolume: number | null;
    demandCpc: number | null;
    demandCompetition: string | null;
    suggestedContentType: string | null;
    existingContentMatchId: string | null;
    status: string;
    dismissedReason: string | null;
    dismissedAt: Date | null;
    linkedGrowthAssetId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): OpportunityDto {
    let evidence: OpportunityEvidence[] = [];
    try {
      evidence = JSON.parse(row.evidence) as OpportunityEvidence[];
    } catch {
      evidence = [];
    }
    return {
      id: row.id,
      projectId: row.projectId,
      origin: row.origin as OpportunityOrigin,
      topic: row.topic,
      topicDisplay: row.topicDisplay,
      // '' means "unspecified" internally (see the Candidate type's note); exposed as null.
      market: row.market || null,
      language: row.language || null,
      intent: row.intent,
      evidenceSourceFamily: row.evidenceSourceFamily,
      reason: row.reason,
      evidence,
      measuredAt: row.measuredAt.toISOString(),
      clientPositionStatus: row.clientPositionStatus as PositionStatus,
      clientPosition: row.clientPosition,
      rivalPositionStatus: row.rivalPositionStatus as PositionStatus,
      rivalPosition: row.rivalPosition,
      rivalName: row.rivalName,
      rivalCompetitorId: row.rivalCompetitorId,
      relevance: row.relevance,
      demandVolume: row.demandVolume,
      demandCpc: row.demandCpc,
      demandCompetition: row.demandCompetition,
      suggestedContentType: row.suggestedContentType,
      existingContentMatchId: row.existingContentMatchId,
      status: row.status as OpportunityStatus,
      dismissedReason: row.dismissedReason,
      dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
      linkedGrowthAssetId: row.linkedGrowthAssetId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
