/**
 * Gap Analysis Module — auto-classifies findings into 6 dimensions + roadmap.
 *
 * Pipeline: technical-audit (AuditFinding) + entity-audit (SchemaCheck, PlatformRecord, ModelDiff) → gaps.
 *
 * Mapping table lives in gap-analysis.service.ts (CLASSIFICATION_RULES) — reviewable constant,
 * intended to become DB-backed/tunable per engagement (SPEC §4.4).
 *
 * @module gap-analysis.module
 */
import { Module } from '@nestjs/common';
import { GapAnalysisService } from './gap-analysis.service';
import { GapAnalysisController } from './gap-analysis.controller';

@Module({
  controllers: [GapAnalysisController],
  providers: [GapAnalysisService],
  exports: [GapAnalysisService],
})
export class GapAnalysisModule {}
