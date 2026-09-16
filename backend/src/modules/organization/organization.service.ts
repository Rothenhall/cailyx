/**
 * OrganizationService — G20: organization settings, branding, report templates
 * and program templates.
 *
 * Four rules drive this file:
 *
 * 1. **Settings are append-only, so a released document cannot be re-written
 *    after the fact.** Every write inserts a new `OrganizationSettings` row
 *    with `version = max + 1` and modifies nothing. A report released under
 *    version 3 pins `3`, and reading version 3 in a year returns exactly what
 *    was published. {@link getSettingsVersionInForce} and
 *    {@link getReleaseSnapshot} are exported for the reporting module to adopt.
 *
 * 2. **A template edit never mutates a committed cycle.** {@link applyProgramTemplate}
 *    COPIES rows into the target — a `WorkItem` goes through
 *    `DeliveryPlanService.createWorkItem`, so an already-committed cycle still
 *    demands a `scopeChangeReason` and records the addition in
 *    `Cycle.scopeChanges`. There is no link back to the template: editing the
 *    template afterwards cannot reach a row it already produced.
 *
 * 3. **`allowPublicShare` is a policy, not a preference.**
 *    {@link assertPublicShareAllowed} is the single call another module makes
 *    before minting a public share link, and it refuses with the settings
 *    version that disabled it.
 *
 * 4. **Multi-agency tenancy is NOT implemented.** These settings are
 *    application-wide, not per-client, because the current data model has no
 *    Organization boundary — see README.md "Tenancy". There is deliberately no
 *    `tenantId` anywhere: faking an isolation boundary would be worse than
 *    documenting that there is none.
 *
 * @module organization.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivityService, type RecordActivityInput } from '../activity/activity.service';
import { DeliveryPlanService } from '../delivery-plan/delivery-plan.service';
import { isValidTimeZone } from '../jobs/lib/cadence-schedule.util';
import { brandingCssVariables, normalizeHexColor, tryNormalizeHexColor } from './lib/branding.util';
import {
  type ApplyProgramTemplateResult,
  type AppliedRow,
  type BrandingSnapshot,
  type OrganizationSettingsDto,
  type ProgramTemplateDto,
  type ProgramTemplateItem,
  type ReleaseSnapshot,
  type ReportTemplateDto,
  type ReportTemplateSection,
  type ShareScope,
  type SkippedItem,
  PROGRAM_TEMPLATE_KINDS,
} from './organization.types';
import type {
  ApplyProgramTemplateDto,
  CreateProgramTemplateDto,
  CreateReportTemplateDto,
  UpdateProgramTemplateDto,
  UpdateReportTemplateDto,
  WriteOrganizationSettingsDto,
} from './dto/organization.dto';

/**
 * The model's own declared defaults, restated so a read on an install where no
 * settings row has ever been written returns the values the schema promises
 * rather than `undefined`. `persisted: false` on the DTO is what marks these as
 * not-a-row — they are not invented, they are the same literals as the
 * `@default(...)` clauses in prisma/schema.prisma.
 */
const SCHEMA_DEFAULT_SETTINGS: Omit<OrganizationSettingsDto, 'version' | 'persisted' | 'updatedBy' | 'createdAt' | 'updatedAt'> = {
  displayName: 'Cailyx',
  logoUrl: null,
  primaryColor: null,
  supportEmail: null,
  supportName: null,
  timezone: 'UTC',
  defaultTier: 'retainer',
  reviewSlaHours: 48,
  allowPublicShare: true,
};

