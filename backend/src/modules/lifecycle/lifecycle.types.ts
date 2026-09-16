/**
 * Shared types and vocabularies for G17 — exports, retention and offboarding.
 *
 * Contract source: design_plan.md G17 (line 1697).
 *
 * SQLite has no enums: `ExportRequest.status`, `RetentionPolicy.action` and
 * `OffboardingRun.status` are `String` columns whose permitted values are
 * documented on the Prisma models. This file is the single source of truth for
 * those vocabularies so the controller, the services and the README cannot
 * drift apart.
 *
 * @module lifecycle.types
 */

// ── Exports ─────────────────────────────────────────────────────────────

/**
 * What an export can cover. `project` exports one project's rows; `client`
 * exports every project the client owns, plus the client-level rows (messages,
 * seat membership, engagements).
 */
export type ExportScopeType = 'client' | 'project';

export const EXPORT_SCOPE_TYPES: readonly ExportScopeType[] = ['client', 'project'];

/**
 * `json` writes one bundle for every requested section. `csv` is a single
 * section rendered as CSV — a spreadsheet cannot represent a nested bundle,
 * and inventing a zip format without a zip dependency would produce a file
 * nothing could open.
 */
export type ExportFormat = 'json' | 'csv';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'csv'];

/** `ExportRequest.status` — mirrors the model's comment exactly. */
export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export const EXPORT_STATUSES: readonly ExportStatus[] = ['queued', 'running', 'ready', 'failed', 'expired'];

/** Terminal states: nothing further will happen without a new request. */
export const TERMINAL_EXPORT_STATUSES: readonly ExportStatus[] = ['ready', 'failed', 'expired'];

/**
 * Every section an export can carry.
 *
 * `leads` is present and labelled because the pre-existing
 * `GET /projects/:id/leads/export` is narrower but still useful and must keep
 * working; including it here means a client-wide export can carry the pipeline
 * under a name that says whose pipeline it is.
 */
export type ExportSection =
  | 'project'
  | 'reports'
  | 'metrics'
  | 'observations'
  | 'audits'
  | 'work'
  | 'query-sets'
  | 'personas'
  | 'content'
  | 'competitors'
  | 'presence'
  | 'authority'
  | 'backlinks'
  | 'messages'
  | 'activity'
  | 'attachments'
  | 'leads';

export const EXPORT_SECTIONS: readonly ExportSection[] = [
  'project',
  'reports',
  'metrics',
  'observations',
  'audits',
  'work',
  'query-sets',
  'personas',
  'content',
  'competitors',
  'presence',
  'authority',
  'backlinks',
  'messages',
  'activity',
  'attachments',
  'leads',
];

/**
 * The default bundle. Deliberately excludes `leads` and `activity`:
 *
 * - `leads` are Cailyx's own sales pipeline (PRD 6.11) and hold personal
 *   contact data. They are exportable, but only on request — an export that
 *   quietly carries a sales pipeline is a disclosure nobody asked for.
 * - `activity` is the audit trail, which is retained under policy rather than
 *   handed out by default.
 */
export const DEFAULT_EXPORT_SECTIONS: readonly ExportSection[] = [
  'project',
  'reports',
  'metrics',
  'observations',
  'audits',
  'work',
  'query-sets',
  'personas',
  'content',
  'competitors',
  'presence',
  'authority',
  'backlinks',
  'messages',
  'attachments',
];

/** Default download-link lifetime. An export is scoped and expiring, not a permalink. */
export const DEFAULT_EXPORT_TTL_HOURS = 24;
export const MAX_EXPORT_TTL_HOURS = 168;

/** Rows carried per section before the section is truncated and says so. */
export const EXPORT_SECTION_ROW_LIMIT = 20_000;

/**
 * What one section contributed, so a reader can tell a genuinely empty section
 * from one that was capped.
 */
export interface ExportSectionReport {
  section: ExportSection;
  rows: number;
  truncated: boolean;
  /** Fields removed from this section for the export, named rather than absent. */
  omitted: string[];
}

// ── Retention ───────────────────────────────────────────────────────────

/** `RetentionPolicy.resourceType` — the values the model documents. */
export type RetentionResourceType = 'observations' | 'reports' | 'messages' | 'job-runs' | 'activity' | 'attachments';

