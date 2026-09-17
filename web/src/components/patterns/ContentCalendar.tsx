'use client';

/**
 * ContentCalendar — P10's one shared calendar implementation
 * (platform_improvement_plan.md §6.4-§6.6).
 *
 * ## Why this is one component and not three
 *
 * §6.4 requires "one content calendar feature, one entry contract, one shared
 * React implementation, and one source of scheduling truth". The three calendar
 * screens this replaces each grew their own grid, their own idea of what dates
 * belong on it, and their own click behaviour — which is how the same content
 * ended up on two calendars with two different dates. There is now one
 * component; the project, portfolio and client calendars differ only in the
 * scope string they pass and the href they build.
 *
 * It renders whatever the server sent and derives nothing about scheduling.
 * Every state, every "not published yet" reading and every count comes from the
 * API (§6.6's derived state); the component's only job is to show it without
 * overstating it.
 *
 * ## The three rules this file exists to keep
 *
 * 1. **Never infer publication from the clock.** A date in the past is not
 *    evidence that anything was sent. A past-due placement reads
 *    {@link PAST_DUE_LABEL} plus the server's reason, and "Published" is only
 *    ever rendered when the server said `state: 'published'`.
 * 2. **Never claim a month is complete when it is not.** The completeness
 *    footer always states how many events the window holds and how many are
 *    loaded, and offers the next page. It never silently shows a page.
 * 3. **Never offer an automated action on a channel that cannot deliver.**
 *    A manual placement gets no Send/Launch control at all — only "Mark as
 *    published" guidance on the content detail. §6.6 also means an ad creative
 *    placement grants nothing here: no budget field, no campaign launch.
 *
 * @module components/patterns/ContentCalendar
 */

