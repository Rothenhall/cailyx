/**
 * AEO Visibility — read-composition types for the merged "AI visibility"
 * screen (platform_improvement_plan.md §8).
 *
 * "Client-facing" in that plan section describes the *content* (a screen a
 * client can be shown), not this route's audience: the reads live on
 * `projects/:projectId/aeo`, which carries no `@ClientPortal()` marker, so
 * `RolesGuard` refuses a client account on every one of them. Clients reach AEO
 * numbers through the portal results read, which is aggregate-only. Nothing
 * here widens that — see the `rawAnswer` note on
 * {@link QuestionObservationResult}.
 *
 * This module adds **no new measurement**. Every number here is composed from
 * data `aeo-audit` already stores (AeoAudit/AeoSurfaceRun/AeoStance, and
 * `measurement`'s Observation, joined through the QuerySet/QuerySetItem the
 * matrix already versions). The composition exists to answer three client
 * questions from ONE read each — summary, customer questions, history — without
 * duplicating Competitors' own comparison tables (§8.3) and without silently
 * dropping a failed surface/market from the denominator (§8.4).
 *
 * @module aeo-visibility.types
 */

import type { AeoSurface, PromptDimension, Stance, SurfaceRunStatus } from './aeo-audit.types';

/** One observed answer, kept apart per surface/market — never averaged away. */
export interface QuestionObservationResult {
  surface: AeoSurface;
  label: string;
  /** The surface that actually answered, when different (fallback). Never hidden. */
  attemptedVia: AeoSurface | null;
  market: string | null;
  mentioned: boolean;
  cited: boolean;
  /**
   * The source the answer cited, when it cited one — §8.1's "safe explanation/
   * source reference". This is a public URL the answer itself pointed at, not
   * model output: the raw answer (`Observation.rawAnswer`) stays staff-only and
   * is never part of this read, so merging the prompt-detail page cannot widen
   * what a client audience sees.
   */
  sourceUrl: string | null;
  /** Judged stance for this exact observation, when the stance pass has run. */
  stance: Stance | null;
  checkedAt: string;
}

/** One customer question — a stable QuerySetItem — with its observed results. */
export interface CustomerQuestion {
  id: string;
  prompt: string;
  topic: PromptDimension | null;
  topicLabel: string;
  funnelStage: string;
  branding: 'branded' | 'unbranded' | null;
  /** False when nothing has measured this question yet — "Not checked", never a fabricated 0. */
  checked: boolean;
  attempts: number;
  appearedCount: number;
  /** null when the stance pass has not run for this audit — never fabricated as 0. */
  recommendedCount: number | null;
  checkedAt: string | null;
  results: QuestionObservationResult[];
}

export interface CustomerQuestionsPage {
  auditId: string;
  querySetId: string;
  querySetVersion: number;
  querySetStatus: string;
  topic: PromptDimension | null;
  items: CustomerQuestion[];
  pageInfo: {
    total: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

/** Denominator-truth methodology record — kept in full even though the UI simplifies it. */
export interface VisibilityMethodology {
  surfaces: Array<{
    surface: AeoSurface;
    label: string;
    status: SurfaceRunStatus;
    market: string | null;
    accessMode: 'api' | 'browser-automation' | 'test-only';
    failureKind: string | null;
  }>;
  questionSetVersion: number;
  questionSetId: string;
  samplingConfig: { tier: string; runCount: number };
  markets: string[];
}

export interface VisibilitySummary {
  auditId: string;
  status: string;
  generatedAt: string | null;
  period: { startedAt: string | null; finishedAt: string | null };
  markets: string[];
  /** Plain-English headline, e.g. "Your business appeared in 18 of 40 answers we checked." */
  headline: string;
  /** Appeared and recommended are kept as separate counts — never conflated (§8.2). */
  appeared: { count: number; of: number; rateValid: boolean };
  recommended: { count: number; of: number; rateValid: boolean } | null;
  questionsChecked: number;
  totalQuestions: number;
  /** Named surfaces/markets that failed or were gated — never silently dropped. */
  disclosedFailures: Array<{ surface: AeoSurface; label: string; market: string | null; reason: string }>;
  methodology: VisibilityMethodology;
  /** Facts-only plain-language lines, reused from the underlying verdict. */
  headlines: string[];
}

export interface VisibilityHistoryEntry {
  auditId: string;
  querySetId: string;
  querySetVersion: number;
  generatedAt: string | null;
  finishedAt: string | null;
  markets: string[];
  status: string;
  questionsChecked: number;
  totalQuestions: number;
  /**
   * `null` when this measurement checked no questions at all (§8.4: "Not
   * checked"). A `{count: 0, of: 0}` pair would read as a measured zero-
   * appearance rate against a real denominator, which is exactly the
   * fabrication this field refuses to make.
   */
  appeared: { count: number; of: number } | null;
  /** True when this entry's question-set version differs from the prior entry's. */
  comparabilityBreak: boolean;
  comparabilityNote: string | null;
  disclosedFailures: Array<{ surface: AeoSurface; label: string; market: string | null; reason: string }>;
}
