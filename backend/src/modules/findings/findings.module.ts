/**
 * Findings Module — gap rows become two-register what/why/fix copy (Wave 2,
 * FR-9.1–9.3), gated by claims discipline (FR-9.4).
 *
 * Depends on: DatabaseModule, ClaimsModule (hard gate on generated copy)
 *
 * @module findings.module
 */

import { Module } from '@nestjs/common';
import { ClaimsModule } from '../claims/claims.module';
import { FindingsService } from './findings.service';
import { FindingsController } from './findings.controller';

@Module({
  imports: [ClaimsModule],
  controllers: [FindingsController],
  providers: [FindingsService],
  exports: [FindingsService],
})
export class FindingsModule {}