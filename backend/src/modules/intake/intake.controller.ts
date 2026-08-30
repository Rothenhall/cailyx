/**
 * Intake Controller — REST API endpoints for subject intake.
 *
 * Routes:
 *   POST  /api/intake/subject           — single-subject intake (public form / API)
 *   POST  /api/intake/bulk              — bulk CSV intake (rate-limited)
 *   GET   /api/intake/enrichments        — recent enrichments (admin)
 *
 * @module intake.controller
 */

import { Controller, Post, Get, Param, Body, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IntakeService } from './intake.service';
import { PublicIntakeDto } from './dto/intake.dto';
import type { IntakeSource } from './intake.types';

@ApiTags('Intake')
@Controller('intake')
export class IntakeController {
  constructor(private readonly intakeService: IntakeService) {}

  /**
   * Single-subject intake. Minimum required input is a domain (PRD FR-1.5).
   * Creates/attaches Project and enriches from site: category, description, country, competitors, entities.
   */
  @Post('subject')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Intake a subject',
    description: 'Accepts a domain (min input). Creates/attaches project, then auto-enriches: fetches homepage, extracts JSON-LD schema, positioning copy, named competitors, country.',
  })
  @ApiBody({ type: PublicIntakeDto })
  @ApiResponse({ status: 201, description: 'Subject enriched, project created/attached' })
  @ApiResponse({ status: 400, description: 'Invalid domain' })
  @ApiResponse({ status: 429, description: 'Rate limited to 5/minute' })
  async intakeSubject(@Body() body: PublicIntakeDto) {
    return this.intakeService.intakeSubject({ ...body, source: body.source as IntakeSource | undefined });
  }

  /**
   * Bulk intake from CSV-parsed items. Rate-limited 2/60s (heavy: every item triggers enrichment).
   */
  @Post('bulk')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 2 } })
  @ApiOperation({ summary: 'Bulk intake subjects from CSV', description: 'Accepts an array of domains, enriches each one. Rate-limited 2/minute.' })
  @ApiResponse({ status: 201, description: 'Bulk intake processed' })
  @ApiResponse({ status: 400, description: 'Invalid CSV items' })
  async intakeBulk(@Body() body: { items: Array<{ domain: string; company?: string }> }) {
    return this.intakeService.intakeBulk(body.items || []);
  }

  /**
   * Get recent intake/enrichment activity (admin).
   */
  @Get('enrichments/count')
  @ApiOperation({ summary: 'Count of intake enrichments performed (admin)' })
  @ApiResponse({ status: 200, description: 'Total enrichments count' })
  async count() {
    return this.intakeService.count();
  }
}