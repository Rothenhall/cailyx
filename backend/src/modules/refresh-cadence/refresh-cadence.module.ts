/**
 * Refresh-Cadence Module — C7 automatic measurement+scoring refresh, derived
 * from each client's plan tier (`docs/analysis/client-portal.md` §19,
 * `docs/PLAN.md` §11.7).
 *
 * Deliberately does NOT import `ClientsModule` or `BillingModule` — it only
 * needs to read `Client.planTier` and `Project`, both plain Prisma models
 * available through the global `DatabaseModule`. Importing either module
 * would pull in the Day-1 onboarding orchestrator (`ClientsModule`) or the
 * billing ledger (`BillingModule`), neither of which this module calls into
 * or is allowed to touch per its build scope.
 *
 * @module refresh-cadence.module
 */

import { Module } from '@nestjs/common';
import { MeasurementModule } from '../measurement/measurement.module';
import { ScoringModule } from '../scoring/scoring.module';
import { RefreshCadenceService } from './refresh-cadence.service';
import { RefreshCadenceSchedulerService } from './refresh-cadence-scheduler.service';
import { RefreshCadenceController } from './refresh-cadence.controller';

@Module({
  imports: [MeasurementModule, ScoringModule],
  controllers: [RefreshCadenceController],
  providers: [RefreshCadenceService, RefreshCadenceSchedulerService],
  exports: [RefreshCadenceService],
})
export class RefreshCadenceModule {}
