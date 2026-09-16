/**
 * Reporting Service — Aggregates audit data into branded diagnostic reports.
 *
 * Consumes (via Prisma):
 *   - TechnicalAudit + AuditFinding + PageMetadata (technical-audit)
 *   - SchemaCheck + PlatformRecord (entity-audit)
 *   - Gap + GapAnalysis (gap-analysis)
 *
 * Consumes (via injected service, all pure reads — never a rebuild/LLM/vendor call):
 *   - StrategyService.getActionPlan() — stage 9's ranked recommendations
 *   - FindingsService.list() — stage 8's LLM what/why/fix copy
 *   - BacklinksService.latest() — the project's latest DataForSEO backlinks pull
 *
 * Produces:
 *   - Scored report (PRD §8: Machine access 25, Entity clarity 25, Shortlist 20,
 *     Extractability 20, Authority 10)
 *   - Executive summary
 *   - Growth plan: stage 12's "Comprehensive Audit & Growth Report" →
 *     "Prioritized Growth Roadmap" (see `GrowthPlanDto`)
 *   - Branded HTML (FR-10.1, FR-10.4), stable slug URL, noindex default (FR-10.5)
 *
 * @module reporting.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import { join } from 'path';
import { readFileSync } from 'fs';
import type { Report, ReportRevision } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ScoringService } from '../scoring/scoring.service';
import { StrategyService } from '../strategy/strategy.service';
import { FindingsService } from '../findings/findings.service';
import { BacklinksService } from '../backlinks/backlinks.service';
import { PresenceService } from '../digital-presence/presence.service';
import { CompetitorsService } from '../competitors/competitors.service';
import { EvidenceService } from '../results/evidence.service';
import { PeriodService } from '../results/period.service';
import { buildReportDocument } from './report-document';
import { renderReportPdf } from './report-pdf';
import type { ReportAudience, ReportDocument, ReportSurface } from './report-document';
import type { ReportPdfArtifact } from './report-pdf';
import type {
  GrowthAssetCountsDto,
  ReleasedReportDto,
  ReportData,
  ReportEditorialStatus,
  ReportFindingDto,
  ReportRevisionSnapshot,
  ReportRoadmapDto,
  GrowthPlanDto,
  ScoreSummary,
  SubScore,
  ScoreBand,
  BrandingConfig,
} from './reporting.types';
import type { BacklinksSummaryDto } from '../backlinks/backlinks.types';
import type { PresenceInventory } from '../digital-presence/presence.types';
import type { GapResult } from '../competitors/competitors.service';


// Handlebars helper: {{#if_eq a b}}...{{/if_eq}}
Handlebars.registerHelper('if_eq', function (a: unknown, b: unknown, options: any) {
  return a === b ? options.fn(this) : options.inverse(this);
});

/**
 * Display labels for `TechnicalAudit` finding types shown in the Findings
 * table. Only entries that would otherwise collide with a DIFFERENT check
 * appearing elsewhere in the same report need an override — everything else
 * falls through to the raw `type` slug.
 *
 * "schema" is the one case that matters: this is technical-audit's field-
 * completeness check (fails when >3 recommended fields are missing), NOT
 * entity-audit's schema-type check (`EntityAudit.schemaChecks`, shown in the
 * Entity clarity sub-score — passes once a valid type + working sameAs links
 * exist, regardless of field completeness). Two genuinely different checks;
 * without a label a reader sees "schema: fail" here and "Schema: ... pass"
 * in the score breakdown and reasonably assumes the report contradicts
 * itself.
 */
const FINDING_TYPE_LABELS: Record<string, string> = {
  schema: 'Schema field completeness (technical audit)',
};

/**
 * D11 — the marker that identifies the old `growthPlan.assetsNote`.
 *
 * Until 2026-09-16 every report said stage 11 "has no module yet". That was
 * true when written and is false now: the `growth-execution` module exists and
 * holds real assets. The sentence misstated the system (never the client's
 * data), which is why it is repaired rather than left in place — and, because
 * a released snapshot is frozen, the repair happens **on read** and is flagged
 * with `assetsNoteCorrected` instead of rewriting the stored bytes.
 */
const LEGACY_ASSETS_NOTE_MARKER = 'has no module yet';

const LEGACY_ASSETS_NOTE_REPAIR =
  'Legacy note, repaired on read (D11): this snapshot was written when stage 11 had no module, so it says so. ' +
  'Growth execution now exists — article, ad-copy, social-content, email-campaign, landing-page, structured-data, ' +
  'seo-fix, faq and review-campaign assets are tracked per project. This report still does not copy them into its ' +
  'snapshot (the approved editorial-plan section is G09/G13); the stored snapshot is unchanged.';

