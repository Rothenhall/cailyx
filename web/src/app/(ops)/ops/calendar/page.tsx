'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useUrlState } from '@/hooks/useUrlState';
import { resolveTimeZone } from '@/lib/format';
import { listProjects } from '@/services/projects';
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
  readPortfolioCalendar,
  shiftMonth,
  updatePlacement,
  type CalendarEvent,
  type CalendarReadResult,
} from '@/services/content-calendar';

/**
 * P10 — the portfolio content calendar, and the screen §3.4 names "Content
 * calendar" in the global navigation.
 *
 * *"Rename the global calendar entry to **Content calendar** and treat it as
 * the portfolio scope of the same calendar."* That is literally what this file
 * is: the same `ContentCalendar` component and the same entry contract as the
 * project screen, reading `GET /content-calendar`, which resolves the permitted
 * project set from the caller's own access rules instead of from a parameter.
 *
 * ## What it replaced
 *
 * This route used to render a chronological list of work-item due dates and
 * released reports, drawn from `/operations/work` and `/operations/reports` —
 * neither of which takes a date range, so its "windows" were local filters over
 * whatever page had loaded. §6.4 removes exactly those two things from the
 * content calendar (work due dates belong to Team work; a report release is not
 * a content placement, and a report is not content a calendar schedules), and
 * §6.7 replaces the local window with a server-side one.
 *
 * ## Cross-project writes
 *
 * Moving a placement from here goes to the *project* that owns it
 * (`/projects/:projectId/content-schedules/:id`), because a placement belongs to
 * one project and its version is per-row. There is no portfolio-wide write
 * route, and there should not be: a bulk portfolio edit would have to invent a
 * transaction the API does not offer.
 */

const FILTER_DEFAULTS = {
  from: '',
  to: '',
  tz: '',
  project: FILTER_ALL,
  type: FILTER_ALL,
  channel: FILTER_ALL,
  state: FILTER_ALL,
  owner: FILTER_ALL,
  view: '',
};

interface RefusedTime {
  error: string;
  message: string;
  nextValidLocal?: string | null;
  candidates?: { disambiguation: 'earlier' | 'later'; utc: string }[];
}

function refusedTimeFrom(cause: unknown): RefusedTime | null {
  const error = toApiError(cause);
  const body = error.body as
    | { error?: unknown; message?: unknown; nextValidLocal?: unknown; candidates?: unknown }
    | undefined;
  if (!body || typeof body.error !== 'string') return null;
  if (!['time-nonexistent', 'time-ambiguous', 'invalid-timezone', 'invalid-time'].includes(body.error)) {
    return null;
  }
  return {
    error: body.error,
    message: typeof body.message === 'string' ? body.message : error.message,
    nextValidLocal: typeof body.nextValidLocal === 'string' ? body.nextValidLocal : null,
    candidates: Array.isArray(body.candidates) ? (body.candidates as RefusedTime['candidates']) : undefined,
  };
}

function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function currentMonthKey(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }).slice(0, 7);
}

function windowLabel(from: string, to: string, view: string): string {
  if (view === 'week') {
    const short = (date: string) =>
      new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    return `${short(from)} – ${short(to)}`;
  }
  return new Date(`${from}T12:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function PortfolioContentCalendarPage() {
  return (
    <Suspense fallback={<CalendarSkeleton />}>
      <PortfolioCalendarView />
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

function PortfolioCalendarView() {
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [result, setResult] = useState<CalendarReadResult | null>(null);
  // Only `id` and `name` are used, so the row type is stated here rather than
  // imported: the project filter is a name lookup, not a project read.
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
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

  const window = useMemo(() => {
    if (filters.from && filters.to) return { from: filters.from, to: filters.to };
    return monthWindow(currentMonthKey(timezone));
  }, [filters.from, filters.to, timezone]);

  // The project filter needs names, and names come from the project list — the
  // calendar read deliberately returns ids. This read is not critical: if it
  // fails, the filter loses its options and the calendar still works, which is
  // why its failure is not surfaced as the page's error.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await listProjects(undefined, { signal: controller.signal });
        setProjects(rows);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setProjects([]);
      }
    })();
    return () => controller.abort();
  }, []);

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
      const options = Array.from(rememberOwners.current.entries())
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label));
      setOwnerOptions(options);
    }
  }, [result]);

  const query = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      timezone,
      projectId: filters.project === FILTER_ALL ? undefined : filters.project,
      type: filters.type === FILTER_ALL ? undefined : filters.type,
      channel: filters.channel === FILTER_ALL ? undefined : filters.channel,
      state: filters.state === FILTER_ALL ? undefined : filters.state,
      ownerId: filters.owner === FILTER_ALL ? undefined : filters.owner,
    }),
    [
      window.from,
      window.to,
      timezone,
      filters.project,
      filters.type,
      filters.channel,
      filters.state,
      filters.owner,
    ],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setError(null);
        setResult(await readPortfolioCalendar(query, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [query],
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
      const next = await readPortfolioCalendar({ ...query, cursor });
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
  }, [query, result?.page.nextCursor]);

  const stepWindow = useCallback(
    (delta: number) => {
      if (filters.view === 'week') {
        setFilters({ from: addDays(window.from, 7 * delta), to: addDays(window.to, 7 * delta) });
        return;
      }
      const target = monthWindow(shiftMonth(window.from.slice(0, 7), delta));
      setFilters({ from: target.from, to: target.to });
    },
    [window, filters.view, setFilters],
  );

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
      await updatePlacement(moving.projectId, moving.scheduleId, {
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
        setRefusal(refused);
        return;
      }
      throw new Error(toApiError(caught).message);
    }
  }

  async function submitCancel(reason: string) {
    if (!cancelling) return;
    try {
      await cancelPlacement(cancelling.projectId, cancelling.scheduleId, reason, cancelling.version);
      setCancelling(null);
      await refresh();
    } catch (caught) {
      throw new Error(toApiError(caught).message);
    }
  }

  async function submitLink(input: { mode: 'draft' | 'publish'; permissions: string[] }) {
    if (!linking) return;
    try {
      await linkPlacementPublication(linking.projectId, linking.scheduleId, {
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
        context="Every project you can see, on one calendar. One placement per channel — a piece planned for two channels is two entries."
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
          scope="portfolio"
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
          windowLabel={windowLabel(window.from, window.to, filters.view)}
          onClearFilters={() =>
            setFilters({
              project: FILTER_ALL,
              type: FILTER_ALL,
              channel: FILTER_ALL,
              state: FILTER_ALL,
              owner: FILTER_ALL,
            })
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
                  key: 'project',
                  label: 'Project',
                  options: projects.map((project) => ({ value: project.id, label: project.name })),
                },
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
                { kind: 'text', key: 'tz', label: 'Timezone', placeholder: browserZone },
              ]}
              summary={
                result
                  ? `Across ${result.scope.projectIds.length} project${
                      result.scope.projectIds.length === 1 ? '' : 's'
                    }; boundaries read in ${result.window.timezone}.`
                  : undefined
              }
            />
          }
          hrefFor={(event) => contentDetailHref(event.projectId, event.assetId, event.scheduleId)}
          hrefForUnscheduled={(item) => contentDetailHref(item.projectId, item.assetId)}
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
