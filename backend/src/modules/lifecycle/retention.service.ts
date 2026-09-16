/**
 * RetentionService — G17's retention policy: what is kept, for how long, and
 * what happens when the window closes.
 *
 * A retention policy is a standing intention, so it is stored and readable even
 * when it has never run. The read returns every resource type this system
 * defines a policy for — including the ones with no row yet, reported as
 * `configured: false` with their documented defaults. A missing policy row is a
 * state to display, not a row to invent (the same discipline
 * `JobsController.cadences` uses for a missing schedule).
 *
 * Two rules are enforced rather than documented:
 *
 * - **A disabled policy never acts.** `apply` refuses (409) when the policy is
 *   not enabled, so a retention run is always the consequence of a decision
 *   somebody made, never of a mistyped URL against a default.
 * - **The audit trail is not deletable here.** `activity` permits `anonymize`
 *   and refuses `delete`, and a request for `delete` is rejected with the
 *   reason instead of being quietly downgraded. design_plan G17: deletion
 *   retains a safe audit record under policy.
 *
 * Each run writes an `ActivityEvent` before it reports its outcome, so the
 * record of what was removed survives the removal.
 *
 * @module retention.service
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import type {
  RetentionAction,
  RetentionCounts,
  RetentionResourceDefinition,
  RetentionResourceType,
} from './lifecycle.types';
import { RETENTION_ACTIONS, RETENTION_RESOURCE_TYPES } from './lifecycle.types';
import type { ApplyRetentionDto, UpdateRetentionPolicyDto } from './dto/retention.dto';

/**
 * The definition table.
 *
 * `allowedActions` is the honest part: an action is only offered where the rows
 * actually support it. `attachment` `delete` stamps `deletedAt` rather than
 * removing the row — the same meaning the offboarding policy gives it, because
 * two parts of the system using one word for two things is how a deletion
 * surprises somebody.
 */
export const RETENTION_DEFINITIONS: readonly RetentionResourceDefinition[] = [
  {
    resourceType: 'observations',
    label: 'Measurement observations',
    covers: 'AI answers recorded by measurement runs, including their verbatim output.',
    measuredFrom: 'Observation.createdAt',
    allowedActions: ['delete', 'anonymize'],
    restriction: null,
    defaultRetainDays: 730,
    defaultAction: 'delete',
  },
  {
    resourceType: 'reports',
    label: 'Reports',
    covers: 'Report rows. Released revisions are separate frozen rows and are covered by the report.',
    measuredFrom: 'Report.createdAt',
    allowedActions: ['archive', 'delete'],
    restriction:
      'Anonymize is not offered: a report carries no personal fields, so there would be nothing to anonymize and offering the action would imply otherwise.',
    defaultRetainDays: null,
    defaultAction: 'archive',
  },
  {
    resourceType: 'messages',
    label: 'Client messages',
    covers: 'Client-portal message bodies, internal and client-visible alike.',
    measuredFrom: 'ClientMessage.createdAt',
    allowedActions: ['delete', 'anonymize'],
    restriction: null,
    defaultRetainDays: 1095,
    defaultAction: 'delete',
  },
  {
    resourceType: 'job-runs',
    label: 'Background job ledger',
    covers: 'Durable run and step records, including their cost and coverage figures.',
    measuredFrom: 'JobRun.createdAt',
    allowedActions: ['delete'],
    restriction: 'Archive and anonymize are not offered: the ledger has no archive state and no personal fields.',
    defaultRetainDays: 365,
    defaultAction: 'delete',
  },
  {
    resourceType: 'activity',
    label: 'Audit trail',
    covers: 'Append-only activity events recording who did what, when and to which resource.',
    measuredFrom: 'ActivityEvent.createdAt',
    allowedActions: ['anonymize'],
    restriction:
      'Delete is not permitted. design_plan G17: audit history is retained under policy even when the resource it describes is deleted. ' +
      'Anonymize clears the actor, the address, the summary and the before/after detail while leaving the event itself in place, so the shape of what happened survives.',
    defaultRetainDays: null,
    defaultAction: 'anonymize',
  },
  {
    resourceType: 'attachments',
    label: 'Attachments',
    covers: 'Uploaded file metadata. Files are marked deleted rather than removed from the table, so the deletion is auditable.',
    measuredFrom: 'Attachment.createdAt',
    allowedActions: ['delete'],
    restriction: 'Anonymize and archive are not offered: an attachment is either reachable or marked deleted.',
    defaultRetainDays: 365,
    defaultAction: 'delete',
  },
];

