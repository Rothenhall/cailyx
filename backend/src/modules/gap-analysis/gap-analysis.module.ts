/**
 * Gap Analysis Module — stage 8, "Findings & Opportunity Analysis".
 *
 * Consolidates: technical-audit (AuditFinding, AuditPage), entity-audit
 * (SchemaCheck, PlatformRecord, ModelDiff), digital-presence (gaps, reviews —
 * via `PresenceService.inventory()`, a pure read), tech-stack, competitors,
 * serp-intelligence, aeo-audit → classified, impact/effort-scored gaps.
 *
 * Only `DigitalPresenceModule` is imported: every other source is read
 * directly via Prisma (same convention the original module already used for
 * technical-audit/entity-audit) rather than injecting each module's service,
 * specifically to avoid `CompetitorsService.gap()`'s live tech-stack-scan
 * fallback — `sync()` must never trigger a fetch as a side effect.
 * `PresenceService.inventory()` is the one exception because it is a pure
 * read + compute (verified against its source) and reusing its business-
 * type-aware gap logic is materially better than re-deriving it here.
 *
 * Mapping table lives in gap-analysis.service.ts (CLASSIFICATION_RULES) —
 * reviewable constant, intended to become DB-backed/tunable per engagement
 * (SPEC §4.4).
 *
 * @module gap-analysis.module
 */
import { Module } from '@nestjs/common';
import { DigitalPresenceModule } from '../digital-presence/digital-presence.module';
import { GapAnalysisService } from './gap-analysis.service';
import { GapAnalysisController } from './gap-analysis.controller';

@Module({
  imports: [DigitalPresenceModule],
  controllers: [GapAnalysisController],
  providers: [GapAnalysisService],
  exports: [GapAnalysisService],
})
export class GapAnalysisModule {}
