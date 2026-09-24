/**
 * ReportDocument — the one data model behind **both** rendered outputs.
 *
 * The report is rendered twice: as a branded HTML page
 * (`templates/report-html.hbs`, via `ReportingService.renderHtml`) and as a
 * paginated PDF (`report-pdf.ts`, via `ReportingService.renderPdf`). Two
 * layouts over one document is a drift surface — the HTML template and the PDF
 * component tree would each independently decide *which sections exist*,
 * *what an absent section says* and *whether a blank metric means zero* — and
 * the two answers would diverge the first time one of them was edited.
 *
 * This module is the single place those questions are answered. Both renderers
 * read the same `ReportDocument` and are reduced to presentation:
 *
 *   - **Order and membership** — {@link ReportDocument.sections}, computed once
 *     from the view (`executive` | `detailed`). Neither renderer contains a
 *     view rule or a section list.
 *   - **Presence and absence wording** — {@link ReportDocument.decisions}. A
 *     renderer never asks "is `presence` null?"; it asks
 *     `decisions.presence` and draws the section, or the sentence that
 *     explains its omission. **Absence is stated, never implied** (§6.4): a
 *     section whose source never ran is named as missing, so a document cannot
 *     look complete by silently dropping it.
 *   - **Units and provenance** (§6.3) — every value is formatted here, with its
 *     unit, and an unmeasured value prints as an explicit absence rather than
 *     `0` or an empty cell. Credits are not currency; percentage points are not
 *     relative percentages; "not measured" is never zero.
 *
 * Nothing in this file renders, and nothing here touches Prisma: it is a pure
 * function of `ReportData`. It reads the *same* source the HTML render reads —
 * for a released report that is the frozen `ReportRevisionSnapshot` dressed
 * with its release stamps — so a PDF and an HTML page of the same revision
 * differ only in markup.
 *
 * @module report-document
 */

import type {
  BrandingConfig,
  ReportData,
  ReportFindingDto,
  ReportRoadmapDto,
  ScoreBand,
  SubScore,
} from './reporting.types';
import type { BacklinksSummaryDto } from '../backlinks/backlinks.types';
import type { PresenceInventory } from '../digital-presence/presence.types';
import type { GapResult } from '../competitors/competitors.service';
import type { AeoVerdict } from '../aeo-audit/aeo-audit.types';
import type { ReportProgressSection } from '../progress/progress.types';
import { niceMax } from '../progress/progress-format';

// ─── Views and sections ─────────────────────────────────────────

/**
 * §6.1's reading hierarchy. The executive view is the opening read; the
 * detailed view adds the section index and the discipline-level sections.
 */
export type ReportView = 'executive' | 'detailed';

/** Which surface is being rendered — only affects the notices a footer states. */
export type ReportSurface = 'web' | 'pdf';

/**
 * Who is going to read this render.
 *
 * `operator` is an authenticated preview (the caller proved an operator token,
 * or is reading their own project's row). `client-facing` is everyone else: the
 * client's portal, a share-token link, or an anonymous reader of a
 * `visibility: public` URL.
 *
 * The distinction exists for disclosure, not for access — access is already
 * decided before a document is built. §6.4 excludes internal state from the
 * public projection, so a reader outside the agency is not told which draft
 * stage an unreleased report is at, nor which operator released it.
 */
export type ReportAudience = 'operator' | 'client-facing';

export type ReportSectionId =
  | 'scoreBreakdown'
  | 'progress'
  | 'findings'
  | 'roadmap'
  | 'presence'
  | 'aeoVisibility'
  | 'competitors'
  | 'growthPlan'
  | 'backlinks';

/**
 * Every render-time decision, as a flat map.
 *
 * Keys are deliberately dot-free camelCase so the Handlebars template can read
 * them with the same path syntax the PDF reads with property access:
 * `{{#if decisions.backlinksTop.present}}` and
 * `decisions.backlinksTop.present` are the same decision.
 *
 * `section.*` keys control a whole section (heading included); the rest control
 * a named part *inside* a section whose heading is always drawn — a table, a
 * metric row — where the honest answer to "nothing here" is a sentence rather
 * than a silently empty block.
 */
export interface ReportDecisions {
  scoreBreakdown: ReportDecision;
  progress: ReportDecision;
  findings: ReportDecision;
  findingsTable: ReportDecision;
  roadmap: ReportDecision;
  roadmapTable: ReportDecision;
  presence: ReportDecision;
  presenceAccounts: ReportDecision;
  presenceGaps: ReportDecision;
  aeoVisibility: ReportDecision;
  aeoVisibilityLosing: ReportDecision;
  competitors: ReportDecision;
  competitorsTable: ReportDecision;
  competitorsOnly: ReportDecision;
  growthPlan: ReportDecision;
  growthPlanActionPlan: ReportDecision;
  growthPlanFindingsCopy: ReportDecision;
  backlinks: ReportDecision;
  backlinksMetrics: ReportDecision;
  backlinksTop: ReportDecision;
}

export type ReportDecisionKey = keyof ReportDecisions;

export interface ReportDecision {
  /** True when there is content to draw. False means draw `note` instead — or nothing, when `note` is null. */
  present: boolean;
  /**
   * The sentence shown in place of the content when `present` is false.
   *
   * `null` means "draw nothing at all", which only happens when the section is
   * outside this view (findings in the executive read) — a section that is
   * genuinely absent always carries its explanation here.
   */
  note: string | null;
  /**
   * The same decision as one of three drawing instructions, because a template
   * needs a single thing to branch on rather than two flags:
   * `body` = draw it, `note` = draw the explanation, `omit` = draw nothing.
   */
  mode: ReportDecisionMode;
}

export type ReportDecisionMode = 'body' | 'note' | 'omit';

/** Build a decision, deriving `mode` so the three fields can never disagree. */
function decision(present: boolean, note: string | null): ReportDecision {
  return { present, note, mode: present ? 'body' : note ? 'note' : 'omit' };
}

/** One entry of the document's section list — the reading order the renderers follow. */
export interface ReportSectionRef {
  id: ReportSectionId;
  /** Heading text, identical in both renderers. */
  title: string;
  /** Stable in-page anchor for the detailed view's section index. */
  anchor: string;
  /** Mirrors `decisions[id].present` — built from the same value, so the two cannot disagree. */
  present: boolean;
  /** Mirrors `decisions[id].note`. */
  note: string | null;
}

