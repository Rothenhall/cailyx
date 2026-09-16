/**
 * ActivityService — G15 append-only activity, provenance and audit trail.
 *
 * `record()` is the one call other G01-G20 packages should use to write an
 * audit event. It is exported from ActivityModule for injection:
 *
 * ```ts
 * constructor(private readonly activity: ActivityService) {}
 *
 * await this.activity.record({
 *   actor: { type: 'user', id: user.userId, label: user.email },
 *   action: 'approved',
 *   resource: { type: 'content-revision', id: revisionId, version: '3' },
 *   clientId, projectId,
 *   summary: 'Approved content revision for publication',
 *   changes: { status: { before: 'pending', after: 'approved' } },
 *   result: 'success',
 *   requestId, jobRunId,
 *   origin: 'api',
 *   clientVisible: false,
 * });
 * ```
 *
 * `summary` and `changes` are ALWAYS passed through the redaction helper
 * before being persisted — callers cannot bypass it. Application code never
 * updates or deletes a row afterward; there is deliberately no
 * `update`/`delete` method on this service. A resource's own deletion is
 * itself recorded via `action: 'deleted'`, which leaves the audit row in
 * place even though the resource it describes is gone.
 *
 * @module activity.service
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { redactChanges, redactSummary } from './redaction.util';
import type { ActivityAction, ActivityEventDto, ActivityOrigin, ActivityResult, ActorType } from './activity.types';

export interface RecordActivityInput {
  actor: {
    type: ActorType;
    /** User.id for actorType "user"; a stable identifier (job kind, webhook source) otherwise. */
    id?: string | null;
    /** Human label at write time — e.g. the user's name/email, or "nightly cadence runner". Redacted like any other field. */
    label?: string | null;
  };
  action: ActivityAction;
  resource: {
    type: string;
    id?: string | null;
    version?: string | null;
  };
  clientId?: string | null;
  projectId?: string | null;
  /** Short human summary. Redacted/truncated before storage — never pass a raw message body or AI answer here. */
  summary?: string | null;
  /** Redacted before/after applied automatically — pass the real (unredacted) values, this method scrubs them. */
  changes?: Record<string, unknown>;
  result?: ActivityResult;
  requestId?: string | null;
  jobRunId?: string | null;
  origin?: ActivityOrigin;
  ipAddress?: string | null;
  /** Whether a client-portal caller may see this event. Defaults false — opt in explicitly. */
  clientVisible?: boolean;
}

/**
 * One audit event as a client may see it.
 *
 * Deliberately a separate type rather than `Omit<ActivityEventDto, …>`: an
 * omission list is easy to get wrong as the source type grows, whereas a shape
 * that only names what is allowed cannot start leaking a field somebody adds
 * later.
 */
export interface ClientVisibleActivityEventDto {
  id: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  summary: string | null;
  result: string;
  createdAt: string;
}

@Injectable()
export class ActivityService {
  constructor(protected readonly prisma: PrismaService) {}