import * as React from 'react';
import Link from 'next/link';
import {
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  List,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import type { ApiError } from '@/lib/api';
import {
  CALENDAR_VIEWS,
  PAST_DUE_LABEL,
  type CalendarEvent,
  type CalendarReadResult,
  type CalendarView,
  type ScheduleState,
  type UnscheduledContentItem,
} from '@/services/content-calendar';

/** The layout the reader gets when they have not chosen one. */
const DESKTOP_DEFAULT_VIEW: CalendarView = 'month';
const MOBILE_DEFAULT_VIEW: CalendarView = 'agenda';

const VIEW_LABELS: Record<CalendarView, string> = {
  month: 'Month',
  week: 'Week',
  agenda: 'Agenda',
};

const VIEW_ICONS: Record<CalendarView, typeof CalendarDays> = {
  month: CalendarDays,
  week: CalendarRange,
  agenda: List,
};

/** Colour is never the only signal — every pill carries its own words too. */
const STATE_TONES: Record<ScheduleState, StatusTone> = {
  planned: 'neutral',
  'awaiting-approval': 'unmeasured',
  ready: 'info',
  scheduled: 'info',
  held: 'warning',
  publishing: 'info',
  published: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface ContentCalendarProps {
  /** Which calendar this is. Copy and available actions differ by scope. */
  scope: 'project' | 'portfolio' | 'client';
  result: CalendarReadResult | null;
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  /** Loads the next page of the same window (`result.page.nextCursor`). */
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Chosen layout, and the setter. `undefined` means "not chosen yet". */
  view: CalendarView | undefined;
  onViewChange: (view: CalendarView) => void;
  /** Moves the window by whole months (month view) or weeks (week view). */
  onStepWindow: (delta: number) => void;
  onToday: () => void;
  /** The window label the page computed, e.g. "September 2026". */
  windowLabel: string;
  /** Filter controls, rendered above the grid. */
  filters?: React.ReactNode;
  /** Removes the active type/channel/state/owner filters. */
  onClearFilters?: () => void;
  /**
   * The content detail URL for an event, or nothing when this scope has no
   * detail screen to open.
   *
   * Optional rather than always a string because the client scope has no
   * content detail in this build: a title that links to "not available in this
   * build" is worse than a title that is plainly not a link. Never a
   * calendar-local editor either way (§6.5).
   */
  hrefFor?: (event: CalendarEvent) => string | undefined;
  /** The URL for an unscheduled item, so its title is actionable too. */
  hrefForUnscheduled?: (item: UnscheduledContentItem) => string | undefined;
  /** Staff scopes can move, cancel and link; the client scope passes none. */
  actions?: {
    onReschedule: (event: CalendarEvent) => void;
    onCancel: (event: CalendarEvent) => void;
    onLinkPublication: (event: CalendarEvent) => void;
  };
  /** Staff-only fields (destination, owner) are shown only when asked for. */
  showStaffFields?: boolean;
  className?: string;
}

export function ContentCalendar(props: ContentCalendarProps) {
  const {
    scope,
    result,
    loading,
    error,
    onRetry,
    onLoadMore,
    loadingMore,
    view,
    onViewChange,
    onStepWindow,
    onToday,
    windowLabel,
    filters,
    onClearFilters,
    hrefFor,
    hrefForUnscheduled,
    actions,
    showStaffFields = false,
    className,
  } = props;

  const isDesktop = useIsDesktop();
  const effectiveView: CalendarView =
    view ?? (isDesktop === null ? MOBILE_DEFAULT_VIEW : isDesktop ? DESKTOP_DEFAULT_VIEW : MOBILE_DEFAULT_VIEW);

  const events = React.useMemo(() => result?.events ?? [], [result]);

  // Grouped by the server's intended local date, never by a browser-local
  // re-derivation of the UTC instant — a reviewer in another timezone must see
  // the day the content is planned for, not their own clock's version of it.
  const byDate = React.useMemo(() => groupByLocalDate(events), [events]);

  // One indirection so a scope without a content detail screen passes nothing
  // and gets a plain title, rather than a link to nowhere.
  const link = (event: CalendarEvent) => hrefFor?.(event);

  if (error) {
    return (
      <div className={className}>
        <ErrorState
          error={toApiError(error)}
          onRetry={onRetry}
          restrictedAction="read this content calendar"
          notFoundReason="missing-or-private"
        />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => onStepWindow(-1)}
            aria-label={`Previous ${effectiveView}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={onToday}>
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => onStepWindow(1)}
            aria-label={`Next ${effectiveView}`}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h2 className="ml-1 text-lg font-semibold tracking-tight">{windowLabel}</h2>
        </div>

        {/* Month/Week/Agenda. §6.5: month is the desktop default, agenda the
            mobile one — which is why an unchosen view resolves per viewport
            rather than being pinned to one of them.

            §4.5: this is a set of view toggles, not an ARIA tab set. There is
            no `tabpanel` element behind it and no roving tabindex with arrow
            keys, so `role="tab"`/`aria-selected` would promise a keyboard
            model the control does not implement. Each button reports its own
            pressed state instead, and ordinary tab order reaches all three. */}
        <div role="group" aria-label="Calendar layout" className="flex items-center gap-1">
          {CALENDAR_VIEWS.map((candidate) => {
            const Icon = VIEW_ICONS[candidate];
            const selected = candidate === effectiveView;
            return (
              <Button
                key={candidate}
                aria-pressed={selected}
                variant={selected ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onViewChange(candidate)}
              >
                <Icon className="mr-1.5 h-4 w-4" />
                {VIEW_LABELS[candidate]}
              </Button>
            );
          })}
        </div>
      </div>

      {filters}

      <WindowFacts result={result} view={effectiveView} />

      {loading && !result ? (
        <Card className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading this window…
        </Card>
      ) : events.length === 0 ? (
        <EmptyWindow scope={scope} result={result} onClearFilters={onClearFilters} />
      ) : effectiveView === 'agenda' ? (
        <AgendaView
          byDate={byDate}
          hrefFor={link}
          actions={actions}
          showStaffFields={showStaffFields}
        />
      ) : effectiveView === 'week' ? (
        <WeekView
          byDate={byDate}
          windowFrom={result?.window.from ?? ''}
          timezone={result?.window.timezone ?? 'UTC'}
          hrefFor={link}
          actions={actions}
          showStaffFields={showStaffFields}
        />
      ) : (
        <MonthView
          byDate={byDate}
          from={result?.window.from ?? ''}
          to={result?.window.to ?? ''}
          timezone={result?.window.timezone ?? 'UTC'}
          hrefFor={link}
          actions={actions}
          showStaffFields={showStaffFields}
        />
      )}

      <CompletenessFooter
        result={result}
        onLoadMore={onLoadMore}
        loadingMore={loadingMore}
      />

      <UnscheduledSection
        result={result}
        scope={scope}
        hrefFor={hrefForUnscheduled}
        showStaffFields={showStaffFields}
      />
    </div>
  );
}

// ── Completeness ─────────────────────────────────────────────────────────

/**
 * What this window actually contains.
 *
 * §6.7's rule that "a UI cannot claim a month is empty because it loaded only
 * the latest 200 records" is satisfied here rather than left to each view: the
 * fact is stated once, above the grid, in the reader's own terms.
 */
function WindowFacts({ result, view }: { result: CalendarReadResult | null; view: CalendarView }) {
  if (!result) return null;
  const { totalInWindow, totalIsExact, window: windowRange } = result;
  return (
    <p className="text-xs text-muted-foreground">
      {totalIsExact ? (
        <>
          {totalInWindow === 1 ? '1 placement' : `${totalInWindow} placements`} in this {view} window
        </>
      ) : (
        <>
          At least {totalInWindow} placements in this window — the filter needed a wider scan than this
          read performed, so this count is a floor, not a total
        </>
      )}
      {' · '}
      times shown in {windowRange.timezone}
    </p>
  );
}

/**
 * The page/truncation footer.
 *
 * Three separate facts, kept separate on purpose: how many the window holds,
 * how many are loaded, and whether more can be loaded. Collapsing them into
 * "Showing 200" is exactly the sentence that lets a month look complete.
 */
function CompletenessFooter({
  result,
  onLoadMore,
  loadingMore,
}: {
  result: CalendarReadResult | null;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  if (!result) return null;
  const { page, totalInWindow, totalIsExact } = result;
  const complete = !page.truncated && totalIsExact && page.returned >= totalInWindow;

  if (complete) {
    return (
      <p className="text-xs text-muted-foreground">
        Showing every placement in this window ({page.returned}).
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
      <Info className="h-4 w-4 shrink-0 text-info-foreground" />
      <p className="text-xs text-muted-foreground">
        Showing {page.returned} of {totalIsExact ? totalInWindow : `at least ${totalInWindow}`} placements
        in this window. This list is truncated — an item not shown here is not evidence that it does not
        exist.
      </p>
      {onLoadMore && page.hasMore ? (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}

/**
 * An empty window — which is genuinely two different states, not one.
 *
 * When a filter is applied, `no-results` is exactly right and the reader gets
 * the control that undoes it. When **no** filter is applied, none of the eight
 * named variants fits: `no-results` would claim a filter the reader never set,
 * and `no-records` would say "an empty list here means none exists" about the
 * one thing that is certainly false — content exists, it is simply planned for
 * other dates, or for none at all. The panel below is therefore written here,
 * and it says the true thing: this window is empty, and the unscheduled list
 * beneath it is where undated content is.
 */
function EmptyWindow({
  result,
  onClearFilters,
}: {
  scope: string;
  result: CalendarReadResult | null;
  onClearFilters?: () => void;
}) {
  const filtered = Boolean(
    result && (result.filters.type || result.filters.channel || result.filters.state || result.filters.ownerId),
  );
  if (filtered) {
    return <EmptyState variant="no-results" onClearFilters={onClearFilters} />;
  }
  return (
    <Card className="flex flex-col gap-1 p-6">
      <h3 className="text-sm font-semibold">Nothing is planned in these dates</h3>
      <p className="max-w-prose text-table text-muted-foreground">
        No placement falls in this window. That is a statement about these dates, not about the content —
        anything with no planned date is listed under &ldquo;Not yet planned&rdquo; below rather than being
        placed on a day nobody chose. A day outside this window is not covered by this message at all.
      </p>
    </Card>
  );
}

// ── Views ────────────────────────────────────────────────────────────────

interface ViewProps {
  byDate: Map<string, CalendarEvent[]>;
  hrefFor: (event: CalendarEvent) => string | undefined;
  actions?: ContentCalendarProps['actions'];
  showStaffFields: boolean;
}

function AgendaView({ byDate, hrefFor, actions, showStaffFields }: ViewProps) {
  const dates = Array.from(byDate.keys()).sort();
  return (
    <div className="flex flex-col gap-4">
      {dates.map((date) => (
        <section key={date} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{formatDateHeading(date)}</h3>
          <div className="flex flex-col gap-2">
            {(byDate.get(date) ?? []).map((event) => (
              <EventCard
                key={event.scheduleId}
                event={event}
                href={hrefFor(event)}
                actions={actions}
                showStaffFields={showStaffFields}
              />
            ))}
          </div>
        </section>
      ))}
      {dates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No placements fall in this window.</p>
      ) : null}
    </div>
  );
}

function MonthView({
  byDate,
  from,
  to,
  timezone,
  hrefFor,
  actions,
  showStaffFields,
}: ViewProps & { from: string; to: string; timezone: string }) {
  const days = daysInRange(from, to);
  if (days.length === 0) return null;
  const pad = leadingBlanks(days[0]);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-surface-sunken">
        {DAY_NAMES.map((name) => (
          <div key={name} className="px-2 py-1.5 text-center text-xs font-medium text-muted-foreground">
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: pad }).map((_, index) => (
          <div key={`pad-${index}`} className="min-h-24 border-b border-r border-border bg-surface-sunken/40" />
        ))}
        {days.map((date) => {
          const events = byDate.get(date) ?? [];
          return (
            <div key={date} className="min-h-24 border-b border-r border-border p-1.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{Number(date.slice(8, 10))}</span>
                {events.length > 2 ? (
                  <span className="text-[10px] text-muted-foreground">{events.length}</span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                {events.slice(0, 3).map((event) => (
                  <EventChip
                    key={event.scheduleId}
                    event={event}
                    href={hrefFor(event)}
                    actions={actions}
                    showStaffFields={showStaffFields}
                  />
                ))}
                {events.length > 3 ? (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    +{events.length - 3} more — switch to Agenda to read them all
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
        Days are local dates in {timezone}. A day shown empty here has no planned placement — it does not
        mean nothing is due that day elsewhere in the business.
      </p>
    </div>
  );
}

function WeekView({
  byDate,
  windowFrom,
  timezone,
  hrefFor,
  actions,
  showStaffFields,
}: ViewProps & { windowFrom: string; timezone: string }) {
  const days = weekDates(windowFrom);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {days.map((date) => {
        const events = byDate.get(date) ?? [];
        return (
          <div key={date} className="flex min-h-40 flex-col gap-2 rounded-lg border border-border p-2">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {formatDateHeading(date)}
              {events.length ? <span className="ml-1 font-normal">({events.length})</span> : null}
            </h3>
            <div className="flex flex-col gap-2">
              {events.map((event) => (
                <EventChip
                  key={event.scheduleId}
                  event={event}
                  href={hrefFor(event)}
                  actions={actions}
                  showStaffFields={showStaffFields}
                />
              ))}
              {events.length === 0 ? (
                <p className="px-1 text-[11px] text-muted-foreground">Nothing planned</p>
              ) : null}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-4 xl:col-span-7">
        Days are local dates in {timezone}.
      </p>
    </div>
  );
}

// ── One event ────────────────────────────────────────────────────────────

function EventChip({
  event,
  href,
  actions,
  showStaffFields,
}: {
  event: CalendarEvent;
  href?: string;
  actions?: ContentCalendarProps['actions'];
  showStaffFields: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded border border-border/70 bg-surface px-1.5 py-1 text-[11px] leading-tight',
        event.state === 'cancelled' && 'opacity-60',
      )}
    >
      {/* A click opens the piece where it lives, at this placement — never a
          calendar-local editor (§6.5). A scope with no content detail screen
          gets a plain title instead of a link to a page that cannot show it. */}
      {href ? (
        <Link href={href} className="block font-medium hover:underline">
          {event.title}
        </Link>
      ) : (
        <span className="block font-medium">{event.title}</span>
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-muted-foreground">
        <span>{event.plannedLocalTime.slice(0, 5)}</span>
        <span>·</span>
        <span>{event.contentTypeLabel}</span>
        <span>·</span>
        <span>{event.channelLabel}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <StatusPill label={event.stateLabel} tone={STATE_TONES[event.state]} />
        {event.deliveryMode === 'manual' ? (
          <Badge variant="outline" className="text-[10px]">
            Delivered by a person
          </Badge>
        ) : null}
      </div>
      {event.pastDue ? (
        <p className="mt-1 text-[10px] font-medium text-warning-foreground">
          {PAST_DUE_LABEL}
          {event.pastDueReasonLabel ? ` — ${event.pastDueReasonLabel}` : ''}
        </p>
      ) : null}
      {showStaffFields && actions ? (
        <div className="mt-1 flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => actions.onReschedule(event)}>
            Move…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function EventCard({
  event,
  href,
  actions,
  showStaffFields,
}: {
  event: CalendarEvent;
  href?: string;
  actions?: ContentCalendarProps['actions'];
  showStaffFields: boolean;
}) {
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          {href ? (
            <Link href={href} className="text-sm font-medium hover:underline">
              {event.title}
            </Link>
          ) : (
            <span className="text-sm font-medium">{event.title}</span>
          )}
          <p className="text-xs text-muted-foreground">
            {event.plannedLocalTime.slice(0, 5)} · {event.contentTypeLabel} · {event.channelLabel}
            {showStaffFields && event.destinationLabel ? ` → ${event.destinationLabel}` : ''}
            {showStaffFields || event.projectName ? ` · ${event.projectName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <StatusPill label={event.stateLabel} tone={STATE_TONES[event.state]} />
          {event.deliveryMode === 'manual' ? (
            <Badge variant="outline">Delivered by a person</Badge>
          ) : null}
        </div>
      </div>

      {event.pastDue ? (
        <p className="rounded border border-warning-subtle bg-warning-subtle px-2 py-1 text-xs text-warning-foreground">
          <span className="font-medium">{PAST_DUE_LABEL}</span>
          {event.pastDueReasonLabel ? ` — ${event.pastDueReasonLabel}` : ''}
          {' '}The planned time has passed; that is not evidence that anything was sent.
        </p>
      ) : null}

      {event.holdReasonLabel && !event.pastDue ? (
        <p className="text-xs text-muted-foreground">{event.holdReasonLabel}</p>
      ) : null}

      {event.intentionAndExecutionDiffer ? (
        <p className="text-xs text-muted-foreground">
          The planned time and the queued publication time differ. Moving this placement never moved the
          published slot — check which one you mean before acting.
        </p>
      ) : null}

      {/* §6.6: delivery and verification are separate facts, so "published;
          live check pending" reads as exactly that. */}
      {event.state === 'published' && event.verification.state === 'pending' ? (
        <p className="text-xs text-muted-foreground">Published; live check pending.</p>
      ) : null}
      {event.verification.state === 'failed' ? (
        <p className="text-xs text-warning-foreground">
          Published, but the follow-up live check did not confirm it.
        </p>
      ) : null}
      {event.attemptCount > 1 ? (
        <p className="text-xs text-muted-foreground">
          {event.attemptCount} publication attempts against this placement — one calendar event, however many
          attempts.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {href ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href}>Open content</Link>
          </Button>
        ) : null}
        {/* §6.5: offered only for a known safe published URL. The server sends
            `liveUrl` only for a real publication, and only when the URL is
            http(s) with a host — never a scheme or a path this component would
            have to vet. */}
        {event.liveUrl ? (
          <Button asChild variant="ghost" size="sm">
            <a href={event.liveUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="mr-1.5 h-4 w-4" />
              View live content
            </a>
          </Button>
        ) : null}
        {showStaffFields && actions ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => actions.onReschedule(event)}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Move
            </Button>
            {/* No Send/Launch control appears for a manual placement: §6.6
                forbids offering an automated action on a channel that cannot
                perform one. Linking is offered only when the server marked the
                placement automated and a destination exists. */}
            {event.deliveryMode === 'automated' && !event.execution && event.state !== 'cancelled' ? (
              <Button variant="ghost" size="sm" onClick={() => actions.onLinkPublication(event)}>
                Publish to {event.destinationLabel ?? event.channelLabel}…
              </Button>
            ) : null}
            {event.state !== 'cancelled' ? (
              <Button variant="ghost" size="sm" onClick={() => actions.onCancel(event)}>
                <XCircle className="mr-1.5 h-4 w-4" />
                Cancel
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {event.state === 'cancelled' && showStaffFields && event.cancelReason ? (
        <p className="text-xs text-muted-foreground">Cancelled: {event.cancelReason}</p>
      ) : null}
    </Card>
  );
}

// ── Unscheduled ──────────────────────────────────────────────────────────

/**
 * §6.5's separate unscheduled list.
 *
 * It is a list, not a calendar lane and not a cell: content with no planned date
 * is put nowhere on the grid, because a date nobody chose is a fabricated fact.
 */
function UnscheduledSection({
  result,
  scope,
  hrefFor,
  showStaffFields,
}: {
  result: CalendarReadResult | null;
  scope: string;
  hrefFor?: (item: UnscheduledContentItem) => string | undefined;
  showStaffFields: boolean;
}) {
  if (!result || !result.unscheduled) return null;
  const { items, total, totalIsExact, truncated } = result.unscheduled;
  if (total === 0 && items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Not yet planned</h3>
        <p className="text-xs text-muted-foreground">
          {totalIsExact ? total : `at least ${total}`} content {total === 1 ? 'piece has' : 'pieces have'} no
          planned date. They are listed here rather than placed on a day, because no date has been chosen for
          them.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing unscheduled in this scope.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {items.map((item) => {
            const href = hrefFor?.(item);
            return (
              <li key={item.assetId} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
                <div className="flex flex-col gap-0.5">
                  {href ? (
                    <Link href={href} className="text-sm font-medium hover:underline">
                      {item.title}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{item.title}</span>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {item.contentTypeLabel} · {item.reasonLabel}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill label="Not planned" tone="neutral" />
                  {scope !== 'client' && showStaffFields && href ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={href}>Plan a date…</Link>
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          This list is truncated too — it shows what this read loaded, not everything on file.
        </p>
      ) : null}
    </section>
  );
}

// ── Reschedule form (a form, never drag-only) ────────────────────────────

export interface RescheduleFormProps {
  event: CalendarEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves the submitted local reading. Throws/returns an error to display. */
  onSubmit: (input: {
    scheduledFor: string;
    timezone: string;
    dstDisambiguation?: 'earlier' | 'later';
  }) => Promise<void>;
  /** The server's `time-nonexistent` / `time-ambiguous` detail, when it refused. */
  serverRefusal?: {
    error: string;
    message: string;
    nextValidLocal?: string | null;
    candidates?: { disambiguation: 'earlier' | 'later'; utc: string }[];
  } | null;
}

/**
 * The reschedule control.
 *
 * A form, not a drag gesture, and deliberately so: §6.5 asks for a form *with*
 * an impact explanation, which is the only way the two facts a drag cannot
 * carry get said — that moving a placement does not move an already-queued
 * publication, and that the date is read in a named timezone other than
 * whatever the browser thinks it is. It is also the keyboard-reachable
 * alternative, which a drag-only calendar never has.
 *
 * The date and time inputs seed from the placement's **intended local** reading
 * the server stored, not from a UTC slice of the instant: the two disagree
 * whenever the project's timezone is not UTC, and seeding from the instant is
 * how a "correct" reschedule silently moves a piece by a day.
 */
export function RescheduleDialog({
  event,
  open,
  onOpenChange,
  onSubmit,
  serverRefusal,
}: RescheduleFormProps) {
  const [date, setDate] = React.useState(event.plannedLocalDate);
  const [time, setTime] = React.useState(event.plannedLocalTime.slice(0, 5));
  const [timezone, setTimezone] = React.useState(event.timezone);
  const [disambiguation, setDisambiguation] = React.useState<'earlier' | 'later' | ''>(
    event.dstDisambiguation ?? '',
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDate(event.plannedLocalDate);
    setTime(event.plannedLocalTime.slice(0, 5));
    setTimezone(event.timezone);
    setDisambiguation(event.dstDisambiguation ?? '');
    setLocalError(null);
  }, [open, event]);

  const ambiguous = serverRefusal?.error === 'time-ambiguous';

  async function submit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setLocalError(null);
    if (ambiguous && disambiguation === '') {
      setLocalError('Choose which of the two times you mean.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        scheduledFor: `${date}T${time}:00`,
        timezone,
        dstDisambiguation: disambiguation === '' ? undefined : disambiguation,
      });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'That change could not be saved.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move this placement</DialogTitle>
          <DialogDescription>{event.title}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reschedule-date">Date</Label>
              <Input
                id="reschedule-date"
                type="date"
                value={date}
                onChange={(changeEvent) => setDate(changeEvent.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reschedule-time">Time</Label>
              <Input
                id="reschedule-time"
                type="time"
                value={time}
                onChange={(changeEvent) => setTime(changeEvent.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reschedule-timezone">Timezone this time is in</Label>
            <Input
              id="reschedule-timezone"
              value={timezone}
              onChange={(changeEvent) => setTimezone(changeEvent.target.value)}
              placeholder="Europe/London"
              required
            />
            <p className="text-xs text-muted-foreground">
              {date} at {time} is read in this zone — not in your browser&apos;s. The project&apos;s own
              zone is {event.timezone}, and keeping it is usually right.
            </p>
          </div>

          {/* DST: a repeated local time names two instants. Asking is the only
              honest option — picking one silently would store a time the person
              did not choose (§6.7). */}
          {ambiguous || event.dstDisambiguation ? (
            <fieldset className="flex flex-col gap-2 rounded border border-border p-3">
              <legend className="px-1 text-xs font-medium">Which of the two?</legend>
              <p className="text-xs text-muted-foreground">
                The clocks move back in {timezone}, so {date} {time} happens twice.
              </p>
              {(serverRefusal?.candidates ?? []).map((candidate) => (
                <label key={candidate.disambiguation} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="dst-disambiguation"
                    value={candidate.disambiguation}
                    checked={disambiguation === candidate.disambiguation}
                    onChange={() => setDisambiguation(candidate.disambiguation)}
                  />
                  {candidate.disambiguation === 'earlier' ? 'The earlier one' : 'The later one'}
                  <span className="text-xs text-muted-foreground">
                    ({new Date(candidate.utc).toISOString()})
                  </span>
                </label>
              ))}
              {!serverRefusal?.candidates?.length ? (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="dst-disambiguation"
                      value="earlier"
                      checked={disambiguation === 'earlier'}
                      onChange={() => setDisambiguation('earlier')}
                    />
                    The earlier one
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="dst-disambiguation"
                      value="later"
                      checked={disambiguation === 'later'}
                      onChange={() => setDisambiguation('later')}
                    />
                    The later one
                  </label>
                </>
              ) : null}
            </fieldset>
          ) : null}

          {/* The impact explanation §6.5 requires — what moves and what does not. */}
          <div className="rounded border border-border bg-surface-sunken p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">What this changes</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>The intended date and time for this piece on this calendar.</li>
              <li>
                Any future automated delivery <span className="font-medium">only if</span> you re-link it —
                a publication already queued keeps the time it was authorized for, and this form will not
                silently move it.
              </li>
              <li>
                Nothing else. The plan commitment this placement serves keeps its own target date, and the
                piece&apos;s approvals and revisions are untouched.
              </li>
            </ul>
            {event.execution ? (
              <p className="mt-2 font-medium text-warning-foreground">
                This placement already has a publication ({event.execution.status}). Moving the placement
                will leave that publication where it is.
              </p>
            ) : null}
          </div>

          {serverRefusal ? (
            <p className="rounded border border-danger-subtle bg-danger-subtle px-2 py-1.5 text-xs text-danger-foreground">
              {serverRefusal.message}
              {serverRefusal.nextValidLocal ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      const [nextDate, nextTime] = serverRefusal.nextValidLocal!.split(' ');
                      setDate(nextDate);
                      setTime(nextTime);
                    }}
                  >
                    Use {serverRefusal.nextValidLocal}
                  </button>
                </>
              ) : null}
            </p>
          ) : null}

          {localError ? <p className="text-xs text-danger-foreground">{localError}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep the current date
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Save the new date
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Cancellation asks for a reason, because the history is the point (§6.7). */
export function CancelPlacementDialog({
  event,
  open,
  onOpenChange,
  onSubmit,
}: {
  event: CalendarEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cancel this placement</DialogTitle>
          <DialogDescription>{event.title}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Cancelling records that this placement is no longer intended and keeps it in the history. It is
            not a delete, and it does not un-publish anything already live.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cancel-reason">Why is it no longer planned?</Label>
            <Input
              id="cancel-reason"
              value={reason}
              onChange={(changeEvent) => setReason(changeEvent.target.value)}
              placeholder="Superseded by the October campaign"
            />
          </div>
          {error ? <p className="text-xs text-danger-foreground">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it planned
          </Button>
          <Button
            variant="destructive"
            disabled={submitting || reason.trim().length < 3}
            onClick={async () => {
              setError(null);
              setSubmitting(true);
              try {
                await onSubmit(reason.trim());
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'That cancellation was refused.');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Cancel the placement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Link-publication form ────────────────────────────────────────────────

/**
 * Link this placement to an approved revision.
 *
 * No approval control lives here and none can: the server refuses unless an
 * approval covers the exact revision being published, and the destination must
 * be connected and authorized. A "send" button on a calendar that could bypass
 * that would be a publishing back door (§6.6).
 */
export function LinkPublicationDialog({
  event,
  open,
  onOpenChange,
  onSubmit,
  destinations,
}: {
  event: CalendarEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { mode: 'draft' | 'publish'; permissions: string[] }) => Promise<void>;
  destinations?: React.ReactNode;
}) {
  const [mode, setMode] = React.useState<'draft' | 'publish'>('publish');
  const [permission, setPermission] = React.useState('content:write');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish to {event.destinationLabel ?? event.channelLabel}</DialogTitle>
          <DialogDescription>{event.title}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="publish-mode">What kind of push?</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as 'draft' | 'publish')}>
              <SelectTrigger id="publish-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Create a draft at the destination</SelectItem>
                <SelectItem value="publish">Publish it live</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A draft push leaves a draft a person still has to publish; it will not read as published here.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="publish-permission">Authorization to use</Label>
            <Input
              id="publish-permission"
              value={permission}
              onChange={(changeEvent) => setPermission(changeEvent.target.value)}
            />
          </div>
          {destinations}
          <p className="rounded border border-border bg-surface-sunken p-2.5 text-xs text-muted-foreground">
            The placement is planned for {event.plannedLocalDate} {event.plannedLocalTime.slice(0, 5)} in{' '}
            {event.timezone}. If that time has already passed, this publishes now instead — the moment has
            gone and nothing can be sent &quot;at&quot; it.
          </p>
          {error ? <p className="text-xs text-danger-foreground">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            disabled={submitting || permission.trim().length === 0}
            onClick={async () => {
              setError(null);
              setSubmitting(true);
              try {
                await onSubmit({ mode, permissions: [permission.trim()] });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Publishing was refused.');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {mode === 'publish' ? 'Publish it' : 'Create the draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function groupByLocalDate(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.plannedLocalDate) ?? [];
    list.push(event);
    grouped.set(event.plannedLocalDate, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.plannedLocalTime.localeCompare(b.plannedLocalTime));
  }
  return grouped;
}

/** Every `YYYY-MM-DD` in an inclusive range, so a grid honours the window. */
function daysInRange(from: string, to: string): string[] {
  if (!from || !to) return [];
  const start = from.slice(0, 10);
  const end = to.slice(0, 10);
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  // A grid is for a month or a week; a year-long window is not a grid.
  while (cursor.getTime() <= last.getTime() && days.length < 42) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * A small preview of the same calendar, for an overview page (§6.4).
 *
 * *"The overview contains a small preview of that same calendar; it is not
 * another scheduler."* This reads the same endpoint, renders the same event
 * contract through the same {@link EventCard}, and offers **no** write action
 * and no filters — the two things that would make it a scheduler. Everything
 * that looks like a decision (move, cancel, link) lives on the calendar screen,
 * one click away through `href`.
 *
 * It also inherits §6.7's honesty rule: the footer states how many placements
 * the window holds whenever the preview shows fewer, so a four-item preview can
 * never be read as "this is all the content there is".
 */
export interface ContentCalendarPreviewProps {
  result: CalendarReadResult | null;
  loading: boolean;
  /** The full calendar for this scope. The preview never replaces it. */
  href: string;
  /** The content detail URL for an event — the same one the calendar builds. */
  hrefFor?: (event: CalendarEvent) => string | undefined;
  /** How many placements the preview shows. */
  limit?: number;
  className?: string;
}

export function ContentCalendarPreview({
  result,
  loading,
  href,
  hrefFor,
  limit = 4,
  className,
}: ContentCalendarPreviewProps) {
  if (loading && !result) {
    return (
      <p className={cn('flex items-center gap-2 text-table text-muted-foreground', className)}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading this month&rsquo;s placements&hellip;
      </p>
    );
  }

  if (!result) {
    return (
      <p className={cn('text-table text-muted-foreground', className)}>
        The calendar could not be read, so nothing is shown here. That is not the same as nothing being
        planned — open the calendar to try again.
      </p>
    );
  }

  const shown = result.events.slice(0, limit);
  const total = result.totalInWindow;
  const held = result.unscheduled.total;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {shown.length === 0 ? (
        <p className="text-table text-muted-foreground">
          Nothing is planned in {result.window.timezone} for these dates. Content with no planned date is
          listed on the calendar under &ldquo;Not yet planned&rdquo; rather than placed on a day nobody
          chose.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((event) => (
            <li key={event.scheduleId} className="flex flex-col gap-1">
              <p className="text-meta text-muted-foreground">
                {formatDateHeading(event.plannedLocalDate)}
              </p>
              <EventCard
                event={event}
                href={hrefFor?.(event)}
                actions={undefined}
                showStaffFields={false}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        {shown.length < total ? (
          <>
            Showing {shown.length} of {totalIsExactLabel(result)} placements in this window. A placement not
            listed here is not evidence that it does not exist.
          </>
        ) : (
          <>Every placement in this window ({shown.length}).</>
        )}
        {held > 0 ? (
          <>
            {' '}
            {held === 1 ? '1 piece has' : `${held} pieces have`} no planned date yet.
          </>
        ) : null}{' '}
        <Link href={href} className="font-medium underline-offset-4 hover:underline">
          Open the calendar
        </Link>
      </p>
    </div>
  );
}

function totalIsExactLabel(result: CalendarReadResult): number | string {
  return result.totalIsExact ? result.totalInWindow : `at least ${result.totalInWindow}`;
}

/** Monday-first blank cells before the first of the month. */
function leadingBlanks(firstDate: string): number {
  if (!firstDate) return 0;
  const weekday = new Date(`${firstDate}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 6 : weekday - 1;
}

function weekDates(anchor: string): string[] {
  if (!anchor) return [];
  const date = new Date(`${anchor.slice(0, 10)}T00:00:00Z`);
  const weekday = date.getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  date.setUTCDate(date.getUTCDate() - back);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(date);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function formatDateHeading(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${DAY_NAMES[weekday === 0 ? 6 : weekday - 1]} ${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * True/false when the media query has been resolved, `null` before it is.
 *
 * `null` matters: the component must not pick a layout from a guess during
 * server rendering and then swap, so an unchosen view stays the mobile default
 * until the viewport is actually known.
 */
function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return isDesktop;
}
