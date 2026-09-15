/**
 * Competitors Controller — REST API endpoints.
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

import { Controller, Post, Get, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CompetitorsService } from './competitors.service';
import { DiscoverCompetitorsDto } from './dto/competitors.dto';

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
      "Distinct from GET /projects/:id/competitors (ProjectsController's named-competitor list + SERP-discovered candidates) — this returns the first-class Competitor rows this module maintains, each with its latest tech/schema/AEO/SERP profile.",
  })
  @ApiResponse({ status: 200, description: '{ competitors }' })
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
   * Brand names an AI surface mentioned that weren't already a recorded
   * competitor — pending operator review. Currently written only by
   * `AeoStanceService`'s stance pass. Never included in `list`/`gap`/the AEO
   * prompt until confirmed.
   */
  @Get('candidates')
  @ApiOperation({
    summary: 'List unconfirmed competitor candidates (currently: names an AI surface mentioned)',
    description:
      'Rows with status=candidate — discovered, not yet trusted. An operator must confirm or reject each one before it counts as a real competitor anywhere else in the app.',
  })
  @ApiResponse({ status: 200, description: '{ candidates }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listCandidates(@Param('projectId') projectId: string) {
    return { candidates: await this.competitors.listCandidates(projectId) };
  }

  /** Promote a candidate to a tracked competitor — appended to Project.competitors too. */
  @Post('candidates/:competitorId/confirm')
  @ApiOperation({ summary: 'Confirm a competitor candidate' })
  @ApiResponse({ status: 201, description: 'The now-tracked Competitor row' })
  @ApiResponse({ status: 404, description: 'Candidate not found' })
  async confirmCandidate(@Param('projectId') projectId: string, @Param('competitorId') competitorId: string) {
    return this.competitors.confirmCandidate(projectId, competitorId);
  }

  /** Discard a candidate — a hallucination, a directory site, or not actually a rival. */
  @Delete('candidates/:competitorId')
  @ApiOperation({ summary: 'Reject and delete a competitor candidate' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Candidate not found' })
  async rejectCandidate(@Param('projectId') projectId: string, @Param('competitorId') competitorId: string) {
    await this.competitors.rejectCandidate(projectId, competitorId);
    return { deleted: true };
  }
}