  /** Write one append-only audit event. See the class doc for the call shape. */
  async record(input: RecordActivityInput): Promise<ActivityEventDto> {
    const changes = redactChanges(input.changes);
    const summary = redactSummary(input.summary);
    // The actor label is free text an upstream caller may have sourced from
    // a display name field — route it through the same redaction as
    // `summary` rather than trusting it.
    const actorLabel = redactSummary(input.actor.label ?? null);

    const row = await this.prisma.activityEvent.create({
      data: {
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        actorLabel,
        action: input.action,
        resourceType: input.resource.type,
        resourceId: input.resource.id ?? null,
        resourceVersion: input.resource.version ?? null,
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
        summary,
        changes: JSON.stringify(changes),
        result: input.result ?? 'success',
        requestId: input.requestId ?? null,
        jobRunId: input.jobRunId ?? null,
        origin: input.origin ?? 'api',
        ipAddress: input.ipAddress ?? null,
        clientVisible: input.clientVisible ?? false,
      },
    });
    return this.toDto(row);
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  /** Operator-scoped read — sees every event, clientVisible or not. */
  async list(filters: {
    resourceType?: string;
    resourceId?: string;
    action?: string;
    clientId?: string;
    projectId?: string;
    actorId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ events: ActivityEventDto[]; nextCursor: string | null }> {
    return this.query(filters, /* clientVisibleOnly */ false);
  }

  /** Client-scoped read — always clientId-scoped AND clientVisible-gated, regardless of what the caller passes. */
  /**
   * The client's own view of their audit trail.
   *
   * `actorId` and `actorLabel` are **stripped**. `clientVisible` gates *which*
   * events a client may see, but it does not gate the operator identity that
   * wrote them — and an internal user id or staff member's name on a client
   * surface is an information leak with no purpose (the client cannot resolve
   * either). The client sees that an action happened, what it was, and when;
   * never who in the agency performed it.
   *
   * The actor TYPE is kept, because "the system did this on a schedule" reads
   * very differently from "a person did this", and that distinction is not
   * sensitive.
   */
  async listForClient(
    clientId: string,
    filters: { resourceType?: string; projectId?: string; limit?: number; cursor?: string },
  ): Promise<{ events: ClientVisibleActivityEventDto[]; nextCursor: string | null }> {
    const { events, nextCursor } = await this.query({ ...filters, clientId }, true);
    return {
      events: events.map((event) => ({
        id: event.id,
        actorType: event.actorType,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        projectId: event.projectId,
        summary: event.summary,
        result: event.result,
        createdAt: event.createdAt,
      })),
      nextCursor,
    };
  }

  /** Operator-scoped read for one project (still full visibility — a project scope, not a client gate). */
  /**
   * The client-facing event shape. Note what is absent: `actorId`,
   * `actorLabel`, `changes`, `requestId`, `jobRunId`, `origin` and the IP are
   * all operator-side detail. See `listForClient` for why.
   */
  async listForProject(
    projectId: string,
    filters: { resourceType?: string; limit?: number; cursor?: string },
  ): Promise<{ events: ActivityEventDto[]; nextCursor: string | null }> {
    return this.query({ ...filters, projectId }, /* clientVisibleOnly */ false);
  }

  /** Same filter surface as `list`, unpaginated up to a hard cap, for CSV/JSON export. */
  async export(filters: {
    resourceType?: string;
    clientId?: string;
    projectId?: string;
    action?: string;
  }): Promise<{ events: ActivityEventDto[] }> {
    const EXPORT_CAP = 5000;
    const rows = await this.prisma.activityEvent.findMany({
      where: this.whereFrom(filters),
      orderBy: { createdAt: 'desc' },
      take: EXPORT_CAP,
    });
    return { events: rows.map((r) => this.toDto(r)) };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async query(
    filters: {
      resourceType?: string;
      resourceId?: string;
      action?: string;
      clientId?: string;
      projectId?: string;
      actorId?: string;
      limit?: number;
      cursor?: string;
    },
    clientVisibleOnly: boolean,
  ): Promise<{ events: ActivityEventDto[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const cursorRow = filters.cursor
      ? await this.prisma.activityEvent.findUnique({ where: { id: filters.cursor }, select: { createdAt: true } })
      : null;

    const where = {
      ...this.whereFrom(filters),
      ...(clientVisibleOnly ? { clientVisible: true } : {}),
      ...(cursorRow ? { createdAt: { lt: cursorRow.createdAt } } : {}),
    };

    const rows = await this.prisma.activityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1]?.id ?? null : null;
    return { events: page.map((r) => this.toDto(r)), nextCursor };
  }

  private whereFrom(filters: {
    resourceType?: string;
    resourceId?: string;
    action?: string;
    clientId?: string;
    projectId?: string;
    actorId?: string;
  }) {
    return {
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
    };
  }

  private toDto(row: {
    id: string;
    actorType: string;
    actorId: string | null;
    actorLabel: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    resourceVersion: string | null;
    clientId: string | null;
    projectId: string | null;
    summary: string | null;
    changes: string;
    result: string;
    requestId: string | null;
    jobRunId: string | null;
    origin: string;
    clientVisible: boolean;
    createdAt: Date;
  }): ActivityEventDto {
    let changes: Record<string, unknown> = {};
    try {
      changes = JSON.parse(row.changes) as Record<string, unknown>;
    } catch {
      changes = {};
    }
    return {
      id: row.id,
      actorType: row.actorType as ActorType,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      action: row.action as ActivityAction,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      resourceVersion: row.resourceVersion,
      clientId: row.clientId,
      projectId: row.projectId,
      summary: row.summary,
      changes,
      result: row.result as ActivityResult,
      requestId: row.requestId,
      jobRunId: row.jobRunId,
      origin: row.origin as ActivityOrigin,
      clientVisible: row.clientVisible,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
