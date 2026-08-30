/**
 * Reporting Types — Branded diagnostic report data shapes.
 *
 * A report aggregates: technical-audit findings, entity-audit schema checks,
 * gap-analysis roadmap, and the PRD §8 weighted score rubric.
 *
 * @module reporting.types
 */

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