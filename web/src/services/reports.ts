import { api, unwrap, ApiError } from '@/lib/api';

/**
 * Report adapter — operator side of design_plan.md RP01–RP05 and the client's
 * CP11/CP12.
 *
 * The type below mirrors `backend/src/modules/reporting/reporting.types.ts`
 * `ReportData`. Several of its members are **nullable by design** and the
 * distinction matters when rendering:
 *
 *   `growthPlan`, `backlinks`, `presence`, `competitors` are all `null` when
 *   the corresponding run has never happened for the project. Report
 *   generation deliberately does not trigger those runs — it reads whatever
 *   already exists. A `null` here means "this section was not part of this
 *   snapshot", and it must render as an absent section, **not** as an empty
 *   one or a zero.
 */

export interface ReportFinding {
  type: string;
  label: string;
  [key: string]: unknown;
}

export interface ReportRoadmapItem {
  [key: string]: unknown;
}

export interface ReportSubScore {
  key?: string;
  label?: string;
  score?: number;
  [key: string]: unknown;
}

export interface ReportData {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  targetUrl: string;
  visibility: 'private' | 'public';
  executiveSummary: string;
  scoreTotal: number;
  scoreBand: string;
  subScores: ReportSubScore[];
  findings: ReportFinding[];
  roadmap: ReportRoadmapItem[];
  /** Null when neither strategy nor findings has run for this project. */
  growthPlan: Record<string, unknown> | null;
  /** Null when the backlinks refresh has never run. Never fetched by generation. */
  backlinks: Record<string, unknown> | null;
  /** Null when digital-presence discovery has never run. */
  presence: Record<string, unknown> | null;
  /** Null when the project has no tracked competitors. */
  competitors: Record<string, unknown> | null;
  createdAt: string;

  // ── G05 — both axes, read straight off the row ──────────────────────
  // `GET :slug/view` returns these. They are declared optional so a response
  // from before the lifecycle shipped still type-checks; every screen must
  // read them from `getReportLifecycle`, which is the route that owns them.

  /** The editorial state: has this been reviewed and released to its client? */
  status?: ReportEditorialStatus;
  /** The revision the client is currently shown. Null when nothing is released. */
  releasedRevision?: number | null;
  releasedAt?: string | null;
  releasedBy?: string | null;
  /** The evidence manifest pinned at generation — null when pinning failed. */
  manifestId?: string | null;
  /**
   * D11 provenance: which rubric and which ScoreRun produced `scoreTotal`.
   * Null means **unrecorded** (a report generated before 2026-09-16, or one
   * whose manifest pinning failed) — never "the project's latest run". A
   * screen must render null as unrecorded rather than filling it in.
   */
  rubricVersion?: number | null;
  scoreRunId?: string | null;
}

// ── G05 — the report editorial lifecycle (RP04, RP05) ─────────────────────

/**
 * The editorial axis. `Report.status` is the report's *summary* state and is
 * sticky once released: while a newer revision is prepared, the report stays
 * `released` and `releasedRevision` keeps pointing at the version the client
 * is still reading. The in-progress version's own state is on
 * {@link ReportRevisionRow.status}.
 */
export type ReportEditorialStatus =
  | 'draft'
  | 'in-review'
  | 'approved'
  | 'released'
  | 'withdrawn';

/** A revision's own state. Adds `superseded`, which is not a `Report.status` value. */
export type ReportRevisionStatus = ReportEditorialStatus | 'superseded';

