/**
 * BusinessProfileService — G04: confirmed intake, the versioned business
 * profile, project attachment and the access checklist.
 *
 * Four rules drive the whole file, and each one is a place where the obvious
 * implementation would be wrong:
 *
 * 1. **A confirmed profile is immutable.** `confirm()` writes a NEW row and
 *    never touches the row it read. Editing a confirmed version is impossible
 *    by construction: `saveDraft()` only ever mutates a row whose
 *    `confirmedAt` is null, and `confirm()` only ever inserts. That is what
 *    makes a fact citable later — "the client confirmed this on the 3rd" has
 *    to remain checkable after they change their mind on the 10th.
 *
 * 2. **Confirmed values never mix with extracted candidates.** `SiteContext`
 *    holds what a crawler or a model guessed. It is served on its own surface
 *    (`listCandidates`) with `provenance: 'extracted'` and no `confirmedAt`
 *    field anywhere in its shape, and no method here reads `SiteContext` on
 *    the profile's behalf. A scrape can never become a fact without a human
 *    typing it into a draft and confirming it.
 *
 * 3. **Nothing propagates silently.** Confirming a version updates nothing
 *    else on the project. `rebuild()` is the only path that moves confirmed
 *    facts outward, it requires the caller to name the targets explicitly, and
 *    it records an audit event naming the version it read.
 *
 * 4. **Ownership is `clientId`.** `Project` carries a nullable `clientId` (the
 *    relation) and a legacy `clientName` (a string). Every method here treats
 *    them as different things: ownership is read from `clientId` only, and
 *    every response that reports ownership says so out loud.
 *
 * @module business-profile.service
 */

import { createHash } from 'crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivityService, type RecordActivityInput } from '../activity/activity.service';
import { normalizeDomain, tryNormalizeDomain } from './lib/domain.util';
import {
  CompetitorCapExceededException,
  competitorCapForTier,
  normalizePlanTier,
} from './lib/competitor-cap.util';
import {
  BUSINESS_PROFILE_PROVENANCE_NOTE,
  type BusinessInfoField,
  type BusinessInfoOverview,
  type BusinessInfoSectionKey,
  type BusinessProfileData,
  type BusinessProfileDto,
  type ChecklistItem,
  type CompetitorShape,
  type MarketTarget,
  type OnboardingChecklistDto,
  type OnboardingRequestDto,
  type OnboardingRequestStatus,
  type ProfileState,
  type ProfileVersionRef,
  type ProjectAttachmentDto,
  type ProjectOwnershipDto,
  type RebuildTarget,
  type SiteContextCandidateDto,
  type TargetLocationsOverview,
  DOWNSTREAM_NOT_TOUCHED,
  ONBOARDING_REQUEST_TRANSITIONS,
  OPEN_REQUEST_STATUSES,
} from './business-profile.types';
import { previewProviderSupport } from './market-provider-support';
import type {
  ConfirmBusinessProfileDto,
  RebuildFromProfileDto,
  RejectBusinessProfileSuggestionDto,
  SaveBusinessProfileDto,
} from './dto/business-profile.dto';
import type { AttachProjectDto, CorrectDomainDto } from './dto/attach.dto';
import type { CreateOnboardingRequestDto, UpdateOnboardingRequestDto } from './dto/onboarding-request.dto';

/** The profile columns this service reads. Structural, so no Prisma type import is needed. */
interface ProfileRow {
  id: string;
  projectId: string;
  version: number;
  brandName: string | null;
  legalName: string | null;
  description: string | null;
  category: string | null;
  services: string;
  icp: string;
  markets: string;
  languages: string;
  targets: string;
  facts: string;
  competitors: string;
  goals: string;
  approvers: string;
  publishing: string;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The newest `SiteContext`, reshaped to the fields business-information suggestions can be built from. */
interface SiteContextSuggestionSource {
  brand: string | null;
  description: string | null;
  /** C2 (`docs/analysis/client-portal.md` §12) — business category / type. */
  category: string | null;
  services: string[];
  icp: string[];
  painPoints: string[];
  markets: string[];
  competitors: CompetitorShape[];
  /**
   * P03 (plan §9.3 stage 4/6) — per-field source page, when the staged
   * pipeline built this `SiteContext` and recorded a validated citation for
   * the field. Keyed the same way as {@link SiteContextSuggestionSource}'s own
   * fields ("description", "services", "icp", "painPoints", "markets").
   * Absent (or the field missing) for a pre-P03 row, which falls back to the
   * whole-context first-page-read behaviour.
   */
  fieldSources: Record<string, string>;
}

/** Result of a profile write: the row, plus anything the caller should know about the input. */
export interface SaveProfileResult {
  profile: BusinessProfileDto;
  /** Set when part of the input could not be stored as given. Never silent. */
  warnings: string[];
}

/** One concrete change an explicit rebuild made (or would make). */
export interface RebuildChange {
  target: RebuildTarget;
  applied: boolean;
  changed: boolean;
  before: string[];
  after: string[];
  added: string[];
  alreadyPresent: string[];
  detail: string;
}

export interface RebuildResult {
  projectId: string;
  /** The version the facts were read from. */
  sourceVersion: number;
  sourceState: 'confirmed';
  reason: string;
  dryRun: boolean;
  changes: RebuildChange[];
  /** Artifacts an operator might expect to move and which deliberately did not. */
  notTouched: Array<{ artifact: string; endpoint: string }>;
}

/** Result of a domain correction. */
export interface DomainCorrectionResult {
  projectId: string;
  changed: boolean;
  before: string;
  after: string;
  normalized: string;
  warnings: string[];
}

export interface AttachmentCheckResult {
  projectId: string;
  clientId: string;
  /** False when the attach would be refused; `blockers` says why. */
  attachable: boolean;
  alreadyAttached: boolean;
  reassignmentRequired: boolean;
  ownership: ProjectOwnershipDto;
  domainConflict: { projectId: string; name: string; domain: string; clientId: string | null } | null;
  blockers: string[];
  warnings: string[];
}

@Injectable()
export class BusinessProfileService {
  private readonly logger = new Logger(BusinessProfileService.name);

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly activity: ActivityService,
  ) {}

  // ── JSON column helpers ─────────────────────────────────────────────

