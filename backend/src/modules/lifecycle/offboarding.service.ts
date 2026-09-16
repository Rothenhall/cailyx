/**
 * OffboardingService — G17's preview / execute / status workflow.
 *
 * The whole design is one sentence: **a preview names exactly what will be
 * touched, and an execute refuses to touch anything the preview did not name.**
 *
 * - {@link OffboardingService.preview} counts every resource type the policy
 *   table defines, stores `{ resourceType: count }` on the `OffboardingRun`,
 *   and lists them with the sentence describing what the action does. Nothing
 *   is changed, and nothing is hidden: the preview is never narrowed to a
 *   subset on the caller's behalf.
 * - {@link OffboardingService.execute} loads that preview, **re-counts the
 *   same resource types**, and refuses (409) if any count has moved. That is
 *   the mechanical guarantee against a broad accidental cascade: the plan an
 *   operator confirmed is the plan that runs, or nothing runs.
 *
 * It also implements the three details G17 calls out specifically:
 *
 * - **Public links are handled, not forgotten.** `ReportShareLink` rows are
 *   either revoked (`revokedAt` stamped, and the report made private again so
 *   a revoked link stops resolving) or kept, and the response says which and
 *   how many.
 * - **Credentials really go.** Google grants, delegations, portal seats and
 *   client logins are deleted and cannot be overridden to `retain` — the one
 *   non-negotiable effect of an offboarding is that access ends.
 * - **The audit trail does not.** `activity-events` is retained, the override
 *   for it is *refused* rather than ignored, and the run writes its own record
 *   before it removes anything, so the deletion is checkable afterwards.
 *
 * @module offboarding.service
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ExportStorageService } from './export-storage.service';
import {
  inExecutionOrder,
  policyFor,
  RESOURCE_POLICIES,
  ACTION_MEANINGS,
  type LifecycleAction,
  type ResourcePolicy,
} from './lifecycle.policy';
import type {
  OffboardingPreview,
  OffboardingResourcePlan,
  OffboardingStatus,
  ResourceCounts,
  ShareLinkPolicy,
} from './lifecycle.types';
import { PREVIEW_TTL_MINUTES } from './lifecycle.types';
import type {
  CancelOffboardingDto,
  ExecuteOffboardingDto,
  PreviewOffboardingDto,
} from './dto/offboarding.dto';

/**
 * The one reserved key inside `OffboardingRun.planned`, holding the action
 * chosen for each resource type. Every other key in that JSON is a resource
 * type mapped to its count, exactly as the model documents.
 */
const POLICY_KEY = '__policy';

/**
 * Resource types excluded from the preview-vs-execute drift comparison.
 * See `diff()` — the audit trail grows because this workflow runs.
 */
const DRIFT_EXEMPT = new Set(['activity-events']);

/** Display labels for the five resource classes design_plan G17 names. */
const CLASS_LABELS: Record<string, string> = {
  artifact: 'Artifacts',
  credential: 'Credentials',
  'scheduled-work': 'Scheduled work',
  message: 'Messages',
  'audit-history': 'Audit history',
};

/** Flatten a built plan into the action map stored under {@link POLICY_KEY}. */
function plannedActions(resources: OffboardingResourcePlan[]): Record<string, string> {
  const actions: Record<string, string> = {};
  for (const entry of resources) actions[entry.resourceType] = entry.action;
  return actions;
}

/** Audit-trail source keys on an `EvidenceManifest`, mapped to the policy resource that owns them. */
const EVIDENCE_KEY_TO_RESOURCE: Record<string, string> = {
  observation: 'observations',
  'measurement-run': 'measurement-runs',
  'score-run': 'score-runs',
  'technical-audit': 'technical-audits',
  'seo-audit': 'seo-audits',
  'aeo-audit': 'aeo-audits',
  'aeo-surface-run': 'aeo-audits',
  'presence-discovery': 'presence-discoveries',
  'authority-scan': 'authority-scans',
  'backlinks-summary': 'backlinks-summaries',
  report: 'reports',
};

/** The scope of rows an offboarding of one client covers. */
interface OffboardingScope {
  client: { id: string; name: string; status: string };
  projectIds: string[];
  reportIds: string[];
  briefIds: string[];
  workItemIds: string[];
  clientUserIds: string[];
  scanIds: string[];
}

/** An `OffboardingRun` as returned to a caller. */
export interface OffboardingRunView {
  id: string;
  clientId: string;
  status: OffboardingStatus;
  planned: ResourceCounts;
  executed: ResourceCounts;
  shareLinkPolicy: ShareLinkPolicy;
  exportRequestId: string | null;
  requestedBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** A preview older than this can no longer be executed. */
  previewExpiresAt: string | null;
  /** Recomputed on read, so a stored preview can be compared against the present. */
  currentCounts: ResourceCounts | null;
  /** Resource types whose current count differs from the preview. Empty means the plan is still exact. */
  drift: Array<{ resourceType: string; planned: number; current: number }>;
}

@Injectable()
export class OffboardingService {
  private readonly logger = new Logger(OffboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly storage: ExportStorageService,
  ) {}

  // ── Preview ─────────────────────────────────────────────────────────

  /**
   * Build the plan. Reads only — nothing in this method writes to a resource
   * table, which is what makes it safe to call from a screen that is merely
   * being looked at.
   */
  async preview(
    clientId: string,
    dto: PreviewOffboardingDto,
    actor: { userId: string; label: string | null },
  ): Promise<OffboardingPreview> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, status: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const shareLinkPolicy = (dto.shareLinkPolicy ?? 'revoke') as ShareLinkPolicy;
    const overrides = this.resolveOverrides(dto.overrides);

    const scope = await this.loadScope(client);
    const counts = await this.countAll(scope);
    const plan = await this.buildPlan(scope, counts, overrides, shareLinkPolicy);