// ─── Value models (§6.3 units and provenance) ───────────────────

/** How a value should be toned. The HTML maps it to a CSS class, the PDF to a colour. */
export type Tone = 'default' | 'good' | 'bad' | 'warn' | 'muted' | 'accent';

/**
 * Where a reading sits — what lets a client see at a glance what is fine and
 * where the problem is. Always drawn as an icon plus `label`, never colour
 * alone; `neutral` means "no judgement" (unmeasured, or context only).
 */
export type StatusLevel = 'good' | 'warning' | 'critical' | 'neutral';

export interface StatusView {
  level: StatusLevel;
  label: string;
}

/**
 * One labelled figure with its unit.
 *
 * `measured` is false when the provider returned no value. §6.3 forbids
 * flattening that to `0`, so `value` then holds the explicit absence sentence
 * and the renderer must not treat it as a number.
 */
export interface MetricView {
  label: string;
  /** Printable value. Never empty. */
  value: string;
  /** §6.3 — the unit/definition, shown with the value. Null when the label already carries it. */
  unit: string | null;
  measured: boolean;
}

/** §6.3 rubric score line: returned value × weight, with the contribution kept visible. */
export interface SubScoreView {
  dimension: string;
  weight: number;
  weightLabel: string;
  /** Returned sub-score 0-100, or the "Unmeasured" label when the dimension is partial (FR-8.4). */
  valueLabel: string;
  contributionLabel: string;
  /** 0-100 width for the bar. Zero for a partial dimension, which contributed nothing. */
  barPercent: number;
  /** FR-8.4 / §6.3 — "Unmeasured; contributes 0 under this rubric", plus the recorded reason. */
  partial: boolean;
  partialNote: string | null;
  evidence: string[];
  /** The rubric's own cut points (0-40 / 41-60 / 61-80 / 81-100) read as a state. */
  status: StatusView;
  /** The measured dimension with the lowest value — where the score loses most. */
  biggestGap: boolean;
}

export interface FindingView {
  /** Display label (never blank — falls back to the raw check type). */
  label: string;
  status: string;
  statusTone: Tone;
  severity: string;
  severityTone: Tone;
  confidence: string;
  recommendedFix: string;
  reproduction: Array<{ bot: string; command: string; expectedResult: string }> | null;
}

export interface RoadmapItemView {
  action: string;
  dimension: string;
  title: string;
  description: string;
  severity: string | null;
  severityTone: Tone;
  /** `null` priorityScore prints "Set inputs" — never `0`. */
  priorityLabel: string;
  /** False when the gap's inputs were never set, so a renderer can mute the label without matching on its text. */
  prioritySet: boolean;
  status: string;
  statusTone: Tone;
}

export interface PresenceAccountView {
  label: string;
  group: string;
  state: string;
  stateTone: Tone;
  nameConsistency: string;
  nameMismatch: boolean;
  /** "@handle", or an em dash when the platform exposes none. */
  handleLabel: string;
  /** The recorded reason when unverified, otherwise the discovery source. */
  note: string;
}

export interface PresenceView {
  metrics: MetricView[];
  accounts: PresenceAccountView[];
  /** Expected platforms with no account — the operator's to-do, not a failure. */
  gaps: string[];
  /** How fresh the discovery evidence is; null when the inventory records no run. */
  lastRunNote: string | null;
}

export interface CompetitorRowView {
  name: string;
  domain: string;
  seoScoreLabel: string;
  seoIssues: string;
  presencePlatforms: string[];
}

export interface CompetitorsView {
  clientSeoLabel: string;
  clientIssues: string[];
  /** Platforms a tracked rival holds and the client does not. */
  competitorsOnly: string[];
  rows: CompetitorRowView[];
  /** §6.4 — scope/date of the comparison, so a reader knows what is being compared. */
  provenanceNote: string;
}

/** One dimension's mention rate — "Service discovery: 0% of 30 answers". */
export interface AeoDimensionView {
  label: string;
  mentionRatePercent: number;
  observations: number;
  /** Flags the weakest question type and any the client is never named in; `neutral` otherwise. */
  status: StatusView;
}

/** One engine's unbranded visibility — the per-engine comparison the audit exists to make. */
export interface AeoEngineView {
  label: string;
  /** Null when this engine was not measured — never drawn as 0. */
  unbrandedPercent: number | null;
  observations: number;
  status: StatusView;
}

/** One brand's share of all brand mentions in the answers; the client is always included. */
export interface AeoShareView {
  name: string;
  sharePercent: number;
  isClient: boolean;
}

/**
 * The single clearest piece of evidence a report can carry for this section:
 * the exact question a buyer would type, where the client was named zero
 * times and a named rival was recommended instead, with the judge's verbatim
 * quote. `null` when the audit's stance pass ran but found no such prompt —
 * a real, good outcome, not a missing one.
 */
export interface AeoLosingExampleView {
  prompt: string;
  losesTo: string[];
  evidenceQuote: string | null;
}

export interface AeoCompetitorView {
  name: string;
  /** True when this name was placed above the client in a judged answer (see {@link AeoLosingExampleView}) — the one AEO signal this document treats as confirmed rather than merely mentioned. */
  verified: boolean;
}

export interface AeoVisibilityView {
  surfaceLabel: string;
  questionsMeasured: number;
  totalAnswers: number;
  unbrandedMentionRatePercent: number;
  brandedMentionRatePercent: number;
  byDimension: AeoDimensionView[];
  /** Where the client stands against the brands the answers named — from share of voice. */
  standing: StatusView;
  engines: AeoEngineView[];
  /** Client plus the top rivals by share, remainder folded into "Others". */
  shareOfVoice: AeoShareView[];
  /** The largest share shown — the shared scale top for both renderers' share-of-voice bars. */
  shareScaleMax: number;
  /**
   * Zero-based scale tops for the engine and question-type bars: a round
   * number just above the largest value, so a 9% vs 28% difference is visible.
   * Every bar is labelled with its value, so length is never read alone.
   */
  engineScaleMax: number;
  dimensionScaleMax: number;
  losingExample: AeoLosingExampleView | null;
  competitors: AeoCompetitorView[];
  /** §6.4 — scope/date of the measurement, so a reader knows what is being compared. */
  provenanceNote: string;
}