/** Settings columns this service reads. Structural, so no Prisma type import is needed. */
interface SettingsRow {
  id: string;
  version: number;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  supportName: string | null;
  timezone: string;
  defaultTier: string;
  reviewSlaHours: number;
  allowPublicShare: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly activity: ActivityService,
    protected readonly deliveryPlan: DeliveryPlanService,
  ) {}

  // ── JSON helpers ────────────────────────────────────────────────────

  private parseUnknown(raw: string | null | undefined): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private parseRecordArray(raw: string | null | undefined): Array<Record<string, unknown>> {
    const v = this.parseUnknown(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
  }

  private str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private async audit(input: RecordActivityInput): Promise<void> {
    try {
      await this.activity.record(input);
    } catch (err) {
      this.logger.warn(
        `G20: audit write failed for ${input.resource.type}/${input.resource.id ?? '-'}: ${(err as Error).message}`,
      );
    }
  }

  // ── Settings ────────────────────────────────────────────────────────

  private toSettingsDto(row: SettingsRow): OrganizationSettingsDto {
    return {
      version: row.version,
      persisted: true,
      displayName: row.displayName,
      logoUrl: row.logoUrl,
      // Read path is lenient: a value stored before validation existed is
      // reported as `null` rather than shipped into a stylesheet.
      primaryColor: tryNormalizeHexColor(row.primaryColor),
      supportEmail: row.supportEmail,
      supportName: row.supportName,
      timezone: row.timezone,
      defaultTier: row.defaultTier,
      reviewSlaHours: row.reviewSlaHours,
      allowPublicShare: row.allowPublicShare,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private schemaDefaultDto(): OrganizationSettingsDto {
    return { version: null, persisted: false, ...SCHEMA_DEFAULT_SETTINGS, updatedBy: null, createdAt: null, updatedAt: null };
  }

  /**
   * The version of the settings in force — the highest version, because
   * settings rows are append-only and nothing is ever edited.
   *
   * Returns the model's declared defaults with `persisted: false` and
   * `version: null` when no row has ever been written. That is a real state
   * ("running on defaults"), not an error and not a version-1 row invented to
   * make the shape tidier.
   *
   * Exported for other modules — this is the method reporting pins into a
   * released report.
   */
  async getSettingsVersionInForce(): Promise<OrganizationSettingsDto> {
    const row = await this.prisma.organizationSettings.findFirst({ orderBy: { version: 'desc' } });
    return row ? this.toSettingsDto(row) : this.schemaDefaultDto();
  }

  /** One exact settings version, or the version in force when `version` is omitted. */
  async getSettings(version?: number): Promise<OrganizationSettingsDto> {
    if (version === undefined) return this.getSettingsVersionInForce();
    const row = await this.prisma.organizationSettings.findUnique({ where: { version } });
    if (!row) throw new NotFoundException(`Organization settings version ${version} not found`);
    return this.toSettingsDto(row);
  }

  /** Every settings version, newest first. There is no update, so this is the whole history. */
  async listSettingsVersions(): Promise<{ versions: OrganizationSettingsDto[]; versionInForce: number | null }> {
    const rows = await this.prisma.organizationSettings.findMany({ orderBy: { version: 'desc' } });
    return {
      versions: rows.map((r) => this.toSettingsDto(r)),
      versionInForce: rows.length > 0 ? rows[0].version : null,
    };
  }

  /**
   * Write a NEW settings version.
   *
   * The version in force is read, the patch is applied on top of it, and the
   * result is INSERTED — the row that was read is not touched. `undefined`
   * carries a field forward; `null` clears a nullable one. Both are recorded
   * in the audit event, because "unchanged" and "cleared" are different
   * outcomes for a brand mark that appears on a client document.
   */
  async writeSettings(dto: WriteOrganizationSettingsDto, actorId: string): Promise<OrganizationSettingsDto> {
    const current = await this.getSettingsVersionInForce();
    const latestRow = await this.prisma.organizationSettings.findFirst({ orderBy: { version: 'desc' } });
    const nextVersion = (latestRow?.version ?? 0) + 1;

    if (dto.timezone !== undefined && !isValidTimeZone(dto.timezone)) {
      throw new BadRequestException(`timezone "${dto.timezone}" is not a recognized IANA zone identifier`);
    }
    const primaryColor =
      dto.primaryColor === undefined
        ? current.primaryColor
        : dto.primaryColor === null
          ? null
          : normalizeHexColor(dto.primaryColor);

    const next = {
      displayName: dto.displayName ?? current.displayName,
      logoUrl: dto.logoUrl === undefined ? current.logoUrl : dto.logoUrl,
      primaryColor,
      supportEmail: dto.supportEmail === undefined ? current.supportEmail : dto.supportEmail,
      supportName: dto.supportName === undefined ? current.supportName : dto.supportName,
      timezone: dto.timezone ?? current.timezone,
      defaultTier: dto.defaultTier ?? current.defaultTier,
      reviewSlaHours: dto.reviewSlaHours ?? current.reviewSlaHours,
      allowPublicShare: dto.allowPublicShare ?? current.allowPublicShare,
    };

    const row = await this.prisma.organizationSettings.create({
      data: { version: nextVersion, ...next, updatedBy: actorId },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'updated',
      resource: { type: 'organization-settings', id: row.id, version: String(row.version) },
      summary: `Organization settings version ${row.version} written (previous version in force: ${current.version ?? 'none — schema defaults'})`,
      changes: {
        displayName: { before: current.displayName, after: next.displayName },
        logoUrl: { before: current.logoUrl, after: next.logoUrl },
        primaryColor: { before: current.primaryColor, after: next.primaryColor },
        supportEmail: { before: current.supportEmail, after: next.supportEmail },
        supportName: { before: current.supportName, after: next.supportName },
        timezone: { before: current.timezone, after: next.timezone },
        defaultTier: { before: current.defaultTier, after: next.defaultTier },
        reviewSlaHours: { before: current.reviewSlaHours, after: next.reviewSlaHours },
        allowPublicShare: { before: current.allowPublicShare, after: next.allowPublicShare },
      },
      origin: 'api',
    });

    return this.toSettingsDto(row);
  }

  // ── Branding ────────────────────────────────────────────────────────

  /**
   * Branding as a released document needs it, with the settings version it
   * came from.
   *
   * The `branding` block is shaped to match reporting's own `BrandingConfig`
   * (`orgName`/`logoUrl`/`palette.primary`) so adopting it is a swap rather
   * than a translation layer. `tagline` is not included: `OrganizationSettings`
   * has no column for one, and inventing a value here would be exactly the
   * kind of fabricated field this build is supposed to avoid.
   */
  async getBrandingForRelease(): Promise<BrandingSnapshot> {
    return this.brandingFrom(await this.getSettingsVersionInForce());
  }

  /**
   * The projection itself, taking the settings row as an argument.
   *
   * Split out so `getReleaseSnapshot` reads the settings ONCE: a snapshot that
   * reported settings version 5 alongside branding read from version 6 would
   * be internally inconsistent, and a settings write landing between two reads
   * is exactly how that happens.
   */
  private brandingFrom(settings: OrganizationSettingsDto): BrandingSnapshot {
    const branding: BrandingSnapshot['branding'] = { orgName: settings.displayName };
    if (settings.logoUrl) branding.logoUrl = settings.logoUrl;
    if (settings.primaryColor) branding.palette = { primary: settings.primaryColor };
    return {
      settingsVersion: settings.version,
      branding,
      cssVariables: brandingCssVariables(settings.primaryColor),
    };
  }

  /**
   * Everything a release has to pin: the settings version, the branding, the
   * policy in force, and the resolved report template WITH its version.
   *
   * This is the method the reporting module should call at release time. A
   * later settings edit creates a new version and a later template edit bumps
   * that template's version, so neither can retroactively change a document
   * that already recorded what it was published under.
   */
  async getReleaseSnapshot(reportType: string): Promise<ReleaseSnapshot> {
    const settings = await this.getSettingsVersionInForce();
    const branding = this.brandingFrom(settings);
    const template = await this.resolveReportTemplate(reportType);
    return {
      settingsVersion: settings.version,
      branding,
      policy: {
        allowPublicShare: settings.allowPublicShare,
        reviewSlaHours: settings.reviewSlaHours,
        timezone: settings.timezone,
        defaultTier: settings.defaultTier,
      },
      template,
      templateUnavailableReason: template
        ? null
        : `No report template is configured for report type "${reportType}". The release must state the section layout it used rather than falling back to one silently.`,
      capturedAt: new Date().toISOString(),
    };
  }

  // ── Public share policy ─────────────────────────────────────────────

  /** Whether public (anyone-with-the-link) shares may be minted at all. */
  async isPublicShareAllowed(): Promise<boolean> {
    const settings = await this.getSettingsVersionInForce();
    return settings.allowPublicShare;
  }

  /**
   * The gate other modules call BEFORE minting a public share link.
   *
   * A boolean read is not enough on its own: a caller that only reads it can
   * forget to act on it, and the failure mode is a client document on the open
   * web. This throws, names what was refused, and names the settings version
   * that disabled it so an operator can find the switch.
   *
   * @throws ForbiddenException public sharing is disabled by policy.
   */
  async assertPublicShareAllowed(scope: ShareScope, subject: string): Promise<void> {
    const settings = await this.getSettingsVersionInForce();
    if (settings.allowPublicShare) return;
    const source =
      settings.version === null
        ? 'application defaults'
        : `organization settings version ${settings.version}`;
    throw new ForbiddenException(
      `Public sharing is disabled by ${source} — refusing to mint a public ${scope} link for ${subject}. Re-enable it at PUT /api/organization/settings.`,
    );
  }

  // ── Report templates ───────────────────────────────────────────────

  private toReportTemplateDto(row: {
    id: string;
    name: string;
    reportType: string;
    sections: string;
    version: number;
    isDefault: boolean;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ReportTemplateDto {
    const sections: ReportTemplateSection[] = this.parseRecordArray(row.sections).map((s, index) => ({
      key: this.str(s.key) ?? `section-${index}`,
      title: this.str(s.title) ?? '',
      include: s.include === undefined ? true : s.include === true,
      order: this.num(s.order) ?? index,
    }));
    sections.sort((a, b) => a.order - b.order);
    return {
      id: row.id,
      name: row.name,
      reportType: row.reportType,
      sections,
      version: row.version,
      isDefault: row.isDefault,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listReportTemplates(reportType?: string): Promise<{ templates: ReportTemplateDto[] }> {
    const rows = await this.prisma.reportTemplate.findMany({
      where: reportType ? { reportType } : {},
      orderBy: [{ reportType: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
    });
    return { templates: rows.map((r) => this.toReportTemplateDto(r)) };
  }

  async getReportTemplate(id: string): Promise<ReportTemplateDto> {
    const row = await this.prisma.reportTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Report template ${id} not found`);
    return this.toReportTemplateDto(row);
  }

  /**
   * The template in force for a report type: the default one if the type has
   * one, otherwise the most recently updated template of that type.
   *
   * Returns null rather than throwing when the type has none — "no template
   * configured" is a state a release has to disclose, not an error that stops
   * the release.
   */
  async resolveReportTemplate(reportType: string): Promise<ReportTemplateDto | null> {
    const preferred = await this.prisma.reportTemplate.findFirst({
      where: { reportType, isDefault: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (preferred) return this.toReportTemplateDto(preferred);
    const fallback = await this.prisma.reportTemplate.findFirst({
      where: { reportType },
      orderBy: { updatedAt: 'desc' },
    });
    return fallback ? this.toReportTemplateDto(fallback) : null;
  }

  async createReportTemplate(dto: CreateReportTemplateDto, actorId: string): Promise<ReportTemplateDto> {
    const sections = dto.sections ?? [];
    this.assertSectionKeysUnique(sections);

    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.reportTemplate.updateMany({
          where: { reportType: dto.reportType, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.reportTemplate.create({
        data: {
          name: dto.name,
          reportType: dto.reportType,
          sections: JSON.stringify(sections),
          version: 1,
          isDefault: dto.isDefault ?? false,
          createdBy: actorId,
        },
      });
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'created',
      resource: { type: 'report-template', id: row.id, version: String(row.version) },
      summary: `Report template "${row.name}" created for ${row.reportType}${row.isDefault ? ' (default)' : ''}`,
      changes: { sections: sections.length, isDefault: row.isDefault },
      origin: 'api',
    });
    return this.toReportTemplateDto(row);
  }

  /**
   * Edit a report template. Content changes bump `version`; an `isDefault`
   * change is deferred to the dedicated endpoint and does not.
   *
   * The bump is what makes the pin checkable: a report released under
   * `{templateId, version: 2}` can still be shown to have used v2 after this
   * edit, because the released document carries its own copy of the sections
   * and the version it copied.
   */
  async updateReportTemplate(id: string, dto: UpdateReportTemplateDto, actorId: string): Promise<ReportTemplateDto> {
    const existing = await this.prisma.reportTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Report template ${id} not found`);

    const sections = dto.sections;
    if (sections) this.assertSectionKeysUnique(sections);

    const contentChanged =
      (dto.name !== undefined && dto.name !== existing.name) ||
      (dto.reportType !== undefined && dto.reportType !== existing.reportType) ||
      (sections !== undefined && JSON.stringify(sections) !== existing.sections);

    const row = await this.prisma.reportTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.reportType !== undefined ? { reportType: dto.reportType } : {}),
        ...(sections !== undefined ? { sections: JSON.stringify(sections) } : {}),
        ...(contentChanged ? { version: existing.version + 1 } : {}),
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'updated',
      resource: { type: 'report-template', id, version: String(row.version) },
      summary: contentChanged
        ? `Report template "${row.name}" edited — version ${existing.version} -> ${row.version}; documents released under version ${existing.version} are unaffected`
        : `Report template "${row.name}" saved with no content change (version stays ${row.version})`,
      changes: {
        contentChanged,
        version: { before: existing.version, after: row.version },
        sections: sections !== undefined ? { before: this.parseRecordArray(existing.sections).length, after: sections.length } : undefined,
      },
      origin: 'api',
    });
    return this.toReportTemplateDto(row);
  }

  /**
   * Make one template the default for its report type, clearing the previous
   * default of that type in the same transaction so a type can never be left
   * with two defaults.
   */
  async setDefaultReportTemplate(id: string, actorId: string): Promise<ReportTemplateDto> {
    const existing = await this.prisma.reportTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Report template ${id} not found`);
    if (existing.isDefault) return this.toReportTemplateDto(existing);

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.reportTemplate.updateMany({
        where: { reportType: existing.reportType, isDefault: true },
        data: { isDefault: false },
      });
      return tx.reportTemplate.update({ where: { id }, data: { isDefault: true } });
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'updated',
      resource: { type: 'report-template', id, version: String(row.version) },
      summary: `Report template "${row.name}" is now the default for ${row.reportType}`,
      changes: { isDefault: { before: false, after: true } },
      origin: 'api',
    });
    return this.toReportTemplateDto(row);
  }

  private assertSectionKeysUnique(sections: ReportTemplateSection[]): void {
    const seen = new Set<string>();
    for (const s of sections) {
      if (seen.has(s.key)) {
        throw new ConflictException(
          `Section key "${s.key}" appears more than once — a renderer keyed on it cannot tell the sections apart.`,
        );
      }
      seen.add(s.key);
    }
  }

  // ── Program templates ──────────────────────────────────────────────

  private toProgramTemplateDto(row: {
    id: string;
    name: string;
    kind: string;
    description: string | null;
    items: string;
    version: number;
    active: boolean;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ProgramTemplateDto {
    const items: ProgramTemplateItem[] = this.parseRecordArray(row.items)
      .map((i) => ({
        title: this.str(i.title) ?? '',
        category: this.str(i.category),
        discipline: this.str(i.discipline),
        role: this.str(i.role),
        estimateHours: this.num(i.estimateHours),
        offsetDays: this.num(i.offsetDays),
      }))
      .filter((i) => i.title.length > 0);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: row.description,
      items,
      version: row.version,
      active: row.active,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listProgramTemplates(filters: { kind?: string; active?: boolean } = {}): Promise<{ templates: ProgramTemplateDto[] }> {
    const rows = await this.prisma.programTemplate.findMany({
      where: {
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.active !== undefined ? { active: filters.active } : {}),
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return { templates: rows.map((r) => this.toProgramTemplateDto(r)) };
  }

  async getProgramTemplate(id: string): Promise<ProgramTemplateDto> {
    const row = await this.prisma.programTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Program template ${id} not found`);
    return this.toProgramTemplateDto(row);
  }

  async createProgramTemplate(dto: CreateProgramTemplateDto, actorId: string): Promise<ProgramTemplateDto> {
    const row = await this.prisma.programTemplate.create({
      data: {
        name: dto.name,
        kind: dto.kind,
        description: dto.description ?? null,
        items: JSON.stringify(dto.items ?? []),
        version: 1,
        active: dto.active ?? true,
        createdBy: actorId,
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'created',
      resource: { type: 'program-template', id: row.id, version: String(row.version) },
      summary: `Program template "${row.name}" (${row.kind}) created with ${this.parseRecordArray(row.items).length} item(s)`,
      changes: { kind: row.kind, items: this.parseRecordArray(row.items).length },
      origin: 'api',
    });
    return this.toProgramTemplateDto(row);
  }

  /**
   * Edit a program template. Content changes bump `version`.
   *
   * Rows already copied from an earlier version are NOT touched — they are
   * copies, not references. This edit cannot reach them, which is the point:
   * a committed cycle keeps the scope it was committed with.
   */
  async updateProgramTemplate(id: string, dto: UpdateProgramTemplateDto, actorId: string): Promise<ProgramTemplateDto> {
    const existing = await this.prisma.programTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Program template ${id} not found`);

    const contentChanged =
      (dto.name !== undefined && dto.name !== existing.name) ||
      (dto.kind !== undefined && dto.kind !== existing.kind) ||
      (dto.description !== undefined && dto.description !== existing.description) ||
      (dto.items !== undefined && JSON.stringify(dto.items) !== existing.items);

    const row = await this.prisma.programTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.items !== undefined ? { items: JSON.stringify(dto.items) } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(contentChanged ? { version: existing.version + 1 } : {}),
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'updated',
      resource: { type: 'program-template', id, version: String(row.version) },
      summary: contentChanged
        ? `Program template "${row.name}" edited — version ${existing.version} -> ${row.version}; rows already copied from it are unaffected`
        : `Program template "${row.name}" saved with no content change (version stays ${row.version})`,
      changes: { contentChanged, version: { before: existing.version, after: row.version }, active: { before: existing.active, after: row.active } },
      origin: 'api',
    });
    return this.toProgramTemplateDto(row);
  }

  /**
   * Apply a program template to a project — by COPYING rows, never by linking.
   *
   * What each kind produces, and the honest limits of each:
   *
   * - `cycle` → `WorkItem` rows, created through `DeliveryPlanService.createWorkItem`
   *   so that every G06 rule still applies: a closed cycle is refused, and an
   *   already-committed cycle demands a `scopeChangeReason` and records the
   *   addition in `Cycle.scopeChanges` rather than silently moving the frozen
   *   denominator. Each row is stamped `sourceType: 'program-template'` /
   *   `sourceId: <template id>`, which is what `WorkItem.sourceType` is for.
   * - `onboarding` → `OnboardingRequest` rows (G04's checklist model — the only
   *   onboarding-checklist table in the schema). The item shape is
   *   work-item-shaped, so `category`/`discipline`/`estimateHours` have nowhere
   *   to go; they are reported in `notCarried` rather than dropped quietly.
   *   `OnboardingRequest` has no provenance column, so the template origin is
   *   recorded in the activity trail only.
   * - `offboarding` → no target table exists. This returns `applied: false`
   *   with the reason (an explicit unavailable state) rather than creating
   *   something that is not an offboarding checklist.
   *
   * A copy is not transactional across rows: a per-item failure is reported in
   * `skipped` and leaves `partial: true`, rather than being hidden by a rollback
   * that also discards the successful rows.
   */
  async applyProgramTemplate(
    templateId: string,
    dto: ApplyProgramTemplateDto,
    actorId: string,
  ): Promise<ApplyProgramTemplateResult> {
    const template = await this.getProgramTemplate(templateId);
    if (!template.active) {
      throw new ConflictException(
        `Program template "${template.name}" is inactive and cannot be applied. Reactivate it, or apply a different template.`,
      );
    }

    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { id: true, clientId: true, timezone: true },
    });
    if (!project) throw new NotFoundException(`Project ${dto.projectId} not found`);

    const base: ApplyProgramTemplateResult = {
      template: { id: template.id, name: template.name, kind: template.kind, version: template.version },
      projectId: dto.projectId,
      applied: false,
      unavailableReason: null,
      dryRun: dto.dryRun === true,
      copied: 0,
      partial: false,
      created: [],
      skipped: [],
      notCarried: [],
      cycle: null,
      notes: [],
    };

    if (template.items.length === 0) {
      return {
        ...base,
        notes: [`Template "${template.name}" has no items, so applying it produced nothing. That is the template's actual content, not a failure.`],
      };
    }

    if (template.kind === 'offboarding') {
      return {
        ...base,
        unavailableReason:
          'No offboarding checklist table exists in this schema, so an offboarding template cannot be applied. Nothing was created. This is an explicit unavailable state, not an empty result.',
      };
    }

    const startOn = dto.startOn ? new Date(dto.startOn) : null;
    if (dto.startOn && (!startOn || Number.isNaN(startOn.getTime()))) {
      throw new BadRequestException(`startOn "${dto.startOn}" is not a parseable date`);
    }

    if (template.kind === 'cycle') {
      if (!dto.cycleId) {
        throw new BadRequestException(
          'A cycle template copies work items into a specific cycle — supply cycleId. Work items with no cycle would land in the backlog rather than the cycle being planned.',
        );
      }
      const cycle = await this.prisma.cycle.findFirst({
        where: { id: dto.cycleId, projectId: dto.projectId },
        select: { id: true, status: true },
      });
      if (!cycle) throw new NotFoundException(`Cycle ${dto.cycleId} not found on project ${dto.projectId}`);
      base.cycle = { id: cycle.id, status: cycle.status };
      base.notCarried = ['role (a work-item has assigneeId/reviewerId, not a role name)'];
    } else if (template.kind === 'onboarding') {
      base.notCarried = ['category', 'discipline', 'estimateHours'];
    } else if (!(PROGRAM_TEMPLATE_KINDS as readonly string[]).includes(template.kind)) {
      return {
        ...base,
        unavailableReason: `Program template kind "${template.kind}" has no apply target in this build. Nothing was created.`,
      };
    }

    const created: AppliedRow[] = [];
    const skipped: SkippedItem[] = [];

    for (const item of template.items) {
      const dueDate = startOn && item.offsetDays !== null ? addDays(startOn, item.offsetDays) : null;

      if (dto.dryRun) {
        created.push({
          id: null,
          title: item.title,
          target: template.kind === 'cycle' ? 'work-item' : 'onboarding-request',
          cycleId: dto.cycleId ?? null,
        });
        continue;
      }

      try {
        if (template.kind === 'cycle') {
          const row = await this.deliveryPlan.createWorkItem(
            dto.projectId,
            {
              title: item.title,
              category: item.category ?? undefined,
              discipline: item.discipline ?? undefined,
              cycleId: dto.cycleId,
              scopeChangeReason: dto.scopeChangeReason,
              estimateHours: item.estimateHours ?? undefined,
              // A bare date: G06 resolves it end-of-day in the project's own
              // timezone, which is the only correct reading of "3 days in".
              dueOn: dueDate ? toIsoDate(dueDate) : undefined,
              sourceType: 'program-template',
              sourceId: template.id,
            },
            actorId,
          );
          created.push({ id: row.id, title: row.title, target: 'work-item', cycleId: row.cycleId ?? null });
        } else {
          const row = await this.prisma.onboardingRequest.create({
            data: {
              projectId: dto.projectId,
              kind: 'other',
              title: item.title,
              detail: `Copied from program template "${template.name}" v${template.version}${item.role ? ` · for ${item.role}` : ''}.`,
              requestedOf: item.role ?? null,
              requestedBy: actorId,
              // OnboardingRequest.dueAt is a timestamp column, so the offset
              // lands at UTC midnight of the computed calendar date.
              dueAt: dueDate,
              blockedWork: '[]',
            },
          });
          created.push({ id: row.id, title: row.title, target: 'onboarding-request', cycleId: null });
        }
      } catch (err) {
        skipped.push({ title: item.title, reason: (err as Error).message });
      }
    }

    const partial = skipped.length > 0 && created.length > 0;

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'created',
      resource: { type: 'program-template', id: template.id, version: String(template.version) },
      projectId: dto.projectId,
      clientId: project.clientId,
      summary: dto.dryRun
        ? `Dry run: program template "${template.name}" v${template.version} would copy ${created.length} row(s) into project ${dto.projectId}`
        : `Program template "${template.name}" v${template.version} applied to project ${dto.projectId}: ${created.length} row(s) copied, ${skipped.length} skipped${partial ? ' (partial)' : ''}`,
      changes: {
        reason: dto.reason ?? null,
        cycleId: dto.cycleId ?? null,
        copied: created.length,
        skipped: skipped.length,
        startOn: startOn ? startOn.toISOString() : null,
        copySemantics: 'Copies, not links: editing this template afterwards cannot change the rows it produced.',
      },
      origin: 'api',
    });

    return {
      ...base,
      applied: !dto.dryRun && created.length > 0,
      copied: created.length,
      partial,
      created,
      skipped,
      notes: [
        'Rows were copied, not linked. Editing this template afterwards does not change the rows it already produced, and a committed cycle keeps the scope it was committed with.',
        ...(dto.cycleId && base.cycle && base.cycle.status !== 'planning'
          ? [`The target cycle is "${base.cycle.status}", so a scopeChangeReason was required and the additions are recorded in Cycle.scopeChanges.`]
          : []),
        ...(base.notCarried.length > 0
          ? [`Not carried onto the copied rows (no such column on the target): ${base.notCarried.join(', ')}.`]
          : []),
        ...(startOn ? [] : ['No startOn was supplied, so no due dates were set — a template cannot invent a schedule it was not given.']),
        ...(partial ? ['This copy is not a single transaction: the successful rows were kept and the failures are listed in `skipped`.'] : []),
      ],
    };
  }
}

/** Add whole days to a date, returning a new Date. Kept local because the only
 *  date arithmetic in this package is a forward offset from an
 *  operator-supplied start date; no timezone resolution is involved here —
 *  a work item receives a bare `YYYY-MM-DD` and G06 resolves it end-of-day
 *  against the project's own timezone. */
function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** `YYYY-MM-DD` in UTC, the bare-date form G06's `dueOn` accepts. */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
