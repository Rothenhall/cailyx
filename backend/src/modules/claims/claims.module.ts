/**
 * Claims Module — claims-discipline guardrail (Wave 2, FR-9.4).
 *
 * Deterministic banned-phrase blocker, numeric-claim detection, single-run-rate
 * enforcement, and A/B/C provenance grading. The hard gate for anything
 * client-facing: findings copy and report figures pass through here.
 *
 * Depends on: DatabaseModule
 *
 * @module claims.module
 */

import { Module } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';

@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}