export interface GrowthActionRowView {
  priorityRank: number;
  category: string;
  label: string;
  title: string;
  summary: string;
  quickWinCount: number;
  majorProjectCount: number;
  fillInCount: number;
  thanklessTaskCount: number;
}

export interface GrowthPlanView {
  /** Every ranked recommendation the snapshot holds — never collapsed to a headline by the model. */
  actionPlan: GrowthActionRowView[] | null;
  notCovered: string[];
  actionPlanUpdatedAt: string | null;
  findingsCopy: Array<{
    title: string;
    thinRun: boolean;
    whatExecutive: string;
    whyExecutive: string;
    fixExecutive: string;
    /** A disclosed gap in the underlying run, shown when the copy carries one. */
    disclosedGap: string | null;
  }>;
  /** D11 — what the snapshot does and does not cover from stage 11. Null when the snapshot has no growth plan. */
  assetsNote: string | null;
  /** True when the note was the pre-2026-09-16 sentence and was repaired on read (D11). */
  assetsNoteCorrected: boolean;
}

export interface BacklinksTopRowView {
  urlFrom: string;
  anchorLabel: string;
  followLabel: string;
  followTone: Tone;
  domainRankLabel: string;
  firstSeenLabel: string;
}

export interface BacklinksView {
  metrics: MetricView[];
  /** The provider's own failure/partial sentence, verbatim — never paraphrased into "no data". */
  statusNote: string | null;
  statusTone: Tone;
  top: BacklinksTopRowView[];
  /** §6.3 — target, snapshot date and the "sample is not full inventory" caveat. */
  provenanceNote: string;
}

export interface ScoreView {
  total: number;
  band: ScoreBand;
  /** §6.3 — the band is a rubric label, and saying so is part of the value. */
  bandNote: string;
  subScores: SubScoreView[];
  /** D11 — null means unrecorded, never inferred from the project's latest run. */
  rubricVersion: number | null;
  scoreRunId: string | null;
  provenanceNote: string;
}

/** §6.2 item 1 — the cover, and the release facts that are not part of the reviewed content. */
export interface ReportCoverView {
  orgName: string;
  tagline: string;
  title: string;
  targetUrl: string;
  /** The report's stable slug — an identifying field, so it comes from the mutable row like `visibility`. */
  slug: string;
  band: ScoreBand;
  scoreTotal: number;
  /** Status of the *report* (documented as a different axis from public visibility). */
  status: string;
  /**
   * §6.2 item 1 "preparation date" — when this content was written by
   * generation, read from the snapshot. Never the moment of rendering: a
   * document that says it was prepared today cannot be shown to be the same
   * document it was yesterday.
   */
  createdAt: string;
  releasedRevision: number | null;
  releasedAt: string | null;
  releasedBy: string | null;
  /**
   * "Released revision 2 on … by …", or — for an operator looking at
   * unreleased work — "Not released — editorial status: draft. …".
   *
   * `null` means **say nothing about release state**, which is what a
   * client-facing render of an unreleased report gets: the report's draft
   * stage is internal, and §6.4 keeps internal state out of the public
   * projection. Both renderers omit the line together, because both read this
   * one field.
   */
  releaseLine: string | null;
  confidentialityLine: string;
}

export interface ReportFooterView {
  lines: string[];
}

export interface ReportDocument {
  view: ReportView;
  surface: ReportSurface;
  audience: ReportAudience;
  /**
   * FR-10.5 — whether the *HTML* page must carry `noindex`. Decided here
   * because it is a property of the document's exposure (a private report, or
   * anything opened by a share token), not of either layout. The PDF ignores
   * it: a `noindex` tag on an HTML page says nothing about a file.
   */
  noindex: boolean;
  cover: ReportCoverView;
  /**
   * §6.1's detailed view carries a section index. Navigation only, generated
   * from `sections` so it cannot misdescribe the document — and `null` when the
   * view has no index, so neither renderer holds a view rule about it.
   */
  sectionIndex: ReportSectionRef[] | null;
  sections: ReportSectionRef[];
  decisions: ReportDecisions;
  score: ScoreView;
  /** Resolved and page-capped by the progress module; drawn as-is. Null on a first audit or until a review is approved. */
  progress: ReportProgressSection | null;
  findings: FindingView[];
  roadmap: RoadmapItemView[];
  presence: PresenceView | null;
  aeoVisibility: AeoVisibilityView | null;
  competitors: CompetitorsView | null;
  growthPlan: GrowthPlanView | null;
  backlinks: BacklinksView | null;
  executiveSummary: string;
  footer: ReportFooterView;
}

// ─── Absence wording (§6.4: state the omission, never imply it) ──

/**
 * The sentences that stand in for a section that is not there.
 *
 * They live here, once, because the *wording of an absence* is content: an
 * HTML page and a PDF of the same revision that say different things about
 * what is missing are two different documents, whatever their markup.
 */
const ABSENT = {
  findingsTable: 'No technical-audit checks are recorded in this snapshot.',
  roadmapTable: 'No roadmap items — run gap-analysis sync and technical audit first.',
  presence: 'No digital-presence discovery run yet for this project.',
  presenceAccounts: 'No accounts discovered yet.',
  presenceGaps: 'No expected platform is missing from a completed discovery run.',
  aeoVisibility: 'No AEO audit has completed for this project yet — run an answer-engine audit first.',
  aeoVisibilityLosing:
    'No prompt in this audit placed a named competitor above the client — either none did, or the stance pass has not run.',
  competitors:
    'No competitor data yet — add competitors to this project and run discovery first.',
  competitorsTable: 'No tracked competitors profiled yet.',
  competitorsOnly:
    'No tracked competitor holds a platform presence that this project does not.',
  growthPlan:
    'No growth plan is recorded in this snapshot: it was locked before that section existed, or neither the strategy action plan nor the findings copy had been produced when it was.',
  growthPlanActionPlan: 'No action plan built yet — POST /projects/:id/strategy/build first.',
  backlinks: 'No backlinks data yet — POST /projects/:id/backlinks/refresh first.',
} as const;

