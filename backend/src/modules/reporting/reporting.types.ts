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
import type { PresenceInventory } from '../digital-presence/presence.types';
import type { GapResult } from '../competitors/competitors.service';

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
  /** Social/directory presence inventory (2026-09-14) — accounts found, verification state, expected-platform gaps. Read-only, computed from whatever digital-presence discovery has already run; never triggers a fresh crawl. */
  presence: PresenceInventory | null;
  /** Competitor landscape (2026-09-14): tech/schema/presence diffs plus each tracked rival's SEO score and content signals. Null when the project has no tracked competitors yet. Read-only, same discipline as backlinks/growthPlan. */
  competitors: GapResult | null;
  createdAt: string;

  // ─── G05 — editorial lifecycle ────────────────────────────────

  /**
   * The report's editorial state. Deliberately a **different axis** from
   * `visibility` above: `visibility` is "may anyone with the URL read the
   * HTML", `status` is "has this been reviewed and released to its client"
   * (§6.4, G19/D10). Revoking a public link never un-releases a report, and
   * releasing never mints a public link.
   */
  status: ReportEditorialStatus;
  /**
   * `ReportRevision.revision` the client is currently shown. Null when
   * nothing is released (never released, or the released revision was
   * withdrawn).
   *
   * Note this is NOT derived from `status` alone: while a newer revision is
   * being prepared, `status` stays `released` and this keeps pointing at the
   * version the client is still reading. See the README's state machine.
   */
  releasedRevision: number | null;
  releasedAt: string | null;
  releasedBy: string | null;
  /** EvidenceManifest pinned at generation (G13) — null when pinning failed; a report without one is valid, its sources are simply not frozen. */
  manifestId: string | null;
  /**
   * D11 — the rubric and score run behind `scoreTotal`, read back from the
   * report's pinned evidence manifest.
   *
   * Both are null for a report generated before 2026-09-16 (the linkage was
   * not recorded then) or one whose manifest pinning failed. They are never
   * inferred from "the project's latest ScoreRun" — that would be a guess
   * about provenance, which is exactly what this field exists to avoid.
   */
  rubricVersion: number | null;
  scoreRunId: string | null;
}

/**
 * A released report as the **client** may read it.
 *
 * Shaped as `ReportData` on purpose — the client-facing screens already render
 * that shape, and a released report is the same document with the same
 * sections. What makes it different is where the values come from: every
 * content field is read from the frozen `ReportRevision.snapshot`, never from
 * the mutable `Report` row, and `revision`/`snapshotAt` say which frozen
 * revision this is. `status` is always `"released"`.
 */
export interface ReleasedReportDto extends ReportData {
  /** Which revision this frozen payload is. */
  revision: number;
  /** When the snapshot was locked (review-lock time) — distinct from every source date inside it and from `releasedAt`. */
  snapshotAt: string;
  /**
   * P15 — the frozen Cailyx score family section, straight out of
   * `ReportRevision.snapshot`. Never recomputed at read time, so a live score
   * update after release cannot change what this report says. Null for a
   * revision released before P15.
   */
  digitalPerformance: ReportDigitalPerformanceSection | null;
  /** P15 — the frozen 30-day plan progress section. Same freeze discipline. */
  planProgress: ReportPlanProgressSection | null;
}

/** One row of the client's released-report list. */
export interface ReleasedReportSummaryDto {
  reportId: string;
  projectId: string;
  slug: string;
  title: string;
  revision: number;
  scoreTotal: number;
  scoreBand: ScoreBand;
  releasedAt: string | null;
  /** When the frozen content was assembled — older than `releasedAt` when a review round trip happened. */
  contentUpdatedAt: string;
  /**
   * P15 — carried on the summary so the Overview's report panel can show what
   * the released report says without a second read, and without ever touching
   * the live score tables. Null when the revision predates P15.
   */
  digitalPerformance?: ReportDigitalPerformanceSection | null;
  planProgress?: ReportPlanProgressSection | null;
}

