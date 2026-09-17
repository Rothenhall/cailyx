/**
 * Website (P12) — REST surface.
 *
 *   GET  /projects/:projectId/website/overview        read-only, storage only
 *   GET  /projects/:projectId/website/pages           read-only, storage only
 *   GET  /projects/:projectId/website/pages/:pageId    read-only, storage only
 *   POST /projects/:projectId/website/sync-google      the ONLY route that calls Google
 *
 * §7.6: loading the overview/pages/detail routes must never trigger a new
 * paid/live audit, provider refresh, or job — every GET here reads stored
 * TechnicalAudit/PageAnalysis/GoogleDataSnapshot rows only.
 *
 * @module website/website.controller
 */

import { Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { WebsiteService } from './website.service';
import { SyncGoogleDataDto } from './dto/website.dto';

@ApiTags('Website')
@Controller('projects/:projectId/website')
export class WebsiteController {
  constructor(private readonly website: WebsiteService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Unified Website overview — health, Google visibility, visitor sessions, insights, important pages. Read-only.' })
  overview(@Param('projectId') projectId: string) {
    return this.website.overview(projectId);
  }

  @Get('pages')
  @ApiOperation({ summary: 'Joined per-page facts across technical checks, Search Console and Analytics. Read-only.' })
  pages(@Param('projectId') projectId: string) {
    return this.website.pages(projectId);
  }

  @Get('pages/:pageId')
  @ApiOperation({ summary: 'Page detail: summary/search/visitors/content/changes for one page identity. Read-only.' })
  async pageDetail(@Param('projectId') projectId: string, @Param('pageId') pageId: string) {
    const detail = await this.website.pageDetail(projectId, pageId);
    if (!detail) throw new NotFoundException(`No page ${pageId} for project ${projectId}`);
    return detail;
  }

  @Post('pages/:pageId/refresh')
  @ApiOperation({
    summary: '"Update this page" — start (or open) the content-refresh workflow for this page.',
    description:
      'Idempotent: returns the existing SleeperPage for this page\'s known source URLs if one is already open, otherwise flags one. Does not call Google or re-crawl; the actual content work happens in the refresh workflow. Returns the page-detail route so the caller lands back in the same page context (§7.2).',
  })
  async startRefresh(@Param('projectId') projectId: string, @Param('pageId') pageId: string) {
    const result = await this.website.startPageRefresh(projectId, pageId);
    if (!result) throw new NotFoundException(`No page ${pageId} for project ${projectId}`);
    return result;
  }

  @Post('sync-google')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Fetch and store current GSC page facts + GA landing-session facts for this project. The only Website route that calls Google.' })
  syncGoogle(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Query() q: SyncGoogleDataDto) {
    return this.website.syncGoogleData(user.userId, projectId, q.days ?? 28);
  }
}
