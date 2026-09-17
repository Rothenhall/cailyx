/**
 * OverviewService — the composed project Overview (platform_improvement_plan.md
 * §5.1, §5.5–§5.7, phase P15).
 *
 * §5.7 puts this composition "in an existing project/results read-model owner,
 * not in a controller or a React component": this is the results module, which
 * already owns the project read models, and this service is the only place the
 * Overview's panels are assembled. The controllers route; the web renders.
 *
 * Three properties are structural rather than conventional:
 *
 *  1. **Every panel is its own section envelope** (`OverviewSection<T>`). One
 *     source read failing produces one `unavailable` panel with a safe
 *     sentence; the other four still render (§4.5's partial-failure rule).
 *     The catch happens here, at the projection boundary, so provider
 *     exception text is replaced by a stable reason code before it can reach a
 *     screen (§4.4).
 *  2. **Every read is a read** (§5.7). Nothing here starts an audit, refreshes
 *     a paid provider, builds a score or creates a job. The score panel calls
 *     `getClientSafe`, which reads stored runs; building one is the explicit
 *     `POST /scores/digital-performance/run`.
 *  3. **The hard limits are enforced by construction**, not by the UI's taste:
 *     `OVERVIEW_ACTION_LIMIT` cards with the true `total`, `OVERVIEW_UPCOMING_LIMIT`
 *     upcoming items, one total, and applicable buckets only.
 *
 * @module results/overview.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ContentCalendarService } from '../content-calendar/content-calendar.service';
import { DeliveryPlanService } from '../delivery-plan/delivery-plan.service';
import type { ActionItemDto } from '../delivery-plan/delivery-plan.types';
import { ReportLifecycleService } from '../reporting/report-lifecycle.service';
import { DigitalPerformanceService } from '../scoring/digital-performance.service';
import type { ClientSafeScoreBucket, ClientSafeScoreRun } from '../scoring/digital-performance.types';
import { PrismaService } from '../database/prisma.service';
import {
  OVERVIEW_ACTION_LIMIT,
  OVERVIEW_UPCOMING_LIMIT,
  type ClientOverviewView,
  type OverviewActionItem,
  type OverviewActionPanel,
  type OverviewBucketCard,
  type OverviewHeader,
  type OverviewPlanPanel,
  type OverviewReportPanel,
  type OverviewScorePanel,
  type OverviewSection,
  type OverviewSectionReasonCode,
  type OverviewSections,
  type OverviewTeamAttentionPanel,
  type OverviewUpcomingItem,
  type OverviewUpcomingPanel,
  type StaffOverviewView,
} from './overview.types';

/** §4.4's rule, applied to every panel: the reader gets this, not the exception. */
const PANEL_UNAVAILABLE_REASON =
  'We could not load this part of your overview just now. Everything else on this page is up to date.';

/** The window "Upcoming content" covers. One month, matching the calendar's own default view. */
const UPCOMING_WINDOW_DAYS = 30;

const ACTION_ORDER_NOTE =
  'Overdue and time-sensitive items first, then anything blocking other work, then everything else.';

@Injectable()
export class OverviewService {
  private readonly logger = new Logger(OverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly digitalPerformance: DigitalPerformanceService,
    private readonly deliveryPlan: DeliveryPlanService,
    private readonly contentCalendar: ContentCalendarService,
    private readonly reports: ReportLifecycleService,
  ) {}

  // ─── Public reads ──────────────────────────────────────────────

  /** The client's own project overview. Ownership is the caller's clientId. */
  async getClientOverview(clientId: string, projectId: string): Promise<ClientOverviewView> {
    const project = await this.requireClientProject(clientId, projectId);
    const header = await this.buildHeader(project);
    const sections: OverviewSections = {
      score: await this.section('score', projectId, () => this.buildScorePanel(projectId)),
      actions: await this.section('actions', projectId, async () => {
        const queue = await this.deliveryPlan.getPortalActionsOverview(clientId, projectId, OVERVIEW_ACTION_LIMIT);
        // §16.2 S02: Overview shows at most three; "View all" leads to the
        // full queue, not to a related-but-different screen.
        return this.ok(this.buildActionPanel(queue.items, queue.total, `/client/projects/${projectId}/actions`));
      }),
      upcomingContent: await this.section('upcomingContent', projectId, () =>
        this.buildUpcomingPanel(clientId, project, false),
      ),
      plan: await this.section('plan', projectId, async () => {
        const progress = await this.deliveryPlan.getPortalPlanProgress(clientId, projectId);
        const panel: OverviewPlanPanel = {
          totalCount: progress.totalCount,
          completedCount: progress.completedCount,
          label: progress.label,
          scopeNote: progress.scopeNote,
          planHref: `/client/projects/${projectId}/plan`,
        };
        return this.ok(panel);
      }),
      report: await this.section('report', projectId, () => this.buildReportPanel(clientId, projectId)),
    };

    return {
      projectId,
      audience: 'client',
      generatedAt: new Date().toISOString(),
      header,
      sections,
    };
  }

