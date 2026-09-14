/**
 * Keyword Research Controller — REST API endpoints.
 *
 * Runs synchronously: a research call is 1-2 vendor requests, not a crawl or
 * a multi-engine measurement run, so there is no job/poll pipeline here
 * (same shape as `tech-stack`, not `serp-intelligence.capture`).
 *
 * @module keyword-research.controller
 */

import { Controller, Post, Get, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KeywordResearchService } from './keyword-research.service';
import { RunKeywordResearchDto, ListKeywordSetsQueryDto, PriorityKeywordsQueryDto } from './dto/keyword-research.dto';

@ApiTags('Keyword Research')
@Controller('projects/:projectId/keyword-research')
export class KeywordResearchController {
  constructor(private readonly keywordResearch: KeywordResearchService) {}

  /**
   * Pull search volume, competition/CPC for a set of seed keywords, plus an
   * optional related/long-tail expansion. Rate-limited to 10/minute — a live
   * paid vendor call.
   */
  @Post()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Research a set of keywords (volume, competition, CPC, related/long-tail)',
    description:
      'Calls DataForSEO Keywords Data for the given seed keywords and, by default, also pulls related/long-tail suggestions for them (one extra vendor call, capped at the first 20 seeds). Requires SWARM_ALLOW_LIVE=1 and DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD — returns 503 with the exact env vars to set when either is missing.',
  })
  @ApiBody({ type: RunKeywordResearchDto })
  @ApiResponse({ status: 201, description: 'The created keyword set, including a partial/failed run — check `status`' })
  @ApiResponse({ status: 400, description: 'No usable keywords after normalization' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'SWARM_ALLOW_LIVE, DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD not configured' })
  async research(@Param('projectId') projectId: string, @Body() body: RunKeywordResearchDto) {
    return this.keywordResearch.research(projectId, body);
  }

  /**
   * List keyword sets for a project, or one set (with its keywords) via
   * `?setId=`. `?minVolume=` filters the returned keyword rows either way.
   */
  @Get()
  @ApiOperation({ summary: 'List keyword sets / keywords for a project' })
  @ApiResponse({ status: 200, description: '{ sets: KeywordSet[] } — each with its (optionally filtered) keywords' })
  @ApiResponse({ status: 404, description: 'Project not found, or setId does not belong to this project' })
  async list(@Param('projectId') projectId: string, @Query() query: ListKeywordSetsQueryDto) {
    return this.keywordResearch.list(projectId, query);
  }

  /**
   * "Select Priority Keywords to Target" — ranks a set's keywords by
   * disclosed weights over volume/competition/CPC. No vendor call, no cost;
   * pure computation over already-stored rows.
   */
  @Get('priority')
  @ApiOperation({
    summary: 'Rank keywords into a priority-to-target order',
    description:
      'Deterministic ranking over volume (55%), inverse advertiser-competition (25%) and CPC-derived commercial intent (20%) — weights returned in the response, never a black-box number. Defaults to the project\'s most recent completed/partial set.',
  })
  @ApiResponse({ status: 200, description: 'Ranked keywords + the ones excluded for having no search-volume data' })
  @ApiResponse({ status: 404, description: 'Project not found, setId not found/foreign, or no eligible set exists yet' })
  async priority(@Param('projectId') projectId: string, @Query() query: PriorityKeywordsQueryDto) {
    return this.keywordResearch.priority(projectId, query);
  }
}