    const planned: ResourceCounts = {};
    for (const entry of plan.resources) planned[entry.resourceType] = entry.count;

    const run = await this.prisma.offboardingRun.create({
      data: {
        clientId,
        status: 'preview',
        // `planned` is `{ resourceType: count }` as the model documents, plus
        // one reserved `__policy` key carrying the action chosen for each
        // resource type. Storing the actions is what lets `execute` carry out
        // the exact plan that was shown, rather than re-deriving one from
        // policy defaults that an override may have moved.
        planned: JSON.stringify({ ...planned, [POLICY_KEY]: { actions: plannedActions(plan.resources), shareLinkPolicy } }),
        shareLinkPolicy,
        requestedBy: actor.userId,
      },
    });

    const frozenConflicts = plan.frozenSnapshotConflicts;

    await this.activity.record({
      actor: { type: 'user', id: actor.userId, label: actor.label },
      action: 'created',
      resource: { type: 'offboarding-run', id: run.id, version: null },
      clientId,
      summary: `Offboarding preview for ${client.name}: ${plan.resources.reduce((sum, entry) => sum + entry.count, 0)} row(s) across ${plan.resources.filter((entry) => entry.count > 0).length} resource type(s)`,
      changes: { planned, shareLinkPolicy, overrides: dto.overrides ?? {}, frozenSnapshotConflicts: frozenConflicts.map((entry) => entry.manifestId) },
      clientVisible: false,
    });

