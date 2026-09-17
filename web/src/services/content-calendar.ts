import { api } from '@/lib/api';

/**
 * Content calendar adapter (P10, platform_improvement_plan.md §6.4-§6.7).
 *
 * One adapter for every scope: the project calendar
 * (`/projects/:projectId/content-calendar`), the portfolio calendar
 * (`/content-calendar`) and the client calendar
 * (`/portal/projects/:projectId/content-calendar`). §6.4 asks for "one content
 * calendar feature, one entry contract, one shared React implementation, and
 * one source of scheduling truth" — a second adapter with a second entry shape
 * is exactly how two calendars come back, so this file has one `CalendarEvent`
 * and one `CalendarReadResult` and all three scopes return them.
 *
 * ## Two things this contract is careful about
 *
 * **Truncation is data.** {@link CalendarPage.truncated} plus
 * {@link CalendarReadResult.totalInWindow} are always present, so a screen can
 * say "showing 200 of 431" instead of rendering a page as if it were the month.
 * §6.7 is explicit that a UI must not claim a month is empty because it loaded
 * only the latest 200 records.
 *
 * **State is not stored, it is derived.** `state` here is the server's reading
 * of the source facts at read time — an approval that lapsed or a destination
 * that was disconnected changes it without anyone editing the placement. A
 * screen must therefore never cache a state across a mutation of the piece, and
 * must re-read rather than patching `state` locally.
 *
 * @module services/content-calendar
 */

// ── Vocabularies, mirroring content-calendar.types.ts ────────────────────

export const CALENDAR_CONTENT_TYPES = [
  'article',
  'social-post',
  'email',
  'ad-creative',
  'landing-page',
  'other',
] as const;
export type CalendarContentType = (typeof CALENDAR_CONTENT_TYPES)[number];

export const CONTENT_TYPE_LABELS: Record<CalendarContentType, string> = {
  article: 'Article',
  'social-post': 'Social post',
  email: 'Email',
  'ad-creative': 'Ad creative',
  'landing-page': 'Landing page',
  other: 'Other content',
};

/** §6.6's nine states. Only `planned` and `cancelled` are ever stored. */
export const SCHEDULE_STATES = [
  'planned',
  'awaiting-approval',
  'ready',
  'scheduled',
  'held',
  'publishing',
  'published',
  'failed',
  'cancelled',
] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export const SCHEDULE_STATE_LABELS: Record<ScheduleState, string> = {
  planned: 'Planned',
  'awaiting-approval': 'Awaiting approval',
  ready: 'Ready to publish',
  scheduled: 'Scheduled',
  held: 'On hold',
  publishing: 'Publishing now',
  published: 'Published',
  failed: 'Publishing failed',
  cancelled: 'Cancelled',
};

export type DeliveryMode = 'automated' | 'manual';
export type VerificationState = 'not-applicable' | 'pending' | 'verified' | 'failed';
export type PastDueReason =
  | 'failure'
  | 'approval-hold'
  | 'disconnected-account'
  | 'manual-publishing'
  | 'unsupported-channel'
  | 'not-linked'
  | 'dispatch-pending';

/** §6.5's literal reading for a past-due item. Never "published". */
export const PAST_DUE_LABEL = 'Not published yet';

/**
 * The channels a placement may target, for the channel filter's options only.
 *
 * Every label a reader sees on an **event** comes from the server's
 * `channelLabel`, so a drift in this table cannot mislabel a placement — it can
 * only cost the filter an option. It mirrors `PLANNING_ONLY_CHANNELS` plus the
 * publishing providers in `content-calendar.types.ts`.
 */
export const CALENDAR_CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'custom-webhook', label: 'Custom webhook (HTTPS endpoint)' },
  { value: 'wordpress', label: 'WordPress' },
  { value: 'webflow', label: 'Webflow' },
  { value: 'ghost', label: 'Ghost' },
  { value: 'contentful', label: 'Contentful' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'x', label: 'X' },
  { value: 'email', label: 'Email' },
  { value: 'paid-ads', label: 'Paid ads' },
  { value: 'organic-social', label: 'Organic social (manual)' },
];

/**
 * Channels with no provider behind them in this build.
 *
 * A placement on one of these is a plan and nothing more: it is delivered by a
 * person, the calendar offers no Send/Launch control for it, and a paid-ads
 * entry authorizes no budget change and no campaign launch.
 */
