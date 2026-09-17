/**
 * Types for the Content Workspace module — P08 (platform_improvement_plan.md
 * §13.1-13.5, §13.9-13.11). This module does not own generation, briefs,
 * approvals or publishing (Growth Execution / Content / Approvals /
 * Publishing already do); it composes their existing records into ONE
 * canonical content list/detail with correctly separated state axes, plus
 * the stable-identity repair (`briefFamilyId`) and the client-safe portal
 * read that did not exist before.
 *
 * @module content-workspace.types
 */

/**
 * The subset of GrowthAsset.assetType that is actually "content" for this
 * workspace's counts (§13.9). The other three tracked types are real,
 * preserved, cross-linked records — just not content-calendar/article-
 * delivery items.
 */
export const CONTENT_WORKSPACE_ASSET_TYPES = [
  'article',
  'ad-copy',
  'social-content',
  'email-campaign',
  'landing-page',
  'faq',
] as const;
export type ContentWorkspaceAssetType = (typeof CONTENT_WORKSPACE_ASSET_TYPES)[number];

/** §13.9 — excluded from the content workspace's counts, never deleted. */
export const NON_CONTENT_ASSET_TYPES = ['seo-fix', 'structured-data', 'review-campaign'] as const;
export type NonContentAssetType = (typeof NON_CONTENT_ASSET_TYPES)[number];

/**
 * Every asset type the platform tracks — the two lists above, together.
 *
 * This is the capability matrix's row set, and it is deliberately NOT the
 * same thing as "types that can be generated". A request for any tracked
 * type must reach the capability check so the caller gets the honest §13.9
 * reason ("no tested writer"), never a class-validator whitelist string that
 * reads like a bug in the request. A request for a type that is not tracked
 * at all is a genuine 400: there is no capability to report on.
 */
export const ALL_TRACKED_ASSET_TYPES = [...CONTENT_WORKSPACE_ASSET_TYPES, ...NON_CONTENT_ASSET_TYPES] as const;
export type TrackedAssetType = (typeof ALL_TRACKED_ASSET_TYPES)[number];

/** Only these two have an implemented writer today (growth-execution.service.ts `generateContent`). Source of truth, not a frontend guess. */
export const GENERATION_IMPLEMENTED_ASSET_TYPES = ['article', 'ad-copy'] as const;

// ─── §13.4 state axes ───────────────────────────────────────────────────

export const EDITORIAL_STATES = [
  'planned',
  'drafting',
  'draft',
  'internal-review',
  'changes-requested',
  'ready-for-client',
  'approved',
] as const;
export type EditorialState = (typeof EDITORIAL_STATES)[number];

export const CLIENT_REVIEW_STATES = ['not-shared', 'awaiting-review', 'changes-requested', 'approved', 'expired-superseded'] as const;
export type ClientReviewState = (typeof CLIENT_REVIEW_STATES)[number];

export const PUBLICATION_SUMMARY_STATES = ['unscheduled', 'planned', 'scheduled', 'publishing', 'published', 'failed'] as const;
export type PublicationSummaryState = (typeof PUBLICATION_SUMMARY_STATES)[number];