/** A policy as returned to a caller, with its definition attached. */
export interface RetentionPolicyView {
  resourceType: RetentionResourceType;
  label: string;
  covers: string;
  measuredFrom: string;
  allowedActions: readonly RetentionAction[];
  restriction: string | null;
  /** True when a `RetentionPolicy` row exists. False means the defaults below are documented, not stored. */
  configured: boolean;
  retainDays: number | null;
  action: RetentionAction;
  enabled: boolean;
  lastRunAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** The instant the window is measured back from. Always "now", so it is stated rather than assumed. */
  cutoff: string | null;
  /** The sentence a surface can render without re-deriving the window. */
  statement: string;
}

/** The outcome of a retention run. */
export interface RetentionRunResult extends RetentionCounts {
  /** Rows the action actually touched, re-counted after the fact. */
  applied: number;
  ranAt: string;
  reason: string | null;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Every policy, configured or not.
   *
   * A resource type with no row is reported with its documented default and
   * `configured: false` — the difference between "we decided this" and "this is
   * what would happen if we did" is exactly the kind of thing a retention
   * screen must not blur.
   */
  async list(): Promise<RetentionPolicyView[]> {
    const rows = await this.prisma.retentionPolicy.findMany();
    const byType = new Map(rows.map((row) => [row.resourceType, row]));
    return RETENTION_DEFINITIONS.map((definition) => this.toView(definition, byType.get(definition.resourceType) ?? null));
  }

  /** One policy. */
  async get(resourceType: string): Promise<RetentionPolicyView> {
    const definition = this.definitionFor(resourceType);
    const row = await this.prisma.retentionPolicy.findUnique({ where: { resourceType: definition.resourceType } });
    return this.toView(definition, row);
  }

  /**
   * Create or replace a policy.
   *
   * The action is validated against the resource type's `allowedActions`
   * before anything is written, so an impossible policy (deleting the audit
   * trail) is refused at the point somebody tries to set it rather than at the
   * point it runs.
   */
  async update(resourceType: string, dto: UpdateRetentionPolicyDto, actor: { userId: string; label: string | null }): Promise<RetentionPolicyView> {
    const definition = this.definitionFor(resourceType);
    const existing = await this.prisma.retentionPolicy.findUnique({ where: { resourceType: definition.resourceType } });

    const action = (dto.action ?? existing?.action ?? definition.defaultAction) as RetentionAction;
    this.assertActionAllowed(definition, action);

    const retainDays = dto.retainDays !== undefined ? dto.retainDays : existing?.retainDays ?? definition.defaultRetainDays;
    const enabled = dto.enabled !== undefined ? dto.enabled : existing?.enabled ?? false;

    if (enabled && retainDays === null) {
      throw new BadRequestException(
        `A ${definition.resourceType} policy cannot be enabled with no retention window: it would mean "act on everything", ` +
          'which is not what an empty window means. Set retainDays first.',
      );
    }

    const row = await this.prisma.retentionPolicy.upsert({
      where: { resourceType: definition.resourceType },
      create: {
        resourceType: definition.resourceType,
        retainDays,
        action,
        enabled,
        updatedBy: actor.userId,
      },
      update: { retainDays, action, enabled, updatedBy: actor.userId },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId, label: actor.label },
      action: 'updated',
      resource: { type: 'retention-policy', id: row.id, version: null },
      summary: `Retention policy for ${definition.resourceType}: ${action}, ${retainDays === null ? 'no window' : `${retainDays} days`}, ${enabled ? 'enabled' : 'disabled'}`,
      changes: { before: existing ? { retainDays: existing.retainDays, action: existing.action, enabled: existing.enabled } : null, after: { retainDays, action, enabled } },
      clientVisible: false,
    });