export interface ReportFindingDto {
  type: string;
  /** Display name for the Findings table — distinct from `type` only where a
   * generic slug (e.g. "schema") would otherwise read as the SAME check that
   * appears elsewhere in the report under a different verdict (entity-audit's
   * own, more lenient schema check). See FINDING_TYPE_LABELS. */
  label: string;
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

/** D11 — what the growth-execution module held for this project at snapshot time. Counts only; never a fabricated asset. */
export interface GrowthAssetCountsDto {
  total: number;
  recommended: number;
  inProgress: number;
  published: number;
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
  /**
   * What this report does and does not cover from stage 11 ("Marketing &
   * Growth Execution").
   *
   * D11 corrected this on 2026-09-16: the previous sentence — "has no module
   * yet" — was true when it was written and is false now, because the
   * `growth-execution` module exists and holds real assets (briefs, and
   * article/ad-copy bodies). It said nothing false about the *client's* data,
   * but it did misstate the system, so it is repaired rather than kept.
   * Reports generated before that date still carry the old sentence in their
   * stored snapshot; {@link assetsNoteCorrected} marks the read-time repair.
   */
  assetsNote: string;
  /**
   * Counts by `GrowthAsset.status` for this project, read (never written) at
   * generation time. `null` when the lookup failed — which is disclosed as
   * unrecorded rather than rendered as zero. Assets themselves are still not
   * copied into the report: that is G09/G13's approved-plan section, and this
   * report says so instead of implying the section is empty because nothing
   * exists.
   */
  growthAssets?: GrowthAssetCountsDto | null;
  /**
   * True when the stored note was the pre-2026-09-16 sentence and has been
   * replaced on read. Set by the reader, never stored — the snapshot on disk
   * is left byte-identical.
   */
  assetsNoteCorrected?: boolean;
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

// ─── G05 — Editorial lifecycle ─────────────────────────────────
// State machine (design_plan.md §8.3), as implemented:
//
//   (no revision) --review()--> in-review --approve(approved)--> approved --publish()--> released
//   in-review --approve(changes-requested)--> draft --review()--> in-review (same revision, re-locked)
//   released --withdraw(reason)--> withdrawn
//   released --review()+publish() of a NEW revision--> new revision released,
//                                                      the old one is superseded
//
// `Report.status` is the report's *summary* state and is deliberately sticky
// once released: while a newer revision is being prepared, the report stays
// `released` and `Report.releasedRevision` keeps pointing at the version the
// client is still reading. Flipping it back to `draft` there would hide a
// live report from the client, which is the bug G05 exists to prevent. The
// in-progress revision's own state lives on `ReportRevision.status`, and is
// surfaced separately on {@link ReportLifecycleDto}.

/** Mirrors `Report.status` / `ReportRevision.status` — see state machine above. */
export type ReportEditorialStatus = 'draft' | 'in-review' | 'approved' | 'released' | 'withdrawn';

/** Mirrors `ReportRevision.status` specifically (adds `superseded`, not a `Report.status` value). */
export type ReportRevisionStatus = ReportEditorialStatus | 'superseded';

// ─── P15 — frozen score-family and plan sections (§14.5 items 2 and 8) ───────

/**
 * One bucket as it was **at release time**.
 *
 * §14.6's freeze rule is why this type exists rather than the live
 * `ScoreBucketRun` row being read on demand: "A released report's score,
 * breakdown and figures must stay identical after later live-score updates and
 * after a new draft revision is created." A released report therefore carries
 * its own copy of every bucket, and reading the report never re-reads the score
 * family's tables.
 */
export interface ReportScoreBucketSnapshot {
  key: string;
  label: string;
  weight: number;
  applicability: string;
  applicabilityReason: string | null;
  state: string;
  /** Client-safe label for `state` (§4.3) — the same words the live Results screen uses. */
  stateLabel: string;
  /** null when the bucket was not measured. Never 0-by-substitution. */
  value: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  missingReasons: string[];
  notes: string[];
  /** Source names and ages only — internal record handles are dropped at this boundary (§4.6). */
  sources: Array<{ kind: string; label: string; observedAt: string | null; ageDays: number | null }>;
}

/**
 * §14.5 item 2 — "Cailyx score snapshot plus buckets" — frozen at release.
 *
 * The field names deliberately mirror the live client-safe score read
 * (`DigitalPerformanceService.getClientSafe`) so the same screen component can
 * render both, with the live/report distinction made by the surrounding label
 * rather than by a second set of field names.
 */
export interface ReportDigitalPerformanceSection {
  family: string;
  scoreName: string;
  methodology: { version: number; label: string; weightsApproved: boolean; approvalNote: string };
  /** The run that was live at release time. Null when no run existed — then `total` is null too. */
  runId: string | null;
  runAt: string | null;
  /** `complete` | `incomplete` | `none`. */
  status: string;
  /** Null whenever `status !== "complete"`; a frozen partial sum would be a fake total. */
  total: number | null;
  evidenceCoverage: number | null;
  coverageMeaning: string;
  buckets: ReportScoreBucketSnapshot[];
  missingAreas: string[];
  excludedFromScore: Array<{ key: string; label: string; reason: string | null }>;
  /** Always the snapshot lock time, so a reader can tell release time from measurement time. */
  frozenAt: string;
}

/** One commitment as it was at release time (§14.5 item 8's progress section). */
export interface ReportCommitmentSnapshot {
  id: string;
  title: string;
  workstream: string;
  status: string;
  targetDate: string | null;
  progressLabel: string;
}

/** §14.5 item 8 — the 30-day plan's progress, frozen at release. */
export interface ReportPlanProgressSection {
  totalCount: number;
  completedCount: number;
  /** Rendered verbatim: "3 of 5 commitments completed". */
  label: string;
  commitments: ReportCommitmentSnapshot[];
  windowStart: string | null;
  windowEnd: string | null;
  frozenAt: string;
}

/**
 * The frozen payload written into `ReportRevision.snapshot` exactly once, at
 * `review()` time (when the revision is locked for QA) — never mutated
 * afterward, including across `approve`/`publish`. Deliberately everything
 * a client reading a released revision needs, and nothing that lives on the
 * mutable `Report` row (id/slug/visibility/status pointer).
 */
export interface ReportRevisionSnapshot {
  title: string;
  targetUrl: string;
  executiveSummary: string;
  scoreTotal: number;
  scoreBand: ScoreBand;
  subScores: SubScore[];
  findings: ReportFindingDto[];
  roadmap: ReportRoadmapDto[];
  growthPlan: GrowthPlanDto | null;
  backlinks: BacklinksSummaryDto | null;
  presence: PresenceInventory | null;
  competitors: GapResult | null;
  branding: BrandingConfig | null;
  /**
   * §6.2 item 5 / D11 — the rubric and the exact ScoreRun the frozen score
   * came from, so a reader can tell a score movement from a rubric change.
   * Null when the report's evidence manifest was not pinned (the linkage was
   * simply not recorded — never guessed).
   */
  rubricVersion: number | null;
  scoreRunId: string | null;
  /** The manifest pinned at generation; copied here so the snapshot names its own evidence. */
  manifestId: string | null;
  /** G13 window/cohort in force, when the report was generated with them pinned. */
  periodId: string | null;
  cohortId: string | null;
  /**
   * P15 / §14.5 item 2 — the Cailyx score family's buckets as they stood when
   * this revision was frozen. Null for a snapshot written before P15.
   *
   * This is a **copy**, not a reference: after release, later live score runs
   * (including a new methodology version) must leave this byte-identical.
   */
  digitalPerformance?: ReportDigitalPerformanceSection | null;
  /** P15 / §14.5 item 8 — the 30-day plan's progress, frozen the same way. */
  planProgress?: ReportPlanProgressSection | null;
  /** `Report.createdAt`/`updatedAt` at lock time: when the *content* was last written by generation. */
  contentCreatedAt: string;
  contentUpdatedAt: string;
  /** When this snapshot was locked (review-lock time), distinct from the content's own dates and from every source date inside it. */
  snapshotAt: string;
}

export interface ReportRevisionDto {
  id: string;
  reportId: string;
  revision: number;
  status: ReportRevisionStatus;
  title: string | null;
  manifestId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  decision: string | null;
  decisionNote: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  withdrawnAt: string | null;
  supersededBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRevisionDetailDto extends ReportRevisionDto {
  snapshot: ReportRevisionSnapshot;
}

export interface ShareLinkDto {
  id: string;
  reportId: string;
  revisionId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdBy: string | null;
  createdAt: string;
}

/**
 * Returned only once, on creation — the raw token is never stored or
 * retrievable again, and neither is a link that contains it.
 */
export interface ShareLinkCreatedDto extends ShareLinkDto {
  /** The raw capability. Only its sha256 is persisted. */
  token: string;
  /** Path the token opens, relative to the API origin (absolute URL shown to the operator by the UI). */
  url: string;
}

export interface DeliveryAttemptDto {
  id: string;
  reportId: string;
  revisionId: string | null;
  /** email | link-share | manual */
  channel: string;
  recipient: string;
  subject: string | null;
  /**
   * queued | sent | failed. `sent` means the **provider accepted** the
   * message — never "the client received it". Release state and send result
   * are separate facts and a failed send never rolls back a release.
   */
  status: string;
  error: string | null;
  attemptedBy: string | null;
  attemptedAt: string;
}

/**
 * The operator's view of both axes at once (RP04).
 *
 * Split deliberately: `status`/`releasedRevision` describe the editorial axis,
 * `visibility` (on {@link ReportData}) describes public sharing, and
 * `inFlightRevision` describes the version being prepared while an older one
 * is still live. Reading any one of them as another is the specific mistake
 * §6.4 and G19/D10 warn about.
 */
export interface ReportLifecycleDto {
  reportId: string;
  slug: string;
  /** `Report.status` — the sticky summary state (see the state machine note above). */
  status: ReportEditorialStatus;
  /** Public link on/off. A different axis from `status`, always. */
  visibility: 'private' | 'public';
  releasedRevision: number | null;
  releasedAt: string | null;
  releasedBy: string | null;
  /** Newest revision not yet released — the one review()/approve() act on. Null when every revision is released/superseded/withdrawn. */
  inFlightRevision: ReportRevisionDto | null;
  /** Every revision, newest first. Released/withdrawn/superseded snapshots are immutable. */
  revisions: ReportRevisionDto[];
  /** Release gate disclosure (G10): what, if anything, would refuse a publish right now. Null when nothing blocks. */
  publishBlocked: { reason: string; message: string } | null;
}