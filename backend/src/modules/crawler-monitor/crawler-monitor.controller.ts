/**
 * Crawler Monitor Controller — AI-crawler log ingestion + activity reports.
 *
 * Routes:
 *   POST /api/projects/:projectId/crawler-monitor/ingest   ingest hits[] or raw logs (classified)
 *   GET  /api/projects/:projectId/crawler-monitor/summary  activity roll-up (by type/vendor/URL)
 *   GET  /api/projects/:projectId/crawler-monitor/hits     raw hits (newest first)
 *
 * @module crawler-monitor.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CrawlerMonitorService } from './crawler-monitor.service';
import { IngestDto, ListHitsQueryDto } from './dto/crawler-monitor.dto';

@ApiTags('Crawler Monitor')
@Controller('projects/:projectId/crawler-monitor')
export class CrawlerMonitorController {
  constructor(private readonly crawlerMonitor: CrawlerMonitorService) {}

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Ingest AI-crawler hits',
    description: 'Accepts hits[] JSON or raw combined-log-format text. Lines whose user-agent matches the bot registry are classified (training vs search vs citation-engine) and stored; everything else is counted as skipped.',
  })
  @ApiResponse({ status: 200, description: '{ingested, skipped}' })
  @ApiResponse({ status: 400, description: 'No parseable hits' })
  async ingest(@Param('projectId') projectId: string, @Body() body: IngestDto) {
    return this.crawlerMonitor.ingest(projectId, { hits: body.hits, logText: body.logText });
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Crawler activity summary',
    description: 'Total hits, training vs search vs citation-engine split, by-vendor breakdown, top crawled URLs. Optional ?daysBack window.',
  })
  @ApiQuery({ name: 'daysBack', required: false })
  async summary(@Param('projectId') projectId: string, @Query('daysBack') daysBack?: string) {
    const days = daysBack ? Number(daysBack) : undefined;
    return this.crawlerMonitor.summary(projectId, days);
  }

  @Get('hits')
  @ApiOperation({ summary: 'Raw crawler hits', description: 'Newest first; optional ?limit= and ?botType= filters.' })
  async hits(@Param('projectId') projectId: string, @Query() query: ListHitsQueryDto) {
    const hits = await this.crawlerMonitor.listHits(projectId, query.limit);
    return query.botType ? hits.filter((h) => h.botType === query.botType) : hits;
  }
}