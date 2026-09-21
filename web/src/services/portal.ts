import { api, unwrap } from '@/lib/api';
import type { PortalProject } from './types';
import type { ReportData } from './reports';

/**
 * Client-portal adapter (Appendix C.7).
 *
 * Every function here is scoped by the **server** from the caller's JWT. None
 * of them takes a `clientId` argument, and that absence is the point: a client
 * cannot ask for another client's data by editing a parameter, and no caller
 * has to remember to pass the right scope (design_plan §10.1, G03).
 *
 * These are the read models the client portal is allowed to see. Where a
 * figure is missing — a project never scored — it comes back `null` and is
 * rendered as "not measured", never as zero (§3.5).
 */

export interface PortalReportSummary {
  id: string;
  slug: string;
  title: string;
  /** ISO 8601. */
  createdAt: string;
  scoreTotal?: number | null;
  scoreBand?: string | null;
  projectId?: string;
  projectName?: string;
}

export async function listPortalProjects(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ projects: PortalProject[] }>('/portal/projects', options);
  return unwrap<PortalProject[]>(payload, 'projects');
}

/**
 * A project as `GET /api/portal/projects` actually returns it today
 * (`client-portal.types.ts` → `PortalProjectDto`).
 *
 * This is a second, correctly-typed read of the same endpoint rather than a
 * replacement for {@link listPortalProjects}: that one is typed by
 * `services/types.ts`'s `PortalProject`, which declares `status` and `score` —
 * fields the backend does not send (it sends `onboardingStatus` and
 * `latestScore`). `services/types.ts` is outside this build's write scope, so
 * the corrected shape lives here and the CP02 screen binds to this instead.
 *
 * `lastAuditAt` is the **latest report's** created time, not an audit-run
 * timestamp — design_plan §4.5 CP02 flags exactly this ("source uses report
 * time as lastAuditAt, label carefully"), so no screen may print it as
 * "last audit".
 */
export interface PortalProjectSummary {
  id: string;
  name: string;
  domain: string;
  /** Day-1 pipeline progress: pending | running | completed | failed. */
  onboardingStatus: string | null;
  /** The stage currently running or failed. Null once complete. */
  onboardingStep: string | null;
  /** Latest REPORT score. Null when no report has ever been generated. */
  latestScore: number | null;
  latestBand: string | null;
  /** Latest report's created time. Not an audit timestamp — see above. */
  lastAuditAt: string | null;
}

export async function listPortalProjectSummaries(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ projects: PortalProjectSummary[] }>('/portal/projects', options);
  return unwrap<PortalProjectSummary[]>(payload, 'projects');
}

export async function listPortalReports(options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ reports: PortalReportSummary[] }>('/portal/reports', options);
  return unwrap<PortalReportSummary[]>(payload, 'reports');
}

/**
 * A released report, by slug.
 *
 * The backend returns 404 both when the report does not exist and when it
 * belongs to a different client — deliberately, so this cannot be used to probe
 * for other clients' report slugs. Screens must therefore render the same
 * "not available" copy for both cases.
 *
 * The payload is the same `ReportData` an operator's report reader receives,
 * with one difference that matters: `Report.visibility: "private"` means "not
 * publicly link-shareable", not "hidden from the client", so the client reads
 * their own report either way. It is returned as **JSON**, never as HTML — §10.5
 * forbids injecting fetched markup.
 */
export async function getPortalReport(slug: string, options?: { signal?: AbortSignal }) {
  return api.get<ReportData>(`/portal/reports/${encodeURIComponent(slug)}`, options);
}

/**
 * The signed-in client's own identity (G01 `GET /api/portal/me`).
 *
 * Distinct from the operator `SafeUser`: it never carries `role`, and it always
 * carries the Client the login belongs to.
 *
 * NOTE (2026-09): this route is **not registered** in the running backend.
 * `AuthService.getPortalMe` exists and returns exactly this shape, but no
 * `@ClientPortal()` controller exposes it — `AuthController`'s `me` is
 * operator-only by design. Calls therefore 404 until the controller ships, and
 * screens must render that as an explicit unavailable state rather than as an
 * empty profile.
 */
export interface PortalMe {
  id: string;
  email: string;
  name: string;
  type: 'client';
  /** Drives the forced first-password-change flow — see the CP15 note. */
  mustChangePassword: boolean;
  client: {
    id: string;
    name: string;
    status: string;
  };
  createdAt: string;
}

export async function getPortalMe(options?: { signal?: AbortSignal }) {
  return api.get<PortalMe>('/portal/me', options);
}

// ── P08 §13.5/§14.4 — client-safe content ───────────────────────────────

/**
 * Client content list. **Only pieces with at least one explicitly shared
 * revision appear here at all.**
 *
 * That is enforced on the server (`content-workspace.service.ts`'s
 * `listClientSafeItems`), not by this adapter or any screen: an unshared draft
 * is absent from the response, so a client cannot count it, link to it, or
 * learn it exists. §14.4's closing rule — "Hiding a button is not access
 * control" — is why the omission happens at the query, and why this function
 * has no filter parameter that could widen it.
 */
