/**
 * Vocabularies and view shapes for P10 — the one content calendar
 * (platform_improvement_plan.md §6.4-§6.7).
 *
 * Three ideas drive every decision in this file:
 *
 * 1. **One entry contract.** There is exactly one kind of calendar entry —
 *    a *placement* (`ContentSchedule`) merged with the publication state it
 *    led to. §6.4's "one content calendar feature, one entry contract, one
 *    shared React implementation, and one source of scheduling truth" is not
 *    satisfiable while a screen can render a report release or a work-item due
 *    date as if it were content. The vocabularies below are deliberately
 *    narrow: what is not in them cannot be rendered here.
 *
 * 2. **Intention is not execution.** A placement exists before any revision is
 *    approved; a publication exists only after. §6.6's list of nine schedule
 *    states spans both halves, so the state a reader sees is *derived* on
 *    every read from the source facts (revisions, approvals, publications) and
 *    never stored. A stored copy could disagree with the thing it describes —
 *    which is exactly how a calendar starts claiming something was published
 *    when it was not.
 *
 * 3. **Nothing is inferred from the clock.** A past date is not evidence that
 *    anything happened (§6.5). {@link PAST_DUE_LABEL} and
 *    {@link PastDueReason} exist so a screen can say "Not published yet" and
 *    *why*, rather than letting a reader conclude the absence of an error
 *    means success.
 *
 * @module content-calendar.types
 */

import { PROVIDER_DECLARATIONS, type ProviderKind } from '../publishing/publishing.types';

// ── Content types (§6.4 "Include") ─────────────────────────────────────────

/**
 * The content types this calendar carries.
 *
 * §6.4 requires planned blog/article publication, social content publication,
 * email content send, and an ad creative launch — the last **only if a real
 * corresponding content record exists**, which is why a placement always
 * points at a `GrowthAsset` and `other` is the only open-ended member.
 *
 * `landing-page` is here because a `GrowthAsset` of that type is a content
 * piece in this product's own vocabulary; the excluded things (audit runs,
 * crawler checks, report releases, employee leave, generic work deadlines,
 * approvals without a publication plan, monitoring jobs) have no member
 * because they are not content at all.
 */
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

/**
 * Maps the asset's own `GrowthAsset.assetType` onto a calendar content type.
 *
 * Used **only** when a placement is created without an explicit
 * `contentType`, so the stored type is a snapshot of what was planned rather
 * than something re-derived on every read (the piece's own type can change
 * later, and a placement records what was planned). An unrecognized asset type
 * maps to `other` rather than throwing: the caller still had to name a real
 * asset, so the entry is content either way.
 */
export function contentTypeForAssetType(assetType: string): CalendarContentType {
  switch (assetType) {
    case 'article':
      return 'article';
    case 'social-content':
      return 'social-post';
    case 'email-campaign':
      return 'email';
    case 'ad-copy':
      return 'ad-creative';
    case 'landing-page':
      return 'landing-page';
    default:
      return 'other';
  }
}

// ── Channels (§6.5's "channel" filter, §6.6's unsupported-channel rule) ────

/**
 * A planning-only channel: a place content can be *planned* for, with no
 * adapter in this build. §6.6 — "For unsupported email/ads/CMS channels, allow
 * only supported planning/manual delivery modes, clearly labelled. Do not show
 * an automated Send/Launch action."
 */
export interface PlanningOnlyChannel {
  channel: string;
  label: string;
  kind: ProviderKind;
  /** Why it is planning-only — shown next to the channel, never hidden. */
  reason: string;
}

export const PLANNING_ONLY_CHANNELS: readonly PlanningOnlyChannel[] = [
  {
    channel: 'email',
    label: 'Email',
    kind: 'email',
    reason: 'No email provider is connected in this build, so a send is planned and delivered by a person.',
  },
  {
    channel: 'paid-ads',
    label: 'Paid ads',
    kind: 'ads',
    reason:
      'A creative on this calendar does not authorize a budget change or a campaign launch — those stay with the ads platform and the account owner.',
  },
  {
    channel: 'organic-social',
    label: 'Organic social (manual)',
    kind: 'social',
    reason: 'No social account is connected in this build, so the post is planned and posted by a person.',
  },
] as const;

/** Every channel a placement may name: real providers first, then planning-only. */
export const CALENDAR_CHANNELS: readonly string[] = [
  ...PROVIDER_DECLARATIONS.map((declaration) => declaration.provider),
  ...PLANNING_ONLY_CHANNELS.map((channel) => channel.channel),
];

export function findPlanningOnlyChannel(channel: string): PlanningOnlyChannel | null {
  return PLANNING_ONLY_CHANNELS.find((candidate) => candidate.channel === channel) ?? null;
}

/**
 * Human label for a channel. Uses the publishing provider's own label where one
 * exists (so "Custom webhook (HTTPS endpoint)" is not retyped here) and the
 * planning-only label otherwise. Never returns an id — §6.5 forbids internal
 * source types in an event's reader-facing text.
 */