/** §6.3 — the rubric band is a label, not a promise. */
const BAND_NOTE =
  'Rubric bands are labels (0-40 invisible, 41-60 faint, 61-80 present, 81-100 recommended). ' +
  '"recommended" is a band on this rubric, not a statement that an engine recommends the brand.';

/** §6.3 — "not measured" is a state, not a number. */
export const NOT_MEASURED = 'Not measured';

/** §6.3 — a provider that returned nothing for one metric is not a provider that returned zero. */
export const NOT_REPORTED = 'Not reported in this snapshot';

// ─── Entry point ────────────────────────────────────────────────

export interface BuildReportDocumentOptions {
  view: ReportView;
  surface: ReportSurface;
  audience: ReportAudience;
  /**
   * `noindex` applies to the HTML surface only (FR-10.5). It is accepted here
   * so the footer notice is decided in one place; the PDF does not carry it,
   * because a file already delivered to a client is not un-indexed by a tag.
   */
  noindex?: boolean;
}

/**
 * What a render is given: a `ReportData`, plus the branding the snapshot
 * carries (FR-10.4). Branding is not part of `ReportData` because it is not
 * report *content* — but it *is* frozen in the snapshot, so a render must take
 * it from there rather than from the current environment.
 */
export interface ReportDocumentInput extends ReportData {
  branding?: BrandingConfig | null;
}

/**
 * Build the document both renderers consume.
 *
 * `data` is a `ReportData` — for a released report that is the frozen
 * `ReportRevisionSnapshot` plus the release stamps, which is exactly what
 * `ReportingService.renderHtml` has always passed to the template. This
 * function reads nothing else: no clock, no database, no environment beyond
 * the branding already inside the data. A PDF rendered from a 2026-09 snapshot
 * in 2031 is the same document.
 */
export function buildReportDocument(
  data: ReportDocumentInput,
  options: BuildReportDocumentOptions,
): ReportDocument {
  const { view, surface, audience } = options;
  const branding = brandingOf(data);
  const detailed = view === 'detailed';

  const decisions = buildDecisions(data, detailed);
  const sections = buildSectionRefs(decisions, detailed);

  return {
    view,
    surface,
    audience,
    noindex: resolveNoindex(data, options.noindex),
    cover: buildCover(data, branding, audience),
    sectionIndex: detailed ? sections : null,
    sections,
    decisions,
    score: buildScore(data),
    progress: data.progress ?? null,
    findings: (data.findings ?? []).map(toFindingView),
    roadmap: (data.roadmap ?? []).map(toRoadmapView),
    presence: data.presence ? toPresenceView(data.presence) : null,
    aeoVisibility: data.aeoVisibility ? toAeoVisibilityView(data.aeoVisibility) : null,
    competitors: data.competitors ? toCompetitorsView(data.competitors) : null,
    growthPlan: data.growthPlan ? toGrowthPlanView(data.growthPlan) : null,
    backlinks: data.backlinks ? toBacklinksView(data.backlinks) : null,
    executiveSummary: data.executiveSummary ?? '',
    footer: buildFooter(data, branding, surface),
  };
}

/**
 * FR-10.5, the rule `ReportingService.compile` used to apply inline:
 * a share-token render forces `noindex` on, an operator/public render follows
 * `visibility`.
 */
function resolveNoindex(data: ReportData, forced?: boolean): boolean {
  if (typeof forced === 'boolean') return forced;
  return data.visibility === 'private';
}

// ─── Sections ───────────────────────────────────────────────────

/** The reading order of each view (§6.1). The only place a view names a section. */
const SECTIONS_BY_VIEW: Record<ReportView, ReportSectionId[]> = {
  executive: ['scoreBreakdown'],
  detailed: ['scoreBreakdown', 'progress', 'findings', 'roadmap', 'presence', 'aeoVisibility', 'competitors', 'growthPlan', 'backlinks'],
};

const SECTION_TITLES: Record<ReportSectionId, string> = {
  scoreBreakdown: 'Score breakdown',
  progress: 'Progress since your baseline',
  findings: 'Findings',
  roadmap: 'Roadmap',
  presence: 'Social & Directory Presence',
  aeoVisibility: 'AI Visibility (AEO)',
  competitors: 'Competitor Landscape',
  growthPlan: 'Prioritized Growth Roadmap',
  backlinks: 'Backlinks',
};

/**
 * Presence for every decision key, given the data and the view.
 *
 * Two rules, applied uniformly:
 *   - a section outside the current view is `decision(false, null)`
 *     (draw nothing — an executive read should not list what it omits);
 *   - a section inside the view that has no content is
 *     `decision(false, <sentence>)` (state the omission).
 */
