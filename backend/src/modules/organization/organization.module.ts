/**
 * Organization Module — organization settings, branding, report and program
 * templates (G20).
 *
 * Contract source: design_plan.md Appendix A (G20), screens OP20/OP21.
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * Three admin-only controllers, one per resource group — see
 * organization.controller.ts. Every route is `@Roles('admin')`.
 *
 * Imports, and why each is explicit:
 *
 * - `ActivityModule` — settings writes, template edits and template applies
 *   record audit events, so "who changed the branding on the 3rd" is
 *   answerable.
 * - `DeliveryPlanModule` — applying a `cycle` program template copies work
 *   items through `DeliveryPlanService.createWorkItem` rather than writing
 *   `WorkItem` rows directly, so every G06 rule (closed cycle refused,
 *   committed cycle demands a scope-change reason) applies to the copy for
 *   free instead of being re-implemented here.
 * - PrismaService is global (DatabaseModule) and ScopeValidationService is
 *   global (ScopeValidationModule) — neither is imported.
 *
 * @module organization.module
 */

import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { DeliveryPlanModule } from '../delivery-plan/delivery-plan.module';
import {
  OrganizationController,
  ProgramTemplatesController,
  ReportTemplatesController,
} from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  imports: [ActivityModule, DeliveryPlanModule],
  controllers: [OrganizationController, ReportTemplatesController, ProgramTemplatesController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
