/**
 * Reporting Module — Branded diagnostic report generation.
 *
 * Aggregates data from technical-audit (Prisma), entity-audit (Prisma),
 * and gap-analysis (Prisma) into scored reports with executive/detailed
 * HTML rendering.
 *
 * Built (FR-10):
 *   - Report generation with PRD §8 scoring
 *   - Executive + detailed HTML views
 *   - Stable slug URLs, visibility control
 *   - Branding config (white-label ready)
 *
 * Depends on: DatabaseModule (PrismaService reports/audits/gaps access)
 *
 * @module reporting.module
 */

import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { ReportingService } from './reporting.service';
import { ReportingController } from './reporting.controller';

@Module({
  imports: [ScoringModule],
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}