@Injectable()
export class ReportingService {
  private readonly logger = new Logger(ReportingService.name);

  private readonly defaultBranding: BrandingConfig = {
    orgName: process.env.REPORT_BRAND_NAME || 'Rothenhall Partners',
    tagline: process.env.REPORT_BRAND_TAGLINE || 'AI Visibility Diagnostics',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: ScoringService,
    private readonly strategy: StrategyService,
    private readonly findings: FindingsService,
    private readonly backlinksService: BacklinksService,
    private readonly presenceService: PresenceService,
    private readonly competitorsService: CompetitorsService,
    private readonly periods: PeriodService,
    private readonly evidence: EvidenceService,
  ) {}

  /** Best-effort presence inventory for a report — never throws, never blocks generation. */
  private async getPresenceSnapshot(projectId: string): Promise<PresenceInventory | null> {
    try {
      return await this.presenceService.inventory(projectId);
    } catch (err) {
      this.logger.warn(`Report: presence inventory unavailable for ${projectId} — continuing without it: ${(err as Error).message}`);
      return null;
    }
  }

  /** Best-effort competitor gap for a report — never throws (no tracked competitors is normal on day one, not an error). */
  private async getCompetitorsSnapshot(projectId: string): Promise<GapResult | null> {
    try {
      return await this.competitorsService.gap(projectId);
    } catch (err) {
      this.logger.warn(`Report: competitor gap unavailable for ${projectId} — continuing without it: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Generate report ──────────────────────────────────────────

  async generateReport(
    projectId: string,
    targetUrl: string,
    title: string,
    /**
     * G13 — optional window/cohort pinning. When `periodId` is supplied the
     * report reproduces that exact stored window forever; otherwise the window
     * is derived from today's date and the report records that it did.
     */
    pinning: { periodId?: string; cohortId?: string } = {},
  ): Promise<ReportData> {
    this.logger.log('Generating report for project ' + projectId);

    const audit = await this.prisma.technicalAudit.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { findings: true, pageMetadata: true },
    });

    if (!audit) {
      throw new NotFoundException('No technical audit found for project ' + projectId + '. Run a technical audit first.');
    }

    const roadmap = await this.getRoadmapSnapshot(projectId);
    const growthPlan = await this.getGrowthPlanSnapshot(projectId);
    const backlinks = await this.backlinksService.latest(projectId);
    const presence = await this.getPresenceSnapshot(projectId);
    const competitors = await this.getCompetitorsSnapshot(projectId);
    // §8 scoring moved into the versioned-rubric scoring module (FR-8.1–8.4):
    // real measurement inputs, evidence-linked sub-scores, rubric version recorded.
    const scoreResult = await this.scoring.scoreProject(projectId);
    const score: ScoreSummary = {
      total: scoreResult.total,
      band: scoreResult.band as ScoreBand,
      subScores: scoreResult.subScores as unknown as SubScore[],
      rubricVersion: scoreResult.rubricVersion,
    };

    const findings: ReportFindingDto[] = audit.findings.map((f: any) => ({
      type: f.type,
      label: FINDING_TYPE_LABELS[f.type] ?? f.type,
      status: f.status,
      severity: f.severity,
      confidence: f.confidence,
      detail: (this.parseJson<Record<string, unknown>>(f.detail) ?? {}),
      recommendedFix: f.recommendedFix,
      reproductionCommands: f.reproductionCommands ? this.parseJson<{ bot: string; command: string; expectedResult: string }[]>(f.reproductionCommands) : null,
      createdAt: audit.createdAt.toISOString(),
    }));

    const executiveSummary = this.buildExecutiveSummary(title, audit.targetUrl, score, findings, roadmap, growthPlan);
    const slug = this.buildSlug(title);

    const record = await this.prisma.report.create({
      data: {
        projectId,
        slug,
        title,
        targetUrl: audit.targetUrl,
        visibility: 'private',
        executiveSummary,
        scoreTotal: score.total,
        scoreBand: score.band,
        subScores: JSON.stringify(score.subScores),
        findingsSnapshot: JSON.stringify(findings),
        roadmapSnapshot: JSON.stringify(roadmap),
        growthPlanSnapshot: JSON.stringify(growthPlan),
        backlinksSnapshot: backlinks ? JSON.stringify(backlinks) : null,
        presenceSnapshot: presence ? JSON.stringify(presence) : null,
        competitorsSnapshot: competitors ? JSON.stringify(competitors) : null,
        branding: JSON.stringify(this.defaultBranding),
        periodId: pinning.periodId ?? null,
        cohortId: pinning.cohortId ?? null,
      },
    });

    // G13 — pin the evidence this report was built from, so a later reader can
    // trace every figure back to the rows it came from and an old report stays
    // reproducible after new runs land.
    //
    // Best-effort and deliberately non-fatal: a report that failed to pin its
    // manifest is still a valid report, and rolling one back because a manifest
    // could not be written would lose work the operator already paid for. The
    // absence is recorded (manifestId stays null) rather than hidden, so a
    // reader can tell a pinned report from an unpinned one.
    let manifestId: string | null = null;
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { timezone: true },
      });
      // Only the window inputs go to resolveWindow; the cohort is a manifest
      // input. A period already carries its own `baselinePeriodId`, so the
      // report does not override it — two sources of truth for "what this is
      // compared against" is how a comparison ends up disagreeing with itself.
      const { window } = await this.periods.resolveWindow(
        projectId,
        { periodId: pinning.periodId },
        project?.timezone ?? 'UTC',
      );
      // D11 — pin the ScoreRun this report was scored by, not merely whatever
      // ScoreRun the window happens to contain. Scoring always writes a new
      // run, so without the pin the manifest would resolve "latest in window"
      // and could attribute a different run's rubric to this score.
      const manifest = await this.evidence.create(
        projectId,
        {
          subjectType: 'report',
          subjectId: record.id,
          periodId: pinning.periodId,
          cohortId: pinning.cohortId,
          scoreRunId: scoreResult.id,
        },
        window,
      );
      manifestId = manifest.id;
      await this.prisma.report.update({ where: { id: record.id }, data: { manifestId } });
    } catch (err) {
      this.logger.warn(
        `Report ${slug} was generated but its evidence manifest could not be pinned: ${
          err instanceof Error ? err.message : String(err)
        }. The report is valid; its sources are simply not frozen.`,
      );
    }

    this.logger.log('Report generated: ' + slug + ' (score: ' + score.total + ', band: ' + score.band + ')');

    // Read the row back rather than echoing what was written: the response then
    // carries exactly what a later reader will see, including the manifest's
    // score-run linkage when pinning succeeded (and its honest absence when it
    // did not) instead of a value this method happens to be holding.
    const fresh = await this.prisma.report.findUniqueOrThrow({ where: { id: record.id } });
    return this.toReportData(fresh);
  }

  // ─── Get / list / visibility ─────────────────────────────────

  /**
   * One report by slug.
   *
   * `projectId` is passed by every operator route so the slug is resolved
   * *within* the URL's project (G03: a report slug must not resolve through
   * another project's URL). `includePrivate` remains what it always was — a
   * gate on the `visibility` flag for the unauthenticated HTML surface, which
   * is a **different axis** from the editorial `status` (G05).
   */
  async getBySlug(slug: string, options: { includePrivate?: boolean; projectId?: string } = {}): Promise<ReportData> {
    const record = await this.prisma.report.findFirst({
      where: { slug, ...(options.projectId ? { projectId: options.projectId } : {}) },
    });
    if (!record) throw new NotFoundException('Report ' + slug + ' not found');
    if (record.visibility === 'private' && !options.includePrivate) {
      throw new NotFoundException('Report ' + slug + ' not found');
    }
    return this.toReportData(record);
  }

  /**
   * Report summaries for a project, newest first.
   *
   * Carries **both** axes: `visibility` (public link on/off) and `status` plus
   * `releasedRevision` (editorial state). A screen that renders only one of
   * them cannot tell a released-and-private report from an unreleased one,
   * which is the distinction G05 exists to make visible.
   */
  async listReports(projectId: string) {
    const reports = await this.prisma.report.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        title: true,
        targetUrl: true,
        visibility: true,
        status: true,
        releasedRevision: true,
        releasedAt: true,
        scoreTotal: true,
        scoreBand: true,
        createdAt: true,
      },
    });
    return { reports };
  }

  async setVisibility(projectId: string, slug: string, visibility: 'private' | 'public') {
    const record = await this.prisma.report.findUnique({ where: { slug } });
    if (!record || record.projectId !== projectId) {
      throw new NotFoundException('Report ' + slug + ' not found for project ' + projectId);
    }
    const updated = await this.prisma.report.update({
      where: { slug },
      data: { visibility },
      select: { slug: true, visibility: true },
    });
    this.logger.log('Report ' + slug + ' visibility set to ' + visibility);
    return updated;
  }

  // ─── Executive summary ────────────────────────────────────────

  private buildExecutiveSummary(
    title: string,
    url: string,
    score: ScoreSummary,
    findings: ReportFindingDto[],
    roadmap: ReportRoadmapDto[],
    growthPlan: GrowthPlanDto,
  ): string {
    const failures = findings.filter((f) => f.status === 'fail');
    const highSev = failures.filter((f) => f.severity === 'high');

    const lines: string[] = [];
    lines.push(title + ' scores ' + score.total + '/100 (' + score.band + ') on AI visibility.');
    lines.push('');

    if (failures.length === 0) {
      lines.push('No blocking issues found — all ' + findings.length + ' checks passed. AI crawlers can read the site and structured data is intact.');
    } else {
      lines.push(failures.length + ' of ' + findings.length + ' checks failed:');
      for (const f of failures) {
        const detail = f.detail as Record<string, unknown>;
        let extra = '';
        if (detail && 'contentLossPercent' in detail && typeof detail['contentLossPercent'] === 'number') {
          extra = ' (' + detail['contentLossPercent'] + '% content loss without JS)';
        }
        const firstSentence = firstSentenceOf(f.recommendedFix);
        lines.push('  - ' + f.type + ': ' + firstSentence + extra);
      }
      if (highSev.length > 0) {
        lines.push('');
        lines.push(highSev.length + ' HIGH-severity issue' + (highSev.length > 1 ? 's' : '') + ' need immediate attention.');
      }
    }

    if (roadmap.length > 0) {
      const fixes = roadmap.filter((r) => r.action === 'fix').length;
      const builds = roadmap.filter((r) => r.action === 'build').length;
      const influences = roadmap.filter((r) => r.action === 'influence').length;
      lines.push('');
      lines.push('Roadmap: ' + fixes + ' fix, ' + builds + ' build, ' + influences + ' influence items.');
    }

    if (growthPlan.actionPlan && growthPlan.actionPlan.recommendations.length > 0) {
      const top = growthPlan.actionPlan.recommendations[0]; // already ranked quick-wins-first
      lines.push('');
      lines.push(
        'Growth plan: ' + growthPlan.actionPlan.recommendations.length + ' recommendation categor' +
          (growthPlan.actionPlan.recommendations.length === 1 ? 'y' : 'ies') + ', top priority — ' + top.title + '.',
      );
    }

    return lines.join('\n');
  }

  // ─── Roadmap snapshot ─────────────────────────────────────────

  private async getRoadmapSnapshot(projectId: string): Promise<ReportRoadmapDto[]> {
    const gaps = await this.prisma.gap.findMany({
      where: { gapAnalysis: { projectId } },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
    });

    return gaps.map((g: any) => ({
      dimension: g.dimension,
      action: g.action,
      title: g.title,
      description: g.description,
      severity: g.severity,
      priorityScore: g.priorityScore,
      status: g.status,
    }));
  }

  // ─── Growth plan snapshot (stage 12 "Prioritized Growth Roadmap") ──

  /**
   * Both sources are pure reads — `strategy.getActionPlan()` returns the
   * last-built plan (null if `POST .../strategy/build` was never called);
   * `findings.list()` returns whatever `findings.generate()` has already
   * stored. Report generation never triggers either module to do fresh work.
   */
  private async getGrowthPlanSnapshot(projectId: string): Promise<GrowthPlanDto> {
    const [actionPlan, findingsResult, growthAssets] = await Promise.all([
      this.strategy.getActionPlan(projectId),
      this.findings.list(projectId),
      this.getGrowthAssetCounts(projectId),
    ]);

    return {
      actionPlan: actionPlan
        ? {
            recommendations: actionPlan.recommendations.map((r) => ({
              category: r.category,
              label: r.label,
              title: r.title,
              summary: r.summary,
              priorityRank: r.priorityRank,
              quickWinCount: r.quickWinCount,
              majorProjectCount: r.majorProjectCount,
              fillInCount: r.fillInCount,
              thanklessTaskCount: r.thanklessTaskCount,
              gapIds: r.gapIds,
            })),
            notCovered: actionPlan.notCovered,
            updatedAt: actionPlan.updatedAt,
          }
        : null,
      findingsCopy: findingsResult.findings.map((f: any) => ({
        gapId: f.gapId,
        title: f.title,
        whatExecutive: f.whatExecutive,
        whatTechnical: f.whatTechnical,
        whyExecutive: f.whyExecutive,
        whyTechnical: f.whyTechnical,
        fixExecutive: f.fixExecutive,
        fixTechnical: f.fixTechnical,
        thinRun: f.thinRun,
        disclosedGap: f.disclosedGap,
      })),
      assetsNote: this.buildAssetsNote(growthAssets),
      growthAssets,
    };
  }

  /**
   * D11 — what this report says about stage 11 ("Marketing & Growth
   * Execution").
   *
   * The previous sentence claimed the module did not exist. It does, so the
   * note now states what is actually true: how many growth-execution assets
   * this project has, and the fact that they are *not copied* into the report
   * snapshot (that section is G09/G13's approved editorial plan). The
   * difference matters — "not included in this snapshot" and "nothing exists"
   * are different disclosures, and the old text said the second when the first
   * was meant.
   */
  private buildAssetsNote(counts: GrowthAssetCountsDto | null): string {
    if (!counts) {
      return (
        'Growth execution assets for this project could not be counted when this snapshot was built, so how many exist ' +
        'is unrecorded here — not zero. This report does not include asset briefs or bodies in any case.'
      );
    }
    if (counts.total === 0) {
      return (
        'No growth-execution assets (article, ad copy, social, email, landing page, structured data, SEO fix, FAQ, ' +
        'review campaign) have been created for this project yet, so there is nothing of that kind to include.'
      );
    }
    return (
      `${counts.total} growth-execution asset${counts.total === 1 ? '' : 's'} exist for this project ` +
      `(${counts.recommended} recommended, ${counts.inProgress} in progress, ${counts.published} published). ` +
      'Their briefs and bodies are deliberately not copied into this report snapshot — the approved editorial-plan ' +
      'section is G09/G13 work — so read them in the project\'s Growth Execution workspace.'
    );
  }

  /**
   * Counts by `GrowthAsset.status` — a read-only lookup, best-effort for the
   * same reason every other optional snapshot source is: a report must not
   * fail because one auxiliary source is unavailable. `null` means the lookup
   * failed and is reported as unrecorded rather than as zero.
   */
  private async getGrowthAssetCounts(projectId: string): Promise<GrowthAssetCountsDto | null> {
    try {
      const rows = await this.prisma.growthAsset.groupBy({ by: ['status'], where: { projectId }, _count: true });
      const counts: GrowthAssetCountsDto = { total: 0, recommended: 0, inProgress: 0, published: 0 };
      for (const row of rows) {
        const n = row._count;
        counts.total += n;
        if (row.status === 'recommended') counts.recommended = n;
        else if (row.status === 'in-progress') counts.inProgress = n;
        else if (row.status === 'published') counts.published = n;
      }
      return counts;
    } catch (err) {
      this.logger.warn(`Report: growth-asset counts unavailable for ${projectId} — the section is disclosed as unrecorded: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Render (FR-10.1, FR-10.3, FR-10.4) ──────────────────────

  /**
   * Render the branded HTML page (§6.4: "Published reports are frozen
   * snapshots").
   *
   * When the report has a released revision, this renders **that revision's
   * frozen snapshot** — not the mutable `Report` row — so a link handed to a
   * client cannot change under them when someone regenerates or edits the
   * report afterwards. An unreleased report (and a report whose release was
   * withdrawn) renders the live row, which is what an operator previewing
   * their own draft is looking at.
   *
   * The visibility gate and the released-revision resolution live in
   * {@link documentFor}, which the PDF render calls too: the two outputs are
   * built from one `ReportDocument` and gated by one code path, so they cannot
   * disagree about what may be rendered or what it says.
   */
  async renderHtml(
    slug: string,
    view: 'executive' | 'detailed' = 'executive',
    options: { includePrivate?: boolean; projectId?: string } = {},
  ): Promise<string> {
    const document = await this.documentFor(slug, view, options, 'web');
    return this.compile(document);
  }

  /**
   * Render the same document as a PDF (FR-10.3's detailed register, as a file
   * a client can keep).
   *
   * Identical gating to {@link renderHtml} — same project scoping, same
   * `visibility`/`includePrivate` rule, same frozen released revision — because
   * it is the same call. The PDF adds a layout, not a surface: an unreleased
   * report is reachable here exactly when it is reachable as HTML, and one
   * route cannot be used to read a report the other refuses.
   */
  async renderPdf(
    slug: string,
    view: 'executive' | 'detailed' = 'executive',
    options: { includePrivate?: boolean; projectId?: string } = {},
  ): Promise<ReportPdfArtifact> {
    const document = await this.documentFor(slug, view, options, 'pdf');
    return this.pdfArtifact(document);
  }

  /**
   * Render a report a share token resolved to: always the report's frozen
   * released revision, always noindex, never the live row.
   *
   * The caller ({@link import('./report-lifecycle.service').ReportLifecycleService.resolveShareToken})
   * has already established that the token is live and that the report is
   * released; this only renders. A missing or unreadable revision throws
   * rather than falling back to the mutable row — falling back would be the
   * one path where an unapproved edit could leak through a public link.
   */
  async renderReleasedHtml(report: Report, revision: ReportRevision, view: 'executive' | 'detailed' = 'executive'): Promise<string> {
    return this.compile(this.releasedDocument(report, revision, view, 'web', 'client-facing', 'private', true));
  }

  /** The token route's PDF: the same frozen revision, the same one build path. */
  async renderReleasedPdf(
    report: Report,
    revision: ReportRevision,
    view: 'executive' | 'detailed' = 'executive',
  ): Promise<ReportPdfArtifact> {
    return this.pdfArtifact(this.releasedDocument(report, revision, view, 'pdf', 'client-facing', 'private', true));
  }

  /**
   * The one place a render's visibility and release rules are applied.
   *
   * Both the HTML and the PDF renderers call this, so there is a single answer
   * to "may this be rendered, and from which source": the frozen released
   * revision when there is one, the live row otherwise. `surface` only decides
   * the footer's closing notice.
   */
  private async documentFor(
    slug: string,
    view: 'executive' | 'detailed',
    options: { includePrivate?: boolean; projectId?: string },
    surface: ReportSurface,
  ): Promise<ReportDocument> {
    const report = await this.prisma.report.findFirst({
      where: { slug, ...(options.projectId ? { projectId: options.projectId } : {}) },
    });
    if (!report) throw new NotFoundException('Report ' + slug + ' not found');
    if (report.visibility === 'private' && !options.includePrivate) {
      throw new NotFoundException('Report ' + slug + ' not found');
    }

    const released = await this.releasedRevisionOf(report);
    if (released) {
      return this.releasedDocument(
        report,
        released,
        view,
        surface,
        options.includePrivate ? 'operator' : 'client-facing',
        report.visibility as 'private' | 'public',
        !options.includePrivate,
      );
    }

    return buildReportDocument(await this.toReportData(report), {
      view,
      surface,
      audience: options.includePrivate ? 'operator' : 'client-facing',
    });
  }

  /**
   * The frozen revision as a document.
   *
   * Every content field comes from `snapshot`; only the identifying fields the
   * snapshot deliberately does not freeze (`id`, `slug`, `visibility`, and the
   * release stamps) come from the mutable row.
   */
  private releasedDocument(
    report: Report,
    revision: ReportRevision,
    view: 'executive' | 'detailed',
    surface: ReportSurface,
    audience: ReportAudience,
    visibility: 'private' | 'public',
    noindex: boolean,
  ): ReportDocument {
    const snapshot = this.parseSnapshot(revision.snapshot);
    return buildReportDocument(
      { ...snapshot, ...releaseStamps(report, revision), visibility },
      { view, surface, audience, noindex },
    );
  }

  /** The client-facing view of a released report: the frozen snapshot, dressed
   * with the identifying fields that live on the mutable row (id, slug,
   * visibility) and the release facts.
   *
   * Explicitly **not** `toReportData(report)`: that reads the live columns, so
   * a report edited after release would show the edit to its client. Every
   * content field below therefore comes from the snapshot.
   */
  buildReleasedView(report: Report, revision: ReportRevision): ReleasedReportDto {
    const snapshot = this.parseSnapshot(revision.snapshot);
    return {
      id: report.id,
      projectId: report.projectId,
      slug: report.slug,
      title: snapshot.title || revision.title || report.title,
      targetUrl: snapshot.targetUrl,
      visibility: report.visibility as 'private' | 'public',
      executiveSummary: snapshot.executiveSummary,
      scoreTotal: snapshot.scoreTotal,
      scoreBand: snapshot.scoreBand,
      subScores: snapshot.subScores,
      findings: snapshot.findings,
      roadmap: snapshot.roadmap,
      growthPlan: this.repairLegacyGrowthPlan(snapshot.growthPlan),
      backlinks: snapshot.backlinks,
      presence: snapshot.presence,
      competitors: snapshot.competitors,
      createdAt: snapshot.contentCreatedAt || report.createdAt.toISOString(),
      status: 'released',
      releasedRevision: revision.revision,
      releasedAt: report.releasedAt ? report.releasedAt.toISOString() : revision.publishedAt ? revision.publishedAt.toISOString() : null,
      releasedBy: report.releasedBy ?? revision.publishedBy,
      manifestId: snapshot.manifestId ?? revision.manifestId ?? report.manifestId,
      rubricVersion: snapshot.rubricVersion,
      scoreRunId: snapshot.scoreRunId,
      revision: revision.revision,
      snapshotAt: snapshot.snapshotAt,
    };
  }

  /** The report's currently-released revision, if any — resolved inside this report, never by number alone. */
  private async releasedRevisionOf(report: Report): Promise<ReportRevision | null> {
    if (report.status !== 'released' || report.releasedRevision == null) return null;
    return this.prisma.reportRevision.findFirst({
      where: { reportId: report.id, revision: report.releasedRevision, status: 'released' },
    });
  }

  /** Compile the shared document into the HTML template. */
  private compile(document: ReportDocument): string {
    let templateSrc: string;
    try {
      templateSrc = readFileSync(join(__dirname, 'templates', 'report-html.hbs'), 'utf8');
    } catch {
      templateSrc = readFileSync(join(process.cwd(), 'src', 'modules', 'reporting', 'templates', 'report-html.hbs'), 'utf8');
    }
    return Handlebars.compile(templateSrc)({ document });
  }

  /** Render the document to bytes, with the name a browser should save it under. */
  private async pdfArtifact(document: ReportDocument): Promise<ReportPdfArtifact> {
    const bytes = await renderReportPdf(document);
    const revision = document.cover.releasedRevision;
    const filename = `${document.cover.slug}-${document.view}-${revision == null ? 'draft' : `r${revision}`}.pdf`;
    return { bytes, filename, view: document.view, releasedRevision: revision };
  }

  // ─── G05 — revision snapshots ─────────────────────────────────

  /**
   * Freeze a report row's current content into a `ReportRevisionSnapshot`.
   *
   * This is the only producer of a snapshot, and it is called exactly once per
   * revision lock (and once per pre-G05 row during the migration), so the
   * payload a reviewer approves is byte-identical to the payload a client
   * later reads. It deliberately copies resolved values rather than ids where
   * a value could later change: `rubricVersion`/`scoreRunId` come from the
   * report's pinned evidence manifest, which is itself immutable.
   *
   * Note what is *not* in here: `id`, `slug`, `visibility` and `status`. Those
   * live on the mutable `Report` row and are the things a later revision is
   * allowed to change; putting them in the snapshot would freeze the wrong
   * half of the record.
   */
  async buildRevisionSnapshot(record: Report): Promise<ReportRevisionSnapshot> {
    const manifest = await this.manifestFacts(record.manifestId);
    return {
      title: record.title,
      targetUrl: record.targetUrl,
      executiveSummary: record.executiveSummary,
      scoreTotal: record.scoreTotal,
      scoreBand: record.scoreBand as ScoreBand,
      subScores: (this.parseJson<SubScore[]>(record.subScores) ?? []),
      findings: (this.parseJson<ReportFindingDto[]>(record.findingsSnapshot) ?? []),
      roadmap: (this.parseJson<ReportRoadmapDto[]>(record.roadmapSnapshot) ?? []),
      growthPlan: record.growthPlanSnapshot ? this.repairLegacyGrowthPlan(this.parseJson<GrowthPlanDto>(record.growthPlanSnapshot)) : null,
      backlinks: record.backlinksSnapshot ? this.parseJson<BacklinksSummaryDto>(record.backlinksSnapshot) : null,
      presence: record.presenceSnapshot ? this.parseJson<PresenceInventory>(record.presenceSnapshot) : null,
      competitors: record.competitorsSnapshot ? this.parseJson<GapResult>(record.competitorsSnapshot) : null,
      branding: record.branding ? this.parseJson<BrandingConfig>(record.branding) : null,
      rubricVersion: manifest?.rubricVersion ?? null,
      scoreRunId: manifest?.scoreRunId ?? null,
      manifestId: record.manifestId,
      periodId: record.periodId,
      cohortId: record.cohortId,
      contentCreatedAt: record.createdAt.toISOString(),
      contentUpdatedAt: record.updatedAt.toISOString(),
      snapshotAt: new Date().toISOString(),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** JSON parse that returns null instead of a partially-typed guess. */
  private parseJson<T>(value: string | null | undefined): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  private parseSnapshot(value: string): ReportRevisionSnapshot {
    const parsed = this.parseJson<ReportRevisionSnapshot>(value);
    return parsed ?? {
      title: '',
      targetUrl: '',
      executiveSummary: '',
      scoreTotal: 0,
      scoreBand: 'invisible',
      subScores: [],
      findings: [],
      roadmap: [],
      growthPlan: null,
      backlinks: null,
      presence: null,
      competitors: null,
      branding: null,
      rubricVersion: null,
      scoreRunId: null,
      manifestId: null,
      periodId: null,
      cohortId: null,
      contentCreatedAt: '',
      contentUpdatedAt: '',
      snapshotAt: '',
    };
  }

  /**
   * D11 — read-time repair of the pre-2026-09-16 `assetsNote`.
   *
   * Applied when a snapshot is *served* (and when a new snapshot is built from
   * an older row's stored growth plan), never written back: released
   * snapshots stay byte-identical, and `assetsNoteCorrected` marks the
   * sentence as repaired so a reader is not shown edited history as if it were
   * the original.
   */
  private repairLegacyGrowthPlan(plan: GrowthPlanDto | null): GrowthPlanDto | null {
    if (!plan || typeof plan.assetsNote !== 'string') return plan;
    if (!plan.assetsNote.includes(LEGACY_ASSETS_NOTE_MARKER)) return plan;
    return { ...plan, assetsNote: LEGACY_ASSETS_NOTE_REPAIR, assetsNoteCorrected: true };
  }

  /** `scoreRunId`/`rubricVersion` off the report's pinned manifest — the only recorded provenance for the score. */
  private async manifestFacts(manifestId: string | null): Promise<{ scoreRunId: string | null; rubricVersion: number | null } | null> {
    if (!manifestId) return null;
    const row = await this.prisma.evidenceManifest.findUnique({
      where: { id: manifestId },
      select: { scoreRunId: true, rubricVersion: true },
    });
    if (!row) return null;
    const version = row.rubricVersion == null ? null : Number(row.rubricVersion);
    return { scoreRunId: row.scoreRunId, rubricVersion: Number.isFinite(version) ? version : null };
  }

  private buildSlug(title: string): string {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base + '-' + Date.now().toString(36);
  }

  private async toReportData(record: Report): Promise<ReportData> {
    const manifest = await this.manifestFacts(record.manifestId);
    return {
      id: record.id,
      projectId: record.projectId,
      slug: record.slug,
      title: record.title,
      targetUrl: record.targetUrl,
      visibility: record.visibility as 'private' | 'public',
      executiveSummary: record.executiveSummary,
      scoreTotal: record.scoreTotal,
      scoreBand: record.scoreBand as ScoreBand,
      subScores: this.parseJson<SubScore[]>(record.subScores) ?? [],
      findings: this.parseJson<ReportFindingDto[]>(record.findingsSnapshot) ?? [],
      roadmap: this.parseJson<ReportRoadmapDto[]>(record.roadmapSnapshot) ?? [],
      // Reports generated before this field existed have no column value at all.
      growthPlan: record.growthPlanSnapshot ? this.repairLegacyGrowthPlan(this.parseJson<GrowthPlanDto>(record.growthPlanSnapshot)) : null,
      backlinks: record.backlinksSnapshot ? this.parseJson<BacklinksSummaryDto>(record.backlinksSnapshot) : null,
      presence: record.presenceSnapshot ? this.parseJson<PresenceInventory>(record.presenceSnapshot) : null,
      competitors: record.competitorsSnapshot ? this.parseJson<GapResult>(record.competitorsSnapshot) : null,
      createdAt: record.createdAt.toISOString(),
      status: record.status as ReportEditorialStatus,
      releasedRevision: record.releasedRevision,
      releasedAt: record.releasedAt ? record.releasedAt.toISOString() : null,
      releasedBy: record.releasedBy,
      manifestId: record.manifestId,
      rubricVersion: manifest?.rubricVersion ?? null,
      scoreRunId: manifest?.scoreRunId ?? null,
    };
  }
}

/**
 * The identifying and release facts a rendered document states about itself,
 * kept separate from the frozen snapshot: they describe *which row this is* and
 * *when this version was released*, neither of which is content that was
 * reviewed.
 *
 * Typed rather than a loose record: these fields are spread into the document
 * input, and a `Record<string, unknown>` would erase the very fields the
 * renderer is entitled to rely on.
 *
 * `releasedBy` is resolved exactly as {@link ReportingService.buildReleasedView}
 * resolves it — the row's recorded releaser, falling back to the revision's —
 * so the HTML page, the PDF cover and the portal JSON cannot name a different
 * person for the same release.
 */
interface ReleaseStamps {
  id: string;
  projectId: string;
  slug: string;
  status: ReportEditorialStatus;
  releasedRevision: number;
  releasedAt: string | null;
  releasedBy: string | null;
  createdAt: string;
}

function releaseStamps(report: Report, revision: ReportRevision): ReleaseStamps {
  return {
    id: report.id,
    projectId: report.projectId,
    slug: report.slug,
    status: report.status as ReportEditorialStatus,
    releasedRevision: revision.revision,
    releasedAt: revision.publishedAt ? revision.publishedAt.toISOString() : report.releasedAt?.toISOString() ?? null,
    releasedBy: report.releasedBy ?? revision.publishedBy,
    createdAt: report.createdAt.toISOString(),
  };
}

/**
 * The first sentence of a fix description, without mangling it.
 *
 * The previous implementation was `text.split('.')[0] + '.'`, which splits on
 * the first period **anywhere** — so a URL, a version number or an abbreviation
 * ended the "sentence". "Sitemap found at https://day1tech.com/sitemap.xml.
 * Submit it." became "Sitemap found at https://day1tech.", which is both wrong
 * and embarrassing on a document a client reads.
 *
 * A sentence ends at a period/question/exclamation **followed by whitespace or
 * the end of the string**, which is what keeps `day1tech.com` intact. Returns
 * the whole string when it is a single sentence.
 */
function firstSentenceOf(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const match = /^(.*?[.!?])(\s|$)/.exec(trimmed);
  return match ? match[1] : trimmed;
}
