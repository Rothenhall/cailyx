/**
 * Gap Analysis Module — stage 8, "Findings & Opportunity Analysis".
 *
 * Consolidates: technical-audit (AuditFinding, AuditPage), entity-audit
 * (SchemaCheck, PlatformRecord, ModelDiff), digital-presence (gaps, reviews —
 * via `PresenceService.inventory()`, a pure read), tech-stack, competitors,
 * serp-intelligence, aeo-audit → classified, impact/effort-scored gaps.
 *
 * `DigitalPresenceModule` and `KeywordResearchModule` are imported: every
 * other source is read directly via Prisma (same convention the original
 * module already used for technical-audit/entity-audit) rather than
 * injecting each module's service, specifically to avoid
 * `CompetitorsService.gap()`'s live tech-stack-scan fallback — `sync()` must
 * never trigger a fetch as a side effect. `PresenceService.inventory()` and
 * `KeywordResearchService.priority()` are the two exceptions because both
 * are pure read + compute (verified against their source) and reusing their
 * logic is materially better than re-deriving it here.
 *
 * Mapping table lives in gap-analysis.service.ts (CLASSIFICATION_RULES) —
 * reviewable constant, intended to become DB-backed/tunable per engagement
 * (SPEC §4.4).
 *
 * @module gap-analysis.module
 */
import { Module } from '@nestjs/common';
import { DigitalPresenceModule } from '../digital-presence/digital-presence.module';
import { KeywordResearchModule } from '../keyword-research/keyword-research.module';
import { GapAnalysisService } from './gap-analysis.service';
import { GapAnalysisController } from './gap-analysis.controller';

@Module({
  imports: [DigitalPresenceModule, KeywordResearchModule],
  controllers: [GapAnalysisController],
  providers: [GapAnalysisService],
  exports: [GapAnalysisService],
})
export class GapAnalysisModule {}
