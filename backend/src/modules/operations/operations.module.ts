/**
 * Operations Module — portfolio aggregation, server pagination, filters and saved views.
 *
 * Contract source: design_plan.md Appendix A (G14).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * @module operations.module
 */

import { Module } from '@nestjs/common';
import { OperationsController, SavedViewsController } from './operations.controller';
import { OperationsService } from './operations.service';

@Module({
  controllers: [OperationsController, SavedViewsController],
  providers: [OperationsService],
  exports: [OperationsService],
})
export class OperationsModule {}
