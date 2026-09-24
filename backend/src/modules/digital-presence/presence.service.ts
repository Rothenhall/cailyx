/**
 * Digital Presence Service — the client's footprint, assembled and kept honest.
 *
 * Two jobs:
 *   1. **Accounts** — discover them from the client's own site, let the operator
 *      correct or supply them, and never let a re-run overwrite operator input.
 *   2. **Inventory** — gather what every other module already discovered into
 *      one view, each line labelled with the module that produced it.
 *
 * The inventory deliberately carries a `not-checked` state alongside `found` and
 * `none`. "No competitors found" and "nobody has looked for competitors" are
 * different answers, and collapsing them would present an unasked question as a
 * negative finding.
 *
 * Analysis + approved decisions: `docs/analysis/digital-presence.md`.
 *
 * @module presence.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { PresenceDiscoveryService, type DiscoveredAccount } from './presence.discovery.service';
import { titleIdentifies, type ConsistencyStatus } from '../entity-audit/entity-audit.consistency';
import { PresenceSerpService } from './presence.serp.service';
import { PresenceDataForSeoService, type ReviewPlatform } from './presence.dataforseo.service';
import { PresenceApifyService, type ApifyPlatform, type ApifyTarget } from './presence.apify.service';
import { PresenceApplicabilityService, type PlatformApplicability } from './presence.applicability.service';
import { PresenceRejectionService } from './presence.rejection.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import {
  EXPECTED_BY_PROFILE,
  EXPECTED_PLATFORMS,
  GROUP_LABELS,
  PROFILE_LABELS,
  inferBusinessProfile,
  PLATFORM_GROUP,
  PLATFORM_LABELS,
  SOURCE_LABELS,
  type BusinessProfileDto,
  type CapabilityNote,
  type DiscoveryRunDto,
  type FootprintItem,
  type FootprintSection,
  type PresenceAccountDto,
  type PresenceGap,
  type BusinessProfile,
  type CategoryCoverage,
  type CoverageState,
  type PresenceAssessment,
  type PresenceEntity,
  type PresenceGroup,
  type PresenceInventory,
  type PresencePlatform,
  type PresenceSource,
  type PresenceState,
  type ReviewDto,
  type SocialActivityRunDto,
  type SocialActivitySummary,
  type SocialPostDto,
} from './presence.types';

/** Apify calls the platform `twitter`; this module's own account rows call it `x`. */
const APIFY_TO_PRESENCE_PLATFORM: Record<ApifyPlatform, PresencePlatform> = {
  linkedin: 'linkedin',
  instagram: 'instagram',
  facebook: 'facebook',
  twitter: 'x',
  youtube: 'youtube',
  tiktok: 'tiktok',
};

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: PresenceDiscoveryService,
    private readonly serp: PresenceSerpService,
    private readonly dataforseo: PresenceDataForSeoService,
    private readonly apify: PresenceApifyService,
    private readonly config: ConfigService,
    private readonly pipelineQueue: PipelineQueueService,
    private readonly applicability: PresenceApplicabilityService,
    private readonly rejections: PresenceRejectionService,
  ) {
    this.pipelineQueue.registerHandler('presence-discovery', (data: {
      runId: string; projectId: string; searchWeb: boolean;
    }) => this.executeDiscovery(data.runId, data.projectId, data.searchWeb));
  }

  // ─── Discovery ──────────────────────────────────────────────────────────

  /**
   * Crawl the client's site, classify every profile link, verify what can be
   * verified, and reconcile against what is already stored.
   *
   * @param projectId Project to discover for.
   * @param searchWeb Also sweep Google for accounts the site does not link.
   *   Off by default because it costs a credit per platform — a discovery run
   *   must never bill by accident, which also keeps the smoke harness at zero
   *   spend as its contract promises.
   * @returns The completed run.
   * @throws NotFoundException when the project does not exist.
   */
  async discover(projectId: string, searchWeb = false): Promise<DiscoveryRunDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const run = await this.prisma.presenceDiscovery.create({
      data: { projectId, status: 'crawling' },
    });

    // The crawl/verify/SERP work runs on the background pipeline queue —
    // this returns the pending row immediately. Poll GET discoveries/:runId
    // (or re-fetch the inventory) until status is completed/failed.
    await this.pipelineQueue.enqueue(
      'presence-discovery',
      { runId: run.id, projectId, searchWeb },
      { attempts: 3, backoff: { type: 'exponential', delay: 10000 } },
    );

    return this.toRunDto(run);
  }

  /** Run by the pipeline queue worker. Does the actual crawl/verify/SERP work
   *  for a run already created by `discover()`. */
  async executeDiscovery(runId: string, projectId: string, searchWeb = false): Promise<DiscoveryRunDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const run = await this.prisma.presenceDiscovery.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Discovery run not found');

    try {
      const { accounts, pagesFetched } = await this.discovery.crawl(project.domain, run.id);

      await this.prisma.presenceDiscovery.update({
        where: { id: run.id },
        data: { status: 'verifying', pagesFetched, found: accounts.length },
      });

      const brand = project.clientName ?? project.name ?? null;
      const verified = await this.discovery.verify(accounts, brand, run.id);

      let confirmed = 0;
      let unverified = 0;
      const sources: Record<string, number> = {};

      for (const acc of verified) {
        if (acc.state === 'confirmed') confirmed++;
        if (acc.state === 'unverified') unverified++;
        sources[acc.source] = (sources[acc.source] ?? 0) + 1;

        const existing = await this.prisma.presenceAccount.findUnique({
          where: { projectId_platform_url: { projectId, platform: acc.platform, url: acc.url } },
        });

        // An operator-supplied row is authoritative. A re-run may refresh what it
        // learned about the URL, but must never downgrade its provenance --
        // otherwise the operator's correction silently becomes a crawl result.
        if (existing?.source === 'manual') {
          await this.prisma.presenceAccount.update({
            where: { id: existing.id },
            data: {
              state: acc.state,
              reason: acc.reason,
              statusCode: acc.statusCode,
              title: acc.title,
              verifiedAt: new Date(),
            },
          });
          continue;
        }

        await this.prisma.presenceAccount.upsert({
          where: { projectId_platform_url: { projectId, platform: acc.platform, url: acc.url } },
          create: {
            projectId,
            platform: acc.platform,
            url: acc.url,
            handle: acc.handle,
            source: acc.source,
            entity: acc.entity,
            state: acc.state,
            reason: acc.reason,
            statusCode: acc.statusCode,
            title: acc.title,
            foundOn: acc.foundOn,
            verifiedAt: new Date(),
          },
          update: {
            handle: acc.handle,
            source: acc.source,
            entity: acc.entity,
            state: acc.state,
            reason: acc.reason,
            statusCode: acc.statusCode,
            title: acc.title,
            foundOn: acc.foundOn,
            verifiedAt: new Date(),
          },
        });
      }

      // ── SERP sweep ──────────────────────────────────────────────────
      // Only for expected platforms the crawl did NOT find, so a fully
      // discovered client spends no credits at all. Everything it returns is a
      // candidate: search cannot tell the client's account from a similarly
      // named stranger's, and pretending otherwise would put the wrong company
      // in a client's report.
      const held = new Set(
        (
          await this.prisma.presenceAccount.findMany({
            where: { projectId, state: { not: 'candidate' } },
            select: { platform: true },
          })
        ).map((r) => r.platform),
      );
      // P05 §11.2 — the applicability policy decides what the collector looks
      // for, not the generic default set. A `not-relevant` platform (an
      // online-only SaaS's local listing, an app-store entry with no app) is
      // never searched for, and a `needs-confirmation` platform is still
      // searched (asking the question costs nothing extra here; not searching
      // it would silently resolve the ambiguity as "irrelevant").
      const category = await this.currentCategory(projectId, project.category);
      const applicable = await this.applicability.relevantOrOptional(projectId, category);
      const applicableSet = new Set<PresencePlatform>(applicable);
      const needsConfirmation = (await this.applicability.forProject(projectId, category))
        .filter((a) => a.status === 'needs-confirmation')
        .map((a) => a.platform);
      for (const p of needsConfirmation) applicableSet.add(p);
      const stillMissing = [...applicableSet].filter((p) => !held.has(p));
      const sweep = searchWeb
        ? await this.serp.sweep(brand, project.domain, [...stillMissing])
        : {
            candidates: [],
            queriesSpent: 0,
            costUsd: 0,
            skipped: this.serp.enabled
              ? 'web search not requested for this run (billable DataForSEO queries)'
              : 'web search not requested, and DataForSEO is not configured',
          };

      let candidates = 0;
      for (const c of sweep.candidates) {
        const existing = await this.prisma.presenceAccount.findUnique({
          where: { projectId_platform_url: { projectId, platform: c.platform, url: c.url } },
        });
        // Never touch a row we already know about by a better route. A crawled
        // or operator-supplied account outranks a search guess, always.
        if (existing) continue;
        // P05 §11.4 — a human already said this exact URL is not ours. Without
        // this check the next sweep would recreate the identical rejected
        // candidate every run, which is precisely the bug the tombstone exists
        // to prevent.
        if (await this.rejections.isTombstoned(projectId, c.platform, c.url)) continue;
        await this.prisma.presenceAccount.create({
          data: {
            projectId,
            platform: c.platform,
            url: c.url,
            handle: c.handle,
            source: 'serp',
            entity: c.entity,
            state: 'candidate',
            reason: null,
            title: c.title,
            foundOn: c.query,
            confidence: c.confidence,
          },
        });
        candidates++;
        sources.serp = (sources.serp ?? 0) + 1;
      }

      const done = await this.prisma.presenceDiscovery.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          confirmed,
          unverified,
          candidates,
          serpQueries: sweep.queriesSpent,
          serpCostUsd: sweep.costUsd,
          serpSkipped: sweep.skipped,
          sources: JSON.stringify(sources),
          finishedAt: new Date(),
        },
      });
      return this.toRunDto(done);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error('Presence discovery failed for ' + projectId + ': ' + message);
      const failed = await this.prisma.presenceDiscovery.update({
        where: { id: run.id },
        data: { status: 'failed', error: message, finishedAt: new Date() },
      });
      return this.toRunDto(failed);
    }
  }

  /** Discovery run history, newest first. */
  async listRuns(projectId: string, limit = 10): Promise<DiscoveryRunDto[]> {
    const rows = await this.prisma.presenceDiscovery.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((r) => this.toRunDto(r));
  }

  /** One discovery run by id — for polling a run queued via `discover()`. */
  async getRun(projectId: string, runId: string): Promise<DiscoveryRunDto> {
    const row = await this.prisma.presenceDiscovery.findFirst({ where: { id: runId, projectId } });
    if (!row) throw new NotFoundException('Discovery run not found');
    return this.toRunDto(row);
  }

  // ─── Operator-supplied accounts ─────────────────────────────────────────

  /**
   * Add an account from a pasted URL.
   *
   * The platform and handle are derived from the URL rather than asked for: the
   * operator already encoded both when they copied the link, and a dropdown
   * would only add a way to disagree with it.
   *
   * @throws BadRequestException when the URL is not a recognised profile, naming
   *   what was rejected so the operator can see whether they pasted a post
   *   rather than a profile.
   */
  async addAccount(projectId: string, url: string): Promise<PresenceAccountDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const hit = this.discovery.classifyOne(url);
    if (!hit) {
      throw new BadRequestException(
        `"${url}" is not a recognised profile URL. Paste the profile itself ` +
          '(e.g. https://instagram.com/yourbrand), not a post, a share link or a search page.',
      );
    }

    const verified = await this.discovery.verify(
      [{ ...hit, source: 'manual' as PresenceSource, foundOn: 'operator' }],
      project.clientName ?? project.name ?? null,
      'manual',
    );
    const v = verified[0];

    const row = await this.prisma.presenceAccount.upsert({
      where: { projectId_platform_url: { projectId, platform: hit.platform, url: hit.url } },
      create: {
        projectId,
        platform: hit.platform,
        url: hit.url,
        handle: hit.handle,
        source: 'manual',
        entity: hit.entity,
        state: v.state,
        reason: v.reason,
        statusCode: v.statusCode,
        title: v.title,
        foundOn: null,
        verifiedAt: new Date(),
      },
      update: {
        handle: hit.handle,
        source: 'manual',
        entity: hit.entity,
        state: v.state,
        reason: v.reason,
        statusCode: v.statusCode,
        title: v.title,
        verifiedAt: new Date(),
      },
    });

    return this.toAccountDto(row, project.clientName ?? project.name ?? null);
  }

  /** Correct one account's URL. Re-derives the platform from the new URL. */
  async updateAccount(projectId: string, accountId: string, url: string): Promise<PresenceAccountDto> {
    const row = await this.prisma.presenceAccount.findUnique({ where: { id: accountId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Account not found');

    const hit = this.discovery.classifyOne(url);
    if (!hit) throw new BadRequestException(`"${url}" is not a recognised profile URL.`);

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    const verified = await this.discovery.verify(
      [{ ...hit, source: 'manual' as PresenceSource, foundOn: 'operator' }],
      project?.clientName ?? project?.name ?? null,
      'manual',
    );
    const v = verified[0];

    const updated = await this.prisma.presenceAccount.update({
      where: { id: accountId },
      data: {
        platform: hit.platform,
        url: hit.url,
        handle: hit.handle,
        source: 'manual',
        entity: hit.entity,
        state: v.state,
        reason: v.reason,
        statusCode: v.statusCode,
        title: v.title,
        verifiedAt: new Date(),
      },
    });
    return this.toAccountDto(updated, project?.clientName ?? project?.name ?? null);
  }

  /**
   * Accept a search-suggested candidate as a real account.
   *
   * This is the human judgement the SERP sweep cannot make. On confirmation the
   * row becomes operator-supplied — it then outranks the crawler and survives
   * re-runs, exactly as a hand-typed URL does — and is verified like any other.
   *
   * @throws NotFoundException when the row is not a candidate of this project.
   */
  /**
   * A `candidate` row (SERP search guess) and an `unverified` row with strong
   * first-party evidence (`page-link`/`json-ld-sameas`/`manual` — genuinely
   * linked from the client's own site, not a search-engine's best guess) are
   * different problems wearing the same status. The first needs a human to
   * pick the real account out of same-named strangers; the second usually
   * already IS the real account — it's stuck at `unverified` only because the
   * platform's login wall blocks automated confirmation (LinkedIn/Instagram/
   * X/Facebook all do this routinely), not because of any actual identity
   * doubt. Re-running the same automated check that already failed would just
   * reproduce `unverified` forever, so this path skips it and records the
   * override as what it is — an operator's judgment call, not a
   * verification — rather than dressing it up as a check that passed.
   */
  private isManuallyConfirmableUnverified(row: { state: string; source: string }): boolean {
    return row.state === 'unverified' && (['page-link', 'json-ld-sameas', 'manual'] as PresenceSource[]).includes(row.source as PresenceSource);
  }

  async confirmCandidate(projectId: string, accountId: string): Promise<PresenceAccountDto> {
    const row = await this.prisma.presenceAccount.findUnique({ where: { id: accountId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Account not found');

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });

    if (this.isManuallyConfirmableUnverified(row)) {
      // Strong first-party evidence, blocked only by a platform login wall —
      // an operator's override, recorded honestly as one (never re-verified,
      // since that would just reproduce the same platform block).
      const updated = await this.prisma.presenceAccount.update({
        where: { id: accountId },
        data: {
          source: 'manual',
          state: 'confirmed',
          reason: `Operator-confirmed: linked from the client's own site, but ${row.reason ?? 'the platform blocks automated verification'}.`,
          verifiedAt: new Date(),
        },
      });
      return this.toAccountDto(updated, project?.clientName ?? project?.name ?? null);
    }

    if (row.state !== 'candidate') {
      throw new BadRequestException(
        'Only a search candidate, or an unverified page-linked/manual account, can be confirmed this way; this row is already an account.',
      );
    }

    const hit = this.discovery.classifyOne(row.url);
    const verified = hit
      ? await this.discovery.verify(
          [{ ...hit, source: 'manual' as PresenceSource, foundOn: 'operator' }],
          project?.clientName ?? project?.name ?? null,
          'confirm',
        )
      : [];
    const v = verified[0];

    const updated = await this.prisma.presenceAccount.update({
      where: { id: accountId },
      data: {
        source: 'manual',
        state: v ? v.state : 'unverified',
        reason: v ? v.reason : 'Confirmed by operator; not re-checked',
        statusCode: v ? v.statusCode : null,
        title: v ? v.title : row.title,
        // The query that found it stops being interesting once a human has
        // vouched for the row.
        foundOn: null,
        confidence: null,
        verifiedAt: new Date(),
      },
    });
    return this.toAccountDto(updated, project?.clientName ?? project?.name ?? null);
  }

  /** Remove an account. */
  async removeAccount(projectId: string, accountId: string): Promise<{ deleted: true }> {
    const row = await this.prisma.presenceAccount.findUnique({ where: { id: accountId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Account not found');
    await this.prisma.presenceAccount.delete({ where: { id: accountId } });
    return { deleted: true };
  }

  // ─── External presence: DataForSEO Business Data (wave-6 D2) ────────────

  /**
   * Pull the Google Business Profile plus Google/Trustpilot/Yelp review
   * counts and store a new snapshot of each.
   *
   * Unlike account discovery this is not a reconciliation — a business
   * profile drifts (hours, rating, categories), so each pull is a new row,
   * never an upsert that erases what the last one saw.
   *
   * @throws NotFoundException when the project does not exist.
   * @throws BadRequestException when there is no business name to search for.
   * @throws ServiceUnavailableException (via {@link PresenceDataForSeoService})
   *   when `SWARM_ALLOW_LIVE` / `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` are
   *   not configured — this method never substitutes an empty profile for
   *   that error.
   */
  async pullBusinessProfile(
    projectId: string,
    opts: { businessName?: string; locationName?: string },
  ): Promise<{ profile: BusinessProfileDto; reviews: ReviewDto[] }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const businessName = (opts.businessName ?? project.clientName ?? project.name ?? '').trim();
    if (!businessName) {
      throw new BadRequestException(
        'No business name to search for — set the project name/client name, or pass businessName explicitly.',
      );
    }
    const locationName =
      (opts.locationName ?? this.config.get<string>('PRESENCE_BUSINESS_LOCATION'))?.trim() || 'United States';

    // Fails closed with a typed 503 when not configured — never caught here,
    // so an absent credential surfaces to the caller exactly as it happened.
    const profileResult = await this.dataforseo.fetchProfile(businessName, locationName);
    const profileRow = await this.prisma.presenceProfile.create({
      data: {
        projectId,
        source: profileResult.source,
        name: profileResult.name,
        categories: JSON.stringify(profileResult.categories),
        hours: profileResult.hours,
        rating: profileResult.rating,
        reviewCount: profileResult.reviewCount,
        address: profileResult.address,
        phone: profileResult.phone,
        website: profileResult.website,
        raw: profileResult.raw,
      },
    });

    // The profile call already proved the credentials work, so a failure on
    // one review platform here is a data-level issue (not found, rate
    // limited) — logged and skipped, never allowed to void the other two.
    const reviews: ReviewDto[] = [];
    for (const platform of ['google', 'trustpilot', 'yelp'] as const satisfies readonly ReviewPlatform[]) {
      try {
        const r = await this.dataforseo.fetchReviews(platform, businessName, locationName);
        const row = await this.prisma.presenceReview.create({
          data: {
            projectId,
            platform: r.platform,
            rating: r.rating,
            reviewCount: r.reviewCount,
            url: r.url,
            raw: r.raw,
          },
        });
        reviews.push(this.toReviewDto(row));
      } catch (err) {
        this.logger.warn(`Business review pull failed for ${platform} on ${projectId}: ${(err as Error).message}`);
      }
    }

    return { profile: this.toProfileDto(profileRow), reviews };
  }

  // ─── External presence: Apify social activity (wave-6 D7) ───────────────

  /**
   * Run the Apify enrichment for this project's linked accounts.
   *
   * **Spends real Apify account credit.** `confirmSpend` must be `true` —
   * checked here, first, before the project is even looked up — so a caller
   * who does not pass it triggers nothing at all, the same contract
   * `discover()`'s `searchWeb` flag keeps for the Google sweep.
   *
   * @throws BadRequestException when `confirmSpend` is not `true`.
   * @throws NotFoundException when the project does not exist.
   * @throws ServiceUnavailableException (via {@link PresenceApifyService})
   *   when `APIFY_API_KEY` is not configured.
   */
  async socialActivity(
    projectId: string,
    opts: { confirmSpend: boolean; platforms?: ApifyPlatform[]; postsPerPlatform?: number },
  ): Promise<SocialActivityRunDto> {
    if (opts.confirmSpend !== true) {
      throw new BadRequestException(
        'Social-activity pulls run real Apify actors and spend real account credit. Pass confirmSpend: true to ' +
          'run this — nothing was run and nothing was spent.',
      );
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const platforms = opts.platforms?.length ? opts.platforms : this.apify.defaultPlatforms();
    const postsPerPlatform =
      opts.postsPerPlatform ?? Number(this.config.get<string>('APIFY_POSTS_PER_PLATFORM', '20'));

    // Enrich the accounts this module already defines (digital-presence.md's
    // own framing) — never a fresh guess at a handle.
    //
    // Brand-voice Quality Rule #1 (discoverability-pipeline-plan.md): only
    // scrape channels that cleared identity verification. `state: 'confirmed'`
    // is the only verified state — `unverified` and `needs-confirmation` are
    // NOT (and `candidate` never was). Scraping an unverified account risks
    // building a "brand voice" from a different company's posts, so this is a
    // data-integrity gate, not a convenience filter. The account states here
    // are `candidate | unverified | needs-confirmation | confirmed`.
    const presencePlatforms = platforms.map((p) => APIFY_TO_PRESENCE_PLATFORM[p]);
    const accounts = await this.prisma.presenceAccount.findMany({
      where: { projectId, platform: { in: presencePlatforms }, state: 'confirmed', entity: { not: 'personal' } },
    });
    const accountByPlatform = new Map(accounts.map((a) => [a.platform, a]));

    const targets: ApifyTarget[] = platforms.map((p) => {
      const account = accountByPlatform.get(APIFY_TO_PRESENCE_PLATFORM[p]);
      return { platform: p, url: account?.url ?? null, handle: account?.handle ?? null };
    });

    // Fails closed with a typed 503 when APIFY_API_KEY is absent — thrown
    // from inside `run()`, after the spend confirmation above, never before it.
    const outcome = await this.apify.run(targets, postsPerPlatform);

    const pulled: SocialPostDto[] = [];
    const errors: SocialActivityRunDto['errors'] = [];
    for (const roleResult of outcome.results) {
      if (roleResult.error) {
        errors.push({ platform: roleResult.platform, role: roleResult.role, error: roleResult.error });
        continue;
      }
      const account = accountByPlatform.get(APIFY_TO_PRESENCE_PLATFORM[roleResult.platform]);
      for (const item of roleResult.items) {
        const row = await this.prisma.presencePost.create({
          data: {
            projectId,
            accountId: account?.id ?? null,
            platform: item.platform,
            kind: item.kind,
            postedAt: item.postedAt ? new Date(item.postedAt) : null,
            url: item.url,
            caption: item.caption,
            likeCount: item.likeCount,
            commentCount: item.commentCount,
            shareCount: item.shareCount,
            viewCount: item.viewCount,
            followerCount: item.followerCount,
            followingCount: item.followingCount,
            postCount: item.postCount,
            actorId: item.actorId,
            raw: item.raw,
          },
        });
        pulled.push(this.toSocialPostDto(row));
      }
    }

    return {
      requested: platforms,
      skipped: outcome.skipped,
      pulled,
      totalCostUsd: outcome.totalCostUsd,
      errors,
    };
  }

  // ─── The inventory ──────────────────────────────────────────────────────

  /**
   * The client's own words about what they do. `SiteContext.category` is the
   * richer one (synthesised from their site); the project column is the
   * operator's, used when no context has been built yet. Shared by the
   * inventory and by the SERP-targeting applicability lookup so both read the
   * same category.
   */
  private async currentCategory(projectId: string, projectCategory: string | null): Promise<string | null> {
    const ctx = await this.prisma.siteContext.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { category: true },
    });
    return ctx?.category ?? projectCategory ?? null;
  }

  /**
   * Public form of {@link currentCategory} for callers outside this service
   * (the applicability GET route) that need the same category resolution
   * without duplicating the SiteContext-then-Project fallback. Returns
   * `undefined` when the project itself does not exist, distinct from `null`
   * (project exists, no category recorded either way).
   */
  async getProjectCategory(projectId: string): Promise<string | null | undefined> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return undefined;
    return this.currentCategory(projectId, project.category);
  }

  /**
   * The client-portal projection of the inventory — P05 §11.1's screen, minus
   * everything §4.6 says a client must not see: no raw candidate confidence
   * score, no discovery-run ids, no internal `foundOn` query strings, no
   * `serpCostUsd`/spend detail. A "candidate" reads as "Recommended profile"
   * with its plain-English match evidence, never an unexplained percentage —
   * §11.4's own rule against exposing a precise score to clients.
   */
  async portalInventory(projectId: string): Promise<{
    projectId: string;
    domain: string;
    accounts: Array<{
      platform: PresencePlatform;
      label: string;
      group: PresenceGroup;
      url: string;
      state: 'confirmed' | 'needs-confirmation' | 'unverified';
      statusLabel: string;
    }>;
    relevantNotFound: Array<{ platform: PresencePlatform; label: string; group: PresenceGroup }>;
    counts: { total: number; needsConfirmation: number };
  }> {
    const full = await this.inventory(projectId);
    const accounts = full.accounts
      .filter((a) => a.entity !== 'personal')
      .map((a) => {
        const state: 'confirmed' | 'needs-confirmation' | 'unverified' =
          a.state === 'candidate' ? 'needs-confirmation' : a.state === 'confirmed' ? 'confirmed' : 'unverified';
        const statusLabel =
          a.state === 'candidate'
            ? 'Recommended profile — needs confirmation'
            : a.state === 'confirmed'
              ? 'Confirmed account'
              : a.state === 'unverified'
                ? 'Found; not fully checked'
                : 'Not checked yet';
        return { platform: a.platform, label: a.label, group: a.group, url: a.url, state, statusLabel };
      });

    return {
      projectId: full.projectId,
      domain: full.domain,
      accounts,
      relevantNotFound: full.gaps.map((g) => ({ platform: g.platform, label: g.label, group: g.group })),
      counts: {
        total: accounts.filter((a) => a.state === 'confirmed').length,
        needsConfirmation: accounts.filter((a) => a.state === 'needs-confirmation').length,
      },
    };
  }

  /**
   * "Not ours" — P05 §11.4. Records the tombstone and removes the live
   * candidate row; a personal/manual/confirmed row cannot be rejected this
   * way (use DELETE for those — rejection is specifically the candidate
   * validation action, not general account removal).
   */
  async rejectCandidate(
    projectId: string,
    accountId: string,
    reason: string,
    actorEmail: string | null,
  ): Promise<{ rejectionId: string }> {
    const row = await this.prisma.presenceAccount.findUnique({ where: { id: accountId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Account not found');
    if (row.state !== 'candidate') {
      throw new BadRequestException('Only a search candidate can be rejected as "Not ours".');
    }
    const tombstone = await this.rejections.reject(
      projectId,
      row.platform as PresencePlatform,
      row.url,
      reason,
      actorEmail,
    );
    await this.prisma.presenceAccount.delete({ where: { id: accountId } });
    return { rejectionId: tombstone.id };
  }

  /**
   * Everything known about where this client exists online.
   *
   * @param projectId Project to report on.
   * @returns Accounts, gaps, the wider footprint, and the last discovery run.
   */
  async inventory(projectId: string): Promise<PresenceInventory> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');

    const category = await this.currentCategory(projectId, project.category);

    const [rows, lastRun, latestProfileRow, reviewRows, postRows] = await Promise.all([
      this.prisma.presenceAccount.findMany({
        where: { projectId },
        orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.presenceDiscovery.findFirst({
        where: { projectId },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.presenceProfile.findFirst({
        where: { projectId },
        orderBy: { fetchedAt: 'desc' },
      }),
      this.prisma.presenceReview.findMany({
        where: { projectId },
        orderBy: { fetchedAt: 'desc' },
      }),
      this.prisma.presencePost.findMany({
        where: { projectId },
        orderBy: { fetchedAt: 'desc' },
      }),
    ]);

    // Latest snapshot per platform only — a project accumulates review
    // history over time (wave-6 D2), but the inventory reports "now".
    const latestReviewByPlatform = new Map<string, (typeof reviewRows)[number]>();
    for (const r of reviewRows) if (!latestReviewByPlatform.has(r.platform)) latestReviewByPlatform.set(r.platform, r);
    const reviews = [...latestReviewByPlatform.values()].map((r) => this.toReviewDto(r));

    const socialActivity = this.summarizeSocialActivity(postRows);

    const brand = project.clientName ?? project.name ?? null;
    const accounts = rows.map((r) => this.toAccountDto(r, brand));
    // Two exclusions, for two different reasons:
    //  - a candidate is a search guess, not an account, and must not satisfy a
    //    gap or the operator stops being asked the question that resolves it;
    //  - a personal profile is a founder's, not the company's. This audit is
    //    about the company, and counting a founder's Google Scholar page as
    //    corporate reach answers a question nobody asked.
    const real = accounts.filter((a) => a.state !== 'candidate' && a.entity !== 'personal');
    const personal = accounts.filter((a) => a.state !== 'candidate' && a.entity === 'personal');
    const havePlatforms = new Set(real.map((a) => a.platform));

    // What counts as a gap depends on what the business is: a consultancy with no
    // TikTok is not a finding, one with no Clutch profile is. Deriving the
    // expected set per client is what makes directories, reviews and marketplaces
    // visible at all — a flat social-only list left four of stage 2's five
    // categories permanently reading "not checked".
    const profile = inferBusinessProfile(category);
    // P05 §11.2 — the applicability policy is THE expected set from here on,
    // not a second opinion layered on top of EXPECTED_BY_PROFILE (which the
    // policy itself uses as its base signal). Only `relevant` platforms can
    // produce a gap; `not-relevant` never does, and `optional` /
    // `needs-confirmation` stay visible without counting as a finding —
    // "a relevant but missing platform stays visible; absence must not itself
    // make a platform irrelevant" and the reverse: irrelevance must never cost
    // a finding either.
    const applicabilityList = await this.applicability.forProject(projectId, category);
    const expected = applicabilityList.filter((a) => a.status === 'relevant').map((a) => a.platform);
    const gaps: PresenceGap[] = expected
      .filter((p) => !havePlatforms.has(p))
      .map((p) => ({ platform: p, label: PLATFORM_LABELS[p], group: PLATFORM_GROUP[p] }));

    const counts = {
      total: real.length,
      confirmed: real.filter((a) => a.state === 'confirmed').length,
      unverified: real.filter((a) => a.state === 'unverified').length,
      social: real.filter((a) => a.group === 'social').length,
      listing: real.filter((a) => ['directory', 'review', 'marketplace'].includes(a.group)).length,
      manual: real.filter((a) => a.source === 'manual').length,
      candidates: accounts.filter((a) => a.state === 'candidate').length,
      personal: personal.length,
    };

    return {
      projectId,
      domain: project.domain,
      accounts,
      counts,
      gaps,
      footprint: await this.footprint(projectId, project.domain, project.competitors),
      assessment: this.assess(
        real,
        personal,
        gaps,
        lastRun,
        profile,
        category,
        expected,
        latestProfileRow !== null,
        reviews.length > 0,
        postRows.length > 0,
      ),
      lastRun: lastRun ? this.toRunDto(lastRun) : null,
      businessProfile: latestProfileRow ? this.toProfileDto(latestProfileRow) : null,
      reviews,
      socialActivity,
      applicability: applicabilityList,
    };
  }

  /**
   * Per-platform posting cadence + reach from stored `PresencePost` rows.
   * Pure aggregation — nothing here calls Apify; it only reads what a prior
   * `socialActivity()` run already stored.
   */
  private summarizeSocialActivity(
    posts: Array<{
      platform: string;
      kind: string;
      postedAt: Date | null;
      likeCount: number | null;
      commentCount: number | null;
      shareCount: number | null;
      followerCount: number | null;
    }>,
  ): SocialActivitySummary[] {
    const byPlatform = new Map<string, typeof posts>();
    for (const p of posts) {
      const list = byPlatform.get(p.platform) ?? [];
      list.push(p);
      byPlatform.set(p.platform, list);
    }

    return [...byPlatform.entries()].map(([platform, rows]) => {
      const profileRow = rows.find((r) => r.kind === 'profile' && r.followerCount !== null);
      const postRows = rows.filter((r) => r.kind === 'post');
      const engagements = postRows.map(
        (r) => (r.likeCount ?? 0) + (r.commentCount ?? 0) + (r.shareCount ?? 0),
      );
      const avgEngagement =
        engagements.length > 0 ? engagements.reduce((a, b) => a + b, 0) / engagements.length : null;
      const lastPostAt = postRows.find((r) => r.postedAt)?.postedAt ?? null; // rows are pre-sorted newest-first

      return {
        platform,
        followerCount: profileRow?.followerCount ?? null,
        postsSampled: postRows.length,
        lastPostAt: lastPostAt ? lastPostAt.toISOString() : null,
        avgEngagement,
      };
    });
  }

  /**
   * Stage 2's *analyse* column: the read on the company's current state online.
   *
   * Facts and absences only — every number is counted, none estimated, and no
   * score is produced. The one thing this must never do is let an unmeasured
   * category read as an empty one, so {@link PresenceAssessment.notMeasured}
   * names what the module cannot yet see. An audit that lists six findings while
   * hiding that it never looked at reviews is worse than one that lists five and
   * says so.
   *
   * @param real Company profiles (candidates and personal rows already removed).
   * @param personal A founder's own profiles — reported, never counted as reach.
   * @param gaps Expected platforms with nothing found.
   * @param lastRun Newest discovery run, for what was and was not searched.
   * @param hasBusinessProfile Whether a DataForSEO business-profile pull is on file.
   * @param hasReviews Whether at least one review-platform snapshot is on file.
   * @param hasSocialActivity Whether at least one Apify social-activity row is on file.
   */
  private assess(
    real: PresenceAccountDto[],
    personal: PresenceAccountDto[],
    gaps: PresenceGap[],
    lastRun: { serpQueries: number; serpSkipped: string | null } | null,
    profile: BusinessProfile,
    category: string | null,
    expectedSet: readonly PresencePlatform[],
    hasBusinessProfile: boolean,
    hasReviews: boolean,
    hasSocialActivity: boolean,
  ): PresenceAssessment {
    const CATEGORIES: PresenceGroup[] = ['social', 'directory', 'review', 'marketplace', 'publishing'];

    const coverage: CategoryCoverage[] = CATEGORIES.map((group) => {
      const held = real.filter((a) => a.group === group);
      const missing = gaps.filter((g) => g.group === group).map((g) => g.label);
      const expected = expectedSet.filter((p) => PLATFORM_GROUP[p] === group);

      let state: CoverageState;
      let note: string;

      if (expected.length === 0 && held.length === 0) {
        // Nothing expected and nothing found. Saying "absent" here would invent
        // a gap out of a category this client was never measured against.
        state = 'not-checked';
        note = 'Not part of the expected set for this client, and nothing was found.';
      } else if (held.length === 0) {
        state = 'absent';
        note =
          missing.length > 0
            ? `No presence found. ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} nothing linked from the site.`
            : 'No presence found in this category.';
      } else if (missing.length > 0) {
        state = 'partial';
        note = `${held.length} found; ${missing.join(', ')} still missing.`;
      } else {
        state = 'covered';
        note = `${held.length} profile${held.length === 1 ? '' : 's'} found.`;
      }

      return { group, label: GROUP_LABELS[group], state, held: held.length, missing, note };
    });

    // Worst first: an operator reads the top of this list and should meet the
    // biggest hole, not the best-covered category.
    const headlines: string[] = [];
    const verified = real.filter((a) => a.state === 'confirmed').length;
    const unverifiable = real.filter((a) => a.state === 'unverified').length;

    headlines.push(
      real.length === 0
        ? 'No company profiles found on any external platform.'
        : `${real.length} company profile${real.length === 1 ? '' : 's'} found across ` +
          `${new Set(real.map((a) => a.group)).size} categor${new Set(real.map((a) => a.group)).size === 1 ? 'y' : 'ies'}.`,
    );

    const absent = coverage.filter((c) => c.state === 'absent');
    for (const c of absent) headlines.push(`${c.label}: none found.`);

    const partial = coverage.filter((c) => c.state === 'partial');
    for (const c of partial) headlines.push(`${c.label}: ${c.missing.join(', ')} missing.`);

    if (unverifiable > 0) {
      headlines.push(
        `${unverifiable} profile${unverifiable === 1 ? '' : 's'} could not be verified from here — ` +
          'those platforms refuse logged-out requests. Found, not missing.',
      );
    }
    if (verified > 0) headlines.push(`${verified} verified as live.`);

    if (personal.length > 0) {
      headlines.push(
        `${personal.length} personal profile${personal.length === 1 ? '' : 's'} (a founder's, not the ` +
          "company's) recorded separately and excluded from the counts above.",
      );
    }

    if (hasBusinessProfile) headlines.push('Business profile pulled from Google Business Data.');
    if (hasReviews) headlines.push('Review ratings pulled from Business Data.');
    if (hasSocialActivity) headlines.push('Social activity pulled via the Apify enrichment.');

    // What this module cannot yet reflect in the numbers above — three-valued
    // the same way PresenceState is, so "no code for this" (not-built),
    // "built but this environment has no credentials" (not-configured) and
    // "credentials fine, nobody has pulled it for THIS project" (not-run)
    // are never collapsed into one blanket "unmeasured". An item is removed
    // from this list the moment all three are satisfied — see the callers of
    // `hasBusinessProfile` / `hasReviews` / `hasSocialActivity` above.
    const notMeasured: CapabilityNote[] = [];

    if (!this.dataforseo.enabled) {
      notMeasured.push({
        label: 'Review ratings & business profile',
        state: 'not-configured',
        note:
          'DataForSEO Business Data adapter is built, but SWARM_ALLOW_LIVE / DATAFORSEO_LOGIN / ' +
          'DATAFORSEO_PASSWORD are not configured in this environment.',
      });
    } else if (!hasReviews || !hasBusinessProfile) {
      notMeasured.push({
        label: 'Review ratings & business profile',
        state: 'not-run',
        note: 'DataForSEO is configured, but has not been pulled for this project yet — POST .../presence/business-profile.',
      });
    }

    if (!this.apify.enabled) {
      notMeasured.push({
        label: 'Social activity',
        state: 'not-configured',
        note: 'Apify adapter is built, but APIFY_API_KEY is not configured in this environment.',
      });
    } else if (!hasSocialActivity) {
      notMeasured.push({
        label: 'Social activity',
        state: 'not-run',
        note:
          'Apify is configured, but no social-activity run has been requested for this project yet — ' +
          'POST .../presence/social-activity with confirmSpend: true. It spends real Apify account credit, ' +
          'so it never runs automatically.',
      });
    }

    notMeasured.push({
      label: 'Directory completeness',
      state: 'not-built',
      note: 'Whether a listing is filled in, not just that it exists.',
    });

    if (!lastRun || lastRun.serpQueries === 0) {
      notMeasured.push({
        label: 'Unlinked accounts',
        state: this.serp.enabled ? 'not-run' : 'not-configured',
        note:
          'Only profiles linked from the site were looked at' +
          (lastRun?.serpSkipped ? ` (${lastRun.serpSkipped})` : ''),
      });
    }

    if (profile === 'default') {
      notMeasured.push({
        label: 'Business type',
        state: 'not-run',
        note:
          'No category recorded, so the expected platforms are a generic social set rather than the ones ' +
          'this industry is judged on.',
      });
    }

    return {
      businessProfile: profile,
      businessProfileLabel: PROFILE_LABELS[profile],
      inferredFrom: category,
      headlines,
      coverage,
      notMeasured,
    };
  }

  /**
   * The rest of the footprint, read from the modules that own each fact.
   *
   * Every item names its source module so a number in the UI can always be
   * traced back to the thing that produced it.
   */
  private async footprint(
    projectId: string,
    domain: string,
    competitorsJson: string | null,
  ): Promise<FootprintSection[]> {
    const [context, tech, google, aeoAudits, seo] = await Promise.all([
      this.prisma.siteContext.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.technicalAudit.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.googleProjectResource.findMany({ where: { projectId } }),
      this.prisma.aeoAudit.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      }),
      this.prisma.seoAudit.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    ]);

    const competitors = parseArray(competitorsJson).length || parseArray(context?.competitors).length;

    const identity: FootprintItem[] = [
      item('Brand', context?.brand ?? null, 'aeo-audit'),
      item('Category', context?.category ?? null, 'aeo-audit'),
      item('Primary market', context?.geo ?? null, 'aeo-audit'),
      countItem('Services', parseArray(context?.services).length, 'aeo-audit', context !== null),
      countItem('ICP segments', parseArray(context?.icp).length, 'aeo-audit', context !== null),
    ];

    const owned: FootprintItem[] = [
      item('Domain', domain, 'projects'),
      countItem('Pages crawled (context)', context?.pagesFetched ?? 0, 'aeo-audit', context !== null),
      countItem('Pages crawled (technical)', tech?.pagesCrawled ?? 0, 'technical-audit', tech !== null),
      item('Sitemap', tech?.sitemapUrl ?? null, 'technical-audit'),
    ];

    const connected: FootprintItem[] = [
      {
        label: 'Google Search Console',
        ...presence(google.some((g) => g.service === 'search-console')),
        source: 'google',
      },
      {
        label: 'Google Analytics',
        ...presence(google.some((g) => g.service === 'analytics')),
        source: 'google',
      },
      seo
        ? { label: 'SEO audit', state: 'found' as const, detail: 'run', source: 'seo-audit' }
        : { label: 'SEO audit', state: 'not-checked' as const, detail: null, source: 'seo-audit' },
    ];

    const audit = aeoAudits[0];
    const answerEngines: FootprintItem[] = [
      audit
        ? {
            label: 'Answer-engine audit',
            state: 'found' as const,
            detail: `${audit.status}${audit.observations ? ` · ${audit.observations} observations` : ''}`,
            source: 'aeo-audit',
          }
        : { label: 'Answer-engine audit', state: 'not-checked' as const, detail: null, source: 'aeo-audit' },
      audit
        ? {
            label: 'Engines measured',
            state: 'found' as const,
            detail: parseArray(audit.surfaces).join(', ') || audit.surface,
            source: 'aeo-audit',
          }
        : { label: 'Engines measured', state: 'not-checked' as const, detail: null, source: 'aeo-audit' },
    ];

    return [
      { key: 'identity', label: 'Identity', items: identity },
      { key: 'owned', label: 'Owned properties', items: owned },
      { key: 'connected', label: 'Connected data', items: connected },
      { key: 'answer-engines', label: 'Answer engines', items: answerEngines },
      {
        key: 'competitors',
        label: 'Competitors',
        items: [countItem('Named competitors', competitors, 'intake / aeo-audit', true)],
      },
    ];
  }

  // ─── Mapping ────────────────────────────────────────────────────────────

  private toAccountDto(row: {
    id: string;
    platform: string;
    url: string;
    handle: string | null;
    source: string;
    entity: string;
    state: string;
    reason: string | null;
    statusCode: number | null;
    title: string | null;
    foundOn: string | null;
    verifiedAt: Date | null;
    confidence: number | null;
  }, brand?: string | null): PresenceAccountDto {
    const platform = row.platform as PresencePlatform;
    const source = row.source as PresenceSource;
    return {
      id: row.id,
      platform,
      label: PLATFORM_LABELS[platform] ?? row.platform,
      group: PLATFORM_GROUP[platform] ?? 'social',
      url: row.url,
      handle: row.handle,
      source,
      sourceLabel: SOURCE_LABELS[source] ?? row.source,
      entity: (row.entity as PresenceEntity) ?? 'company',
      state: row.state as PresenceState,
      reason: row.reason,
      statusCode: row.statusCode,
      title: row.title,
      foundOn: row.foundOn,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      confidence: row.confidence,
      // A fetched page title, compared by `entity-audit`'s containment rule --
      // platforms pad titles ("Acme Ltd | LinkedIn"), so equality would mark
      // every real profile a mismatch. No title (walled platform, never
      // fetched) stays `not-checked` rather than defaulting to a verdict.
      nameConsistency:
        row.title && brand ? (titleIdentifies(row.title, brand) ? 'match' : 'mismatch') : 'not-checked',
    };
  }

  private toRunDto(row: {
    id: string;
    status: string;
    pagesFetched: number;
    found: number;
    confirmed: number;
    unverified: number;
    candidates: number;
    serpQueries: number;
    serpCostUsd: number;
    serpSkipped: string | null;
    sources: string | null;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }): DiscoveryRunDto {
    let sources: Record<string, number> = {};
    if (row.sources) {
      try {
        sources = JSON.parse(row.sources) as Record<string, number>;
      } catch {
        sources = {};
      }
    }
    return {
      id: row.id,
      status: row.status as DiscoveryRunDto['status'],
      pagesFetched: row.pagesFetched,
      found: row.found,
      confirmed: row.confirmed,
      unverified: row.unverified,
      candidates: row.candidates,
      serpQueries: row.serpQueries,
      serpCostUsd: row.serpCostUsd,
      serpSkipped: row.serpSkipped,
      sources,
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }

  private toProfileDto(row: {
    id: string;
    source: string;
    name: string | null;
    categories: string | null;
    hours: string | null;
    rating: number | null;
    reviewCount: number | null;
    address: string | null;
    phone: string | null;
    website: string | null;
    fetchedAt: Date;
  }): BusinessProfileDto {
    return {
      id: row.id,
      source: row.source,
      name: row.name,
      categories: parseArray(row.categories) as string[],
      hours: row.hours ? safeJsonParse(row.hours) : null,
      rating: row.rating,
      reviewCount: row.reviewCount,
      address: row.address,
      phone: row.phone,
      website: row.website,
      fetchedAt: row.fetchedAt.toISOString(),
    };
  }

  private toReviewDto(row: {
    id: string;
    platform: string;
    rating: number | null;
    reviewCount: number | null;
    url: string | null;
    source: string;
    fetchedAt: Date;
  }): ReviewDto {
    return {
      id: row.id,
      platform: row.platform,
      rating: row.rating,
      reviewCount: row.reviewCount,
      url: row.url,
      source: row.source,
      fetchedAt: row.fetchedAt.toISOString(),
    };
  }

  private toSocialPostDto(row: {
    id: string;
    platform: string;
    kind: string;
    postedAt: Date | null;
    url: string | null;
    caption: string | null;
    likeCount: number | null;
    commentCount: number | null;
    shareCount: number | null;
    viewCount: number | null;
    followerCount: number | null;
    followingCount: number | null;
    postCount: number | null;
    fetchedAt: Date;
  }): SocialPostDto {
    return {
      id: row.id,
      platform: row.platform,
      kind: row.kind === 'profile' ? 'profile' : 'post',
      postedAt: row.postedAt ? row.postedAt.toISOString() : null,
      url: row.url,
      caption: row.caption,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      shareCount: row.shareCount,
      viewCount: row.viewCount,
      followerCount: row.followerCount,
      followingCount: row.followingCount,
      postCount: row.postCount,
      fetchedAt: row.fetchedAt.toISOString(),
    };
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────

/** A JSON array column, parsed defensively. */
function parseArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A JSON column of unknown shape (e.g. the provider's own opening-hours structure). */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A value that is either present or has never been looked for. */
function item(label: string, value: string | null, source: string): FootprintItem {
  return {
    label,
    state: value ? 'found' : 'not-checked',
    detail: value,
    source,
  };
}

/**
 * A count. `checked` separates "the module ran and found none" from "the module
 * never ran" — the same distinction the whole inventory turns on.
 */
function countItem(label: string, n: number, source: string, checked: boolean): FootprintItem {
  if (!checked) return { label, state: 'not-checked', detail: null, source };
  return { label, state: n > 0 ? 'found' : 'none', detail: n > 0 ? String(n) : null, source };
}

/** A binary connection state. */
function presence(connected: boolean): { state: FootprintItem['state']; detail: string | null } {
  return connected ? { state: 'found', detail: 'connected' } : { state: 'none', detail: 'not connected' };
}
