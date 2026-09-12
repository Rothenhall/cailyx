/**
 * Tech Stack Controller — REST API endpoints.
 *
 * Runs synchronously (no background job/poll): detection is pure text/header
 * matching over one fetch, typically sub-second. Rate-limited like other
 * live-fetch endpoints since it does real network I/O.
 *
 * @module tech-stack.controller
 */

import { Controller, Post, Get, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TechStackService } from './tech-stack.service';
import { RunTechStackScanDto } from './dto/tech-stack.dto';

@ApiTags('Tech Stack')
@Controller('projects/:projectId/tech-stack')
export class TechStackController {
  constructor(private readonly techStack: TechStackService) {}

  /**
   * Scan a domain's homepage for known technology signatures. Defaults to the
   * project's own domain. Rate-limited to 10/minute — a live fetch, but cheap
   * enough not to need technical-audit's stricter 3/minute.
   */
  @Post('scan')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Scan a domain for known technology signatures',
    description:
      "Fetches the domain's homepage and matches headers/HTML/scripts against an in-repo signature table. Runs synchronously and returns the result directly. Defaults to the project's own domain; pass `domain` to profile any other domain (e.g. a competitor).",
  })
  @ApiBody({ type: RunTechStackScanDto })
  @ApiResponse({ status: 201, description: 'Scan result, including a failed scan (fetch blocked/unreachable) — check `status`' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 429, description: 'Too many scans — rate limited to 10/minute' })
  async scan(@Param('projectId') projectId: string, @Body() body: RunTechStackScanDto) {
    return this.techStack.scanDomain(projectId, body.domain);
  }

  /**
   * Latest stored scan for a domain. Defaults to the project's own domain.
   *
   * Wrapped in `{ scan }` rather than returned bare: Nest/Express sends an
   * empty body (not the JSON literal `null`) for a bare `null` return, which
   * breaks any client doing `JSON.parse` on the response.
   */
  @Get()
  @ApiOperation({ summary: 'Get the latest tech-stack scan for a domain' })
  @ApiResponse({ status: 200, description: '{ scan }, scan is null if none has run yet' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getLatest(@Param('projectId') projectId: string, @Query('domain') domain?: string) {
    return { scan: await this.techStack.getLatest(projectId, domain) };
  }
}