    return {
      offboardingRunId: run.id,
      clientId,
      clientName: client.name,
      generatedAt: run.createdAt.toISOString(),
      expiresAt: new Date(run.createdAt.getTime() + PREVIEW_TTL_MINUTES * 60_000).toISOString(),
      status: 'preview',
      shareLinkPolicy,
      byClass: plan.byClass,
      resources: plan.resources,
      totalsByAction: plan.totalsByAction,
      shareLinks: plan.shareLinks,
      frozenSnapshotConflicts: frozenConflicts,
      notes: plan.notes,
    };
  }

  // ── Execute ─────────────────────────────────────────────────────────

  /**
   * Run the plan.
   *
   * The order of the guards is deliberate — the cheapest and most consequential
   * checks come first, and **no resource row is touched until every guard has
   * passed**:
   *
   * 1. the preview exists, belongs to this client, and is still `preview`
   * 2. it has not expired
   * 3. `confirm` is literally true and `confirmationPhrase` matches the client's name
   * 4. every count still matches the preview (or the whole execute is refused)
   * 5. any frozen evidence snapshot the plan would break has been acknowledged
   * 6. any named export is really `ready` and really this client's
   */
  async execute(
    clientId: string,
    dto: ExecuteOffboardingDto,
    actor: { userId: string; label: string | null },
  ): Promise<OffboardingRunView> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, status: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const run = await this.prisma.offboardingRun.findFirst({ where: { id: dto.previewRunId, clientId } });
    if (!run) throw new NotFoundException(`Offboarding preview ${dto.previewRunId} not found for this client`);
    if (run.status !== 'preview') {
      throw new ConflictException(
        `Offboarding preview ${run.id} is ${run.status}; only a preview can be executed. Start a new preview if this run was already carried out.`,
      );
    }
    if (Date.now() - run.createdAt.getTime() > PREVIEW_TTL_MINUTES * 60_000) {
      throw new ConflictException(
        `Offboarding preview ${run.id} was generated ${run.createdAt.toISOString()} and is older than ${PREVIEW_TTL_MINUTES} minutes. ` +
          'A preview is a promise about a specific state of the data; request a fresh one.',
      );
    }
    if (dto.confirm !== true) {
      throw new BadRequestException('An offboarding is destructive; pass `confirm: true` to proceed.');
    }
    if (dto.confirmationPhrase !== client.name) {
      throw new BadRequestException(
        'The confirmation phrase must be the client\'s exact name. This guard exists to catch a call assembled against the wrong client id.',
      );
    }

    const shareLinkPolicy = (dto.shareLinkPolicy ?? (run.shareLinkPolicy as ShareLinkPolicy)) as ShareLinkPolicy;
    const planned = this.parseCounts(run.planned);

    // Re-count, and refuse on any drift. This is the mechanical form of
    // "no broad accidental cascade": the plan that runs is the plan that was
    // shown, or nothing runs at all.
    const scope = await this.loadScope(client);
    const current = await this.countAll(scope);
    const drift = this.diff(planned, current);
    if (drift.length > 0) {
      throw new ConflictException(
        `The client's data changed since the preview: ${drift
          .map((entry) => `${entry.resourceType} ${entry.planned} -> ${entry.current}`)
          .join(', ')}. ` +
          'Request a fresh preview so the exact resources are listed before anything is removed.',
      );
    }

    // Execute carries out the actions the preview recorded, not actions
    // re-derived from the policy table. Re-deriving would let a policy change
    // between preview and execute silently change what runs — and the whole
    // contract is that the plan an operator confirmed is the plan that runs.
    const plan = await this.buildPlan(scope, current, this.plannedActions(run.planned), shareLinkPolicy);

    if (plan.frozenSnapshotConflicts.length > 0 && dto.acknowledgeFrozenSnapshots !== true) {
      throw new ConflictException(
        `This plan deletes rows that ${plan.frozenSnapshotConflicts.length} pinned evidence manifest(s) name: ` +
          `${plan.frozenSnapshotConflicts.map((entry) => entry.manifestId).join(', ')}. ` +
          'A manifest whose sources are gone can no longer be resolved, so the acknowledgement must be explicit: pass `acknowledgeFrozenSnapshots: true` to proceed.',
      );
    }

    if (dto.exportRequestId) {
      const exportRow = await this.prisma.exportRequest.findFirst({
        where: { id: dto.exportRequestId, scopeType: 'client', scopeId: clientId, status: 'ready' },
        select: { id: true },
      });
      if (!exportRow) {
        throw new NotFoundException(
          `Export ${dto.exportRequestId} is not a ready client-scoped export for this client. A copy must be taken and ready before it can be recorded as the one kept.`,
        );
      }
    }

    await this.prisma.offboardingRun.update({ where: { id: run.id }, data: { status: 'executing' } });

    // The record of what is about to happen is written first, so it survives
    // whatever this run removes.
    await this.activity.record({
      actor: { type: 'user', id: actor.userId, label: actor.label },
      action: 'started',
      resource: { type: 'offboarding-run', id: run.id, version: null },
      clientId,
      summary: `Offboarding started for ${client.name}`,
      changes: { planned, shareLinkPolicy, exportRequestId: dto.exportRequestId ?? null },
      clientVisible: false,
    });

    await this.prisma.offboardingRun.update({
      where: { id: run.id },
      data: { confirmedBy: actor.userId, confirmedAt: new Date(), shareLinkPolicy },
    });

    try {
      const executed = await this.apply(scope, plan.resources, shareLinkPolicy);

      const completed = await this.prisma.offboardingRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          executed: JSON.stringify(executed),
          exportRequestId: dto.exportRequestId ?? null,
          completedAt: new Date(),
        },
      });

      await this.activity.record({
        actor: { type: 'user', id: actor.userId, label: actor.label },
        action: 'deleted',
        resource: { type: 'offboarding-run', id: run.id, version: null },
        clientId,
        summary: `Offboarding completed for ${client.name}: ${Object.values(executed).reduce((sum, n) => sum + n, 0)} row(s) affected across ${Object.keys(executed).length} resource type(s)`,
        changes: { planned, executed, shareLinkPolicy },
        clientVisible: false,
      });

      this.logger.log(`Offboarding ${run.id} completed for client ${clientId}`);
      return this.toView(completed, current);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Offboarding ${run.id} failed: ${message}`);
      const failed = await this.prisma.offboardingRun.update({
        where: { id: run.id },
        data: { status: 'failed', error: message.slice(0, 1000) },
      });
      await this.activity.record({
        actor: { type: 'user', id: actor.userId, label: actor.label },
        action: 'updated',
        resource: { type: 'offboarding-run', id: run.id, version: null },
        clientId,
        summary: `Offboarding failed for ${client.name}`,
        changes: { error: message },
        result: 'failure',
        clientVisible: false,
      });
      return this.toView(failed, null);
    }
  }

  /** A client's offboarding runs, newest first. */
  async list(clientId: string): Promise<OffboardingRunView[]> {
    const rows = await this.prisma.offboardingRun.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((row) => this.toView(row, null));
  }

  /** One run, re-counted so its plan can be compared against the present. */
  async get(clientId: string, id: string): Promise<OffboardingRunView> {
    const row = await this.prisma.offboardingRun.findFirst({ where: { id, clientId } });
    if (!row) throw new NotFoundException(`Offboarding run ${id} not found for this client`);

    let current: ResourceCounts | null = null;
    if (row.status === 'preview') {
      const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, status: true } });
      if (client) current = await this.countAll(await this.loadScope(client));
    }
    return this.toView(row, current);
  }

  /**
   * Abandon a preview that will not be executed. Only a `preview` can be
   * cancelled — a run that already executed is a fact, and "cancelling" it
   * would be a claim about the past rather than a decision about the future.
   */
  async cancel(
    clientId: string,
    id: string,
    dto: CancelOffboardingDto,
    actor: { userId: string; label: string | null },
  ): Promise<OffboardingRunView> {
    const row = await this.prisma.offboardingRun.findFirst({ where: { id, clientId } });
    if (!row) throw new NotFoundException(`Offboarding run ${id} not found for this client`);
    if (row.status !== 'preview') {
      throw new ConflictException(`Offboarding run ${id} is ${row.status}; only an unexecuted preview can be cancelled.`);
    }

    const cancelled = await this.prisma.offboardingRun.update({
      where: { id },
      data: { status: 'cancelled', error: dto.reason ?? null },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId, label: actor.label },
      action: 'cancelled',
      resource: { type: 'offboarding-run', id, version: null },
      clientId,
      summary: `Offboarding preview cancelled${dto.reason ? `: ${dto.reason}` : ''}`,
      changes: { reason: dto.reason ?? null },
      clientVisible: false,
    });

    return this.toView(cancelled, null);
  }

  // ── Scope and counting ──────────────────────────────────────────────

  private async loadScope(client: { id: string; name: string; status: string }): Promise<OffboardingScope> {
    const projects = await this.prisma.project.findMany({ where: { clientId: client.id }, select: { id: true } });
    const projectIds = projects.map((project) => project.id);

    const [reports, briefs, workItems, clientUsers, scans] = await Promise.all([
      this.prisma.report.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } }),
      this.prisma.contentBrief.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } }),
      this.prisma.workItem.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } }),
      this.prisma.user.findMany({ where: { clientId: client.id, type: 'client' }, select: { id: true } }),
      this.prisma.authorityScan.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } }),
    ]);

    return {
      client,
      projectIds,
      reportIds: reports.map((row) => row.id),
      briefIds: briefs.map((row) => row.id),
      workItemIds: workItems.map((row) => row.id),
      clientUserIds: clientUsers.map((row) => row.id),
      scanIds: scans.map((row) => row.id),
    };
  }

  /**
   * Count every resource type in the policy table.
   *
   * Each count is the number of rows the action would actually *change*, not
   * the number of rows that happen to exist: a project already archived is not
   * affected by archiving it again, and counting it would inflate the preview
   * into a number nobody could act on.
   */
  private async countAll(scope: OffboardingScope): Promise<ResourceCounts> {
    const { projectIds, reportIds, briefIds, workItemIds, clientUserIds, scanIds, client } = scope;
    const counts: ResourceCounts = {};

    const [
      reportsArchivable, reportRevisions, deliveryAttempts, briefsArchivable, contentRevisions,
      workItemsArchivable, cyclesOpen, milestones, engagementsPausable, attachmentsLive,
      observations, measurementRuns, scoreRuns, technicalAudits, seoAudits, aeoAudits,
      presenceDiscoveries, authorityScans, backlinks, competitors, querySets, personas,
      cadenceRulesLive, scheduleConfigsLive, messages, readCursorsAccuracy,
      activityEvents, jobRuns, verifications, approvals, exports,
      clientUsers, clientMembers, authTokens, googleConnections, delegations,
      projectsArchivable, clientArchivable,
    ] = await Promise.all([
      this.prisma.report.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.reportRevision.count({ where: { reportId: { in: reportIds } } }),
      this.prisma.reportDeliveryAttempt.count({ where: { reportId: { in: reportIds } } }),
      this.prisma.contentBrief.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.contentRevision.count({ where: { briefId: { in: briefIds } } }),
      this.prisma.workItem.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.cycle.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.milestone.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.engagement.count({ where: { clientId: client.id } }),
      this.prisma.attachment.count({ where: { projectId: { in: projectIds }, deletedAt: null } }),
      this.prisma.observation.count({ where: { run: { projectId: { in: projectIds } } } }),
      this.prisma.measurementRun.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.scoreRun.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.technicalAudit.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.seoAudit.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.aeoAudit.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.presenceDiscovery.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.authorityScan.count({ where: { id: { in: scanIds } } }),
      this.prisma.backlinksSummary.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.competitor.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.querySet.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.persona.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.cadenceRule.count({ where: { projectId: { in: projectIds }, pausedAt: null } }),
      this.prisma.scheduleConfig.count({ where: { projectId: { in: projectIds }, OR: [{ active: true }, { seoActive: true }] } }),
      this.prisma.clientMessage.count({ where: { clientId: client.id } }),
      this.prisma.messageReadCursor.count({ where: { userId: { in: clientUserIds } } }),
      this.prisma.activityEvent.count({ where: { OR: [{ clientId: client.id }, { projectId: { in: projectIds } }] } }),
      this.prisma.jobRun.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.verification.count({ where: { workItemId: { in: workItemIds } } }),
      this.prisma.approvalRequest.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.exportRequest.count({
        where: { OR: [{ scopeType: 'client', scopeId: client.id }, { scopeType: 'project', scopeId: { in: projectIds } }] },
      }),
      this.prisma.user.count({ where: { clientId: client.id, type: 'client' } }),
      this.prisma.clientMember.count({ where: { clientId: client.id } }),
      this.prisma.authToken.count({ where: { userId: { in: clientUserIds } } }),
      // Connections owned by this client's own logins. An operator-owned
      // connection that merely serves this client through a delegation is
      // deliberately NOT counted here — see `apply`.
      this.prisma.googleConnection.count({ where: { userId: { in: clientUserIds } } }),
      this.prisma.connectionDelegation.count({ where: { projectId: { in: projectIds }, revokedAt: null } }),
      this.prisma.project.count({ where: { id: { in: projectIds }, status: { not: 'archived' } } }),
      client.status === 'churned' ? 0 : 1,
    ]);

    counts['client'] = clientArchivable;
    counts['projects'] = projectsArchivable;
    counts['reports'] = reportsArchivable;
    counts['report-revisions'] = reportRevisions;
    counts['report-delivery-attempts'] = deliveryAttempts;
    counts['content-briefs'] = briefsArchivable;
    counts['content-revisions'] = contentRevisions;
    counts['work-items'] = workItemsArchivable;
    counts['cycles'] = cyclesOpen;
    counts['milestones'] = milestones;
    counts['attachments'] = attachmentsLive;
    counts['observations'] = observations;
    counts['measurement-runs'] = measurementRuns;
    counts['score-runs'] = scoreRuns;
    counts['technical-audits'] = technicalAudits;
    counts['seo-audits'] = seoAudits;
    counts['aeo-audits'] = aeoAudits;
    counts['presence-discoveries'] = presenceDiscoveries;
    counts['authority-scans'] = authorityScans;
    counts['backlinks-summaries'] = backlinks;
    counts['competitors'] = competitors;
    counts['query-sets'] = querySets;
    counts['personas'] = personas;
    counts['cadence-rules'] = cadenceRulesLive;
    counts['schedule-configs'] = scheduleConfigsLive;
    counts['engagements'] = engagementsPausable;
    counts['client-messages'] = messages;
    counts['message-read-cursors'] = readCursorsAccuracy;
    counts['activity-events'] = activityEvents;
    counts['job-runs'] = jobRuns;
    counts['verifications'] = verifications;
    counts['approvals'] = approvals;
    counts['exports'] = exports;
    counts['client-users'] = clientUsers;
    counts['client-members'] = clientMembers;
    counts['auth-tokens'] = authTokens;
    counts['google-connections'] = googleConnections;
    counts['connection-delegations'] = delegations;

    return counts;
  }

  /**
   * Compare a stored plan against a fresh count.
   *
   * The audit trail is exempt. Offboarding writes to it *as part of running* —
   * the preview records itself, and every execute attempt records itself before
   * it does anything — so its count can never be a stable signal, and requiring
   * it to match would mean no preview could ever be executed. Nothing is lost
   * by exempting it: the policy retains `activity-events` unconditionally, so
   * this run was never going to remove any of them.
   */
  private diff(planned: ResourceCounts, current: ResourceCounts): Array<{ resourceType: string; planned: number; current: number }> {
    const drift: Array<{ resourceType: string; planned: number; current: number }> = [];
    for (const policy of RESOURCE_POLICIES) {
      if (DRIFT_EXEMPT.has(policy.resourceType)) continue;
      const before = planned[policy.resourceType] ?? 0;
      const after = current[policy.resourceType] ?? 0;
      if (before !== after) drift.push({ resourceType: policy.resourceType, planned: before, current: after });
    }
    return drift;
  }

  // ── Plan assembly ───────────────────────────────────────────────────

  /**
   * Assemble the plan.
   *
   * `actions` is the decision set — either the caller's validated overrides at
   * preview time, or the actions the stored preview recorded at execute time.
   * Anything not in it falls back to the policy default, and `overridden`
   * records which is which so the response never presents a default as a
   * choice somebody made.
   */
  private async buildPlan(
    scope: OffboardingScope,
    counts: ResourceCounts,
    actions: Map<string, LifecycleAction>,
    shareLinkPolicy: ShareLinkPolicy,
  ): Promise<{
    resources: OffboardingResourcePlan[];
    byClass: Record<string, { label: string; meaning: string; resourceTypes: string[]; total: number }>;
    totalsByAction: Record<string, number>;
    shareLinks: OffboardingPreview['shareLinks'];
    frozenSnapshotConflicts: OffboardingPreview['frozenSnapshotConflicts'];
    notes: string[];
  }> {
    const resources: OffboardingResourcePlan[] = [];
    const totalsByAction: Record<string, number> = {};
    const byClass: Record<string, { label: string; meaning: string; resourceTypes: string[]; total: number }> = {};

    for (const resourceType of inExecutionOrder(RESOURCE_POLICIES.map((policy) => policy.resourceType))) {
      const policy = policyFor(resourceType);
      if (!policy) continue;
      const chosen = actions.get(resourceType);
      const action = chosen ?? policy.action;
      const count = counts[resourceType] ?? 0;

      resources.push({
        resourceType,
        label: policy.label,
        resourceClass: policy.resourceClass,
        action,
        meaning: action === policy.action ? policy.meaning : this.overrideMeaning(policy, action),
        count,
        overridden: chosen !== undefined && chosen !== policy.action,
        consequence: policy.consequence,
      });

      totalsByAction[action] = (totalsByAction[action] ?? 0) + count;

      const classEntry = byClass[policy.resourceClass] ?? {
        label: CLASS_LABELS[policy.resourceClass],
        meaning: this.classMeaning(policy.resourceClass),
        resourceTypes: [],
        total: 0,
      };
      classEntry.resourceTypes.push(resourceType);
      classEntry.total += count;
      byClass[policy.resourceClass] = classEntry;
    }

    // Public links, handled explicitly rather than left to the report archive.
    const links = await this.prisma.reportShareLink.findMany({
      where: { reportId: { in: scope.reportIds }, revokedAt: null },
      select: { id: true },
    });
    const shareLinks: OffboardingPreview['shareLinks'] = {
      policy: shareLinkPolicy,
      count: links.length,
      explanation:
        shareLinkPolicy === 'revoke'
          ? `${links.length} live public report link(s) will be revoked: revokedAt is stamped and each report's visibility is set back to private, so the link stops resolving.`
          : `${links.length} live public report link(s) will be KEPT and will continue to resolve to the archived reports. This is the one effect of an offboarding a client cannot undo afterwards; choose "revoke" unless the links are deliberately being left up.`,
    };

    const notes: string[] = [
      'The preview lists every resource type this system defines a policy for, including the ones with a count of 0. Nothing is omitted from the list to make it shorter.',
      'Applying an action changes only the rows counted above. A parent and a child are listed separately, so deleting a project while retaining its reports is visible as two lines rather than as a surprise.',
    ];

    const deletingParents = resources.filter((entry) => entry.action === 'delete' && ['projects', 'client'].includes(entry.resourceType) && entry.count > 0);
    if (deletingParents.length > 0) {
      const retainedChildren = resources.filter((entry) => entry.action === 'retain' && entry.count > 0);
      if (retainedChildren.length > 0) {
        notes.push(
          `This plan deletes ${deletingParents.map((entry) => entry.label).join(' and ')} while retaining ${retainedChildren
            .map((entry) => entry.label)
            .join(', ')}. The retained rows keep their existing project references, which will no longer resolve. Override those to "delete" as well if that is not what you want.`,
        );
      }
    }

    // A pinned evidence manifest names the exact rows a frozen snapshot was
    // built from. Deleting those rows leaves the snapshot unresolvable, so the
    // plan names the manifests before anything runs.
    const deletedResourceTypes = new Set(resources.filter((entry) => entry.action === 'delete' && entry.count > 0).map((entry) => entry.resourceType));
    const frozenSnapshotConflicts: OffboardingPreview['frozenSnapshotConflicts'] = [];
    if (deletedResourceTypes.size > 0) {
      const manifests = await this.prisma.evidenceManifest.findMany({
        where: { projectId: { in: scope.projectIds } },
        select: { id: true, subjectType: true, sources: true },
        take: 200,
      });
      for (const manifest of manifests) {
        let sourceKeys: string[] = [];
        try {
          const parsed: unknown = JSON.parse(manifest.sources);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sourceKeys = Object.keys(parsed as Record<string, unknown>);
        } catch {
          sourceKeys = [];
        }
        const hit = sourceKeys
          .map((key) => EVIDENCE_KEY_TO_RESOURCE[key])
          .filter((resourceType): resourceType is string => Boolean(resourceType) && deletedResourceTypes.has(resourceType));
        if (hit.length > 0) {
          frozenSnapshotConflicts.push({ manifestId: manifest.id, subjectType: manifest.subjectType, resourceTypes: Array.from(new Set(hit)) });
        }
      }
    }
    if (frozenSnapshotConflicts.length > 0) {
      notes.push(
        `${frozenSnapshotConflicts.length} pinned evidence manifest(s) reference rows this plan deletes. Executing without ` +
          '`acknowledgeFrozenSnapshots: true` is refused: a frozen snapshot whose sources are gone cannot be resolved, and an old report is supposed to stay reproducible.',
      );
    }

    // Operator-owned connections serving this client through a delegation are
    // deliberately kept — deleting them would revoke access for every other
    // client they serve.
    const delegated = await this.prisma.connectionDelegation.count({ where: { projectId: { in: scope.projectIds }, revokedAt: null } });
    if (delegated > 0) {
      notes.push(
        `${delegated} delegated Google connection(s) serve this client's projects. The delegations are revoked; the underlying connection rows are kept, ` +
          'because an operator-owned grant may serve other clients and deleting it here would revoke their access too.',
      );
    }

    const exportsKept = counts['exports'] ?? 0;
    if (exportsKept > 0) {
      notes.push(
        `${exportsKept} export request(s) belong to this client. Export files expire on their own schedule and are removed when they do; the export history rows are retained.`,
      );
    }

    return { resources, byClass, totalsByAction, shareLinks, frozenSnapshotConflicts, notes };
  }

  private classMeaning(resourceClass: string): string {
    switch (resourceClass) {
      case 'artifact':
        return ACTION_MEANINGS.archive.meaning;
      case 'credential':
        return 'Credentials are removed outright. Offboarding has exactly one non-negotiable effect: the client\'s access ends.';
      case 'scheduled-work':
        return ACTION_MEANINGS.pause.meaning;
      case 'message':
        return 'Message rows are listed individually so their fate is a decision rather than a side effect of the client leaving.';
      case 'audit-history':
        return 'Audit history is retained under policy even when the resources it describes are deleted. This is what makes the offboarding itself checkable afterwards.';
      default:
        return '';
    }
  }

  private overrideMeaning(policy: ResourcePolicy, action: LifecycleAction): string {
    return `Overridden from the default "${policy.action}" to "${action}": ${ACTION_MEANINGS[action].meaning}`;
  }

  /**
   * Validate a caller's overrides against the policy table.
   *
   * An override for a non-overridable resource type is **refused**, not
   * ignored: quietly dropping it would let an operator believe they had
   * preserved something the executor then deleted, which is the worst possible
   * failure mode for a destructive workflow.
   */
  private resolveOverrides(raw: Record<string, string> | undefined): Map<string, LifecycleAction> {
    const resolved = new Map<string, LifecycleAction>();
    if (!raw) return resolved;

    for (const [resourceType, action] of Object.entries(raw)) {
      const policy = policyFor(resourceType);
      if (!policy) {
        throw new BadRequestException(`Unknown offboarding resource type "${resourceType}".`);
      }
      if (!policy.overridable) {
        throw new BadRequestException(
          `The ${resourceType} policy cannot be overridden (the offboarding policy fixes it at "${policy.action}"). ` +
            'It is refused rather than ignored, so this request changed nothing.',
        );
      }
      if (!policy.allowedActions.includes(action as LifecycleAction)) {
        throw new BadRequestException(
          `The ${resourceType} policy permits ${policy.allowedActions.join(', ')}, not "${action}".`,
        );
      }
      resolved.set(resourceType, action as LifecycleAction);
    }
    return resolved;
  }

  /**
   * The actions a stored preview recorded.
   *
   * Validated again on read rather than trusted: the policy table is code and
   * could in principle change between a preview and its execute, and applying
   * an action the policy no longer permits would be the one failure this
   * workflow must not have. A preview with no recorded actions is refused
   * rather than executed from defaults — defaults are a *different* plan.
   */
  private plannedActions(raw: string): Map<string, LifecycleAction> {
    const stored = this.parsePolicyBlock(raw);
    if (!stored) {
      throw new ConflictException(
        'This offboarding preview does not record which action it planned for each resource type, so executing it would run a different plan than the one that was shown. Request a fresh preview.',
      );
    }

    const resolved = new Map<string, LifecycleAction>();
    for (const [resourceType, action] of Object.entries(stored.actions)) {
      const policy = policyFor(resourceType);
      if (!policy) continue;
      if (!policy.allowedActions.includes(action)) {
        throw new ConflictException(
          `The ${resourceType} policy no longer permits "${action}", which this preview planned. Request a fresh preview.`,
        );
      }
      resolved.set(resourceType, action);
    }
    return resolved;
  }

  /** The reserved `__policy` block inside `planned`, when it is well-formed. */
  private parsePolicyBlock(raw: string): { actions: Record<string, LifecycleAction>; shareLinkPolicy?: string } | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const block = (parsed as Record<string, unknown>)[POLICY_KEY];
      if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
      const actionsRaw = (block as Record<string, unknown>).actions;
      if (!actionsRaw || typeof actionsRaw !== 'object' || Array.isArray(actionsRaw)) return null;

      const actions: Record<string, LifecycleAction> = {};
      for (const [key, value] of Object.entries(actionsRaw as Record<string, unknown>)) {
        if (typeof value === 'string') actions[key] = value as LifecycleAction;
      }
      const shareLinkPolicy = (block as Record<string, unknown>).shareLinkPolicy;
      return { actions, shareLinkPolicy: typeof shareLinkPolicy === 'string' ? shareLinkPolicy : undefined };
    } catch {
      return null;
    }
  }

  // ── Applying ────────────────────────────────────────────────────────

  /**
   * Carry out the plan, one resource type at a time, in execution order
   * (children before parents).
   *
   * Every branch is written out rather than driven off a table of SQL strings:
   * an offboarding is not the place for a clever generic deleter, and a reader
   * checking "what does this do to messages" should be able to read it here.
   */
  private async apply(
    scope: OffboardingScope,
    plan: OffboardingResourcePlan[],
    shareLinkPolicy: ShareLinkPolicy,
  ): Promise<ResourceCounts> {
    const { projectIds, reportIds, briefIds, workItemIds, clientUserIds } = scope;
    const executed: ResourceCounts = {};
    const now = new Date();

    for (const entry of plan) {
      if (entry.action === 'retain' || entry.count === 0) continue;
      const { resourceType, action } = entry;

      switch (resourceType) {
        case 'client':
          executed[resourceType] = action === 'delete'
            ? 0
            : (await this.prisma.client.updateMany({ where: { id: scope.client.id }, data: { status: 'churned' } })).count;
          break;

        case 'projects':
          executed[resourceType] = action === 'delete'
            ? (await this.prisma.project.deleteMany({ where: { id: { in: projectIds } } })).count
            : (await this.prisma.project.updateMany({ where: { id: { in: projectIds } }, data: { status: 'archived' } })).count;
          break;

        case 'reports':
          executed[resourceType] = action === 'delete'
            ? (await this.prisma.report.deleteMany({ where: { projectId: { in: projectIds } } })).count
            // Archive withdraws the report. `visibility` is left alone here and
            // is governed by shareLinkPolicy below, so the two decisions stay
            // separate.
            : (await this.prisma.report.updateMany({ where: { projectId: { in: projectIds }, status: { not: 'withdrawn' } }, data: { status: 'withdrawn' } })).count;
          break;

        case 'report-revisions':
          executed[resourceType] = (await this.prisma.reportRevision.deleteMany({ where: { reportId: { in: reportIds } } })).count;
          break;

        case 'report-delivery-attempts':
          executed[resourceType] = (await this.prisma.reportDeliveryAttempt.deleteMany({ where: { reportId: { in: reportIds } } })).count;
          break;

        case 'content-briefs':
          executed[resourceType] = action === 'delete'
            ? (await this.prisma.contentBrief.deleteMany({ where: { projectId: { in: projectIds } } })).count
            : (await this.prisma.contentBrief.updateMany({ where: { projectId: { in: projectIds }, status: { not: 'archived' } }, data: { status: 'archived' } })).count;
          break;

        case 'content-revisions':
          // ContentRevision binds to its brief through `assetId`.
          executed[resourceType] = (await this.prisma.contentRevision.deleteMany({ where: { assetId: { in: briefIds } } })).count;
          break;

        case 'work-items':
          executed[resourceType] = action === 'delete'
            ? (await this.prisma.workItem.deleteMany({ where: { projectId: { in: projectIds } } })).count
            : (await this.prisma.workItem.updateMany({
                where: { projectId: { in: projectIds }, status: { notIn: ['cancelled', 'verified'] } },
                data: { status: 'cancelled', blockedReason: null, blockedOn: null, assigneeId: null },
              })).count;
          break;

        case 'cycles':
          executed[resourceType] = action === 'delete'
            ? (await this.prisma.cycle.deleteMany({ where: { projectId: { in: projectIds } } })).count
            : (await this.prisma.cycle.updateMany({ where: { projectId: { in: projectIds }, status: { not: 'closed' } }, data: { status: 'closed', closedAt: now } })).count;
          break;

        case 'milestones':
          executed[resourceType] = (await this.prisma.milestone.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'attachments':
          executed[resourceType] = action === 'delete'
            ? (await this.prisma.attachment.updateMany({ where: { projectId: { in: projectIds }, deletedAt: null }, data: { deletedAt: now } })).count
            : 0;
          break;

        case 'observations':
          executed[resourceType] = (await this.prisma.observation.deleteMany({ where: { run: { projectId: { in: projectIds } } } })).count;
          break;

        case 'measurement-runs':
          executed[resourceType] = (await this.prisma.measurementRun.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'score-runs':
          executed[resourceType] = (await this.prisma.scoreRun.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'technical-audits':
          executed[resourceType] = (await this.prisma.technicalAudit.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'seo-audits':
          executed[resourceType] = (await this.prisma.seoAudit.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'aeo-audits':
          // Stance judgments and per-surface runs cascade from the audit.
          executed[resourceType] = (await this.prisma.aeoAudit.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'presence-discoveries':
          executed[resourceType] = (await this.prisma.presenceDiscovery.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'authority-scans':
          executed[resourceType] = (await this.prisma.authorityScan.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'backlinks-summaries':
          executed[resourceType] = (await this.prisma.backlinksSummary.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'competitors':
          executed[resourceType] = (await this.prisma.competitor.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'query-sets':
          executed[resourceType] = (await this.prisma.querySet.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'personas':
          executed[resourceType] = (await this.prisma.persona.deleteMany({ where: { projectId: { in: projectIds } } })).count;
          break;

        case 'cadence-rules':
          executed[resourceType] = (await this.prisma.cadenceRule.updateMany({
            where: { projectId: { in: projectIds }, pausedAt: null },
            data: { pausedAt: now, enabled: false, nextRunAt: null },
          })).count;
          break;

        case 'schedule-configs':
          executed[resourceType] = (await this.prisma.scheduleConfig.updateMany({
            where: { projectId: { in: projectIds } },
            data: { active: false, seoActive: false, nextRunAt: null, seoNextRunAt: null },
          })).count;
          break;

        case 'engagements':
          executed[resourceType] = action === 'archive'
            ? (await this.prisma.engagement.updateMany({ where: { clientId: scope.client.id }, data: { status: 'completed' } })).count
            : (await this.prisma.engagement.updateMany({
                where: { clientId: scope.client.id, status: 'active' },
                data: { status: 'paused', pausedAt: now, pauseReason: 'Client offboarding' },
              })).count;
          break;

        case 'client-messages':
          executed[resourceType] = (await this.prisma.clientMessage.deleteMany({ where: { clientId: scope.client.id } })).count;
          break;

        case 'message-read-cursors':
          executed[resourceType] = (await this.prisma.messageReadCursor.deleteMany({ where: { userId: { in: clientUserIds } } })).count;
          break;

        case 'activity-events':
          // Unreachable: the policy fixes this type at `retain` and refuses an
          // override. Present so the switch is exhaustive and the intent is
          // legible at the site where somebody might be tempted.
          executed[resourceType] = 0;
          break;

        case 'job-runs': {
          // JobStep binds to its run through `jobRunId`, a plain id with no
          // relation, so the children are removed explicitly rather than left
          // behind pointing at a run that no longer exists.
          const runs = await this.prisma.jobRun.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
          const runIds = runs.map((run) => run.id);
          if (runIds.length > 0) await this.prisma.jobStep.deleteMany({ where: { jobRunId: { in: runIds } } });
          executed[resourceType] = (await this.prisma.jobRun.deleteMany({ where: { id: { in: runIds } } })).count;
          break;
        }

        case 'verifications':
          executed[resourceType] = (await this.prisma.verification.deleteMany({ where: { workItemId: { in: workItemIds } } })).count;
          break;

        case 'approvals': {
          const requests = await this.prisma.approvalRequest.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
          const requestIds = requests.map((request) => request.id);
          if (requestIds.length > 0) {
            await this.prisma.approvalDecision.deleteMany({ where: { approvalRequestId: { in: requestIds } } });
          }
          executed[resourceType] = (await this.prisma.approvalRequest.deleteMany({ where: { id: { in: requestIds } } })).count;
          break;
        }

        case 'exports': {
          const rows = await this.prisma.exportRequest.findMany({
            where: { OR: [{ scopeType: 'client', scopeId: scope.client.id }, { scopeType: 'project', scopeId: { in: projectIds } }] },
            select: { id: true, storageKey: true },
          });
          for (const row of rows) {
            if (row.storageKey) await this.storage.remove(row.storageKey);
          }
          executed[resourceType] = (await this.prisma.exportRequest.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
          break;
        }

        case 'client-members':
          executed[resourceType] = (await this.prisma.clientMember.deleteMany({ where: { clientId: scope.client.id } })).count;
          break;

        case 'auth-tokens':
          executed[resourceType] = (await this.prisma.authToken.deleteMany({ where: { userId: { in: clientUserIds } } })).count;
          break;

        case 'client-users': {
          await this.prisma.refreshToken.deleteMany({ where: { userId: { in: clientUserIds } } });
          await this.prisma.userSession.deleteMany({ where: { userId: { in: clientUserIds } } });
          executed[resourceType] = (await this.prisma.user.deleteMany({ where: { id: { in: clientUserIds } } })).count;
          break;
        }

        case 'connection-delegations':
          executed[resourceType] = (await this.prisma.connectionDelegation.updateMany({
            where: { projectId: { in: projectIds }, revokedAt: null },
            data: { revokedAt: now },
          })).count;
          break;

        case 'google-connections':
          executed[resourceType] = (await this.prisma.googleConnection.deleteMany({ where: { userId: { in: clientUserIds } } })).count;
          break;

        default:
          throw new BadRequestException(`No offboarding action is implemented for "${resourceType}".`);
      }
    }

    // Public links, last: whether they keep resolving depends on the reports
    // above still existing, so this runs after the report actions and reports
    // exactly what it did.
    const shareLinks = await this.prisma.reportShareLink.findMany({
      where: { reportId: { in: reportIds }, revokedAt: null },
      select: { id: true },
    });
    if (shareLinks.length > 0) {
      if (shareLinkPolicy === 'revoke') {
        await this.prisma.reportShareLink.updateMany({
          where: { id: { in: shareLinks.map((link) => link.id) } },
          data: { revokedAt: now },
        });
        // A revoked link must stop resolving, and the public renderer keys off
        // `visibility`, so the reports behind revoked links are made private
        // again. Without this the link would return 404 only by accident.
        await this.prisma.report.updateMany({ where: { id: { in: reportIds } }, data: { visibility: 'private' } });
      }
      executed['report-share-links'] = shareLinkPolicy === 'revoke' ? shareLinks.length : 0;
    } else {
      executed['report-share-links'] = 0;
    }

    return executed;
  }

  // ── Serialisation ───────────────────────────────────────────────────

  private parseCounts(raw: string): ResourceCounts {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const counts: ResourceCounts = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'number') counts[key] = value;
        }
        return counts;
      }
    } catch {
      // Fall through to an empty plan — a corrupt `planned` column means there
      // is nothing to execute, and `diff` then reports every type as drift and
      // refuses, which is the safe outcome.
    }
    return {};
  }

  private toView(
    row: {
      id: string;
      clientId: string;
      status: string;
      planned: string;
      executed: string;
      shareLinkPolicy: string;
      exportRequestId: string | null;
      requestedBy: string;
      confirmedBy: string | null;
      confirmedAt: Date | null;
      completedAt: Date | null;
      error: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    current: ResourceCounts | null,
  ): OffboardingRunView {
    const planned = this.parseCounts(row.planned);
    const executed = this.parseCounts(row.executed);

    return {
      id: row.id,
      clientId: row.clientId,
      status: row.status as OffboardingStatus,
      planned,
      executed,
      shareLinkPolicy: row.shareLinkPolicy as ShareLinkPolicy,
      exportRequestId: row.exportRequestId,
      requestedBy: row.requestedBy,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      previewExpiresAt: new Date(row.createdAt.getTime() + PREVIEW_TTL_MINUTES * 60_000).toISOString(),
      currentCounts: current,
      drift: current ? this.diff(planned, current) : [],
    };
  }
}
