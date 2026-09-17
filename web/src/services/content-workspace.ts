import { api, unwrap } from '@/lib/api';

/**
 * Content Workspace adapters — P08 (platform_improvement_plan.md §13.1–13.5,
 * §13.9). The canonical staff content list, detail, capability matrix and the
 * explicit client-sharing controls.
 *
 * Four rules from §13 shape this file, and each one is why a function below
 * does something the obvious version would not:
 *
 *  1. **§13.4 — four independent state axes, never one flattened status.**
 *     `editorialState`, `clientReviewState`, `publicationSummary` and
 *     `updateState` all travel on every row. `primaryBadge` is a *derived*
 *     label with a documented precedence, and it is deliberately returned
 *     alongside the axes rather than instead of them: a screen that rendered
 *     only the badge would lose "Published · Update in progress" the moment
 *     the precedence changed. {@link PRIMARY_BADGE_NOTE} states that contract
 *     where a reader of this file will see it.
 *  2. **§13.3 — one row per piece.** Placements arrive nested under their
 *     piece in `publicationSummary.placements`; they are never separate rows,
 *     and `total` is a count of pieces. A screen must not add
 *     `placements.length` to anything.
 *  3. **§13.9 — capability responses, not frontend guesses.** Which types can
 *     be generated is read from `/content-workspace/capabilities`, never from
 *     a local list. {@link generationImplementedFor} is a lookup over that
 *     response, so a writer added on the server shows up in the UI with no
 *     frontend change.
 *  4. **§13.5/§14.4 — sharing is explicit and reversible.** A revision starts
 *     private; `shareRevision`/`unshareRevision` are the only two functions
 *     that touch that state, and neither is called by rendering.
 */

/** §13.4's documented precedence rule, restated for the screens that render it. */
export const PRIMARY_BADGE_NOTE =
  'The badge is derived from the four axes below it. It never replaces them — "Published · Update in progress" means the live piece is still live.';

// ── §13.4 axes ──────────────────────────────────────────────────────────

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

export const CLIENT_REVIEW_STATES = [
  'not-shared',
  'awaiting-review',
  'changes-requested',
  'approved',
  'expired-superseded',
] as const;
export type ClientReviewState = (typeof CLIENT_REVIEW_STATES)[number];

export const PUBLICATION_SUMMARY_STATES = [
  'unscheduled',
  'planned',
  'scheduled',
  'publishing',
  'published',
  'failed',
] as const;
export type PublicationSummaryState = (typeof PUBLICATION_SUMMARY_STATES)[number];

