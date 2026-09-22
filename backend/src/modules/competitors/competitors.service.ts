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
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import * as cheerio from 'cheerio';
import { FetcherService } from '../fetcher/fetcher.service';
import type { SchemaBlock } from '../fetcher/fetcher.types';
import { AeoStanceService, type CompetitorSignal } from '../aeo-audit/aeo-stance.service';
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
import { BusinessProfileService } from '../business-profile/business-profile.service';
import { SerpIntelligenceService } from '../serp-intelligence/serp-intelligence.service';
import type { CompetitorInputDto, DiscoverByMarketDto, DiscoverCompetitorsDto } from './dto/competitors.dto';

/**
 * §12.2 exclusion list — registrable domains that are never a "competitor"
 * even when they legitimately rank/appear for a client's service+market
 * queries: generic business directories/marketplaces, review platforms,
 * social/publishing platforms, and reference sites. Grounded, not invented —
 * every entry here is a well-known non-provider destination, not a guess
 * about any specific candidate. Extend cautiously; being too aggressive here
 * silently drops real rivals, which is the opposite failure mode.
 */
const EXCLUDED_DOMAINS = new Set<string>([
  // Directories / marketplaces / review platforms
  'yelp.com', 'clutch.co', 'g2.com', 'capterra.com', 'trustpilot.com', 'glassdoor.com',
  'indeed.com', 'crunchbase.com', 'bbb.org', 'yellowpages.com', 'angi.com', 'thumbtack.com',
  'upcity.com', 'goodfirms.co', 'designrush.com', 'sortlist.com', 'expertise.com', 'trustradius.com',
  'getapp.com', 'softwareadvice.com', 'houzz.com', 'homeadvisor.com',
  // Social / publishing platforms (a company's presence there is not itself a rival)
  'facebook.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'twitter.com', 'x.com',
  'pinterest.com', 'reddit.com', 'quora.com', 'medium.com', 'wordpress.com', 'blogspot.com',
  'tumblr.com', 'tiktok.com',
  // Reference / general knowledge
  'wikipedia.org', 'wikidata.org',
  // Search/portal infrastructure that sometimes shows up as a "domain" in a captured result
  'google.com', 'bing.com', 'duckduckgo.com',
]);

/** Case/whitespace-normalized identity key for a candidate name. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Canonical registrable-domain identity key, via the same `hostOf()` every other module uses. */
function domainKeyOf(domain: string): string | null {
  return hostOf(domain) ?? domain.trim().toLowerCase();
}

/**
 * One rival name/domain mined from already-stored evidence, before exclusion/dedup.
 *
 * `evidenceKind` records *how* the candidate was found so Stage-4 scoring can
 * weight sources differently (discoverability-pipeline-plan.md §Stage 4 §7's
 * "external-discovery corroboration"). Free-pass kinds: `aeo-verdict`,
 * `serp-snapshot`. Paid-pass kinds: `serp-live-search` (name-independent
 * keyword/category searches, spec §6.4), `serp-comparison-search`
 * (`"<name>" alternatives`, spec §6.1), `review-site-category` (G2/Capterra
 * category-listing pulls, spec §6.1).
 */
interface RawCandidate {
  name: string;
  domain: string | null;
  evidenceKind:
    | 'aeo-verdict'
    | 'serp-snapshot'
    | 'serp-live-search'
    | 'serp-comparison-search'
    | 'review-site-category';
  reason: string;
}

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

/** How many confirmed services to compose queries/consider evidence for, per discovery run. */
const MAX_SERVICES_CONSIDERED = 5;
/** How many confirmed target markets to compose queries for, per discovery run. */
const MAX_MARKETS_CONSIDERED = 3;
/** Hard cap on bounded SERP searches per `collectNew: true` call — a budget, not a suggestion. */
const MAX_MARKET_QUERIES = 6;
/** How much of `MAX_MARKET_QUERIES` is reserved for pass-2 comparison searches (spec §6.1). */
const MAX_COMPARISON_QUERIES = 2;
/** Best-effort review-site category-listing pulls per call (spec §6.1). Fetch, else headless render. */
const MAX_REVIEW_SITE_PULLS = 2;

/** Distinct strings, case-insensitive, first-seen order preserved. */
export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v.trim());
  }
  return out;
}

/**
 * Branded candidate names to seed pass-2 comparison searches (`"<name>"
 * alternatives`). A comparison query only works once a name exists to compare
 * against (spec §6.1), so these come from *this run's own* pass-1 results.
 * Prefers real brand names (aeo-verdict / organic titles) over bare domain keys.
 */
export function pickComparisonSeeds(raw: RawCandidate[], limit: number): string[] {
  const branded = raw.filter(
    (c) => (c.evidenceKind === 'aeo-verdict' || c.evidenceKind === 'serp-live-search') && c.name && !c.name.includes('.'),
  );
  return dedupeStrings(branded.map((c) => c.name)).slice(0, limit);
}

