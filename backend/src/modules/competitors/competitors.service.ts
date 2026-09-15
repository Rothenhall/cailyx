/**
 * Competitors Service — promotes `Project.competitors` (JSON) into
 * first-class `Competitor` rows, builds a light per-competitor profile, and
 * produces an honest client-vs-competitor gap comparison (decision D4,
 * `docs/analysis/wave-6-audit-pipeline.md`).
 *
 * D4: "light now, structured to deepen later" — per competitor this reuses
 * `TechStackService.scanDomain` unchanged, reads schema.org/JSON-LD off the
 * homepage, and attaches whatever SERP/AEO presence already exists for that
 * competitor. It never triggers a fresh SERP or AEO run, and it never runs
 * the full `technical-audit` module per competitor — both are explicitly out
 * of scope for this module.
 *
 * @module competitors.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { TechStackService, type TechStackScanResult } from '../tech-stack/tech-stack.service';
import { PresenceDiscoveryService } from '../digital-presence/presence.discovery.service';
import { PLATFORM_GROUP, PLATFORM_LABELS, type PresencePlatform } from '../digital-presence/presence.types';
import {
  PresenceDirectoryRatingService,
  RATABLE_PLATFORMS,
} from '../digital-presence/presence.directory-rating.service';
import { extractPageSignals } from '../technical-audit/checks/page-signals';
import { findPageIssues, scorePage } from '../technical-audit/checks/seo-rubric';
import { parseCompetitors, hostOf } from '../../common/utils/subject-match';
import type { CompetitorInputDto, DiscoverCompetitorsDto } from './dto/competitors.dto';

/** One external profile found on a competitor's own site. */
export interface CompetitorPresenceAccount {
  platform: string;
  label: string;
  group: string;
  url: string;
  handle: string | null;
  state: string;
}

/** Mirrors `CompetitorStanding` in aeo-audit.types.ts — the subset attached here. */
export interface AttachedAeoStanding {
  name: string;
  observations: number;
  mentionRate: number;
  clientAheadCount: number;
  clientBehindCount: number;
  wonWhileClientAbsent: number;
  /** From `AeoVerdict.counted.shareOfVoice`, when this competitor appears there. */
  shareOfVoice: number | null;
  auditId: string;
  generatedAt: string | null;
}

/**
 * Stage 7's "Competitor Content" read, from the rival's homepage only.
 *
 * Homepage-only is a real limit, not a hedge: a content *inventory* (how many
 * articles, which topics, how often they publish) needs their sitemap crawled,
 * which this module does not do. What is here is what one already-fetched page
 * honestly supports.
 */
export interface CompetitorContentSignals {
  wordCount: number;
  h1Count: number;
  headingCount: number;
  imageCount: number;
  imagesMissingAlt: number;
  titleLength: number | null;
  metaDescriptionLength: number | null;
  jsonLdCount: number;
  noindex: boolean;
}

/** One directory listing's published rating. `found: false` is kept, never dropped. */
export interface CompetitorReviewRating {
  platform: string;
  label: string;
  url: string;
  found: boolean;
  rating: number | null;
  ratingCount: number | null;
  scale: number | null;
}

/** Summary of what an existing SERP tracker's results say about one competitor. */
export interface AttachedSerpPresence {
  occurrences: number;
  bestRank: number | null;
  sampleKeyword: string | null;
  capturedAt: string | null;
}

export interface CompetitorRecord {
  id: string;
  projectId: string;
  name: string;
  domain: string | null;
  source: string;
  status: string;
  createdAt: Date;
}

export interface CompetitorProfileResult {
  id: string;
  competitorId: string;
  domain: string | null;
  status: 'completed' | 'failed' | 'skipped';
  error: string | null;
  techScanId: string | null;
  schemaTypes: string[];
  /** The rival's own external profiles — company only. */
  presenceStatus: 'completed' | 'skipped' | 'failed' | 'unknown';
  presenceAccounts: CompetitorPresenceAccount[];
  presenceError: string | null;
  aeoStatus: 'present' | 'absent' | 'unknown';
  aeoStanding: AttachedAeoStanding | null;
  serpStatus: 'present' | 'absent' | 'unknown';
  serpPresence: AttachedSerpPresence | null;
  /** Stage 7 "Competitor SEO" — homepage only, scored by the client's own rubric. */
  seoStatus: 'completed' | 'skipped' | 'failed' | 'unknown';
  seoScore: number | null;
  seoIssues: string[];
  seoError: string | null;
  /** Stage 7 "Competitor Content" — homepage only. */
  contentSignals: CompetitorContentSignals | null;
  /** Stage 7 "Competitor Reviews" — published AggregateRating, no vendor. */
  reviewStatus: 'completed' | 'skipped' | 'failed' | 'unknown';
  reviewRatings: CompetitorReviewRating[];
  reviewError: string | null;
  createdAt: Date;
}