export const UPDATE_STATES = ['no-update', 'revision-in-progress'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

/** §13.1's saved views, as filter values. "Update existing content" is a view, not a separate object. */
export const CONTENT_VIEWS = [
  'all',
  'ideas',
  'in-progress',
  'needs-review',
  'scheduled',
  'published',
  'updating',
] as const;
export type ContentView = (typeof CONTENT_VIEWS)[number];

export const CONTENT_VIEW_LABELS: Record<ContentView, string> = {
  all: 'All content',
  ideas: 'Ideas',
  'in-progress': 'In progress',
  'needs-review': 'Needs review',
  scheduled: 'Scheduled',
  published: 'Published',
  updating: 'Update existing content',
};

export const EDITORIAL_STATE_LABELS: Record<EditorialState, string> = {
  planned: 'Planned',
  drafting: 'Drafting',
  draft: 'Draft',
  'internal-review': 'Internal review',
  'changes-requested': 'Changes requested',
  'ready-for-client': 'Ready for client',
  approved: 'Approved',
};

export const CLIENT_REVIEW_STATE_LABELS: Record<ClientReviewState, string> = {
  'not-shared': 'Not shared',
  'awaiting-review': 'Awaiting client review',
  'changes-requested': 'Client requested changes',
  approved: 'Client approved',
  'expired-superseded': 'Superseded',
};

export const PUBLICATION_STATE_LABELS: Record<PublicationSummaryState, string> = {
  unscheduled: 'Not scheduled',
  planned: 'Planned placement',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Publish failed',
};

export const UPDATE_STATE_LABELS: Record<UpdateState, string> = {
  'no-update': 'No update in progress',
  'revision-in-progress': 'Update in progress',
};

// ── Records ─────────────────────────────────────────────────────────────

export interface PlacementSummary {
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

export interface PublicationSummary {
  status: PublicationSummaryState;
  /** Count per `Publication.status`. Metadata on ONE row — never added to the row count (§13.3). */
  counts: Record<string, number>;
  placements: PlacementSummary[];
}

/** One content piece, as the canonical list returns it (§13.3). */
export interface ContentWorkspaceItem {
  assetId: string;
  projectId: string;
  assetType: string;
  title: string;
  source: string;
  sourceGapId: string | null;
  sourceOpportunityId: string | null;
  market: string | null;
  language: string | null;
  assigneeId: string | null;
  editorialState: EditorialState;
  clientReviewState: ClientReviewState;
  publicationSummary: PublicationSummary;
  updateState: UpdateState;
  primaryBadge: string;
  currentVersion: number;
  hasRevision: boolean;
  promotedFromOpportunityId: string | null;
  briefFamilyId: string | null;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentWorkspaceRevisionSummary {
  id: string;
  revision: number;
  origin: string;
  authorId: string | null;
  wordCount: number;
  clientVisible: boolean;
  clientVisibleAt: string | null;
  createdAt: string;
}

export interface ContentWorkspaceApprovalSummary {
  id: string;
  reviewerType: string;
  status: string;
  artifactRevision: number | null;
  revisionId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentWorkspaceCheckSummary {
  id: string;
  checkKind: string;
  status: string;
  detail: string | null;
  createdAt: string;
}

export interface ContentWorkspaceBrief {
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
}

export interface ContentWorkspaceCurrentRevision {
  id: string;
  revision: number;
  title: string | null;
  body: string | null;
  fields: Record<string, unknown>;
  wordCount: number;
  origin: string;
  clientVisible: boolean;
  createdAt: string;
}

/** §13.5's full anatomy: header + preview/editor state + plan + review + schedule + history. */
export interface ContentWorkspaceDetail extends ContentWorkspaceItem {
  brief: ContentWorkspaceBrief | null;
  currentRevision: ContentWorkspaceCurrentRevision | null;
  revisions: ContentWorkspaceRevisionSummary[];
  approvals: ContentWorkspaceApprovalSummary[];
  checks: ContentWorkspaceCheckSummary[];
  publications: PlacementSummary[];
}

export interface ContentWorkspaceListQuery {
  /** §13.1 saved view. Applied by the server, against the same predicate that produces `total`. */
  view?: ContentView;
  q?: string;
  assetType?: string;
  editorialState?: string;
  source?: string;
  market?: string;
  language?: string;
  assigneeId?: string;
  clientVisibility?: 'shared' | 'not-shared';
  page?: number;
  pageSize?: number;
}

export interface ContentWorkspacePage {
  items: ContentWorkspaceItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** §13.9's capability matrix row — the server's answer, not a frontend assumption. */
export interface ContentCapability {
  assetType: string;
  label: string;
  generationImplemented: boolean;
  manualPlanningAvailable: boolean;
  countsAsContent: boolean;
  note: string;
}

// ── §13.3 the canonical list ────────────────────────────────────────────

/**
 * One page of the canonical content list.
 *
 * Every filter below is applied by the **server**, against the same predicate
 * that produces `total` (§13.3: "All filtering/counts/pagination must be
 * server-side and use the same predicate"). Nothing in this file filters a
 * fetched page client-side, because doing so would make the count describe a
 * different set than the rows.
 */
export async function listContentWorkspace(
  projectId: string,
  query: ContentWorkspaceListQuery = {},
  options?: { signal?: AbortSignal },
): Promise<ContentWorkspacePage> {
  return api.get<ContentWorkspacePage>(`/projects/${projectId}/content-workspace/items`, {
    ...options,
    query: {
      // 'ideas' is never sent: an idea is an Opportunity, not a content row,
      // and the workspace reads those from their own module (§13.3).
      view: query.view === 'ideas' ? undefined : query.view,
      q: query.q,
      assetType: query.assetType,
      editorialState: query.editorialState,
      source: query.source,
      market: query.market,
      language: query.language,
      assigneeId: query.assigneeId,
      clientVisibility: query.clientVisibility,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export async function getContentWorkspaceItem(
  projectId: string,
  assetId: string,
  options?: { signal?: AbortSignal },
): Promise<ContentWorkspaceDetail> {
  return api.get<ContentWorkspaceDetail>(
    `/projects/${projectId}/content-workspace/items/${assetId}`,
    options,
  );
}

export async function listContentCapabilities(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ContentCapability[]> {
  const payload = await api.get<{ capabilities: ContentCapability[] }>(
    `/projects/${projectId}/content-workspace/capabilities`,
    options,
  );
  return unwrap<ContentCapability[]>(payload, 'capabilities');
}

/** §13.3 — the staff owner filter's option source, and the assign control's. */
export async function setContentAssignee(
  projectId: string,
  assetId: string,
  assigneeId: string | null,
): Promise<ContentWorkspaceItem> {
  return api.patch<ContentWorkspaceItem>(
    `/projects/${projectId}/content-workspace/items/${assetId}/assignee`,
    { assigneeId },
  );
}

// ── §13.5/§14.4 explicit client sharing ─────────────────────────────────

/**
 * Mark one exact revision client-visible.
 *
 * §14.4's table makes this the *only* way a client sees a draft: sharing is
 * per-revision and starts `false`, so a new revision of an already-shared piece
 * is private again until someone shares it deliberately.
 */
export async function shareRevision(
  projectId: string,
  assetId: string,
  revisionId: string,
): Promise<{ shared: boolean; revisionId: string }> {
  return api.post<{ shared: boolean; revisionId: string }>(
    `/projects/${projectId}/content-workspace/items/${assetId}/revisions/${revisionId}/share`,
  );
}

export async function unshareRevision(
  projectId: string,
  assetId: string,
  revisionId: string,
): Promise<{ shared: boolean; revisionId: string }> {
  return api.post<{ shared: boolean; revisionId: string }>(
    `/projects/${projectId}/content-workspace/items/${assetId}/revisions/${revisionId}/unshare`,
  );
}

/** §13.2's staff-only lineage repair. Never automatic — an operator names both families. */
export async function mergeBriefFamilies(
  projectId: string,
  fromFamilyId: string,
  intoFamilyId: string,
): Promise<{ mergedVersions: number; briefFamilyId: string }> {
  return api.post<{ mergedVersions: number; briefFamilyId: string }>(
    `/projects/${projectId}/content-workspace/brief-families/merge`,
    { fromFamilyId, intoFamilyId },
  );
}

// ── Derived reads (pure) ────────────────────────────────────────────────

/**
 * §13.9 gate. `undefined` capabilities mean the matrix has not loaded yet —
 * which is *not* the same as "not implemented", and is why this returns
 * `undefined` rather than `false`: a screen must render "checking" rather than
 * a disabled Generate button it cannot justify.
 */
export function generationImplementedFor(
  capabilities: readonly ContentCapability[] | undefined,
  assetType: string,
): boolean | undefined {
  if (!capabilities) return undefined;
  return capabilities.find((entry) => entry.assetType === assetType)?.generationImplemented ?? false;
}

/** The asset types this project can actually generate today, from the server's matrix. */
export function generatableTypes(
  capabilities: readonly ContentCapability[] | undefined,
): readonly ContentCapability[] {
  return (capabilities ?? []).filter((entry) => entry.generationImplemented);
}

/** Total placements across a page of rows — a *placement* count, kept separate from the piece count. */
export function countPlacements(items: readonly ContentWorkspaceItem[]): number {
  return items.reduce((sum, item) => sum + item.publicationSummary.placements.length, 0);
}