/**
 * Is this HTML an actual listing page, or a bot-block/JS-shell? G2/Capterra sit
 * behind Cloudflare; a plain fetch often returns a challenge page, which must
 * NOT be parsed as competitor data.
 */
export function looksLikeReviewListing(html: string): boolean {
  if (!html || html.length < 500) return false;
  if (/just a moment|cf-browser-verification|attention required|please enable javascript|access denied/i.test(html)) {
    return false;
  }
  return /\/products\//i.test(html);
}

/**
 * Parse product names out of a G2 category-listing page. Product links look
 * like `/products/<slug>/reviews`; the anchor text is the product name. Pure
 * and defensive so it can be unit-tested with a captured page and a
 * bot-challenge page.
 */
export function parseG2CategoryListing(html: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!/\/products\/[a-z0-9-]+\//i.test(href)) return;
      const name = ($(el).text() || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length < 2 || name.length > 60) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(name);
    });
  } catch {
    // best-effort parse — a malformed page yields no names, never throws
  }
  return names;
}

/**
 * A rival's own company context, read off its homepage (discoverability-pipeline
 * Stage 4 step 3, homepage-only variant). `category` is deliberately often null:
 * a homepage rarely states a machine-readable category, and inventing one from
 * marketing copy would be worse than a gap.
 */
export interface CompetitorCompanyContext {
  brand: string | null;
  description: string | null;
  category: string | null;
  keywords: string[];
  socialProfiles: string[];
}

/**
 * Extract a rival's company context from its homepage HTML + JSON-LD blocks —
 * pure, no IO, so it is unit-testable. Prefers structured JSON-LD (an
 * Organization/LocalBusiness block's `name`/`description`/`sameAs`) and falls
 * back to `og:site_name`/`<title>` and the meta description. Returns null when
 * nothing usable is present (e.g. a bot-challenge page).
 */
export function extractCompetitorCompanyContext(html: string, schemaBlocks: SchemaBlock[]): CompetitorCompanyContext | null {
  const strOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let brand: string | null = null;
  let description: string | null = null;
  const category: string | null = null; // not reliably derivable from a homepage
  const keywords: string[] = [];
  const social = new Set<string>();

  const ORG_TYPE = /organization|localbusiness|corporation|website|onlinestore|business|store/i;
  for (const block of schemaBlocks ?? []) {
    if (!block || typeof block !== 'object') continue;
    if (!ORG_TYPE.test(String(block.type ?? ''))) continue;
    const fields = (block.fields ?? {}) as Record<string, unknown>;
    brand = brand ?? strOf(fields.name) ?? strOf(fields.legalName);
    description = description ?? strOf(fields.description);
    const sameAs = fields.sameAs;
    if (typeof sameAs === 'string') social.add(sameAs);
    else if (Array.isArray(sameAs)) for (const s of sameAs) { const u = strOf(s); if (u) social.add(u); }
  }

  if (html) {
    try {
      const $ = cheerio.load(html);
      brand =
        brand ??
        strOf($('meta[property="og:site_name"]').attr('content')) ??
        strOf($('meta[property="og:title"]').attr('content')) ??
        strOf($('title').first().text());
      description =
        description ??
        strOf($('meta[name="description"]').attr('content')) ??
        strOf($('meta[property="og:description"]').attr('content'));
      const kw = strOf($('meta[name="keywords"]').attr('content'));
      if (kw) for (const k of kw.split(',').map((s) => s.trim()).filter(Boolean)) keywords.push(k);
    } catch {
      // best-effort — a malformed page just yields whatever JSON-LD gave us
    }
  }

  if (brand && brand.length > 120) brand = brand.slice(0, 120);
  if (description && description.length > 500) description = description.slice(0, 500);
  const socialProfiles = [...social].slice(0, 20);
  const uniqueKeywords = dedupeStrings(keywords).slice(0, 20);
  if (!brand && !description && socialProfiles.length === 0 && uniqueKeywords.length === 0) return null;
  return { brand, description, category, keywords: uniqueKeywords, socialProfiles };
}

export interface DiscoverByMarketResult {
  projectId: string;
  collectNew: boolean;
  queriesRun: number;
  /** Best-effort review-site category listings that returned usable data (spec §6.1). */
  reviewSitesPulled: number;
  costUsd: number;
  servicesConsidered: string[];
  marketsConsidered: string[];
  candidatesProposed: number;
  candidatesExcluded: number;
  exclusionSample: string[];
  candidates: CompetitorRecord[];
  note: string;
}

/** spec §7 composite-score weights for competitor ranking (sum = 1.0). */
const RANKING_WEIGHTS = {
  platformCoverage: 0.3,
  absence: 0.25,
  coMention: 0.15,
  position: 0.15,
  diversity: 0.1,
  corroboration: 0.05,
} as const;

