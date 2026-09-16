/**
 * LifecycleService — G17's exports.
 *
 * An export is assembled from stored rows, written to a scoped file, and given
 * a lifetime. Three properties are the whole contract:
 *
 * - **Scoped.** The export's `scopeType`/`scopeId` are fixed at creation and
 *   every read (`status`, `download`) re-resolves them against the URL. An
 *   export id from another client's scope 404s rather than resolving, and the
 *   storage key is derived from the export's own id, so one client's download
 *   cannot address another's file.
 * - **Expiring.** `expiresAt` is enforced on download, and a request after it
 *   flips the row to `expired` and returns 410 — the export is not a permalink.
 *   `downloadedAt` is stamped on every successful download.
 * - **Disclosing.** `omittedNote` names every field deliberately left out and
 *   why. Nothing sensitive is dropped silently, and nothing sensitive is
 *   included silently either: `leads` (Cailyx's own sales pipeline, with
 *   personal contact data) and `activity` (the audit trail) are not in the
 *   default bundle.
 *
 * The export does **not** recompute results. It carries the stored rows, so the
 * numbers it contains are the numbers that were recorded — a live
 * `/results` read is a different thing and says so on its own response.
 *
 * @module lifecycle.service
 */

import { BadRequestException, ConflictException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ExportStorageService } from './export-storage.service';
import type { ExportFormat, ExportSection, ExportSectionReport, ExportScopeType, ExportStatus } from './lifecycle.types';
import {
  DEFAULT_EXPORT_SECTIONS,
  DEFAULT_EXPORT_TTL_HOURS,
  EXPORT_SECTION_ROW_LIMIT,
  EXPORT_SECTIONS,
} from './lifecycle.types';
import type { CreateExportDto } from './dto/export.dto';

/** Who asked, for the row and the audit trail. */
export interface ExportActor {
  userId: string;
  label: string | null;
}

