/**
 * Integrations Module — external-service connection status for the dashboard.
 *
 * Config inspection only (+ a short Redis ping). No persistence, no secrets
 * returned. Depends on ConfigModule (global).
 *
 * @module integrations.module
 */

import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