/** A candidate must be seen on at least this many surfaces to make the top list — relaxed to 1 if too few clear it. */
const MIN_PLATFORM_COVERAGE = 2;
/** Default size of the ranked top list. */
const DEFAULT_TOP_N = 5;
/** How many below the top list to keep as an explicit watchlist. */
const WATCHLIST_SIZE = 10;

/** One ranked rival — a {@link CompetitorSignal} plus its composite score and the normalized components behind it. */
export interface RankedCompetitor extends CompetitorSignal {
  /** 0–100 composite (spec §7). */
  score: number;
  /** Whether Stage-2 external discovery also surfaced this name (a `market-discovery` Competitor row). */
  externallyCorroborated: boolean;
  /** The normalized 0–1 factors behind `score`, for transparency. */
  components: {
    platformCoverage: number;
    absence: number;
    coMention: number;
    position: number;
    diversity: number;
    corroboration: number;
  };
}

export interface CompetitorRankingResult {
  projectId: string;
  /** The completed AEO audit whose stances were ranked, or null when none exists. */
  auditId: string | null;
  /** Top N by composite score (spec §7). */
  rankedTop: RankedCompetitor[];
  /** 6th–15th — kept, not discarded, so a later round can reconsider them. */
  watchlist: RankedCompetitor[];
  /** The platform-coverage floor actually applied (relaxed to 1 when too few cleared the default). */
  minPlatformCoverage: number;
  /** True when the floor had to be relaxed to fill the top list. */
  floorRelaxed: boolean;
  totalCandidates: number;
  note: string;
}

/**
 * Pure §7 scoring/ranking over aggregated {@link CompetitorSignal}s — no DB, no
 * IO, deterministic — so the weighted-score math is unit-testable. `discoveredKeys`
 * is the set of `nameKey`s that Stage-2 external discovery corroborated.
 */