export interface ReportRevisionRow {
  id: string;
  reportId: string;
  revision: number;
  status: ReportRevisionStatus;
  title: string | null;
  manifestId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** `approved` | `changes-requested` | `grandfathered` — the recorded QA decision. */
  decision: string | null;
  decisionNote: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  withdrawnAt: string | null;
  /** Id of the revision that superseded this one. Records, never rewrites. */
  supersededBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The payload frozen into a revision at review-lock time and never rewritten
 * afterwards. It is what a reviewer approves and what a released client reads,
 * so it is deliberately the only thing a checklist on RP04 should evaluate.
 */
export interface ReportRevisionSnapshot {
  title: string;
  targetUrl: string;
  executiveSummary: string;
  scoreTotal: number;
  scoreBand: string;
  subScores: ReportSubScore[];
  findings: ReportFinding[];
  roadmap: ReportRoadmapItem[];
  growthPlan: Record<string, unknown> | null;
  backlinks: Record<string, unknown> | null;
  presence: Record<string, unknown> | null;
  competitors: Record<string, unknown> | null;
  /** D11 — null means unrecorded, never inferred. */
  rubricVersion: number | null;
  scoreRunId: string | null;
  manifestId: string | null;
  periodId: string | null;
  cohortId: string | null;
  /** When generation last wrote the content — not the reporting window, not the source dates. */
  contentCreatedAt: string;
  contentUpdatedAt: string;
  /** When this snapshot was locked. Distinct from every date inside it. */
  snapshotAt: string;
}

export interface ReportRevisionDetail extends ReportRevisionRow {
  snapshot: ReportRevisionSnapshot;
}

/**
 * The release gate's verdict, read-only (G10).
 *
 * A **disclosure, not a permission**: the gate re-runs inside `publish`, so a
 * screen uses this to say why release is unavailable instead of letting the
 * operator find out from a refused request.
 */
export interface ReportPublishBlock {
  reason: string;
  message: string;
}

/**
 * Both axes for one report, plus the versions being prepared.
 *
 * `status`/`releasedRevision` is the editorial axis; `visibility` is the public
 * "anyone with the URL" axis. They share no code path and must be rendered as
 * two controls with two consequences (§6.4, G19/D10).
 */
export interface ReportLifecycle {
  reportId: string;
  slug: string;
  status: ReportEditorialStatus;
  visibility: 'private' | 'public';
  releasedRevision: number | null;
  releasedAt: string | null;
  releasedBy: string | null;
  /** The newest revision that is not settled — what review/approve act on. */
  inFlightRevision: ReportRevisionRow | null;
  /** Every revision, newest first. */
  revisions: ReportRevisionRow[];
  publishBlocked: ReportPublishBlock | null;
}

export interface ReportShareLink {
  id: string;
  reportId: string;
  /** The revision that was current when the link was minted — an audit record, not a pin. */
  revisionId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdBy: string | null;
  createdAt: string;
}

/**
 * Returned **once**, on creation. The raw token is never stored — only its
 * sha256 — so no later read can reconstruct a working link and this is the
 * only moment it can be handed over.
 */
export interface ReportShareLinkCreated extends ReportShareLink {
  token: string;
  /** Path the token opens, relative to this app's origin (e.g. `/api/reports/shared/<token>`). */
  url: string;
}

export type ReportDeliveryChannel = 'email' | 'link-share' | 'manual';
export type ReportDeliveryStatus = 'queued' | 'sent' | 'failed';

export interface ReportDeliveryAttempt {
  id: string;
  reportId: string;
  /** The released revision this attempt pointed at. Null when none was resolvable. */
  revisionId: string | null;
  channel: string;
  recipient: string;
  subject: string | null;
  /**
   * `queued` = recorded before the provider was called and never settled —
   * "attempted, outcome unknown". `sent` = the **provider accepted** the
   * message (or, for `link-share`/`manual`, the operator's own record); never
   * "the client received it". `failed` is a recorded outcome, not a failed
   * request, and it never changes the report's release state.
   */
  status: string;
  error: string | null;
  attemptedBy: string | null;
  attemptedAt: string;
}

const lifecyclePath = (projectId: string, slug: string) =>
  `/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(slug)}`;

/** A named list field that must be present: §10.2 forbids reading a missing shape as "empty". */
function requireList<T>(payload: unknown, key: string): T[] {
  const rows = unwrap<T[]>(payload, key);
  if (!Array.isArray(rows)) {
    throw new Error(`The response's \`${key}\` field was not a list.`);
  }
  return rows;
}

/**
 * Both axes for one report, plus the release gate's verdict.
 *
 * This is the read RP04 and RP05 are built on: it carries the editorial state,
 * the public-link flag, the in-flight revision and `publishBlocked`, so a
 * screen never has to infer one from another.
 */
export async function getReportLifecycle(
  projectId: string,
  slug: string,
  options?: { signal?: AbortSignal },
): Promise<ReportLifecycle> {
  const lifecycle = await api.get<ReportLifecycle>(`${lifecyclePath(projectId, slug)}/lifecycle`, options);
  if (!lifecycle || !Array.isArray(lifecycle.revisions)) {
    throw new Error('GET :slug/lifecycle answered without a `revisions` list.');
  }
  return lifecycle;
}

/** Revision metadata, newest first. No snapshot bodies — see {@link getReportRevision}. */
export async function listReportRevisions(
  projectId: string,
  slug: string,
  options?: { signal?: AbortSignal },
): Promise<ReportRevisionRow[]> {
  return requireList<ReportRevisionRow>(
    await api.get<unknown>(`${lifecyclePath(projectId, slug)}/revisions`, options),
    'revisions',
  );
}

/** One revision **with its frozen snapshot** — exactly what a reviewer approves. */
export async function getReportRevision(
  projectId: string,
  slug: string,
  revision: number,
  options?: { signal?: AbortSignal },
): Promise<ReportRevisionDetail> {
  return api.get<ReportRevisionDetail>(
    `${lifecyclePath(projectId, slug)}/revisions/${revision}`,
    options,
  );
}

/**
 * Lock the report's current content for review and freeze its snapshot.
 *
 * Three server-side cases: the first review creates revision 1, a draft sent
 * back with changes re-locks the same revision, and a settled revision opens
 * revision N+1 (that is how "new data produces a new version" happens). An
 * in-review or approved revision is refused with 409 — a screen must not offer
 * this while either is the newest revision.
 */
export async function reviewReport(
  projectId: string,
  slug: string,
  note?: string,
): Promise<ReportRevisionDetail> {
  return api.post<ReportRevisionDetail>(`${lifecyclePath(projectId, slug)}/review`, {
    ...(note ? { note } : {}),
  });
}

/**
 * Record the QA decision for the revision in review.
 *
 * `changes-requested` returns it to draft (and the next review re-locks the
 * same number); `approved` is what `publish` requires. The route accepts
 * exactly these two — there is no `rejected` state on a revision, so a screen
 * must not offer one.
 */
export async function decideReportRevision(
  projectId: string,
  slug: string,
  decision: 'approved' | 'changes-requested',
  note?: string,
): Promise<ReportRevisionDetail> {
  return api.post<ReportRevisionDetail>(`${lifecyclePath(projectId, slug)}/approve`, {
    decision,
    ...(note ? { note } : {}),
  });
}

/**
 * Release an approved revision to the client.
 *
 * The G10 gate runs first and its refusal is propagated verbatim, so this can
 * 409 (`kind: 'conflict'`) for a reason `GET :slug/lifecycle` already
 * discloses as `publishBlocked`. Releasing sends nothing and mints no public
 * link: delivery and sharing are separate actions.
 */
export async function publishReport(
  projectId: string,
  slug: string,
  note?: string,
): Promise<ReportRevisionDetail> {
  return api.post<ReportRevisionDetail>(`${lifecyclePath(projectId, slug)}/publish`, {
    ...(note ? { note } : {}),
  });
}

/**
 * Pull a released report back from the client. A reason is **required** by the
 * route (a 400 without one) and is recorded on the revision.
 */
export async function withdrawReport(
  projectId: string,
  slug: string,
  reason: string,
): Promise<ReportRevisionDetail> {
  return api.post<ReportRevisionDetail>(`${lifecyclePath(projectId, slug)}/withdraw`, { reason });
}

/**
 * Every share link for a report. Never carries a token — only that a link exists
 * and whether it still resolves.
 *
 * Revoked and expired links are always included: the revocation history is the
 * point of the record, and `ReportShareLink.revokedAt` is how a screen says a
 * link is dead rather than implying it never existed.
 */
export async function listReportShareLinks(
  projectId: string,
  slug: string,
  options?: { signal?: AbortSignal },
): Promise<ReportShareLink[]> {
  return requireList<ReportShareLink>(
    await api.get<unknown>(`${lifecyclePath(projectId, slug)}/share-links`, options),
    'links',
  );
}

/**
 * Mint an expiring, revocable public link for a **released** report.
 *
 * Only a released report can be shared — an unreleased one 409s, because §6.4
 * excludes unpublished drafts from the public projection. The raw token is in
 * the returned object and in nothing else this adapter can call: the caller
 * must show it immediately or lose it.
 */
export async function createReportShareLink(
  projectId: string,
  slug: string,
  expiresInHours?: number,
): Promise<ReportShareLinkCreated> {
  return api.post<ReportShareLinkCreated>(`${lifecyclePath(projectId, slug)}/share-links`, {
    ...(expiresInHours ? { expiresInHours } : {}),
  });
}

/** Revoke a share link. Immediate and idempotent; the report's release state is untouched. */
export async function revokeReportShareLink(
  projectId: string,
  slug: string,
  linkId: string,
): Promise<ReportShareLink> {
  return api.delete<ReportShareLink>(
    `${lifecyclePath(projectId, slug)}/share-links/${encodeURIComponent(linkId)}`,
  );
}

/** The send ledger for a report, newest first. `sent` means the provider accepted — never "read". */
export async function listReportDeliveryAttempts(
  projectId: string,
  slug: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<ReportDeliveryAttempt[]> {
  return requireList<ReportDeliveryAttempt>(
    await api.get<unknown>(`${lifecyclePath(projectId, slug)}/delivery-attempts`, {
      signal: options?.signal,
      query: { limit: options?.limit ?? 50 },
    }),
    'attempts',
  );
}

/**
 * Record a delivery attempt — and, for `email`, actually attempt the send.
 *
 * A failed send answers **200** with `status: 'failed'` and the recorded error:
 * the ledger row is the resource that was created, and a failure here never
 * rolls back the release. Only a released report can be delivered at all
 * (409 otherwise), and the `email` channel requires `reportUrl` (400) because a
 * send with no link cannot work.
 */
export async function recordReportDelivery(
  projectId: string,
  slug: string,
  input: {
    recipient: string;
    subject?: string;
    channel?: ReportDeliveryChannel;
    /** The link the recipient opens. Required for the `email` channel. */
    reportUrl?: string;
  },
): Promise<ReportDeliveryAttempt> {
  return api.post<ReportDeliveryAttempt>(
    `${lifecyclePath(projectId, slug)}/delivery-attempts`,
    input,
  );
}

/**
 * The absolute URL a created share link opens.
 *
 * The server returns a path relative to the API origin, and this app serves
 * `/api/*` itself, so the browser origin is the right prefix — the same reason
 * every other URL on RP04/RP05 is built from `window.location.origin` rather
 * than assumed.
 */
export function shareLinkAbsoluteUrl(created: ReportShareLinkCreated, origin: string): string {
  return `${origin}${created.url}`;
}

export interface ReportSummaryRow {
  id: string;
  slug: string;
  title: string;
  scoreTotal?: number;
  scoreBand?: string;
  createdAt?: string;
}

/**
 * The project's reports, newest first.
 *
 * The route wraps its result in `{reports: [...]}` rather than answering with a
 * bare array (unlike `GET /projects`). §10.2 forbids reading an unexpected
 * shape as "no data", so the envelope is unwrapped explicitly and a response
 * without the key raises instead of rendering an empty library.
 *
 * This list carries `visibility` and the score but **not** the editorial state
 * — see {@link listProjectReportRows} for the screen that needs both axes.
 */
export async function listProjectReports(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ReportSummaryRow[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/reports`, options);
  const rows = unwrap<ReportSummaryRow[]>(payload, 'reports');
  if (!Array.isArray(rows)) {
    throw new Error('GET /projects/:id/reports answered with a non-list `reports` field.');
  }
  return rows;
}

/**
 * One row of the portfolio report list.
 *
 * Declared here rather than imported from `services/operations.ts` so this
 * adapter has no dependency on a module another change may be editing. It
 * mirrors `ReportRowDto` in the backend's `operations.types.ts` exactly; the
 * two fields that matter most are `status` and `visibility`, which are separate
 * on purpose (see below).
 */
export interface ReportLibraryRow {
  id: string;
  slug: string;
  title: string;
  /** The G05 editorial state: draft | in-review | approved | released | withdrawn. */
  status: string;
  /** Whether a public "anyone with the link" URL exists at all. */
  visibility: string;
  scoreTotal: number;
  scoreBand: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  /** Set when a revision was released. Null on a report that never has been. */
  releasedAt: string | null;
  createdAt: string;
}

/**
 * The same reports as the portfolio aggregation route sees them.
 *
 * `GET /operations/reports` is the only read that returns `status` (the G05
 * editorial state) alongside `visibility` (whether a public link exists), so
 * RP01, RP04 and RP05 read it rather than deriving either axis themselves.
 * Those two fields are different questions and the screen shows them as
 * separate columns; a service that merged them would make the §6.4 mistake
 * possible again further up.
 *
 * Server-paginated and scope-filtered: `projectId` narrows the caller's own
 * assigned portfolio and never extends it, and a project outside it is
 * reported as not found rather than confirmed.
 */
export async function listProjectReportRows(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<ReportLibraryRow[]> {
  const page = await api.get<{ items?: ReportLibraryRow[] }>('/operations/reports', {
    ...options,
    query: { projectId, pageSize: 100 },
  });
  if (!page || !Array.isArray(page.items)) {
    throw new Error('GET /operations/reports answered without an `items` list.');
  }
  return page.items;
}

/**
 * The report's full underlying JSON.
 *
 * Scoped server-side: this 404s when the slug belongs to a different project,
 * so a caller must pass the real project id rather than resolving by slug
 * alone (design_plan G03, line 1613).
 */
export async function getReport(
  projectId: string,
  slug: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<ReportData>(`/projects/${projectId}/reports/${slug}/view`, options);
}

/**
 * The server-rendered HTML version.
 *
 * design_plan §10.1 allows the backend's own HTML rendering to remain a
 * delivery option, and §10.5 requires that fetched HTML is never injected as
 * trusted application markup. This helper therefore returns a **URL string**
 * for use in a link or an iframe `src`, not a string of HTML to insert into
 * the page.
 */
export function reportRenderUrl(projectId: string, slug: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(slug)}/render`;
}

/**
 * Generate a report.
 *
 * `targetUrl` and `title` are both **required** by the route. This is worth
 * stating plainly because it is counter-intuitive: `targetUrl` is validated as
 * a URL and then used only in the executive summary, while the URL the report
 * actually persists is the **latest technical audit's** own `targetUrl`
 * (§5.10 step 1 — "generation always uses the latest technical audit, and
 * persists that audit's URL rather than trusting the requested URL"). A screen
 * must therefore show which audit will be used instead of implying its own
 * input decides the scope.
 *
 * Generation is not free and not idle: it scores the project, snapshots five
 * optional sources, and calls the competitor gap service, which may scan the
 * client's current technology. It also writes a new ScoreRun, so repeated
 * generation distorts a naive score-history timeline (§5.10 step 3). §10.4
 * therefore requires an explicit start, double-submit protection and a
 * reconciled timeout — which is why the screen uses `RunConfigurator`.
 *
 * A 404 means no technical audit exists for the project: that is the one
 * blocking prerequisite, and it is named rather than reported as a generic
 * failure.
 */
export async function generateReport(
  projectId: string,
  input: {
    /** Shown in the summary; the stored target comes from the latest audit. */
    targetUrl: string;
    title: string;
    /** G13 — pins an exact stored window. Omit for a moving window from today. */
    periodId?: string;
    /** G13 — the methodology cohort this report belongs to. */
    cohortId?: string;
  },
): Promise<ReportData> {
  return api.post<ReportData>(`/projects/${projectId}/reports`, input);
}

/**
 * Turn the public "anyone with the link" URL on or off.
 *
 * **This is not a QA state.** §6.4 and RP04's own note are explicit that
 * editorial release and public sharing are two independent axes: a private
 * report can be released to its client, and a released report can have no
 * public link. G05 exists to add the second axis; until it does, this is the
 * only report-state control the API offers, and it governs *unauthenticated*
 * HTML sharing only.
 *
 * The response is the server's own answer (`{slug, visibility}`), not an echo
 * of the request — RP04 renders that value so a screen can never show "public"
 * for a write the server did not make.
 */
export async function setReportVisibility(
  projectId: string,
  slug: string,
  visibility: 'private' | 'public',
): Promise<{ slug: string; visibility: string }> {
  return api.put<{ slug: string; visibility: string }>(
    `/projects/${projectId}/reports/${encodeURIComponent(slug)}/visibility`,
    { visibility },
  );
}

// ── Delivery (RP05) ─────────────────────────────────────────────────────

/**
 * The provider's answer to a send attempt.
 *
 * `delivered: true` means the email provider **accepted** the message. It is
 * not proof of inbox delivery, and §5.10 step 7 is explicit that no open/read
 * tracking exists — a screen must never upgrade this to "the client received
 * it". The attempt and the report's release state are separate facts and stay
 * separate on screen: a failed send never un-releases the report.
 */
export interface DeliveryEmailResult {
  delivered: boolean;
  messageId?: string;
  to: string;
  reportUrl: string;
  /** Set when the provider is configured but the send failed — never silent. */
  error?: string;
}

/**
 * Send the report-link email (Plunk).
 *
 * `reportUrl` is the link the recipient receives, so the caller has to choose
 * the right audience for them (§5.10 step 6):
 *
 *  - a **public** URL, which opens for anyone with it — and only works once
 *    `visibility` is `public`;
 *  - the **client portal** URL, which requires the recipient to sign in.
 *
 * An operator's bearer-authenticated preview URL will not work for an
 * unauthenticated recipient, which is why that option is not offered here.
 *
 * A 503 `unavailable` means the email provider is not configured — nothing was
 * sent, and the report's state is untouched.
 */
export async function sendReportEmail(
  projectId: string,
  input: {
    /** Absolute URL the recipient will open. */
    reportUrl: string;
    to: string;
    subject?: string;
    includeTestimonialAsk?: boolean;
  },
): Promise<DeliveryEmailResult> {
  return api.post<DeliveryEmailResult>(`/projects/${projectId}/delivery/send`, input);
}

// ── Evidence manifests (RP01 coverage, RP02 freshness) ──────────────────

/** Named reason a source row did not contribute. */
export interface EvidenceFailure {
  /** The pinned row this failure belongs to, when it is per-row. */
  id: string | null;
  reason: string;
}

/**
 * One source type's contribution to a report's evidence bundle.
 *
 * `expected`/`succeeded`/`failed`/`pending` are **attempt counts, not
 * measurements** (§6.3). `succeeded: 0` is a fact about collection, and the
 * metric it feeds is still reported as not-measured rather than as a zero.
 */
export interface EvidenceCoverage {
  expected: number;
  succeeded: number;
  failed: number;
  /** Started and not finished. Disclosed, never dropped. */
  pending: number;
  failedReason: string | null;
  pinnedCount: number;
  truncated: boolean;
}

/**
 * Freshness, kept deliberately separate from the reporting window.
 *
 * `latestSourceObservedAt` is the newest timestamp the *sources themselves*
 * carry. It is a different field from `window.endsOn`, which is the stored
 * period's own end — §6.3 forbids presenting one as the other.
 */
export interface EvidenceFreshness {
  latestSourceObservedAt: string | null;
  earliestSourceObservedAt: string | null;
  periodEndsOn: string;
  sourcesPredatePeriodEnd: boolean;
  stalenessDays: number | null;
  perSource: Record<string, string>;
  /** The sentence a surface can render without re-deriving any of the above. */
  statement: string;
}

export interface EvidenceManifestView {
  id: string;
  projectId: string;
  /** `report` or `result-set`. */
  subjectType: string;
  subjectId: string | null;
  periodId: string | null;
  cohortId: string | null;
  createdAt: string;
  window: {
    appliedBy: string;
    periodId: string | null;
    label: string | null;
    startsOn: string;
    endsOn: string;
    timezone: string;
    stored: boolean;
    days: number;
  } | null;
  manifestId: string;
  /** True when the snapshot is reproducible from stored ids. */
  pinned: boolean;
  sources: Record<string, string[]>;
  coverage: Record<string, EvidenceCoverage>;
  freshness: EvidenceFreshness;
  /** Sources that were expected but missing — named, never silently absent. */
  omissions: string[];
  truncations: string[];
  scoreRunId: string | null;
  rubricVersion: string | null;
}

/**
 * The project's evidence manifests, newest first.
 *
 * A generated report pins one with `subjectType: 'report'` and its own id, so
 * passing `subjectId` answers "which sources did this report come from, and how
 * old were they". Pinning is best-effort at generation time — a report without
 * a manifest is still a valid report, and its coverage is genuinely unrecorded
 * rather than zero.
 */
export async function listEvidenceManifests(
  projectId: string,
  query?: { subjectType?: string; subjectId?: string; periodId?: string; limit?: number },
  options?: { signal?: AbortSignal },
): Promise<EvidenceManifestView[]> {
  const payload = await api.get<unknown>(`/projects/${projectId}/evidence-manifests`, {
    ...options,
    query: { ...query, limit: query?.limit ?? 100 },
  });
  const rows = unwrap<EvidenceManifestView[]>(payload, 'manifests');
  if (!Array.isArray(rows)) {
    throw new Error('GET /projects/:id/evidence-manifests answered with a non-list field.');
  }
  return rows;
}

/**
 * Fold a manifest's per-source coverage into the shape `CoveragePanel` takes.
 *
 * Three things this deliberately does **not** do:
 *
 *  - It does not merge failed and pending into one count (§3.5: a failed source
 *    is a failure, a deferred one is accepted but not measured).
 *  - It does not turn an absent manifest into zeros. The caller passes `null`
 *    and renders the unrecorded state; this function never sees it.
 *  - It does not invent a source name. The source *type* is what the manifest
 *    records, and the reason given is the server's own `failedReason` or an
 *    explicit "no reason recorded" — never a guessed cause.
 */
export function coverageFromManifest(
  manifest: EvidenceManifestView | null,
): { expectedCount: number; successfulCount: number; failed: Array<{ name: string; reason: string }>; deferred: Array<{ name: string; reason: string }> } | null {
  if (!manifest) return null;
  const entries = Object.entries(manifest.coverage ?? {});
  if (entries.length === 0) return null;

  let expected = 0;
  let successful = 0;
  const failed: Array<{ name: string; reason: string }> = [];
  const deferred: Array<{ name: string; reason: string }> = [];

  for (const [sourceType, coverage] of entries) {
    expected += coverage.expected ?? 0;
    successful += coverage.succeeded ?? 0;
    if ((coverage.failed ?? 0) > 0) {
      failed.push({
        name: sourceType,
        reason: coverage.failedReason ?? 'No failure reason was recorded for this source.',
      });
    }
    if ((coverage.pending ?? 0) > 0) {
      deferred.push({
        name: sourceType,
        reason: `${coverage.pending} row(s) started and did not finish.`,
      });
    }
  }

  return { expectedCount: expected, successfulCount: successful, failed, deferred };
}

/**
 * The one report row for a slug, from the portfolio list.
 *
 * A 404 from the list route means the project is not visible to the caller, so
 * this is only ever used after the project itself has resolved. `null` means
 * the slug was not in the caller's page of the project's reports.
 */
export async function findReportRow(
  projectId: string,
  slug: string,
  options?: { signal?: AbortSignal },
): Promise<ReportLibraryRow | null> {
  const rows = await listProjectReportRows(projectId, options);
  return rows.find((row) => row.slug === slug) ?? null;
}

/**
 * `true` when this error is the route's documented "no such report for this
 * project" answer, which RP04/RP05 render as the neutral missing-or-private
 * state rather than as a failure to retry.
 */
export function isMissingReport(cause: unknown): boolean {
  return cause instanceof ApiError && cause.kind === 'not-found';
}
