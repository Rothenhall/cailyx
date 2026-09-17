/**
 * ContentCalendarService — P10, the one content calendar
 * (platform_improvement_plan.md §6.4-§6.7).
 *
 * ## Why the merge happens here and not in the database
 *
 * §6.6 splits scheduling into an *intention* (`ContentSchedule`, which can exist
 * before any revision is approved) and an *execution* (`Publication`, which
 * cannot). The calendar presents those two as one event, and the merge is done
 * on read for a specific reason: every input to the derived state — the piece's
 * latest revision, whether an approval still covers it, the destination's
 * connection state, whether the client is paused — is a fact that changes
 * without anyone touching the placement. A stored `state` would be a copy that
 * goes stale the moment one of them moves, and a stale copy here reads as
 * "Scheduled" for something that will never be sent.
 *
 * ## One event per placement, always
 *
 * The event identity is `ContentSchedule.id` (`scheduleId`). Publications are
 * loaded *by* `scheduleId` and attached as a child, so three attempts on one
 * placement are one event with `attemptCount: 3` — never three rows from a
 * join. §6.6 calls this out explicitly ("not duplicate rows caused by joining
 * the same placement twice"), and it is also what keeps the cursor stable:
 * paging on `(plannedForUtc, id)` over placements cannot double-count or skip.
 *
 * ## Completeness is returned, not implied
 *
 * §6.7's exit gate is "month complete beyond 200 entries". Every read returns
 * `page.truncated`, `page.nextCursor` and a `totalInWindow` computed over the
 * whole window under the same filters, so a caller can always distinguish "this
 * month is empty" from "I loaded the first 200 of 431".
 *
 * ## What this service deliberately does NOT do
 *
 * - It does not create a `Publication` itself. Linking goes through
 *   `PublishingService.createPublication`, which owns every gate (approval at
 *   the exact revision, destination connected, permissions granted, provider
 *   implemented, project not paused at dispatch). §6.6: a placement must not be
 *   "a fake publication row that bypasses approval".
 * - It does not cancel a queued publication on the operator's behalf. What may
 *   be cancelled (no remote id, not published) is publishing's rule, and a
 *   second path to it would be a second set of rules.
 * - It propagates nothing (§6.7): moving a placement never re-dates a
 *   commitment, and moving a commitment never moves a placement.
 *
 * @module content-calendar.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import {
  CONTENT_ARTIFACT_TYPE,
  PublishingService,
  STALE_PUBLISHING_MS,
} from '../publishing/publishing.service';
import { findProvider } from '../publishing/publishing.types';
import type {
  CreatePlacementDto,
  LinkPublicationDto,
  UpdatePlacementDto,
} from './dto/content-calendar.dto';
import {
  CONTENT_TYPE_LABELS,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_UNSCHEDULED_LIMIT,
  HOLD_REASON_LABELS,
  MAX_EVENT_LIMIT,
  MAX_UNSCHEDULED_LIMIT,
  MAX_WINDOW_DAYS,
  MAX_WINDOW_SCAN,
  PAST_DUE_LABEL,
  PAST_DUE_REASON_LABELS,
  SCHEDULE_STATE_LABELS,
  channelLabel,
  contentTypeForAssetType,
  findPlanningOnlyChannel,
  type CalendarContentType,
  type CalendarEvent,
  type CalendarPage,
  type CalendarReadResult,
  type CalendarScopeInfo,
  type DeliveryMode,
  type HoldReason,
  type PastDueReason,
  type PlanningOnlyChannel,
  type ScheduleState,
  type UnscheduledContentItem,
  type VerificationState,
} from './content-calendar.types';
import {
  daysBetween,
  endOfLocalDay,
  endOfLocalMonth,
  isValidTimeZone,
  resolvePlacementLocalTime,
  resolveWindowBound,
  startOfLocalDay,
  startOfLocalMonth,
} from './lib/timezone.util';

/** Everything every scope's read shares, so there is one read pipeline. */
export interface CalendarReadQuery {
  from?: string;
  to?: string;
  timezone?: string;
  type?: string;
  channel?: string;
  state?: string;
  ownerId?: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
  unscheduledLimit?: number;
  unscheduledCursor?: string;
}

/** Who is reading. A `client` read is filtered, never field-masked. */
export type CalendarAudience = 'staff' | 'client';

interface ResolvedScope {
  info: CalendarScopeInfo;
  /** `null` means unrestricted (admin) — then no `projectId IN (...)` filter is applied. */
  projectIds: string[] | null;
  timezone: string;
}

/** Batched once per page; nothing in here is per-row. */
interface DerivationContext {
  assets: Map<string, AssetRow>;
  latestRevision: Map<string, { id: string; revision: number }>;
  approvedRevision: Map<string, number>;
  /** Highest client-visible revision number per asset, when one exists. */
  sharedRevision: Map<string, number>;
  destinations: Map<string, DestinationRow>;
  approvalsById: Map<string, string>;
  pausedProjectIds: Set<string>;
  publicationsBySchedule: Map<string, PublicationRow[]>;
  /** Owner display names, so a staff read can label the owner filter. */
  owners: Map<string, string>;
  now: Date;
}

type AssetRow = {
  id: string;
  title: string;
  assetType: string;
  projectId: string;
  assigneeId: string | null;
  updatedAt: Date;
};