export const PLANNING_ONLY_CHANNELS: readonly string[] = ['email', 'paid-ads', 'organic-social'];

export function isPlanningOnlyChannel(channel: string): boolean {
  return PLANNING_ONLY_CHANNELS.includes(channel);
}

/** The three calendar layouts. Month is the desktop default; Agenda the mobile one. */
export const CALENDAR_VIEWS = ['month', 'week', 'agenda'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

// ── The one entry contract ──────────────────────────────────────────────

export interface CalendarEventExecution {
  publicationId: string;
  status: string;
  mode: string;
  scheduledFor: string | null;
  attempt: number;
  remoteUrl: string | null;
  /** Staff reads only. */
  error?: string | null;
}

export interface CalendarEventVerification {
  state: VerificationState;
  verifiedAt: string | null;
  verifiedUrl: string | null;
  /** Staff reads only. */
  error?: string | null;
}

/**
 * One placement, merged with the publication state it led to.
 *
 * `scheduleId` is the identity: a placement with three publication attempts is
 * still one event, and the attempts are children of it (`attemptCount`). The
 * absence of `publicationId` as a key is deliberate — keying a React list by it
 * would multiply one placement into one row per attempt (§6.6).
 */
export interface CalendarEvent {
  scheduleId: string;
  projectId: string;
  projectName: string;
  /** The content piece a click opens. */
  assetId: string;
  /** The piece's own title. Never a run id or an internal source type (§6.5). */
  title: string;
  contentType: CalendarContentType;
  contentTypeLabel: string;
  channel: string;
  channelLabel: string;
  deliveryMode: DeliveryMode;
  /** Staff reads only. */
  destinationLabel?: string | null;
  state: ScheduleState;
  stateLabel: string;
  holdReason: string | null;
  holdReasonLabel: string | null;
  pastDue: boolean;
  pastDueLabel: string | null;
  pastDueReason: PastDueReason | null;
  pastDueReasonLabel: string | null;
  scheduledForUtc: string;
  plannedLocalDate: string;
  plannedLocalTime: string;
  timezone: string;
  dstDisambiguation: 'earlier' | 'later' | null;
  execution: CalendarEventExecution | null;
  attemptCount: number;
  intentionAndExecutionDiffer: boolean;
  verification: CalendarEventVerification;
  /** A known safe published URL, or null. The only thing "View live" may use. */
  liveUrl: string | null;
  approvedRevision: number | null;
  latestRevision: number | null;
  commitmentId: string | null;
  briefId: string | null;
  /** Staff reads only. */
  ownerId?: string | null;
  /** The owner's display name, resolved by the server. Staff reads only. */
  ownerLabel?: string | null;
  cancelledAt: string | null;
  /** Staff reads only. */
  cancelReason?: string | null;
  /** The version to send back when moving or cancelling this placement. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** §6.5 — unscheduled content has its own list, never a fabricated date. */
export interface UnscheduledContentItem {
  assetId: string;
  /** The project it belongs to — needed to link it from the portfolio scope. */
  projectId: string;
  title: string;
  contentType: CalendarContentType;
  contentTypeLabel: string;
  state: 'unscheduled';
  reason: 'no-placement';
  reasonLabel: string;
  /** Staff reads only. */
  ownerId?: string | null;
  updatedAt: string;
}

export interface CalendarPage<T> {
  items: T[];
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** True when this page is not everything in the window. */
  truncated: boolean;
}

export interface CalendarWindow {
  from: string;
  to: string;
  timezone: string;
  days: number;
  bounded: true;
}

export interface CalendarScopeInfo {
  kind: 'project' | 'portfolio';
  projectId: string | null;
  projectIds: string[];
  label: string;
}

export interface CalendarReadResult {
  scope: CalendarScopeInfo;
  window: CalendarWindow;
  filters: {
    type: string | null;
    channel: string | null;
    state: string | null;
    ownerId: string | null;
  };
  /** The same array as `events`; the layout views read this. */
  layout: CalendarEvent[];
  events: CalendarEvent[];
  page: CalendarPage<CalendarEvent>;
  /** Every placement in the window under these filters, ignoring the page. */
  totalInWindow: number;
  /** False when a filter could only be applied in memory and the scan was capped. */
  totalIsExact: boolean;
  unscheduled: CalendarPage<UnscheduledContentItem> & { total: number; totalIsExact: boolean };
  generatedAt: string;
}

// ── Queries ─────────────────────────────────────────────────────────────

/** The filters every calendar read accepts. Values go on the wire as-is. */
export interface CalendarQuery {
  /** Window start: `YYYY-MM-DD` (local midnight) or a full ISO instant. */
  from?: string;
  /** Window end, inclusive. A bare date means the last instant of that day. */
  to?: string;
  timezone?: string;
  type?: string;
  channel?: string;
  state?: string;
  ownerId?: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
  unscheduledLimit?: number;
  unscheduledCursor?: string;
  /** Lets the object be spread straight into `api.get`'s query record. */
  [key: string]: string | number | undefined;
}

/**
 * A page as the write endpoints return it — the same entry contract.
 *
 * The write routes return a single `CalendarEvent`, not a page; this alias
 * exists so a caller reading `event.state` after a move does not need to know
 * which endpoint produced it.
 */
export type CalendarEventResponse = CalendarEvent;

// ── Reads ───────────────────────────────────────────────────────────────

/**
 * The project calendar.
 *
 * The window is **server-side** (§6.7): `from`/`to` are sent, not applied to a
 * loaded page, so a month view's contents never depend on how many rows a
 * browser happened to fetch.
 */
export async function readProjectCalendar(
  projectId: string,
  query: CalendarQuery = {},
  options?: { signal?: AbortSignal },
): Promise<CalendarReadResult> {
  return api.get<CalendarReadResult>(`/projects/${projectId}/content-calendar`, {
    ...options,
    query,
  });
}

/**
 * The portfolio calendar across every project the caller may see.
 *
 * There is no `clientId` parameter: the permitted project set is resolved from
 * the caller's own access rules on the server, so this cannot be widened from
 * the browser.
 */
export async function readPortfolioCalendar(
  query: CalendarQuery = {},
  options?: { signal?: AbortSignal },
): Promise<CalendarReadResult> {
  return api.get<CalendarReadResult>('/content-calendar', { ...options, query });
}

/**
 * The client's own calendar.
 *
 * Filtered by construction: a piece appears only once an operator has shared a
 * revision of it, and the server applies that to the query rather than to the
 * rendered rows, so `totalInWindow` and `unscheduled.total` cannot count an
 * unshared draft either. There are no write functions for this scope on
 * purpose — a client reads their calendar; moving a placement is an operator
 * action.
 */
export async function readClientCalendar(
  projectId: string,
  query: CalendarQuery = {},
  options?: { signal?: AbortSignal },
): Promise<CalendarReadResult> {
  return api.get<CalendarReadResult>(`/portal/projects/${projectId}/content-calendar`, {
    ...options,
    query,
  });
}

// ── Writes (staff only) ─────────────────────────────────────────────────

/**
 * Plan a placement — a date content is *intended* for.
 *
 * No revision or approval is involved, which is §6.6's whole point: the planned
 * date is visible before approval, and `awaiting-approval` is a state the
 * calendar shows rather than an error it hides.
 */
export interface CreatePlacementInput {
  assetId: string;
  channel: string;
  /** `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm` (read in `timezone`), or a full ISO instant. */
  scheduledFor: string;
  contentType?: CalendarContentType;
  briefId?: string;
  commitmentId?: string;
  deliveryMode?: DeliveryMode;
  /** Required for an automated placement; refused if it is not connected. */
  destinationId?: string;
  timezone?: string;
  /** Required only when the local time is repeated by a fall-back transition. */
  dstDisambiguation?: 'earlier' | 'later';
  ownerId?: string;
  idempotencyKey?: string;
}

export async function createPlacement(
  projectId: string,
  input: CreatePlacementInput,
): Promise<CalendarEvent> {
  return api.post<CalendarEvent>(`/projects/${projectId}/content-schedules`, input);
}

/**
 * Move or edit a placement.
 *
 * `version` is required and is the version that was read — the server refuses a
 * stale one rather than overwriting another operator's change, so a form must
 * send back exactly what it loaded. Moving a placement never moves a queued
 * publication (§6.7).
 */
export interface UpdatePlacementInput {
  version: number;
  scheduledFor?: string;
  timezone?: string;
  dstDisambiguation?: 'earlier' | 'later';
  channel?: string;
  deliveryMode?: DeliveryMode;
  /** `null` clears the destination; omitting it leaves it unchanged. */
  destinationId?: string | null;
  contentType?: CalendarContentType;
  ownerId?: string | null;
  commitmentId?: string | null;
}

export async function updatePlacement(
  projectId: string,
  scheduleId: string,
  input: UpdatePlacementInput,
): Promise<CalendarEvent> {
  return api.patch<CalendarEvent>(`/projects/${projectId}/content-schedules/${scheduleId}`, input);
}

/**
 * Cancel a placement. A state change, never a delete.
 *
 * The reason is required because §6.7's "cancellation preserves history" means
 * the history has to be worth keeping — a bare `cancelled` flag with no reason
 * tells a reader in three months nothing.
 */
export async function cancelPlacement(
  projectId: string,
  scheduleId: string,
  reason: string,
  version: number,
): Promise<CalendarEvent> {
  return api.post<CalendarEvent>(
    `/projects/${projectId}/content-schedules/${scheduleId}/cancel`,
    { reason, version },
  );
}

/**
 * Link the placement to an approved revision, through publishing's gates.
 *
 * This is the only way the calendar creates a publication. The server re-runs
 * every gate (exact-revision approval, destination connected, permissions
 * granted, provider implemented) and refuses with publishing's own error, so a
 * refusal here reads the same as one on the content detail screen.
 */
export interface LinkPublicationInput {
  revisionId?: string;
  mode?: 'draft' | 'publish';
  permissions?: string[];
  contentHash?: string;
  /** Dispatch now instead of at the placement time (also what an overdue placement does). */
  publishNow?: boolean;
}

export async function linkPlacementPublication(
  projectId: string,
  scheduleId: string,
  input: LinkPublicationInput = {},
): Promise<CalendarEvent> {
  return api.post<CalendarEvent>(
    `/projects/${projectId}/content-schedules/${scheduleId}/publication`,
    input,
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * The one URL a screen may send a reader to for a content piece.
 *
 * Always the content detail, never a calendar-specific editor: §6.5 requires a
 * click to open the piece "in its content detail at the selected placement,
 * not a calendar-specific editor modal", so there is exactly one function that
 * builds this and no second calendar route that could drift from it.
 */
export function contentDetailHref(projectId: string, assetId: string, scheduleId?: string): string {
  const base = `/projects/${projectId}/content/${assetId}`;
  // The placement is a query parameter so the detail screen can highlight the
  // date the reader came from without the calendar owning a second editor.
  return scheduleId ? `${base}?scheduleId=${encodeURIComponent(scheduleId)}` : base;
}

/** The client's own content detail, for the portal calendar. */
export function clientContentHref(projectId: string, assetId: string): string {
  return `/client/projects/${projectId}/content/${assetId}`;
}

/**
 * Format an event's planned instant for display.
 *
 * Formats the **server's** intended local date and time rather than
 * re-deriving one from the UTC instant in the viewer's browser: the placement
 * was made in the project's timezone, and a reviewer in another zone must see
 * the time the content is actually planned for, not their own clock's version
 * of it (§6.7 stores both precisely so this cannot drift).
 */
export function formatPlannedTime(event: CalendarEvent): string {
  return event.plannedLocalTime.slice(0, 5);
}

/** The local date an event belongs on, `YYYY-MM-DD`, in its own timezone. */
export function plannedLocalDate(event: CalendarEvent): string {
  return event.plannedLocalDate;
}

/**
 * Days in the month a `YYYY-MM` names, for the month grid.
 *
 * Built from the calendar's own date strings rather than from `new Date()`
 * arithmetic, so a month grid cannot disagree with the dates the server sent.
 */
export function monthDays(monthKey: string): string[] {
  const [year, month] = monthKey.split('-').map(Number);
  const days: string[] = [];
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= count; day += 1) {
    days.push(`${monthKey}-${String(day).padStart(2, '0')}`);
  }
  return days;
}

/** Shifts a `YYYY-MM` key by whole months. */
export function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First and last `YYYY-MM-DD` of a month key — the window to send the server. */
export function monthWindow(monthKey: string): { from: string; to: string } {
  const days = monthDays(monthKey);
  return { from: days[0], to: days[days.length - 1] };
}

/** The `YYYY-MM-DD` week containing the Monday of `monthKey`'s first week. */
export function weekWindow(anchorDate: string): { from: string; to: string } {
  const anchor = new Date(`${anchorDate}T00:00:00Z`);
  // Monday-first: JS getUTCDay() is 0=Sunday, so Sunday moves back six days.
  const weekday = anchor.getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  const from = new Date(anchor);
  from.setUTCDate(from.getUTCDate() - back);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 6);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}
