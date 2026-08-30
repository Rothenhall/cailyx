/**
 * Health module.
 * Provides a health-check endpoint to verify the application is running.
 *
 * @module HealthModule
 */

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
