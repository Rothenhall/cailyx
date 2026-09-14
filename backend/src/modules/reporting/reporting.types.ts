/**
 * Reporting Types — Branded diagnostic report data shapes.
 *
 * A report aggregates: technical-audit findings, entity-audit schema checks,
 * gap-analysis roadmap, the PRD §8 weighted score rubric, and (2026-09-13)
 * the project's latest DataForSEO backlinks snapshot.
 *
 * @module reporting.types
 */

import type { BacklinksSummaryDto } from '../backlinks/backlinks.types';

// ─── PRD §8 Score rubric ───────────────────────────────────────

export interface SubScore {
  dimension: string;
  weight: number;
  /** 0-100 sub-score */
  value: number;
  /** weighted contribution to total */
  contribution: number;
  evidence: string[];
  /** FR-8.4: evidence source missing — dimension scored 0 and flagged. */
  partial?: boolean;
  partialReason?: string;
}

export interface ScoreSummary {
  total: number;
  band: ScoreBand;
  subScores: SubScore[];
  /** Versioned rubric used (FR-8.2). */
  rubricVersion: number;
}

/** PRD §8 bands: 0-40 invisible, 41-60 faint, 61-80 present, 81-100 recommended. */
export type ScoreBand = 'invisible' | 'faint' | 'present' | 'recommended';

// ─── Report content ────────────────────────────────────────────

export type ReportVisibility = 'private' | 'public';

export interface ReportData {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  targetUrl: string;
  visibility: 'private' | 'public';
  executiveSummary: string;
  scoreTotal: number;
  scoreBand: ScoreBand;
  subScores: SubScore[];
  findings: ReportFindingDto[];
  roadmap: ReportRoadmapDto[];
  /** Stage 12 "Prioritized Growth Roadmap": null when neither strategy nor findings has run yet for this project. */
  growthPlan: GrowthPlanDto | null;
  /** Latest DataForSEO backlinks snapshot for this project's domain — null when `POST .../backlinks/refresh` has never been run. Never pulled fresh by report generation itself (read-only, same discipline as growthPlan). */
  backlinks: BacklinksSummaryDto | null;
  createdAt: string;
}

export interface ReportFindingDto {
  type: string;
  status: string;
  severity: string;
  confidence: string;
  detail: Record<string, unknown>;
  recommendedFix: string;
  reproductionCommands: Array<{ bot: string; command: string; expectedResult: string }> | null;
  createdAt: string;
}

export interface ReportRoadmapDto {
  dimension: string;
  action: string;
  title: string;
  description: string;
  severity: string | null;
  priorityScore: number | null;
  status: string;
}

// ─── Stage 12 "Prioritized Growth Roadmap" ─────────────────────
// The flowchart's Final-Output branch: Issue+Evidence, Recommended Action,
// Priority and Implementation Guidance, rolled into one ranked roadmap.
// "Business/Search Impact" is `Gap.impactScore`/severity (already in
// `roadmap` above); "Recommended/Generated Asset" is stage 11, not built —
// `assetsNote` says so honestly rather than inventing an empty array.

/** One stage-9 recommendation category — "Recommended Action" + "Priority" (`priorityRank`, quick-wins-first). */
export interface GrowthRecommendationDto {
  category: string;
  label: string;
  title: string;
  summary: string;
  priorityRank: number;
  quickWinCount: number;
  majorProjectCount: number;
  fillInCount: number;
  thanklessTaskCount: number;
  gapIds: string[];
}

/** One stage-8 LLM-authored finding — "Issue + Evidence" in both client (executive) and technical registers. "Implementation Guidance" = the fix fields. */
export interface GrowthFindingDto {
  gapId: string | null;
  title: string;
  whatExecutive: string;
  whatTechnical: string;
  whyExecutive: string;
  whyTechnical: string;
  fixExecutive: string;
  fixTechnical: string;
  thinRun: boolean;
  disclosedGap: string | null;
}

export interface GrowthPlanDto {
  /** null when `strategy.buildActionPlan()` has never been run for this project. */
  actionPlan: {
    recommendations: GrowthRecommendationDto[];
    notCovered: string[];
    updatedAt: string;
  } | null;
  /** Empty (not null) when `findings.generate()` has never been run — a report can still show the roadmap without LLM copy. */
  findingsCopy: GrowthFindingDto[];
  /** Honest note: stage 11 "Marketing & Growth Execution" (blog topics, ad angles, generated assets) has no module yet. */
  assetsNote: string;
}

// ─── Branding (FR-10.4) ────────────────────────────────────────

export interface BrandingConfig {
  orgName: string;
  logoUrl?: string;
  tagline?: string;
  palette?: {
    primary?: string;
    accent?: string;
  };
}