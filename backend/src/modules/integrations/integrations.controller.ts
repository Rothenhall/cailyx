/**
 * Integrations Controller — connection status for the operator dashboard.
 *
 *   GET /api/integrations — every external service Cailyx can use + connected flag
 *
 * Protected by the global JwtAuthGuard.
 *
 * @module integrations.controller
 */

import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all external-service connections and their status',
    description:
      'Google Analytics / Search Console (OAuth — not wired), Anthropic, Perplexity, DataForSEO, ' +
      'PageSpeed, Redis, Stripe, Plunk, and the swarm-live mode flag. Booleans + metadata only — ' +
      'no secret values are returned.',
  })
  @ApiResponse({ status: 200, description: '{ integrations[], summary: { total, connected } }' })
  async list() {
    return this.service.list();
  }
}
