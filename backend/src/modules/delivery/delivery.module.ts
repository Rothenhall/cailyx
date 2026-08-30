/**
 * Delivery module — PRD §6.11: Plunk email adapter (pre-approved), the Lead
 * CRM with CTA logging, and the Stripe Checkout upgrade ledger
 * (docs/analysis/wave-5.md §3).
 *
 * @module delivery.module
 */

import { Module } from '@nestjs/common';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';

// PrismaModule is @Global — modules do not import DatabaseModule.
// Plunk is called over raw fetch (no SDK); Stripe option A needs no SDK.
@Module({
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}