export interface CompetitorWithProfile extends CompetitorRecord {
  latestProfile: CompetitorProfileResult | null;
}

export interface DiscoverResult {
  projectId: string;
  totalCompetitors: number;
  promoted: number;
  competitors: CompetitorWithProfile[];
}

/** One line of the tech/schema diff table in the gap report. */
export interface GapDiffLine {
  key: string;
  client: boolean;
  competitors: string[];
}

export interface GapCompetitorRow {
  competitorId: string;
  name: string;
  domain: string | null;
  aeoStatus: 'present' | 'absent' | 'unknown';
  aeoStanding: AttachedAeoStanding | null;
  serpStatus: 'present' | 'absent' | 'unknown';
  serpPresence: AttachedSerpPresence | null;
  /** Platform keys this rival was found on — company profiles only. */
  presencePlatforms: string[];
  /** Homepage SEO score (0-100) on the client's own rubric. Null when not scored. */
  seoScore: number | null;
  seoIssues: string[];
  contentSignals: CompetitorContentSignals | null;
  /** Only listings that actually publish a rating. */
  reviewRatings: CompetitorReviewRating[];
}

export interface GapResult {
  projectId: string;
  domain: string;
  generatedAt: string;
  tech: {
    client: string[];
    clientOnly: GapDiffLine[];
    competitorsOnly: GapDiffLine[];
    shared: GapDiffLine[];
  };
  schema: {
    client: string[];
    clientOnly: GapDiffLine[];
    competitorsOnly: GapDiffLine[];
    shared: GapDiffLine[];
  };
  /**
   * External presence, same diff shape. This is the row a client actually
   * reacts to — "three of your four rivals are on Clutch and you are not" is a
   * decision, where a tech-stack diff is trivia.
   */
  presence: {
    client: string[];
    clientOnly: GapDiffLine[];
    competitorsOnly: GapDiffLine[];
    shared: GapDiffLine[];
  };
  /** The client's own homepage score + content read, for comparison. */
  seo: {
    client: {
      status: 'completed' | 'failed';
      score: number | null;
      issues: string[];
      contentSignals: CompetitorContentSignals | null;
      error: string | null;
    };
    note: string;
  };
  /** The client's own published directory ratings, newest per platform. */
  reviews: {
    client: CompetitorReviewRating[];
    note: string;
  };
  competitors: GapCompetitorRow[];
  note: string;
}

@Injectable()
export class CompetitorsService {
  private readonly logger = new Logger(CompetitorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: FetcherService,
    private readonly techStack: TechStackService,
    private readonly presence: PresenceDiscoveryService,
    private readonly directoryRating: PresenceDirectoryRatingService,
  ) {}

  private async requireProject(projectId: string): Promise<{ id: string; domain: string; competitors: string | null }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, domain: true, competitors: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  /**
   * Promote `Project.competitors` (JSON) — merged with any explicit list in
   * the request body — into `Competitor` rows, then build a fresh light
   * profile for each. Idempotent on identity (name, case-insensitive, is
   * unique per project) but never on profile data: every call writes a new
   * `CompetitorProfile` row, same convention as `TechStackScan`.
   */
  async discover(projectId: string, dto: DiscoverCompetitorsDto): Promise<DiscoverResult> {
    const project = await this.requireProject(projectId);
    const fromJson = parseCompetitors(project.competitors);
    const explicit = (dto.competitors ?? []).map((c: CompetitorInputDto) => ({
      name: c.name.trim(),
      domain: c.domain?.trim() || null,
    }));

    const byName = new Map<string, { name: string; domain: string | null; source: string }>();
    for (const c of fromJson) {
      if (!c.name) continue;
      byName.set(c.name.toLowerCase(), { name: c.name, domain: c.domain, source: 'project-json' });
    }
    for (const c of explicit) {
      if (!c.name) continue;
      const key = c.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        // Enrich an already-known competitor with a domain the JSON lacked,
        // but keep its provenance — it was already on the project.
        if (!existing.domain && c.domain) existing.domain = c.domain;
      } else {
        byName.set(key, { name: c.name, domain: c.domain, source: 'manual' });
      }
    }

    // SQLite's default collation is case-sensitive (no NOCASE applied to
    // `Competitor.name`), so `@@unique([projectId, name])` alone does NOT
    // give the case-insensitive identity this method's own docstring
    // promises. Looked up once, in memory, against every existing row for
    // this project rather than per-entry `findUnique` — cheaper, and the
    // only way to actually enforce "case-insensitive" without a DB collation.
    const existingRows = await this.prisma.competitor.findMany({ where: { projectId } });
    const existingByLowerName = new Map(existingRows.map((r) => [r.name.toLowerCase(), r]));

