/**
 * BusinessProfile Module — confirmed intake, versioned business profile,
 * project attachment and the access checklist (G04).
 *
 * Contract source: design_plan.md Appendix A (G04), §5.3 steps 4-5,
 * screens OP06/CP04/AE05/SL03/PJ02.
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * Four controllers, because G04 owns four route prefixes with different
 * audiences — see business-profile.controller.ts.
 *
 * PrismaService is global (DatabaseModule); ScopeValidationService is global
 * (ScopeValidationModule, activated in AuthModule) — neither is imported here.
 * ActivityModule is imported explicitly because `ActivityService.record()` is
 * how a confirmation, an attach and an explicit rebuild become auditable
 * facts rather than claims.
 *
 * @module business-profile.module
 */

import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import {
  BusinessProfileController,
  BusinessProfilePortalController,
  OnboardingChecklistController,
  ProjectAttachmentController,
} from './business-profile.controller';
import { BusinessProfileService } from './business-profile.service';

@Module({
  imports: [ActivityModule],
  controllers: [
    BusinessProfileController,
    ProjectAttachmentController,
    OnboardingChecklistController,
    BusinessProfilePortalController,
  ],
  providers: [BusinessProfileService],
  exports: [BusinessProfileService],
})
export class BusinessProfileModule {}
