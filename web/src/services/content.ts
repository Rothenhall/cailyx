import { ApiError, api, unwrap } from '@/lib/api';

/**
 * Content production adapters — the G09 content module, plus the handful of
 * endpoints CT01–CT06 read from neighbouring modules.
 *
 * design_plan.md §4's content family contract is what shapes this file:
 * *"Opportunity → brief → draft header; editor uses §3 wireframe; source/QA
 * panel collapses on mobile; exact revision displayed during review; generated
 * draft, external edit and published URL remain distinct."*
 *
 * Two things that contract forces here:
 *
 *  1. **A revision is the unit of everything.** `getAssetContent` returns the
 *     exact `currentVersion` a save must quote, and `saveAssetContent` sends it
 *     back as `expectedVersion`. A save that quotes a stale version is a 409,
 *     never a silent overwrite — `versionConflictOf()` below turns that 409
 *     body into the current server state so the screen can show a comparison
 *     instead of claiming a save that did not happen.
 *  2. **Seven of the nine asset types cannot be generated at all.** §5.8's
 *     table marks social content, email, landing page, structured data, SEO
 *     fix, FAQ and review campaigns "brief only". `isGeneratable()` is the one
 *     place that answers which two can, so no screen can imply otherwise.
 *
 * Nothing here is called on page load that starts paid work: the only writes
 * are explicit operator actions, and `createGenerationJob` is never a
 * side effect of rendering (`src/services/research.ts` states the same rule
 * for audits).
 */

// ── Vocabulary ──────────────────────────────────────────────────────────