export function rankCompetitorSignals(
  signals: CompetitorSignal[],
  discoveredKeys: Set<string>,
  topN: number,
): {
  rankedTop: RankedCompetitor[];
  watchlist: RankedCompetitor[];
  minPlatformCoverage: number;
  floorRelaxed: boolean;
  totalCandidates: number;
} {
  const maxSurfaces = Math.max(1, ...signals.map((s) => s.distinctSurfaces));
  const maxAbsence = Math.max(1, ...signals.map((s) => s.absenceMentions));
  const maxCoMention = Math.max(1, ...signals.map((s) => s.coMentions));
  const maxDimensions = Math.max(1, ...signals.map((s) => s.distinctDimensions));
  const positions = signals.map((s) => s.avgPosition).filter((n): n is number => n != null);
  const worstPosition = positions.length > 0 ? Math.max(...positions) : 1;

  const scored: RankedCompetitor[] = signals.map((s) => {
    const platformCoverage = s.distinctSurfaces / maxSurfaces;
    const absence = s.absenceMentions / maxAbsence;
    const coMention = s.coMentions / maxCoMention;
    // Lower (better) average position scores higher; null (never derivable) scores 0.
    const position =
      s.avgPosition == null ? 0 : worstPosition <= 1 ? 1 : (worstPosition - s.avgPosition) / (worstPosition - 1);
    const diversity = s.distinctDimensions / maxDimensions;
    const corroboration = discoveredKeys.has(nameKey(s.name)) ? 1 : 0;
    const composite =
      RANKING_WEIGHTS.platformCoverage * platformCoverage +
      RANKING_WEIGHTS.absence * absence +
      RANKING_WEIGHTS.coMention * coMention +
      RANKING_WEIGHTS.position * position +
      RANKING_WEIGHTS.diversity * diversity +
      RANKING_WEIGHTS.corroboration * corroboration;
    return {
      ...s,
      score: Number((composite * 100).toFixed(2)),
      externallyCorroborated: corroboration === 1,
      components: { platformCoverage, absence, coMention, position, diversity, corroboration },
    };
  });

  let floor = MIN_PLATFORM_COVERAGE;
  let eligible = scored.filter((s) => s.distinctSurfaces >= floor);
  let floorRelaxed = false;
  if (eligible.length < topN && floor > 1) {
    floor = 1;
    eligible = scored.filter((s) => s.distinctSurfaces >= floor);
    floorRelaxed = true;
  }
  eligible.sort((a, b) => b.score - a.score || b.totalMentions - a.totalMentions || a.name.localeCompare(b.name));

  return {
    rankedTop: eligible.slice(0, topN),
    watchlist: eligible.slice(topN, topN + WATCHLIST_SIZE),
    minPlatformCoverage: floor,
    floorRelaxed,
    totalCandidates: scored.length,
  };
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

/** §12.3 — exactly which source observations/versions a frozen comparison was derived from. */
export interface ComparisonProvenance {
  competitorSetVersion: string;
  extractionVersion: string;
  techScanIds: string[];
  profileIds: string[];
  aeoAuditIds: string[];
  serpResultSampleCount: number;
}

export interface GapResult {
  projectId: string;
  domain: string;
  generatedAt: string;
  /** §12.3 — the frozen snapshot this exact comparison was persisted as. Re-reading it later via getComparisonSnapshot returns this same result unchanged, even if the competitor set later changes. */
  snapshotId: string;
  comparisonMeta: ComparisonProvenance;
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
    private readonly businessProfile: BusinessProfileService,
    private readonly serpIntelligence: SerpIntelligenceService,
    private readonly aeoStance: AeoStanceService,
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
    const rows = await this.prisma.competitor.findMany({
      where: { projectId, status: 'candidate' },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return rows;

    // Rejection-memory self-heal: a candidate can be written by a producer
    // this module does not control (AeoStanceService, aeo-audit — off limits
    // to edit here), so enforcing "a rejected candidate never resurfaces" at
    // read time, against every candidate regardless of who wrote it, is the
    // only place this module can honestly guarantee that contract. A match
    // is deleted outright (never re-shown) rather than merely filtered, so a
    // second read gives the same answer without redoing this work.
    const rejections = await this.prisma.competitorRejection.findMany({ where: { projectId } });
    if (rejections.length === 0) return rows;
    const rejectedNames = new Set(rejections.map((r) => r.nameKey));
    const rejectedDomains = new Set(rejections.map((r) => r.domainKey).filter((d): d is string => !!d));

    const kept: CompetitorRecord[] = [];
    const toDelete: string[] = [];
    for (const row of rows) {
      const nk = nameKey(row.name);
      const dk = row.domain ? domainKeyOf(row.domain) : null;
      if (rejectedNames.has(nk) || (dk && rejectedDomains.has(dk))) {
        toDelete.push(row.id);
      } else {
        kept.push(row);
      }
    }
    if (toDelete.length > 0) {
      await this.prisma.competitor.deleteMany({ where: { id: { in: toDelete } } });
    }
    return kept;
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

  /**
   * Discard a candidate — it was a hallucination, a directory site, or not
   * actually a rival. Records a rejection tombstone FIRST (§12.2: "rejection
   * memory prevents rediscovery loops") so a later discovery pass — from
   * this module or another producer — does not re-propose the same
   * name/domain; the row itself is then deleted, matching the existing
   * "no undo" contract this endpoint already documented.
   */
  async rejectCandidate(projectId: string, competitorId: string, reason?: string): Promise<void> {
    const row = await this.requireCandidate(projectId, competitorId);
    await this.prisma.competitorRejection.upsert({
      where: { projectId_nameKey: { projectId, nameKey: nameKey(row.name) } },
      update: { domainKey: row.domain ? domainKeyOf(row.domain) : null, reason: reason ?? null },
      create: {
        projectId,
        nameKey: nameKey(row.name),
        domainKey: row.domain ? domainKeyOf(row.domain) : null,
        reason: reason ?? null,
      },
    });
    await this.prisma.competitor.delete({ where: { id: row.id } });
  }

  /**
   * Reclassify a candidate's relevance (§12.2: direct competitor / adjacent
   * alternative / not relevant) without confirming or rejecting it — an
   * operator correcting the discovery heuristic's guess, kept as its own
   * action so it never silently promotes/deletes anything.
   */
  async reclassifyCandidate(projectId: string, competitorId: string, relevance: string): Promise<CompetitorRecord> {
    const row = await this.requireCandidate(projectId, competitorId);
    return this.prisma.competitor.update({ where: { id: row.id }, data: { relevance } });
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

  // ─── §12.2: service/market-based discovery ─────────────────────────────

  /**
   * Compose bounded searches from confirmed services + target markets, and
   * combine with rival names/domains already observed in stored AEO verdicts
   * and SERP snapshots. Writes new `status: 'candidate'` rows only — an
   * existing tracked/candidate competitor is never touched, and the whole
   * existing list is retained (discovery only proposes additions, per
   * §12.2's last paragraph).
   *
   * Two cost classes, kept explicit and separate (§12.3's other half):
   *   - Default (`collectNew` false/omitted): reads only what
   *     `AeoAudit.verdict` and `SerpResult` already have stored. No network
   *     call, no vendor, free — safe to run from a page load.
   *   - `collectNew: true`: additionally composes up to
   *     `MAX_MARKET_QUERIES` "<service> in <market>" searches through the
   *     gated SERP provider (`serpForDiscovery` — the same gate `capture()`
   *     uses: SERP_ALLOW_FIXTURE for the offline fixture, SWARM_ALLOW_LIVE +
   *     credentials for the real, paid DataForSEO call). This is the
   *     explicit, budgeted "Collect new results" action; it never runs
   *     implicitly.
   */
  async discoverByMarket(projectId: string, dto: DiscoverByMarketDto): Promise<DiscoverByMarketResult> {
    const project = await this.requireProject(projectId);
    const clientDomainKey = project.domain ? domainKeyOf(project.domain) : null;

    const existing = await this.prisma.competitor.findMany({ where: { projectId } });
    const existingNameKeys = new Set(existing.map((c) => nameKey(c.name)));
    const existingDomainKeys = new Set(existing.filter((c) => c.domain).map((c) => domainKeyOf(c.domain!)));

    const rejections = await this.prisma.competitorRejection.findMany({ where: { projectId } });
    const rejectedNameKeys = new Set(rejections.map((r) => r.nameKey));
    const rejectedDomainKeys = new Set(rejections.map((r) => r.domainKey).filter((d): d is string => !!d));

    // Confirmed services/segments (never draft/suggested values) — the same
    // read `aeo-audit`'s own market resolution uses, business-profile module
    // untouched.
    const profile = await this.businessProfile.getConfirmedProfile(projectId);
    const services = (profile?.data.services ?? []).filter((s) => s && s.trim()).slice(0, MAX_SERVICES_CONSIDERED);
    const segments = (profile?.data.icp.segments ?? []).filter((s) => s && s.trim());
    const targetCountries = await this.businessProfile.getConfirmedTargetCountries(projectId);

    const raw: RawCandidate[] = [];

    // ── Free pass: mine already-stored AEO verdict + SERP evidence ────────
    const audit = await this.prisma.aeoAudit.findFirst({
      where: { projectId, status: 'completed', verdict: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (audit?.verdict) {
      try {
        const verdict = JSON.parse(audit.verdict) as {
          counted?: { competitors?: Array<{ name: string }> };
        };
        for (const c of verdict.counted?.competitors ?? []) {
          if (!c?.name) continue;
          raw.push({
            name: c.name,
            domain: null,
            evidenceKind: 'aeo-verdict',
            reason: `Named as a competitor standing in AI-visibility audit ${audit.id}.`,
          });
        }
      } catch {
        // Best-effort mining — a malformed verdict never blocks discovery.
      }
    }

    const trackers = await this.prisma.serpTracker.findMany({ where: { projectId }, select: { id: true } });
    if (trackers.length > 0) {
      const results = await this.prisma.serpResult.findMany({
        where: { snapshot: { trackerId: { in: trackers.map((t) => t.id) } } },
        orderBy: { capturedAt: 'desc' },
        take: 300,
        include: { query: { select: { keyword: true } } },
      });
      const seenDomainCounts = new Map<string, number>();
      for (const r of results) {
        let topDomains: Array<{ domain: string; rank: number }> = [];
        try {
          topDomains = JSON.parse(r.topDomains || '[]');
        } catch {
          topDomains = [];
        }
        for (const entry of topDomains) {
          const key = domainKeyOf(entry.domain);
          if (!key) continue;
          seenDomainCounts.set(key, (seenDomainCounts.get(key) ?? 0) + 1);
        }
      }
      for (const [domainKey, count] of seenDomainCounts) {
        raw.push({
          name: domainKey,
          domain: domainKey,
          evidenceKind: 'serp-snapshot',
          reason: `Appeared in ${count} stored tracked-SERP result(s) for this project.`,
        });
      }
    }

    // ── Paid pass: bounded searches + review-site pulls, only when requested ─
    let queriesRun = 0;
    let costUsd = 0;
    let reviewSitesPulled = 0;
    if (dto.collectNew) {
      const markets = targetCountries.length > 0 ? targetCountries.slice(0, MAX_MARKETS_CONSIDERED) : ['United States'];
      const industry = profile?.data.category?.trim() || null;
      const icp = segments.find((s) => s && s.trim())?.trim() || null;
      const topics = services.length > 0 ? services : segments.slice(0, MAX_SERVICES_CONSIDERED);

      // Run one discovery SERP and fold its organic results into `raw`, tagged
      // with the given evidence kind so Stage-4 scoring can weight the source.
      const runSerp = async (
        query: string,
        evidenceKind: RawCandidate['evidenceKind'],
        reason: (key: string) => string,
      ): Promise<void> => {
        try {
          const resp = await this.serpIntelligence.serpForDiscovery(
            query,
            { locationName: 'United States', languageCode: 'en', device: 'desktop' },
            dto.provider,
          );
          queriesRun++;
          costUsd += resp.costUsd;
          for (const item of resp.items) {
            if (item.type !== 'organic' || !item.domain) continue;
            const key = domainKeyOf(item.domain);
            if (!key) continue;
            raw.push({ name: item.title || key, domain: key, evidenceKind, reason: reason(key) });
          }
        } catch (err) {
          this.logger.warn(`discoverByMarket: search "${query}" failed: ${(err as Error).message}`);
        }
      };

      // Pass 1 (spec §6.4) — name-independent keyword/category searches. They
      // need no competitor name to exist first, so they run first and seed the
      // branded comparison pass. Reserve budget for pass 2.
      const nameIndependent: string[] = [];
      for (const market of markets) {
        for (const topic of topics.length > 0 ? topics : ['']) {
          if (!topic) {
            nameIndependent.push(`best providers in ${market}`);
            continue;
          }
          nameIndependent.push(`${topic} in ${market}`);
          if (icp) nameIndependent.push(`best ${topic} tools for ${icp}`);
          if (industry) nameIndependent.push(`${topic} for ${industry}`);
          nameIndependent.push(`${topic} vendors ${market}`);
        }
      }
      const pass1Budget = Math.max(1, MAX_MARKET_QUERIES - MAX_COMPARISON_QUERIES);
      for (const query of dedupeStrings(nameIndependent).slice(0, pass1Budget)) {
        await runSerp(query, 'serp-live-search', () => `Ranked organically for the composed search "${query}".`);
      }

      // Pass 2 (spec §6.1) — comparison/alternatives, one per branded candidate
      // this run just surfaced, spending whatever SERP budget pass 1 left.
      for (const name of pickComparisonSeeds(raw, MAX_COMPARISON_QUERIES)) {
        if (queriesRun >= MAX_MARKET_QUERIES) break;
        const query = `"${name}" alternatives`;
        await runSerp(query, 'serp-comparison-search', () => `Surfaced by the comparison search "${query}".`);
      }

      // Pass 3 (spec §6.1) — best-effort review-site category listings (G2). A
      // plain fetch first, a headless render as a backup when it is bot-blocked;
      // both degrade to nothing rather than blocking discovery.
      for (const category of dedupeStrings([industry, ...topics].filter((t): t is string => !!t)).slice(0, MAX_REVIEW_SITE_PULLS)) {
        const found = await this.pullReviewSiteCategory(category);
        if (found.pulled) reviewSitesPulled++;
        raw.push(...found.candidates);
      }
    }

    // ── Normalize, exclude, dedupe, classify ───────────────────────────────
    const byIdentity = new Map<string, { candidate: RawCandidate; evidenceKinds: Set<string> }>();
    let excludedCount = 0;
    const excludedReasons: string[] = [];

    for (const c of raw) {
      const dKey = c.domain ? domainKeyOf(c.domain) : null;
      const nKey = nameKey(c.name);

      if (dKey && clientDomainKey && dKey === clientDomainKey) {
        excludedCount++;
        continue;
      }
      if (dKey && EXCLUDED_DOMAINS.has(dKey)) {
        excludedCount++;
        excludedReasons.push(`${dKey} — known directory/publishing/social platform, not a provider`);
        continue;
      }
      if (existingNameKeys.has(nKey) || (dKey && existingDomainKeys.has(dKey))) {
        // Already tracked or already a candidate — not a new proposal.
        continue;
      }
      if (rejectedNameKeys.has(nKey) || (dKey && rejectedDomainKeys.has(dKey))) {
        excludedCount++;
        excludedReasons.push(`${c.name} — previously rejected by an operator, not re-proposed`);
        continue;
      }

      const identity = dKey ?? nKey;
      const bucket = byIdentity.get(identity);
      if (bucket) {
        bucket.evidenceKinds.add(c.evidenceKind);
      } else {
        byIdentity.set(identity, { candidate: c, evidenceKinds: new Set([c.evidenceKind]) });
      }
    }

    const created: CompetitorRecord[] = [];
    for (const { candidate, evidenceKinds } of byIdentity.values()) {
      // Classification (§12.2): grounded in the evidence actually gathered,
      // never an invented domain and never a promotion to `tracked` — a
      // candidate mentioned by name in an AI verdict (a market-aware source
      // reasoning about this project's own competitive set) is treated as a
      // likely direct competitor; a bare SERP co-occurrence with no other
      // corroborating evidence is treated as merely adjacent until a human
      // says otherwise.
      const relevance = evidenceKinds.has('aeo-verdict')
        ? 'direct-competitor'
        : evidenceKinds.size > 1
          ? 'direct-competitor'
          : 'adjacent-alternative';

      const row = await this.prisma.competitor.upsert({
        where: { projectId_name: { projectId, name: candidate.name } },
        update: {},
        create: {
          projectId,
          name: candidate.name,
          domain: candidate.domain,
          source: 'market-discovery',
          status: 'candidate',
          relevance,
          discoveryReason: `${candidate.reason} (${[...evidenceKinds].join(', ')})`,
        },
      });
      if (row.status === 'candidate') created.push(row);
    }

    return {
      projectId,
      collectNew: !!dto.collectNew,
      queriesRun,
      reviewSitesPulled,
      costUsd: Number(costUsd.toFixed(6)),
      servicesConsidered: services,
      marketsConsidered: targetCountries,
      candidatesProposed: created.length,
      candidatesExcluded: excludedCount,
      exclusionSample: excludedReasons.slice(0, 10),
      candidates: created,
      note:
        'Proposals only — the existing tracked list is never replaced. Partner/directory/publishing-platform domains and the client\'s own domain are excluded before a row is ever created. A candidate previously rejected by an operator is never re-proposed.',
    };
  }

  /**
   * Best-effort pull of a G2 review-site category listing (spec §6.1). Tries a
   * plain HTTP fetch first, then falls back to a headless render when the fetch
   * is bot-blocked (G2 sits behind Cloudflare). Returns the products it can
   * parse, tagged `review-site-category`; on any block/empty/parse failure it
   * returns nothing and logs — it must never block market discovery, and a
   * Cloudflare challenge page must never be parsed as competitor data.
   *
   * These candidates carry no domain (the listing links to G2 product pages,
   * not the vendor's own site), so they seed a *name* for the branded Stage-3
   * buckets and add evidence-kind diversity for Stage-4 scoring — not a domain.
   */
  private async pullReviewSiteCategory(category: string): Promise<{ pulled: boolean; candidates: RawCandidate[] }> {
    const slug = category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return { pulled: false, candidates: [] };
    const url = `https://www.g2.com/categories/${slug}`;

    let html = '';
    try {
      const res = await this.fetcher.fetch({ url, cacheTtlSeconds: 86400 }, 'competitors:review-site');
      if (res.status >= 200 && res.status < 300 && looksLikeReviewListing(res.body)) html = res.body;
    } catch (err) {
      this.logger.warn(`review-site fetch "${url}" failed: ${(err as Error).message}`);
    }
    if (!html) {
      // Backup: headless render past the JS shell / soft block.
      try {
        const res = await this.fetcher.render({ url }, 'competitors:review-site');
        if (looksLikeReviewListing(res.html)) html = res.html;
      } catch (err) {
        this.logger.warn(`review-site render "${url}" failed: ${(err as Error).message}`);
      }
    }
    if (!html) {
      this.logger.log(`review-site category "${slug}" returned no usable listing (likely bot-blocked) — skipped; discovery continues`);
      return { pulled: false, candidates: [] };
    }

    const candidates: RawCandidate[] = parseG2CategoryListing(html).map((name) => ({
      name,
      domain: null,
      evidenceKind: 'review-site-category',
      reason: `Listed in the G2 "${slug}" category.`,
    }));
    return { pulled: candidates.length > 0, candidates };
  }

  /**
   * Rank rivals by the weighted composite score (discoverability-pipeline Stage 4
   * steps 1–2, spec §7). Read-only: aggregates the newest completed AEO audit's
   * stances (`AeoStanceService.aggregateCompetitorSignals`), normalizes each
   * factor across the candidate set, and combines them with the §7 weights —
   * platform coverage 30%, absence-mentions 25%, co-mention 15%, position 15%,
   * prompt diversity 10%, external-discovery corroboration 5% (the last from
   * Stage-2 `market-discovery` Competitor rows). Applies a min-platform-coverage
   * floor, relaxing it (and flagging) when too few candidates clear it; returns
   * the top N plus a 6th–15th watchlist (kept, not discarded, so a later round
   * can reconsider them). No writes, no LLM call, no schema change.
   */
  async rankCompetitorsByStance(projectId: string, opts: { topN?: number } = {}): Promise<CompetitorRankingResult> {
    await this.requireProject(projectId);
    const topN = opts.topN ?? DEFAULT_TOP_N;
    const empty = (auditId: string | null, note: string): CompetitorRankingResult => ({
      projectId,
      auditId,
      rankedTop: [],
      watchlist: [],
      minPlatformCoverage: MIN_PLATFORM_COVERAGE,
      floorRelaxed: false,
      totalCandidates: 0,
      note,
    });

    const audit = await this.prisma.aeoAudit.findFirst({
      where: { projectId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!audit) return empty(null, 'No completed AEO audit for this project yet — run one before ranking competitors.');

    const signals = await this.aeoStance.aggregateCompetitorSignals(audit.id);
    if (signals.length === 0) {
      return empty(audit.id, 'The latest AEO audit surfaced no rival names in its stances — nothing to rank.');
    }

    // External-discovery corroboration: names Stage-2 market discovery also found.
    const discovered = await this.prisma.competitor.findMany({
      where: { projectId, source: 'market-discovery' },
      select: { name: true },
    });
    const discoveredKeys = new Set(discovered.map((c) => nameKey(c.name)));

    const ranking = rankCompetitorSignals(signals, discoveredKeys, topN);

    return {
      projectId,
      auditId: audit.id,
      ...ranking,
      note:
        `Ranked ${ranking.totalCandidates} rival name(s) from AEO audit ${audit.id} by the §7 composite ` +
        `(platform 30% / absence 25% / co-mention 15% / position 15% / diversity 10% / discovery 5%). ` +
        (ranking.floorRelaxed
          ? `The ${MIN_PLATFORM_COVERAGE}-platform floor was relaxed to 1 — too few rivals cleared it.`
          : `Only rivals seen on ≥${ranking.minPlatformCoverage} platform(s) are ranked.`),
    };
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

    // §12.3: exactly which source observations/versions this comparison was
    // derived from, so a later addition of a competitor can be told apart
    // from a re-derivation over the same evidence.
    const competitorSetVersion = createHash('sha256')
      .update([...competitors].map((c) => `${c.id}:${c.status}`).sort().join(','))
      .digest('hex')
      .slice(0, 16);
    const profileIds = competitors.map((c) => c.profiles[0]?.id).filter((id): id is string => !!id);
    const techScanIds = [...new Set(competitors.map((c) => c.profiles[0]?.techScanId).filter((id): id is string => !!id))];
    const aeoAuditIds = [
      ...new Set(
        rows
          .map((r) => r.aeoStanding?.auditId)
          .filter((id): id is string => !!id),
      ),
    ];
    const comparisonMeta: ComparisonProvenance = {
      competitorSetVersion,
      extractionVersion: 'gap-v1',
      techScanIds,
      profileIds,
      aeoAuditIds,
      serpResultSampleCount: rows.filter((r) => r.serpStatus === 'present').length,
    };

    const result: GapResult = {
      projectId,
      domain: project.domain,
      generatedAt: new Date().toISOString(),
      snapshotId: '', // filled in below once the snapshot row exists
      comparisonMeta,
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

    // Persist as a frozen snapshot (§12.3): "Update comparison" — a read from
    // already-stored evidence, never a new paid AEO/SERP/tech run — is still
    // worth keeping a permanent, never-mutated record of, so a later
    // competitor-set change cannot retroactively alter what an earlier
    // comparison said. Best-effort: a write failure here must not fail the
    // read itself.
    try {
      const snapshot = await this.prisma.competitorComparisonSnapshot.create({
        data: {
          projectId,
          competitorSetVersion,
          extractionVersion: 'gap-v1',
          sourceObservationIds: JSON.stringify({ techScanIds, profileIds, aeoAuditIds }),
          result: JSON.stringify(result),
        },
      });
      result.snapshotId = snapshot.id;
    } catch (err) {
      this.logger.warn(`gap: failed to persist comparison snapshot for ${projectId}: ${(err as Error).message}`);
    }

    return result;
  }

  /** Every frozen comparison snapshot for a project, newest first — summary only (no full result body). */
  async listComparisonSnapshots(projectId: string): Promise<
    Array<{ id: string; competitorSetVersion: string; extractionVersion: string; generatedAt: Date }>
  > {
    await this.requireProject(projectId);
    return this.prisma.competitorComparisonSnapshot.findMany({
      where: { projectId },
      orderBy: { generatedAt: 'desc' },
      select: { id: true, competitorSetVersion: true, extractionVersion: true, generatedAt: true },
    });
  }

  /**
   * Read one frozen comparison exactly as it was computed (§12.3: "never
   * retroactively mutate a frozen report/comparison"). Returns the stored
   * `result` JSON verbatim — never recomputed, even if competitors have since
   * been added, removed, or reprofiled.
   */
  async getComparisonSnapshot(projectId: string, snapshotId: string): Promise<GapResult> {
    const row = await this.prisma.competitorComparisonSnapshot.findUnique({ where: { id: snapshotId } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Comparison snapshot ${snapshotId} not found for project ${projectId}`);
    }
    return JSON.parse(row.result) as GapResult;
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
    let companyContextStatus: 'completed' | 'skipped' | 'failed' | 'unknown' = 'unknown';
    let companyContext: CompetitorCompanyContext | null = null;

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
              // Stage 4 step 3 (homepage-only): the rival's own company context,
              // off the SAME HTML/JSON-LD just read. Null when the page states
              // nothing usable — a `completed` read with no context, not a failure.
              companyContext = extractCompetitorCompanyContext(result.html, result.raw as SchemaBlock[]);
              companyContextStatus = 'completed';
            }
          } catch (err) {
            seoStatus = 'failed';
            seoError = (err as Error).message;
            companyContextStatus = 'failed';
          }
        } catch (err) {
          // Schema extraction is best-effort — a failure here does not fail
          // the whole profile, since the tech scan already succeeded.
          this.logger.warn(`Schema read failed for ${competitor.domain}: ${(err as Error).message}`);
          seoStatus = 'failed';
          seoError = `Homepage could not be read: ${(err as Error).message}`;
          companyContextStatus = 'failed';
        }
      } else {
        seoStatus = 'failed';
        seoError = error;
        companyContextStatus = 'failed';
      }
    }

    if (!competitor.domain) {
      seoStatus = 'skipped';
      seoError = 'No domain on record — no homepage to score.';
      companyContextStatus = 'skipped';
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
        companyContextStatus,
        companyContext: companyContext ? JSON.stringify(companyContext) : null,
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