export const UPDATE_STATES = ['no-update', 'revision-in-progress'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export interface PlacementSummaryDto {
  id: string;
  destinationId: string;
  provider: string;
  status: string;
  mode: string;
  scheduledFor: string | null;
  remoteUrl: string | null;
  revisionId: string;
  revisionNumber: number | null;
}

export interface PublicationSummaryDto {
  status: PublicationSummaryState;
  /** Count per Publication.status, e.g. { published: 1, failed: 1 }. Placements never inflate the "All content" row count — this is metadata on ONE row. */
  counts: Record<string, number>;
  placements: PlacementSummaryDto[];
}

/** One content piece as it appears in the canonical workspace list (§13.3). */
export interface ContentWorkspaceItemDto {
  assetId: string;
  projectId: string;
  assetType: ContentWorkspaceAssetType;
  title: string;
  /** search-gap | manual | opportunity-<origin> — where this piece came from, for the source filter. */
  source: string;
  sourceGapId: string | null;
  sourceOpportunityId: string | null;
  /** Derived from the linked ContentBrief (via the latest revision's briefId), if any. Null when no brief has been linked yet. */
  market: string | null;
  language: string | null;
  assigneeId: string | null;
  editorialState: EditorialState;
  clientReviewState: ClientReviewState;
  publicationSummary: PublicationSummaryDto;
  updateState: UpdateState;
  /** Documented badge-precedence output — see `derivePrimaryBadge`. A secondary-facts string, never a replacement for the four axes above. */
  primaryBadge: string;
  currentVersion: number;
  hasRevision: boolean;
  /** Opportunity.id this piece was promoted from, if any — so the list can show the link instead of a duplicate idea row (§13.3). */
  promotedFromOpportunityId: string | null;
  briefFamilyId: string | null;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentWorkspaceRevisionSummaryDto {
  id: string;
  revision: number;
  origin: string;
  authorId: string | null;
  wordCount: number;
  clientVisible: boolean;
  clientVisibleAt: string | null;
  createdAt: string;
}

export interface ContentWorkspaceApprovalSummaryDto {
  id: string;
  reviewerType: string;
  status: string;
  artifactRevision: number | null;
  revisionId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentWorkspaceCheckSummaryDto {
  id: string;
  checkKind: string;
  status: string;
  detail: string | null;
  createdAt: string;
}

/** Full staff content-detail view (§13.5): header + preview + plan + review + schedule + history. */
export interface ContentWorkspaceDetailDto extends ContentWorkspaceItemDto {
  brief: {
    id: string;
    briefFamilyId: string;
    version: number;
    title: string;
    audience: string | null;
    intent: string | null;
    angle: string | null;
    mustInclude: string[];
    references: { url: string; note?: string }[];
    wordTarget: number | null;
    status: string;
  } | null;
  currentRevision: {
    id: string;
    revision: number;
    title: string | null;
    body: string | null;
    fields: Record<string, unknown>;
    wordCount: number;
    origin: string;
    clientVisible: boolean;
    createdAt: string;
  } | null;
  revisions: ContentWorkspaceRevisionSummaryDto[];
  approvals: ContentWorkspaceApprovalSummaryDto[];
  checks: ContentWorkspaceCheckSummaryDto[];
  publications: PlacementSummaryDto[];
}

/**
 * §13.1's saved views, as a *server* filter.
 *
 * These live here rather than in the web app because §13.3 requires the
 * paginated page and its `total` to be produced by the same predicate: a view
 * applied client-side would show "12 of 40" while paging through a different
 * 40. `ideas` is deliberately absent — an idea is an Opportunity, a different
 * record, and the workspace reads those from their own module.
 */
export const CONTENT_WORKSPACE_VIEWS = [
  'all',
  'in-progress',
  'needs-review',
  'scheduled',
  'published',
  'updating',
] as const;
export type ContentWorkspaceView = (typeof CONTENT_WORKSPACE_VIEWS)[number];

export interface ContentWorkspaceListQuery {
  /** §13.1 saved view. Absent or 'all' applies no view predicate. */
  view?: string;
  q?: string;
  assetType?: string;
  editorialState?: string;
  source?: string;
  market?: string;
  language?: string;
  assigneeId?: string;
  /** 'shared' = has at least one clientVisible revision; 'not-shared' = none. */
  clientVisibility?: 'shared' | 'not-shared';
  page?: number;
  pageSize?: number;
}

export interface CapabilityDto {
  assetType: string;
  label: string;
  /** Read from GENERATION_IMPLEMENTED_ASSET_TYPES — the real writer path in growth-execution.service.ts, never a hardcoded frontend guess. */
  generationImplemented: boolean;
  /** True for every tracked asset type — manual planning/editing is always available even without a generator. */
  manualPlanningAvailable: boolean;
  /** True only for the 6 CONTENT_WORKSPACE_ASSET_TYPES — the other 3 are real work/records, not "content" for calendar/delivery counts. */
  countsAsContent: boolean;
  note: string;
}
