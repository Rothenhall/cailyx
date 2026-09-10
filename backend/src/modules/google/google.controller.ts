/**
 * Google integration — REST surface.
 *
 *   POST   /api/integrations/google/authorize          → { url }  (start OAuth)
 *   GET    /api/integrations/google/callback           → 302 back to the app  (@Public)
 *   GET    /api/integrations/google/connections        → per-service connection state
 *   DELETE /api/integrations/google/connections/:svc   → revoke + forget
 *   GET    /api/integrations/google/resources          → sites / properties + current map
 *   PUT    /api/integrations/google/resources          → map a project to a site / property
 *   GET    /api/integrations/google/search-console/summary?projectId=&days=
 *   GET    /api/integrations/google/analytics/summary?projectId=&days=
 *
 * Everything except the callback is behind the global JwtAuthGuard.
 *
 * @module google/google.controller
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleConnectionService } from './google-connection.service';
import { SearchConsoleService } from './search-console.service';
import { AnalyticsService } from './analytics.service';
import { AuthorizeDto, ResourcesQueryDto, SetResourceDto, SummaryQueryDto } from './dto/google.dto';
import type { GoogleResourcesView, GoogleService } from './google.types';

@ApiTags('Integrations · Google')
@ApiBearerAuth()
@Controller('integrations/google')
export class GoogleController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly connections: GoogleConnectionService,
    private readonly gsc: SearchConsoleService,
    private readonly ga: AnalyticsService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether the OAuth client id/secret are configured on the server' })
  status() {
    return { configured: this.oauth.isConfigured() };
  }

  @Post('authorize')
  @ApiOperation({ summary: 'Begin the OAuth consent flow — returns the Google URL to open' })
  authorize(@CurrentUser() user: AuthedRequestUser, @Body() body: AuthorizeDto) {
    const state = this.oauth.signState(user.userId, body.projectId ?? null, body.service);
    return { url: this.oauth.authUrl(state, body.service) };
  }

  @Public()
  @Get('callback')
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const back = (params: Record<string, string>) => {
      const url = new URL(this.oauth.successRedirect);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      res.redirect(url.toString());
    };

    if (error) return back({ google: 'error', reason: error });
    if (!code || !state) return back({ google: 'error', reason: 'missing_code_or_state' });

    let parsed: { userId: string; projectId: string | null; service: GoogleService };
    try {
      parsed = this.oauth.verifyState(state);
    } catch (e) {
      return back({ google: 'error', reason: (e as Error).message.slice(0, 120) });
    }

    try {
      const tokens = await this.oauth.exchangeCode(code);
      await this.connections.saveAuthorization(parsed.userId, parsed.service, tokens);
      return back({ google: parsed.service, status: 'connected' });
    } catch (e) {
      return back({ google: parsed.service, status: 'error', reason: (e as Error).message.slice(0, 160) });
    }
  }

  @Get('connections')
  @ApiOperation({ summary: 'Per-service connection state for this operator (no tokens returned)' })
  connectionsList(@CurrentUser() user: AuthedRequestUser) {
    return this.connections.list(user.userId);
  }

  @Delete('connections/:service')
  @ApiOperation({ summary: 'Revoke and forget a Google connection' })
  async disconnect(@CurrentUser() user: AuthedRequestUser, @Param('service') service: string) {
    if (service !== 'search-console' && service !== 'analytics') {
      throw new BadRequestException('service must be "search-console" or "analytics"');
    }
    await this.connections.disconnect(user.userId, service);
    return { ok: true };
  }

  @Get('resources')
  @ApiOperation({ summary: 'Sites / properties the connected account can read, plus the current project mapping' })
  async resources(
    @CurrentUser() user: AuthedRequestUser,
    @Query() q: ResourcesQueryDto,
  ): Promise<GoogleResourcesView> {
    const selected = await this.connections.getProjectResource(q.projectId, q.service);
    let options;
    let connected = true;
    try {
      options =
        q.service === 'analytics'
          ? await this.ga.listProperties(user.userId)
          : await this.gsc.listSites(user.userId);
    } catch {
      connected = false;
      options = [];
    }
    return { service: q.service, projectId: q.projectId, connected, options, selected };
  }

  @Put('resources')
  @ApiOperation({ summary: 'Map a project to a specific GSC site / GA4 property' })
  async setResource(@CurrentUser() user: AuthedRequestUser, @Body() body: SetResourceDto) {
    await this.connections.setProjectResource(
      user.userId,
      body.projectId,
      body.service,
      body.resourceId,
      body.resourceLabel ?? null,
    );
    return { ok: true };
  }

  @Get('search-console/summary')
  @ApiOperation({ summary: 'Search Console clicks / impressions / CTR / position + top queries & pages' })
  async searchConsoleSummary(@CurrentUser() user: AuthedRequestUser, @Query() q: SummaryQueryDto) {
    const site = await this.connections.requireProjectResource(q.projectId, 'search-console');
    return this.gsc.summary(user.userId, site, q.days ?? 28);
  }

  @Get('analytics/summary')
  @ApiOperation({ summary: 'GA4 sessions / users / views / engagement + channel & page breakdown' })
  async analyticsSummary(@CurrentUser() user: AuthedRequestUser, @Query() q: SummaryQueryDto) {
    const property = await this.connections.requireProjectResource(q.projectId, 'analytics');
    return this.ga.summary(user.userId, property, q.days ?? 28);
  }
}