    return this.toView(definition, row);
  }

  /**
   * Count what a run would affect, without affecting it.
   *
   * A preview is always safe to call and never requires the policy to be
   * enabled — knowing what a policy *would* do is exactly what an admin needs
   * before deciding to turn it on.
   */
  async preview(resourceType: string): Promise<RetentionCounts> {
    const definition = this.definitionFor(resourceType);
    const row = await this.prisma.retentionPolicy.findUnique({ where: { resourceType: definition.resourceType } });
    const action = (row?.action ?? definition.defaultAction) as RetentionAction;
    const retainDays = row?.retainDays ?? definition.defaultRetainDays;
    const enabled = row?.enabled ?? false;

    this.assertActionAllowed(definition, action);
    return this.counts(definition, action, retainDays, enabled);
  }

  /**
   * Run a policy.
   *
   * Refuses when the policy is disabled, when `confirm` is not literally true,
   * or when the resource type's action is not permitted. The counts are
   * recomputed here rather than taken from an earlier preview, so the number
   * reported as acted on is the number that was actually acted on.
   */
  async apply(resourceType: string, dto: ApplyRetentionDto, actor: { userId: string; label: string | null }): Promise<RetentionRunResult> {
    const definition = this.definitionFor(resourceType);
    const row = await this.prisma.retentionPolicy.findUnique({ where: { resourceType: definition.resourceType } });
    if (!row) {
      throw new NotFoundException(`No retention policy is configured for ${definition.resourceType}. Configure it before running it.`);
    }
    if (!row.enabled) {
      throw new ConflictException(
        `The ${definition.resourceType} retention policy is disabled, and a disabled policy never acts. Enable it deliberately, or leave the rows alone.`,
      );
    }
    if (dto.confirm !== true) {
      throw new BadRequestException('A retention run is destructive; pass `confirm: true` to proceed.');
    }

    const action = row.action as RetentionAction;
    this.assertActionAllowed(definition, action);
    if (row.retainDays === null) {
      throw new ConflictException(`The ${definition.resourceType} policy has no retention window, so there is nothing to measure "old rows" against.`);
    }

    const before = await this.counts(definition, action, row.retainDays, row.enabled);
    const cutoff = new Date(Date.now() - row.retainDays * 86_400_000);
    const where = { createdAt: { lt: cutoff } };

    let applied = 0;
    switch (definition.resourceType) {
      case 'observations':
        applied =
          action === 'delete'
            ? (await this.prisma.observation.deleteMany({ where })).count
            : (await this.prisma.observation.updateMany({ where, data: { rawAnswer: '[redacted by retention policy]' } })).count;
        break;

      case 'reports':
        applied =
          action === 'delete'
            ? (await this.prisma.report.deleteMany({ where })).count
            : (await this.prisma.report.updateMany({ where, data: { status: 'withdrawn' } })).count;
        break;

      case 'messages':
        applied =
          action === 'delete'
            ? (await this.prisma.clientMessage.deleteMany({ where })).count
            : (await this.prisma.clientMessage.updateMany({ where, data: { body: '[redacted by retention policy]' } })).count;
        break;

      case 'job-runs':
        // The step rows are bound by FK, so removing runs would strand them;
        // the ledger is deleted as a unit, children first.
        if (action === 'delete') {
          const stale = await this.prisma.jobRun.findMany({ where, select: { id: true }, take: 5000 });
          const ids = stale.map((run) => run.id);
          if (ids.length > 0) {
            await this.prisma.jobStep.deleteMany({ where: { jobRunId: { in: ids } } });
            applied = (await this.prisma.jobRun.deleteMany({ where: { id: { in: ids } } })).count;
          }
        }
        break;

      case 'activity':
        // Only anonymize is permitted for the audit trail — see the definition.
        applied = (
          await this.prisma.activityEvent.updateMany({
            where,
            data: { actorId: null, actorLabel: null, ipAddress: null, summary: null, changes: '{}' },
          })
        ).count;
        break;

      case 'attachments':
        applied = (
          await this.prisma.attachment.updateMany({
            where: { createdAt: { lt: cutoff }, deletedAt: null },
            data: { deletedAt: new Date() },
          })
        ).count;
        break;

      default: {
        const exhaustive: never = definition.resourceType;
        throw new BadRequestException(`Unhandled retention resource type: ${String(exhaustive)}`);
      }
    }

    const ranAt = new Date();
    await this.prisma.retentionPolicy.update({ where: { id: row.id }, data: { lastRunAt: ranAt, updatedBy: actor.userId } });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId, label: actor.label },
      action: 'deleted',
      resource: { type: 'retention-policy', id: row.id, version: null },
      summary: `Retention run on ${definition.resourceType}: ${action}, ${applied} row(s) affected of ${before.eligible} eligible`,
      changes: { action, retainDays: row.retainDays, cutoff: cutoff.toISOString(), eligible: before.eligible, applied, reason: dto.reason ?? null },
      clientVisible: false,
      result: applied === before.eligible || before.eligible === 0 ? 'success' : 'failure',
    });

    this.logger.log(`Retention ${definition.resourceType}: ${action} applied to ${applied} of ${before.eligible} eligible rows`);

    return { ...before, applied, ranAt: ranAt.toISOString(), reason: dto.reason ?? null };
  }

  // ── Privates ──────────────────────────────────────────────────────

  private definitionFor(resourceType: string): RetentionResourceDefinition {
    const definition = RETENTION_DEFINITIONS.find((entry) => entry.resourceType === resourceType);
    if (!definition) {
      throw new BadRequestException(
        `Unknown retention resource type "${resourceType}". Known types: ${RETENTION_RESOURCE_TYPES.join(', ')}.`,
      );
    }
    return definition;
  }

  private assertActionAllowed(definition: RetentionResourceDefinition, action: RetentionAction): void {
    if (!RETENTION_ACTIONS.includes(action)) {
      throw new BadRequestException(`Unknown retention action "${action}". Known actions: ${RETENTION_ACTIONS.join(', ')}.`);
    }
    if (!definition.allowedActions.includes(action)) {
      throw new BadRequestException(
        `The ${definition.resourceType} policy does not permit "${action}". ` + (definition.restriction ?? `Permitted: ${definition.allowedActions.join(', ')}.`),
      );
    }
  }

  private async counts(
    definition: RetentionResourceDefinition,
    action: RetentionAction,
    retainDays: number | null,
    enabled: boolean,
  ): Promise<RetentionCounts> {
    const measuredFrom = new Date().toISOString();
    if (retainDays === null) {
      return {
        resourceType: definition.resourceType,
        action,
        retainDays,
        enabled,
        eligible: 0,
        affected: 0,
        measuredFrom,
        cutoff: null,
        note: `${definition.label} has no retention window, so no row is eligible. That is reported as 0 eligible rather than as "everything", because an unset window is not an unlimited one.`,
      };
    }

    const cutoff = new Date(Date.now() - retainDays * 86_400_000);
    const where = { createdAt: { lt: cutoff } };

    let eligible: number;
    switch (definition.resourceType) {
      case 'observations':
        eligible = await this.prisma.observation.count({ where });
        break;
      case 'reports':
        eligible = await this.prisma.report.count({ where });
        break;
      case 'messages':
        eligible = await this.prisma.clientMessage.count({ where });
        break;
      case 'job-runs':
        eligible = await this.prisma.jobRun.count({ where });
        break;
      case 'activity':
        eligible = await this.prisma.activityEvent.count({ where });
        break;
      case 'attachments':
        eligible = await this.prisma.attachment.count({ where: { createdAt: { lt: cutoff }, deletedAt: null } });
        break;
      default: {
        const exhaustive: never = definition.resourceType;
        throw new BadRequestException(`Unhandled retention resource type: ${String(exhaustive)}`);
      }
    }

    return {
      resourceType: definition.resourceType,
      action,
      retainDays,
      enabled,
      eligible,
      // Every offered action applies to every eligible row; there is no action
      // that can only reach some of them, so the two counts differ only in
      // meaning, not in value.
      affected: eligible,
      measuredFrom,
      cutoff: cutoff.toISOString(),
      note: enabled
        ? `${eligible} ${definition.label.toLowerCase()} row(s) were created before ${cutoff.toISOString()} and would be acted on by "${action}".`
        : `${eligible} ${definition.label.toLowerCase()} row(s) are past the ${retainDays}-day window, but the policy is disabled so nothing will happen. Enable it deliberately to act.`,
    };
  }

  private toView(
    definition: RetentionResourceDefinition,
    row: { resourceType: string; retainDays: number | null; action: string; enabled: boolean; lastRunAt: Date | null; updatedBy: string | null; updatedAt: Date } | null,
  ): RetentionPolicyView {
    const action = (row?.action ?? definition.defaultAction) as RetentionAction;
    const retainDays = row?.retainDays ?? definition.defaultRetainDays;
    const enabled = row?.enabled ?? false;
    const cutoff = retainDays === null ? null : new Date(Date.now() - retainDays * 86_400_000).toISOString();

    const statement = !enabled
      ? `${definition.label} are kept indefinitely: no policy is enabled.${row ? '' : ' No policy row exists yet — the defaults below are what would apply if one were created.'}`
      : retainDays === null
        ? `${definition.label} have an enabled policy with no window, which matches nothing.`
        : `${definition.label} older than ${retainDays} days (created before ${cutoff}) are ${action}. Last run: ${row?.lastRunAt ? row.lastRunAt.toISOString() : 'never'}.`;

    return {
      resourceType: definition.resourceType,
      label: definition.label,
      covers: definition.covers,
      measuredFrom: definition.measuredFrom,
      allowedActions: definition.allowedActions,
      restriction: definition.restriction,
      configured: row !== null,
      retainDays,
      action,
      enabled,
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      cutoff,
      statement,
    };
  }
}
