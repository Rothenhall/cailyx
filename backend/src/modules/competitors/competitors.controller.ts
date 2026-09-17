/**
 * Competitors Controller — REST API endpoints.
 *
 *   POST   /projects/:projectId/competitors/discover
 *   GET    /projects/:projectId/competitors/profiles
 *   GET    /projects/:projectId/competitors/gap
 *   GET    /projects/:projectId/competitors/candidates
 *   POST   /projects/:projectId/competitors/candidates/:competitorId/confirm
 *   DELETE /projects/:projectId/competitors/candidates/:competitorId
 *
 * The last three exist only in source: they are absent from the checked-in
 * `openapi.json` (G19/D01), so their response schemas are declared in this
 * file rather than inherited from it. All six are operator routes under the
 * global guard; `:projectId` is resolved by each service call, never trusted
 * from the URL alone.
 *
 * `discover` does real network I/O (one homepage fetch per competitor via
 * `TechStackService.scanDomain` + one schema read), so it is rate-limited
 * like other live-fetch endpoints. `list` and `gap` are reads over already
 * stored rows (`gap` additionally does one cheap live tech/schema check
 * against the client's own domain — no vendor, same cost class as
 * tech-stack's own scan).
 *
 * @module competitors.controller
 */

import { Controller, Post, Get, Delete, Patch, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, type SchemaObject } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CompetitorsService } from './competitors.service';
import { DiscoverByMarketDto, DiscoverCompetitorsDto, SetCandidateRelevanceDto } from './dto/competitors.dto';

/**
 * The `Competitor` row as the candidate routes return it.
 *
 * Declared here (G19/D01) because these three routes exist only in source —
 * they are absent from the checked-in `openapi.json` — so this schema is the
 * only place their response contract is written down. Every field is what
 * `CompetitorsService` actually selects; `status` and `source` are the two
 * vocabularies a caller must switch on:
 *
 *   - `status`: `tracked | candidate`. Candidates are never profiled, never
 *     appear in `list`/`gap`, and are never fed back into the AEO stance
 *     prompt as a "known competitor" until confirmed.
 *   - `source`: `project-json | manual | aeo-answer`. `aeo-answer` is the only
 *     producer of candidates today; `project-json`/`manual` entries arrive
 *     already `tracked`.
 */