type PlacementRow = {
  id: string;
  projectId: string;
  assetId: string;
  briefId: string | null;
  commitmentId: string | null;
  contentType: string;
  channel: string;
  deliveryMode: string;
  destinationId: string | null;
  plannedForUtc: Date;
  plannedLocalDate: string;
  plannedLocalTime: string;
  timezone: string;
  dstDisambiguation: string | null;
  status: string;
  cancelledAt: Date | null;
  cancelReason: string | null;
  ownerId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type DestinationRow = {
  id: string;
  label: string;
  provider: string;
  status: string;
  revokedAt: Date | null;
};

type PublicationRow = {
  id: string;
  projectId: string;
  destinationId: string;
  assetId: string;
  revisionId: string;
  approvalId: string | null;
  scheduleId: string | null;
  mode: string;
  scheduledFor: Date | null;
  status: string;
  remoteId: string | null;
  remoteUrl: string | null;
  verifiedAt: Date | null;
  verifiedUrl: string | null;
  verifyError: string | null;
  error: string | null;
  attempt: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * §6.4's exclusion list, expressed as the asset types this calendar therefore
 * does not carry.
 *
 * `GrowthAsset.assetType` is the flowchart's nine leaves; six of them are
 * content with a publication, and three are operational work whose schedules
 * belong to Team work and Monitoring, not here: `structured-data` and `seo-fix`
 * are website tasks, and `review-campaign` is a presence campaign. Everything
 * else §6.4 excludes (audit runs, crawler checks, report releases, employee
 * leave, generic work deadlines, approvals without a publication plan,
 * monitoring jobs) has no `GrowthAsset` at all, so it cannot reach this module.
 */
const CONTENT_ASSET_TYPES = [
  'article',
  'ad-copy',
  'social-content',
  'email-campaign',
  'landing-page',
  'faq',
] as const;

const OPERATIONAL_EXCLUSION_NOTE =
  'Audit runs, crawler checks, report releases, employee leave, generic work deadlines and monitoring jobs keep their own schedules outside this calendar (§6.4).';

/** Bound on the unscheduled list's own scan, so a huge project cannot make it unbounded. */
const UNSCHEDULED_SCAN = 1000;

@Injectable()
export class ContentCalendarService {
  private readonly logger = new Logger(ContentCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publishing: PublishingService,
    private readonly scope: ScopeValidationService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────

  /** Project scope, staff audience. Access is asserted against the URL's project id. */
  async readProjectCalendar(
    user: AuthedRequestUser,
    projectId: string,
    query: CalendarReadQuery,
  ): Promise<CalendarReadResult> {
    await this.scope.assertProjectAccess(user, projectId);
    const project = await this.requireProject(projectId);
    const timezone = this.pickTimezone(query.timezone, project.timezone);
    return this.read(
      {
        info: { kind: 'project', projectId, projectIds: [projectId], label: project.name },
        projectIds: [projectId],
        timezone,
      },
      query,
      'staff',
      project.name,
    );
  }

  /**
   * Portfolio scope, staff audience — §3.4's portfolio view of the same
   * calendar. The project set is the caller's permitted projects, so a
   * non-admin operator reads their own book rather than everyone's.
   */
  async readPortfolioCalendar(
    user: AuthedRequestUser,
    query: CalendarReadQuery,
  ): Promise<CalendarReadResult> {
    const accessible = await this.scope.getAccessibleProjectIds(user);

    if (query.projectId) {
      if (accessible !== null && !accessible.includes(query.projectId)) {
        throw new NotFoundException(`Project ${query.projectId} not found`);
      }
      const project = await this.requireProject(query.projectId);
      const timezone = this.pickTimezone(query.timezone, project.timezone);
      return this.read(
        {
          info: {
            kind: 'portfolio',
            projectId: query.projectId,
            projectIds: [query.projectId],
            label: project.name,
          },
          projectIds: [query.projectId],
          timezone,
        },
        query,
        'staff',
        project.name,
      );
    }

    const projectIds =
      accessible ?? (await this.prisma.project.findMany({ select: { id: true } })).map((row) => row.id);
    // An unfiltered portfolio window is read in one zone — the caller's choice,
    // or UTC. Resolving each row in its own project's zone would make the same
    // window mean something different for two rows on the same screen.
    const timezone = this.pickTimezone(query.timezone, 'UTC');
    return this.read(
      {
        info: { kind: 'portfolio', projectId: null, projectIds, label: 'All permitted projects' },
        projectIds,
        timezone,
      },
      query,
      'staff',
      null,
    );
  }

  /**
   * Client scope.
   *
   * The client id comes from the session, never from the request — the URL's
   * project id is checked against it — and the read runs as the `client`
   * audience, so an unshared internal draft is absent from the response *and*
   * from every count in it.
   */
  async readPortalCalendar(
    clientId: string,
    projectId: string,
    query: CalendarReadQuery,
  ): Promise<CalendarReadResult> {
    const project = await this.requireProject(projectId);
    if (project.clientId !== clientId) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const timezone = this.pickTimezone(query.timezone, project.timezone);
    return this.read(
      {
        info: { kind: 'project', projectId, projectIds: [projectId], label: project.name },
        projectIds: [projectId],
        timezone,
      },
      // The owner filter is dropped rather than validated: it exists to help
      // staff find a colleague's work, and honouring it here would let a client
      // probe for staff identity by watching which ids return events.
      { ...query, ownerId: undefined },
      'client',
      project.name,
    );
  }

  // ── Writes ───────────────────────────────────────────────────────────

  /**
   * Create a placement — an intention, with no approval behind it.
   *
   * Idempotent on `idempotencyKey` (§6.7): a retried create returns the row it
   * already made rather than a second placement, which matters because the
   * natural caller is a form a user may double-submit.
   */
  async createPlacement(
    user: AuthedRequestUser,
    projectId: string,
    dto: CreatePlacementDto,
  ): Promise<CalendarEvent> {
    await this.scope.assertProjectAccess(user, projectId);

    if (dto.idempotencyKey) {
      const existing = await this.prisma.contentSchedule.findFirst({
        where: { projectId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) return this.renderOne(existing as PlacementRow, 'staff');
    }

    const asset = await this.requireContentAsset(projectId, dto.assetId);
    if (dto.briefId) await this.requireBrief(projectId, dto.briefId);
    if (dto.commitmentId) await this.requireCommitment(projectId, dto.commitmentId);
    if (dto.ownerId) await this.requireUser(dto.ownerId, 'owner');

    const timezone = await this.resolveWriteTimezone(projectId, dto.timezone);
    const planningOnly = findPlanningOnlyChannel(dto.channel);
    const destination = dto.destinationId
      ? await this.requireUsableDestination(projectId, dto.destinationId)
      : null;
    const deliveryMode = this.resolveDeliveryMode(
      dto.channel,
      destination,
      dto.deliveryMode,
      planningOnly,
    );

    const resolved = resolvePlacementLocalTime(dto.scheduledFor, timezone, dto.dstDisambiguation);

    const row = await this.prisma.contentSchedule.create({
      data: {
        projectId,
        assetId: asset.id,
        briefId: dto.briefId ?? null,
        commitmentId: dto.commitmentId ?? null,
        // A snapshot of what was planned, not something re-derived per read:
        // the piece's own type can change later, and this row records the
        // intention as it was made.
        contentType: dto.contentType ?? contentTypeForAssetType(asset.assetType),
        channel: dto.channel,
        deliveryMode,
        destinationId: destination?.id ?? null,
        plannedForUtc: resolved.utc,
        plannedLocalDate: resolved.localDate,
        plannedLocalTime: resolved.localTime,
        timezone,
        dstDisambiguation: resolved.dstDisambiguation,
        status: 'planned',
        ownerId: dto.ownerId ?? null,
        idempotencyKey: dto.idempotencyKey ?? null,
        createdBy: user.userId,
        updatedBy: user.userId,
      },
    });

    return this.renderOne(row as PlacementRow, 'staff');
  }

  /**
   * Move or edit a placement.
   *
   * Optimistic concurrency: the caller sends the version it read, and a stale
   * version is refused rather than quietly overwriting another writer's change.
   * The refusal carries the current version so the interface can show what
   * changed instead of asking the user to retype the form.
   *
   * Moving a placement does **not** move a queued publication. That is §6.7's
   * "updating a plan date must not silently reschedule content" read in the
   * other direction: the publication holds the slot the operator approved, and
   * dragging it would send content at a time nobody agreed to. The read reports
   * `intentionAndExecutionDiffer` so the divergence is visible and can be
   * resolved deliberately.
   */
  async updatePlacement(
    user: AuthedRequestUser,
    projectId: string,
    id: string,
    dto: UpdatePlacementDto,
  ): Promise<CalendarEvent> {
    await this.scope.assertProjectAccess(user, projectId);
    const row = await this.requirePlacement(projectId, id);

    if (row.status === 'cancelled') {
      throw new ConflictException({
        error: 'placement-cancelled',
        message:
          'This placement is cancelled. Cancellation preserves history, so it cannot be edited back into the calendar — create a new placement instead.',
      });
    }
    if (row.version !== dto.version) {
      throw new ConflictException({
        error: 'version-conflict',
        message: `This placement changed since you loaded it (you sent version ${dto.version}, it is now version ${row.version}). Reload it and apply your change again.`,
        currentVersion: row.version,
      });
    }
    if (dto.ownerId) await this.requireUser(dto.ownerId, 'owner');
    if (dto.commitmentId) await this.requireCommitment(projectId, dto.commitmentId);

    const channel = dto.channel ?? row.channel;
    const planningOnly = findPlanningOnlyChannel(channel);

    // `destinationId` is tri-state: absent leaves it alone, null clears it,
    // a value points it somewhere else. Collapsing absent into null would erase
    // a destination every time a caller changed only the time.
    let destinationId = row.destinationId;
    if (dto.destinationId === null) {
      destinationId = null;
    } else if (typeof dto.destinationId === 'string') {
      destinationId = (await this.requireUsableDestination(projectId, dto.destinationId)).id;
    }
    if (channel !== row.channel && destinationId) {
      // A destination belongs to one provider, so a channel change must not
      // leave a placement claiming to send somewhere it cannot.
      const current = await this.prisma.publishDestination.findUnique({ where: { id: destinationId } });
      if (current && current.provider !== channel) destinationId = null;
    }
    const destination = destinationId
      ? await this.prisma.publishDestination.findUnique({ where: { id: destinationId } })
      : null;
    const deliveryMode = this.resolveDeliveryMode(
      channel,
      destination as DestinationRow | null,
      dto.deliveryMode ?? row.deliveryMode,
      planningOnly,
    );

    // The zone a change is read in: an explicit new zone, else the placement's
    // own. A new bare time is *not* silently re-read in a different zone.
    const timezone =
      dto.timezone !== undefined
        ? await this.resolveWriteTimezone(projectId, dto.timezone)
        : row.timezone;
    const scheduledForInput =
      dto.scheduledFor ?? `${row.plannedLocalDate}T${row.plannedLocalTime}:00`;
    const resolved = resolvePlacementLocalTime(scheduledForInput, timezone, dto.dstDisambiguation);

    const updated = await this.applyVersionedUpdate(projectId, id, dto.version, {
      resolved,
      channel,
      deliveryMode,
      destinationId,
      contentType: dto.contentType,
      ownerId: dto.ownerId,
      commitmentId: dto.commitmentId,
      actorId: user.userId,
    });

    return this.renderOne(updated, 'staff');
  }

  /**
   * Cancel a placement — a state change, never a deletion (§6.7).
   *
   * Refuses while a *queued* publication is still attached: that publication
   * will fire on its own schedule, so telling the operator the placement is
   * cancelled while leaving the send in flight would be a lie with a deadline.
   * Cancelling the publication is publishing's operation (it owns the rules
   * about what may be cancelled), so this points there rather than reaching
   * into another module's rows.
   *
   * A placement whose publication has already gone out *can* be cancelled: the
   * live item is not retracted, and the history keeps both facts — the row with
   * its `cancelReason` and `cancelledAt`, and the publication that succeeded.
   */
  async cancelPlacement(
    user: AuthedRequestUser,
    projectId: string,
    id: string,
    reason: string,
    version: number,
  ): Promise<CalendarEvent> {
    await this.scope.assertProjectAccess(user, projectId);
    const row = await this.requirePlacement(projectId, id);

    if (row.status === 'cancelled') {
      throw new ConflictException({
        error: 'already-cancelled',
        message: 'This placement is already cancelled.',
      });
    }
    if (row.version !== version) {
      throw new ConflictException({
        error: 'version-conflict',
        message: `This placement changed since you loaded it (you sent version ${version}, it is now version ${row.version}). Reload it and try again.`,
        currentVersion: row.version,
      });
    }

    const queued = await this.prisma.publication.findMany({
      where: { scheduleId: id, status: { in: ['pending', 'publishing'] } },
      select: { id: true, status: true, scheduledFor: true },
    });
    if (queued.length > 0) {
      throw new ConflictException({
        error: 'publication-still-queued',
        message:
          'This placement has a publication that is still queued or mid-dispatch, so cancelling the placement alone would not stop it. Cancel that publication first (it has its own rules — nothing that already reached the destination can be un-published), then cancel this placement.',
        publications: queued.map((publication) => ({
          id: publication.id,
          status: publication.status,
          scheduledFor: publication.scheduledFor ? publication.scheduledFor.toISOString() : null,
        })),
      });
    }

    // The version sits in the `where`, so two concurrent cancels cannot both
    // write: the second matches no row and is told the state it lost to.
    const result = await this.prisma.contentSchedule.updateMany({
      where: { id, projectId, version },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: reason,
        version: { increment: 1 },
        updatedBy: user.userId,
      },
    });
    if (result.count === 0) {
      const current = await this.requirePlacement(projectId, id);
      throw new ConflictException({
        error: 'version-conflict',
        message: `This placement changed while you were cancelling it (it is now version ${current.version}). Reload it and try again.`,
        currentVersion: current.version,
      });
    }
    return this.renderOne(await this.requirePlacement(projectId, id), 'staff');
  }

  /**
   * Link this placement to an approved revision — through publishing's gates.
   *
   * The body of this method is a delegation on purpose. Publishing owns the
   * rule set that decides whether a push is legal (destination connected,
   * permissions actually granted, provider implemented, an approval at *this
   * exact* revision, and a still-valid approval re-checked at dispatch), and
   * §6.6 is explicit that the calendar must not become a way around it. Passing
   * the placement's own `plannedForUtc` in as `scheduledFor` is what makes the
   * execution land on the intended instant rather than "now".
   *
   * If nothing is approved, or the destination refuses, the operator sees
   * publishing's own error — the same one the content detail screen shows.
   */
  async linkPublication(
    user: AuthedRequestUser,
    projectId: string,
    id: string,
    dto: LinkPublicationDto,
  ): Promise<CalendarEvent> {
    await this.scope.assertProjectAccess(user, projectId);
    const row = await this.requirePlacement(projectId, id);

    if (row.status === 'cancelled') {
      throw new ConflictException({
        error: 'placement-cancelled',
        message: 'This placement is cancelled, so there is nothing to link a publication to.',
      });
    }
    if (row.deliveryMode !== 'automated' || !row.destinationId) {
      throw new BadRequestException({
        error: 'manual-delivery-only',
        message:
          'This placement is on a channel delivered by a person, so nothing is sent automatically. Publish it manually and record the result on the content piece.',
      });
    }

    // A planned instant that has passed cannot be sent "at" its time — the
    // moment is gone. Publishing refuses a past `scheduledFor`, so a link on an
    // overdue placement dispatches immediately instead, which is what "publish
    // this now, it is late" means. The calendar reports the outcome either way.
    const overdue = row.plannedForUtc.getTime() <= Date.now();
    const scheduledFor = dto.publishNow || overdue ? undefined : row.plannedForUtc.toISOString();

    await this.publishing.createPublication(
      projectId,
      {
        assetId: row.assetId,
        revisionId: dto.revisionId,
        destinationId: row.destinationId,
        mode: dto.mode ?? 'publish',
        scheduledFor,
        permissions: dto.permissions ?? [],
        contentHash: dto.contentHash,
        scheduleId: row.id,
      },
      { userId: user.userId, role: user.role, type: user.type },
    );

    return this.renderOne(await this.requirePlacement(projectId, id), 'staff');
  }

  // ── The read pipeline ────────────────────────────────────────────────

  private async read(
    scope: ResolvedScope,
    query: CalendarReadQuery,
    audience: CalendarAudience,
    singleProjectName: string | null,
  ): Promise<CalendarReadResult> {
    const window = this.resolveWindow(query, scope.timezone);
    const limit = clamp(query.limit, DEFAULT_EVENT_LIMIT, 1, MAX_EVENT_LIMIT);
    const unscheduledLimit = clamp(
      query.unscheduledLimit,
      DEFAULT_UNSCHEDULED_LIMIT,
      1,
      MAX_UNSCHEDULED_LIMIT,
    );

    const projectFilter = scope.projectIds === null ? {} : { projectId: { in: scope.projectIds } };

    // Cancelled placements are out of the live book by default, so the one
    // request that wants them has to widen the SQL to reach them. The `state`
    // filter below does the selecting — this only decides what is readable.
    const includeCancelled = query.state === 'cancelled';
    const where: Record<string, unknown> = {
      ...projectFilter,
      plannedForUtc: { gte: window.fromDate, lte: window.toDate },
      status: includeCancelled ? { in: ['planned', 'cancelled'] } : 'planned',
    };
    if (query.channel) where.channel = query.channel;
    if (query.type) where.contentType = query.type;
    if (query.ownerId && audience === 'staff') where.ownerId = query.ownerId;

    // The client audience only sees pieces with an explicitly shared revision
    // (§6.5: internal draft titles must not leak through calendar events *or
    // counts*). Applied to the query, not to the rendered rows, so
    // `totalInWindow` cannot count a draft either.
    let sharedAssetIds: string[] | null = null;
    if (audience === 'client') {
      sharedAssetIds = await this.sharedAssetIds(scope.projectIds);
      if (sharedAssetIds.length === 0) {
        return this.emptyResult(scope, window, query, limit, unscheduledLimit);
      }
      where.assetId = { in: sharedAssetIds };
    }

    let events: CalendarEvent[];
    let totalInWindow: number;
    let totalIsExact = true;
    let page: CalendarPage<CalendarEvent>;

    if (query.state) {
      // A derived state cannot be pushed into SQL, so it is evaluated over the
      // window. Past the scan cap the read still answers but stops claiming its
      // count is exact — a partial count presented as complete is exactly the
      // failure §6.7's completeness rule exists to prevent.
      //
      // `cancelled` takes this path too, even though it is the one state that
      // *is* a stored column: `includeCancelled` widens the SQL to read the
      // cancelled rows at all, and the filter below is what makes the answer to
      // "show me the cancelled ones" the cancelled ones rather than the whole
      // month with them in it.
      const scanned = (await this.prisma.contentSchedule.findMany({
        where: where as never,
        orderBy: [{ plannedForUtc: 'asc' }, { id: 'asc' }],
        take: MAX_WINDOW_SCAN,
      })) as unknown as PlacementRow[];

      const matched = (await this.buildEvents(scanned, audience, singleProjectName)).filter(
        (event) => event.state === query.state,
      );
      totalInWindow = matched.length;
      totalIsExact = scanned.length < MAX_WINDOW_SCAN;

      const offset = decodeOffsetCursor(query.cursor);
      const slice = matched.slice(offset, offset + limit);
      const hasMore = totalIsExact && offset + slice.length < matched.length;
      events = slice;
      page = {
        items: slice,
        limit,
        returned: slice.length,
        hasMore,
        nextCursor: hasMore ? encodeCursor({ kind: 'offset', offset: offset + slice.length }) : null,
        truncated: hasMore || !totalIsExact,
      };
    } else {
      const cursor = decodeKeyCursor(query.cursor);
      const rows = (await this.prisma.contentSchedule.findMany({
        where: (cursor
          ? {
              AND: [
                where,
                {
                  OR: [
                    { plannedForUtc: { gt: cursor.plannedForUtc } },
                    { plannedForUtc: cursor.plannedForUtc, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : where) as never,
        orderBy: [{ plannedForUtc: 'asc' }, { id: 'asc' }],
        // One extra row decides `hasMore` without a second count query.
        take: limit + 1,
      })) as unknown as PlacementRow[];

      const hasMore = rows.length > limit;
      const placements = hasMore ? rows.slice(0, limit) : rows;
      events = await this.buildEvents(placements, audience, singleProjectName);
      totalInWindow = await this.prisma.contentSchedule.count({ where: where as never });
      const last = placements[placements.length - 1];
      page = {
        items: events,
        limit,
        returned: events.length,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                kind: 'key',
                plannedForUtc: last.plannedForUtc.toISOString(),
                id: last.id,
              })
            : null,
        truncated: hasMore,
      };
    }

    const unscheduled = await this.listUnscheduled(
      scope,
      audience,
      query,
      unscheduledLimit,
      sharedAssetIds,
    );

    return {
      scope: scope.info,
      window: {
        from: window.fromDate.toISOString(),
        to: window.toDate.toISOString(),
        timezone: scope.timezone,
        days: daysBetween(window.fromDate, window.toDate),
        bounded: true,
      },
      filters: {
        type: query.type ?? null,
        channel: query.channel ?? null,
        state: query.state ?? null,
        ownerId: audience === 'staff' ? (query.ownerId ?? null) : null,
      },
      layout: events,
      events,
      page,
      totalInWindow,
      totalIsExact,
      unscheduled,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * §6.5's separate unscheduled list.
   *
   * A piece with no placement is still work in progress, so it is listed — but
   * it has no date, and giving it one would put a fabricated event in a month
   * view where a reader would trust it. That is the whole reason §6.5 requires
   * this list to be separate and forbids midnight or an arbitrary date.
   */
  private async listUnscheduled(
    scope: ResolvedScope,
    audience: CalendarAudience,
    query: CalendarReadQuery,
    limit: number,
    sharedAssetIds: string[] | null,
  ): Promise<CalendarPage<UnscheduledContentItem> & { total: number; totalIsExact: boolean }> {
    const projectFilter = scope.projectIds === null ? {} : { projectId: { in: scope.projectIds } };

    const placed = await this.prisma.contentSchedule.findMany({
      where: {
        ...projectFilter,
        status: 'planned',
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.type ? { contentType: query.type } : {}),
        ...(audience === 'staff' && query.ownerId ? { ownerId: query.ownerId } : {}),
      },
      select: { assetId: true },
      take: MAX_WINDOW_SCAN,
    });
    const placedAssetIds = new Set(placed.map((row) => row.assetId));

    const assetWhere: Record<string, unknown> = {
      ...projectFilter,
      // Operational asset types are excluded here too: §6.4 takes them out of
      // this calendar entirely, so they must not reappear as "unscheduled
      // content" in its other half.
      assetType: { in: CONTENT_ASSET_TYPES },
    };
    if (audience === 'client') assetWhere.id = { in: sharedAssetIds ?? [] };

    const scanned = await this.prisma.growthAsset.findMany({
      where: assetWhere as never,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: { id: true, title: true, assetType: true, projectId: true, assigneeId: true, updatedAt: true },
      take: UNSCHEDULED_SCAN + 1,
    });
    const capped = scanned.length > UNSCHEDULED_SCAN;
    const assets = capped ? scanned.slice(0, UNSCHEDULED_SCAN) : scanned;

    const unscheduled = assets.filter((asset) => !placedAssetIds.has(asset.id));
    const offset = decodeOffsetCursor(query.unscheduledCursor);
    const slice = unscheduled.slice(offset, offset + limit);
    const hasMore = offset + slice.length < unscheduled.length;

    const items: UnscheduledContentItem[] = slice.map((asset) => {
      const contentType = contentTypeForAssetType(asset.assetType) as CalendarContentType;
      const item: UnscheduledContentItem = {
        assetId: asset.id,
        projectId: asset.projectId,
        title: asset.title,
        contentType,
        contentTypeLabel: CONTENT_TYPE_LABELS[contentType],
        state: 'unscheduled',
        reason: 'no-placement',
        reasonLabel: 'No date is planned for this piece yet.',
        updatedAt: asset.updatedAt.toISOString(),
      };
      if (audience === 'staff') item.ownerId = asset.assigneeId;
      return item;
    });

    return {
      items,
      limit,
      returned: items.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor({ kind: 'offset', offset: offset + slice.length }) : null,
      truncated: hasMore || capped,
      total: unscheduled.length,
      totalIsExact: !capped,
    };
  }

  // ── Deriving one event from intention + execution ────────────────────

  /**
   * Merge a page of placements with everything that qualifies their state.
   *
   * Batched on purpose: a fixed number of `in (...)` queries for the whole
   * page rather than per-row work, so a 200-entry month does not issue 1,200
   * round trips. Publications are grouped by `scheduleId`, which is what keeps
   * the merge one-to-one — an ungrouped join would return one event per attempt.
   */
  private async buildEvents(
    placements: PlacementRow[],
    audience: CalendarAudience,
    singleProjectName: string | null,
  ): Promise<CalendarEvent[]> {
    if (placements.length === 0) return [];

    const assetIds = Array.from(new Set(placements.map((row) => row.assetId)));
    const scheduleIds = placements.map((row) => row.id);
    const projectIds = Array.from(new Set(placements.map((row) => row.projectId)));

    const [assets, revisions, approvals, publications] = await Promise.all([
      this.prisma.growthAsset.findMany({
        where: { id: { in: assetIds } },
        select: {
          id: true,
          title: true,
          assetType: true,
          projectId: true,
          assigneeId: true,
          updatedAt: true,
        },
      }),
      this.prisma.contentRevision.findMany({
        where: { assetId: { in: assetIds } },
        select: { id: true, assetId: true, revision: true, clientVisible: true },
        orderBy: { revision: 'desc' },
      }),
      this.prisma.approvalRequest.findMany({
        where: { artifactType: CONTENT_ARTIFACT_TYPE, artifactId: { in: assetIds } },
        select: { id: true, artifactId: true, artifactRevision: true, revisionId: true, status: true },
      }),
      this.prisma.publication.findMany({
        where: { scheduleId: { in: scheduleIds } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const assetById = new Map<string, AssetRow>(assets.map((asset) => [asset.id, asset as AssetRow]));

    const latestRevision = new Map<string, { id: string; revision: number }>();
    const sharedRevision = new Map<string, number>();
    for (const revision of revisions) {
      if (!latestRevision.has(revision.assetId)) {
        latestRevision.set(revision.assetId, { id: revision.id, revision: revision.revision });
      }
      // Ordered by revision desc, so the first visible row is the newest one.
      if (revision.clientVisible && !sharedRevision.has(revision.assetId)) {
        sharedRevision.set(revision.assetId, revision.revision);
      }
    }

    // "Approved at the current revision" — matched on the revision number, or
    // on the revision id when the request recorded one. Never "the newest
    // approved request for this asset": that is how approval of revision 2
    // leaks onto publishing revision 3. This mirrors publishing's own gate so
    // that the calendar's "Ready to publish" means what dispatch means.
    const approvedRevision = new Map<string, number>();
    for (const approval of approvals) {
      if (approval.status !== 'approved') continue;
      const latest = latestRevision.get(approval.artifactId);
      if (!latest) continue;
      if (approval.artifactRevision === latest.revision || approval.revisionId === latest.id) {
        approvedRevision.set(approval.artifactId, latest.revision);
      }
    }

    const destinationIds = Array.from(
      new Set(
        placements.map((row) => row.destinationId).filter((value): value is string => Boolean(value)),
      ),
    );
    const destinations: DestinationRow[] = destinationIds.length
      ? ((await this.prisma.publishDestination.findMany({
          where: { id: { in: destinationIds } },
          select: { id: true, label: true, provider: true, status: true, revokedAt: true },
        })) as DestinationRow[])
      : [];

    const approvalIds = Array.from(
      new Set(publications.map((row) => row.approvalId).filter((value): value is string => Boolean(value))),
    );
    const approvalRows = approvalIds.length
      ? await this.prisma.approvalRequest.findMany({
          where: { id: { in: approvalIds } },
          select: { id: true, status: true },
        })
      : [];

    const pausedProjectIds = await this.pausedProjects(projectIds);
    const projectNames = await this.projectNames(projectIds, singleProjectName);

    const publicationsBySchedule = new Map<string, PublicationRow[]>();
    for (const publication of publications) {
      if (!publication.scheduleId) continue;
      const list = publicationsBySchedule.get(publication.scheduleId) ?? [];
      list.push(publication as unknown as PublicationRow);
      publicationsBySchedule.set(publication.scheduleId, list);
    }

    const table: DerivationContext = {
      assets: assetById,
      latestRevision,
      approvedRevision,
      sharedRevision,
      destinations: new Map(destinations.map((row) => [row.id, row])),
      approvalsById: new Map(approvalRows.map((row) => [row.id, row.status])),
      pausedProjectIds,
      publicationsBySchedule,
      owners: await this.ownerNames(placements.map((row) => row.ownerId)),
      now: new Date(),
    };

    const events: CalendarEvent[] = [];
    for (const placement of placements) {
      const event = this.deriveEvent(placement, table, audience, projectNames);
      if (event) events.push(event);
    }
    // Stable order even if a caller handed us an unordered page.
    events.sort((a, b) => {
      const diff = Date.parse(a.scheduledForUtc) - Date.parse(b.scheduledForUtc);
      return diff !== 0 ? diff : a.scheduleId.localeCompare(b.scheduleId);
    });
    return events;
  }

  /**
   * One event.
   *
   * Returns null when a client read must not see this placement at all — no
   * shared revision exists for the piece, so it is absent rather than redacted.
   */
  private deriveEvent(
    placement: PlacementRow,
    table: DerivationContext,
    audience: CalendarAudience,
    projectNames: Map<string, string>,
  ): CalendarEvent | null {
    const asset = table.assets.get(placement.assetId);
    if (!asset) {
      this.logger.warn(`Placement ${placement.id} points at missing asset ${placement.assetId}`);
      return null;
    }
    if (audience === 'client' && !table.sharedRevision.has(asset.id)) return null;

    const contentType = placement.contentType as CalendarContentType;
    const latest = table.latestRevision.get(asset.id) ?? null;
    const approvedRevision = table.approvedRevision.get(asset.id) ?? null;

    const attempts = table.publicationsBySchedule.get(placement.id) ?? [];
    // `buildEvents` ordered these by createdAt desc, so the first non-cancelled
    // attempt is the one that decides the event's execution state.
    const live = attempts.find((attempt) => attempt.status !== 'cancelled') ?? null;
    const destination = placement.destinationId
      ? (table.destinations.get(placement.destinationId) ?? null)
      : null;
    const planningOnly = findPlanningOnlyChannel(placement.channel);

    const derived = this.deriveState({
      placement,
      live,
      destination,
      planningOnly,
      approvedRevision,
      latestRevision: latest?.revision ?? null,
      latestRevisionId: latest?.id ?? null,
      approvalStatus: live?.approvalId ? (table.approvalsById.get(live.approvalId) ?? null) : null,
      projectPaused: table.pausedProjectIds.has(placement.projectId),
      now: table.now,
    });

    // Delivery and verification are separate facts (§6.6), so "the push
    // succeeded but the live check has not confirmed it" is expressible and is
    // collapsed into neither "published" nor an error.
    const verificationState: VerificationState = !live
      ? 'not-applicable'
      : live.status !== 'published' || live.mode !== 'publish'
        ? 'not-applicable'
        : live.verifiedAt && live.verifiedUrl
          ? 'verified'
          : live.verifyError
            ? 'failed'
            : 'pending';

    const pastDue =
      placement.status !== 'cancelled' &&
      placement.plannedForUtc.getTime() < table.now.getTime() &&
      derived.state !== 'published';

    const event: CalendarEvent = {
      scheduleId: placement.id,
      projectId: placement.projectId,
      projectName: projectNames.get(placement.projectId) ?? 'Project',
      assetId: asset.id,
      // The piece's own title — never a run id, source type or slug (§6.5). A
      // client read shows the same title the client content list already shows,
      // because a piece only appears here at all once it is shared.
      title: asset.title,
      contentType,
      contentTypeLabel: CONTENT_TYPE_LABELS[contentType] ?? 'Other content',
      channel: placement.channel,
      channelLabel: channelLabel(placement.channel),
      deliveryMode: placement.deliveryMode as DeliveryMode,
      state: derived.state,
      stateLabel: SCHEDULE_STATE_LABELS[derived.state],
      holdReason: derived.holdReason,
      holdReasonLabel: derived.holdReason ? HOLD_REASON_LABELS[derived.holdReason] : null,
      // Nothing here is inferred from the clock: `pastDue` says the planned
      // instant has passed and the placement is not published, and
      // `pastDueReason` says which source fact explains that.
      pastDue,
      pastDueLabel: pastDue ? PAST_DUE_LABEL : null,
      pastDueReason: pastDue ? derived.pastDueReason : null,
      pastDueReasonLabel:
        pastDue && derived.pastDueReason ? PAST_DUE_REASON_LABELS[derived.pastDueReason] : null,
      scheduledForUtc: placement.plannedForUtc.toISOString(),
      plannedLocalDate: placement.plannedLocalDate,
      plannedLocalTime: placement.plannedLocalTime,
      timezone: placement.timezone,
      dstDisambiguation: (placement.dstDisambiguation as 'earlier' | 'later' | null) ?? null,
      // `remoteUrl` is deliberately NOT built here — it is the raw URL the
      // publishing provider returned, and the client-facing field is the
      // sanitized `liveUrl` below. It is attached in the staff-only block, so
      // a client cannot receive it by this object being spread somewhere.
      execution: live
        ? {
            publicationId: live.id,
            status: live.status,
            mode: live.mode,
            scheduledFor: live.scheduledFor ? live.scheduledFor.toISOString() : null,
            attempt: live.attempt,
          }
        : null,
      attemptCount: attempts.length,
      // Divergence, not drift: one of them moved and the other did not.
      intentionAndExecutionDiffer: Boolean(
        live?.scheduledFor &&
          Math.abs(live.scheduledFor.getTime() - placement.plannedForUtc.getTime()) > 60_000,
      ),
      verification: {
        state: verificationState,
        verifiedAt: live?.verifiedAt ? live.verifiedAt.toISOString() : null,
        verifiedUrl: live?.verifiedUrl ?? null,
      },
      liveUrl:
        derived.state === 'published' ? safeLiveUrl(live?.verifiedUrl ?? live?.remoteUrl ?? null) : null,
      approvedRevision,
      latestRevision: latest?.revision ?? null,
      commitmentId: placement.commitmentId,
      briefId: placement.briefId,
      cancelledAt: placement.cancelledAt ? placement.cancelledAt.toISOString() : null,
      version: placement.version,
      createdAt: placement.createdAt.toISOString(),
      updatedAt: placement.updatedAt.toISOString(),
    };

    // Staff-only fields: a destination label can name an internal account,
    // owner ids are staff identity, and raw provider errors are operator text
    // (§3.4 keeps them out of client copy rather than exposing them and asking
    // the interface not to render them).
    if (audience === 'staff') {
      event.destinationLabel = destination?.label ?? null;
      event.ownerId = placement.ownerId;
      event.ownerLabel = placement.ownerId ? (table.owners.get(placement.ownerId) ?? null) : null;
      event.cancelReason = placement.cancelReason;
      if (event.execution) {
        event.execution.error = live?.error ?? null;
        // The raw provider URL is staff diagnostic detail (§4.6). Clients get
        // `liveUrl`, which is the same value only once it has been checked as
        // a safe public link.
        event.execution.remoteUrl = live?.remoteUrl ?? null;
      }
      if (event.verification.state === 'failed') event.verification.error = live?.verifyError ?? null;
    }

    return event;
  }

  /**
   * §6.6's nine states, derived from source facts only.
   *
   * The order is load-bearing:
   *
   * 1. A cancelled placement is cancelled, whatever its history says.
   * 2. A live publication wins over the placement's own progress: if something
   *    was sent, the calendar reports what happened, not what was intended.
   * 3. A *blocked* execution is `held` rather than its nominal state, because
   *    the dispatcher would refuse this row right now — and a calendar that
   *    says "Scheduled" for a row the dispatcher will skip is the specific
   *    dishonesty §6.7's dispatch-time recheck exists to prevent. The reasons
   *    are the dispatcher's own, read from the same columns.
   * 4. With no execution, the placement's own progress decides: nothing written
   *    yet (`planned`), written but not approved (`awaiting-approval`), or
   *    approved (`ready`).
   */
  private deriveState(input: {
    placement: PlacementRow;
    live: PublicationRow | null;
    destination: DestinationRow | null;
    planningOnly: PlanningOnlyChannel | null;
    approvedRevision: number | null;
    latestRevision: number | null;
    /** The id of the asset's current revision, so a live execution can be
     *  compared against it (a publication points at a revision id, not a
     *  number). */
    latestRevisionId: string | null;
    approvalStatus: string | null;
    projectPaused: boolean;
    now: Date;
  }): { state: ScheduleState; holdReason: HoldReason | null; pastDueReason: PastDueReason | null } {
    const { placement, live, destination, planningOnly } = input;

    if (placement.status === 'cancelled') {
      return { state: 'cancelled', holdReason: null, pastDueReason: null };
    }

    // §6.6: an unsupported channel may only be planned or delivered manually,
    // and the label has to say so. A placement on one is never "scheduled".
    const manualDelivery = placement.deliveryMode !== 'automated' || Boolean(planningOnly);

    if (live) {
      if (live.status === 'published' && live.mode === 'publish') {
        return { state: 'published', holdReason: null, pastDueReason: null };
      }
      if (live.status === 'publishing') {
        // A dispatch running longer than the stale window may or may not have
        // reached the destination, and publishing never resets it on its own.
        // The calendar says so rather than showing a spinner forever.
        const stale = input.now.getTime() - live.updatedAt.getTime() > STALE_PUBLISHING_MS;
        if (stale) {
          return {
            state: 'held',
            holdReason: 'dispatch-interrupted',
            pastDueReason: 'dispatch-pending',
          };
        }
        return { state: 'publishing', holdReason: null, pastDueReason: null };
      }
      if (live.status === 'failed') {
        return { state: 'failed', holdReason: null, pastDueReason: 'failure' };
      }
      if (live.status === 'pending') {
        // Publishing's dispatch gate, mirrored. A permanent block is checked
        // first, so a placement waiting on a destination that will never work
        // does not read as merely "waiting for its slot".
        const block = this.executionBlock(live, destination, input);
        if (block) {
          return { state: 'held', holdReason: block, pastDueReason: pastDueReasonFor(block) };
        }
        return { state: 'scheduled', holdReason: null, pastDueReason: 'dispatch-pending' };
      }
      if (live.status === 'published' && live.mode !== 'publish') {
        // A successful *draft* push is not a publication to an audience: the
        // destination holds a draft a person still has to publish. Reading it
        // as "Published" would tell someone their readers saw it when nothing
        // went out.
        return {
          state: 'ready',
          holdReason: 'manual-delivery',
          pastDueReason: 'manual-publishing',
        };
      }
      // A cancelled publication leaves no live execution, so the reading falls
      // through to the placement's own progress below.
    }

    if (manualDelivery) {
      if (input.approvedRevision !== null) {
        return { state: 'ready', holdReason: 'manual-delivery', pastDueReason: 'manual-publishing' };
      }
      return {
        state: input.latestRevision === null ? 'planned' : 'awaiting-approval',
        holdReason: null,
        pastDueReason: input.latestRevision === null ? 'not-linked' : 'approval-hold',
      };
    }

    if (!destination) {
      return { state: 'held', holdReason: 'no-destination', pastDueReason: 'disconnected-account' };
    }
    if (input.approvedRevision === null) {
      return {
        state: input.latestRevision === null ? 'planned' : 'awaiting-approval',
        holdReason: null,
        pastDueReason: input.latestRevision === null ? 'not-linked' : 'approval-hold',
      };
    }
    return { state: 'ready', holdReason: null, pastDueReason: 'not-linked' };
  }

  /**
   * The dispatcher's own reasons a queued row will not go out right now.
   *
   * Same columns and same order of severity as `PublishingService`'s
   * `dispatchBlockedReason`, so the calendar cannot promise a push the
   * dispatcher will refuse.
   */
  private executionBlock(
    live: PublicationRow,
    destination: DestinationRow | null,
    input: { approvalStatus: string | null; projectPaused: boolean; latestRevisionId: string | null },
  ): HoldReason | null {
    if (!destination) return 'no-destination';
    if (destination.revokedAt) return 'destination-revoked';
    if (destination.status === 'error') return 'destination-error';
    if (destination.status !== 'connected') return 'destination-not-connected';
    const declaration = findProvider(destination.provider);
    if (!declaration || !declaration.implemented) return 'provider-not-implemented';
    if (!live.approvalId) return 'approval-invalidated';
    if (input.approvalStatus !== 'approved') return 'approval-invalidated';
    // §21.2 journey 12 — this mirrors `PublishingService.dispatchBlockedReason`.
    // The approval on file is still `approved`, but it named an older revision:
    // the content was edited after consent was given, so this would ship the
    // pre-edit body. Reported as its own reason rather than as a withdrawn
    // approval, because the approval was never withdrawn.
    if (input.latestRevisionId !== null && live.revisionId !== input.latestRevisionId) {
      return 'content-changed-since-approval';
    }
    if (input.projectPaused) return 'client-paused';
    if (live.remoteId) return 'dispatch-interrupted';
    return null;
  }

  // ── Read helpers ─────────────────────────────────────────────────────

  /** Renders a single placement (after a write) through the same derivation. */
  private async renderOne(
    placement: PlacementRow,
    audience: CalendarAudience,
  ): Promise<CalendarEvent> {
    const project = await this.requireProject(placement.projectId);
    const events = await this.buildEvents([placement], audience, project.name);
    const event = events[0];
    if (!event) {
      throw new NotFoundException(`Placement ${placement.id} could not be rendered`);
    }
    return event;
  }

  /**
   * The pieces a client may see at all: one with an explicitly shared revision.
   *
   * `ContentRevision.clientVisible` is the only source of that decision (§13.5),
   * and it is deliberately not derived from approval status — an approved piece
   * an operator has not shared is still internal.
   */
  private async sharedAssetIds(projectIds: string[] | null): Promise<string[]> {
    const visible = await this.prisma.contentRevision.findMany({
      where: { clientVisible: true },
      select: { assetId: true },
      distinct: ['assetId'],
    });
    const ids = visible.map((row) => row.assetId);
    if (projectIds === null) return ids;
    if (ids.length === 0) return [];
    const scoped = await this.prisma.growthAsset.findMany({
      where: { id: { in: ids }, projectId: { in: projectIds } },
      select: { id: true },
    });
    return scoped.map((asset) => asset.id);
  }

  /** Projects whose client account is paused — a real dispatch gate. */
  private async pausedProjects(projectIds: string[]): Promise<Set<string>> {
    if (projectIds.length === 0) return new Set();
    const projects = await this.prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, clientId: true },
    });
    const clientIds = Array.from(
      new Set(
        projects.map((project) => project.clientId).filter((value): value is string => Boolean(value)),
      ),
    );
    const paused = new Set<string>();
    if (clientIds.length === 0) return paused;
    const clients = await this.prisma.client.findMany({
      where: { id: { in: clientIds }, status: 'paused' },
      select: { id: true },
    });
    const pausedClients = new Set(clients.map((client) => client.id));
    for (const project of projects) {
      if (project.clientId && pausedClients.has(project.clientId)) paused.add(project.id);
    }
    return paused;
  }

  /**
   * Display names for the owners on this page.
   *
   * Deliberately a lookup over just the ids on this page rather than a roster
   * read: the calendar needs to *label* the owners it already returned, not to
   * enumerate every operator, and `GET /users` is admin-only anyway. A missing
   * user yields no entry, and the label is then absent rather than invented.
   */
  private async ownerNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter((value): value is string => Boolean(value))));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async projectNames(
    projectIds: string[],
    single: string | null,
  ): Promise<Map<string, string>> {
    if (single && projectIds.length === 1) return new Map([[projectIds[0], single]]);
    if (projectIds.length === 0) return new Map();
    const rows = await this.prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * §6.7's bounded window.
   *
   * Every read has one: an unbounded read is refused rather than defaulted to
   * "all time", because "all time" is exactly how a month view ends up loading
   * a truncated slice and calling it the month.
   */
  private resolveWindow(query: CalendarReadQuery, timezone: string): { fromDate: Date; toDate: Date } {
    const zone = isValidTimeZone(timezone) ? timezone : 'UTC';

    let fromDate: Date;
    if (query.from) {
      // A bare date is local midnight; a full timestamp is already an instant
      // and is used exactly as sent.
      fromDate =
        query.from.length === 10
          ? startOfLocalDay(zone, resolveWindowBound(`${query.from}T00:00:00`, zone, 'start'))
          : resolveWindowBound(query.from, zone, 'start');
    } else {
      fromDate = startOfLocalMonth(zone, new Date());
    }

    let toDate: Date;
    if (query.to) {
      toDate =
        query.to.length === 10
          ? endOfLocalDay(zone, resolveWindowBound(`${query.to}T00:00:00`, zone, 'start'))
          : resolveWindowBound(query.to, zone, 'end');
    } else {
      // Closed implicitly at the last instant of the same local month, so
      // "from=2026-09-01" reads one month rather than one day, and "nothing
      // given" reads the current month.
      toDate = endOfLocalMonth(zone, fromDate);
    }

    if (toDate.getTime() < fromDate.getTime()) {
      throw new BadRequestException({
        error: 'invalid-window',
        message: `"to" (${toDate.toISOString()}) is before "from" (${fromDate.toISOString()}).`,
      });
    }
    const days = daysBetween(fromDate, toDate);
    if (days > MAX_WINDOW_DAYS) {
      throw new BadRequestException({
        error: 'window-too-large',
        message: `This window spans ${days} days; the maximum is ${MAX_WINDOW_DAYS}. Narrow it and page with the cursor.`,
        maxDays: MAX_WINDOW_DAYS,
      });
    }
    return { fromDate, toDate };
  }

  private emptyResult(
    scope: ResolvedScope,
    window: { fromDate: Date; toDate: Date },
    query: CalendarReadQuery,
    limit: number,
    unscheduledLimit: number,
  ): CalendarReadResult {
    const emptyPage = <T,>(pageLimit: number): CalendarPage<T> => ({
      items: [],
      limit: pageLimit,
      returned: 0,
      hasMore: false,
      nextCursor: null,
      truncated: false,
    });
    return {
      scope: scope.info,
      window: {
        from: window.fromDate.toISOString(),
        to: window.toDate.toISOString(),
        timezone: scope.timezone,
        days: daysBetween(window.fromDate, window.toDate),
        bounded: true,
      },
      filters: {
        type: query.type ?? null,
        channel: query.channel ?? null,
        state: query.state ?? null,
        ownerId: query.ownerId ?? null,
      },
      layout: [],
      events: [],
      page: emptyPage<CalendarEvent>(limit),
      totalInWindow: 0,
      totalIsExact: true,
      unscheduled: {
        ...emptyPage<UnscheduledContentItem>(unscheduledLimit),
        total: 0,
        totalIsExact: true,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private pickTimezone(requested: string | undefined, fallback: string): string {
    const zone = requested ?? fallback ?? 'UTC';
    if (!isValidTimeZone(zone)) {
      throw new BadRequestException({
        error: 'invalid-timezone',
        message: `"${zone}" is not a recognized IANA timezone.`,
      });
    }
    return zone;
  }

  /**
   * The zone a placement's local time is read in: the engagement's, else the
   * project's — the same precedence publishing uses, so a time planned here and
   * a time dispatched there agree.
   */
  private async resolveWriteTimezone(projectId: string, requested?: string): Promise<string> {
    if (requested) {
      if (!isValidTimeZone(requested)) {
        throw new BadRequestException({
          error: 'invalid-timezone',
          message: `"${requested}" is not a recognized IANA timezone.`,
        });
      }
      return requested;
    }
    const project = await this.requireProject(projectId);
    return project.timezone || 'UTC';
  }

  // ── Write helpers ────────────────────────────────────────────────────

  /**
   * Apply an update only if the version still matches.
   *
   * The version sits in the `where` clause of `updateMany`: if another writer
   * bumped it between the caller's read and this write, zero rows match and the
   * caller is told the current version rather than silently winning.
   */
  private async applyVersionedUpdate(
    projectId: string,
    id: string,
    version: number,
    change: {
      resolved: {
        utc: Date;
        localDate: string;
        localTime: string;
        timezone: string;
        dstDisambiguation: string | null;
      };
      channel: string;
      deliveryMode: string;
      destinationId: string | null;
      contentType?: string;
      ownerId?: string | null;
      commitmentId?: string | null;
      actorId: string;
    },
  ): Promise<PlacementRow> {
    const data: Record<string, unknown> = {
      plannedForUtc: change.resolved.utc,
      plannedLocalDate: change.resolved.localDate,
      plannedLocalTime: change.resolved.localTime,
      timezone: change.resolved.timezone,
      dstDisambiguation: change.resolved.dstDisambiguation,
      channel: change.channel,
      deliveryMode: change.deliveryMode,
      destinationId: change.destinationId,
      version: { increment: 1 },
      updatedBy: change.actorId,
    };
    if (change.contentType !== undefined) data.contentType = change.contentType;
    if (change.ownerId !== undefined) data.ownerId = change.ownerId;
    if (change.commitmentId !== undefined) data.commitmentId = change.commitmentId;

    const result = await this.prisma.contentSchedule.updateMany({
      where: { id, projectId, version },
      data: data as never,
    });
    if (result.count === 0) {
      const current = await this.requirePlacement(projectId, id);
      throw new ConflictException({
        error: 'version-conflict',
        message: `This placement changed while you were editing it (it is now version ${current.version}). Reload it and apply your change again.`,
        currentVersion: current.version,
      });
    }
    return this.requirePlacement(projectId, id);
  }

  /**
   * The delivery mode a placement may claim.
   *
   * §6.6 requires that an unsupported channel may only be planned or delivered
   * manually, and that an automated claim be true. So `automated` needs a
   * declared, implemented provider *and* a connected destination — and asking
   * for `automated` without them is refused with the reason, never quietly
   * downgraded, because a silent downgrade is how a channel with no adapter
   * starts looking like one with.
   */
  private resolveDeliveryMode(
    channel: string,
    destination: DestinationRow | null,
    requested: string | undefined,
    planningOnly: PlanningOnlyChannel | null,
  ): string {
    const declaration = findProvider(channel);
    const automatable = Boolean(declaration?.implemented) && !planningOnly;
    const wantsAutomated =
      requested === 'automated' || (requested === undefined && automatable && Boolean(destination));

    if (!wantsAutomated) return 'manual';

    if (planningOnly) {
      throw new BadRequestException({
        error: 'channel-not-automatable',
        message: `${planningOnly.label} has no automated delivery in this build. ${planningOnly.reason} Plan it as a manual placement instead.`,
      });
    }
    if (!declaration) {
      throw new BadRequestException({
        error: 'channel-not-automatable',
        message: `Channel "${channel}" is not a declared provider, so nothing can be automated for it.`,
      });
    }
    if (!declaration.implemented) {
      throw new BadRequestException({
        error: 'provider-not-implemented',
        message: declaration.unavailableReason ?? `${declaration.label} has no adapter in this build.`,
      });
    }
    if (!destination) {
      throw new BadRequestException({
        error: 'destination-required',
        message:
          'An automated placement needs a destination. Connect one, or plan this as a manual placement.',
      });
    }
    if (destination.revokedAt || destination.status !== 'connected') {
      throw new ConflictException({
        error: 'destination-not-connected',
        message: `That destination is ${destination.revokedAt ? 'revoked' : `"${destination.status}"`}, so nothing could be sent. Connect it first, or plan this as a manual placement.`,
      });
    }
    return 'automated';
  }

  private async requireProject(projectId: string): Promise<{
    id: string;
    name: string;
    clientId: string | null;
    timezone: string;
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, clientId: true, engagementId: true, timezone: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    if (project.engagementId) {
      const engagement = await this.prisma.engagement.findUnique({
        where: { id: project.engagementId },
        select: { timezone: true },
      });
      if (engagement?.timezone) {
        return {
          id: project.id,
          name: project.name,
          clientId: project.clientId,
          timezone: engagement.timezone,
        };
      }
    }
    return {
      id: project.id,
      name: project.name,
      clientId: project.clientId,
      timezone: project.timezone,
    };
  }

  private async requireContentAsset(projectId: string, assetId: string): Promise<AssetRow> {
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) {
      throw new NotFoundException(`Content piece ${assetId} not found for project ${projectId}`);
    }
    // §6.4 takes the operational asset types out of this calendar entirely: an
    // `seo-fix`, a `structured-data` item or a `review-campaign` is a technical
    // task with no publication, and its scheduling belongs with Team work.
    if (!(CONTENT_ASSET_TYPES as readonly string[]).includes(asset.assetType)) {
      throw new BadRequestException({
        error: 'not-content',
        message: `"${asset.assetType}" is not content this calendar carries. ${OPERATIONAL_EXCLUSION_NOTE}`,
      });
    }
    return asset as AssetRow;
  }

  private async requireBrief(projectId: string, briefId: string): Promise<void> {
    const brief = await this.prisma.contentBrief.findUnique({
      where: { id: briefId },
      select: { projectId: true },
    });
    if (!brief || brief.projectId !== projectId) {
      throw new NotFoundException(`Brief ${briefId} not found for project ${projectId}`);
    }
  }

  /**
   * A commitment reference is checked for existence and ownership and then only
   * stored (§6.7: a content schedule never changes a commitment's target, and
   * moving a commitment never moves a schedule).
   */
  private async requireCommitment(projectId: string, commitmentId: string): Promise<void> {
    const commitment = await this.prisma.commitment.findUnique({
      where: { id: commitmentId },
      select: { projectId: true },
    });
    if (!commitment || commitment.projectId !== projectId) {
      throw new NotFoundException(`Commitment ${commitmentId} not found for project ${projectId}`);
    }
  }

  private async requireUser(userId: string, field: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException(`The ${field} ${userId} is not a known user`);
  }

  private async requireUsableDestination(
    projectId: string,
    destinationId: string,
  ): Promise<DestinationRow> {
    const destination = await this.prisma.publishDestination.findUnique({
      where: { id: destinationId },
    });
    if (!destination || destination.projectId !== projectId) {
      throw new NotFoundException(
        `Publish destination ${destinationId} not found for project ${projectId}`,
      );
    }
    if (destination.revokedAt) {
      throw new ConflictException({
        error: 'destination-revoked',
        message: 'That destination was revoked.',
      });
    }
    const declaration = findProvider(destination.provider);
    if (!declaration || !declaration.implemented) {
      throw new BadRequestException({
        error: 'provider-not-implemented',
        message:
          declaration?.unavailableReason ??
          `Provider "${destination.provider}" has no adapter in this build.`,
      });
    }
    return destination as DestinationRow;
  }

  private async requirePlacement(projectId: string, id: string): Promise<PlacementRow> {
    const row = await this.prisma.contentSchedule.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Placement ${id} not found for project ${projectId}`);
    }
    return row as PlacementRow;
  }
}

// ── Module-private helpers ───────────────────────────────────────────────

/** §6.5's four distinctions, chosen by what is actually blocking. */
function pastDueReasonFor(hold: HoldReason): PastDueReason {
  switch (hold) {
    case 'approval-invalidated':
      return 'approval-hold';
    case 'no-destination':
    case 'destination-not-connected':
    case 'destination-revoked':
    case 'destination-error':
      return 'disconnected-account';
    case 'manual-delivery':
      return 'manual-publishing';
    case 'provider-not-implemented':
      return 'unsupported-channel';
    default:
      return 'dispatch-pending';
  }
}

/**
 * A URL safe to render as "View live content".
 *
 * Only http(s), with a host, and no embedded credentials. Anything else (a
 * `javascript:` scheme, a relative path, a `user:pass@host` form) is not a live
 * content link and is reported as absent rather than shown — §6.5 makes the
 * link conditional on a known **safe** published URL.
 */
function safeLiveUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

type Cursor = { kind: 'key'; plannedForUtc: string; id: string } | { kind: 'offset'; offset: number };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Cursors are opaque and never trusted.
 *
 * A malformed cursor is refused rather than treated as "start from the
 * beginning": silently restarting would make a paging loop look like it
 * completed, which is the same failure as implying a truncated month is empty.
 */
function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (
      parsed &&
      parsed.kind === 'key' &&
      typeof parsed.plannedForUtc === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return parsed;
    }
    if (parsed && parsed.kind === 'offset' && typeof parsed.offset === 'number' && parsed.offset >= 0) {
      return parsed;
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new BadRequestException({
    error: 'invalid-cursor',
    message:
      'That page cursor is not readable. Restart the read without a cursor rather than continuing from an unknown position.',
  });
}

function decodeKeyCursor(cursor: string | undefined): { plannedForUtc: Date; id: string } | null {
  const decoded = decodeCursor(cursor);
  if (!decoded) return null;
  if (decoded.kind !== 'key') {
    throw new BadRequestException({
      error: 'invalid-cursor',
      message: 'That cursor belongs to a different list.',
    });
  }
  const at = new Date(decoded.plannedForUtc);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException({ error: 'invalid-cursor', message: 'That page cursor is not readable.' });
  }
  return { plannedForUtc: at, id: decoded.id };
}

function decodeOffsetCursor(cursor: string | undefined): number {
  const decoded = decodeCursor(cursor);
  if (!decoded) return 0;
  if (decoded.kind !== 'offset') {
    throw new BadRequestException({
      error: 'invalid-cursor',
      message: 'That cursor belongs to a different list.',
    });
  }
  return decoded.offset;
}
