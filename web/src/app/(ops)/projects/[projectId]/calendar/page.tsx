'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CancelPlacementDialog,
  ContentCalendar,
  LinkPublicationDialog,
  RescheduleDialog,
} from '@/components/patterns/ContentCalendar';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { useUrlState } from '@/hooks/useUrlState';
import { resolveTimeZone } from '@/lib/format';
import {
  CALENDAR_CHANNEL_OPTIONS,
  CALENDAR_CONTENT_TYPES,
  CONTENT_TYPE_LABELS,
  SCHEDULE_STATES,
  SCHEDULE_STATE_LABELS,
  cancelPlacement,
  contentDetailHref,
  linkPlacementPublication,
  monthWindow,
  readProjectCalendar,
  shiftMonth,
  updatePlacement,
  type CalendarEvent,
  type CalendarReadResult,
} from '@/services/content-calendar';

/**
 * P10 — the project content calendar.
 *
 * platform_improvement_plan.md §6.4: *"One content calendar feature, one entry
 * contract, one shared React implementation, one source of scheduling truth."*
 * This screen is the project scope of that one feature. It renders
 * `ContentCalendar` — the same component the portfolio and client calendars
 * render — and every state, count and "not published yet" reading comes from
 * `GET /projects/:projectId/content-calendar`, which derives them from the
 * source facts rather than storing them.
 *
 * ## What this screen used to be, and what happened to that
 *
 * It was four bands of different things: work-item due dates, milestone due
 * dates, approval due dates, run cadence, and released reports. §6.4 separates
 * those deliberately — a task's due date and a crawler's next run are not
 * content placements, and putting them in the same month grid is how a reader
 * concludes that content is planned for a day when nothing is. Those schedules
 * are **not deleted**: work due dates are on Team work (`/projects/:id/work`),
 * and cadence and runs are on Monitoring (`/projects/:id/monitoring`).
 *
 * ## The window is the server's
 *
 * `from`/`to`/`timezone` are sent with every read. Nothing is filtered in the
 * browser after loading a page, which is what §6.7 asks for and what makes the
 * "month complete beyond 200 entries" claim checkable: the month's contents do
 * not depend on how many rows happened to arrive.
 *
 * ## Why the url state carries an empty window by default
 *
 * `from: ''`/`to: ''` means "the current month in the current timezone" and is
 * resolved on every render, so a bookmarked calendar still opens on the current
 * month a year later instead of on a frozen one. Stepping pins explicit dates,
 * which are then shareable, and "Today" returns to the empty default.
 */

/**
 * Filter + window state. A stable module constant, as `FilterBar` requires: it
 * is the set of keys `useUrlState` decodes, so a key missing here disappears
 * from a copied link.
 */
const FILTER_DEFAULTS = {
  from: '',
  to: '',
  tz: '',
  type: FILTER_ALL,
  channel: FILTER_ALL,
  state: FILTER_ALL,
  owner: FILTER_ALL,
  view: '',
};

/** A refused local reading, as the server described it (§6.7's DST rules). */
interface RefusedTime {
  error: string;
  message: string;
  nextValidLocal?: string | null;
  candidates?: { disambiguation: 'earlier' | 'later'; utc: string }[];
}

/**
 * Reads a `time-nonexistent` / `time-ambiguous` refusal out of a failed write.
 *
 * These are the two failures that are not errors so much as *questions* — "that
 * time does not exist" and "that time happened twice" — so they are carried
 * back into the form as a choice rather than shown as a generic failure.
 */
function refusedTimeFrom(cause: unknown): RefusedTime | null {
  const error = toApiError(cause);
  const body = error.body as
    | {
        error?: unknown;
        message?: unknown;
        nextValidLocal?: unknown;
        candidates?: unknown;
      }
    | undefined;
  if (!body || typeof body.error !== 'string') return null;
  if (!['time-nonexistent', 'time-ambiguous', 'invalid-timezone', 'invalid-time'].includes(body.error)) {
    return null;
  }
  return {
    error: body.error,
    message: typeof body.message === 'string' ? body.message : error.message,
    nextValidLocal: typeof body.nextValidLocal === 'string' ? body.nextValidLocal : null,
    candidates: Array.isArray(body.candidates)
      ? (body.candidates as RefusedTime['candidates'])
      : undefined,
  };
}

/** `YYYY-MM-DD` shifted by whole days, in UTC so no local clock is involved. */
function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The current month key in a named zone — the window an unstepped calendar shows. */
function currentMonthKey(timezone: string): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  return today.slice(0, 7);
}

