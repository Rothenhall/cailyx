/**
 * Types for the Content module — G09: editable briefs, versioned content
 * revisions and reliable generation jobs.
 *
 * @module content.types
 */

/** The two asset types that can actually be generated today (article, ad-copy) — reuses growth-execution's writer. */
export const GENERATABLE_ASSET_TYPES = ['article', 'ad-copy'] as const;
export type GeneratableAssetType = (typeof GENERATABLE_ASSET_TYPES)[number];

/**
 * The full nine "Create Recommended Assets" leaves growth-execution defines.
 * Kept as a local literal (not imported) so this module does not create a
 * runtime dependency on growth-execution's exports for something this basic —
 * the seven non-generatable ones stay brief-only per design_plan §5.8's table.
 */
export const ALL_ASSET_TYPES = [
  'article',
  'ad-copy',
  'social-content',
  'email-campaign',
  'landing-page',
  'structured-data',
  'seo-fix',
  'faq',
  'review-campaign',
] as const;
export type ContentAssetType = (typeof ALL_ASSET_TYPES)[number];

export type BriefStatus = 'draft' | 'approved' | 'archived';

export interface ReferenceSource {
  url: string;
  note?: string;
}

export interface ContentBriefDto {
  id: string;
  projectId: string;
  version: number;
  title: string;
  assetType: ContentAssetType;
  targetQuery: string | null;
  supportingQueries: string[];
  audience: string | null;
  intent: string | null;
  angle: string | null;
  mustInclude: string[];
  claimIds: string[];
  references: ReferenceSource[];
  sourceType: string | null;
  sourceId: string | null;
  wordTarget: number | null;
  language: string;
  status: BriefStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RevisionOrigin = 'generation' | 'operator-edit' | 'client-edit' | 'import';

export interface ContentRevisionDto {
  id: string;
  assetId: string;
  revision: number;
  title: string | null;
  body: string | null;
  fields: Record<string, unknown>;
  briefId: string | null;
  briefVersion: number | null;
  origin: RevisionOrigin;
  generationItemId: string | null;
  wordCount: number;
  authorId: string | null;
  contentHash: string | null;
  createdAt: string;
}

/** Returned by GET .../content/assets/:assetId — the asset plus its current editable state. */
export interface AssetContentDto {
  assetId: string;
  projectId: string;
  assetType: ContentAssetType;
  title: string;
  status: string;
  /** The revision number a PATCH must supply as `expectedVersion` to succeed. 0 = no ContentRevision saved yet (only the legacy GrowthAsset.content, if any). */
  currentVersion: number;
  current: ContentRevisionDto | null;
  /** True when currentVersion is 0 and GrowthAsset.content still holds legacy (pre-G09) generated content not yet captured as a revision. */
  legacyContentOnly: boolean;
}

export type GenerationJobStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed';
export type GenerationItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface GenerationItemDto {
  id: string;
  generationJobId: string;
  subject: string | null;
  topicId: string | null;
  status: GenerationItemStatus;
  assetId: string | null;
  revisionId: string | null;
  error: string | null;
  retryable: boolean;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationJobDto {
  id: string;
  projectId: string;
  briefId: string | null;
  briefVersion: number | null;
  assetType: ContentAssetType;
  requested: number;
  succeeded: number;
  failed: number;
  status: GenerationJobStatus;
  provider: string | null;
  model: string | null;
  costUsd: number;
  error: string | null;
  requestedBy: string | null;
  /** Zero-topic batches are distinguished from per-item failures here rather than by a shared "no items" empty state. */
  note: string | null;
  items: GenerationItemDto[];
  /** GenerationItem.id for every item in `items` that failed AND is retryable — the exact set POST .../retry acts on by default. */
  retryableItemIds: string[];
  createdAt: string;
  updatedAt: string;
}