function buildDecisions(data: ReportData, detailed: boolean): ReportDecisions {
  const findings = data.findings ?? [];
  const roadmap = data.roadmap ?? [];
  const presence = data.presence;
  const aeoVisibility = data.aeoVisibility;
  const competitors = data.competitors;
  const growthPlan = data.growthPlan;
  const backlinks = data.backlinks;

  const outOfView: ReportDecision = decision(false, null);
  const has = (n: number | null | undefined): boolean => (n ?? 0) > 0;

  return {
    // The score breakdown is the one section every view draws: it is the
    // report's headline claim and the thing a reader checks first.
    scoreBreakdown: decision(true, null),

    // Deliberately `omit`, not an absence note, when there is no page: a first
    // audit has nothing to compare yet, and "no progress" printed in a client's
    // first report would misstate that. The page appears only from a later,
    // comparable audit whose progress review an operator approved.
    progress: detailed && data.progress ? decision(true, null) : outOfView,

    findings: detailed ? decision(true, null) : outOfView,
    findingsTable: !detailed
      ? outOfView
      : findings.length > 0
        ? decision(true, null)
        : decision(false, ABSENT.findingsTable),

    // Roadmap's heading is drawn even with no rows (the section is a promise
    // the report makes about the project's work list, and an empty one is
    // itself the finding) — so the *section* is present and the *table* carries
    // the absence.
    roadmap: detailed ? decision(true, null) : outOfView,
    roadmapTable: !detailed
      ? outOfView
      : roadmap.length > 0
        ? decision(true, null)
        : decision(false, ABSENT.roadmapTable),

    presence: !detailed
      ? outOfView
      : presence
        ? decision(true, null)
        : decision(false, ABSENT.presence),
    presenceAccounts: !detailed || !presence
      ? outOfView
      : presence.accounts.length > 0
        ? decision(true, null)
        : decision(false, ABSENT.presenceAccounts),
    presenceGaps: !detailed || !presence
      ? outOfView
      : has(presence.gaps?.length)
        ? decision(true, null)
        : decision(false, ABSENT.presenceGaps),

    aeoVisibility: !detailed
      ? outOfView
      : aeoVisibility
        ? decision(true, null)
        : decision(false, ABSENT.aeoVisibility),
    aeoVisibilityLosing: !detailed || !aeoVisibility
      ? outOfView
      : aeoVisibility.judged.available && aeoVisibility.judged.losingPrompts.length > 0
        ? decision(true, null)
        : decision(false, ABSENT.aeoVisibilityLosing),

    competitors: !detailed
      ? outOfView
      : competitors
        ? decision(true, null)
        : decision(false, ABSENT.competitors),
    competitorsTable: !detailed || !competitors
      ? outOfView
      : competitors.competitors.length > 0
        ? decision(true, null)
        : decision(false, ABSENT.competitorsTable),
    competitorsOnly: !detailed || !competitors
      ? outOfView
      : competitorsOnlyKeys(competitors).length > 0
        ? decision(true, null)
        : decision(false, ABSENT.competitorsOnly),

    growthPlan: !detailed
      ? outOfView
      : growthPlan
        ? decision(true, null)
        : decision(false, ABSENT.growthPlan),
    growthPlanActionPlan: !detailed || !growthPlan
      ? outOfView
      : growthPlan.actionPlan && growthPlan.actionPlan.recommendations.length > 0
        ? decision(true, null)
        : decision(false, ABSENT.growthPlanActionPlan),
    growthPlanFindingsCopy: !detailed
      ? outOfView
      : growthPlan && growthPlan.findingsCopy.length > 0
        ? decision(true, null)
        : decision(false, null),

    backlinks: !detailed
      ? outOfView
      : backlinks
        ? decision(true, null)
        : decision(false, ABSENT.backlinks),
    // A failed pull still carries a status and an error worth printing; what
    // it does not carry is numbers, and those must not appear as zeros.
    backlinksMetrics: !detailed
      ? outOfView
      : backlinks && backlinks.status !== 'failed'
        ? decision(true, null)
        : decision(false, null),
    backlinksTop: !detailed || !backlinks || backlinks.status === 'failed'
      ? outOfView
      : backlinks.topBacklinks && backlinks.topBacklinks.length > 0
        ? decision(true, null)
        : decision(false, null),
  };
}

/** Section refs, derived from the same decisions the renderers read. */
function buildSectionRefs(decisions: ReportDecisions, detailed: boolean): ReportSectionRef[] {
  // An `omit` section is not part of this document at all (only progress can
  // be omitted inside a view), so the contents must not list it as missing.
  const ids = SECTIONS_BY_VIEW[detailed ? 'detailed' : 'executive'].filter((id) => decisions[id].mode !== 'omit');
  return ids.map((id) => ({
    id,
    title: SECTION_TITLES[id],
    anchor: `section-${id}`,
    present: decisions[id].present,
    note: decisions[id].note,
  }));
}

// ─── Cover ──────────────────────────────────────────────────────

function buildCover(data: ReportData, branding: BrandingConfig, audience: ReportAudience): ReportCoverView {
  const released = data.releasedRevision != null;
  const releaseLine = released
    ? `Released revision ${data.releasedRevision}${data.releasedAt ? ` on ${data.releasedAt}` : ''}` +
      `${audience === 'operator' && data.releasedBy ? ` by ${data.releasedBy}` : ''}. This document renders that ` +
      'frozen revision, so it does not change when the report is regenerated.'
    : audience === 'operator'
      ? `Not released — editorial status: ${data.status}. This document is an internal preview and has not been ` +
        'delivered to the client.'
      : null;

  return {
    orgName: branding.orgName,
    tagline: branding.tagline ?? '',
    title: data.title,
    targetUrl: data.targetUrl,
    slug: data.slug,
    band: data.scoreBand,
    scoreTotal: data.scoreTotal,
    status: data.status,
    createdAt: data.createdAt,
    releasedRevision: data.releasedRevision ?? null,
    releasedAt: data.releasedAt ?? null,
    releasedBy: data.releasedBy ?? null,
    releaseLine,
    confidentialityLine:
      `Confidential — prepared by ${branding.orgName} for ${data.targetUrl}. Share with the named recipient only; ` +
      'this document is not a public page.',
  };
}

// ─── Score ──────────────────────────────────────────────────────

function buildScore(data: ReportData): ScoreView {
  const rubricKnown = data.rubricVersion != null;
  const provenanceNote = rubricKnown
    ? `Scored with rubric v${data.rubricVersion}${data.scoreRunId ? ` (score run ${data.scoreRunId})` : ''}.`
    : 'The rubric version and score run behind this report are not recorded on it, so the score cannot be ' +
      'traced to a specific run from this document.';

  return {
    total: data.scoreTotal,
    band: data.scoreBand,
    bandNote: BAND_NOTE,
    subScores: flagBiggestGap((data.subScores ?? []).map(toSubScoreView)),
    rubricVersion: data.rubricVersion ?? null,
    scoreRunId: data.scoreRunId ?? null,
    provenanceNote,
  };
}

/**
 * §6.3 partial dimension: "Show 'Unmeasured; contributes 0 under this rubric';
 * do not silently reweight."
 *
 * The stored sub-score is 0 for a partial dimension, so printing `value` alone
 * shows a legitimate zero for something that was never measured — the exact
 * flattening §6.3 and AGENT-BRIEF rule 3 forbid. The value is therefore
 * replaced by the explicit label, and the contribution is still stated because
 * it is still what the total counted.
 */
