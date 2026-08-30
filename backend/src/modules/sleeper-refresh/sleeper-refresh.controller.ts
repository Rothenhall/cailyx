/**
 * Sleeper Refresh Controller — REST surface for SOP-10.
 *
 * @module sleeper-refresh.controller
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SleeperRefreshService } from './sleeper-refresh.service';
import {
  CreateSleeperPageDto,
  ImportSleeperDto,
  ListSleeperQueryDto,
  MarkRefreshedDto,
  UpdateSleeperPageDto,
} from './dto/sleeper-refresh.dto';

@ApiTags('Sleeper Refresh')
@Controller('projects/:projectId/sleeper-refresh')
export class SleeperRefreshController {
  constructor(private readonly sleeper: SleeperRefreshService) {}

  @Post('pages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a sleeper-page candidate', description: 'Manual entry: page URL + optional traffic decline % and referring-domain count from a GSC export. GSC OAuth pull is an external prerequisite (LEFT-OUT in analysis §3).' })
  @ApiResponse({ status: 201, description: 'Page flagged' })
  async createPage(@Param('projectId') projectId: string, @Body() body: CreateSleeperPageDto) {
    return this.sleeper.createPage(projectId, body.url, body);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Import pages from pasted GSC CSV/TSV or structured rows', description: 'Upserts by URL inside the project; header rows and unparseable lines are counted as skipped. Up to 500 rows per call.' })
  @ApiResponse({ status: 200, description: '{upserted, skipped}' })
  async importPages(@Param('projectId') projectId: string, @Body() body: ImportSleeperDto) {
    return this.sleeper.importPages(projectId, body.text, body.pages);
  }

  @Get('pages')
  @ApiOperation({ summary: 'Candidate list', description: 'Each page carries sleeperStatus (sleeper / not-sleeper / unproven) against minDeclinePct (default 20) and minReferringDomains (default 3); sorted by decline.' })
  async listPages(@Param('projectId') projectId: string, @Query() query: ListSleeperQueryDto) {
    return this.sleeper.listPages(projectId, {
      ...(query?.minDeclinePct !== undefined ? { minDeclinePct: query.minDeclinePct } : {}),
      ...(query?.minReferringDomains !== undefined ? { minReferringDomains: query.minReferringDomains } : {}),
      ...(query?.status ? { status: query.status } : {}),
    });
  }

  @Get('summary')
  @ApiOperation({ summary: 'Refresh SLA roll-up', description: 'Counts by status + how many shipped refreshes verifiably moved dateModified.' })
  async summary(@Param('projectId') projectId: string) {
    return this.sleeper.summary(projectId);
  }

  @Patch('pages/:pageId')
  @ApiOperation({ summary: 'Update a page (status transitions / evidence / notes)' })
  async updatePage(@Param('projectId') projectId: string, @Param('pageId') pageId: string, @Body() body: UpdateSleeperPageDto) {
    return this.sleeper.updatePage(projectId, pageId, body);
  }

  @Post('pages/:pageId/refreshed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a refresh shipped', description: 'Records the new visible dateModified so "the refresh actually moved the page" is auditable (SOP-10).' })
  async markRefreshed(@Param('projectId') projectId: string, @Param('pageId') pageId: string, @Body() body: MarkRefreshedDto) {
    return this.sleeper.markRefreshed(projectId, pageId, body.dateModifiedAfter, body.notes);
  }

  @Delete('pages/:pageId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a sleeper page' })
  async deletePage(@Param('projectId') projectId: string, @Param('pageId') pageId: string) {
    return this.sleeper.deletePage(projectId, pageId);
  }
}