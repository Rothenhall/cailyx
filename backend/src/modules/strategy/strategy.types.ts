/**
 * Strategy Types — stage 9, "Strategy & Recommendations".
 *
 * Reads gap-analysis's consolidated, categorised, impact/effort-scored gaps
 * (stage 8) and groups the actionable ones (issue/gap/opportunity/risk —
 * never a strength, which has nothing to act on) into the nine
 * recommendation buckets the flowchart draws, sequenced into one action plan.
 *
 * @module strategy.types
 */

import type { RecommendationCategory } from '../gap-analysis/gap-analysis.types';

export interface RecommendationDto {
  id: string;
  category: RecommendationCategory;
  label: string;
  title: string;
  summary: string;
  /** The Gap ids this recommendation bundles — the plan points at gap-analysis's own rows rather than copying their text. */
  gapIds: string[];
  quickWinCount: number;
  majorProjectCount: number;
  fillInCount: number;
  thanklessTaskCount: number;
  /** 1 = act on first, ranked across the whole plan. */
  priorityRank: number;
  createdAt: string;
}

export interface ActionPlanDto {
  id: string;
  projectId: string;
  recommendations: RecommendationDto[];
  /** Gaps with no evidence to act on yet (no completed audit for that source) — named, not hidden. */
  notCovered: RecommendationCategory[];
  createdAt: string;
  updatedAt: string;
}