function toSubScoreView(sub: SubScore): SubScoreView {
  const partial = sub.partial === true;
  return {
    dimension: sub.dimension,
    weight: sub.weight,
    weightLabel: `${sub.weight} pts max`,
    valueLabel: partial ? NOT_MEASURED : String(round(sub.value)),
    contributionLabel: `${round(sub.contribution)} of the 100-point total`,
    barPercent: partial ? 0 : clampPercent(sub.value),
    partial,
    partialNote: partial
      ? `Unmeasured; contributes 0 under this rubric.${sub.partialReason ? ` ${sub.partialReason}` : ''}`
      : null,
    evidence: sub.evidence ?? [],
    status: partial ? { level: 'neutral', label: NOT_MEASURED } : rubricStatus(sub.value),
    biggestGap: false,
  };
}

/**
 * The rubric's band cut points (BAND_NOTE: 0-40 / 41-60 / 61-80 / 81-100)
 * read as a state for one dimension. Same boundaries the total's band uses,
 * so a dimension and the total can never be judged on different scales.
 */
function rubricStatus(value: number): StatusView {
  if (value <= 40) return { level: 'critical', label: 'Critical gap' };
  if (value <= 60) return { level: 'warning', label: 'Needs work' };
  if (value <= 80) return { level: 'good', label: 'Solid' };
  return { level: 'good', label: 'Strong' };
}

/** Mark the lowest measured dimension — unless it is already fine, where "gap" would overstate it. */
function flagBiggestGap(subs: SubScoreView[]): SubScoreView[] {
  const measured = subs.filter((s) => !s.partial);
  if (measured.length < 2) return subs;
  const lowest = measured.reduce((a, b) => (b.barPercent < a.barPercent ? b : a));
  if (lowest.status.level === 'good') return subs;
  return subs.map((s) => (s === lowest ? { ...s, biggestGap: true } : s));
}

// ─── Findings / roadmap ─────────────────────────────────────────

function toFindingView(finding: ReportFindingDto): FindingView {
  return {
    // Legacy snapshots predate the display label; falling back to the raw type
    // keeps them readable without rewriting frozen content (the same rule the
    // template applied inline before this model existed).
    label: finding.label || finding.type,
    status: finding.status,
    statusTone: statusTone(finding.status),
    severity: finding.severity,
    severityTone: severityTone(finding.severity),
    confidence: finding.confidence,
    recommendedFix: finding.recommendedFix,
    reproduction: finding.reproductionCommands ?? null,
  };
}

function toRoadmapView(item: ReportRoadmapDto): RoadmapItemView {
  return {
    action: item.action,
    dimension: item.dimension,
    title: item.title,
    description: item.description,
    severity: item.severity,
    severityTone: severityTone(item.severity),
    // A gap whose inputs were never set has no priority — "Set inputs" names
    // the missing action. Printing 0 would claim it was ranked last.
    priorityLabel: item.priorityScore == null ? 'Set inputs' : String(round(item.priorityScore)),
    prioritySet: item.priorityScore != null,
    status: item.status,
    statusTone: statusTone(item.status),
  };
}

// ─── Presence ───────────────────────────────────────────────────

function toPresenceView(inventory: PresenceInventory): PresenceView {
  return {
    metrics: [
      { label: 'Confirmed', value: String(inventory.counts.confirmed), unit: 'company profiles', measured: true },
      { label: 'Unverified', value: String(inventory.counts.unverified), unit: 'company profiles', measured: true },
      { label: 'Social accounts', value: String(inventory.counts.social), unit: null, measured: true },
      { label: 'Directory / listing', value: String(inventory.counts.listing), unit: null, measured: true },
    ],
    accounts: inventory.accounts.map((a) => ({
      label: a.label,
      group: a.group,
      state: a.state,
      stateTone: statusTone(a.state),
      nameConsistency: a.nameConsistency,
      nameMismatch: a.nameConsistency === 'mismatch',
      handleLabel: a.handle ? `@${a.handle}` : '—',
      // A platform that could not be checked says why; otherwise the row names
      // where the account was found. Both are provenance, so neither is dropped.
      note: a.reason ?? a.sourceLabel,
    })),
    gaps: (inventory.gaps ?? []).map((g) => g.label),
    lastRunNote: inventory.lastRun
      ? `Discovery run ${inventory.lastRun.id} — ${inventory.lastRun.status}. A discovered URL is not proof of account ownership.`
      : null,
  };
}

// ─── AEO Visibility ─────────────────────────────────────────────

/**
 * `judged.losingPrompts[].losesTo` is this document's one AEO "verified
 * competitor" signal: a name a judged answer explicitly placed above the
 * client, worst-first. Everything else an answer merely mentioned is a
 * weaker claim than this document makes as a named competitor — so this is
 * deliberately the *only* source `competitors` below draws from, not a
 * broader "every name seen" list.
 */
function toAeoVisibilityView(verdict: AeoVerdict): AeoVisibilityView {
  const measuredSurfaces = verdict.surfaceRuns.filter((s) => s.status === 'completed').map((s) => s.label);
  const surfaceLabel = measuredSurfaces.length > 0 ? measuredSurfaces.join(', ') : verdict.surface;

  const verifiedNames = new Map<string, boolean>();
  for (const p of verdict.judged.losingPrompts) {
    for (const name of p.losesTo) verifiedNames.set(name, true);
  }

  const firstLosing = verdict.judged.losingPrompts[0] ?? null;
  const dims = dimensionViews(verdict);
  const engines = engineViews(verdict);
  const share = shareViews(verdict);

  return {
    surfaceLabel,
    questionsMeasured: verdict.counted.overall.prompts,
    totalAnswers: verdict.counted.overall.observations,
    unbrandedMentionRatePercent: round(verdict.counted.unbranded.mentionRate * 100),
    brandedMentionRatePercent: round(verdict.counted.branded.mentionRate * 100),
    byDimension: dims,
    standing: standingOf(verdict),
    engines,
    shareOfVoice: share,
    shareScaleMax: Math.max(1, ...share.map((r) => r.sharePercent)),
    engineScaleMax: niceMax(Math.max(0, ...engines.map((e) => e.unbrandedPercent ?? 0))),
    dimensionScaleMax: niceMax(Math.max(0, ...dims.map((d) => d.mentionRatePercent))),
    losingExample: firstLosing
      ? { prompt: firstLosing.prompt, losesTo: firstLosing.losesTo, evidenceQuote: firstLosing.evidenceQuote }
      : null,
    competitors: [...verifiedNames.keys()].map((name) => ({ name, verified: true })),
    provenanceNote:
      `Measured ${verdict.generatedAt} on ${surfaceLabel}, ${verdict.runCount} repeats per question. ` +
      'Mention rate is the share of answers naming the client; the unbranded rate — the honest visibility test — ' +
      'counts only questions that did not already name the client.',
  };
}