    let promoted = 0;
    const rows: CompetitorRecord[] = [];
    for (const entry of byName.values()) {
      const existing = existingByLowerName.get(entry.name.toLowerCase()) ?? null;
      const row = existing
        ? await this.prisma.competitor.update({
            // An explicit project-json/manual entry outranks a prior AEO-answer
            // candidate for the same name — promote it to tracked rather than
            // leaving it stuck awaiting a confirm the operator has, in effect,
            // just given.
            where: { id: existing.id },
            data: { domain: entry.domain ?? existing.domain, status: 'tracked' },
          })
        : await (async () => {
            promoted++;
            return this.prisma.competitor.create({
              data: { projectId, name: entry.name, domain: entry.domain, source: entry.source, status: 'tracked' },
            });
          })();
      rows.push(row);
    }

    const withProfiles: CompetitorWithProfile[] = [];
    for (const row of rows) {
      const profile = await this.buildProfile(row);
      withProfiles.push({ ...row, latestProfile: profile });
    }

    return {
      projectId,
      totalCompetitors: rows.length,
      promoted,
      competitors: withProfiles,
    };
  }

  /** Every competitor for a project, each with its latest profile (or null if none has run). */
  async list(projectId: string): Promise<CompetitorWithProfile[]> {
    await this.requireProject(projectId);
    const rows = await this.prisma.competitor.findMany({
      where: { projectId, status: { not: 'candidate' } },
      include: { profiles: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      domain: r.domain,
      source: r.source,
      status: r.status,
      createdAt: r.createdAt,
      latestProfile: r.profiles[0] ? this.toProfileResult(r.profiles[0]) : null,
    }));
  }

  /**
   * Brand names discovered but not yet confirmed — currently only written by
   * `AeoStanceService` when an AI surface names a company that isn't already
   * a recorded competitor. Never included in {@link list}, {@link gap}, or
   * the AEO "known competitors" prompt until an operator confirms one.
   */
  async listCandidates(projectId: string): Promise<CompetitorRecord[]> {
    await this.requireProject(projectId);
    return this.prisma.competitor.findMany({
      where: { projectId, status: 'candidate' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Promote a candidate to a tracked competitor — same effect as an operator
   * adding it via `/discover`. Also appended to `Project.competitors` so it
   * feeds every OTHER consumer of the named-competitor list (the AEO stance
   * prompt's "known competitors" line, share-of-voice, SERP tracking) —
   * without this, confirming here would only affect `/discover`/`/gap`.
   */
  async confirmCandidate(projectId: string, competitorId: string): Promise<CompetitorRecord> {
    const row = await this.requireCandidate(projectId, competitorId);
    const updated = await this.prisma.competitor.update({ where: { id: row.id }, data: { status: 'tracked' } });

    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { competitors: true } });
    const list: Array<{ name: string; domain: string | null; source?: string }> = parseCompetitors(
      project?.competitors ?? null,
    );
    if (!list.some((c) => c.name.toLowerCase() === row.name.toLowerCase())) {
      list.push({ name: row.name, domain: row.domain, source: 'aeo-answer' });
      await this.prisma.project.update({
        where: { id: projectId },
        data: { competitors: JSON.stringify(list) },
      });
    }

    return updated;
  }

  /** Discard a candidate — it was a hallucination, a directory site, or not actually a rival. */
  async rejectCandidate(projectId: string, competitorId: string): Promise<void> {
    const row = await this.requireCandidate(projectId, competitorId);
    await this.prisma.competitor.delete({ where: { id: row.id } });
  }

  private async requireCandidate(projectId: string, competitorId: string): Promise<CompetitorRecord> {
    const row = await this.prisma.competitor.findUnique({ where: { id: competitorId } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Candidate ${competitorId} not found for project ${projectId}`);
    }
    if (row.status !== 'candidate') {
      throw new NotFoundException(`Competitor ${competitorId} is not a pending candidate`);
    }
    return row;
  }

  /**
   * The gap comparison: what the client's own tech-stack/schema/SERP/AEO
   * profile has versus what its competitors have. A plain diff, not a scored
   * verdict — the data does not support a composite score and this module
   * does not invent one.
   */
  async gap(projectId: string): Promise<GapResult> {
    const project = await this.requireProject(projectId);

    let clientTech = await this.techStack.getLatest(projectId);
    if (!clientTech) {
      clientTech = await this.techStack.scanDomain(projectId);
    }
    const clientTechKeys = new Set((clientTech.findings ?? []).map((f) => `${f.category}:${f.name}`));

    const clientSchema = await this.readSchemaTypes(project.domain);
    const clientSchemaSet = new Set(clientSchema);

    // The client's own homepage on the SAME rubric, so the rival scores below
    // have something to be compared against. Listing "rival: 71" with no
    // client number is not a gap report, it is trivia.
    const clientSeo = await this.scoreClientHomepage(project.domain);

    // The client's published directory ratings, read from what
    // `digital-presence` already stored — never a fresh lookup here.
    const clientReviewRows = await this.prisma.presenceReview.findMany({
      where: { projectId },
      orderBy: { fetchedAt: 'desc' },
    });
    const clientReviews: CompetitorReviewRating[] = [];
    const seenReviewPlatforms = new Set<string>();
    for (const r of clientReviewRows) {
      if (seenReviewPlatforms.has(r.platform)) continue;
      seenReviewPlatforms.add(r.platform);
      clientReviews.push({
        platform: r.platform,
        label: PLATFORM_LABELS[r.platform as PresencePlatform] ?? r.platform,
        url: r.url ?? '',
        found: true,
        rating: r.rating,
        ratingCount: r.reviewCount,
        // `PresenceReview` stores no scale; the competitor side reads one off
        // the listing's own AggregateRating. Null here means "not recorded",
        // not "out of 1" -- so a renderer must not assume a denominator.
        scale: null,
      });
    }

    // The client's own platforms, read from what `digital-presence` already
    // stored — never a fresh crawl. Candidates and personal profiles are
    // excluded for the same reason they are excluded from the client's own
    // counts: a search guess is not an account, and a founder is not the company.
    const clientAccounts = await this.prisma.presenceAccount.findMany({
      where: { projectId, state: { not: 'candidate' }, entity: { not: 'personal' } },
      select: { platform: true },
    });
    const clientPlatformSet = new Set(clientAccounts.map((a) => a.platform));

    const competitors = await this.prisma.competitor.findMany({
      where: { projectId, status: { not: 'candidate' } },
      include: { profiles: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    const techByCompetitor = new Map<string, string[]>();
    const schemaByCompetitor = new Map<string, string[]>();
    const presenceByCompetitor = new Map<string, string[]>();
    // Built directly from the id, never a positional zip against a
    // separately-derived name list — a zip is one stray `continue`/filter
    // away from silently attributing one competitor's data to another's name.
    const competitorIdToName = new Map(competitors.map((c) => [c.id, c.name]));
    const rows: GapCompetitorRow[] = [];

    for (const c of competitors) {
      const profile = c.profiles[0] ?? null;
      let techKeys: string[] = [];
      if (profile?.techScanId) {
        const scan = await this.prisma.techStackScan.findUnique({
          where: { id: profile.techScanId },
          include: { findings: true },
        });
        techKeys = (scan?.findings ?? []).map((f) => `${f.category}:${f.name}`);
      }
      techByCompetitor.set(c.id, techKeys);
      schemaByCompetitor.set(c.id, profile ? (JSON.parse(profile.schemaTypes || '[]') as string[]) : []);

      const rivalAccounts = profile
        ? (JSON.parse(profile.presenceAccounts || '[]') as CompetitorPresenceAccount[])
        : [];
      const rivalPlatforms = [...new Set(rivalAccounts.map((a) => a.platform))];
      presenceByCompetitor.set(c.id, rivalPlatforms);

      rows.push({
        competitorId: c.id,
        name: c.name,
        domain: c.domain,
        aeoStatus: (profile?.aeoStatus as GapCompetitorRow['aeoStatus']) ?? 'unknown',
        aeoStanding: profile?.aeoStanding ? (JSON.parse(profile.aeoStanding) as AttachedAeoStanding) : null,
        serpStatus: (profile?.serpStatus as GapCompetitorRow['serpStatus']) ?? 'unknown',
        serpPresence: profile?.serpPresence ? (JSON.parse(profile.serpPresence) as AttachedSerpPresence) : null,
        presencePlatforms: rivalPlatforms,
        seoScore: profile?.seoScore ?? null,
        seoIssues: profile ? (JSON.parse(profile.seoIssues || '[]') as string[]) : [],
        contentSignals: profile?.contentSignals
          ? (JSON.parse(profile.contentSignals) as CompetitorContentSignals)
          : null,
        // Only listings that actually published a number. The `found: false`
        // rows are kept on the profile, where the distinction matters; a gap
        // table comparing ratings has nothing to put in that column.
        reviewRatings: profile
          ? (JSON.parse(profile.reviewRatings || '[]') as CompetitorReviewRating[]).filter(
              (r) => r.found && r.rating !== null,
            )
          : [],
      });
    }

    return {
      projectId,
      domain: project.domain,
      generatedAt: new Date().toISOString(),
      seo: {
        client: clientSeo,
        note:
          "Homepage only, on the same rubric (`seo-rubric.ts`) the client's own pages are " +
          "scored by. Not a site-wide score for either side — that needs each rival's sitemap " +
          'crawled, which this module does not do.',
      },
      reviews: {
        client: clientReviews,
        note:
          'Ratings each listing publishes about itself (AggregateRating). A platform absent ' +
          "here was either not discovered or published no rating — see each profile's " +
          '`reviewRatings`, where that distinction is kept.',
      },
      tech: this.buildDiff([...clientTechKeys], techByCompetitor, competitorIdToName),
      schema: this.buildDiff([...clientSchemaSet], schemaByCompetitor, competitorIdToName),
      presence: this.buildDiff([...clientPlatformSet], presenceByCompetitor, competitorIdToName),
      competitors: rows,
      note:
        'Tech/schema/presence are presence diffs, not scores. AEO/SERP rows reflect whatever those modules have already measured — this endpoint never triggers a new AEO or SERP run. The client-side platform list comes from stored digital-presence rows (candidates and personal profiles excluded), so a client who has never had a presence scan shows as having none rather than as having been checked.',
    };
  }

  /**
   * Find a competitor's own external profiles, by the same rules used for the
   * client.
   *
   * Reuses `PresenceDiscoveryService.crawl` untouched — it takes a bare domain,
   * so it was already competitor-ready. Company profiles only: a rival
   * founder's personal LinkedIn is not their company's footprint, and counting
   * it would inflate the very comparison this feeds.
   *
   * Never throws. A rival whose site is unreachable is a `failed` row with the
   * reason, not a profile run that dies — one bad domain must not take the
   * whole competitor set with it.
   */
  private async attachPresence(domain: string | null): Promise<{
    status: 'completed' | 'skipped' | 'failed';
    accounts: CompetitorPresenceAccount[];
    error: string | null;
  }> {
    if (!domain) {
      return { status: 'skipped', accounts: [], error: 'No domain on record — nothing to crawl.' };
    }
    try {
      const { accounts } = await this.presence.crawl(domain, `competitor-profile`);
      return {
        status: 'completed',
        accounts: accounts
          .filter((a) => a.entity !== 'personal')
          .map((a) => ({
            platform: a.platform,
            label: PLATFORM_LABELS[a.platform] ?? a.platform,
            group: PLATFORM_GROUP[a.platform] ?? 'other',
            url: a.url,
            handle: a.handle,
            // Not verified here. The client's own accounts get a fetch each;
            // doing that per competitor multiplies requests to platforms that
            // wall them anyway, for a number the gap report does not use.
            state: 'unverified',
          })),
        error: null,
      };
    } catch (err) {
      return { status: 'failed', accounts: [], error: (err as Error).message };
    }
  }

  /**
   * Published ratings for whichever discovered listings are ratable.
   *
   * Depends entirely on the presence crawl: no accounts means nothing to look
   * up, which is `skipped`, not an empty result. `unknown` is reserved for
   * "the crawl itself never ran", so a caller can always tell absence of
   * ratings from absence of looking.
   */
  private async attachReviews(
    accounts: CompetitorPresenceAccount[],
    presenceStatus: 'completed' | 'skipped' | 'failed' | 'unknown',
  ): Promise<{
    status: 'completed' | 'skipped' | 'failed' | 'unknown';
    ratings: CompetitorReviewRating[];
    error: string | null;
  }> {
    if (presenceStatus !== 'completed') {
      return {
        status: presenceStatus === 'failed' ? 'failed' : 'skipped',
        ratings: [],
        error: 'No presence crawl succeeded, so no listings were available to check.',
      };
    }

    const ratable = accounts.filter((a) =>
      (RATABLE_PLATFORMS as readonly string[]).includes(a.platform),
    );
    if (ratable.length === 0) {
      return {
        status: 'skipped',
        ratings: [],
        error: 'No ratable directory or marketplace listing was discovered for this competitor.',
      };
    }

    try {
      const results = await this.directoryRating.fetchAll(
        ratable.map((a) => ({ platform: a.platform as PresencePlatform, url: a.url })),
        'competitor-profile',
      );
      return {
        status: 'completed',
        ratings: results.map((r) => ({
          platform: r.platform,
          label: PLATFORM_LABELS[r.platform] ?? r.platform,
          url: r.url,
          found: r.found,
          rating: r.rating,
          ratingCount: r.reviewCount,
          scale: r.bestRating,
        })),
        error: null,
      };
    } catch (err) {
      return { status: 'failed', ratings: [], error: (err as Error).message };
    }
  }

  // ─── Profile building ───────────────────────────────────────────────────

  private async buildProfile(competitor: CompetitorRecord): Promise<CompetitorProfileResult> {
    let status: 'completed' | 'failed' | 'skipped' = 'completed';
    let error: string | null = null;
    let techScanId: string | null = null;
    let schemaTypes: string[] = [];
    let schemaRaw: unknown[] = [];
    let seoStatus: 'completed' | 'skipped' | 'failed' | 'unknown' = 'unknown';
    let seoScore: number | null = null;
    let seoIssues: string[] = [];
    let seoError: string | null = null;
    let contentSignals: CompetitorContentSignals | null = null;

    if (!competitor.domain) {
      status = 'skipped';
      error = 'No domain on record for this competitor — homepage could not be crawled.';
    } else {
      let scan: TechStackScanResult;
      try {
        scan = await this.techStack.scanDomain(competitor.projectId, competitor.domain);
        techScanId = scan.id;
        if (scan.status === 'failed') {
          status = 'failed';
          error = scan.error;
        }
      } catch (err) {
        status = 'failed';
        error = (err as Error).message;
      }

      if (status !== 'failed') {
        try {
          const result = await this.readSchema(competitor.domain);
          schemaTypes = result.types;
          schemaRaw = result.raw;

          // Stage 7's "Competitor SEO" and "Competitor Content" columns, off
          // the HTML the schema read already fetched. Scored by the SAME
          // rubric `technical-audit` scores the client's pages with -- a rival
          // graded on its own scale would make the comparison meaningless.
          try {
            if (result.status === 0 || result.status >= 400) {
              // The real fetch status, not a fabricated 200 -- a 404/5xx
              // homepage must be reported unreachable, never scored as if
              // healthy off whatever error-page HTML came back.
              seoStatus = 'failed';
              seoError = `Homepage returned HTTP ${result.status}`;
            } else {
              const signals = extractPageSignals(result.html, result.status, result.url, hostOf(result.url) ?? '');
              const issues = findPageIssues(signals);
              seoIssues = issues;
              seoScore = scorePage(issues);
              seoStatus = 'completed';
              contentSignals = {
                wordCount: signals.wordCount,
                h1Count: signals.h1Count,
                headingCount: signals.headingLevels.length,
                imageCount: signals.imageCount,
                imagesMissingAlt: signals.imagesMissingAlt,
                titleLength: signals.title?.length ?? null,
                metaDescriptionLength: signals.metaDescription?.length ?? null,
                jsonLdCount: signals.jsonLdCount,
                noindex: signals.noindex,
              };
            }
          } catch (err) {
            seoStatus = 'failed';
            seoError = (err as Error).message;
          }
        } catch (err) {
          // Schema extraction is best-effort — a failure here does not fail
          // the whole profile, since the tech scan already succeeded.
          this.logger.warn(`Schema read failed for ${competitor.domain}: ${(err as Error).message}`);
          seoStatus = 'failed';
          seoError = `Homepage could not be read: ${(err as Error).message}`;
        }
      } else {
        seoStatus = 'failed';
        seoError = error;
      }
    }

    if (!competitor.domain) {
      seoStatus = 'skipped';
      seoError = 'No domain on record — no homepage to score.';
    }

    // The rival's own external presence (wave-6 step 5, reused unchanged).
    // Without this the gap report compares tech stacks and nothing else — it
    // could not say "they are on Instagram and Clutch, you are on neither",
    // which is the comparison stage 7 exists to make.
    //
    // The crawl only, never the paid enrichment: DataForSEO/Apify spend real
    // money per entity, and quietly multiplying that by the competitor count
    // is not a cost anyone asked for.
    const presence = await this.attachPresence(competitor.domain);

    // Stage 7's "Competitor Reviews". Runs off the listings the presence crawl
    // just discovered, and reads the AggregateRating each directory already
    // publishes about itself -- so there is no review vendor and no
    // per-competitor cost. A listing that loads but declares no rating is kept
    // as `found: false`: "on G2 with no public rating" and "not on G2" are
    // different facts about a rival, and collapsing them would invent one.
    const review = await this.attachReviews(presence.accounts, presence.status);

    const aeo = await this.attachAeoStanding(competitor.projectId, competitor.name);
    const serp = await this.attachSerpPresence(competitor.projectId, competitor.name, competitor.domain);

    const created = await this.prisma.competitorProfile.create({
      data: {
        competitorId: competitor.id,
        domain: competitor.domain,
        status,
        error,
        techScanId,
        schemaTypes: JSON.stringify(schemaTypes),
        schemaRaw: JSON.stringify(schemaRaw),
        aeoStatus: aeo.status,
        aeoStanding: aeo.standing ? JSON.stringify(aeo.standing) : null,
        aeoAuditId: aeo.auditId,
        serpStatus: serp.status,
        serpPresence: serp.presence ? JSON.stringify(serp.presence) : null,
        presenceStatus: presence.status,
        presenceAccounts: JSON.stringify(presence.accounts),
        presenceError: presence.error,
        seoStatus,
        seoScore,
        seoIssues: JSON.stringify(seoIssues),
        contentSignals: contentSignals ? JSON.stringify(contentSignals) : null,
        seoError,
        reviewStatus: review.status,
        reviewRatings: JSON.stringify(review.ratings),
        reviewError: review.error,
      },
    });

    return this.toProfileResult(created);
  }

  /**
   * Score the client's own homepage with the same extractor and rubric applied
   * to every competitor. Fails soft: a gap report is still useful without the
   * client's own number, and losing the whole report to one failed fetch is not.
   */
  private async scoreClientHomepage(domain: string): Promise<GapResult['seo']['client']> {
    try {
      const result = await this.readSchema(domain);
      if (result.status === 0 || result.status >= 400) {
        return { status: 'failed', score: null, issues: [], contentSignals: null, error: `Homepage returned HTTP ${result.status}` };
      }
      const signals = extractPageSignals(result.html, result.status, result.url, hostOf(result.url) ?? '');
      const issues = findPageIssues(signals);
      return {
        status: 'completed',
        score: scorePage(issues),
        issues,
        contentSignals: {
          wordCount: signals.wordCount,
          h1Count: signals.h1Count,
          headingCount: signals.headingLevels.length,
          imageCount: signals.imageCount,
          imagesMissingAlt: signals.imagesMissingAlt,
          titleLength: signals.title?.length ?? null,
          metaDescriptionLength: signals.metaDescription?.length ?? null,
          jsonLdCount: signals.jsonLdCount,
          noindex: signals.noindex,
        },
        error: null,
      };
    } catch (err) {
      return {
        status: 'failed',
        score: null,
        issues: [],
        contentSignals: null,
        error: (err as Error).message,
      };
    }
  }

  /** Homepage-only schema.org/JSON-LD read, reusing `FetcherService.fetchSchema`. */
  private async readSchema(domain: string): Promise<{ types: string[]; raw: unknown[]; html: string; url: string; status: number }> {
    const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
    const result = await this.fetcher.fetchSchema(url, 'competitors');
    const types = [...new Set(result.schemas.map((s) => s.type).filter(Boolean))];
    // `fetchSchema` already returns the body it parsed. Handing it back means
    // the SEO and content reads below cost zero additional requests -- they
    // analyse the page this call has already paid for.
    return { types, raw: result.schemas, html: result.raw, url, status: result.status };
  }

  /** Same as `readSchema`, but only the type list — used for the client side of the gap report. */
  private async readSchemaTypes(domain: string): Promise<string[]> {
    try {
      const { types } = await this.readSchema(domain);
      return types;
    } catch {
      return [];
    }
  }

  /**
   * Attach whatever AEO share-of-voice standing already exists for this
   * competitor, read from the most recent completed `AeoAudit.verdict` for
   * the project. Never triggers a new AEO run.
   */
  private async attachAeoStanding(
    projectId: string,
    competitorName: string,
  ): Promise<{ status: 'present' | 'absent' | 'unknown'; standing: AttachedAeoStanding | null; auditId: string | null }> {
    const audit = await this.prisma.aeoAudit.findFirst({
      where: { projectId, status: 'completed', verdict: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!audit || !audit.verdict) {
      return { status: 'unknown', standing: null, auditId: null };
    }

    try {
      const verdict = JSON.parse(audit.verdict) as {
        generatedAt?: string;
        counted?: {
          competitors?: Array<{
            name: string;
            observations: number;
            mentionRate: number;
            clientAheadCount: number;
            clientBehindCount: number;
            wonWhileClientAbsent: number;
          }>;
          shareOfVoice?: Array<{ name: string; share: number }>;
        };
      };
      const nameLower = competitorName.toLowerCase();
      const standing = verdict.counted?.competitors?.find((c) => c.name.toLowerCase() === nameLower);
      if (!standing) {
        return { status: 'absent', standing: null, auditId: audit.id };
      }
      const sov = verdict.counted?.shareOfVoice?.find((s) => s.name.toLowerCase() === nameLower);
      return {
        status: 'present',
        auditId: audit.id,
        standing: {
          name: standing.name,
          observations: standing.observations,
          mentionRate: standing.mentionRate,
          clientAheadCount: standing.clientAheadCount,
          clientBehindCount: standing.clientBehindCount,
          wonWhileClientAbsent: standing.wonWhileClientAbsent,
          shareOfVoice: sov ? sov.share : null,
          auditId: audit.id,
          generatedAt: verdict.generatedAt ?? null,
        },
      };
    } catch (err) {
      this.logger.warn(`Could not parse AeoAudit.verdict for project ${projectId}: ${(err as Error).message}`);
      return { status: 'unknown', standing: null, auditId: null };
    }
  }

  /**
   * Attach whatever SERP presence already exists for this competitor, read
   * from the project's most recent SERP snapshots. Never triggers a new SERP
   * fetch.
   */
  private async attachSerpPresence(
    projectId: string,
    competitorName: string,
    competitorDomain: string | null,
  ): Promise<{ status: 'present' | 'absent' | 'unknown'; presence: AttachedSerpPresence | null }> {
    const trackers = await this.prisma.serpTracker.findMany({ where: { projectId }, select: { id: true } });
    if (trackers.length === 0) {
      return { status: 'unknown', presence: null };
    }

    const results = await this.prisma.serpResult.findMany({
      where: { snapshot: { trackerId: { in: trackers.map((t) => t.id) } } },
      orderBy: { capturedAt: 'desc' },
      take: 500,
      include: { query: { select: { keyword: true } } },
    });

    const nameLower = competitorName.toLowerCase();
    const domainHost = competitorDomain ? hostOf(competitorDomain) : null;

    let occurrences = 0;
    let bestRank: number | null = null;
    let sampleKeyword: string | null = null;
    let capturedAt: string | null = null;

    for (const r of results) {
      const seen = JSON.parse(r.competitorsSeen || '[]') as string[];
      const nameHit = seen.some((s) => s.toLowerCase() === nameLower);

      const topDomains = JSON.parse(r.topDomains || '[]') as Array<{ domain: string; rank: number }>;
      const domainHit = domainHost ? topDomains.find((d) => hostOf(d.domain) === domainHost) : undefined;

      if (nameHit || domainHit) {
        occurrences++;
        if (domainHit && (bestRank === null || domainHit.rank < bestRank)) bestRank = domainHit.rank;
        if (!sampleKeyword) sampleKeyword = r.query?.keyword ?? null;
        if (!capturedAt) capturedAt = r.capturedAt.toISOString();
      }
    }

    if (occurrences === 0) {
      return { status: 'absent', presence: null };
    }
    return { status: 'present', presence: { occurrences, bestRank, sampleKeyword, capturedAt } };
  }

  // ─── Gap diff helper ────────────────────────────────────────────────────

  private buildDiff(
    clientKeys: string[],
    byCompetitor: Map<string, string[]>,
    idToName: Map<string, string>,
  ): { client: string[]; clientOnly: GapDiffLine[]; competitorsOnly: GapDiffLine[]; shared: GapDiffLine[] } {
    const clientSet = new Set(clientKeys);
    const allCompetitorKeys = new Set<string>();
    for (const keys of byCompetitor.values()) {
      for (const k of keys) allCompetitorKeys.add(k);
    }

    const whoHas = (key: string): string[] =>
      [...byCompetitor.entries()].filter(([, keys]) => keys.includes(key)).map(([id]) => idToName.get(id) ?? id);

    const clientOnly: GapDiffLine[] = [];
    const shared: GapDiffLine[] = [];
    for (const key of clientSet) {
      const holders = whoHas(key);
      if (holders.length > 0) shared.push({ key, client: true, competitors: holders });
      else clientOnly.push({ key, client: true, competitors: [] });
    }

    const competitorsOnly: GapDiffLine[] = [];
    for (const key of allCompetitorKeys) {
      if (!clientSet.has(key)) competitorsOnly.push({ key, client: false, competitors: whoHas(key) });
    }

    return { client: clientKeys, clientOnly, competitorsOnly, shared };
  }

  private toProfileResult(row: {
    id: string;
    competitorId: string;
    domain: string | null;
    status: string;
    error: string | null;
    techScanId: string | null;
    schemaTypes: string;
    aeoStatus: string;
    aeoStanding: string | null;
    serpStatus: string;
    serpPresence: string | null;
    presenceStatus: string;
    presenceAccounts: string;
    presenceError: string | null;
    seoStatus: string;
    seoScore: number | null;
    seoIssues: string;
    contentSignals: string | null;
    seoError: string | null;
    reviewStatus: string;
    reviewRatings: string;
    reviewError: string | null;
    createdAt: Date;
  }): CompetitorProfileResult {
    return {
      id: row.id,
      competitorId: row.competitorId,
      domain: row.domain,
      status: row.status as CompetitorProfileResult['status'],
      error: row.error,
      techScanId: row.techScanId,
      schemaTypes: JSON.parse(row.schemaTypes || '[]') as string[],
      aeoStatus: row.aeoStatus as CompetitorProfileResult['aeoStatus'],
      aeoStanding: row.aeoStanding ? (JSON.parse(row.aeoStanding) as AttachedAeoStanding) : null,
      serpStatus: row.serpStatus as CompetitorProfileResult['serpStatus'],
      serpPresence: row.serpPresence ? (JSON.parse(row.serpPresence) as AttachedSerpPresence) : null,
      presenceStatus: row.presenceStatus as CompetitorProfileResult['presenceStatus'],
      presenceAccounts: JSON.parse(row.presenceAccounts || '[]') as CompetitorPresenceAccount[],
      presenceError: row.presenceError,
      seoStatus: row.seoStatus as CompetitorProfileResult['seoStatus'],
      seoScore: row.seoScore,
      seoIssues: JSON.parse(row.seoIssues || '[]') as string[],
      contentSignals: row.contentSignals
        ? (JSON.parse(row.contentSignals) as CompetitorContentSignals)
        : null,
      seoError: row.seoError,
      reviewStatus: row.reviewStatus as CompetitorProfileResult['reviewStatus'],
      reviewRatings: JSON.parse(row.reviewRatings || '[]') as CompetitorReviewRating[],
      reviewError: row.reviewError,
      createdAt: row.createdAt,
    };
  }
}
