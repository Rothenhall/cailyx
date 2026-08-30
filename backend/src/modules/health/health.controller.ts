/**
 * Health controller.
 * Exposes endpoints for application health checks.
 *
 * @module HealthController
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { Public } from '../../common/decorators/auth.decorators';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * GET /api/health
   * Returns the current health status of the application.
   * Public — uptime checks run without credentials.
   */
  @Get()
  @Public()
  @ApiOperation({ summary: 'Check application health', description: 'Returns health status, uptime, and timestamp' })
  @ApiResponse({ status: 200, description: 'Application is healthy' })
  getHealth() {
    return this.healthService.getHealth();
  }
}