const NO_STATUS: StatusView = { level: 'neutral', label: '' };

/** Smallest slice a status may be read from — below it one answer swings the rate by several points. */
const AEO_STATUS_MIN_ANSWERS = 5;

/** Spread between engines that counts as uneven — the same 5-point threshold `headlines()` uses. */
const ENGINE_SPREAD = 5;

/**
 * "Never named" is critical on its own terms. "Weakest" is relative, so — the
 * same rule the engines use — it is only said when the question types really
 * differ (a spread of at least ENGINE_SPREAD points), and as a warning: the
 * lowest of 72% / 80% / 85% is not a problem to flag.
 */
function dimensionViews(verdict: AeoVerdict): AeoDimensionView[] {
  const dims = verdict.counted.byDimension;
  const judged = dims.filter((d) => d.observations >= AEO_STATUS_MIN_ANSWERS);
  const pcts = judged.map((d) => round(d.mentionRate * 100));
  const uneven = judged.length > 1 && Math.max(...pcts) - Math.min(...pcts) >= ENGINE_SPREAD;
  const weakest = uneven ? judged.reduce((a, b) => (b.mentionRate < a.mentionRate ? b : a)) : null;
  return dims.map((d) => {
    let status = NO_STATUS;
    if (d.observations >= AEO_STATUS_MIN_ANSWERS && d.mentionRate === 0) status = { level: 'critical', label: 'Never named' };
    else if (d === weakest) status = { level: 'warning', label: 'Weakest' };
    return { label: d.label, mentionRatePercent: round(d.mentionRate * 100), observations: d.observations, status };
  });
}

function engineViews(verdict: AeoVerdict): AeoEngineView[] {
  const measured = verdict.counted.bySurface.filter((s) => s.status === 'completed' && s.observations > 0);
  const pcts = measured.map((s) => round(s.unbrandedMentionRate * 100));
  const hi = pcts.length ? Math.max(...pcts) : 0;
  const lo = pcts.length ? Math.min(...pcts) : 0;
  const uneven = measured.length > 1 && hi - lo >= ENGINE_SPREAD;
  return verdict.counted.bySurface.map((s) => {
    if (s.status !== 'completed' || s.observations === 0) {
      return { label: s.label, unbrandedPercent: null, observations: s.observations, status: { level: 'neutral', label: NOT_MEASURED } };
    }
    const pct = round(s.unbrandedMentionRate * 100);
    let status = NO_STATUS;
    if (pct === 0) status = { level: 'critical', label: 'Invisible' };
    else if (uneven && pct === lo) status = { level: 'warning', label: 'Weakest engine' };
    else if (uneven && pct === hi) status = { level: 'good', label: 'Strongest engine' };
    return { label: s.label, unbrandedPercent: pct, observations: s.observations, status };
  });
}

/**
 * Client plus the five largest rivals; everything else folds into one
 * "Others" bar. Each share is a fraction of *all* brand mentions (measurement
 * divides by the full total before it trims the list to ten), so "Others" is
 * exactly what the shown bars leave — not just the trimmed list's tail.
 */
function shareViews(verdict: AeoVerdict): AeoShareView[] {
  const [client, ...rivals] = verdict.counted.shareOfVoice;
  if (!client) return [];
  const top = rivals.slice(0, 5);
  const shown = client.share + top.reduce((sum, r) => sum + r.share, 0);
  const rest = Math.max(0, 1 - shown);
  return [
    { name: client.name, sharePercent: round(client.share * 100), isClient: true },
    ...top.map((r) => ({ name: r.name, sharePercent: round(r.share * 100), isClient: false })),
    ...(round(rest * 100) > 0 ? [{ name: 'Others', sharePercent: round(rest * 100), isClient: false }] : []),
  ];
}

/** Where the client stands among the brands the answers named — relative, so it needs no invented benchmark. */
function standingOf(verdict: AeoVerdict): StatusView {
  const [client, ...rivals] = verdict.counted.shareOfVoice;
  if (!client || (client.share === 0 && rivals.length === 0)) return { level: 'neutral', label: 'No brands named yet' };
  if (rivals.length === 0 || rivals.every((r) => r.share <= client.share)) {
    return client.share > 0 ? { level: 'good', label: 'You lead share of voice' } : { level: 'critical', label: 'Not named in any answer' };
  }
  const leader = rivals.reduce((a, b) => (b.share > a.share ? b : a));
  const ahead = rivals.filter((r) => r.share > client.share).length;
  if (client.share < leader.share / 2) return { level: 'critical', label: `Far behind ${leader.name}` };
  return { level: 'warning', label: `${ahead} rival${ahead === 1 ? '' : 's'} named more often` };
}

// ─── Competitors ────────────────────────────────────────────────

function competitorsOnlyKeys(gap: GapResult): string[] {
  return (gap.presence?.competitorsOnly ?? []).filter((line) => !line.client).map((line) => line.key);
}

function toCompetitorsView(gap: GapResult): CompetitorsView {
  return {
    clientSeoLabel:
      gap.seo?.client?.score == null
        ? NOT_REPORTED
        : `${round(gap.seo.client.score)}${gap.seo.client.status === 'failed' ? ' (this pull failed)' : ''}`,
    clientIssues: gap.seo?.client?.issues ?? [],
    competitorsOnly: competitorsOnlyKeys(gap),
    rows: (gap.competitors ?? []).map((row) => ({
      name: row.name,
      domain: row.domain ?? '—',
      seoScoreLabel: row.seoScore == null ? NOT_REPORTED : String(round(row.seoScore)),
      seoIssues: (row.seoIssues ?? []).join(', '),
      presencePlatforms: row.presencePlatforms ?? [],
    })),
    provenanceNote:
      `Competitor gap taken ${gap.generatedAt} against ${gap.domain}. Scopes are comparable, not identical: ` +
      'this is a point-in-time diff, and it does not compute an overall competitor score.',
  };
}

