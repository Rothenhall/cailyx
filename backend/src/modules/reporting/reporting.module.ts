/**
 * Reporting Module — Branded diagnostic report generation.
 *
 * Aggregates data from technical-audit (Prisma), entity-audit (Prisma),
 * gap-analysis (Prisma) and — as of the stage-12 completion pass — strategy
 * (stage 9's ranked action plan) and findings (stage 8's LLM what/why/fix
 * copy) into scored reports with executive/detailed HTML rendering. This is
 * the flowchart's "Comprehensive Audit & Growth Report" → "Prioritized
 * Growth Roadmap" (stage 12, "Final Output").
 *
 * Built (FR-10):
 *   - Report generation with PRD §8 scoring
 *   - Executive + detailed HTML views
 *   - Stable slug URLs, visibility control
 *   - Branding config (white-label ready)
 *   - Growth plan section: strategy's ranked ActionPlan + findings' copy
 *   - Backlinks section: the project's latest DataForSEO backlinks snapshot
 *
 * `StrategyService.getActionPlan()`, `FindingsService.list()` and
 * `BacklinksService.latest()` are all pure reads (no rebuild, no LLM call,
 * no vendor call) — report generation must never trigger a paid call or a
 * gap-analysis re-sync as a side effect.
 *
 * Depends on: DatabaseModule (PrismaService reports/audits/gaps access)
 *
 * @module reporting.module
 */

import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { StrategyModule } from '../strategy/strategy.module';
import { FindingsModule } from '../findings/findings.module';
import { BacklinksModule } from '../backlinks/backlinks.module';
import { ReportingService } from './reporting.service';
import { ReportingController } from './reporting.controller';

@Module({
  imports: [ScoringModule, StrategyModule, FindingsModule, BacklinksModule],
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}