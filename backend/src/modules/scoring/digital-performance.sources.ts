/**
 * The read-only source adapter for the `digital-performance` score family.
 *
 * ── Why this file exists as its own module ──────────────────────────────────
 * This is the ONE place the new score touches another module's data. The
 * governing preference for this phase is to read the **stable Prisma models**
 * (TechnicalAudit/AuditPage, GoogleDataSnapshot, AeoAudit/AeoStance,
 * PresenceAccount/PresencePost, ContentBrief/ContentRevision, BusinessProfile)
 * rather than binding to service method signatures in modules that are being
 * reshaped concurrently. If a source layer changes shape, this file is the only
 * one that has to be reconciled — the evaluators in
 * `digital-performance.buckets.ts` consume plain data and know nothing about
 * where it came from.
 *
 * ── The honesty rules encoded here ──────────────────────────────────────────
 * - Nothing here makes a network call, refreshes a provider, or starts a job.
 *   §5.7: "Loading this page must never start an audit, refresh a paid
 *   provider, build a score, or create a job." Every method is a bounded read
 *   of rows that already exist.
 * - A source's own timestamps are preserved, never relabeled: `fetchedAt` is
 *   when a provider was actually read, `checkedAt` is when a page was actually
 *   fetched. Freshness is judged against those, never against `createdAt` of a
 *   row we happened to write.
 * - A missing row is reported as missing. It is never replaced by a zero.
 *
 * @module digital-performance.sources
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

// ─── Source shapes (plain data — no Prisma types leak past this file) ────────

export interface CrawledPage {
  url: string;
  status: number;
  score: number | null;
}

export interface WebsiteHealthSource {
  auditId: string | null;
  crawledAt: Date | null;
  pages: CrawledPage[];
}

export interface GscFact {
  query: string;
  impressions: number;
  position: number;
}

export interface GoogleVisibilitySource {
  snapshotId: string | null;
  fetchedAt: Date | null;
  /** false when the provider's own pagination says more rows exist than were fetched. */
  complete: boolean;
  /** The source's own window strings — GSC dates are Pacific and are not relabeled. */
  windowStart: string | null;
  windowEnd: string | null;
  timezoneNote: string | null;
  rowCount: number;
  facts: GscFact[];
}

export interface AiVisibilitySource {
  auditId: string | null;
  /** The newest audit's own status — `failed` is the source reporting its own failure. */
  status: string | null;
  attemptedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  surfaces: string[];
  markets: string[];
  stances: Array<{ stance: string; surface: string | null }>;
  /** id + the moment the newest COMPLETED audit finished, if any. */
  latestCompleted: { id: string; finishedAt: Date } | null;
}

export interface ProfileAccount {
  id: string;
  platform: string;
  url: string;
  state: string;
  verifiedAt: Date | null;
  statusCode: number | null;
  updatedAt: Date;
}

export interface OnlineProfilesSource {
  accounts: ProfileAccount[];
  /** A discovery run that reported its own failure, when it is newer than the newest account row. */
  discoveryFailedAt: Date | null;
  discoveryError: string | null;
}

export interface SocialPostRow {
  platform: string;
  kind: string;
  postedAt: Date | null;
  fetchedAt: Date | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  followerCount: number | null;
}

export interface SocialActivitySource {
  channels: Array<{ platform: string; accountId: string }>;
  posts: SocialPostRow[];
  discoveryFailedAt: Date | null;
  discoveryError: string | null;
}

export interface ContentBriefRow {
  id: string;
  wordTarget: number | null;
  updatedAt: Date;
}

export interface ContentRevisionRow {
  assetId: string;
  /** The ContentBrief row this revision was written against. */
  briefId: string | null;
  revision: number;
  wordCount: number;
  createdAt: Date;
}

export interface ContentQualitySource {
  briefs: ContentBriefRow[];
  /** The latest saved revision of each content asset, so a superseded draft is never scored as the delivered content. */
  revisions: ContentRevisionRow[];
}

// ─── Adapter ────────────────────────────────────────────────────────────────