const COMPETITOR_ROW_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'projectId', 'name', 'source', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    projectId: { type: 'string' },
    name: { type: 'string' },
    domain: {
      type: 'string',
      nullable: true,
      description: 'Bare domain, or null when only the name is known. A candidate with no domain has nothing to profile.',
    },
    source: {
      type: 'string',
      enum: ['project-json', 'manual', 'aeo-answer'],
      description: 'project-json = promoted from Project.competitors; manual = an explicit /discover body list; aeo-answer = a company name an AI surface mentioned and nothing had recorded.',
    },
    status: {
      type: 'string',
      enum: ['tracked', 'candidate'],
      description: 'candidate = discovered, not yet trusted, awaiting operator confirm/reject.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

@ApiTags('Competitors')
@Controller('projects/:projectId/competitors')
export class CompetitorsController {
  constructor(private readonly competitors: CompetitorsService) {}

  /**
   * Promote `Project.competitors` (JSON) — merged with an optional explicit
   * list in the body — into `Competitor` rows, then build a fresh light
   * profile for each: a homepage tech-stack scan, a schema/JSON-LD read, and
   * whatever SERP/AEO presence already exists for that competitor. Rate
   * limited to 5/minute — it fans out to one crawl per competitor.
   */
  @Post('discover')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Promote competitors to rows and build a light profile for each',
    description:
      "Merges Project.competitors (JSON) with an optional explicit list, upserts Competitor rows, and profiles each one: tech-stack scan of the homepage, a schema.org/JSON-LD read, and existing SERP/AEO presence attached by reference. Never runs the full technical-audit per competitor, and never triggers a new SERP or AEO run — only attaches what already exists.",
  })
  @ApiBody({ type: DiscoverCompetitorsDto })
  @ApiResponse({ status: 201, description: 'Competitor rows with their freshly built profile' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 429, description: 'Too many discover runs — rate limited to 5/minute' })
  async discover(@Param('projectId') projectId: string, @Body() body: DiscoverCompetitorsDto) {
    return this.competitors.discover(projectId, body ?? {});
  }

  /**
   * §12.2 — service/market-based discovery. Default (collectNew omitted)
   * only mines names/domains already stored in AEO verdicts + SERP
   * snapshots — free, safe to call from a page load. `collectNew: true` also
   * composes a small bounded set of Google searches through the gated SERP
   * provider — an explicit, budgeted action, never triggered implicitly.
   * Writes new `status: "candidate"` rows only; the existing tracked list is
   * never replaced. Partner/directory/publishing-platform domains and the
   * client's own domain are excluded before a row is ever created, and a
   * previously-rejected candidate is never re-proposed.
   */
  @Post('discover/market')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Propose new competitor candidates from confirmed services/segments + target markets',
    description:
      'Mines stored AEO-verdict + SERP evidence for rival names/domains (free), and, only when collectNew=true, additionally runs a bounded set of Google searches through the gated SERP provider (paid/explicit). Excludes the client\'s own domain, known directories/publishing/social platforms, and previously-rejected candidates. Never touches the existing tracked list.',
  })
  @ApiBody({ type: DiscoverByMarketDto })
  @ApiResponse({ status: 201, description: 'Discovery summary + newly proposed candidate rows' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async discoverByMarket(@Param('projectId') projectId: string, @Body() body: DiscoverByMarketDto) {
    return this.competitors.discoverByMarket(projectId, body ?? {});
  }

  /**
   * Every competitor for the project, each with its latest profile.
   *
   * Deliberately NOT `GET /projects/:id/competitors` bare — `ProjectsController`
   * already owns that exact path (the named-competitor list + SERP-discovered
   * candidates that share-of-voice and the RivalsPanel frontend read). This
   * module is additive, so it lives one segment deeper rather than shadowing
   * or replacing an existing, frontend-consumed endpoint.
   */
  @Get('profiles')
  @ApiOperation({
    summary: 'List competitors with their latest profile',
    description:
      "Distinct from GET /projects/:id/competitors (ProjectsController's named-competitor list + SERP-discovered candidates) — this returns the first-class Competitor rows this module maintains, each with its latest tech/schema/AEO/SERP profile. Excludes status=candidate rows: an unconfirmed candidate is not yet a rival and has no profile to return.",
  })
  @ApiResponse({ status: 200, description: '{ competitors: Competitor[] } — tracked rows only, each with `latestProfile` (nullable when no profile has been built)' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async list(@Param('projectId') projectId: string) {
    return { competitors: await this.competitors.list(projectId) };
  }

  /**
   * The gap comparison: what the client's own tech-stack/schema/SERP/AEO
   * profile has versus what its competitors have. A plain diff, not a scored
   * verdict.
   */
  @Get('gap')
  @ApiOperation({
    summary: 'Compare the client against its competitors on tech, schema, and attached SERP/AEO presence',
    description:
      'A straightforward diff/comparison table — tech and schema signatures the client has that competitors lack (and vice versa), plus each competitor’s attached SERP/AEO status. Not a scored verdict; the data does not support a composite score and this endpoint does not invent one.',
  })
  @ApiResponse({ status: 200, description: 'Gap comparison' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async gap(@Param('projectId') projectId: string) {
    return this.competitors.gap(projectId);
  }

  /**
   * §12.3 — every frozen comparison snapshot for the project, newest first.
   * Summary only (no full result body) so listing stays cheap regardless of
   * how many comparisons have accumulated.
   */
  @Get('comparison-snapshots')
  @ApiOperation({
    summary: 'List frozen comparison snapshots',
    description: 'Every GET .../gap call persists a new immutable snapshot. This lists them newest first, without their full result body.',
  })
  @ApiResponse({ status: 200, description: '{ snapshots: [...] }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listComparisonSnapshots(@Param('projectId') projectId: string) {
    return { snapshots: await this.competitors.listComparisonSnapshots(projectId) };
  }

  /**
   * §12.3 — read one frozen comparison exactly as computed. Never
   * recomputed, even if the competitor set has since changed.
   */
  @Get('comparison-snapshots/:snapshotId')
  @ApiOperation({
    summary: 'Read one frozen comparison snapshot verbatim',
    description: 'Returns the exact GapResult stored at generation time — never retroactively mutated by later competitor-set changes.',
  })
  @ApiResponse({ status: 200, description: 'The frozen GapResult' })
  @ApiResponse({ status: 404, description: 'Snapshot not found for this project' })
  async getComparisonSnapshot(@Param('projectId') projectId: string, @Param('snapshotId') snapshotId: string) {
    return this.competitors.getComparisonSnapshot(projectId, snapshotId);
  }

  /**
   * Brand names an AI surface mentioned that weren't already a recorded
   * competitor — pending operator review. Currently written only by
   * `AeoStanceService`'s stance pass. Never included in `list`/`gap`/the AEO
   * prompt until confirmed.
   */
  @Get('candidates')
  @ApiOperation({
    summary: 'List unconfirmed competitor candidates (currently: names an AI surface mentioned)',
    description:
      'Rows with status=candidate — discovered, not yet trusted. An operator must confirm or reject each one before it counts as a real competitor anywhere else in the app. Returns every candidate for the project, newest first; a project with none returns an empty array, which is "nothing was proposed", not "nothing to review yet".',
  })
  @ApiResponse({
    status: 200,
    description: '{ candidates: Competitor[] } — always status="candidate" (possibly empty)',
    schema: {
      type: 'object',
      required: ['candidates'],
      properties: { candidates: { type: 'array', items: COMPETITOR_ROW_SCHEMA } },
    },
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listCandidates(@Param('projectId') projectId: string) {
    return { candidates: await this.competitors.listCandidates(projectId) };
  }

  /**
   * Promote a candidate to a tracked competitor — appended to Project.competitors too,
   * so share-of-voice and the AEO stance prompt see it on their next read.
   */
  @Post('candidates/:competitorId/confirm')
  @ApiOperation({
    summary: 'Confirm a competitor candidate',
    description:
      'Flips the row to status=tracked and appends its name to Project.competitors. Repeating the call on an already-tracked row is a 404 — the row is no longer a candidate — so the endpoint is idempotent by outcome, not by request.',
  })
  @ApiResponse({
    status: 201,
    description: 'The now-tracked Competitor row (status="tracked")',
    schema: COMPETITOR_ROW_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'No candidate with that id in this project (unknown id, another project\'s id, or a row already tracked)' })
  async confirmCandidate(@Param('projectId') projectId: string, @Param('competitorId') competitorId: string) {
    return this.competitors.confirmCandidate(projectId, competitorId);
  }

  /**
   * Reclassify a candidate's relevance (§12.2: direct competitor / adjacent
   * alternative / not relevant) without confirming or rejecting it.
   */
  @Patch('candidates/:competitorId/relevance')
  @ApiOperation({
    summary: 'Reclassify a competitor candidate\'s relevance',
    description: 'Sets direct-competitor / adjacent-alternative / not-relevant on a still-pending candidate. Does not confirm or reject it.',
  })
  @ApiBody({ type: SetCandidateRelevanceDto })
  @ApiResponse({ status: 200, description: 'The updated candidate row', schema: COMPETITOR_ROW_SCHEMA })
  @ApiResponse({ status: 404, description: 'No pending candidate with that id in this project' })
  async reclassifyCandidate(
    @Param('projectId') projectId: string,
    @Param('competitorId') competitorId: string,
    @Body() body: SetCandidateRelevanceDto,
  ) {
    return this.competitors.reclassifyCandidate(projectId, competitorId, body.relevance);
  }

  /**
   * Discard a candidate — a hallucination, a directory site, or not actually
   * a rival. Records a rejection tombstone first (§12.2 — "rejection memory
   * prevents rediscovery loops") so neither this module's own market
   * discovery nor any other producer of candidate rows re-proposes the same
   * name/domain later.
   */
  @Delete('candidates/:competitorId')
  @ApiOperation({
    summary: 'Reject and delete a competitor candidate',
    description:
      'Records a rejection tombstone (by name + canonical domain) and deletes the candidate row. Only ever applies to an unconfirmed candidate — an established tracked competitor cannot be removed here, which is why a row already confirmed answers 404 rather than being deleted. The row itself has no undo; the tombstone is what prevents it resurfacing.',
  })
  @ApiResponse({
    status: 200,
    description: '{ deleted: true } — the row is gone; a rejection tombstone now suppresses rediscovery',
    schema: { type: 'object', required: ['deleted'], properties: { deleted: { type: 'boolean', enum: [true] } } },
  })
  @ApiResponse({ status: 404, description: 'No candidate with that id in this project (unknown id, another project\'s id, or an already-tracked competitor)' })
  async rejectCandidate(
    @Param('projectId') projectId: string,
    @Param('competitorId') competitorId: string,
    @Query('reason') reason?: string,
  ) {
    await this.competitors.rejectCandidate(projectId, competitorId, reason);
    return { deleted: true };
  }
}
