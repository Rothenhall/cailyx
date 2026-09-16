/**
 * Approvals Module — version-specific approval requests, decisions and claim gates.
 *
 * Contract source: design_plan.md Appendix A (G10).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * @module approvals.module
 */

import { Module } from '@nestjs/common';
import {
  ApprovalCheckResultsController,
  ApprovalsPortalController,
  ProjectApprovalsController,
} from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  controllers: [ProjectApprovalsController, ApprovalCheckResultsController, ApprovalsPortalController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