/** §5.8's nine "Create Recommended Assets" types, exactly. */
export const CONTENT_ASSET_TYPES = [
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
export type ContentAssetType = (typeof CONTENT_ASSET_TYPES)[number];

/**
 * The two types the generator actually produces. The other seven stay
 * brief-only until separately implemented (design_plan §5.8) — a brief for
 * them is still usable by a human writer, so they are not "blocked", they are
 * simply not machine-generated.
 */
export const GENERATABLE_ASSET_TYPES: readonly ContentAssetType[] = ['article', 'ad-copy'];

export function isGeneratable(assetType: ContentAssetType): boolean {
  return GENERATABLE_ASSET_TYPES.includes(assetType);
}

export const ASSET_TYPE_LABELS: Record<ContentAssetType, string> = {
  article: 'Article / guide',
  'ad-copy': 'Ad copy',
  'social-content': 'Social content',
  'email-campaign': 'Email campaign',
  'landing-page': 'Landing page',
  'structured-data': 'Structured data',
  'seo-fix': 'SEO fix',
  faq: 'FAQ / knowledge',
  'review-campaign': 'Review / reputation campaign',
};

export type BriefStatus = 'draft' | 'approved' | 'archived';

export interface ReferenceSource {
  url: string;
  note?: string;
}

/** One version of an instruction set. Approved versions are never rewritten. */
export interface ContentBrief {
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

/** An immutable saved revision of an asset's text. */
export interface ContentRevision {
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

export interface AssetContent {
  assetId: string;
  projectId: string;
  assetType: ContentAssetType;
  title: string;
  /** The asset's lifecycle status (recommended / in-progress / published). */
  status: string;
  /**
   * What a save must send as `expectedVersion`. **0 means no revision has ever
   * been saved** — whatever is in `current` then is legacy generated content,
   * read-only context that was never captured as a revision.
   */
  currentVersion: number;
  current: ContentRevision | null;
  legacyContentOnly: boolean;
}

export type GenerationJobStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed';
export type GenerationItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface GenerationItem {
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

export interface GenerationJob {
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
  /**
   * Distinguishes "zero assets because no topics were selected" from "every
   * item failed". Both produce an empty asset list and only one of them is a
   * fault (§5.8 Stage C).
   */
  note: string | null;
  items: GenerationItem[];
  /** Items that failed AND are retryable — the set `retryGenerationJob` acts on. */
  retryableItemIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A priority-keyword-derived topic. A preview: never persisted. */
export interface TopicSuggestion {
  targetKeyword: string;
  /** Disclosed weighted formula over volume, competition and CPC — not proof of conversion potential. */
  priorityScore: number;
  searchVolume: number | null;
  blogTopic: string;
  adAngle: string;
}

export type GrowthAssetStatus = 'recommended' | 'in-progress' | 'published';
export type GrowthAssetSource = 'deterministic' | 'generated-llm';

export interface ArticleFields {
  metaDescription?: string;
  slug?: string;
  faq?: Array<{ question: string; answer: string }>;
  jsonLd?: Record<string, unknown>[];
}

export interface AdCopyFields {
  variants?: Array<{ headline: string; description: string }>;
}

/** A library row: a brief-only recommendation, or a generated draft. */
export interface GrowthAsset {
  id: string;
  projectId: string;
  assetType: ContentAssetType;
  title: string;
  brief: string;
  targetKeyword: string | null;
  sourceGapId: string | null;
  status: GrowthAssetStatus;
  source: GrowthAssetSource;
  generationModel: string | null;
  /** Null until real content exists — that is what "brief only" means. */
  content: Record<string, unknown> | null;
  publishedAt: string | null;
  assetUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §5.8 Stage E discipline check over arbitrary copy. Deterministic; not persisted. */
export interface CopyCheckReport {
  result: 'passed' | 'banned-phrase' | 'ungraded-number' | 'single-run-rate';
  banned: Array<{ phrase: string; match: string }>;
  numericClaims: string[];
  singleRunRate: boolean;
  violations: string[];
}

export interface ClaimRow {
  id: string;
  projectId: string;
  statement: string;
  sourceUrl: string | null;
  status: 'draft' | 'approved' | 'blocked';
  grade: 'A' | 'B' | 'C' | null;
  disciplineCheck?: CopyCheckReport | null;
}

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'changes-requested'
  | 'cancelled'
  | 'invalidated';

/**
 * G10's version-bound approval request. `artifactRevision` is the whole point:
 * an approval is "I approve *this revision*", so a later revision invalidates it
 * rather than carrying consent forward.
 */
export interface ApprovalRequest {
  id: string;
  projectId: string;
  clientId: string | null;
  artifactType: 'report' | 'content' | 'plan' | 'cycle' | 'claim';
  artifactId: string;
  artifactRevision: number | null;
  revisionId: string | null;
  title: string;
  detail: string | null;
  reviewerType: 'operator' | 'client';
  requiredReviewerId: string | null;
  requestedBy: string;
  dueAt: string | null;
  status: ApprovalStatus;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One recorded decision. Immutable: a later one supersedes it, never rewrites it. */
export interface ApprovalDecision {
  id: string;
  approvalRequestId: string;
  decision: 'approved' | 'changes-requested';
  comment: string | null;
  decidedBy: string;
  decidedByType: 'operator' | 'client';
  /** The revision the decider confirmed they read. Null when none was recorded. */
  decidedRevision: number | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface ApprovalRequestDetail extends ApprovalRequest {
  /** Newest first; only the head is the current decision. */
  decisions: ApprovalDecision[];
}

export async function getApproval(
  projectId: string,
  approvalId: string,
  options?: { signal?: AbortSignal },
): Promise<ApprovalRequestDetail> {
  const payload = await api.get<unknown>(
    `/projects/${projectId}/approvals/${approvalId}`,
    options,
  );
  return asObject<ApprovalRequestDetail>(payload, 'approval request');
}

/**
 * Record a decision against a specific revision.
 *
 * `revision` must equal the request's current `artifactRevision` — that is what
 * proves the decision was made about the version on screen and not a stale one.
 * A mismatch is a 409, so a decision can never silently attach itself to a
 * revision nobody looked at.
 */
export async function decideApproval(
  projectId: string,
  approvalId: string,
  input: { decision: 'approved' | 'changes-requested'; revision: number; comment?: string },
): Promise<ApprovalRequestDetail> {
  const payload = await api.post<unknown>(
    `/projects/${projectId}/approvals/${approvalId}/decision`,
    input,
  );
  return asObject<ApprovalRequestDetail>(payload, 'approval request');
}

/** A review record tied to one exact revision — evidence behind a decision. */
export interface RevisionCheckResult {
  id: string;
  subjectType: string;
  subjectId: string;
  checkKind: string;
  status: string;
  detail: string | null;
  payload: unknown;
  checkedBy: string | null;
  checkedVia: 'automated' | 'human';
  createdAt: string;
}

export interface PublishDestination {
  id: string;
  projectId: string;
  provider: string;
  providerLabel: string;
  providerKind: string;
  /** False when this build has no adapter for the provider — declared, not connected. */
  providerImplemented: boolean;
  label: string;
  resourceId: string | null;
  resourceLabel: string | null;
  credentialRef: string | null;
  credentialConfigured: boolean;
  status: string;
  lastTestedAt: string | null;
  lastError: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One priced range, in exactly one unit. Credits and USD never share a row. */
export interface CostEstimateRange {
  unit: 'credits' | 'usd';
  low: number;
  high: number;
  rangeKind: 'point' | 'range';
  basis: string;
  basisDetail: string;
  caller: string;
}

/**
 * `available: false` is a real answer — it means no estimator exists for this
 * task kind in this build, and `estimate.reason` says so. It is never a zero,
 * and it is never rendered as "costs nothing".
 */
export interface ContentCostEstimate {
  available: boolean;
  provider: string | null;
  assumedDefaults?: boolean;
  reason?: string;
  ranges: CostEstimateRange[];
  notes: string[];
}

/** The pre-flight estimate response: the estimate plus the ceilings it was checked against. */
export interface CostEstimateView {
  projectId: string;
  taskKind: string;
  requestedConfiguration: Record<string, unknown>;
  estimate: ContentCostEstimate;
  /** Whether the caller must reserve before starting. Always true for paid work. */
  reservationRequired: boolean;
  reservationRationale: string;
  affordability: 'affordable' | 'over-cap' | 'requires-approval' | 'unknown';
  notes: string[];
}

// ── Envelope guards ─────────────────────────────────────────────────────

/**
 * These three routes answer with a bare JSON array rather than an envelope.
 * §10.2 forbids reading an unexpected shape as "no data", so a non-array
 * payload throws instead of rendering as an empty list.
 */
function asArray<T>(payload: unknown, what: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: `Expected a list of ${what} but the response was not an array.`,
    body: payload,
  });
}

/**
 * The single-row routes answer with the row itself, unenveloped. A null or
 * non-object body is a broken contract, not an empty record (§10.2).
 */
function asObject<T>(payload: unknown, what: string): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload as T;
  throw new ApiError({
    kind: 'unknown',
    status: 0,
    message: `Expected a single ${what} but the response was not an object.`,
    body: payload,
  });
}

// ── Content briefs (G09) ────────────────────────────────────────────────

export interface ListBriefsQuery {
  status?: BriefStatus;
  assetType?: ContentAssetType;
  /** Collapse to the highest version of each title. */
  latestOnly?: boolean;
}

export async function listContentBriefs(
  projectId: string,
  query: ListBriefsQuery = {},
  options?: { signal?: AbortSignal },
): Promise<{ briefs: ContentBrief[] }> {
  return api.get<{ briefs: ContentBrief[] }>(`/projects/${projectId}/content-briefs`, {
    ...options,
    query: { status: query.status, assetType: query.assetType, latestOnly: query.latestOnly },
  });
}

export async function getContentBrief(
  projectId: string,
  briefId: string,
  options?: { signal?: AbortSignal },
): Promise<ContentBrief> {
  const payload = await api.get<unknown>(
    `/projects/${projectId}/content-briefs/${briefId}`,
    options,
  );
  return asObject<ContentBrief>(payload, 'content brief');
}

/** Every version of the same title, oldest first — what changed since v1. */
export async function listBriefVersions(
  projectId: string,
  briefId: string,
  options?: { signal?: AbortSignal },
): Promise<{ versions: ContentBrief[] }> {
  return api.get<{ versions: ContentBrief[] }>(
    `/projects/${projectId}/content-briefs/${briefId}/versions`,
    options,
  );
}

export interface CreateBriefInput {
  title: string;
  assetType?: ContentAssetType;
  targetQuery?: string;
  audience?: string;
  intent?: 'informational' | 'commercial' | 'transactional' | 'navigational';
  angle?: string;
  mustInclude?: string[];
  wordTarget?: number;
  language?: string;
  sourceType?: string;
  sourceId?: string;
}

/** Creates version 1 of a new instruction set, in `draft`. */
export async function createContentBrief(
  projectId: string,
  input: CreateBriefInput,
): Promise<ContentBrief> {
  const payload = await api.post<unknown>(`/projects/${projectId}/content-briefs`, input);
  return asObject<ContentBrief>(payload, 'content brief');
}

export interface UpdateBriefInput extends Partial<CreateBriefInput> {
  status?: BriefStatus;
}

/**
 * Edit a brief, or move it through draft → approved → archived.
 *
 * Editing a brief that is already approved does **not** rewrite it: the server
 * forks a new version (back at `draft`) so a generation job that recorded
 * `briefId + briefVersion` keeps pointing at the instructions it actually used.
 * The returned row may therefore be a different id than the one passed in.
 */
export async function updateContentBrief(
  projectId: string,
  briefId: string,
  patch: UpdateBriefInput,
): Promise<ContentBrief> {
  const payload = await api.patch<unknown>(
    `/projects/${projectId}/content-briefs/${briefId}`,
    patch,
  );
  return asObject<ContentBrief>(payload, 'content brief');
}

// ── Asset content and revisions (G09) ───────────────────────────────────

export async function getAssetContent(
  projectId: string,
  assetId: string,
  options?: { signal?: AbortSignal },
): Promise<AssetContent> {
  const payload = await api.get<unknown>(
    `/projects/${projectId}/growth-execution/assets/${assetId}`,
    options,
  );
  return asObject<AssetContent>(payload, 'asset');
}

/** Every saved revision, newest first. Immutable: the previous row is never mutated. */
export async function listAssetRevisions(
  projectId: string,
  assetId: string,
  options?: { signal?: AbortSignal },
): Promise<{ revisions: ContentRevision[] }> {
  return api.get<{ revisions: ContentRevision[] }>(
    `/projects/${projectId}/growth-execution/assets/${assetId}/revisions`,
    options,
  );
}

export interface SaveAssetContentInput {
  title?: string;
  body?: string;
  /**
   * Sent **whole**, never as a patch: the server falls back to the previous
   * revision's fields only when the key is absent, so a partial object would
   * silently drop the keys left out.
   */
  fields?: Record<string, unknown>;
  /** The `currentVersion` the edit was based on. A mismatch is a 409. */
  expectedVersion: number;
}

/**
 * Save an edit. The route is `.../assets/:assetId/content` — the bare
 * `PATCH .../assets/:assetId` belongs to growth-execution's lifecycle
 * transition and would not reach this handler.
 */
export async function saveAssetContent(
  projectId: string,
  assetId: string,
  input: SaveAssetContentInput,
): Promise<AssetContent> {
  const payload = await api.patch<unknown>(
    `/projects/${projectId}/growth-execution/assets/${assetId}/content`,
    input,
  );
  return asObject<AssetContent>(payload, 'asset');
}

/** The server's state when a save was rejected as stale. */
export interface VersionConflict {
  currentVersion: number;
  current: ContentRevision | null;
  message: string;
}

/**
 * Reads a 409 from `saveAssetContent` into the server's current state, so the
 * screen can offer a real reload/compare instead of a retry that would fail
 * the same way. Returns null for every other error class.
 */
export function versionConflictOf(error: unknown): VersionConflict | null {
  if (!(error instanceof ApiError) || error.kind !== 'conflict') return null;
  const body = error.body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.currentVersion !== 'number') return null;
  return {
    currentVersion: record.currentVersion,
    current: (record.current ?? null) as ContentRevision | null,
    message: typeof record.message === 'string' ? record.message : error.message,
  };
}

/**
 * The asset's lifecycle ("Record as published", §5.8 Stage G). This is the
 * plain `PATCH .../assets/:assetId` route — a different handler from the
 * content save above, and the one the design plan names for recording a live
 * URL after a human publishes in the CMS.
 */
export async function recordAssetLifecycle(
  projectId: string,
  assetId: string,
  input: { status: GrowthAssetStatus; assetUrl?: string },
): Promise<GrowthAsset> {
  const payload = await api.patch<unknown>(
    `/projects/${projectId}/growth-execution/assets/${assetId}`,
    input,
  );
  return asObject<GrowthAsset>(payload, 'asset');
}

// ── The asset library ───────────────────────────────────────────────────

export async function listGrowthAssets(
  projectId: string,
  query: { assetType?: ContentAssetType; status?: GrowthAssetStatus } = {},
  options?: { signal?: AbortSignal },
): Promise<{ assets: GrowthAsset[] }> {
  return api.get<{ assets: GrowthAsset[] }>(`/projects/${projectId}/growth-execution/assets`, {
    ...options,
    query: { assetType: query.assetType, status: query.status },
  });
}

export interface CreateAssetsInput {
  assetTypes?: ContentAssetType[];
  /** Source gaps per recommendation category to build briefs from (1–5, default 2). */
  perCategoryLimit?: number;
  /** Refines each brief with one LLM call — 503 without a configured provider. */
  useLlm?: boolean;
}

/**
 * "Create recommended assets" — one **brief** (title + angle, not copy) per
 * open, actionable gap, grouped by its recommendation category. This is the
 * CT01 action; it is a write, so it is only ever called from an explicit
 * confirmation.
 */
export async function createRecommendedAssets(
  projectId: string,
  input: CreateAssetsInput,
): Promise<{ assets: GrowthAsset[] }> {
  return api.post<{ assets: GrowthAsset[] }>(
    `/projects/${projectId}/growth-execution/assets`,
    input,
  );
}

/**
 * Priority keyword topics and ad angles.
 *
 * **An empty array means no keyword-research set has run**, not "no
 * opportunities" — the endpoint swallows the missing-set error and returns [].
 * Screens must render that as `not-measured` with the keyword-research
 * prerequisite rather than as an empty result list.
 */
export async function listTopicSuggestions(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<TopicSuggestion[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/growth-execution/topics`, options);
  return unwrap<TopicSuggestion[]>(payload, 'topics');
}

// ── Gap-derived recommendations (CT01's other half) ─────────────────────

export type RecommendationCategory =
  | 'seo-improvements'
  | 'content-strategy'
  | 'social-strategy'
  | 'reputation-strategy'
  | 'search-aeo-strategy'
  | 'conversion-optimization'
  | 'technology-improvements'
  | 'advertising-opportunities'
  | 'market-expansion';

export const RECOMMENDATION_CATEGORY_LABELS: Record<string, string> = {
  'seo-improvements': 'SEO improvements',
  'content-strategy': 'Content strategy',
  'social-strategy': 'Social strategy',
  'reputation-strategy': 'Reputation strategy',
  'search-aeo-strategy': 'Search / AEO strategy',
  'conversion-optimization': 'Conversion optimization',
  'technology-improvements': 'Technology improvements',
  'advertising-opportunities': 'Advertising opportunities',
  'market-expansion': 'Market expansion',
};

/** One classified finding. A strength has no recommendation category — nothing to act on. */
export interface GapRow {
  id: string;
  title: string;
  description: string;
  dimension: string;
  action: string;
  category: 'issue' | 'gap' | 'opportunity' | 'strength' | 'risk' | string;
  recommendationCategory: RecommendationCategory | null;
  /** 1–5 disclosed band. Null on every strength. */
  impactScore: number | null;
  effortScore: number | null;
  priorityScore: number | null;
  status: string;
}

/**
 * The project's classified gaps.
 *
 * **`analysisId === ''` means gap analysis has never run for this project** —
 * the service returns an empty set rather than a 404. That is `not-measured`,
 * not "no opportunities", and CT01 renders it as such with the prerequisite.
 */
export async function listGaps(
  projectId: string,
  query: { status?: string; category?: string } = {},
  options?: { signal?: AbortSignal },
): Promise<{ analysisId: string; gaps: GapRow[] }> {
  const payload = await api.get<unknown>(`/projects/${projectId}/gap-analysis`, {
    ...options,
    query: { status: query.status, category: query.category },
  });
  const body = asObject<{ id: string; gaps: GapRow[] }>(payload, 'gap analysis');
  return { analysisId: body.id, gaps: Array.isArray(body.gaps) ? body.gaps : [] };
}

// ── Generation jobs (G09) ───────────────────────────────────────────────

export interface CreateGenerationJobInput {
  briefId: string;
  /** The exact version reviewed. A mismatch is a 422, never a silent substitution. */
  briefVersion: number;
  assetType?: 'article' | 'ad-copy';
  /** One item per topic. An empty array is valid and records a zero-requested job. */
  items: Array<{ topicId: string; subject?: string }>;
  sourceClaimIds?: string[];
  voiceContextVersion?: string;
  language?: string;
  constraints?: string;
}

export async function listGenerationJobs(
  projectId: string,
  query: { status?: GenerationJobStatus; limit?: number } = {},
  options?: { signal?: AbortSignal },
): Promise<{ jobs: GenerationJob[] }> {
  return api.get<{ jobs: GenerationJob[] }>(`/projects/${projectId}/content-jobs`, {
    ...options,
    query: { status: query.status, limit: query.limit },
  });
}

export async function getGenerationJob(
  projectId: string,
  jobId: string,
  options?: { signal?: AbortSignal },
): Promise<GenerationJob> {
  const payload = await api.get<unknown>(`/projects/${projectId}/content-jobs/${jobId}`, options);
  return asObject<GenerationJob>(payload, 'generation job');
}

/**
 * Runs the batch and returns the **finished** job — this route is synchronous,
 * so the response already carries requested/succeeded/failed per item. It is
 * never called on page load.
 */
export async function createGenerationJob(
  projectId: string,
  input: CreateGenerationJobInput,
): Promise<GenerationJob> {
  const payload = await api.post<unknown>(`/projects/${projectId}/content-jobs`, input);
  return asObject<GenerationJob>(payload, 'generation job');
}

/** Re-runs only the failed, retryable items — with the same brief version. */
export async function retryGenerationJob(
  projectId: string,
  jobId: string,
  itemIds?: string[],
): Promise<GenerationJob> {
  const payload = await api.post<unknown>(`/projects/${projectId}/content-jobs/${jobId}/retry`, {
    itemIds,
  });
  return asObject<GenerationJob>(payload, 'generation job');
}

// ── Pre-flight cost estimate (G12) ──────────────────────────────────────

/**
 * A dry estimate: not a charge and not a reservation, and by default it makes
 * no provider call at all. For `content-generation` this build has no
 * estimator, so the honest answer is `available: false` with the reason.
 */
export async function estimateContentGeneration(
  projectId: string,
  requestedConfiguration: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<CostEstimateView> {
  const payload = await api.post<unknown>(
    `/projects/${projectId}/cost-estimates`,
    {
      taskKind: 'content-generation',
      requestedConfiguration,
      checkProviderBalance: false,
    },
    options,
  );
  const view = asObject<CostEstimateView>(payload, 'cost estimate');
  // `estimate` is a distinct key on the response, not a wrapper for the whole
  // body — unwrap both it and the ranges so a shape change fails loudly here
  // rather than rendering as "no cost".
  const estimate = unwrap<ContentCostEstimate>(view, 'estimate');
  return { ...view, estimate: { ...estimate, ranges: estimate.ranges ?? [] } };
}

// ── Claims discipline (FR-9.4) ──────────────────────────────────────────

/**
 * §5.8 Stage E: the deterministic discipline check over drafted copy. The
 * current generator is **not** automatically protected by the claim-approval
 * workflow, so this has to be run deliberately and its result read by a human.
 */
export async function checkCopy(
  projectId: string,
  copy: string,
  allowRates = false,
): Promise<CopyCheckReport> {
  const payload = await api.post<unknown>(`/projects/${projectId}/claims/check`, {
    copy,
    allowRates,
  });
  return unwrap<CopyCheckReport>(payload, 'report') ?? (payload as CopyCheckReport);
}

export async function listClaims(
  projectId: string,
  status?: 'draft' | 'approved' | 'blocked',
  options?: { signal?: AbortSignal },
): Promise<ClaimRow[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/claims`, {
    ...options,
    query: { status },
  });
  return asArray<ClaimRow>(payload, 'claims');
}

// ── Approvals bound to content revisions (G10) ──────────────────────────

export async function listContentApprovals(
  projectId: string,
  query: { status?: ApprovalStatus; artifactId?: string } = {},
  options?: { signal?: AbortSignal },
): Promise<{ requests: ApprovalRequest[] }> {
  return api.get<{ requests: ApprovalRequest[] }>(`/projects/${projectId}/approvals`, {
    ...options,
    query: { artifactType: 'content', status: query.status, artifactId: query.artifactId },
  });
}

/**
 * The claim/source review records tied to one exact revision.
 *
 * Not project-scoped: `CheckResult` carries no owning column, so the route
 * takes `subjectType` + `subjectId` and is restricted to admin/delivery-lead.
 * A caller that is not one of those gets a 403 with no retry control, which is
 * the correct outcome — the screen says so rather than hiding the section.
 */
export async function listRevisionChecks(
  subjectId: string,
  subjectType: 'content-revision' = 'content-revision',
  options?: { signal?: AbortSignal },
): Promise<{ results: RevisionCheckResult[] }> {
  return api.get<{ results: RevisionCheckResult[] }>('/approvals/check-results', {
    ...options,
    query: { subjectType, subjectId },
  });
}

// ── Publication destinations (G11) ──────────────────────────────────────

/**
 * Where content can be published from. A row existing is **not** a working
 * channel: `providerImplemented` says whether this build has an adapter and
 * `credentialConfigured` whether the secret currently resolves.
 */
export async function listPublishDestinations(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<{ destinations: PublishDestination[] }> {
  return api.get<{ destinations: PublishDestination[] }>(
    `/projects/${projectId}/publish-destinations`,
    options,
  );
}
