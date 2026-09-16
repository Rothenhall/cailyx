import { ApiError, api } from '@/lib/api';

/**
 * Data-asset adapters — SOP-8 original research (CT09).
 *
 * §5.9 puts the ceiling on what this is: *"Current API is a ledger, not a
 * survey platform or dataset warehouse. Add research review before making
 * numeric claims."* So these rows record intent, method and publication — they
 * do not collect data, and a `surveySize` here is a **declared design size**,
 * not a measured response count. The screen says so; this file cannot.
 */

export const BRAND_ALIGNMENTS = ['brand-named', 'subject-matter'] as const;
export type BrandAlignment = (typeof BRAND_ALIGNMENTS)[number];

export const BRAND_ALIGNMENT_LABELS: Record<BrandAlignment, string> = {
  'brand-named': 'Brand-named',
  'subject-matter': 'Subject-matter',
};

export const DATA_ASSET_STATUSES = ['planned', 'fielding', 'published'] as const;
export type DataAssetStatus = (typeof DATA_ASSET_STATUSES)[number];

export const DATA_ASSET_STATUS_LABELS: Record<DataAssetStatus, string> = {
  planned: 'Planned',
  fielding: 'Fielding',
  published: 'Published',
};

export interface DataAsset {
  id: string;
  projectId: string;
  title: string;
  /** How the brand attaches. Brand-named assets earn citations more reliably. */
  brandAlignment: BrandAlignment;
  /**
   * The methodology note. Sourceable numbers require one — without it a numeric
   * claim cannot pass claims discipline (§5.8 Stage E).
   */
  methodologyNote: string | null;
  /** Declared sample size, if the method is a survey. Null is not zero. */
  surveySize: number | null;
  status: DataAssetStatus;
  publishedAt: string | null;
  /** The live URL once published. */
  assetUrl: string | null;
  createdAt: string;
}

function asArray(payload: unknown): DataAsset[] {
  if (Array.isArray(payload)) return payload as DataAsset[];
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: 'Expected a list of data assets but the response was not an array.',
    body: payload,
  });
}

export async function listDataAssets(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<DataAsset[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/data-asset`, options);
  return asArray(payload);
}

export async function createDataAsset(
  projectId: string,
  input: {
    title: string;
    brandAlignment?: BrandAlignment;
    methodologyNote?: string;
    surveySize?: number;
    assetUrl?: string;
  },
): Promise<DataAsset> {
  return api.post<DataAsset>(`/projects/${projectId}/data-asset`, input);
}

/** Lifecycle and fields. `published` stamps `publishedAt` server-side. */
export async function updateDataAsset(
  projectId: string,
  assetId: string,
  patch: {
    title?: string;
    brandAlignment?: BrandAlignment;
    methodologyNote?: string;
    surveySize?: number;
    assetUrl?: string;
    status?: DataAssetStatus;
  },
): Promise<DataAsset> {
  return api.patch<DataAsset>(`/projects/${projectId}/data-asset/${assetId}`, patch);
}

export async function deleteDataAsset(projectId: string, assetId: string): Promise<DataAsset> {
  return api.delete<DataAsset>(`/projects/${projectId}/data-asset/${assetId}`);
}
