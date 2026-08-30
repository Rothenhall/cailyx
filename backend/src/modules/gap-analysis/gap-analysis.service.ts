/**
 * Gap Analysis Service — auto-classifies findings into 6 dimensions + fix/build/influence.
 *
 * Ingests: AuditFinding (technical-audit), SchemaCheck + PlatformRecord + ModelDiff (entity-audit).
 * Mapping table (CLASSIFICATION_RULES) is exported for review — per SPEC §4.4 it should become
 * DB-backed/tunable when engagement tuning demand emerges; for v1 it is a constant.
 *
 * Priority score: demandPotential × credibilityImpact × citationLikelihood (null until all three 1-5 are set).
 * Auto-assigned dimension/action flip to *_auto_assigned=false once delivery lead overrides via PATCH.
 *
 * Sync is idempotent: @@unique([sourceType, sourceId]) prevents duplicates; re-sync upserts titles/descriptions.
 *
 * @module gap-analysis.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { ClassificationRule, GapDimension, GapAction } from './gap-analysis.types';

export const CLASSIFICATION_RULES: ClassificationRule[] = [
  // Technical findings — type exact match
  { sourceType: 'technical-finding', sourceKey: 'robots', match: 'robots', dimension: 'visibility', action: 'fix', title: 'robots.txt blocks AI crawlers' },
  { sourceType: 'technical-finding', sourceKey: 'cdn-inferred', match: 'cdn-inferred', dimension: 'visibility', action: 'fix', title: 'CDN/WAF silently blocks AI crawlers' },
  { sourceType: 'technical-finding', sourceKey: 'js-render', match: 'js-render', dimension: 'visibility', action: 'fix', title: 'JS-render dependency hides content from crawlers' },
  { sourceType: 'technical-finding', sourceKey: 'cwv', match: 'cwv', dimension: 'visibility', action: 'fix', title: 'Core Web Vitals need improvement' },
  { sourceType: 'technical-finding', sourceKey: 'schema-tech', match: 'schema', dimension: 'narrative', action: 'fix', title: 'Missing or incomplete JSON-LD structured data' },
  // Entity-audit derived
  { sourceType: 'schema-check', sourceKey: 'schema-check', match: 'schema-check', dimension: 'narrative', action: 'fix', title: 'Schema check failed — missing fields or broken sameAs' },
  { sourceType: 'schema-check', sourceKey: 'sameAs', match: 'sameAs', dimension: 'narrative', action: 'fix', title: 'Broken or stale sameAs links' },
  { sourceType: 'platform-record', sourceKey: 'platform-record', match: 'platform-record', dimension: 'narrative', action: 'influence', title: 'Platform name/descriptor mismatch' },
  { sourceType: 'model-diff', sourceKey: 'model-diff', match: 'model-diff', dimension: 'narrative', action: 'influence', title: 'AI model mischaracterizes entity (model-diff divergence)' },
  // Generic fallbacks for topic/format/web-mentions/demand — created only when explicitly produced by future modules
];

function computePriorityScore(demand: number | null, credibility: number | null, citation: number | null): number | null {
  if (demand == null || credibility == null || citation == null) return null;
  return demand * credibility * citation;
}

function classify(sourceType: string, sourceKey: string): { dimension: GapDimension; action: GapAction; title: string } | null {
  const key = sourceKey.toLowerCase();
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.sourceType !== sourceType) continue;
    // Exact match on sourceKey or rule.match substring in key
    if (rule.match.toLowerCase() === key) return { dimension: rule.dimension, action: rule.action, title: rule.title };
  }
  // Fallback: try loose contains
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.sourceType !== sourceType) continue;
    if (key.includes(rule.match.toLowerCase()) || rule.match.toLowerCase().includes(key)) {
      return { dimension: rule.dimension, action: rule.action, title: rule.title };
    }
  }
  return null;
}

@Injectable()
export class GapAnalysisService {
  private readonly logger = new Logger(GapAnalysisService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async getOrCreateAnalysis(projectId: string) {
    let analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) {
      try {
        analysis = await this.prisma.gapAnalysis.create({ data: { projectId } });
      } catch (e: any) {
        // Race: another sync created it first (projectId @unique)
        if (e?.code === 'P2002') {
          analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
          if (!analysis) throw e;
        } else {
          throw e;
        }
      }
    }
    return analysis;
  }

  /**
   * List gaps for a project, filterable by dimension/action/status.
   */
  async listGaps(projectId: string, filters: { dimension?: string; action?: string; status?: string }) {
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) return { id: '', projectId, gaps: [], count: 0 };

    const where: any = { gapAnalysisId: analysis.id };
    if (filters.dimension) where.dimension = filters.dimension;
    if (filters.action) where.action = filters.action;
    if (filters.status) where.status = filters.status;

    const gaps = await this.prisma.gap.findMany({
      where,
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
    });

    // Sort: non-null priorityScore desc, nulls last
    gaps.sort((a, b) => {
      if (a.priorityScore != null && b.priorityScore != null) return b.priorityScore - a.priorityScore;
      if (a.priorityScore != null) return -1;
      if (b.priorityScore != null) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    return { id: analysis.id, projectId, gaps, count: gaps.length };
  }

  async getGap(projectId: string, gapId: string) {
    const gap = await this.prisma.gap.findUnique({ where: { id: gapId }, include: { gapAnalysis: true } });
    if (!gap || gap.gapAnalysis.projectId !== projectId) {
      throw new NotFoundException(`Gap ${gapId} not found in project ${projectId}`);
    }
    return gap;
  }

  /**
   * Re-run auto-classification against latest findings. Idempotent — upserts by (sourceType, sourceId).
   * Prunes stale gaps where the source no longer qualifies (finding now passes or record deleted).
   */
  async sync(projectId: string) {
    const analysis = await this.getOrCreateAnalysis(projectId);
    let created = 0;
    let updated = 0;
    const validSourceIds = new Set<string>();

    // 1. Technical findings: AuditFinding where status in fail/error
    const audits = await this.prisma.technicalAudit.findMany({
      where: { projectId },
      include: { findings: true },
    });
    const technicalFindings: Array<{ id: string; type: string; status: string; severity: string; recommendedFix: string }> = [];
    for (const audit of audits) {
      for (const f of audit.findings) {
        if (f.status === 'fail' || f.status === 'error') technicalFindings.push(f as any);
      }
    }

    for (const f of technicalFindings) {
      const key = f.type; // robots, cdn-inferred, js-render, cwv, schema
      const cls = classify('technical-finding', key);
      if (!cls) continue;
      validSourceIds.add(`technical-finding:${f.id}`);
      const result = await this.upsertGap(analysis.id, {
        sourceType: 'technical-finding',
        sourceId: f.id,
        dimension: cls.dimension,
        action: cls.action,
        title: `${cls.title} (${f.type})`,
        description: f.recommendedFix,
        severity: f.severity,
      });
      if (result.created) created++; else updated++;
    }

    // 2. Entity-audit: SchemaChecks where status fail/error
    // Need to scope to entities belonging to this project's EntityAudit
    const entityAudit = await this.prisma.entityAudit.findFirst({ where: { projectId }, include: { entities: { include: { schemaChecks: true, platformRecords: true, modelDiffs: true } } } });
    if (entityAudit) {
      for (const entity of entityAudit.entities) {
        for (const sc of entity.schemaChecks) {
          if (sc.status !== 'fail' && sc.status !== 'error') continue;
          // Determine subtype: sameAs broken vs missing fields
          const verification = typeof sc.sameAsVerification === 'string' ? JSON.parse(sc.sameAsVerification) as any : (sc.sameAsVerification as any);
          const hasBroken = Array.isArray(verification) && verification.some((v: any) => !v.resolves || v.identityMatch === false);
          const key = hasBroken ? 'sameAs' : 'schema-check';
          const cls = classify('schema-check', key);
          if (!cls) continue;
          const missingRaw = typeof sc.fieldsMissing === 'string' ? JSON.parse(sc.fieldsMissing || '[]') as string[] : (sc.fieldsMissing as any);
          const missing = (missingRaw as string[] | null)?.join(', ') || '';
          validSourceIds.add(`schema-check:${sc.id}`);
          const result = await this.upsertGap(analysis.id, {
            sourceType: 'schema-check',
            sourceId: sc.id,
            dimension: cls.dimension,
            action: cls.action,
            title: `${cls.title} — ${entity.name}`,
            description: missing ? `Missing fields: ${missing}. ` + `Schema type: ${sc.schemaType || 'none'}.` : `Schema issue for entity ${entity.name}.`,
            severity: sc.status === 'fail' ? 'medium' : 'low',
          });
          if (result.created) created++; else updated++;
        }

        // 3. PlatformRecord mismatches
        for (const pr of entity.platformRecords) {
          if (pr.consistencyStatus !== 'mismatch') continue;
          const cls = classify('platform-record', 'platform-record');
          if (!cls) continue;
          validSourceIds.add(`platform-record:${pr.id}`);
          const result = await this.upsertGap(analysis.id, {
            sourceType: 'platform-record',
            sourceId: pr.id,
            dimension: cls.dimension,
            action: cls.action,
            title: `${cls.title} — ${entity.name} on ${pr.platform}`,
            description: `Platform ${pr.platform} shows "${pr.recordedName}" vs entity "${entity.name}"${pr.sourceUrl ? ` (${pr.sourceUrl})` : ''}.`,
            severity: 'medium',
          });
          if (result.created) created++; else updated++;
        }

        // 4. ModelDiff divergences (only high divergence; schema exists but execution deferred — usually zero rows)
        for (const md of entity.modelDiffs) {
          if (md.status !== 'completed') continue;
          const divergence = md.divergence as any;
          const score = divergence?.score as number | undefined;
          if (score == null || score < 0.5) continue; // only high divergence (>=0.5) becomes a gap
          const cls = classify('model-diff', 'model-diff');
          if (!cls) continue;
          validSourceIds.add(`model-diff:${md.id}`);
          const result = await this.upsertGap(analysis.id, {
            sourceType: 'model-diff',
            sourceId: md.id,
            dimension: cls.dimension,
            action: cls.action,
            title: `${cls.title} — ${entity.name} (${md.provider})`,
            description: divergence?.summary || `Model ${md.provider}/${md.model || ''} divergent (score ${score}).`,
            severity: 'high',
          });
          if (result.created) created++; else updated++;
        }
      }
    }

    // Prune stale gaps: remove gaps whose source no longer qualifies (finding now passes/deleted)
    // Only prune auto-synced sources; manual gaps with no source would not be in validSourceIds
    const existingGaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id }, select: { id: true, sourceType: true, sourceId: true } });
    let pruned = 0;
    for (const g of existingGaps) {
      const key = `${g.sourceType}:${g.sourceId}`;
      if (!validSourceIds.has(key)) {
        await this.prisma.gap.delete({ where: { id: g.id } });
        pruned++;
      }
    }

    this.logger.log(`Gap sync for ${projectId}: ${created} created, ${updated} updated, ${pruned} pruned`);
    const gaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id }, orderBy: { createdAt: 'desc' } });
    return { id: analysis.id, projectId, created, updated, pruned, gaps, count: gaps.length };
  }

  private async upsertGap(
    gapAnalysisId: string,
    data: { sourceType: string; sourceId: string; dimension: GapDimension; action: GapAction; title: string; description: string; severity: string },
  ): Promise<{ created: boolean }> {
    const existing = await this.prisma.gap.findFirst({ where: { sourceType: data.sourceType, sourceId: data.sourceId } });
    if (existing) {
      // Only update title/description/severity if still auto-assigned — don't overwrite manual overrides
      const patch: any = {};
      if (existing.dimensionAutoAssigned) patch.dimension = data.dimension;
      if (existing.actionAutoAssigned) patch.action = data.action;
      // Always refresh denormalized display fields if auto
      if (existing.dimensionAutoAssigned || existing.actionAutoAssigned) {
        patch.title = data.title;
        patch.description = data.description;
        patch.severity = data.severity;
      }
      if (Object.keys(patch).length > 0) {
        await this.prisma.gap.update({ where: { id: existing.id }, data: patch });
      }
      return { created: false };
    }
    await this.prisma.gap.create({
      data: {
        gapAnalysisId,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        dimension: data.dimension,
        dimensionAutoAssigned: true,
        action: data.action,
        actionAutoAssigned: true,
        title: data.title,
        description: data.description,
        severity: data.severity,
        status: 'open',
      },
    });
    return { created: true };
  }

  /**
   * Patch a gap: override dimension/action/status and set 1-5 priority inputs.
   */
  async patchGap(projectId: string, gapId: string, patch: { dimension?: string; action?: string; status?: string; demandPotential?: number; credibilityImpact?: number; citationLikelihood?: number; title?: string; description?: string }) {
    const gap = await this.getGap(projectId, gapId);
    const data: any = {};
    if (patch.dimension !== undefined) {
      data.dimension = patch.dimension;
      data.dimensionAutoAssigned = false;
    }
    if (patch.action !== undefined) {
      data.action = patch.action;
      data.actionAutoAssigned = false;
    }
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.demandPotential !== undefined) data.demandPotential = patch.demandPotential;
    if (patch.credibilityImpact !== undefined) data.credibilityImpact = patch.credibilityImpact;
    if (patch.citationLikelihood !== undefined) data.citationLikelihood = patch.citationLikelihood;
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.description !== undefined) data.description = patch.description;

    // Recompute priorityScore if any of the three are set (use merged values)
    const demand = patch.demandPotential !== undefined ? patch.demandPotential : gap.demandPotential;
    const credibility = patch.credibilityImpact !== undefined ? patch.credibilityImpact : gap.credibilityImpact;
    const citation = patch.citationLikelihood !== undefined ? patch.citationLikelihood : gap.citationLikelihood;
    // If patch touches any priority input, recompute; also if all three now present
    if (patch.demandPotential !== undefined || patch.credibilityImpact !== undefined || patch.citationLikelihood !== undefined) {
      data.priorityScore = computePriorityScore(demand as number | null, credibility as number | null, citation as number | null);
    }

    const updated = await this.prisma.gap.update({ where: { id: gapId }, data });
    return updated;
  }

  /**
   * Roadmap grouped by action, sorted by priorityScore desc (nulls last).
   */
  async getRoadmap(projectId: string) {
    const analysis = await this.prisma.gapAnalysis.findUnique({ where: { projectId } });
    if (!analysis) return { projectId, groups: [], total: 0 };

    const gaps = await this.prisma.gap.findMany({ where: { gapAnalysisId: analysis.id } });

    const groups: Record<GapAction, typeof gaps> = { fix: [], build: [], influence: [] } as any;
    for (const gap of gaps) {
      const action = gap.action as GapAction;
      if (!groups[action]) (groups as any)[action] = [];
      (groups[action] as any).push(gap);
    }

    const sortByPriority = (a: any, b: any) => {
      if (a.priorityScore != null && b.priorityScore != null) return b.priorityScore - a.priorityScore;
      if (a.priorityScore != null) return -1;
      if (b.priorityScore != null) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    };

    const result = (Object.keys(groups) as GapAction[]).map((action) => {
      const sorted = [...(groups[action] || [])].sort(sortByPriority);
      return { action, gaps: sorted, count: sorted.length };
    });

    // Most actionable first: fix, then build, then influence
    const order: GapAction[] = ['fix', 'build', 'influence'];
    result.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));

    return { projectId, groups: result, total: gaps.length };
  }
}
