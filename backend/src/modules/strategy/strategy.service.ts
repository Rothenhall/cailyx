/**
 * Strategy Service — stage 9, "Strategy & Recommendations".
 *
 * "Create Action Plan": take gap-analysis's stage-8 output (already
 * consolidated, categorised, impact/effort-scored) and group every
 * actionable gap into the nine recommendation buckets the flowchart draws.
 * This module owns sequencing and client-facing framing; it never re-derives
 * evidence — gap-analysis is the only place that reads the other audit
 * modules' raw data.
 *
 * Strengths are excluded on purpose: `recommendationCategory` is null on
 * every strength row (gap-analysis.types.ts), because there is nothing to
 * act on. A strategy is a set of things to DO.
 *
 * @module strategy.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GapAnalysisService } from '../gap-analysis/gap-analysis.service';
import {
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_LABELS,
  type RecommendationCategory,
} from '../gap-analysis/gap-analysis.types';
import type { ActionPlanDto, RecommendationDto } from './strategy.types';

interface BundledGap {
  id: string;
  title: string;
  quadrant: string | null;
  impactScore: number | null;
}

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gapAnalysis: GapAnalysisService,
  ) {}

  /**
   * Build (or rebuild) the action plan from the project's current gaps.
   *
   * Runs `gapAnalysisService.sync()` first so the plan reflects the latest
   * evidence every module has — never a snapshot the operator forgot to
   * refresh. Idempotent: re-running replaces each category's recommendation
   * in place and removes any category that no longer has a gap.
   */
  async buildActionPlan(projectId: string): Promise<ActionPlanDto> {
    const { gaps } = await this.gapAnalysis.sync(projectId);

    const byCategory = new Map<RecommendationCategory, BundledGap[]>();
    for (const g of gaps) {
      const cat = g.recommendationCategory as RecommendationCategory | null;
      if (!cat || g.category === 'strength') continue; // nothing to act on
      const list = byCategory.get(cat) ?? [];
      list.push({ id: g.id, title: g.title, quadrant: g.quadrant, impactScore: g.impactScore });
      byCategory.set(cat, list);
    }

    const plan = await this.prisma.actionPlan.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
    });

    // Rank categories with a quick win first, then by total impact, then
    // alphabetically — "do the cheap high-value work first" is the whole
    // point of scoring impact/effort in the first place.
    const ranked = [...byCategory.entries()]
      .map(([category, bundled]) => ({ category, bundled, ...this.countQuadrants(bundled) }))
      .sort((a, b) => {
        if (a.quickWinCount !== b.quickWinCount) return b.quickWinCount - a.quickWinCount;
        if (a.totalImpact !== b.totalImpact) return b.totalImpact - a.totalImpact;
        return a.category.localeCompare(b.category);
      });

    const recommendations: RecommendationDto[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const { category, bundled, quickWinCount, majorProjectCount, fillInCount, thanklessTaskCount } = ranked[i];
      const priorityRank = i + 1;
      const { title, summary } = this.describe(category, bundled, quickWinCount, majorProjectCount);

      const row = await this.prisma.recommendation.upsert({
        where: { actionPlanId_category: { actionPlanId: plan.id, category } },
        create: {
          actionPlanId: plan.id,
          category,
          title,
          summary,
          gapIds: JSON.stringify(bundled.map((b) => b.id)),
          quickWinCount,
          majorProjectCount,
          fillInCount,
          thanklessTaskCount,
          priorityRank,
        },
        update: {
          title,
          summary,
          gapIds: JSON.stringify(bundled.map((b) => b.id)),
          quickWinCount,
          majorProjectCount,
          fillInCount,
          thanklessTaskCount,
          priorityRank,
        },
      });
      recommendations.push(this.toDto(row));
    }

    // A category no longer backed by any gap (the underlying issue was
    // fixed, or the source data disappeared) is removed rather than left
    // stale — a recommendation with zero live gaps is not a real one.
    const liveCategories = new Set(ranked.map((r) => r.category));
    const existing = await this.prisma.recommendation.findMany({ where: { actionPlanId: plan.id }, select: { id: true, category: true } });
    for (const row of existing) {
      if (!liveCategories.has(row.category as RecommendationCategory)) {
        await this.prisma.recommendation.delete({ where: { id: row.id } });
      }
    }

    const notCovered = RECOMMENDATION_CATEGORIES.filter((c) => !liveCategories.has(c));

    this.logger.log(`Action plan built for ${projectId}: ${recommendations.length} recommendation(s), ${notCovered.length} category(ies) with no gap`);

    return {
      id: plan.id,
      projectId,
      recommendations,
      notCovered,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Latest stored action plan, or null when none has been built yet. */
  async getActionPlan(projectId: string): Promise<ActionPlanDto | null> {
    const plan = await this.prisma.actionPlan.findUnique({
      where: { projectId },
      include: { recommendations: { orderBy: { priorityRank: 'asc' } } },
    });
    if (!plan) return null;

    const liveCategories = new Set(plan.recommendations.map((r) => r.category));
    const notCovered = RECOMMENDATION_CATEGORIES.filter((c) => !liveCategories.has(c));

    return {
      id: plan.id,
      projectId,
      recommendations: plan.recommendations.map((r) => this.toDto(r)),
      notCovered,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private countQuadrants(bundled: BundledGap[]) {
    let quickWinCount = 0;
    let majorProjectCount = 0;
    let fillInCount = 0;
    let thanklessTaskCount = 0;
    let totalImpact = 0;
    for (const g of bundled) {
      if (g.quadrant === 'quick-win') quickWinCount++;
      else if (g.quadrant === 'major-project') majorProjectCount++;
      else if (g.quadrant === 'fill-in') fillInCount++;
      else if (g.quadrant === 'thankless-task') thanklessTaskCount++;
      totalImpact += g.impactScore ?? 0;
    }
    return { quickWinCount, majorProjectCount, fillInCount, thanklessTaskCount, totalImpact };
  }

  /**
   * Deterministic, template-based copy — no LLM in the loop. Every fact in
   * the summary (counts, the named top gap) is read straight off the bundled
   * gaps, never generated prose that could drift from the evidence.
   */
  private describe(
    category: RecommendationCategory,
    bundled: BundledGap[],
    quickWinCount: number,
    majorProjectCount: number,
  ): { title: string; summary: string } {
    const label = RECOMMENDATION_LABELS[category];
    const title = `${label}: ${bundled.length} item${bundled.length === 1 ? '' : 's'} identified`;

    const top = [...bundled].sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];
    const parts: string[] = [];
    if (quickWinCount > 0) parts.push(`${quickWinCount} quick win${quickWinCount === 1 ? '' : 's'}`);
    if (majorProjectCount > 0) parts.push(`${majorProjectCount} major project${majorProjectCount === 1 ? '' : 's'}`);
    const countLine = parts.length > 0 ? parts.join(' and ') : `${bundled.length} item${bundled.length === 1 ? '' : 's'} to plan for`;
    const summary = top ? `${countLine}. Highest priority: ${top.title}.` : `${countLine}.`;

    return { title, summary };
  }

  private toDto(row: {
    id: string;
    category: string;
    title: string;
    summary: string;
    gapIds: string;
    quickWinCount: number;
    majorProjectCount: number;
    fillInCount: number;
    thanklessTaskCount: number;
    priorityRank: number;
    createdAt: Date;
  }): RecommendationDto {
    let gapIds: string[] = [];
    try {
      gapIds = JSON.parse(row.gapIds) as string[];
    } catch {
      gapIds = [];
    }
    const category = row.category as RecommendationCategory;
    return {
      id: row.id,
      category,
      label: RECOMMENDATION_LABELS[category],
      title: row.title,
      summary: row.summary,
      gapIds,
      quickWinCount: row.quickWinCount,
      majorProjectCount: row.majorProjectCount,
      fillInCount: row.fillInCount,
      thanklessTaskCount: row.thanklessTaskCount,
      priorityRank: row.priorityRank,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