  private parseUnknown(raw: string | null | undefined): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private parseStringArray(raw: string | null | undefined): string[] {
    const v = this.parseUnknown(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  private parseRecord(raw: string | null | undefined): Record<string, unknown> {
    const v = this.parseUnknown(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }

  private parseRecordArray(raw: string | null | undefined): Array<Record<string, unknown>> {
    const v = this.parseUnknown(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
  }

  private str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private stringArrayOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  }

  /** Parse the `targets` JSON column. Defensively — a malformed or legacy-empty row parses to `[]`, never throws. */
  private parseTargets(raw: string | null | undefined): MarketTarget[] {
    return this.parseRecordArray(raw)
      .map((t) => ({
        country: (this.str(t.country) ?? '').toUpperCase(),
        region: this.str(t.region),
        city: this.str(t.city),
        language: this.str(t.language),
        priority: typeof t.priority === 'number' && Number.isFinite(t.priority) ? t.priority : 0,
        active: t.active !== false,
        productApplicability: this.stringArrayOf(t.productApplicability),
      }))
      .filter((t) => /^[A-Z]{2}$/.test(t.country))
      .sort((a, b) => a.priority - b.priority);
  }

  // ── Row → DTO ───────────────────────────────────────────────────────

  private toData(row: ProfileRow): BusinessProfileData {
    const icp = this.parseRecord(row.icp);
    const publishing = this.parseRecord(row.publishing);
    return {
      brandName: row.brandName,
      legalName: row.legalName,
      description: row.description,
      category: row.category,
      services: this.parseStringArray(row.services),
      icp: {
        segments: this.stringArrayOf(icp.segments),
        roles: this.stringArrayOf(icp.roles),
        painPoints: this.stringArrayOf(icp.painPoints),
      },
      markets: this.parseStringArray(row.markets),
      languages: this.parseStringArray(row.languages),
      targets: this.parseTargets(row.targets),
      facts: this.parseRecordArray(row.facts)
        .map((f) => ({ fact: this.str(f.fact) ?? '', evidenceUrl: this.str(f.evidenceUrl) }))
        .filter((f) => f.fact.length > 0),
      competitors: this.parseRecordArray(row.competitors)
        .map((c) => ({ name: this.str(c.name) ?? '', domain: this.str(c.domain) }))
        .filter((c) => c.name.length > 0),
      goals: this.parseStringArray(row.goals),
      approvers: this.parseRecordArray(row.approvers)
        .map((a) => ({ name: this.str(a.name) ?? '', email: this.str(a.email), role: this.str(a.role) }))
        .filter((a) => a.name.length > 0),
      publishing: {
        cms: this.str(publishing.cms),
        constraints: this.str(publishing.constraints),
        styleNotes: this.str(publishing.styleNotes),
      },
    };
  }

  private toVersionRef(row: ProfileRow): ProfileVersionRef {
    return {
      id: row.id,
      version: row.version,
      state: row.confirmedAt ? 'confirmed' : 'draft',
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toDto(
    row: ProfileRow,
    confirmedVersion: ProfileVersionRef | null,
    isLatest: boolean,
  ): BusinessProfileDto {
    const state = row.confirmedAt ? 'confirmed' : 'draft';
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      state,
      isDraft: state === 'draft',
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      data: this.toData(row),
      confirmedVersion,
      isLatest,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ── Row access ──────────────────────────────────────────────────────

  private async requireProject(projectId: string): Promise<{
    id: string;
    name: string;
    domain: string;
    status: string;
    clientId: string | null;
    clientName: string | null;
    onboardingStatus: string;
    onboardingStep: string | null;
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        domain: true,
        status: true,
        clientId: true,
        clientName: true,
        onboardingStatus: true,
        onboardingStep: true,
      },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  private async latestRow(projectId: string): Promise<ProfileRow | null> {
    return this.prisma.businessProfile.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
    });
  }

  private async latestConfirmedRow(projectId: string): Promise<ProfileRow | null> {
    return this.prisma.businessProfile.findFirst({
      where: { projectId, confirmedAt: { not: null } },
      orderBy: { version: 'desc' },
    });
  }

  private async rowByVersion(projectId: string, version: number): Promise<ProfileRow | null> {
    return this.prisma.businessProfile.findUnique({
      where: { projectId_version: { projectId, version } },
    });
  }

  /** Write one append-only audit event. An audit failure must never fail the
   *  business write, but it is logged rather than swallowed. */
  private async audit(input: RecordActivityInput): Promise<void> {
    try {
      await this.activity.record(input);
    } catch (err) {
      this.logger.warn(
        `G04: audit write failed for ${input.resource.type}/${input.resource.id ?? '-'}: ${(err as Error).message}`,
      );
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────

  /**
   * The newest version of any state, or one exact version, or the newest
   * confirmed one.
   *
   * `state: 'confirmed'` exists so a consumer that must not cite a guess has
   * a way to say so in one request instead of fetching the latest and hoping
   * it is confirmed. It 404s when nothing has ever been confirmed — which is
   * a different fact from "the values are empty", and is reported as one.
   */
  async getProfile(
    projectId: string,
    opts: { version?: number; state?: 'latest' | 'confirmed' } = {},
  ): Promise<{
    projectId: string;
    profile: BusinessProfileDto | null;
    confirmedVersion: ProfileVersionRef | null;
    versionCount: number;
    unavailableReason: string | null;
  }> {
    await this.requireProject(projectId);

    const confirmedRow = await this.latestConfirmedRow(projectId);
    const confirmedVersion = confirmedRow ? this.toVersionRef(confirmedRow) : null;
    const versionCount = await this.prisma.businessProfile.count({ where: { projectId } });

    if (opts.version !== undefined) {
      const row = await this.rowByVersion(projectId, opts.version);
      if (!row) {
        throw new NotFoundException(
          `Business profile version ${opts.version} not found for project ${projectId} — versions on file: ${
            versionCount === 0 ? 'none' : `1..${versionCount}`
          }`,
        );
      }
      const latest = await this.latestRow(projectId);
      return {
        projectId,
        profile: this.toDto(row, confirmedVersion, latest?.id === row.id),
        confirmedVersion,
        versionCount,
        unavailableReason: null,
      };
    }

    if (opts.state === 'confirmed') {
      if (!confirmedRow) {
        throw new NotFoundException(
          `Nothing has been confirmed for project ${projectId}${versionCount > 0 ? ` — ${versionCount} draft version(s) exist but no human has confirmed any of them` : ''}`,
        );
      }
      return {
        projectId,
        profile: this.toDto(confirmedRow, confirmedVersion, false),
        confirmedVersion,
        versionCount,
        unavailableReason: null,
      };
    }

    const latest = await this.latestRow(projectId);
    return {
      projectId,
      profile: latest ? this.toDto(latest, confirmedVersion, true) : null,
      confirmedVersion,
      versionCount,
      unavailableReason: latest
        ? null
        : 'No business profile has been drafted for this project yet. The extracted site context on this project is readable, but it is not a confirmed profile.',
    };
  }

  /**
   * The confirmed facts in force, or null. This is the method other modules
   * should call when they need to cite the business — it can never return a
   * draft, and it can never return a scraped value.
   */
  async getConfirmedProfile(projectId: string): Promise<BusinessProfileDto | null> {
    const row = await this.latestConfirmedRow(projectId);
    if (!row) return null;
    const latest = await this.latestRow(projectId);
    return this.toDto(row, this.toVersionRef(row), latest?.id === row.id);
  }

  /** Every version on file, newest first — the audit view of how the facts moved. */
  async listVersions(projectId: string): Promise<{
    projectId: string;
    versions: ProfileVersionRef[];
    latestConfirmedVersion: number | null;
  }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.businessProfile.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
    });
    const confirmed = rows.filter((r) => r.confirmedAt !== null);
    return {
      projectId,
      versions: rows.map((r) => this.toVersionRef(r)),
      latestConfirmedVersion: confirmed.length > 0 ? Math.max(...confirmed.map((r) => r.version)) : null,
    };
  }

  /**
   * Extracted candidates from `SiteContext` — what a crawl or a model guessed.
   *
   * Deliberately a separate endpoint with a separate response shape. There is
   * no `confirmedAt` anywhere in {@link SiteContextCandidateDto} and
   * `provenance` is the literal `'extracted'`, so nothing that renders one of
   * these can present it as a fact the client stood behind. This method never
   * writes, and no other method in this service reads this table.
   */
  async listCandidates(projectId: string): Promise<{
    projectId: string;
    candidates: SiteContextCandidateDto[];
    policy: string;
    latestConfirmedVersion: number | null;
  }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.siteContext.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const confirmedRow = await this.latestConfirmedRow(projectId);
    return {
      projectId,
      candidates: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        provenance: 'extracted' as const,
        confirmed: false as const,
        domain: r.domain,
        brand: r.brand,
        category: r.category,
        vertical: r.vertical,
        description: r.description,
        geo: r.geo,
        markets: this.parseStringArray(r.markets),
        services: this.parseStringArray(r.services),
        icp: this.parseStringArray(r.icp),
        valueProps: this.parseStringArray(r.valueProps),
        painPoints: this.parseStringArray(r.painPoints),
        outcomes: this.parseStringArray(r.outcomes),
        competitors: this.parseRecordArray(r.competitors)
          .map((c) => ({ name: this.str(c.name) ?? '', domain: this.str(c.domain) }))
          .filter((c) => c.name.length > 0),
        extraction: r.extraction,
        llmModel: r.llmModel,
        pagesFetched: r.pagesFetched,
        pageUrls: this.parseStringArray(r.pageUrls),
        costUsd: r.costUsd,
        createdAt: r.createdAt.toISOString(),
      })),
      policy: BUSINESS_PROFILE_PROVENANCE_NOTE,
      latestConfirmedVersion: confirmedRow ? confirmedRow.version : null,
    };
  }

  // ── Business information (P02 — plan §9.1/§9.2) ────────────────────

  /**
   * Field defs that drive both {@link getBusinessInformation} and
   * {@link rejectSuggestion}. A field with no `getSuggested` source (legal
   * name, ICP roles, languages, goals) is confirmed/gap-only — nothing in
   * `SiteContext` extracts it today, so no suggestion is ever fabricated for
   * one.
   */
  private static readonly BUSINESS_INFO_FIELD_DEFS: ReadonlyArray<{
    field: BusinessInfoField;
    section: BusinessInfoSectionKey;
    label: string;
    getConfirmed: (data: BusinessProfileData) => string[] | string | null;
    getSuggested: ((ctx: SiteContextSuggestionSource) => string[] | string | null) | null;
  }> = [
    { field: 'brandName', section: 'about', label: 'Business name', getConfirmed: (d) => d.brandName, getSuggested: (c) => c.brand },
    { field: 'legalName', section: 'about', label: 'Legal name', getConfirmed: (d) => d.legalName, getSuggested: null },
    { field: 'description', section: 'about', label: 'What you do', getConfirmed: (d) => d.description, getSuggested: (c) => c.description },
    { field: 'category', section: 'about', label: 'Business category / type', getConfirmed: (d) => d.category, getSuggested: (c) => c.category },
    { field: 'services', section: 'about', label: 'Products / services', getConfirmed: (d) => d.services, getSuggested: (c) => c.services },
    { field: 'icp.segments', section: 'customers', label: 'Customer types', getConfirmed: (d) => d.icp.segments, getSuggested: (c) => c.icp },
    { field: 'icp.roles', section: 'customers', label: 'Buyer roles', getConfirmed: (d) => d.icp.roles, getSuggested: null },
    { field: 'icp.painPoints', section: 'customers', label: 'Problems customers arrive with', getConfirmed: (d) => d.icp.painPoints, getSuggested: (c) => c.painPoints },
    { field: 'markets', section: 'locations', label: 'Target locations', getConfirmed: (d) => d.markets, getSuggested: (c) => c.markets },
    { field: 'languages', section: 'locations', label: 'Languages', getConfirmed: (d) => d.languages, getSuggested: null },
    { field: 'competitors', section: 'brand', label: 'Named competitors', getConfirmed: (d) => d.competitors.map((c) => (c.domain ? `${c.name} (${c.domain})` : c.name)), getSuggested: (c) => c.competitors.map((x) => (x.domain ? `${x.name} (${x.domain})` : x.name)) },
    { field: 'goals', section: 'brand', label: 'Commercial goals', getConfirmed: (d) => d.goals, getSuggested: null },
  ];

  private static readonly BUSINESS_INFO_SECTIONS: ReadonlyArray<{ key: BusinessInfoSectionKey; label: string }> = [
    { key: 'about', label: 'About your business' },
    { key: 'customers', label: 'Your customers' },
    { key: 'locations', label: 'Target locations and languages' },
    { key: 'brand', label: 'Brand details' },
  ];

  /** Canonical form used for both hashing and equality — sorted/trimmed so
   *  reordering or whitespace differences do not count as a changed value. */
  private normalizeForHash(value: string[] | string | null): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      return JSON.stringify(
        [...value]
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
          .sort(),
      );
    }
    return JSON.stringify(value.trim());
  }

  private hashValue(value: string[] | string | null): string {
    return createHash('sha256').update(this.normalizeForHash(value)).digest('hex');
  }

  private valuesEqual(a: string[] | string | null, b: string[] | string | null): boolean {
    return this.normalizeForHash(a) === this.normalizeForHash(b);
  }

  private isEmptyValue(value: string[] | string | null): boolean {
    if (value === null) return true;
    if (Array.isArray(value)) return value.filter((v) => v.trim().length > 0).length === 0;
    return value.trim().length === 0;
  }

  /** First citation URL per field from a staged-pipeline `SiteContext.fieldSources` column, defensively parsed. */
  private parseFieldSources(raw: string | null | undefined): Record<string, string> {
    const v = this.parseUnknown(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [field, cites] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(cites) || cites.length === 0) continue;
      const first = cites[0] as unknown;
      if (first && typeof first === 'object' && typeof (first as { url?: unknown }).url === 'string') {
        out[field] = (first as { url: string }).url;
      }
    }
    return out;
  }

  /** The newest `SiteContext` row, reshaped to the fields this module can turn into suggestions. */
  private async currentSuggestionSource(
    projectId: string,
  ): Promise<{ row: { id: string; domain: string; pageUrls: string; createdAt: Date } | null; source: SiteContextSuggestionSource | null }> {
    const row = await this.prisma.siteContext.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    if (!row) return { row: null, source: null };
    return {
      row,
      source: {
        brand: this.str(row.brand),
        description: row.description,
        category: row.category,
        services: this.parseStringArray(row.services),
        icp: this.parseStringArray(row.icp),
        painPoints: this.parseStringArray(row.painPoints),
        markets: this.parseStringArray(row.markets),
        competitors: this.parseRecordArray(row.competitors)
          .map((c) => ({ name: this.str(c.name) ?? '', domain: this.str(c.domain) }))
          .filter((c) => c.name.length > 0),
        fieldSources: this.parseFieldSources((row as { fieldSources?: string }).fieldSources),
      },
    };
  }

  /** §9.1 field → the `SiteContext.fieldSources` key that cites it, when P03's staged pipeline produced one. */
  private static readonly FIELD_SOURCE_KEY: Partial<Record<BusinessInfoField, string>> = {
    description: 'description',
    services: 'services',
    'icp.segments': 'icp',
    'icp.painPoints': 'painPoints',
    markets: 'markets',
  };

  /**
   * The §9.1 four-section view: every field grouped as Confirmed / Suggested /
   * Needs information. Shared, byte-for-byte, between the staff and client
   * portal reads — the only difference between the two audiences is the
   * vocabulary the screen wraps this in (§4.3), not the data. Nothing here
   * carries a run id, model name or cost, so it is client-safe by
   * construction (§4.6).
   *
   * A suggestion that exactly repeats a value already recorded in
   * `BusinessProfileRejection` for that field is withheld rather than shown —
   * the resurfacing plan §9.2 says must not happen.
   */
  async getBusinessInformation(projectId: string): Promise<BusinessInfoOverview> {
    await this.requireProject(projectId);
    const latest = await this.latestRow(projectId);
    const confirmedRow = await this.latestConfirmedRow(projectId);
    const data = latest ? this.toData(latest) : this.emptyData();
    const profileState: ProfileState | null = latest ? (latest.confirmedAt ? 'confirmed' : 'draft') : null;

    const { row: ctxRow, source } = await this.currentSuggestionSource(projectId);
    const rejections = await this.prisma.businessProfileRejection.findMany({ where: { projectId } });
    const rejectedSet = new Set(rejections.map((r) => `${r.fieldPath}:${r.valueHash}`));

    const sections = BusinessProfileService.BUSINESS_INFO_SECTIONS.map((def) => ({
      key: def.key,
      label: def.label,
      confirmed: [] as BusinessInfoOverview['sections'][number]['confirmed'],
      suggestions: [] as BusinessInfoOverview['sections'][number]['suggestions'],
      gaps: [] as BusinessInfoOverview['sections'][number]['gaps'],
    }));
    const byKey = new Map(sections.map((s) => [s.key, s]));

    let suppressed = 0;
    const sourcePage = ctxRow ? (this.parseStringArray(ctxRow.pageUrls)[0] ?? ctxRow.domain) : null;

    for (const fieldDef of BusinessProfileService.BUSINESS_INFO_FIELD_DEFS) {
      const current = fieldDef.getConfirmed(data);
      const section = byKey.get(fieldDef.section)!;
      section.confirmed.push({ field: fieldDef.field, label: fieldDef.label, value: current });

      const suggested = source && fieldDef.getSuggested ? fieldDef.getSuggested(source) : null;
      const hasSuggestion = suggested !== null && !this.isEmptyValue(suggested) && !this.valuesEqual(current, suggested);

      if (hasSuggestion && suggested !== null) {
        const hash = this.hashValue(suggested);
        if (rejectedSet.has(`${fieldDef.field}:${hash}`)) {
          suppressed += 1;
        } else {
          // P03: prefer the field's own validated citation over the
          // whole-context "first page read" fallback, when the staged
          // pipeline recorded one for this exact field.
          const sourceKey = BusinessProfileService.FIELD_SOURCE_KEY[fieldDef.field];
          const fieldSourcePage = sourceKey ? source?.fieldSources[sourceKey] : undefined;
          section.suggestions.push({
            field: fieldDef.field,
            section: fieldDef.section,
            label: fieldDef.label,
            currentValue: current,
            suggestedValue: suggested,
            sourcePage: fieldSourcePage ?? sourcePage,
            sourceDate: (ctxRow as { createdAt: Date }).createdAt.toISOString(),
          });
        }
      }

      if (this.isEmptyValue(current) && !hasSuggestion) {
        section.gaps.push({ field: fieldDef.field, section: fieldDef.section, label: fieldDef.label });
      }
    }

    return {
      projectId,
      profileState,
      confirmedVersion: confirmedRow
        ? {
            id: confirmedRow.id,
            version: confirmedRow.version,
            state: 'confirmed' as const,
            confirmedAt: (confirmedRow.confirmedAt as Date).toISOString(),
            createdAt: confirmedRow.createdAt.toISOString(),
          }
        : null,
      sections,
      suppressedRejectedCount: suppressed,
      hasSiteContext: ctxRow !== null,
      sourceCheckedAt: ctxRow ? ctxRow.createdAt.toISOString() : null,
    };
  }

  /**
   * Target locations (P04, plan §10.2/§10.4) — the structured confirmed/
   * drafted targets, the still-open site-evidence suggestions, and a real
   * per-provider support preview. This is what the Business information →
   * Target locations screen reads, and what a results screen's "what we
   * checked" detail can cite alongside a run.
   *
   * Suggestions are computed the same way every other §9.1 field's
   * suggestions are: read live from the newest `SiteContext.markets`
   * (P03's ranked ISO-3166 alpha-2 service-area evidence), diffed against
   * the current confirmed-or-drafted targets, and never stored or
   * auto-applied. A country already an active target (confirmed or
   * drafted) is not re-suggested.
   */
  async getTargetLocations(projectId: string): Promise<TargetLocationsOverview> {
    await this.requireProject(projectId);
    const latest = await this.latestRow(projectId);
    const confirmedRow = await this.latestConfirmedRow(projectId);
    const data = latest ? this.toData(latest) : this.emptyData();
    const profileState: ProfileState | null = latest ? (latest.confirmedAt ? 'confirmed' : 'draft') : null;

    const { row: ctxRow, source } = await this.currentSuggestionSource(projectId);
    const currentCountries = new Set(data.targets.filter((t) => t.active).map((t) => t.country));
    const suggestedCountries = (source?.markets ?? [])
      .map((m) => m.trim().toUpperCase())
      .filter((m) => /^[A-Z]{2}$/.test(m))
      .filter((m) => !currentCountries.has(m));

    return {
      projectId,
      profileState,
      confirmedVersion: confirmedRow
        ? {
            id: confirmedRow.id,
            version: confirmedRow.version,
            state: 'confirmed' as const,
            confirmedAt: (confirmedRow.confirmedAt as Date).toISOString(),
            createdAt: confirmedRow.createdAt.toISOString(),
          }
        : null,
      targets: data.targets,
      suggestedCountries,
      providerSupport: previewProviderSupport(data.targets),
      hasSiteContext: ctxRow !== null,
      sourceCheckedAt: ctxRow ? ctxRow.createdAt.toISOString() : null,
    };
  }

  /**
   * The active target countries on the newest CONFIRMED profile, in priority
   * order — the one method other modules should call for "where is this
   * project's measurement scope" (plan §10.2 step 5). Returns `[]` when
   * nothing is confirmed or no confirmed profile has any active target;
   * callers must not treat an empty array as "no opinion, pick something" —
   * see `aeo-audit.service.ts`'s `resolveDefaultMarket`, which is the
   * consumer this exists for.
   */
  async getConfirmedTargetCountries(projectId: string): Promise<string[]> {
    const row = await this.latestConfirmedRow(projectId);
    if (!row) return [];
    const data = this.toData(row);
    return data.targets.filter((t) => t.active).map((t) => t.country);
  }

  /**
   * "Keep current" on one field — records that this exact suggested value was
   * seen and declined, so a later recrawl producing the SAME value does not
   * present it again. The value rejected is read from the current
   * `SiteContext`, never trusted from the request body, so a caller cannot
   * record a rejection of a value nothing ever suggested.
   */
  async rejectSuggestion(
    projectId: string,
    dto: RejectBusinessProfileSuggestionDto,
    actor: { type: 'operator' | 'client'; id: string | null },
  ): Promise<{ field: string; rejected: boolean; detail: string }> {
    await this.requireProject(projectId);
    const field = dto.field as BusinessInfoField;
    const fieldDef = BusinessProfileService.BUSINESS_INFO_FIELD_DEFS.find((f) => f.field === field);
    if (!fieldDef || !fieldDef.getSuggested) {
      throw new NotFoundException(`"${dto.field}" has no suggested value to decline.`);
    }

    const { row: ctxRow, source } = await this.currentSuggestionSource(projectId);
    if (!ctxRow || !source) {
      throw new ConflictException(`Project ${projectId} has no extracted site context, so there is no suggestion for "${field}" to decline.`);
    }
    const suggested = fieldDef.getSuggested(source);
    if (suggested === null || this.isEmptyValue(suggested)) {
      throw new ConflictException(`There is no current suggestion for "${field}" to decline.`);
    }

    const latest = await this.latestRow(projectId);
    const currentData = latest ? this.toData(latest) : this.emptyData();
    const current = fieldDef.getConfirmed(currentData);
    if (this.valuesEqual(current, suggested)) {
      throw new ConflictException(`"${field}" already matches the current confirmed/drafted value — there is nothing to decline.`);
    }

    const hash = this.hashValue(suggested);
    await this.prisma.businessProfileRejection.upsert({
      where: { projectId_fieldPath_valueHash: { projectId, fieldPath: field, valueHash: hash } },
      update: {},
      create: {
        projectId,
        fieldPath: field,
        valueHash: hash,
        value: JSON.stringify(suggested),
        actorType: actor.type,
        actorId: actor.id,
      },
    });

    await this.audit({
      actor: { type: actor.type === 'client' ? 'user' : actor.id ? 'user' : 'system', id: actor.id, label: null },
      action: 'updated',
      resource: { type: 'business-profile', id: projectId, version: null },
      projectId,
      summary: `Suggested "${field}" declined — kept the current value`,
      changes: { field, declinedValue: suggested, actorType: actor.type },
      origin: 'api',
    });

    return {
      field,
      rejected: true,
      detail: `Kept the current value for "${field}". This suggestion will not be shown again unless the site's value changes.`,
    };
  }

  // ── Draft write ─────────────────────────────────────────────────────

  /**
   * §29 competitor-cap enforcement. Resolves the owning client's
   * `Client.planTier` (the same field/read pattern `refresh-cadence` uses:
   * a direct `prisma.client.findUnique` on `planTier`, never a derived
   * guess) and throws a dedicated, distinguishable 422
   * ({@link CompetitorCapExceededException}) when `newCount` would exceed
   * that tier's cap. A project with no `clientId` (not yet attached to a
   * client account) is treated as `starter` — the most conservative default.
   *
   * The thrown payload is shaped so the frontend can render this as an
   * upsell moment rather than a generic validation error: `error:
   * 'competitor-cap-exceeded'`, plus the numbers needed to build a "You're
   * on the Starter plan (5 competitors) — upgrade to track more" message.
   */
  private async enforceCompetitorCap(clientId: string | null, newCount: number): Promise<void> {
    let tier: string | null = null;
    if (clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: clientId },
        select: { planTier: true },
      });
      tier = client?.planTier ?? null;
    }
    const cap = competitorCapForTier(tier);
    if (cap !== null && newCount > cap) {
      throw new CompetitorCapExceededException(normalizePlanTier(tier), cap, newCount);
    }
  }

  /**
   * Merge a patch onto the working draft.
   *
   * Two cases, and the difference matters:
   *
   * - The newest row is an unconfirmed draft: it is updated in place. Nothing
   *   confirmed is being touched — the row has no `confirmedAt`, so no human
   *   ever stood behind its contents.
   * - The newest row is confirmed (or there is no row): a NEW version is
   *   created, seeded from the confirmed values and then patched. The
   *   confirmed row is left exactly as it was.
   *
   * There is no third case in which a confirmed row is edited.
   */
  async saveDraft(projectId: string, dto: SaveBusinessProfileDto, actorId: string | null): Promise<SaveProfileResult> {
    const project = await this.requireProject(projectId);

    const latest = await this.latestRow(projectId);
    const base = latest ? this.toData(latest) : this.emptyData();
    const { data, warnings } = this.merge(base, dto);

    // §29 competitor cap — only blocks a save that would *increase* the
    // competitor count past the client's plan-tier limit. A client already
    // over the cap (e.g. grandfathered from before this cap existed) can
    // still edit/remove competitors or save unrelated fields; they just
    // cannot add more until they're back under the cap. See
    // `lib/competitor-cap.util.ts` for the tier numbers and reasoning.
    if (dto.competitors !== undefined && data.competitors.length > base.competitors.length) {
      await this.enforceCompetitorCap(project.clientId, data.competitors.length);
    }

    const columns = {
      brandName: data.brandName,
      legalName: data.legalName,
      description: data.description,
      category: data.category,
      services: JSON.stringify(data.services),
      icp: JSON.stringify(data.icp),
      markets: JSON.stringify(data.markets),
      languages: JSON.stringify(data.languages),
      targets: JSON.stringify(data.targets),
      facts: JSON.stringify(data.facts),
      competitors: JSON.stringify(data.competitors),
      goals: JSON.stringify(data.goals),
      approvers: JSON.stringify(data.approvers),
      publishing: JSON.stringify(data.publishing),
    };

    let row: ProfileRow;
    let created: boolean;
    if (latest && latest.confirmedAt === null) {
      row = await this.prisma.businessProfile.update({ where: { id: latest.id }, data: columns });
      created = false;
    } else {
      row = await this.prisma.businessProfile.create({
        data: { projectId, version: (latest?.version ?? 0) + 1, ...columns },
      });
      created = true;
    }

    const confirmedRow = await this.latestConfirmedRow(projectId);
    await this.audit({
      actor: { type: actorId ? 'user' : 'system', id: actorId, label: null },
      action: created ? 'created' : 'updated',
      resource: { type: 'business-profile', id: row.id, version: String(row.version) },
      projectId,
      summary: created
        ? `Business profile draft created (version ${row.version})`
        : `Business profile draft updated (version ${row.version})`,
      changes: {
        note: dto.note ?? null,
        fields: Object.keys(dto).filter((k) => k !== 'note'),
        baseVersion: latest ? latest.version : null,
        baseState: latest ? (latest.confirmedAt ? 'confirmed' : 'draft') : null,
        warnings,
      },
      origin: 'api',
    });

    return {
      profile: this.toDto(row, confirmedRow ? this.toVersionRef(confirmedRow) : null, true),
      warnings,
    };
  }

  // ── Confirmation ────────────────────────────────────────────────────

  /**
   * Confirm a draft. This INSERTs a new version carrying `confirmedBy`/`confirmedAt`
   * and leaves the draft row untouched.
   *
   * Why a new row rather than stamping the draft: the draft is the record of
   * exactly what the confirming human was shown. Stamping it would destroy
   * that — after the next edit round nobody could prove which words were
   * agreed to. The draft stays as the proposal; the new row is the fact.
   *
   * Refusals are specific, because "you cannot confirm this" is useless on its
   * own: confirming an already-confirmed version, confirming a draft that a
   * newer confirmed version has superseded, and confirming when no draft
   * exists are three different situations with three different fixes.
   */
  async confirm(
    projectId: string,
    dto: ConfirmBusinessProfileDto,
    actorId: string,
  ): Promise<{ profile: BusinessProfileDto; confirmedFrom: ProfileVersionRef; warnings: string[] }> {
    await this.requireProject(projectId);

    const latest = await this.latestRow(projectId);
    const latestConfirmed = await this.latestConfirmedRow(projectId);

    let candidate: ProfileRow | null;
    if (dto.version !== undefined) {
      candidate = await this.rowByVersion(projectId, dto.version);
      if (!candidate) {
        throw new NotFoundException(`Business profile version ${dto.version} not found for project ${projectId}`);
      }
    } else {
      candidate = await this.prisma.businessProfile.findFirst({
        where: { projectId, confirmedAt: null },
        orderBy: { version: 'desc' },
      });
    }

    if (!candidate) {
      throw new ConflictException(
        latest
          ? `Nothing to confirm for project ${projectId}: version ${latest.version} is already confirmed. Edit the profile to create a new draft, then confirm that.`
          : `Project ${projectId} has no business profile to confirm. Save a draft first (PUT /api/projects/${projectId}/business-profile).`,
      );
    }
    if (candidate.confirmedAt !== null) {
      throw new ConflictException(
        `Version ${candidate.version} is already confirmed (by ${candidate.confirmedBy ?? 'unknown'} at ${candidate.confirmedAt.toISOString()}). Confirming it again would write a duplicate; edit the profile to draft the next version instead.`,
      );
    }
    if (latestConfirmed && candidate.version < latestConfirmed.version) {
      throw new ConflictException(
        `Draft version ${candidate.version} was superseded by confirmed version ${latestConfirmed.version}. Confirm version ${latestConfirmed.version}, or save a new draft from it and confirm that.`,
      );
    }

    const data = this.toData(candidate);
    const warnings = this.validateForConfirmation(data);

    // Confirming a completely empty draft is refused — there would be nothing
    // for the recorded confirmation to be *of*. Anything else is allowed: an
    // incomplete-but-substantive profile is a normal first call, and the gaps
    // are reported in `warnings` and written to the audit event rather than
    // being turned into a note the operator would type "ok" into.
    if (this.isEmptyDraft(data)) {
      throw new ConflictException(
        `Version ${candidate.version} is an empty draft, so there is nothing to confirm. Fill in at least the brand name, a description and the services offered ` +
          `(PUT /api/projects/${projectId}/business-profile), then confirm.`,
      );
    }

    const nextVersion = (latest?.version ?? 0) + 1;
    const confirmedRow = await this.prisma.businessProfile.create({
      data: {
        projectId,
        version: nextVersion,
        brandName: data.brandName,
        legalName: data.legalName,
        description: data.description,
        category: data.category,
        services: JSON.stringify(data.services),
        icp: JSON.stringify(data.icp),
        markets: JSON.stringify(data.markets),
        languages: JSON.stringify(data.languages),
        targets: JSON.stringify(data.targets),
        facts: JSON.stringify(data.facts),
        competitors: JSON.stringify(data.competitors),
        goals: JSON.stringify(data.goals),
        approvers: JSON.stringify(data.approvers),
        publishing: JSON.stringify(data.publishing),
        confirmedBy: actorId,
        confirmedAt: new Date(),
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'approved',
      resource: { type: 'business-profile', id: confirmedRow.id, version: String(confirmedRow.version) },
      projectId,
      summary: `Business profile version ${confirmedRow.version} confirmed from draft version ${candidate.version}`,
      changes: { fromVersion: candidate.version, toVersion: confirmedRow.version, note: dto.note ?? null, warnings },
      origin: 'api',
    });

    return {
      profile: this.toDto(confirmedRow, this.toVersionRef(confirmedRow), true),
      confirmedFrom: this.toVersionRef(candidate),
      warnings,
    };
  }

  // ── Explicit propagation ────────────────────────────────────────────

  /**
   * Propagate confirmed facts outward — the ONLY path that does.
   *
   * Confirming a version changes nothing else on the project; this endpoint
   * exists so "the client changed their competitors on Tuesday" does not
   * quietly rewrite a roadmap on Wednesday. The caller names the targets, the
   * source is a CONFIRMED version (`targets` cannot be satisfied from a
   * draft), and the response states plainly which artifacts were left alone
   * and which endpoint owns each of them.
   *
   * `dryRun` reports exactly what would change without writing, so the
   * operator can see the diff before committing to it.
   */
  async rebuild(projectId: string, dto: RebuildFromProfileDto, actorId: string): Promise<RebuildResult> {
    const project = await this.requireProject(projectId);

    let source: ProfileRow | null;
    if (dto.version !== undefined) {
      source = await this.rowByVersion(projectId, dto.version);
      if (!source) {
        throw new NotFoundException(`Business profile version ${dto.version} not found for project ${projectId}`);
      }
      if (source.confirmedAt === null) {
        throw new ConflictException(
          `Version ${source.version} is a draft. A rebuild may only read a confirmed version — confirm it first, or name a confirmed version.`,
        );
      }
    } else {
      source = await this.latestConfirmedRow(projectId);
      if (!source) {
        throw new ConflictException(
          `Project ${projectId} has no confirmed business profile version, so there is nothing to propagate. Confirm a version first (POST /api/projects/${projectId}/business-profile/confirm), or name an already-confirmed version explicitly.`,
        );
      }
    }

    const data = this.toData(source);
    const changes: RebuildChange[] = [];

    for (const target of dto.targets) {
      if (target === 'project-competitors') {
        changes.push(await this.rebuildProjectCompetitors(project.id, data.competitors, dto.dryRun === true));
      }
    }

    const applied = changes.some((c) => c.changed);

    if (!dto.dryRun && applied) {
      await this.audit({
        actor: { type: 'user', id: actorId, label: null },
        action: 'updated',
        resource: { type: 'business-profile', id: source.id, version: String(source.version) },
        projectId,
        clientId: project.clientId,
        summary: `Explicit rebuild from confirmed business profile version ${source.version}`,
        changes: {
          reason: dto.reason,
          targets: dto.targets,
          changes: changes.map((c) => ({ target: c.target, added: c.added, alreadyPresent: c.alreadyPresent })),
        },
        origin: 'api',
      });
    }

    return {
      projectId,
      sourceVersion: source.version,
      sourceState: 'confirmed',
      reason: dto.reason,
      dryRun: dto.dryRun === true,
      changes,
      notTouched: DOWNSTREAM_NOT_TOUCHED.map((d) => ({ artifact: d.artifact, endpoint: d.endpoint })),
    };
  }

  /**
   * Merge the confirmed competitor names into `Project.competitors`, which is
   * the JSON column the intake pipeline seeds and share-of-voice reads.
   *
   * A merge, not a replace: the confirmed list is the client's own naming of
   * their rivals, and intake may have discovered others. Adding to the set
   * cannot lose evidence; overwriting it could, so this never overwrites.
   */
  private async rebuildProjectCompetitors(
    projectId: string,
    confirmed: CompetitorShape[],
    dryRun: boolean,
  ): Promise<RebuildChange> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { competitors: true },
    });
    const existing = this.parseRecordArray(project?.competitors)
      .map((c) => ({ name: this.str(c.name) ?? '', domain: this.str(c.domain) }))
      .filter((c) => c.name.length > 0);

    const before = existing.map((c) => (c.domain ? `${c.name} (${c.domain})` : c.name));
    const key = (c: CompetitorShape): string => (c.domain ? `d:${c.domain.toLowerCase()}` : `n:${c.name.toLowerCase()}`);
    const seen = new Set(existing.map(key));

    const added: CompetitorShape[] = [];
    const alreadyPresent: string[] = [];
    for (const c of confirmed) {
      if (c.name.trim().length === 0) continue;
      const k = key(c);
      if (seen.has(k)) {
        alreadyPresent.push(c.domain ? `${c.name} (${c.domain})` : c.name);
        continue;
      }
      seen.add(k);
      added.push({ name: c.name, domain: c.domain });
    }

    const after = [...existing, ...added].map((c) => (c.domain ? `${c.name} (${c.domain})` : c.name));
    const changed = added.length > 0;

    if (!dryRun && changed) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { competitors: JSON.stringify([...existing, ...added]) },
      });
    }

    return {
      target: 'project-competitors',
      applied: !dryRun,
      changed,
      before,
      after,
      added: added.map((c) => (c.domain ? `${c.name} (${c.domain})` : c.name)),
      alreadyPresent,
      detail: changed
        ? dryRun
          ? `${added.length} confirmed competitor(s) would be added to the project's competitor list; ${alreadyPresent.length} already present.`
          : `${added.length} confirmed competitor(s) added to the project's competitor list; ${alreadyPresent.length} already present.`
        : confirmed.length === 0
          ? 'The confirmed profile names no competitors, so the project competitor list is unchanged.'
          : `All ${alreadyPresent.length} confirmed competitor(s) are already on the project; nothing to add.`,
    };
  }

  // ── Attachment ──────────────────────────────────────────────────────

  private ownershipOf(project: { clientId: string | null; clientName: string | null }, clientDisplayName: string | null): ProjectOwnershipDto {
    return {
      clientId: project.clientId,
      clientName: project.clientName,
      established: project.clientId !== null,
      clientDisplayName,
      labelWithoutOwnership: project.clientId === null && project.clientName !== null,
    };
  }

  /**
   * Every other project whose domain is the same host once normalized.
   *
   * `Project.domain` is unique on the raw string, so `example.com` and
   * `https://www.example.com/` are two rows as far as the database is
   * concerned. This is the check that catches that, and it is deliberately
   * global rather than per-client: one domain cannot be owned by two clients,
   * so a collision against ANY project has to be resolved rather than
   * attached around.
   */
  private async findDomainConflicts(
    normalized: string,
    excludeProjectId: string,
  ): Promise<Array<{ projectId: string; name: string; domain: string; clientId: string | null }>> {
    const rows = await this.prisma.project.findMany({
      where: { NOT: { id: excludeProjectId } },
      select: { id: true, name: true, domain: true, clientId: true },
    });
    return rows
      .filter((r) => tryNormalizeDomain(r.domain) === normalized)
      .map((r) => ({ projectId: r.id, name: r.name, domain: r.domain, clientId: r.clientId }));
  }

  /**
   * Preflight for the attach screen: what would happen, without writing.
   *
   * Same rules as {@link attachProject}, so a wizard can disable the button
   * and explain why instead of letting the operator discover the refusal on
   * submit.
   */
  async checkAttachment(clientId: string, projectId: string): Promise<AttachmentCheckResult> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);
    const project = await this.requireProject(projectId);

    const blockers: string[] = [];
    const warnings: string[] = [];

    const normalized = tryNormalizeDomain(project.domain);
    let conflict: AttachmentCheckResult['domainConflict'] = null;
    if (normalized) {
      const conflicts = await this.findDomainConflicts(normalized, projectId);
      if (conflicts.length > 0) {
        const first = conflicts[0];
        conflict = first;
        blockers.push(
          `Domain "${normalized}" is already on project ${first.projectId} ("${first.name}", ${
            first.clientId ? `client ${first.clientId}` : 'no client attached'
          }). One domain cannot belong to two clients — attach that project instead, or correct this one's domain first (PUT /api/clients/${clientId}/projects/${projectId}/domain).`,
        );
      }
    } else {
      warnings.push(
        `This project's stored domain "${project.domain}" is not a valid hostname, so the duplicate-domain check could not run. Correct it before relying on this check.`,
      );
    }

    const alreadyAttached = project.clientId === clientId;
    const reassignmentRequired = project.clientId !== null && project.clientId !== clientId;
    if (reassignmentRequired) {
      warnings.push(
        `This project currently belongs to client ${project.clientId}. Attaching it to ${client.name} moves it — that requires reassign: true and is recorded in the audit trail.`,
      );
    }

    return {
      projectId,
      clientId,
      attachable: blockers.length === 0,
      alreadyAttached,
      reassignmentRequired,
      ownership: this.ownershipOf(project, project.clientId ? await this.clientName(project.clientId) : null),
      domainConflict: conflict,
      blockers,
      warnings,
    };
  }

  private async clientName(clientId: string): Promise<string | null> {
    const c = await this.prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
    return c ? c.name : null;
  }

  /**
   * Attach (or explicitly reassign) a project to a client — the authorized
   * escape hatch for §5.3's "creating a client project fails on an existing
   * domain", and the endpoint that establishes ownership.
   *
   * Three things this refuses to do:
   *
   * - It never resolves a client from `Project.clientName`. A project whose
   *   only connection to a client is that legacy string is treated as
   *   UNATTACHED (`ownership.established === false`), and the response says so
   *   rather than letting a label act as a foreign key.
   * - It never moves a project away from another client as a side effect.
   *   `reassign: true` is required, so a stale wizard tab cannot relink
   *   somebody's project by being resubmitted.
   * - It never attaches a project whose domain is already claimed by another
   *   project, in any normalization of it.
   */
  async attachProject(
    clientId: string,
    projectId: string,
    dto: AttachProjectDto,
    actorId: string,
  ): Promise<ProjectAttachmentDto & { warnings: string[] }> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const project = await this.requireProject(projectId);
    const warnings: string[] = [];

    // The unnamed-but-present legacy label is the trap this endpoint exists to
    // avoid: report it, never honour it.
    if (project.clientId === null && project.clientName !== null) {
      warnings.push(
        `This project carried the display label clientName="${project.clientName}" with no clientId. That label never established ownership — the project was unattached until now, and ownership comes from the clientId this call sets.`,
      );
    }

    if (dto.expectedCurrentClientId !== undefined && dto.expectedCurrentClientId !== project.clientId) {
      throw new ConflictException(
        `This project's client is ${
          project.clientId ?? 'nothing (unattached)'
        }, not ${dto.expectedCurrentClientId ?? 'nothing'}. Reload the project and re-check before attaching.`,
      );
    }

    const reassignedFrom = project.clientId !== null && project.clientId !== clientId ? project.clientId : null;
    if (reassignedFrom !== null && dto.reassign !== true) {
      throw new ConflictException(
        `Project ${projectId} already belongs to client ${reassignedFrom}. Moving it to ${clientId} is a reassignment — resend with reassign: true, which records the move in the audit trail.`,
      );
    }
    if (reassignedFrom === null && dto.reassign === true && project.clientId === clientId) {
      warnings.push('Already attached to this client; reassign: true had no effect.');
    }

    const normalized = tryNormalizeDomain(project.domain);
    if (normalized) {
      const conflicts = await this.findDomainConflicts(normalized, projectId);
      if (conflicts.length > 0) {
        const first = conflicts[0];
        const message =
          `Domain "${normalized}" is also on project ${first.projectId} ("${first.name}", ${
            first.clientId ? `client ${first.clientId}` : 'no client attached'
          }).`;
        if (project.clientId === clientId) {
          // The project is already owned by the client named in the URL, so
          // this call acquires nothing: refusing it would make a resubmitted
          // wizard screen fail on data it did not create and cannot fix from
          // here. The collision is still reported, as a warning, because it
          // does need resolving.
          warnings.push(
            `${message} This project is already attached to this client, so ownership is unchanged — but two projects for one domain is inconsistent data. Resolve it by correcting one project's domain (PUT /api/clients/${clientId}/projects/${projectId}/domain).`,
          );
        } else {
          throw new ConflictException(
            `A duplicate domain blocks this attach: ${message} One domain cannot belong to two clients — attach that project instead, or correct this one's domain first (PUT /api/clients/${clientId}/projects/${projectId}/domain).`,
          );
        }
      }
    } else {
      warnings.push(
        `Domain "${project.domain}" is not a valid hostname, so the duplicate-domain check could not run. Correct it (PUT /api/clients/${clientId}/projects/${projectId}/domain) and re-check.`,
      );
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        clientId,
        // The legacy label is kept in step with the owner so the pre-clients
        // UI keeps showing the right brand, but it is written FROM clientId,
        // never read TO it. An explicit dto.clientName wins because it is a
        // deliberate display choice.
        ...(dto.clientName !== undefined
          ? { clientName: dto.clientName }
          : project.clientName === null
            ? { clientName: client.name }
            : {}),
      },
      select: {
        id: true,
        name: true,
        domain: true,
        status: true,
        clientId: true,
        clientName: true,
        onboardingStatus: true,
        onboardingStep: true,
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'granted',
      resource: { type: 'project', id: projectId, version: null },
      projectId,
      clientId,
      summary: reassignedFrom
        ? `Project reassigned from client ${reassignedFrom} to client ${clientId}`
        : `Project attached to client ${clientId}`,
      changes: {
        clientId: { before: project.clientId, after: clientId },
        clientNameLabel: { before: project.clientName, after: updated.clientName },
        note: dto.note ?? null,
      },
      origin: 'api',
    });

    return {
      project: {
        id: updated.id,
        name: updated.name,
        domain: updated.domain,
        status: updated.status,
        onboardingStatus: updated.onboardingStatus,
        onboardingStep: updated.onboardingStep,
      },
      ownership: this.ownershipOf(updated, client.name),
      attached: updated.clientId === clientId,
      reassignedFrom,
      warnings,
    };
  }

  /**
   * Correct a project's domain.
   *
   * This is not a display-label edit: the domain is what every later crawl,
   * audit and report is keyed on, so it takes validated normalization, a
   * global conflict check, an ownership check, a mandatory reason and an audit
   * record. The `@unique` constraint is the last line of defence; a race that
   * beats the pre-check surfaces as a 409 here rather than a 500.
   */
  async correctDomain(
    clientId: string,
    projectId: string,
    dto: CorrectDomainDto,
    actorId: string,
  ): Promise<DomainCorrectionResult> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const project = await this.requireProject(projectId);
    // Ownership check: the URL's clientId must be the project's actual owner.
    // A project with only a legacy `clientName` is unattached and must be
    // attached before its domain can be changed.
    if (project.clientId !== clientId) {
      throw new NotFoundException(
        project.clientId === null
          ? `Project ${projectId} is not attached to any client, so it has no domain to correct under client ${clientId}. Attach it first (PUT /api/clients/${clientId}/projects/${projectId}/attach).`
          : `Project ${projectId} does not belong to client ${clientId}`,
      );
    }

    const normalized = normalizeDomain(dto.domain);
    const before = project.domain;
    const warnings: string[] = [];

    if (normalized === before) {
      return { projectId, changed: false, before, after: before, normalized, warnings: ['Domain is already this value; nothing was written.'] };
    }

    const conflicts = await this.findDomainConflicts(normalized, projectId);
    if (conflicts.length > 0) {
      const first = conflicts[0];
      throw new ConflictException(
        `Domain "${normalized}" is already on project ${first.projectId} ("${first.name}", ${
          first.clientId ? `client ${first.clientId}` : 'no client attached'
        }). Resolve that project first — two projects cannot share a domain.`,
      );
    }

    try {
      await this.prisma.project.update({ where: { id: projectId }, data: { domain: normalized } });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`Domain "${normalized}" was taken by another project while this request was in flight.`);
      }
      throw err;
    }

    const previousNormalized = tryNormalizeDomain(before);
    if (previousNormalized === null) {
      warnings.push(`The previous value "${before}" was not a valid hostname; it is replaced rather than kept anywhere.`);
    }

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'updated',
      resource: { type: 'project', id: projectId, version: null },
      projectId,
      clientId,
      summary: `Project domain corrected from "${before}" to "${normalized}"`,
      changes: { domain: { before, after: normalized }, reason: dto.reason },
      origin: 'api',
    });

    return { projectId, changed: true, before, after: normalized, normalized, warnings };
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
  }

  // ── Onboarding requests ─────────────────────────────────────────────

  private async requireRequest(projectId: string, requestId: string) {
    const row = await this.prisma.onboardingRequest.findFirst({ where: { id: requestId, projectId } });
    if (!row) throw new NotFoundException(`Onboarding request ${requestId} not found for project ${projectId}`);
    return row;
  }

  /**
   * Every blockedWork id must name a work item ON THIS PROJECT. A foreign id
   * is a 404, not a 403 — a caller who guesses another project's work-item id
   * must not learn that it exists.
   */
  private async assertBlockedWorkBelongs(projectId: string, ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return;
    const found = await this.prisma.workItem.findMany({
      where: { id: { in: unique }, projectId },
      select: { id: true },
    });
    const known = new Set(found.map((w) => w.id));
    const foreign = unique.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      throw new NotFoundException(
        `blockedWork references work item(s) not found on project ${projectId}: ${foreign.join(', ')}`,
      );
    }
  }

  /** Resolve blockedWork ids to work items, reporting ids that no longer exist
   *  rather than dropping them — a deleted blocker is a fact worth showing.
   *  Scoped by `projectId` as well as id, so a legacy or hand-inserted row
   *  naming another project's work item resolves to nothing rather than
   *  leaking its title across the project boundary. */
  private async resolveBlockedWork(projectId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.workItem.findMany({
      where: { id: { in: ids }, projectId },
      select: { id: true, title: true, status: true, cycleId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      return row
        ? { id: row.id, title: row.title, status: row.status, cycleId: row.cycleId, missing: false }
        : { id, title: null, status: null, cycleId: null, missing: true };
    });
  }

  private async toRequestDto(row: {
    id: string;
    projectId: string;
    kind: string;
    title: string;
    detail: string | null;
    requestedOf: string | null;
    requestedBy: string | null;
    dueAt: Date | null;
    status: string;
    blockedWork: string;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<OnboardingRequestDto> {
    const blockedWork = this.parseStringArray(row.blockedWork);
    const links = await this.resolveBlockedWork(row.projectId, blockedWork);
    const status = row.status as OnboardingRequestStatus;
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      requestedOf: row.requestedOf,
      requestedBy: row.requestedBy,
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      status,
      blockedWork,
      blockedWorkLinks: links,
      outstanding: OPEN_REQUEST_STATUSES.includes(status),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      resolvedBy: row.resolvedBy,
      overdue: row.dueAt !== null && OPEN_REQUEST_STATUSES.includes(status) && row.dueAt.getTime() < Date.now(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listRequests(
    projectId: string,
    filters: { status?: string; kind?: string; outstanding?: boolean } = {},
  ): Promise<{ projectId: string; requests: OnboardingRequestDto[]; counts: Record<string, number> }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.onboardingRequest.findMany({
      where: {
        projectId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.outstanding ? { status: { in: [...OPEN_REQUEST_STATUSES] } } : {}),
      },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
    });
    const all = await this.prisma.onboardingRequest.findMany({ where: { projectId }, select: { status: true } });
    const counts: Record<string, number> = { open: 0, 'in-progress': 0, done: 0, waived: 0 };
    for (const r of all) counts[r.status] = (counts[r.status] ?? 0) + 1;

    const requests: OnboardingRequestDto[] = [];
    for (const row of rows) requests.push(await this.toRequestDto(row));
    return { projectId, requests, counts };
  }

  async createRequest(
    projectId: string,
    dto: CreateOnboardingRequestDto,
    actorId: string,
  ): Promise<OnboardingRequestDto> {
    const project = await this.requireProject(projectId);
    const blockedWork = dto.blockedWork ?? [];
    await this.assertBlockedWorkBelongs(projectId, blockedWork);

    let dueAt: Date | null = null;
    if (dto.dueAt) {
      const parsed = new Date(dto.dueAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new ConflictException(`dueAt "${dto.dueAt}" is not a parseable date.`);
      }
      dueAt = parsed;
    }

    const row = await this.prisma.onboardingRequest.create({
      data: {
        projectId,
        kind: dto.kind,
        title: dto.title,
        detail: dto.detail ?? null,
        requestedOf: dto.requestedOf ?? null,
        requestedBy: actorId,
        dueAt,
        blockedWork: JSON.stringify(blockedWork),
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'created',
      resource: { type: 'onboarding-request', id: row.id, version: null },
      projectId,
      clientId: project.clientId,
      summary: `Access request raised (${row.kind}): ${row.title}`,
      changes: { kind: row.kind, blockedWork, dueAt: row.dueAt ? row.dueAt.toISOString() : null },
      origin: 'api',
      // The client is the one being asked, so they may see it.
      clientVisible: true,
    });

    return this.toRequestDto(row);
  }

  /**
   * Operator update. Status moves are checked against
   * {@link ONBOARDING_REQUEST_TRANSITIONS} — resolving and reopening are both
   * recorded, and `resolvedAt`/`resolvedBy` are cleared on reopen rather than
   * left asserting a resolution that no longer holds.
   */
  async updateRequest(
    projectId: string,
    requestId: string,
    dto: UpdateOnboardingRequestDto,
    actorId: string,
    opts: { allowedStatuses?: string[]; actorLabel?: 'operator' | 'client' } = {},
  ): Promise<OnboardingRequestDto> {
    const project = await this.requireProject(projectId);
    const row = await this.requireRequest(projectId, requestId);

    if (dto.status !== undefined) {
      const from = row.status as OnboardingRequestStatus;
      const to = dto.status as OnboardingRequestStatus;
      if (opts.allowedStatuses && !opts.allowedStatuses.includes(to)) {
        throw new ConflictException(
          `A ${opts.actorLabel ?? 'caller'} may not set status "${to}" on an onboarding request — permitted: ${opts.allowedStatuses.join(', ')}.`,
        );
      }
      if (from !== to && !ONBOARDING_REQUEST_TRANSITIONS[from].includes(to)) {
        throw new ConflictException(
          `Onboarding request ${requestId} is "${from}" and cannot move to "${to}". Permitted from "${from}": ${
            ONBOARDING_REQUEST_TRANSITIONS[from].join(', ') || 'none — it is closed'
          }.`,
        );
      }
    }

    if (dto.blockedWork !== undefined) {
      await this.assertBlockedWorkBelongs(projectId, dto.blockedWork);
    }

    let dueAt: Date | undefined;
    if (dto.dueAt !== undefined) {
      const parsed = new Date(dto.dueAt);
      if (Number.isNaN(parsed.getTime())) throw new ConflictException(`dueAt "${dto.dueAt}" is not a parseable date.`);
      dueAt = parsed;
    }

    const nextStatus = (dto.status ?? row.status) as OnboardingRequestStatus;
    const isResolved = !OPEN_REQUEST_STATUSES.includes(nextStatus);

    const updated = await this.prisma.onboardingRequest.update({
      where: { id: requestId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.detail !== undefined ? { detail: dto.detail } : {}),
        ...(dto.requestedOf !== undefined ? { requestedOf: dto.requestedOf } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(dto.status !== undefined ? { status: nextStatus } : {}),
        ...(dto.blockedWork !== undefined ? { blockedWork: JSON.stringify(dto.blockedWork) } : {}),
        resolvedAt: isResolved ? (row.resolvedAt ?? new Date()) : null,
        resolvedBy: isResolved ? (row.resolvedBy ?? actorId) : null,
      },
    });

    await this.audit({
      actor: { type: 'user', id: actorId, label: null },
      action: 'updated',
      resource: { type: 'onboarding-request', id: requestId, version: null },
      projectId,
      clientId: project.clientId,
      summary: dto.status !== undefined && dto.status !== row.status
        ? `Access request ${row.status} -> ${updated.status}: ${updated.title}`
        : `Access request updated: ${updated.title}`,
      changes: {
        status: { before: row.status, after: updated.status },
        blockedWork: dto.blockedWork !== undefined ? { before: this.parseStringArray(row.blockedWork), after: dto.blockedWork } : undefined,
        note: dto.note ?? null,
      },
      origin: 'api',
      clientVisible: true,
    });

    return this.toRequestDto(updated);
  }

  // ── Access checklist ────────────────────────────────────────────────

  /** Request-backed checklist lines, in CP04's order (design_plan §4.5). */
  private static readonly REQUEST_ITEMS: ReadonlyArray<{
    key: string;
    kind: string;
    label: string;
    owner: 'client' | 'operator';
  }> = [
    { key: 'confirm-profile', kind: 'confirm-profile', label: 'Confirm company, services and markets', owner: 'client' },
    { key: 'gsc-access', kind: 'gsc-access', label: 'Connect Google Search Console', owner: 'client' },
    { key: 'ga4-access', kind: 'ga4-access', label: 'Connect Google Analytics 4', owner: 'client' },
    { key: 'cms-access', kind: 'cms-access', label: 'Grant CMS / publishing access', owner: 'client' },
    { key: 'brand-assets', kind: 'brand-assets', label: 'Send brand assets (logo, tone, examples)', owner: 'client' },
  ];

  /**
   * The welcome checklist (CP04) built from records that actually exist.
   *
   * Every line reports its SOURCE, so nothing here can be mistaken for a
   * hand-maintained list: a request-backed line reads the request, the profile
   * line reads the confirmed profile version, the seat line counts client
   * members, and the scope line reads the project's cycles. A line with no
   * backing record is `not-requested` — which is a different state from
   * `done`, and is reported as one (AGENT-BRIEF rule 3).
   */
  async getChecklist(projectId: string): Promise<OnboardingChecklistDto> {
    const project = await this.requireProject(projectId);
    const requests = await this.prisma.onboardingRequest.findMany({
      where: { projectId },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    });
    const requestDtos: OnboardingRequestDto[] = [];
    for (const r of requests) requestDtos.push(await this.toRequestDto(r));

    const items: ChecklistItem[] = [];
    const confirmedRow = await this.latestConfirmedRow(projectId);
    const now = Date.now();

    for (const spec of BusinessProfileService.REQUEST_ITEMS) {
      const open = requestDtos.find((r) => r.kind === spec.kind && r.outstanding);
      const closed = requestDtos.find((r) => r.kind === spec.kind && !r.outstanding);

      // `confirm-profile` has a second, stronger source: the profile itself.
      // A confirmed version is the fact; the request is only the ask for it.
      if (spec.kind === 'confirm-profile' && confirmedRow) {
        items.push({
          key: spec.key,
          label: spec.label,
          owner: spec.owner,
          state: 'done',
          detail: `Business profile version ${confirmedRow.version} was confirmed by ${confirmedRow.confirmedBy ?? 'an operator'} on ${(confirmedRow.confirmedAt as Date).toISOString()}.`,
          source: 'business-profile',
          rule: null,
          requestId: closed?.id ?? open?.id ?? null,
          dueAt: null,
        });
        continue;
      }

      if (open) {
        items.push({
          key: spec.key,
          label: spec.label,
          owner: spec.owner,
          state: 'outstanding',
          detail: open.dueAt
            ? `Requested${open.requestedOf ? ` of ${open.requestedOf}` : ''}; due ${open.dueAt}${open.overdue ? ' (overdue)' : ''}.`
            : `Requested${open.requestedOf ? ` of ${open.requestedOf}` : ''}; no due date set.`,
          source: 'onboarding-request',
          rule: null,
          requestId: open.id,
          dueAt: open.dueAt,
        });
        continue;
      }

      if (closed) {
        items.push({
          key: spec.key,
          label: spec.label,
          owner: spec.owner,
          state: 'done',
          detail:
            closed.status === 'waived'
              ? `Waived by the operator on ${closed.resolvedAt ?? closed.updatedAt} — deliberately not required.`
              : `Marked done by ${closed.resolvedBy ?? 'unknown'} on ${closed.resolvedAt ?? closed.updatedAt}.`,
          source: 'onboarding-request',
          rule: null,
          requestId: closed.id,
          dueAt: null,
        });
        continue;
      }

      items.push({
        key: spec.key,
        label: spec.label,
        owner: spec.owner,
        state: 'not-requested',
        detail: 'Nobody has asked for this yet. It is not done and not refused — it has not been requested.',
        source: 'onboarding-request',
        rule: null,
        requestId: null,
        dueAt: null,
      });
    }

    // Invite collaborators — read from client seats, which G02 owns. The rule
    // is stated rather than implied so "1 seat" is not silently reported as
    // a completed invite.
    if (project.clientId === null) {
      items.push({
        key: 'invite-collaborators',
        label: 'Invite collaborators',
        owner: 'client',
        state: 'unavailable',
        detail:
          'This project has no client attached, so there are no seats to invite. Attach it first (PUT /api/clients/:clientId/projects/:projectId/attach).',
        source: 'project',
        rule: 'Requires an attached client.',
        requestId: null,
        dueAt: null,
      });
    } else {
      const seats = await this.prisma.clientMember.count({
        where: { clientId: project.clientId, status: 'active', removedAt: null },
      });
      items.push({
        key: 'invite-collaborators',
        label: 'Invite collaborators',
        owner: 'client',
        state: seats > 1 ? 'done' : 'outstanding',
        detail:
          seats === 0
            ? 'No active client seats on this account at all.'
            : `${seats} active seat${seats === 1 ? '' : 's'}${
                seats === 1 ? ' — only the primary contact, no collaborator invited yet' : ''
              }.`,
        source: 'client-member',
        rule: 'Done when the client has more than one active seat.',
        requestId: null,
        dueAt: null,
      });
    }

    // Agree scope — read from cycles (G06). No cycle is "not-requested", not
    // "outstanding": there is nothing yet to agree to.
    const cycles = await this.prisma.cycle.findMany({
      where: { projectId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: 'desc' },
    });
    const committed = cycles.find((c) => c.status !== 'planning');
    items.push(
      committed
        ? {
            key: 'agree-scope',
            label: 'Agree the scope of the first cycle',
            owner: 'client',
            state: 'done',
            detail: `Cycle "${committed.name}" is ${committed.status}.`,
            source: 'cycle',
            rule: 'Done when a cycle for this project has been committed (status is not "planning").',
            requestId: null,
            dueAt: null,
          }
        : cycles.length > 0
          ? {
              key: 'agree-scope',
              label: 'Agree the scope of the first cycle',
              owner: 'client',
              state: 'outstanding',
              detail: `Cycle "${cycles[0].name}" is still in planning and has not been committed.`,
              source: 'cycle',
              rule: 'Done when a cycle for this project has been committed (status is not "planning").',
              requestId: null,
              dueAt: null,
            }
          : {
              key: 'agree-scope',
              label: 'Agree the scope of the first cycle',
              owner: 'client',
              state: 'not-requested',
              detail: 'No cycle exists for this project yet, so there is no scope to agree to.',
              source: 'cycle',
              rule: 'Done when a cycle for this project has been committed (status is not "planning").',
              requestId: null,
              dueAt: null,
            },
    );

    // Reorder to CP04's reading order while keeping any extra lines at the end.
    const order = ['confirm-profile', 'invite-collaborators', 'gsc-access', 'ga4-access', 'cms-access', 'brand-assets', 'agree-scope'];
    items.sort((a, b) => {
      const ia = order.indexOf(a.key);
      const ib = order.indexOf(b.key);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });

    const outstandingRequests = requestDtos.filter((r) => r.outstanding);
    const missingBlockedWork = Array.from(
      new Set(
        requestDtos.flatMap((r) => r.blockedWorkLinks.filter((l) => l.missing).map((l) => l.id)),
      ),
    );

    return {
      projectId,
      generatedAt: new Date(now).toISOString(),
      hasClient: project.clientId !== null,
      items,
      counts: {
        done: items.filter((i) => i.state === 'done').length,
        outstanding: items.filter((i) => i.state === 'outstanding').length,
        notRequested: items.filter((i) => i.state === 'not-requested').length,
        unavailable: items.filter((i) => i.state === 'unavailable').length,
      },
      blocking: outstandingRequests.map((r) => ({
        requestId: r.id,
        title: r.title,
        kind: r.kind,
        status: r.status,
        dueAt: r.dueAt,
        overdue: r.overdue,
        requestedOf: r.requestedOf,
        blockedWorkLinks: r.blockedWorkLinks,
      })),
      missingBlockedWork,
    };
  }

  // ── Merge / validation ──────────────────────────────────────────────

  private emptyData(): BusinessProfileData {
    return {
      brandName: null,
      legalName: null,
      description: null,
      category: null,
      services: [],
      icp: { segments: [], roles: [], painPoints: [] },
      markets: [],
      languages: [],
      targets: [],
      facts: [],
      competitors: [],
      goals: [],
      approvers: [],
      publishing: { cms: null, constraints: null, styleNotes: null },
    };
  }

  /** Blank value that means "the caller did not send this" for a JSON column,
   *  distinguished from an empty one — see `merge`. */
  private merge(base: BusinessProfileData, patch: SaveBusinessProfileDto): { data: BusinessProfileData; warnings: string[] } {
    const warnings: string[] = [];

    const competitors: CompetitorShape[] | undefined =
      patch.competitors === undefined
        ? undefined
        : patch.competitors.map((c) => {
            const domain = c.domain ? tryNormalizeDomain(c.domain) : null;
            if (c.domain && domain === null) {
              warnings.push(`Competitor "${c.name}" was kept with no domain: "${c.domain}" is not a valid hostname.`);
            }
            return { name: c.name, domain };
          });

    const data: BusinessProfileData = {
      brandName: patch.brandName !== undefined ? patch.brandName : base.brandName,
      legalName: patch.legalName !== undefined ? patch.legalName : base.legalName,
      description: patch.description !== undefined ? patch.description : base.description,
      category: patch.category !== undefined ? patch.category : base.category,
      services: patch.services !== undefined ? patch.services : base.services,
      icp:
        patch.icp !== undefined
          ? {
              segments: patch.icp.segments !== undefined ? patch.icp.segments : base.icp.segments,
              roles: patch.icp.roles !== undefined ? patch.icp.roles : base.icp.roles,
              painPoints: patch.icp.painPoints !== undefined ? patch.icp.painPoints : base.icp.painPoints,
            }
          : base.icp,
      markets: patch.markets !== undefined ? patch.markets : base.markets,
      languages: patch.languages !== undefined ? patch.languages : base.languages,
      targets:
        patch.targets !== undefined
          ? patch.targets.map((t) => {
              const country = t.country.trim().toUpperCase();
              if (!/^[A-Z]{2}$/.test(country)) {
                warnings.push(`Target "${t.country}" was dropped: not a 2-letter ISO-3166 country code.`);
              }
              return {
                country,
                region: t.region ?? null,
                city: t.city ?? null,
                language: t.language ?? null,
                priority: t.priority ?? 0,
                active: t.active ?? true,
                productApplicability: t.productApplicability ?? [],
              };
            }).filter((t) => /^[A-Z]{2}$/.test(t.country))
          : base.targets,
      facts:
        patch.facts !== undefined
          ? patch.facts.map((f) => ({ fact: f.fact, evidenceUrl: f.evidenceUrl ?? null }))
          : base.facts,
      competitors: competitors !== undefined ? competitors : base.competitors,
      goals: patch.goals !== undefined ? patch.goals : base.goals,
      approvers:
        patch.approvers !== undefined
          ? patch.approvers.map((a) => ({ name: a.name, email: a.email ?? null, role: a.role ?? null }))
          : base.approvers,
      publishing:
        patch.publishing !== undefined
          ? {
              cms: patch.publishing.cms !== undefined ? patch.publishing.cms : base.publishing.cms,
              constraints:
                patch.publishing.constraints !== undefined ? patch.publishing.constraints : base.publishing.constraints,
              styleNotes:
                patch.publishing.styleNotes !== undefined ? patch.publishing.styleNotes : base.publishing.styleNotes,
            }
          : base.publishing,
    };

    return { data, warnings };
  }

  /**
   * True when a draft carries nothing at all — no name, no description, no
   * services, no audience and no markets. A confirmation of this would be a
   * confirmation of nothing, so it is refused rather than recorded.
   */
  private isEmptyDraft(data: BusinessProfileData): boolean {
    return (
      !data.brandName &&
      !data.legalName &&
      !data.description &&
      data.services.length === 0 &&
      data.icp.segments.length === 0 &&
      data.markets.length === 0 &&
      data.targets.length === 0 &&
      data.facts.length === 0 &&
      data.competitors.length === 0 &&
      data.goals.length === 0
    );
  }

  /**
   * What is missing before a profile can be called complete.
   *
   * None of these is a hard requirement — a first call with a thin profile is
   * better than no confirmed profile at all. They are returned on the
   * confirmation and written to the audit event, so a confirmation is a
   * decision the operator can see the shape of rather than a button that
   * always silently succeeds.
   */
  private validateForConfirmation(data: BusinessProfileData): string[] {
    const missing: string[] = [];
    if (!data.brandName) missing.push('No brand name.');
    if (!data.description) missing.push('No description of the business.');
    if (data.services.length === 0) missing.push('No services listed.');
    if (data.icp.segments.length === 0) missing.push('No ICP segments listed.');
    if (data.markets.length === 0) missing.push('No markets listed.');
    return missing;
  }
}