/** The `ExportRequest` columns this service reads. */
export interface ExportRow {
  id: string;
  scopeType: string;
  scopeId: string;
  requestedBy: string;
  format: string;
  sections: string;
  status: string;
  storageKey: string | null;
  sizeBytes: number | null;
  expiresAt: Date | null;
  downloadedAt: Date | null;
  omittedNote: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An `ExportRequest` as returned to a caller.
 *
 * Deliberately not the row: `storageKey` is an internal locator on this host
 * and is never published. What a caller needs is whether the download is
 * available and when it stops being so, which is computed here rather than left
 * for a surface to infer from `status` and `expiresAt`.
 */
export interface ExportRequestView {
  id: string;
  scopeType: ExportScopeType;
  scopeId: string;
  requestedBy: string;
  format: ExportFormat;
  sections: ExportSection[];
  status: ExportStatus;
  sizeBytes: number | null;
  expiresAt: string | null;
  downloadedAt: string | null;
  omittedNote: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** True once `expiresAt` has passed, whether or not the row has been reaped yet. */
  expired: boolean;
  /** True only while a download would actually succeed. */
  downloadAvailable: boolean;
}

/** What a download returns. */
export interface ExportDownload {
  exportRequestId: string;
  scopeType: ExportScopeType;
  scopeId: string;
  format: ExportFormat;
  filename: string;
  contentType: string;
  content: string;
  sizeBytes: number | null;
  downloadedAt: string;
  expiresAt: string | null;
  /** Everything deliberately left out of this bundle. Repeated so a reader sees it at the point of use. */
  omittedNote: string;
}

/** The assembled bundle, before it is written to storage. */
interface AssembledExport {
  payload: unknown;
  /** `<section>.csv` when the format is csv; the JSON bundle otherwise. */
  text: string;
  sectionReports: ExportSectionReport[];
  omitted: string[];
}

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ExportStorageService,
    private readonly activity: ActivityService,
  ) {}

  // ── Requests ────────────────────────────────────────────────────────

  /** Create and assemble a project-scoped export. */
  async createForProject(projectId: string, dto: CreateExportDto, actor: ExportActor): Promise<ExportRequestView> {
    return this.create('project', projectId, dto, actor);
  }

  /** Create and assemble a client-scoped export (every project the client owns, plus client-level rows). */
  async createForClient(clientId: string, dto: CreateExportDto, actor: ExportActor): Promise<ExportRequestView> {
    return this.create('client', clientId, dto, actor);
  }

  /**
   * The request itself.
   *
   * The row is created first (`queued`) so a failure during assembly leaves a
   * durable record of the attempt rather than nothing at all — an export that
   * disappears on error is an export nobody can debug.
   */
  private async create(
    scopeType: ExportScopeType,
    scopeId: string,
    dto: CreateExportDto,
    actor: ExportActor,
  ): Promise<ExportRequestView> {
    const format = (dto.format ?? 'json') as ExportFormat;
    const sections = this.resolveSections(dto.sections, format);
    const ttlHours = dto.ttlHours ?? DEFAULT_EXPORT_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    const row = await this.prisma.exportRequest.create({
      data: {
        scopeType,
        scopeId,
        requestedBy: actor.userId,
        format,
        sections: JSON.stringify(sections),
        status: 'queued',
        expiresAt,
      },
    });

    await this.prisma.exportRequest.update({ where: { id: row.id }, data: { status: 'running' } });

    try {
      const assembled = await this.assemble(scopeType, scopeId, sections, format, expiresAt);
      const { storageKey, sizeBytes } = await this.storage.write(row.id, assembled.text);

      const ready = await this.prisma.exportRequest.update({
        where: { id: row.id },
        data: {
          status: 'ready',
          storageKey,
          sizeBytes,
          omittedNote: assembled.omitted.join(' '),
        },
      });

      await this.activity.record({
        actor: { type: 'user', id: actor.userId, label: actor.label },
        action: 'created',
        resource: { type: 'export-request', id: row.id, version: null },
        clientId: scopeType === 'client' ? scopeId : await this.clientIdOfScope(scopeType, scopeId),
        projectId: scopeType === 'project' ? scopeId : null,
        summary: `Requested a ${format} export (${sections.join(', ')})`,
        changes: { sections, format, ttlHours, sizeBytes, omit: assembled.omitted },
        clientVisible: false,
      });

      // The view, not the row: `storageKey` is a locator on this host and is
      // never published to a caller.
      return this.toView(ready);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Export ${row.id} failed: ${message}`);
      const failed = await this.prisma.exportRequest.update({
        where: { id: row.id },
        data: { status: 'failed', error: message.slice(0, 1000) },
      });
      return this.toView(failed);
    }
  }

  /** A scope's exports, newest first. */
  async list(scopeType: ExportScopeType, scopeId: string): Promise<ExportRequestView[]> {
    const rows = await this.prisma.exportRequest.findMany({
      where: { scopeType, scopeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => this.toView(row));
  }

  /** One export, without its storage key. */
  async get(scopeType: ExportScopeType, scopeId: string, id: string): Promise<ExportRequestView> {
    return this.toView(await this.loadRow(scopeType, scopeId, id));
  }

  /**
   * Resolve a row inside its scope. A mismatched scope is a 404, not a 403: a
   * caller must not learn that an id exists somewhere they cannot see it.
   */
  private async loadRow(scopeType: ExportScopeType, scopeId: string, id: string): Promise<ExportRow> {
    const row = await this.prisma.exportRequest.findFirst({ where: { id, scopeType, scopeId } });
    if (!row) throw new NotFoundException(`Export ${id} not found for this ${scopeType}`);
    return row;
  }

  /**
   * Download an export.
   *
   * Enforces three things in order: the scope (above), the status (`ready`
   * only — a queued or failed export has no file), and `expiresAt`. A request
   * past the expiry flips the row to `expired`, removes the payload, and
   * throws 410 — the download link is not a permalink, and the response says
   * so rather than serving stale bytes.
   */
  async download(scopeType: ExportScopeType, scopeId: string, id: string): Promise<ExportDownload> {
    const row = await this.loadRow(scopeType, scopeId, id);

    if (row.status === 'expired') {
      throw new GoneException(
        `Export ${id} expired${row.expiresAt ? ` on ${row.expiresAt.toISOString()}` : ''}. Request a new export; a download link is scoped and expiring by design.`,
      );
    }
    if (row.status !== 'ready') {
      throw new ConflictException(
        `Export ${id} is ${row.status}${row.error ? `: ${row.error}` : ''}. Only a ready export can be downloaded.`,
      );
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await this.expire(row);
      throw new GoneException(
        `Export ${id} expired on ${row.expiresAt.toISOString()} and its payload has been removed. Request a new export.`,
      );
    }
    if (!row.storageKey) {
      throw new ConflictException(`Export ${id} is marked ready but has no storage key — this is a data defect, not a client error.`);
    }
    if (!(await this.storage.exists(row.storageKey))) {
      // The host's temp directory was cleared, or another instance served the
      // write. Say that, rather than returning an empty body.
      throw new GoneException(
        `Export ${id}'s payload is no longer present on this host (${this.storage.directory()}). The export row is intact; request a new export.`,
      );
    }

    const content = await this.storage.read(row.storageKey);
    const downloadedAt = new Date();
    await this.prisma.exportRequest.update({ where: { id: row.id }, data: { downloadedAt } });

    const format = row.format as ExportFormat;
    const sections = this.parseSections(row.sections);

    return {
      exportRequestId: row.id,
      scopeType,
      scopeId,
      format,
      filename: this.filenameFor(row, sections, format),
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      content,
      sizeBytes: row.sizeBytes,
      downloadedAt: downloadedAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      omittedNote: row.omittedNote ?? '',
    };
  }

  /** Mark expired and drop the payload. Safe to call repeatedly. */
  private async expire(row: ExportRow): Promise<void> {
    await this.prisma.exportRequest.update({ where: { id: row.id }, data: { status: 'expired' } });
    if (row.storageKey) await this.storage.remove(row.storageKey);
  }

  /**
   * Strip the host-local fields and compute the two facts a surface needs.
   *
   * `expired` is computed rather than read off `status`, so a link whose
   * lifetime has passed reads as expired even before any request has flipped
   * the column — the answer to "will this download work" must not depend on
   * whether somebody happened to try it first.
   */
  private toView(row: ExportRow): ExportRequestView {
    const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
    const status = (expired && row.status === 'ready' ? 'expired' : row.status) as ExportStatus;

    return {
      id: row.id,
      scopeType: row.scopeType as ExportScopeType,
      scopeId: row.scopeId,
      requestedBy: row.requestedBy,
      format: row.format as ExportFormat,
      sections: this.parseSections(row.sections),
      status,
      sizeBytes: row.sizeBytes,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      downloadedAt: row.downloadedAt ? row.downloadedAt.toISOString() : null,
      omittedNote: row.omittedNote,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expired,
      downloadAvailable: row.status === 'ready' && !expired,
    };
  }

  // ── Assembly ────────────────────────────────────────────────────────

  /**
   * Resolve the requested sections against the format.
   *
   * `csv` requires exactly one section: a bundle has no CSV representation, and
   * a file that claims to be CSV while holding nested JSON would be a worse lie
   * than a 400.
   */
  private resolveSections(requested: string[] | undefined, format: ExportFormat): ExportSection[] {
    const sections = (requested && requested.length > 0 ? requested : [...DEFAULT_EXPORT_SECTIONS]) as ExportSection[];
    const unknown = sections.filter((section) => !EXPORT_SECTIONS.includes(section));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown export section(s): ${unknown.join(', ')}. Known sections: ${EXPORT_SECTIONS.join(', ')}.`);
    }
    if (format === 'csv' && sections.length !== 1) {
      throw new BadRequestException(
        `A csv export covers exactly one section, but ${sections.length} were requested. ` +
          'Request a single section for csv, or use json for a bundle.',
      );
    }
    return sections;
  }

  private parseSections(raw: string): ExportSection[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is ExportSection => typeof entry === 'string' && EXPORT_SECTIONS.includes(entry as ExportSection));
    } catch {
      return [];
    }
  }

  /**
   * Read every requested section.
   *
   * Each section is capped at {@link EXPORT_SECTION_ROW_LIMIT} rows and reports
   * whether it was truncated, so a bundle cannot silently become a partial
   * one — the `sectionReports` block is the honest accounting.
   */
  private async assemble(
    scopeType: ExportScopeType,
    scopeId: string,
    sections: ExportSection[],
    format: ExportFormat,
    expiresAt: Date,
  ): Promise<AssembledExport> {
    const projectIds = await this.projectIdsIn(scopeType, scopeId);
    const clientId = scopeType === 'client' ? scopeId : await this.clientIdOfScope(scopeType, scopeId);

    const sectionReports: ExportSectionReport[] = [];
    const omitted = new Set<string>();
    const data: Record<string, unknown> = {};

    const add = (section: ExportSection, rows: unknown[], sectionOmissions: string[] = []): void => {
      const truncated = rows.length > EXPORT_SECTION_ROW_LIMIT;
      data[section] = truncated ? rows.slice(0, EXPORT_SECTION_ROW_LIMIT) : rows;
      for (const entry of sectionOmissions) omitted.add(entry);
      sectionReports.push({ section, rows: Math.min(rows.length, EXPORT_SECTION_ROW_LIMIT), truncated, omitted: sectionOmissions });
    };

    for (const section of sections) {
      switch (section) {
        case 'project':
          add(section, await this.projectsSection(projectIds), [
            'Project internal notes are omitted: they are operator commentary, not client data.',
          ]);
          break;

        case 'reports':
          add(section, await this.reportsSection(projectIds), [
            'Report snapshot JSON blobs (findings, roadmap, growth plan, backlinks, presence, competitors) are omitted: they are derived payloads whose sources are exported in their own sections.',
          ]);
          break;

        case 'metrics':
          add(section, await this.metricsSection(projectIds), [
            'Metrics are the stored measurement and score rows, not a recomputed summary. An export must not serve a live number where a recorded one exists.',
          ]);
          break;

        case 'observations':
          add(section, await this.observationsSection(projectIds), [
            'Verbatim model answers (rawAnswer) are omitted: they are model output rather than client data and may quote third parties.',
          ]);
          break;

        case 'audits':
          add(section, await this.auditsSection(projectIds), []);
          break;

        case 'work':
          add(section, await this.workSection(projectIds), [
            'Work-item internal notes are omitted: they are a separate server-side channel, never a UI toggle on a client-visible field.',
          ]);
          break;

        case 'query-sets':
          add(section, await this.querySetsSection(projectIds), []);
          break;

        case 'personas':
          add(section, await this.personasSection(projectIds), []);
          break;

        case 'content':
          add(section, await this.contentSection(projectIds), []);
          break;

        case 'competitors':
          add(section, await this.competitorsSection(projectIds), []);
          break;

        case 'presence':
          add(section, await this.presenceSection(projectIds), []);
          break;

        case 'authority':
          add(section, await this.authoritySection(projectIds), []);
          break;

        case 'backlinks':
          add(section, await this.backlinksSection(projectIds), []);
          break;

        case 'messages':
          add(section, await this.messagesSection(clientId, projectIds), [
            'Internal message rows are omitted entirely: they are a separate server-side channel and are never exported.',
          ]);
          break;

        case 'activity':
          add(section, await this.activitySection(clientId, projectIds), [
            'Only activity events flagged clientVisible are exported. Operator-only events, actor ids and IP addresses are omitted.',
          ]);
          break;

        case 'attachments':
          add(section, await this.attachmentsSection(projectIds), [
            'Attachment storage keys and file contents are omitted: the export carries the metadata that identifies a file, not the file.',
          ]);
          break;

        case 'leads':
          add(section, await this.leadsSection(projectIds), [
            "Leads are Cailyx's own inbound sales pipeline (PRD 6.11), not client revenue or client contacts. They are included only because this section was requested explicitly, and they carry personal contact data (name, email).",
          ]);
          break;

        default: {
          const exhaustive: never = section;
          throw new BadRequestException(`Unhandled export section: ${String(exhaustive)}`);
        }
      }
    }

    omitted.add(
      'Credentials are never exported: OAuth grants, refresh tokens, session tokens, one-time auth tokens and provider secrets are omitted from every section.',
    );
    omitted.add('Rows belonging to any other client are never included; scope is enforced on the server, not by filtering the output.');
    omitted.add(
      `This export is a scoped, expiring download rather than a permanent link: it stops being available at ${expiresAt.toISOString()}, and the payload is removed then.`,
    );

    const payload = {
      export: {
        scopeType,
        scopeId,
        generatedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        sections: sectionReports,
        format,
        note:
          'Stored rows as they are. Counts here are row counts; they are not metrics and are not a summary of performance.',
      },
      data,
    };

    const text =
      format === 'csv'
        ? this.toCsv(data[sections[0]] as unknown[])
        : JSON.stringify(payload, null, 2);

    return { payload, text, sectionReports, omitted: Array.from(omitted) };
  }

  // ── Sections ────────────────────────────────────────────────────────

  private async projectIdsIn(scopeType: ExportScopeType, scopeId: string): Promise<string[]> {
    if (scopeType === 'project') {
      const found = await this.prisma.project.findUnique({ where: { id: scopeId }, select: { id: true } });
      if (!found) throw new NotFoundException(`Project ${scopeId} not found`);
      return [scopeId];
    }
    const projects = await this.prisma.project.findMany({ where: { clientId: scopeId }, select: { id: true } });
    return projects.map((project) => project.id);
  }

  private async clientIdOfScope(scopeType: ExportScopeType, scopeId: string): Promise<string | null> {
    if (scopeType === 'client') return scopeId;
    const project = await this.prisma.project.findUnique({ where: { id: scopeId }, select: { clientId: true } });
    return project?.clientId ?? null;
  }

  private async projectsSection(projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true, name: true, domain: true, category: true, clientName: true,
        status: true, onboardingStatus: true, timezone: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async reportsSection(projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.report.findMany({
      where: { projectId: { in: projectIds } },
      select: {
        id: true, projectId: true, slug: true, title: true, targetUrl: true, visibility: true,
        status: true, scoreTotal: true, scoreBand: true, releasedRevision: true, releasedAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({ ...row, releasedAt: row.releasedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }));
  }

  private async metricsSection(projectIds: string[]): Promise<unknown[]> {
    const [scoreRuns, measurementRuns] = await Promise.all([
      this.prisma.scoreRun.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, rubricVersion: true, total: true, band: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: EXPORT_SECTION_ROW_LIMIT + 1,
      }),
      this.prisma.measurementRun.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          id: true, projectId: true, querySetId: true, surface: true, geo: true, runCount: true,
          status: true, totalRequests: true, completedRequests: true, failedRequests: true,
          startedAt: true, finishedAt: true, createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: EXPORT_SECTION_ROW_LIMIT + 1,
      }),
    ]);
    return [
      ...scoreRuns.map((row) => ({ kind: 'rubric-score', ...row, createdAt: row.createdAt.toISOString() })),
      ...measurementRuns.map((row) => ({
        kind: 'measurement-run',
        ...row,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    ];
  }

  private async observationsSection(projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.observation.findMany({
      where: { run: { projectId: { in: projectIds } } },
      select: {
        id: true, runId: true, itemId: true, runNumber: true, prompt: true, mentioned: true,
        cited: true, citedUrl: true, position: true, competitors: true, characterization: true,
        model: true, latencyMs: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  private async auditsSection(projectIds: string[]): Promise<unknown[]> {
    const [technical, seo, aeo] = await Promise.all([
      this.prisma.technicalAudit.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, targetUrl: true, score: true, pagesCrawled: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: EXPORT_SECTION_ROW_LIMIT + 1,
      }),
      this.prisma.seoAudit.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, siteUrl: true, score: true, clicks: true, impressions: true, ctr: true, position: true, windowDays: true, pagesInspected: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: EXPORT_SECTION_ROW_LIMIT + 1,
      }),
      this.prisma.aeoAudit.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, querySetId: true, runId: true, surface: true, tier: true, status: true, promptCount: true, observations: true, stanceJudged: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: EXPORT_SECTION_ROW_LIMIT + 1,
      }),
    ]);
    return [
      ...technical.map((row) => ({ kind: 'technical', ...row, createdAt: row.createdAt.toISOString() })),
      ...seo.map((row) => ({ kind: 'seo', ...row, createdAt: row.createdAt.toISOString() })),
      ...aeo.map((row) => ({ kind: 'aeo', ...row, createdAt: row.createdAt.toISOString() })),
    ];
  }

  private async workSection(projectIds: string[]): Promise<unknown[]> {
    const [items, cycles, milestones, engagements] = await Promise.all([
      this.prisma.workItem.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, cycleId: true, title: true, category: true, discipline: true, status: true, priority: true, dueAt: true, estimateHours: true, actualHours: true, clientVisible: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
        take: EXPORT_SECTION_ROW_LIMIT + 1,
      }),
      this.prisma.cycle.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, engagementId: true, name: true, status: true, startsOn: true, endsOn: true, goal: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.milestone.findMany({ where: { projectId: { in: projectIds } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.engagement.findMany({ where: { clientId: { in: await this.clientIdsFor(projectIds) } }, orderBy: { createdAt: 'asc' } }),
    ]);
    return [
      ...items.map((row) => ({ kind: 'work-item', ...row, dueAt: row.dueAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
      ...cycles.map((row) => ({ kind: 'cycle', ...row, startsOn: row.startsOn.toISOString(), endsOn: row.endsOn.toISOString(), createdAt: row.createdAt.toISOString() })),
      ...milestones.map((row) => ({ kind: 'milestone', ...row })),
      ...engagements.map((row) => ({ kind: 'engagement', ...row, notes: null })),
    ];
  }

  private async clientIdsFor(projectIds: string[]): Promise<string[]> {
    const rows = await this.prisma.project.findMany({
      where: { id: { in: projectIds }, clientId: { not: null } },
      select: { clientId: true },
    });
    return Array.from(new Set(rows.map((row) => row.clientId).filter((id): id is string => Boolean(id))));
  }

  private async querySetsSection(projectIds: string[]): Promise<unknown[]> {
    const sets = await this.prisma.querySet.findMany({
      where: { projectId: { in: projectIds } },
      include: { items: { select: { id: true, prompt: true, funnelStage: true, dimension: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return sets.map((set) => ({
      id: set.id, projectId: set.projectId, version: set.version, persona: set.persona,
      label: set.label, status: set.status, source: set.source, createdAt: set.createdAt.toISOString(),
      items: set.items,
    }));
  }

  private async personasSection(projectIds: string[]): Promise<unknown[]> {
    return this.prisma.persona.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
  }

  private async contentSection(projectIds: string[]): Promise<unknown[]> {
    const briefs = await this.prisma.contentBrief.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    return briefs;
  }

  private async competitorsSection(projectIds: string[]): Promise<unknown[]> {
    return this.prisma.competitor.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
  }

  private async presenceSection(projectIds: string[]): Promise<unknown[]> {
    const [accounts, discoveries] = await Promise.all([
      this.prisma.presenceAccount.findMany({ where: { projectId: { in: projectIds } }, take: EXPORT_SECTION_ROW_LIMIT + 1 }),
      this.prisma.presenceDiscovery.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true, status: true, pagesFetched: true, found: true, confirmed: true, unverified: true, candidates: true, startedAt: true, finishedAt: true },
        orderBy: { startedAt: 'asc' },
      }),
    ]);
    return [
      ...accounts.map((row) => ({ kind: 'account', ...row })),
      ...discoveries.map((row) => ({ kind: 'discovery', ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null })),
    ];
  }

  private async authoritySection(projectIds: string[]): Promise<unknown[]> {
    const scans = await this.prisma.authorityScan.findMany({
      where: { projectId: { in: projectIds } },
      include: { candidates: { select: { id: true, domain: true, url: true, title: true, type: true, status: true, rank: true, relevance: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return scans.map((scan) => ({
      ...scan,
      listicleQueries: undefined,
      createdAt: scan.createdAt.toISOString(),
      finishedAt: scan.finishedAt?.toISOString() ?? null,
      candidates: scan.candidates,
    }));
  }

  private async backlinksSection(projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.backlinksSummary.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, target: true, status: true, rank: true, backlinks: true, referringDomains: true, referringPages: true, brokenBacklinks: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  private async messagesSection(clientId: string | null, projectIds: string[]): Promise<unknown[]> {
    if (!clientId) return [];
    const rows = await this.prisma.clientMessage.findMany({
      where: { clientId, internal: false },
      select: { id: true, projectId: true, authorType: true, body: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    void projectIds;
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  private async activitySection(clientId: string | null, projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.activityEvent.findMany({
      where: {
        clientVisible: true,
        OR: [
          ...(clientId ? [{ clientId }] : []),
          ...(projectIds.length > 0 ? [{ projectId: { in: projectIds } }] : []),
        ],
      },
      select: { id: true, action: true, resourceType: true, resourceId: true, clientId: true, projectId: true, summary: true, result: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  private async attachmentsSection(projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { projectId: { in: projectIds }, deletedAt: null },
      select: { id: true, projectId: true, contextType: true, contextId: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  private async leadsSection(projectIds: string[]): Promise<unknown[]> {
    const rows = await this.prisma.lead.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, email: true, name: true, source: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_SECTION_ROW_LIMIT + 1,
    });
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  // ── Formatting ──────────────────────────────────────────────────────

  /**
   * Flatten rows to CSV.
   *
   * Values that are not scalars are JSON-encoded into their cell rather than
   * dropped — a CSV that silently loses a column is worse than one with a JSON
   * cell, and the header row always comes from the union of the rows' keys so
   * no column disappears because the first row happened to lack it.
   */
  private toCsv(rows: unknown[]): string {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const records = rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row));

    const headers: string[] = [];
    for (const record of records) {
      for (const key of Object.keys(record)) {
        if (!headers.includes(key)) headers.push(key);
      }
    }
    if (headers.length === 0) return '';

    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };

    const lines = [headers.map(escape).join(',')];
    for (const record of records) {
      lines.push(headers.map((header) => escape(record[header])).join(','));
    }
    return lines.join('\n');
  }

  private filenameFor(row: ExportRow, sections: ExportSection[], format: ExportFormat): string {
    const label = sections.length === 1 ? sections[0] : `${sections.length}-sections`;
    const extension = format === 'csv' ? 'csv' : 'json';
    return `cailyx-${row.scopeType}-export-${row.id}-${label}.${extension}`;
  }
}
