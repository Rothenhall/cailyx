/**
 * Activity Module — append-only activity, provenance and audit trail.
 *
 * Contract source: design_plan.md Appendix A (G15).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * @module activity.module
 */

import { Module } from '@nestjs/common';
import {
  ActivityController,
  ClientActivityController,
  PortalActivityController,
  ProjectActivityController,
} from './activity.controller';
import { ActivityService } from './activity.service';

@Module({
  controllers: [ActivityController, ProjectActivityController, ClientActivityController, PortalActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