  /** The staff read of the same page, plus the §5.1 "Team attention" shortcut. */
  async getStaffOverview(user: AuthedRequestUser, projectId: string): Promise<StaffOverviewView> {
    const project = await this.requireProject(projectId);
    const header = await this.buildHeader(project);

    // The client-equivalent panels come from the project's own client, so
    // staff see exactly what the client sees. Read-only: `clientId` is never
    // trusted from a request body, only from the project row.
    const clientId = project.clientId;
    const sections: OverviewSections = {
      score: await this.section('score', projectId, () => this.buildScorePanel(projectId, true)),
      actions: await this.section('actions', projectId, async () => {
        if (!clientId) return this.empty<OverviewActionPanel>(null, 'This project has no client attached yet.', 'not-shared');
        const queue = await this.deliveryPlan.getPortalActionsOverview(clientId, projectId, OVERVIEW_ACTION_LIMIT);
        return this.ok(this.buildActionPanel(queue.items, queue.total, `/projects/${projectId}/actions`));
      }),
      upcomingContent: await this.section('upcomingContent', projectId, () =>
        clientId
          ? this.buildUpcomingPanel(clientId, project, true)
          : Promise.resolve(this.empty<OverviewUpcomingPanel>(null, 'This project has no client attached yet.', 'not-shared')),
      ),
      plan: await this.section('plan', projectId, async () => {
        if (!clientId) return this.empty<OverviewPlanPanel>(null, 'This project has no client attached yet.', 'not-shared');
        const progress = await this.deliveryPlan.getPortalPlanProgress(clientId, projectId);
        return this.ok<OverviewPlanPanel>({
          totalCount: progress.totalCount,
          completedCount: progress.completedCount,
          label: progress.label,
          scopeNote: progress.scopeNote,
          planHref: `/projects/${projectId}/cycles`,
        });
      }),
      report: await this.section('report', projectId, () =>
        clientId
          ? this.buildReportPanel(clientId, projectId, `/projects/${projectId}/reports`)
          : Promise.resolve(this.empty<OverviewReportPanel>(null, 'This project has no client attached yet.', 'not-shared')),
      ),
      // §5.1: a small staff shortcut *below* the client-equivalent information.
      teamAttention: await this.section('teamAttention', projectId, async () => {
        const queue = await this.deliveryPlan.getStaffActions(projectId, {
          userId: user.userId,
          role: user.role,
          type: user.type,
        });
        const panel: OverviewTeamAttentionPanel = {
          items: queue.items.slice(0, OVERVIEW_ACTION_LIMIT).map((item) => this.toActionItem(item)),
          total: queue.total,
          limit: OVERVIEW_ACTION_LIMIT,
          order: ACTION_ORDER_NOTE,
          href: `/projects/${projectId}/priorities`,
        };
        return panel.total === 0
          ? this.empty(panel, 'Nothing on this project is waiting on the team.', 'no-data-yet')
          : this.ok(panel);
      }),
    };

    return {
      projectId,
      audience: 'operator',
      generatedAt: new Date().toISOString(),
      header,
      sections: sections as StaffOverviewView['sections'],
    };
  }

  // ─── Sections ──────────────────────────────────────────────────