export interface PortalContentItem {
  assetId: string;
  title: string;
  assetType: string;
  /** not-shared | awaiting-review | changes-requested | approved | expired-superseded. */
  clientReviewState: string;
  /** unscheduled | planned | scheduled | publishing | published | failed. */
  publicationStatus: string;
  updatedAt: string;
}

export async function listPortalContent(projectId: string, options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ items: PortalContentItem[] }>(
    `/portal/projects/${projectId}/content`,
    options,
  );
  return unwrap<PortalContentItem[]>(payload, 'items');
}

/**
 * One shared piece, at the **explicitly shared revision**.
 *
 * `revision` is the latest revision whose `clientVisible` flag is set — never
 * the latest internal draft, and never inferred from an approval's existence.
 * `history` lists only shared revisions, so an internal iteration does not
 * show up as a gap the client can ask about.
 *
 * There is no prompt, provider, model, cost or staff-identity field in this
 * shape, and none can be added by a screen: the server builds this projection
 * from a fixed set of columns.
 *
 * A piece with nothing shared answers **404**, not an empty body, so "nothing
 * has been shared yet" and "this piece does not exist" are never confused.
 */
export interface PortalContentDetail {
  assetId: string;
  title: string;
  assetType: string;
  clientReviewState: string;
  revision: {
    revision: number;
    title: string | null;
    body: string | null;
    fields: Record<string, unknown>;
    sharedAt: string | null;
  };
  history: Array<{ revision: number; sharedAt: string | null }>;
  /** The client-reviewer approval status for this exact revision, when one exists. */
  approvalStatus: string | null;
}

export async function getPortalContent(
  projectId: string,
  assetId: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<PortalContentDetail>(
    `/portal/projects/${projectId}/content/${encodeURIComponent(assetId)}`,
    options,
  );
}

// ── C4 §13/§20 — prompt visibility + add/delete request queue ──────────

/** One buyer prompt, exactly as `measurement` runs it — read-only. */
export interface PortalQuerySetItem {
  id: string;
  querySetId: string;
  prompt: string;
  funnelStage: string;
  createdAt: string;
}

/** One active, versioned prompt set (one persona) — read-only. */
export interface PortalQuerySet {
  id: string;
  projectId: string;
  version: number;
  persona: string;
  label: string | null;
  status: string;
  source: string;
  items: PortalQuerySetItem[];
  createdAt: string;
  activatedAt: string | null;
}

export async function listPortalPrompts(projectId: string, options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ sets: PortalQuerySet[] }>(`/portal/projects/${projectId}/prompts`, options);
  return unwrap<PortalQuerySet[]>(payload, 'sets');
}

export type PromptRequestAction = 'add' | 'remove';
export type PromptRequestStatus = 'pending' | 'approved' | 'declined';

/**
 * One prompt add/delete request and its lifecycle. `overQuota` is a §20
 * upsell flag the admin sees — it never blocks submission.
 */
export interface PortalPromptRequest {
  id: string;
  projectId: string;
  action: PromptRequestAction;
  prompt: string | null;
  persona: string | null;
  targetItemId: string | null;
  targetPromptText: string | null;
  note: string | null;
  status: PromptRequestStatus;
  activePromptCount: number;
  planPromptLimit: number | null;
  planTier: string;
  overQuota: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export async function listPortalPromptRequests(projectId: string, options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ requests: PortalPromptRequest[] }>(
    `/portal/projects/${projectId}/prompt-requests`,
    options,
  );
  return unwrap<PortalPromptRequest[]>(payload, 'requests');
}

export interface CreatePromptRequestInput {
  action: PromptRequestAction;
  prompt?: string;
  persona?: string;
  targetItemId?: string;
  note?: string;
}

export async function createPortalPromptRequest(
  projectId: string,
  input: CreatePromptRequestInput,
  options?: { signal?: AbortSignal },
) {
  return api.post<PortalPromptRequest>(`/portal/projects/${projectId}/prompt-requests`, input, options);
}

// ── C4 §14/§22 — structured "request new content" form ─────────────────

export type ContentRequestPriority = 'low' | 'normal' | 'high';

export interface PortalContentRequest {
  id: string;
  projectId: string;
  contentType: string;
  topic: string;
  priority: ContentRequestPriority;
  note: string | null;
  growthAssetId: string;
  createdAt: string;
}

export async function listPortalContentRequests(projectId: string, options?: { signal?: AbortSignal }) {
  const payload = await api.get<{ requests: PortalContentRequest[] }>(
    `/portal/projects/${projectId}/content-requests`,
    options,
  );
  return unwrap<PortalContentRequest[]>(payload, 'requests');
}

export interface CreateContentRequestInput {
  contentType: string;
  topic: string;
  priority?: ContentRequestPriority;
  note?: string;
}

export async function createPortalContentRequest(
  projectId: string,
  input: CreateContentRequestInput,
  options?: { signal?: AbortSignal },
) {
  return api.post<PortalContentRequest>(`/portal/projects/${projectId}/content-requests`, input, options);
}
