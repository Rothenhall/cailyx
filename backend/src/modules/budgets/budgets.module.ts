/**
 * Budgets Module — G12: budget policies, spend reservations and the cost
 * audit ledger.
 *
 * Contract source: design_plan.md Appendix A (G12).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * `PrismaService` is global via `DatabaseModule` and `ScopeValidationService`
 * is global via `ScopeValidationModule` (activated in `AuthModule`) — neither
 * is imported here. `MeasurementModule` is imported for one export:
 * `CloroClient`, whose `GET /v1/credits` is the only provider balance this
 * codebase can actually read, and which the cost estimate uses when a caller
 * asks for a balance probe. Reusing that client keeps the Cloro base URL and
 * auth rule in the one place that already knows them.
 *
 * `BudgetsService` and `ReservationsService` are both exported: the cost
 * estimate and the ledger are for any module that pays a provider, and the
 * reserve/settle pair is the contract every paid run has to follow.
 *
 * @module budgets.module
 */

import { Module } from '@nestjs/common';
import { MeasurementModule } from '../measurement/measurement.module';
import {
  BudgetsController,
  CostEstimatesController,
  ReservationsController,
  SpendController,
} from './budgets.controller';
import { BudgetsService } from './budgets.service';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [MeasurementModule],
  controllers: [BudgetsController, CostEstimatesController, SpendController, ReservationsController],
  providers: [BudgetsService, ReservationsService],
  exports: [BudgetsService, ReservationsService],
})
export class BudgetsModule {}
