/**
 * Digital Presence Controller — where the client exists online.
 *
 * Routes (all under `/api/projects/:projectId/presence`):
 *   GET    /                      the full inventory: accounts, gaps, footprint
 *   POST   /discover              crawl the client's site for profile links
 *   GET    /discoveries           discovery run history
 *   POST   /accounts              operator adds an account by URL
 *   POST   /accounts/:id/confirm   accept a search-suggested candidate
 *   PATCH  /accounts/:accountId   correct one
 *   DELETE /accounts/:accountId   remove one
 *   POST   /business-profile      DataForSEO Business Data pull (wave-6 D2)
 *   POST   /social-activity       Apify social-activity pull, opt-in only (wave-6 D7)
 *
 * @module presence.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AddAccountDto,
  BusinessProfileDto,
  DiscoverDto,
  ReconsiderRejectionDto,
  RejectCandidateDto,
  RunHistoryQueryDto,
  SetApplicabilityDto,
  SocialActivityDto,
} from './dto/presence.dto';
import { PresenceService } from './presence.service';
import { PresenceApplicabilityService } from './presence.applicability.service';
import { PresenceBrandVoiceService } from './presence.brand-voice.service';
import { PresenceDirectoryRatingService } from './presence.directory-rating.service';
import { PresenceRejectionService } from './presence.rejection.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import type { PresencePlatform } from './presence.types';

@ApiTags('Digital Presence')
@ApiBearerAuth()
@Controller('projects/:projectId/presence')
export class PresenceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly brandVoice: PresenceBrandVoiceService,
    private readonly directoryRating: PresenceDirectoryRatingService,
    private readonly applicability: PresenceApplicabilityService,
    private readonly rejections: PresenceRejectionService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The client\'s digital footprint',
    description:
      'Every account found or supplied, the expected platforms with no account, and what every other ' +
      'module has discovered (identity, owned properties, connected data, answer engines, competitors). ' +
      'Each line names the module that produced it. States are three-valued throughout: a profile linked ' +
      "from the client's own site that a platform refused to serve is `unverified`, never `missing`.",
  })
  @ApiResponse({ status: 200, description: 'The inventory' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async inventory(@Param('projectId') projectId: string) {
    return this.presence.inventory(projectId);
  }

  @Post('discover')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Discover accounts from the site',
    description:
      "Reads the client's homepage and contact/about pages, pulls profile URLs from JSON-LD `sameAs` " +
      'and from on-page links, and verifies what can be verified. Share widgets and intent links are ' +
      'rejected by the signature table rather than reported as accounts. Free by default — ' +
      "it is the fetcher against the client's own site. Pass `searchWeb: true` to also sweep Google " +
      'for unlinked accounts, which costs one credit per platform and returns candidates, not accounts.',
  })
  @ApiBody({ type: DiscoverDto, required: false })
  @ApiResponse({ status: 201, description: 'Discovery run completed (or failed, with its reason)' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async discover(@Param('projectId') projectId: string, @Body() body: DiscoverDto = {}) {
    return this.presence.discover(projectId, body.searchWeb === true);
  }

  @Get('discoveries')
  @ApiOperation({ summary: 'Discovery run history (newest first)' })
  @ApiResponse({ status: 200, description: 'Runs' })
  async runs(@Param('projectId') projectId: string, @Query() query: RunHistoryQueryDto) {
    return this.presence.listRuns(projectId, query.limit ?? 10);
  }

  @Get('discoveries/:runId')
  @ApiOperation({ summary: 'One discovery run by id — poll this for status while it runs' })
  @ApiResponse({ status: 200, description: 'The run' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async run(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.presence.getRun(projectId, runId);
  }

  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add an account by URL',
    description:
      'For the case discovery cannot cover: an account that exists but is not linked from the site. ' +
      'Operator entry outranks the crawler and is never overwritten by a later discovery run.',
  })
  @ApiBody({ type: AddAccountDto })
  @ApiResponse({ status: 201, description: 'Account stored' })
  @ApiResponse({ status: 400, description: 'Not a recognised profile URL' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async addAccount(@Param('projectId') projectId: string, @Body() body: AddAccountDto) {
    return this.presence.addAccount(projectId, body.url);
  }

  @Post('accounts/:accountId/confirm')
  @ApiOperation({
    summary: 'Confirm a search candidate',
    description:
      "Accepts a SERP-suggested profile as a real account. Search cannot tell the client's account " +
      "from a similarly named stranger's — a live `site:instagram.com \"HubSpot\"` returns three real " +
      'HubSpot accounts and one unrelated podcast — so this human yes/no is the only thing that ' +
      'promotes a candidate. Confirmed rows become operator-supplied and survive re-runs.',
  })
  @ApiResponse({ status: 201, description: 'Candidate promoted to an account' })
  @ApiResponse({ status: 400, description: 'Row is not a candidate' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async confirmCandidate(
    @Param('projectId') projectId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.presence.confirmCandidate(projectId, accountId);
  }

  @Patch('accounts/:accountId')
  @ApiOperation({ summary: 'Correct an account URL' })
  @ApiBody({ type: AddAccountDto })
  @ApiResponse({ status: 200, description: 'Account updated' })
  @ApiResponse({ status: 400, description: 'Not a recognised profile URL' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async updateAccount(
    @Param('projectId') projectId: string,
    @Param('accountId') accountId: string,
    @Body() body: AddAccountDto,
  ) {
    return this.presence.updateAccount(projectId, accountId, body.url);
  }

  @Delete('accounts/:accountId')
  @ApiOperation({ summary: 'Remove an account' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async removeAccount(@Param('projectId') projectId: string, @Param('accountId') accountId: string) {
    return this.presence.removeAccount(projectId, accountId);
  }

  @Post('business-profile')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Pull the Google Business Profile + review ratings (wave-6 D2)',
    description:
      'DataForSEO Business Data → Google My Business Info, plus Google/Trustpilot/Yelp review counts. Rating ' +
      'and review count only — no sentiment is invented over review text. Each pull is a new snapshot, never an ' +
      'upsert, since a business profile drifts over time. Requires SWARM_ALLOW_LIVE=1 and DATAFORSEO_LOGIN/' +
      'DATAFORSEO_PASSWORD; without them this returns a 503 naming exactly what is missing rather than an empty profile.',
  })
  @ApiBody({ type: BusinessProfileDto, required: false })
  @ApiResponse({ status: 201, description: 'Profile + review snapshots stored' })
  @ApiResponse({ status: 400, description: 'No business name to search for' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'DataForSEO not configured (SWARM_ALLOW_LIVE / DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)' })
  async businessProfile(@Param('projectId') projectId: string, @Body() body: BusinessProfileDto = {}) {
    return this.presence.pullBusinessProfile(projectId, {
      businessName: body.businessName,
      locationName: body.locationName,
    });
  }

  @Post('social-activity')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 2 } })
  @ApiOperation({
    summary: 'Pull social activity via Apify (wave-6 D7) — spends real account credit, opt-in only',
    description:
      'Runs Apify actors against this project\'s linked accounts for posting cadence, followers and engagement. ' +
      '**Spends real Apify account credit** (the FREE plan\'s $5/month usage cap) — `confirmSpend: true` is ' +
      'required on every call, mirroring the opt-in `searchWeb` flag on /discover: there is no default or ' +
      'automatic path that reaches this. Actor output schemas differ wildly across platforms and are normalised ' +
      'into one shape before storage. Requires APIFY_API_KEY; without it this returns a 503.',
  })
  @ApiBody({ type: SocialActivityDto })
  @ApiResponse({ status: 201, description: 'Social-activity rows pulled and stored (or skipped, per platform)' })
  @ApiResponse({ status: 400, description: 'confirmSpend was not true — nothing was run' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'APIFY_API_KEY not configured' })
  async socialActivity(@Param('projectId') projectId: string, @Body() body: SocialActivityDto) {
    return this.presence.socialActivity(projectId, {
      confirmSpend: body.confirmSpend === true,
      platforms: body.platforms,
      postsPerPlatform: body.postsPerPlatform,
    });
  }

  @Post('brand-voice')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Synthesize the brand voice from stored Apify captions',
    description:
      'Reads the captions already stored on PresencePost (from a prior /social-activity pull) and, with an ' +
      'LLM provider configured and at least 3 captions on file, extracts tone, recurring themes, vocabulary and ' +
      'call-to-action patterns — grounded entirely in the real captions, never invented. With too few captions ' +
      'or no LLM configured, returns extraction: "insufficient-data" rather than a guess.',
  })
  @ApiResponse({ status: 201, description: 'Brand-voice read built and stored' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async buildBrandVoice(@Param('projectId') projectId: string) {
    return this.brandVoice.synthesize(projectId);
  }

  @Get('brand-voice')
  @ApiOperation({ summary: 'Latest stored brand-voice read' })
  @ApiResponse({ status: 200, description: 'The brand-voice read' })
  @ApiResponse({ status: 404, description: 'None built yet — POST .../presence/brand-voice first' })
  async getBrandVoice(@Param('projectId') projectId: string) {
    const result = await this.brandVoice.latest(projectId);
    if (!result) throw new NotFoundException('No brand-voice read built yet for this project — POST .../presence/brand-voice first.');
    return result;
  }

  @Post('directory-ratings')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Read published ratings for the client\'s own discovered listings',
    description:
      'For every already-discovered G2/Capterra/Trustpilot/Glassdoor/Yelp/Clutch/Crunchbase/Product Hunt account ' +
      '(candidates and personal profiles excluded), reads the AggregateRating that listing already publishes ' +
      'about itself — no vendor, no per-lookup cost. Stored as PresenceReview rows tagged source: "schema-scrape", ' +
      'alongside any DataForSEO-sourced rows from /business-profile. A listing that loads but declares no rating ' +
      'writes nothing; that is a fact about the listing, not a failure of this call.',
  })
  @ApiResponse({ status: 201, description: 'Ratings read (zero or more found) for every ratable discovered account' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async pullDirectoryRatings(@Param('projectId') projectId: string) {
    return this.directoryRating.fetchAndStoreForProject(projectId);
  }

  // ─── Candidate validation — Confirm / Not ours / Correct link (§11.4) ────
  // Confirm = POST accounts/:id/confirm (above). Correct link = PATCH
  // accounts/:accountId (above). This is "Not ours" and its undo.

  @Post('accounts/:accountId/reject')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reject a search candidate — "Not ours"',
    description:
      'Records a tombstone (normalized URL + platform + project scope + reason + actor) and removes the ' +
      'live candidate row. A subsequent discovery/SERP sweep will not recreate this exact URL as a candidate ' +
      'again — otherwise the next search keeps recommending the same unrelated business. No permanent ' +
      'destructive deletion: the tombstone can be reconsidered via POST .../rejections/:id/reconsider.',
  })
  @ApiBody({ type: RejectCandidateDto })
  @ApiResponse({ status: 201, description: 'Tombstone recorded; candidate removed' })
  @ApiResponse({ status: 400, description: 'Row is not a candidate, or no reason given' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async rejectCandidate(
    @Param('projectId') projectId: string,
    @Param('accountId') accountId: string,
    @Body() body: RejectCandidateDto,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.presence.rejectCandidate(projectId, accountId, body.reason, user?.email ?? null);
  }

  @Get('rejections')
  @ApiOperation({ summary: 'Rejection tombstones for this project (newest first)' })
  @ApiResponse({ status: 200, description: 'Tombstones, including reconsidered ones' })
  async listRejections(@Param('projectId') projectId: string) {
    return this.rejections.list(projectId);
  }

  @Post('rejections/:rejectionId/reconsider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo a "Not ours" rejection',
    description:
      'Authorized reconsideration only — clears the tombstone\'s effect (it is kept for history, not deleted) ' +
      'so the URL can surface again on the next discovery/SERP sweep.',
  })
  @ApiBody({ type: ReconsiderRejectionDto, required: false })
  @ApiResponse({ status: 200, description: 'Rejection reconsidered' })
  @ApiResponse({ status: 404, description: 'Rejection not found' })
  async reconsiderRejection(
    @Param('projectId') projectId: string,
    @Param('rejectionId') rejectionId: string,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.rejections.reconsider(projectId, rejectionId, user?.email ?? null);
  }

  // ─── Applicability policy (§11.2) ────────────────────────────────────────

  @Get('applicability')
  @ApiOperation({
    summary: 'Applicability policy for every platform',
    description:
      'What matters for THIS client and why: relevant / optional / not-relevant / needs-confirmation, each ' +
      'with a reason and rule version. The same result GET .../presence embeds and the collector/gap-list use — ' +
      'never a second opinion computed elsewhere.',
  })
  @ApiResponse({ status: 200, description: 'Per-platform applicability' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getApplicability(@Param('projectId') projectId: string) {
    const project = await this.presence.getProjectCategory(projectId);
    if (project === undefined) throw new NotFoundException('Project not found');
    return this.applicability.forProject(projectId, project);
  }

  @Patch('applicability/:platform')
  @ApiOperation({
    summary: 'Staff/client override for one platform\'s applicability',
    description:
      'Explicit correction of the computed default (e.g. "this local listing IS relevant even though the ' +
      'business reads as online-only"). Versioned: the prior override is superseded, never mutated, and this ' +
      'one wins from now on — including after a rediscovery run, since discovery never writes to this table.',
  })
  @ApiBody({ type: SetApplicabilityDto })
  @ApiResponse({ status: 200, description: 'Override recorded' })
  async setApplicability(
    @Param('projectId') projectId: string,
    @Param('platform') platform: string,
    @Body() body: SetApplicabilityDto,
    @CurrentUser() user: AuthedRequestUser,
  ) {
    return this.applicability.setOverride(
      projectId,
      platform as PresencePlatform,
      body.status,
      body.reason,
      user?.email ?? null,
    );
  }
}

// ─── Client portal ──────────────────────────────────────────────────────

/**
 * The client's own read of their online presence — P05 §11.1 / §4.6.
 *
 * Deliberately a narrower projection than the operator's `GET .../presence`:
 * no raw candidate confidence score, no discovery-run ids, no SERP query text
 * or spend, no `foundOn` internals. A search-suggested candidate reads as
 * "Recommended profile — needs confirmation", never an unexplained percentage.
 */
@ApiTags('Digital Presence: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId/presence')
export class PresencePortalController {
  constructor(
    private readonly presence: PresenceService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "This client's online presence — confirmed/needs-confirmation/relevant-not-found only",
    description:
      'No raw discovery internals: no confidence score, no run ids, no SERP query text or cost. States are ' +
      'plain-English: "Confirmed account", "Recommended profile — needs confirmation", "Found; not fully ' +
      'checked", "Recommended profile not found".',
  })
  @ApiResponse({ status: 200, description: 'Client-safe presence projection' })
  @ApiResponse({ status: 403, description: 'Project does not belong to this client' })
  async portalInventory(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.presence.portalInventory(projectId);
  }
}
