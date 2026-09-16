/**
 * Lifecycle Module — export requests, retention policy and offboarding.
 *
 * Contract source: design_plan.md Appendix A (G17, line 1697).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * Providers:
 * - `LifecycleService`    — export request/status/download
 * - `RetentionService`    — retention policy reads, updates and runs
 * - `OffboardingService`  — preview / execute / status
 * - `ExportStorageService`— the scoped file the export payload lives in
 *
 * `ActivityModule` is imported rather than writing `ActivityEvent` rows
 * directly: G15 owns that table, exports the service for exactly this purpose,
 * and its `record()` applies the redaction that keeps secrets out of the audit
 * trail. An offboarding that wrote its own audit rows would be a second,
 * divergent implementation of the thing the audit trail exists to be.
 *
 * PrismaService is global (DatabaseModule); ScopeValidationService is global
 * (ScopeValidationModule, activated in AuthModule) — neither is imported here.
 *
 * @module lifecycle.module
 */

import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import {
  ClientExportsController,
  LifecycleController,
  LifecyclePortalController,
  OffboardingController,
  RetentionController,
} from './lifecycle.controller';
import { ExportStorageService } from './export-storage.service';
import { LifecycleService } from './lifecycle.service';
import { OffboardingService } from './offboarding.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [ActivityModule],
  controllers: [
    LifecycleController,
    ClientExportsController,
    RetentionController,
    OffboardingController,
    LifecyclePortalController,
  ],
  providers: [LifecycleService, RetentionService, OffboardingService, ExportStorageService],
  exports: [LifecycleService, RetentionService, OffboardingService],
})
export class LifecycleModule {}
