/**
 * DeliveryPlan Module — engagements, cycles, work items, capacity and verification.
 *
 * Contract source: design_plan.md Appendix A (G06).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * @module delivery-plan.module
 */

import { Module } from '@nestjs/common';
import {
  CapacityController,
  CyclesController,
  DeliveryPlanPortalController,
  EngagementsController,
  MilestonesController,
  WorkItemsController,
} from './delivery-plan.controller';
import { DeliveryPlanService } from './delivery-plan.service';

@Module({
  controllers: [
    EngagementsController,
    CyclesController,
    WorkItemsController,
    MilestonesController,
    CapacityController,
    DeliveryPlanPortalController,
  ],
  providers: [DeliveryPlanService],
  exports: [DeliveryPlanService],
})
export class DeliveryPlanModule {}
