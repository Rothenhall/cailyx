/**
 * Types and vocabularies for G20 — organization settings, branding, report
 * templates and program templates.
 *
 * SQLite has no enums: `ReportTemplate.reportType` and
 * `ProgramTemplate.kind` are `String` columns whose permitted values are
 * documented on the models and re-validated here before any write.
 *
 * Two different versioning shapes live in this package, and the difference is
 * deliberate rather than sloppy:
 *
 * - `OrganizationSettings` is **append-only**. Every write inserts a new row
 *   with `version = max + 1` and `@@unique([version])`; nothing is ever
 *   updated. "The version in force" is the highest version.
 * - `ReportTemplate` / `ProgramTemplate` are **mutated in place with a bumped
 *   `version` counter**. A released report carries its own copy of the
 *   template and the version it copied, so the counter is what makes the
 *   pinned identity checkable afterwards. `isDefault`/`active` only make sense
 *   on a mutable current row, which is why these are not append-only.
 *
 * @module organization.types
 */

// ─── Settings ────────────────────────────────────────────────────────

/** `OrganizationSettings.defaultTier` — the tiers G06's engagements use. */
export const SERVICE_TIERS = ['scorecard', 'diagnostic', 'sprint', 'retainer'] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/**
 * The settings in force.
 *
 * `version` is `null` when no settings row has ever been written — the values
 * are then the schema's own declared defaults, not a row that exists. That
 * distinction is reported rather than smoothed over, because a released report
 * pinning `null` means "published under the application defaults", which is a
 * different fact from "published under version 1".
 */
export interface OrganizationSettingsDto {
  version: number | null;
  /** False when these values come from the model's declared defaults and no row exists. */
  persisted: boolean;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  supportName: string | null;
  timezone: string;
  defaultTier: string;
  reviewSlaHours: number;
  /** Whether operators may create anyone-with-the-link report shares. */
  allowPublicShare: boolean;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Branding in the shape a released document needs, plus the CSS custom
 * property the client applies.
 *
 * `branding` is deliberately shaped like `reporting`'s own `BrandingConfig`
 * (`orgName`/`logoUrl`/`palette.primary`) so that adopting this method is a
 * swap rather than a mapping. `tagline` is absent because
 * `OrganizationSettings` has no column for it — reporting currently sources it
 * from `REPORT_BRAND_TAGLINE` and may keep doing so.
 */
export interface BrandingSnapshot {
  /** The settings row this branding was read from. Null when no row exists yet. */
  settingsVersion: number | null;
  branding: {
    orgName: string;
    logoUrl?: string;
    palette?: { primary?: string };
  };
  /** `primaryColor` as a CSS custom property override. Empty when no colour is set. */
  cssVariables: Record<string, string>;
}

/**
 * Everything a release has to pin so a later settings edit cannot change a
 * delivered document: which settings version was in force, which template (and
 * which version of it), and the policy that applied at the time.
 */
export interface ReleaseSnapshot {
  settingsVersion: number | null;
  branding: BrandingSnapshot;
  policy: {
    allowPublicShare: boolean;
    reviewSlaHours: number;
    timezone: string;
    defaultTier: string;
  };
  template: ReportTemplateDto | null;
  /** Why `template` is null, when it is. Never left for the caller to guess. */
  templateUnavailableReason: string | null;
  capturedAt: string;
}

// ─── Report templates ────────────────────────────────────────────────

export const REPORT_TYPES = ['monthly', 'quarterly', 'diagnostic', 'scorecard'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** One entry of `ReportTemplate.sections` JSON. */
export interface ReportTemplateSection {
  key: string;
  title: string;
  include: boolean;
  order: number;
}

export interface ReportTemplateDto {
  id: string;
  name: string;
  reportType: string;
  sections: ReportTemplateSection[];
  version: number;
  isDefault: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Program templates ───────────────────────────────────────────────

export const PROGRAM_TEMPLATE_KINDS = ['onboarding', 'cycle', 'offboarding'] as const;
export type ProgramTemplateKind = (typeof PROGRAM_TEMPLATE_KINDS)[number];

/** One entry of `ProgramTemplate.items` JSON. */
export interface ProgramTemplateItem {
  title: string;
  /** fix | build | influence (G06's WorkItem.category). */
  category: string | null;
  /** technical | content | authority | research | reporting | access (G06's WorkItem.discipline). */
  discipline: string | null;
  /** Who it is for — a role name, or a ClientMember/User id. */
  role: string | null;
  estimateHours: number | null;
  /** Days from the apply date. `startOn` turns this into a real due date; without one, no date is set. */
  offsetDays: number | null;
}

export interface ProgramTemplateDto {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  items: ProgramTemplateItem[];
  version: number;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Applying a program template ─────────────────────────────────────

/** Which table a copied row landed in. */
export type ApplyTarget = 'work-item' | 'onboarding-request';

export interface AppliedRow {
  /** The created row's id, or null on a dry run where nothing was written. */
  id: string | null;
  title: string;
  target: ApplyTarget;
  /** The cycle the work item went into, for `target: 'work-item'`. */
  cycleId: string | null;
}

export interface SkippedItem {
  title: string;
  reason: string;
}

export interface ApplyProgramTemplateResult {
  template: { id: string; name: string; kind: string; version: number };
  projectId: string;
  /** False when this kind has no target table in the current schema — an explicit unavailable state, not a failure. */
  applied: boolean;
  unavailableReason: string | null;
  dryRun: boolean;
  copied: number;
  partial: boolean;
  created: AppliedRow[];
  skipped: SkippedItem[];
  /**
   * Template-item fields the target row has no column for. Reported because a
   * silent drop would make the copy look more faithful than it is.
   */
  notCarried: string[];
  cycle: { id: string; status: string } | null;
  notes: string[];
}

// ─── Public share policy ─────────────────────────────────────────────

/** What a caller is about to mint, so a refusal can name it. */
export type ShareScope = 'report' | 'content' | 'other';