// ─── Growth plan ────────────────────────────────────────────────

function toGrowthPlanView(plan: NonNullable<ReportData['growthPlan']>): GrowthPlanView {
  const actionPlan = plan.actionPlan;
  return {
    actionPlan:
      actionPlan && actionPlan.recommendations.length > 0
        ? actionPlan.recommendations.map((r) => ({
            priorityRank: r.priorityRank,
            category: r.category,
            label: r.label,
            title: r.title,
            summary: r.summary,
            quickWinCount: r.quickWinCount,
            majorProjectCount: r.majorProjectCount,
            fillInCount: r.fillInCount,
            thanklessTaskCount: r.thanklessTaskCount,
          }))
        : null,
    notCovered: actionPlan?.notCovered ?? [],
    actionPlanUpdatedAt: actionPlan?.updatedAt ?? null,
    findingsCopy: (plan.findingsCopy ?? []).map((f) => ({
      title: f.title,
      thinRun: f.thinRun === true,
      whatExecutive: f.whatExecutive,
      whyExecutive: f.whyExecutive,
      fixExecutive: f.fixExecutive,
      disclosedGap: f.disclosedGap ?? null,
    })),
    assetsNote: plan.assetsNote ?? null,
    assetsNoteCorrected: plan.assetsNoteCorrected === true,
  };
}

// ─── Backlinks ──────────────────────────────────────────────────

/**
 * §6.3 backlinks display rule: "Provider snapshot with sample of top links —
 * timestamp, target and partial status; sample is not full inventory."
 *
 * Every metric goes through {@link metric}, so a `partial` pull that returned
 * five of six fields prints the fifth and names the sixth as not reported
 * rather than showing a zero it did not receive.
 */
function toBacklinksView(summary: BacklinksSummaryDto): BacklinksView {
  const failed = summary.status === 'failed';
  return {
    metrics: [
      metric('Referring domains', summary.referringDomains, 'domains'),
      metric('Total backlinks', summary.backlinks, 'links'),
      metric('Rank', summary.rank, 'provider 0-100'),
      metric('Spam score', summary.backlinksSpamScore, 'provider 0-100'),
      metric('Broken backlinks', summary.brokenBacklinks, 'links'),
      metric('Referring IPs', summary.referringIps, 'addresses'),
      metric('Referring subnets', summary.referringSubnets, 'subnets'),
    ],
    statusNote:
      failed || summary.status === 'partial'
        ? summary.error ??
          `The provider returned a ${summary.status} snapshot, so some figures may be missing.`
        : null,
    statusTone: failed ? 'bad' : summary.status === 'partial' ? 'warn' : 'muted',
    top: (summary.topBacklinks ?? []).map((b) => ({
      urlFrom: b.urlFrom,
      anchorLabel: b.anchor && b.anchor.length > 0 ? b.anchor : '—',
      followLabel: b.dofollow ? 'dofollow' : 'nofollow',
      followTone: b.dofollow ? 'default' : 'warn',
      domainRankLabel: b.domainFromRank == null ? NOT_REPORTED : String(round(b.domainFromRank)),
      firstSeenLabel: b.firstSeen ?? NOT_REPORTED,
    })),
    provenanceNote:
      `Provider snapshot (${summary.status}) for ${summary.target}, taken ${summary.createdAt}. ` +
      'The rows below are a sample of top links, not a full inventory; a referring-domain count is a provider ' +
      'figure and is not the Authority rubric score.',
  };
}

// ─── Footer ─────────────────────────────────────────────────────

/**
 * The footer's sentences, decided once per surface.
 *
 * The provenance line is the same on both. The closing notice differs because
 * the surfaces differ: a `noindex` tag is a claim about an HTML page and is
 * meaningless on a file, while confidentiality is meaningful on both.
 */
function buildFooter(
  data: ReportData,
  branding: BrandingConfig,
  surface: ReportSurface,
): ReportFooterView {
  const rubric =
    data.rubricVersion != null
      ? `Scored with rubric v${data.rubricVersion}${data.scoreRunId ? ` (score run ${data.scoreRunId})` : ''}.`
      : 'Rubric version and score run: not recorded on this report.';

  const notice =
    surface === 'web'
      ? 'Reproduction commands included per PRD FR-2.6. noindex applied to private reports and to every share link (FR-10.5).'
      : `Confidential — ${branding.orgName}. Generated from this report's frozen snapshot; it does not change when the report is regenerated.`;

  return {
    lines: [
      `Generated ${data.createdAt} · Report slug: ${data.slug}`,
      rubric,
      notice,
    ],
  };
}

// ─── Formatting helpers (§6.3) ──────────────────────────────────

/** A metric that may not have been returned at all. */
function metric(
  label: string,
  value: number | null | undefined,
  unit: string,
): MetricView {
  const measured = typeof value === 'number' && Number.isFinite(value);
  return {
    label,
    value: measured ? String(round(value)) : NOT_REPORTED,
    unit,
    measured,
  };
}

/** Rounds for display only — the value's own precision is the backend's business. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Shared status→tone map, so a "partial" check is not coloured as a pass in one renderer. */
function statusTone(status: string): Tone {
  switch (status) {
    case 'pass':
    case 'confirmed':
    case 'completed':
      return 'good';
    case 'fail':
    case 'failed':
      return 'bad';
    case 'error':
    case 'unverified':
    case 'partial':
      return 'warn';
    case 'missing':
    case 'skipped':
      return 'muted';
    default:
      return 'default';
  }
}

function severityTone(severity: string | null | undefined): Tone {
  switch (severity) {
    case 'high':
      return 'bad';
    case 'medium':
      return 'accent';
    case 'low':
      return 'muted';
    default:
      return 'default';
  }
}

function brandingOf(data: ReportDocumentInput): BrandingConfig {
  return {
    orgName: data.branding?.orgName || process.env.REPORT_BRAND_NAME || 'Rothenhall Partners',
    tagline: data.branding?.tagline || process.env.REPORT_BRAND_TAGLINE || 'AI Visibility Diagnostics',
  };
}