/** The window label, in the reader's terms rather than in date-string terms. */
function windowLabel(from: string, to: string, view: string): string {
  const monthName = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  if (view === 'week') {
    const short = (date: string) =>
      new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    return `${short(from)} – ${short(to)}`;
  }
  return monthName(from);
}

export default function ProjectCalendarPage() {
  // `useUrlState` reads `useSearchParams`, which suspends during static
  // prerender, so the view is wrapped the same way every other filtered screen
  // in the app wraps it.
  return (
    <Suspense fallback={<CalendarSkeleton />}>
      <ProjectContentView />
    </Suspense>
  );
}

function CalendarSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-12 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

function ProjectContentView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [result, setResult] = useState<CalendarReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [moving, setMoving] = useState<CalendarEvent | null>(null);
  const [refusal, setRefusal] = useState<RefusedTime | null>(null);
  const [cancelling, setCancelling] = useState<CalendarEvent | null>(null);
  const [linking, setLinking] = useState<CalendarEvent | null>(null);

  const browserZone = useMemo(() => resolveTimeZone(), []);
  const timezone = filters.tz.trim() || browserZone;

  // The window, resolved once per render so an unstepped calendar always means
  // "the current month" rather than "the month this was first opened".
  const window = useMemo(() => {
    if (filters.from && filters.to) return { from: filters.from, to: filters.to };
    return monthWindow(currentMonthKey(timezone));
  }, [filters.from, filters.to, timezone]);

  /**
   * Owner options, accumulated across reads.
   *
   * They cannot be derived from the current result alone: choosing an owner
   * filters the read to that owner, which would empty the list of every other
   * choice and strand the reader on a filter they cannot undo. Options are
   * therefore unioned over the session and the select is never emptied by
   * using it. `/users` is admin-only, which is why the server resolves the
   * labels for the owners it returned rather than the browser listing staff.
   */
  const [ownerOptions, setOwnerOptions] = useState<{ value: string; label: string }[]>([]);
  const rememberOwners = useRef(new Map<string, string>());
  useEffect(() => {
    if (!result) return;
    let changed = false;
    for (const event of result.events) {
      if (!event.ownerId || rememberOwners.current.has(event.ownerId)) continue;
      rememberOwners.current.set(event.ownerId, event.ownerLabel ?? event.ownerId);
      changed = true;
    }
    if (changed) {
      const options = Array.from(rememberOwners.current.entries()).map(([value, label]) => ({
        value,
        label,
      }));
      options.sort((a, b) => a.label.localeCompare(b.label));
      setOwnerOptions(options);
    }
  }, [result]);

  const query = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      timezone,
      type: filters.type === FILTER_ALL ? undefined : filters.type,
      channel: filters.channel === FILTER_ALL ? undefined : filters.channel,
      state: filters.state === FILTER_ALL ? undefined : filters.state,
      ownerId: filters.owner === FILTER_ALL ? undefined : filters.owner,
    }),
    [window.from, window.to, timezone, filters.type, filters.channel, filters.state, filters.owner],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setError(null);
        const next = await readProjectCalendar(projectId, query, { signal });
        setResult(next);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [projectId, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const loadMore = useCallback(async () => {
    const cursor = result?.page.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      setActionError(null);
      const next = await readProjectCalendar(projectId, { ...query, cursor });
      setResult((current) =>
        current
          ? {
              ...current,
              events: [...current.events, ...next.events],
              layout: [...current.layout, ...next.layout],
              page: next.page,
              totalInWindow: next.totalInWindow,
              totalIsExact: next.totalIsExact,
            }
          : next,
      );
    } catch (caught) {
      setActionError(toApiError(caught).message);
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, query, result?.page.nextCursor]);

  /**
   * Step the window.
   *
   * Month and Agenda step by whole months; Week steps by seven days. The
   * step is applied to the *window*, never to an event (§6.7: "moving a plan
   * date must not silently reschedule content", and the mirror of it — looking
   * at the next month must not move anything).
   */
  const stepWindow = useCallback(
    (delta: number) => {
      const base = { ...window };
      if (filters.view === 'week') {
        setFilters({ from: addDays(base.from, 7 * delta), to: addDays(base.to, 7 * delta) });
        return;
      }
      const target = monthWindow(shiftMonth(base.from.slice(0, 7), delta));
      setFilters({ from: target.from, to: target.to });
    },
    [window, filters.view, setFilters],
  );

  const regionLabel = windowLabel(window.from, window.to, filters.view);

  /** Re-read after every write: state is derived, so it is never patched locally. */
  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  async function submitMove(input: {
    scheduledFor: string;
    timezone: string;
    dstDisambiguation?: 'earlier' | 'later';
  }) {
    if (!moving) return;
    setRefusal(null);
    try {
      await updatePlacement(projectId, moving.scheduleId, {
        // The version that was read. A stale one is refused rather than
        // overwriting whatever another operator changed (§6.7).
        version: moving.version,
        scheduledFor: input.scheduledFor,
        timezone: input.timezone,
        dstDisambiguation: input.dstDisambiguation,
      });
      setMoving(null);
      await refresh();
    } catch (caught) {
      const refused = refusedTimeFrom(caught);
      if (refused) {
        // A question, not a failure — the form stays open and asks.
        setRefusal(refused);
        return;
      }
      throw new Error(toApiError(caught).message);
    }
  }

  async function submitCancel(reason: string) {
    if (!cancelling) return;
    try {
      await cancelPlacement(projectId, cancelling.scheduleId, reason, cancelling.version);
      setCancelling(null);
      await refresh();
    } catch (caught) {
      throw new Error(toApiError(caught).message);
    }
  }

  async function submitLink(input: { mode: 'draft' | 'publish'; permissions: string[] }) {
    if (!linking) return;
    try {
      await linkPlacementPublication(projectId, linking.scheduleId, {
        mode: input.mode,
        permissions: input.permissions,
      });
      setLinking(null);
      await refresh();
    } catch (caught) {
      throw new Error(toApiError(caught).message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content calendar"
        context="When content is intended to go out, and what actually happened to it. Work due dates and monitoring runs live on Team work and Monitoring."
        status={
          result ? (
            <StatusPill
              label={`${result.scope.projectIds.length === 1 ? 'This project' : `${result.scope.projectIds.length} projects`}`}
              tone="neutral"
            />
          ) : undefined
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      ) : null}

      {actionError ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-table text-danger-foreground">
          {actionError}
        </p>
      ) : null}

      {!error ? (
        <ContentCalendar
          scope="project"
          result={result}
          loading={loading}
          error={null}
          onRetry={() => void load()}
          onLoadMore={() => void loadMore()}
          loadingMore={loadingMore}
          view={filters.view === '' ? undefined : (filters.view as 'month' | 'week' | 'agenda')}
          onViewChange={(view) => setFilters({ view })}
          onStepWindow={stepWindow}
          onToday={() => setFilters({ from: '', to: '' })}
          windowLabel={regionLabel}
          onClearFilters={() =>
            setFilters({ type: FILTER_ALL, channel: FILTER_ALL, state: FILTER_ALL, owner: FILTER_ALL })
          }
          filters={
            <FilterBar
              defaults={FILTER_DEFAULTS}
              value={filters}
              onChange={setFilters}
              hideSearch
              controls={[
                {
                  kind: 'select',
                  key: 'type',
                  label: 'Content type',
                  options: CALENDAR_CONTENT_TYPES.map((value) => ({
                    value,
                    label: CONTENT_TYPE_LABELS[value],
                  })),
                },
                { kind: 'select', key: 'channel', label: 'Channel', options: CALENDAR_CHANNEL_OPTIONS },
                {
                  kind: 'select',
                  key: 'state',
                  label: 'State',
                  options: SCHEDULE_STATES.map((value) => ({
                    value,
                    label: SCHEDULE_STATE_LABELS[value],
                  })),
                },
                { kind: 'select', key: 'owner', label: 'Owner', options: ownerOptions },
                {
                  kind: 'text',
                  key: 'tz',
                  label: 'Timezone',
                  placeholder: browserZone,
                },
              ]}
              summary={
                result
                  ? `Week and month boundaries are read in ${result.window.timezone}.`
                  : undefined
              }
            />
          }
          hrefFor={(event) => contentDetailHref(projectId, event.assetId, event.scheduleId)}
          hrefForUnscheduled={(item) => contentDetailHref(projectId, item.assetId)}
          showStaffFields
          actions={{
            onReschedule: (event) => {
              setRefusal(null);
              setMoving(event);
            },
            onCancel: (event) => setCancelling(event),
            onLinkPublication: (event) => setLinking(event),
          }}
        />
      ) : null}

      {moving ? (
        <RescheduleDialog
          event={moving}
          open
          onOpenChange={(open) => {
            if (!open) {
              setMoving(null);
              setRefusal(null);
            }
          }}
          onSubmit={submitMove}
          serverRefusal={refusal}
        />
      ) : null}

      {cancelling ? (
        <CancelPlacementDialog
          event={cancelling}
          open
          onOpenChange={(open) => !open && setCancelling(null)}
          onSubmit={submitCancel}
        />
      ) : null}

      {linking ? (
        <LinkPublicationDialog
          event={linking}
          open
          onOpenChange={(open) => !open && setLinking(null)}
          onSubmit={submitLink}
        />
      ) : null}
    </div>
  );
}