export const RETENTION_RESOURCE_TYPES: readonly RetentionResourceType[] = [
  'observations',
  'reports',
  'messages',
  'job-runs',
  'activity',
  'attachments',
];

/** `RetentionPolicy.action` — mirrors the model's comment exactly. */
export type RetentionAction = 'delete' | 'anonymize' | 'archive';

export const RETENTION_ACTIONS: readonly RetentionAction[] = ['delete', 'anonymize', 'archive'];

/** The row-count outcome of a retention preview or run. */
export interface RetentionCounts {
  resourceType: RetentionResourceType;
  action: RetentionAction;
  retainDays: number | null;
  enabled: boolean;
  /** Rows older than the policy window as at the moment of the call. */
  eligible: number;
  /** Rows the action can actually be applied to. Equals `eligible` for a permitted action. */
  affected: number;
  /** The instant the retention window is measured back from. Always "now", stated. */
  measuredFrom: string;
  /** The cutoff instant: rows created before this are eligible. Null when retainDays is null. */
  cutoff: string | null;
  note: string;
}

/**
 * `anonymize` is only offered where the row actually holds something to
 * anonymize. The action is refused rather than silently performed as a no-op
 * on a table with nothing personal in it.
 */
export interface RetentionResourceDefinition {
  resourceType: RetentionResourceType;
  label: string;
  /** What the policy covers, in the reader's words. */
  covers: string;
  /** The timestamp the retention window is measured from. */
  measuredFrom: string;
  /** Actions this resource type permits. */
  allowedActions: readonly RetentionAction[];
  /** Why an action is not permitted, when one is not. */
  restriction: string | null;
  /** Documented default when no policy row exists yet. */
  defaultRetainDays: number | null;
  defaultAction: RetentionAction;
}

// ── Offboarding ─────────────────────────────────────────────────────────

/** `OffboardingRun.status` — mirrors the model's comment exactly. */
export type OffboardingStatus = 'preview' | 'executing' | 'completed' | 'failed' | 'cancelled';

export const OFFBOARDING_STATUSES: readonly OffboardingStatus[] = [
  'preview',
  'executing',
  'completed',
  'failed',
  'cancelled',
];

/** `OffboardingRun.shareLinkPolicy` — what happens to public report links. */
export type ShareLinkPolicy = 'revoke' | 'keep';

export const SHARE_LINK_POLICIES: readonly ShareLinkPolicy[] = ['revoke', 'keep'];

/** How long a preview stays valid. A preview is a promise about a state; a stale one is not. */
export const PREVIEW_TTL_MINUTES = 30;

/** `planned` / `executed` JSON: `{ [resourceType]: count }`, as the model documents. */
export type ResourceCounts = Record<string, number>;

/** One line of an offboarding preview. */
export interface OffboardingResourcePlan {
  resourceType: string;
  label: string;
  resourceClass: string;
  /** What will happen to these rows. */
  action: string;
  /** What that action means for this resource class. */
  meaning: string;
  /** Rows that will be affected, right now. */
  count: number;
  /** True when `action` came from a request override rather than the policy. */
  overridden: boolean;
  /** What the client loses. */
  consequence: string;
}

/** The full preview: exactly what will be touched, named and counted. */
export interface OffboardingPreview {
  offboardingRunId: string;
  clientId: string;
  clientName: string;
  generatedAt: string;
  expiresAt: string;
  status: OffboardingStatus;
  shareLinkPolicy: ShareLinkPolicy;
  /** Per resource class, so the shape of the change is visible before the counts. */
  byClass: Record<string, { label: string; meaning: string; resourceTypes: string[]; total: number }>;
  resources: OffboardingResourcePlan[];
  /** Totals by action, so "how much is being destroyed" has one answer. */
  totalsByAction: Record<string, number>;
  /** Public report links, handled explicitly per `shareLinkPolicy`. */
  shareLinks: {
    policy: ShareLinkPolicy;
    count: number;
    explanation: string;
  };
  /** Frozen evidence snapshots this plan would leave pointing at deleted rows. */
  frozenSnapshotConflicts: Array<{ manifestId: string; subjectType: string; resourceTypes: string[] }>;
  notes: string[];
}