  /**
   * Run one panel's read in isolation.
   *
   * The catch is the whole point: §4.5 requires that one failed panel does not
   * blank the page, and §4.4 requires that the reader never sees the provider's
   * exception text. The real error goes to the server log — where the operator
   * can act on it — and the response carries a stable code and a safe sentence.
   */
  private async section<T>(
    panel: string,
    projectId: string,
    load: () => Promise<OverviewSection<T>>,
  ): Promise<OverviewSection<T>> {
    try {
      return await load();
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `Overview panel "${panel}" failed for project ${projectId}: ${error?.message ?? String(err)}`,
        error?.stack,
      );
      return { status: 'unavailable', data: null, reason: PANEL_UNAVAILABLE_REASON, reasonCode: 'read-failed' };
    }
  }

  private ok<T>(data: T): OverviewSection<T> {
    return { status: 'ok', data, reason: null, reasonCode: null };
  }

  private empty<T>(data: T | null, reason: string, reasonCode: OverviewSectionReasonCode): OverviewSection<T> {
    return { status: 'empty', data, reason, reasonCode };
  }

  // ─── Header ────────────────────────────────────────────────────

  private async buildHeader(project: { id: string; name: string; domain: string }): Promise<OverviewHeader> {
    return {
      projectId: project.id,
      projectName: project.name,
      domain: project.domain,
      contextLine: `${project.name} · ${project.domain}`,
      explanation:
        'Your score, anything waiting on you, what is coming up, and your latest report — the whole picture on one page.',
    };
  }

  // ─── Score panel (§5.1's one prominent score + applicable buckets) ─────────

  /**
   * §5.1's one prominent score, plus the bucket cards.
   *
   * `staff` only changes where "View results" points. There is no staff twin of
   * the client Results screen — the client's screen is the client's — so the
   * operator's equivalent is the §3.3 mapping into the research reads
   * (`research/website`), which show the same domain read models from the
   * operator's side. The panel's own content is identical for both audiences,
   * which is the point of §5.1's "client-equivalent information".
   */
  private async buildScorePanel(projectId: string, staff = false): Promise<OverviewSection<OverviewScorePanel>> {
    const { score, explanation } = await this.digitalPerformance.getClientSafe(projectId);
    const run: ClientSafeScoreRun | null = score.latest;

    // §5.1: the bucket cards are the APPLICABLE ones. A bucket recorded
    // not-applicable is a decision, reported in `excludedFromScore` and
    // explained in the sheet — never drawn as a card with a missing number.
    const applicable: ClientSafeScoreBucket[] = (run?.buckets ?? []).filter(
      (bucket) => bucket.applicability !== 'not-applicable',
    );
    const excluded = (run?.buckets ?? []).filter((bucket) => bucket.applicability === 'not-applicable');

    const buckets: OverviewBucketCard[] = applicable.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      weight: bucket.weight,
      state: bucket.state,
      stateLabel: bucket.stateLabel,
      value: bucket.value,
      windowStart: bucket.windowStart,
      windowEnd: bucket.windowEnd,
      missingReasons: bucket.missingReasons,
      // §5.5's drilldown: the stored detail target plus the period the bucket
      // was measured over, so the Results tab opens on the same window the card
      // describes rather than on today's default.
      detailPath: bucket.detail.path,
      detailQuery: bucket.detail.query,
      period: { start: bucket.detail.period.start, end: bucket.detail.period.end },
    }));

    // §5.3's no-fake-total contract, restated for the reader: the overall
    // number is missing exactly when an applicable bucket is unmeasured, and
    // which areas those are is named rather than implied.
    const missingAreas = buckets
      .filter((bucket) => bucket.state !== 'measured')
      .map((bucket) => `${bucket.label}: ${bucket.missingReasons[0] ?? bucket.stateLabel.toLowerCase()}`);

    const comparisonNote =
      run && run.comparison.state !== 'comparable'
        ? (run.comparison.changeUnavailableReason ??
          'We are not comparing this result with the previous one: the way it is measured changed, so a difference would not mean anything.')
        : null;

    const panel: OverviewScorePanel = {
      family: score.family,
      scoreName: score.scoreName,
      methodologyVersion: score.methodology.version,
      weightsApproved: score.methodology.weightsApproved,
      approvalNote: score.methodology.approvalNote,
      status: run ? (run.status === 'complete' ? 'complete' : 'incomplete') : 'none',
      statusLabel: run ? run.statusLabel : 'Not calculated yet',
      total: run ? run.total : null,
      runId: run?.id ?? null,
      runAt: run?.createdAt ?? null,
      evidenceCoverage: run?.evidenceCoverage ?? null,
      coverageMeaning: run?.coverageMeaning ?? '',
      lastComplete: score.lastComplete
        ? {
            id: score.lastComplete.id,
            createdAt: score.lastComplete.createdAt,
            total: score.lastComplete.total,
            evidenceCoverage: score.lastComplete.evidenceCoverage,
          }
        : null,
      lastCompleteIsLatest: score.lastCompleteIsLatest,
      missingAreas,
      excludedFromScore: excluded.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        reason: bucket.applicabilityReason,
      })),
      changeInTotal: run?.comparison.changeInTotal ?? null,
      comparisonNote,
      buckets,
      howThisScoreWorks: {
        headline: explanation.headline,
        missingDataRule: explanation.missingDataRule,
        totalRule: explanation.totalRule,
        coverageRule: explanation.coverageRule,
        comparisonRule: explanation.comparisonRule,
        methodologyVersion: explanation.methodologyVersion,
        buckets: explanation.buckets,
      },
      // §14.6's live/report distinction, in the reader's words.
      liveLabel: run ? `Live score, updated ${run.createdAt.slice(0, 10)}` : 'Live score',
      resultsHref: staff ? `/projects/${projectId}/research/website` : `/client/projects/${projectId}/results`,
    };

    if (!run) {
      return this.empty(
        panel,
        'We have not calculated your first score yet. Nothing is waiting on you for this.',
        'no-data-yet',
      );
    }
    return this.ok(panel);
  }

  // ─── Action panel (§5.6) ───────────────────────────────────────

  private buildActionPanel(
    items: ActionItemDto[],
    total: number,
    viewAllHref: string,
  ): OverviewActionPanel {
    return {
      // The server caps at the source, and the cap is applied again here so a
      // caller passing a larger limit through the wrong door still cannot
      // produce a fourth card.
      items: items.slice(0, OVERVIEW_ACTION_LIMIT).map((item) => this.toActionItem(item)),
      // The TRUE total, never `items.length`. §5.6's whole point.
      total,
      limit: OVERVIEW_ACTION_LIMIT,
      // The service already ordered these by §5.6's rule (overdue, then
      // blocking, then normal); the note records that so the UI does not
      // re-sort and invent a different order.
      order: ACTION_ORDER_NOTE,
      viewAllHref,
      allClearMessage: 'Nothing is waiting on you. We will tell you when something needs your attention.',
    };
  }

  /**
   * §5.6's presentation rules, enforced at the boundary:
   *
   *  - The card carries the source's identity (`sourceType` + `sourceId`) and
   *    its current state, and nothing that lets a reader "complete" it from
   *    here. Opening a card is a navigation, not an action: there is no route
   *    in this payload that resolves the item, and none of the panel's fields
   *    is a completion target.
   *  - Internal routing detail (`audience`, `eligibleActorId`, `projectId`,
   *    `createdAt`) is dropped — it is how the server decided this row belongs
   *    to the reader, not information the reader needs.
   */
  private toActionItem(item: ActionItemDto): OverviewActionItem {
    return {
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      title: item.title,
      reason: item.reason,
      deadline: item.deadline,
      severity: item.severity,
      destination: item.destination,
      currentVersion: item.currentVersion,
      completionCondition: item.completionCondition,
    };
  }

  // ─── Upcoming content (§5.1) ───────────────────────────────────

  /**
   * Read through the calendar's own portal read, not a second query: the panel
   * therefore respects the calendar's client-audience rules (an unshared
   * internal draft is absent from the items *and* from the count) and can never
   * disagree with the calendar screen about what is scheduled.
   *
   * The read is bounded — one window, `OVERVIEW_UPCOMING_LIMIT` items — so the
   * Overview never becomes a second calendar.
   */
  private async buildUpcomingPanel(
    clientId: string,
    project: { id: string; timezone: string },
    staff: boolean,
  ): Promise<OverviewSection<OverviewUpcomingPanel>> {
    // Window bounds are local DATES in the project's own zone, which is what
    // the calendar read expects (a bare date means local midnight): "the next
    // 30 days" therefore starts when the client's day starts, not at whatever
    // instant the panel happened to be opened.
    const timezone = project.timezone || 'UTC';
    const query = {
      from: localDateString(timezone, 0),
      to: localDateString(timezone, UPCOMING_WINDOW_DAYS),
      limit: OVERVIEW_UPCOMING_LIMIT,
      unscheduledLimit: 1,
    };
    const result = await this.contentCalendar.readPortalCalendar(clientId, project.id, query);

    const items: OverviewUpcomingItem[] = result.events.slice(0, OVERVIEW_UPCOMING_LIMIT).map((event) => ({
      scheduleId: event.scheduleId,
      assetId: event.assetId,
      title: event.title,
      contentTypeLabel: event.contentTypeLabel,
      channelLabel: event.channelLabel,
      state: event.state,
      stateLabel: event.stateLabel,
      scheduledForUtc: event.scheduledForUtc,
      plannedLocalDate: event.plannedLocalDate,
      plannedLocalTime: event.plannedLocalTime,
      timezone: event.timezone,
      pastDue: event.pastDue,
      pastDueLabel: event.pastDueLabel,
      href: staff
        ? `/projects/${project.id}/calendar?event=${encodeURIComponent(event.scheduleId)}`
        : `/client/projects/${project.id}/calendar?event=${encodeURIComponent(event.scheduleId)}`,
    }));

    const panel: OverviewUpcomingPanel = {
      items,
      totalInWindow: result.totalInWindow,
      window: { from: query.from, to: query.to, timezone: result.window.timezone },
      calendarHref: staff ? `/projects/${project.id}/calendar` : `/client/projects/${project.id}/calendar`,
      // The calendar tells us whether its own count is exact; passing that
      // through means this panel never presents a partial count as a total.
      truncated: !result.totalIsExact || result.page.hasMore,
    };

    if (items.length === 0) {
      return this.empty(panel, 'Nothing is scheduled in the next 30 days yet.', 'no-data-yet');
    }
    return this.ok(panel);
  }

  // ─── Plan footer (§5.1) / report footer (§5.1, §14.6) ──────────

  /**
   * The latest **released** report, read through the lifecycle service's
   * release gate. Everything shown comes from the frozen snapshot — including
   * the score, which is why a report released in September keeps saying what it
   * said in September no matter how many live runs happen later (§14.6).
   */
  private async buildReportPanel(
    clientId: string,
    projectId: string,
    hrefOverride?: string,
  ): Promise<OverviewSection<OverviewReportPanel>> {
    const { reports } = await this.reports.listReleasedForClient(clientId, projectId);
    const latest = reports[0];
    if (!latest) {
      return this.empty<OverviewReportPanel>(
        null,
        'No report has been released for this project yet. When one is, it will appear here.',
        'no-data-yet',
      );
    }

    const frozen = latest.digitalPerformance ?? null;
    const panel: OverviewReportPanel = {
      slug: latest.slug,
      title: latest.title,
      revision: latest.revision,
      releasedAt: latest.releasedAt ?? latest.contentUpdatedAt,
      // §14.6's distinction, in the reader's words: this number is not the live one.
      releasedLabel: `As released in the ${monthLabel(latest.releasedAt ?? latest.contentUpdatedAt)} report`,
      releasedScoreTotal: latest.scoreTotal,
      releasedScoreBand: latest.scoreBand,
      releasedDigitalPerformance: frozen
        ? {
            family: frozen.family,
            methodologyVersion: frozen.methodology.version,
            status: frozen.status,
            total: frozen.total,
            evidenceCoverage: frozen.evidenceCoverage,
            measuredBucketCount: frozen.buckets.filter((bucket) => bucket.state === 'measured').length,
            applicableBucketCount: frozen.buckets.length,
            frozenAt: frozen.frozenAt,
          }
        : null,
      releasedPlanProgress: latest.planProgress
        ? {
            totalCount: latest.planProgress.totalCount,
            completedCount: latest.planProgress.completedCount,
            label: latest.planProgress.label,
          }
        : null,
      href: hrefOverride ?? `/client/reports/${latest.slug}`,
    };
    return this.ok(panel);
  }

  // ─── Projects ──────────────────────────────────────────────────

  private async requireProject(projectId: string): Promise<{ id: string; name: string; domain: string; timezone: string; clientId: string | null }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, domain: true, timezone: true, clientId: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  /**
   * The portal ownership rule: a mismatch is a 404 from here, so a caller that
   * reaches this service cannot confirm that another client's project exists.
   * The controller runs `assertProjectAccess` first, and that shared guard
   * answers 403 for a client reading a project that is not theirs (the same
   * behaviour the pre-existing `/portal/projects/:id/results` route has), so
   * this check is the second line of defence rather than the only one — it is
   * kept because a service must not depend on its caller for ownership.
   */
  private async requireClientProject(clientId: string, projectId: string) {
    const project = await this.requireProject(projectId);
    if (project.clientId !== clientId) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }
}

/** "September" from an ISO timestamp — used only for the release label, never for a measurement date. */
function monthLabel(value: string | null): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'latest';
  return date.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}

/**
 * `YYYY-MM-DD` in a specific zone, `offsetDays` from today. Used for the
 * calendar window: the calendar resolves a bare date against the project's own
 * timezone, so the Overview's "next 30 days" means the same 30 days the client
 * sees on the calendar screen.
 */
function localDateString(timezone: string, offsetDays: number): string {
  const at = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