@Injectable()
export class DigitalPerformanceSources {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Website health reads the newest technical audit and the pages that crawl
   * actually fetched. Only stable columns are used (`status`, `score`,
   * `createdAt`) — no dependency on another module's issue-code vocabulary.
   */
  async websiteHealth(projectId: string): Promise<WebsiteHealthSource> {
    const audit = await this.prisma.technicalAudit.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, pagesCrawled: true },
    });
    if (!audit) return { auditId: null, crawledAt: null, pages: [] };
    const pages = await this.prisma.auditPage.findMany({
      where: { auditId: audit.id },
      select: { url: true, status: true, score: true },
    });
    return { auditId: audit.id, crawledAt: audit.createdAt, pages };
  }

  /**
   * Google visibility reads the newest stored Search Console page/query/date
   * snapshot. It never calls Google — the snapshot is written by the explicit
   * Website sync (§7.6), and a score built on a live call would make every score
   * build a paid provider refresh.
   */
  async googleVisibility(projectId: string): Promise<GoogleVisibilitySource> {
    const snapshot = await this.prisma.googleDataSnapshot.findFirst({
      where: { projectId, service: 'search-console', kind: 'page-query-date' },
      orderBy: { fetchedAt: 'desc' },
    });
    if (!snapshot) {
      return {
        snapshotId: null,
        fetchedAt: null,
        complete: false,
        windowStart: null,
        windowEnd: null,
        timezoneNote: null,
        rowCount: 0,
        facts: [],
      };
    }
    return {
      snapshotId: snapshot.id,
      fetchedAt: snapshot.fetchedAt,
      complete: snapshot.complete,
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      timezoneNote: snapshot.timezoneNote,
      rowCount: snapshot.rowCount,
      facts: parseGscFacts(snapshot.rows),
    };
  }

  /**
   * AI visibility reads the newest COMPLETED AEO audit and the judged stances
   * attached to it. Stance rates are counts over stored rows; the LLM's prose
   * never sets the score (§5.3 rule 3) — it only ever wrote the `stance` label
   * that this counts.
   *
   * The newest audit of ANY status is read separately: an audit that is merely
   * in flight must not blank out the last real measurement, while an audit the
   * source itself reported as `failed` is a failure signal the state machine
   * must see.
   */
  async aiVisibility(projectId: string): Promise<AiVisibilitySource> {
    const [newest, completed] = await Promise.all([
      this.prisma.aeoAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, finishedAt: true, error: true, surfaces: true, markets: true },
      }),
      this.prisma.aeoAudit.findFirst({
        where: { projectId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, finishedAt: true },
      }),
    ]);
    if (!newest) {
      return {
        auditId: null,
        status: null,
        attemptedAt: null,
        finishedAt: null,
        error: null,
        surfaces: [],
        markets: [],
        stances: [],
        latestCompleted: null,
      };
    }
    const stances = completed
      ? await this.prisma.aeoStance.findMany({
          where: { auditId: completed.id },
          select: { stance: true, surface: true },
        })
      : [];
    return {
      auditId: newest.id,
      status: newest.status,
      attemptedAt: newest.createdAt,
      finishedAt: newest.finishedAt,
      error: newest.error,
      surfaces: parseStringArray(newest.surfaces),
      markets: parseStringArray(newest.markets),
      stances,
      latestCompleted: completed
        ? { id: completed.id, finishedAt: completed.finishedAt ?? completed.createdAt }
        : null,
    };
  }

  /**
   * Online profiles reads the discovered account inventory. Candidate rows are
   * excluded on purpose: §5.2 scores "confirmed relevant accounts", and a
   * candidate is a question the operator has not answered yet.
   */
  async onlineProfiles(projectId: string): Promise<OnlineProfilesSource> {
    const [accounts, discovery] = await Promise.all([
      this.prisma.presenceAccount.findMany({
        where: { projectId, entity: 'company', state: { in: ['confirmed', 'unverified', 'missing'] } },
        select: { id: true, platform: true, url: true, state: true, verifiedAt: true, statusCode: true, updatedAt: true },
      }),
      this.prisma.presenceDiscovery.findFirst({
        where: { projectId, status: 'failed' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, error: true },
      }),
    ]);
    return {
      accounts,
      discoveryFailedAt: discovery?.startedAt ?? null,
      discoveryError: discovery?.error ?? null,
    };
  }

  /**
   * Social activity reads confirmed company accounts (which define the channels
   * in scope) plus the social-activity rows the Apify enrichment stored.
   *
   * `fetchedAt` — not `postedAt` — is what decides whether a channel was
   * actually observed: a channel with no row means we never looked, which is
   * different from a channel we looked at and found quiet.
   */
  async socialActivity(projectId: string): Promise<SocialActivitySource> {
    const [accounts, posts, discovery] = await Promise.all([
      this.prisma.presenceAccount.findMany({
        where: { projectId, entity: 'company', state: 'confirmed' },
        select: { id: true, platform: true },
      }),
      this.prisma.presencePost.findMany({
        where: { projectId },
        select: {
          platform: true,
          kind: true,
          postedAt: true,
          fetchedAt: true,
          likeCount: true,
          commentCount: true,
          shareCount: true,
          followerCount: true,
        },
      }),
      this.prisma.presenceDiscovery.findFirst({
        where: { projectId, status: 'failed' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, error: true },
      }),
    ]);
    return {
      channels: accounts.map((a) => ({ platform: a.platform, accountId: a.id })),
      posts,
      discoveryFailedAt: discovery?.startedAt ?? null,
      discoveryError: discovery?.error ?? null,
    };
  }

  /**
   * Content quality reads the agreed important content — approved briefs — and
   * the latest saved revision of each content asset. A brief with no revision is
   * uncovered content, which is a fact about the work, not an error.
   */
  async contentQuality(projectId: string): Promise<ContentQualitySource> {
    const briefs = await this.prisma.contentBrief.findMany({
      where: { projectId, status: 'approved' },
      select: { id: true, wordTarget: true, updatedAt: true },
    });
    if (briefs.length === 0) return { briefs: [], revisions: [] };

    const assets = await this.prisma.growthAsset.findMany({
      where: { projectId },
      select: { id: true },
    });
    if (assets.length === 0) return { briefs, revisions: [] };

    const revisions = await this.prisma.contentRevision.findMany({
      where: { assetId: { in: assets.map((a) => a.id) } },
      orderBy: [{ assetId: 'asc' }, { revision: 'desc' }],
      select: { assetId: true, briefId: true, revision: true, wordCount: true, createdAt: true },
    });
    // Latest revision per asset only: an earlier draft's word count is not the
    // delivered content, and counting both would reward writing drafts.
    const latestPerAsset = new Map<string, ContentRevisionRow>();
    for (const r of revisions) if (!latestPerAsset.has(r.assetId)) latestPerAsset.set(r.assetId, r);
    return { briefs, revisions: [...latestPerAsset.values()] };
  }

  /**
   * §5.5 requires a change to be shown only between runs with the same market
   * set, so the market set is part of the comparison key. It is read from the
   * newest CONFIRMED business profile: an unconfirmed row is a candidate, and
   * letting a draft profile silently change the comparison segment would let an
   * unconfirmed edit invalidate a client's score history.
   */
  async marketSet(projectId: string): Promise<{ markets: string[]; profileVersion: number | null }> {
    const profile = await this.prisma.businessProfile.findFirst({
      where: { projectId, confirmedAt: { not: null } },
      orderBy: { version: 'desc' },
      select: { version: true, targets: true, markets: true },
    });
    if (!profile) return { markets: [], profileVersion: null };

    const fromTargets = parseJsonArray(profile.targets)
      .map((t) => {
        const row = t as { country?: unknown; active?: unknown };
        if (row.active === false) return null;
        return typeof row.country === 'string' && row.country.trim() !== '' ? row.country.trim().toUpperCase() : null;
      })
      .filter((c): c is string => c !== null);

    const fromLegacy = parseJsonArray(profile.markets)
      .map((m) => (typeof m === 'string' && m.trim() !== '' ? m.trim().toUpperCase() : null))
      .filter((c): c is string => c !== null);

    const markets = [...new Set([...fromTargets, ...fromLegacy])].sort();
    return { markets, profileVersion: profile.version };
  }
}

// ─── Defensive parsing ──────────────────────────────────────────────────────
// Stored JSON columns are read as data of unknown shape. A row that does not
// look like a GSC fact is dropped rather than coerced into a zero.

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(raw: string | null): string[] {
  return parseJsonArray(raw).filter((v): v is string => typeof v === 'string');
}

function parseGscFacts(raw: string | null): GscFact[] {
  const out: GscFact[] = [];
  for (const row of parseJsonArray(raw)) {
    const r = row as { query?: unknown; impressions?: unknown; position?: unknown };
    if (typeof r.query !== 'string' || r.query.trim() === '') continue;
    if (typeof r.impressions !== 'number' || !Number.isFinite(r.impressions)) continue;
    if (typeof r.position !== 'number' || !Number.isFinite(r.position)) continue;
    out.push({ query: r.query, impressions: r.impressions, position: r.position });
  }
  return out;
}