export function channelLabel(channel: string): string {
  const declaration = PROVIDER_DECLARATIONS.find((candidate) => candidate.provider === channel);
  if (declaration) return declaration.label;
  return findPlanningOnlyChannel(channel)?.label ?? 'Other channel';
}

/**
 * The delivery modes a placement may carry.
 *
 * `automated` is the claim that the system will push this at the planned time.
 * It is only ever stored for a channel that has a real, implemented provider
 * **and** a connected destination — {@link ContentCalendarService} enforces
 * that on write, so the label cannot be aspirational.
 */
export const DELIVERY_MODES = ['automated', 'manual'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

// ── Schedule state (§6.6) ─────────────────────────────────────────────────

/**
 * §6.6's schedule state vocabulary, in full.
 *
 * Only `planned` and `cancelled` are ever stored. The rest are derived:
 * `planned` (nothing written yet) → `awaiting-approval` (a revision exists but
 * none is approved) → `ready` (approved, not yet linked to a publication) →
 * `scheduled` (a publication holds the slot) → `publishing` → `published` /
 * `failed`, with `held` as the derived "something is blocking right now" state
 * at any point.
 */
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

/** Filter values that mean "any placement, whatever its derived state". */
export const STATE_FILTER_ANY = 'any';

// ── Hold reasons ──────────────────────────────────────────────────────────

/**
 * Why a placement is `held`, or why a published one is not confirmed.
 *
 * Derived from the same source facts the dispatcher re-checks at dispatch time
 * (§6.7: "recheck approval, destination, project pause, and permissions"),
 * which is what stops the calendar promising a push the dispatcher will
 * refuse.
 */
export const HOLD_REASONS = [
  'no-destination',
  'destination-not-connected',
  'destination-revoked',
  'destination-error',
  'approval-invalidated',
  // §21.2 journey 12: the content was edited after the revision being
  // published was approved. Distinct from `approval-invalidated` — the
  // approval was not withdrawn and remains a true record of consent for the
  // revision it named; the content simply moved on, so that consent no longer
  // covers what would be sent.
  'content-changed-since-approval',
  'client-paused',
  'dispatch-interrupted',
  'provider-not-implemented',
  'manual-delivery',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  'no-destination': 'No destination is connected for this channel yet.',
  'destination-not-connected': 'The destination is not connected yet.',
  'destination-revoked': 'The destination was revoked.',
  'destination-error': 'The destination reported an error on its last check.',
  'approval-invalidated': 'The approval that authorized this was withdrawn or superseded.',
  'content-changed-since-approval':
    'This content was edited after it was approved, so it is waiting for the latest version to be approved.',
  'client-paused': 'The client account is paused, so agreed future publications are held.',
  'dispatch-interrupted': 'A dispatch was interrupted — check the destination before retrying.',
  'provider-not-implemented': 'This channel has no adapter in this build.',
  'manual-delivery': 'This channel is delivered by a person, so nothing will send automatically.',
};

// ── Delivery vs verification (§6.6 "Published; live check pending") ───────

/**
 * Verification state, deliberately separate from the publication status.
 *
 * §6.6 requires "Published; live check pending" to be expressible, so a
 * placement whose push succeeded while the follow-up fetch has not yet
 * confirmed it reads exactly that rather than being collapsed into
 * "published" or into an error.
 */
export const VERIFICATION_STATES = ['not-applicable', 'pending', 'verified', 'failed'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

// ── Past-due readings (§6.5) ──────────────────────────────────────────────

/**
 * §6.5's single sentence for a past-due planned item. The calendar never
 * writes "published" because the date passed, so this is what it writes
 * instead.
 */
export const PAST_DUE_LABEL = 'Not published yet';

/**
 * The distinctions §6.5 requires a past-due item to make. Each is a fact about
 * the source records, not an inference from the clock.
 */
export const PAST_DUE_REASONS = [
  'failure',
  'approval-hold',
  'disconnected-account',
  'manual-publishing',
  'unsupported-channel',
  'not-linked',
  'dispatch-pending',
] as const;
export type PastDueReason = (typeof PAST_DUE_REASONS)[number];

export const PAST_DUE_REASON_LABELS: Record<PastDueReason, string> = {
  failure: 'The last publishing attempt failed. It must be retried deliberately.',
  'approval-hold': 'It is waiting for an approval on the exact revision to publish.',
  'disconnected-account': 'The destination is not connected, so nothing could be sent.',
  'manual-publishing': 'This channel is delivered by a person, so nothing sends automatically.',
  'unsupported-channel': 'This channel has no adapter in this build.',
  'not-linked': 'No publication was ever linked to this placement.',
  'dispatch-pending': 'It is due and the dispatcher has not run for it yet.',
};

// ── Scope ─────────────────────────────────────────────────────────────────

export const CALENDAR_SCOPES = ['project', 'portfolio'] as const;
export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

/** §6.7's bounded window. A read may not be asked for an unbounded one. */
export const MAX_WINDOW_DAYS = 366;

/** Default page size for a calendar read (events per page). */
export const DEFAULT_EVENT_LIMIT = 200;
/** Hard cap on a page. The >200-entry exit gate relies on truncation being explicit, not on raising this. */
export const MAX_EVENT_LIMIT = 500;
/** Unscheduled items are a separate, smaller list — §6.5's "separate list". */
export const DEFAULT_UNSCHEDULED_LIMIT = 50;
export const MAX_UNSCHEDULED_LIMIT = 200;

/**
 * How many placements one read will scan when a filter cannot be pushed into
 * the database (the derived `state` filter). Past this the read still answers,
 * but says the scan was capped instead of presenting a partial count as exact.
 */
export const MAX_WINDOW_SCAN = 5000;

// ── Read envelopes (§6.7) ─────────────────────────────────────────────────

/** The execution half of an event: the newest publication attempt. */
export interface CalendarEventExecution {
  publicationId: string;
  status: string;
  mode: string;
  /** The publication's own time. Null when it dispatches immediately. */
  scheduledFor: string | null;
  attempt: number;
  /**
   * The raw URL the publishing provider returned — **staff reads only**
   * (§4.6: clients get the sanitized `liveUrl`, which is the same value only
   * after it has been checked as a safe public link). Optional rather than
   * nullable so the client projection genuinely does not carry the field, and
   * so a reader of this type can see it is not always present.
   */
  remoteUrl?: string | null;
  /** Raw provider error — staff reads only (§3.4 keeps raw errors out of client copy). */
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
 * The one calendar entry contract (§6.4). Every scope builds this same shape —
 * project, portfolio and client — so there is exactly one thing a React
 * component has to render.
 *
 * `scheduleId` is the identity: a placement with three publication attempts is
 * still one event, because the attempts are children of it.
 */
export interface CalendarEvent {
  /** The placement id. The event identity, and the key a cursor pages on. */
  scheduleId: string;
  projectId: string;
  projectName: string;
  /** The content piece — what a click opens. */
  assetId: string;
  /** The piece's own title — never a run id, source type or slug (§6.5). */
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
  holdReason: HoldReason | null;
  holdReasonLabel: string | null;
  /** True when the planned instant is in the past and it is not published. */
  pastDue: boolean;
  /** §6.5's literal reading for a past-due item. Null when not past due. */
  pastDueLabel: string | null;
  pastDueReason: PastDueReason | null;
  pastDueReasonLabel: string | null;
  /** The one scheduling truth every scope reads. */
  scheduledForUtc: string;
  plannedLocalDate: string;
  plannedLocalTime: string;
  timezone: string;
  dstDisambiguation: 'earlier' | 'later' | null;
  /** Null until a publication is linked. */
  execution: CalendarEventExecution | null;
  /** Publications attached to this placement. Never multiplies the event. */
  attemptCount: number;
  /** True when a queued publication is set for a different time than the placement. */
  intentionAndExecutionDiffer: boolean;
  verification: CalendarEventVerification;
  /** §6.5 — a known safe published URL, or null. */
  liveUrl: string | null;
  approvedRevision: number | null;
  latestRevision: number | null;
  commitmentId: string | null;
  briefId: string | null;
  /** Staff reads only. */
  ownerId?: string | null;
  /**
   * The owner's display name. Staff reads only.
   *
   * Resolved here rather than in the browser because the only staff directory
   * (`GET /users`) is admin-only: without this, a delivery lead's owner filter
   * could offer nothing but raw user ids, and §6.5's owner filter would be
   * unusable for exactly the people who schedule content.
   */
  ownerLabel?: string | null;
  cancelledAt: string | null;
  /** Staff reads only — operator prose may carry internal detail. */
  cancelReason?: string | null;
  /** The placement's optimistic-concurrency version. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** §6.5 — unscheduled content lives in its own list, never at midnight. */
export interface UnscheduledContentItem {
  assetId: string;
  /**
   * The project the piece belongs to.
   *
   * Present because the portfolio scope lists pieces from several projects at
   * once: without it an unscheduled entry on the portfolio calendar is a title
   * with nowhere to click, which is a dead end rather than a to-do.
   */
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

/** Cursor page metadata, returned explicitly rather than implied. */
export interface CalendarPage<T> {
  items: T[];
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  /**
   * True when this page does not contain everything in the window. §6.7: a UI
   * must be able to tell "the month is empty" from "I only loaded 200 rows".
   */
  truncated: boolean;
}

export interface CalendarWindow {
  from: string;
  to: string;
  timezone: string;
  days: number;
  /** Always true — a read without a window is refused, not defaulted to "all time". */
  bounded: true;
}

export interface CalendarScopeInfo {
  kind: CalendarScope;
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
  layout: CalendarEvent[];
  /** Same array as `layout`; kept for callers that read `events`. */
  events: CalendarEvent[];
  page: CalendarPage<CalendarEvent>;
  /**
   * Every placement in the window under the same filters, ignoring the page.
   * Compare with `page.returned` to know whether the window is complete.
   */
  totalInWindow: number;
  /**
   * False when a filter could only be evaluated in memory and the scan cap was
   * reached — then `totalInWindow` is a lower bound and the UI must say so.
   */
  totalIsExact: boolean;
  unscheduled: CalendarPage<UnscheduledContentItem> & { total: number; totalIsExact: boolean };
  generatedAt: string;
}
