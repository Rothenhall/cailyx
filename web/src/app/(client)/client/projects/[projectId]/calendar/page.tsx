'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { ContentCalendar } from '@/components/patterns/ContentCalendar';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { useUrlState } from '@/hooks/useUrlState';
import { resolveTimeZone } from '@/lib/format';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  CALENDAR_CHANNEL_OPTIONS,
  CALENDAR_CONTENT_TYPES,
  CONTENT_TYPE_LABELS,
  SCHEDULE_STATES,
  SCHEDULE_STATE_LABELS,
  monthWindow,
  readClientCalendar,
  shiftMonth,
  type CalendarReadResult,
} from '@/services/content-calendar';

/**
 * P10 — the client's own content calendar.
 *
 * platform_improvement_plan.md §6.5 requires that "client users see only
 * explicitly shared content (internal draft titles must not leak through events
 * **or counts**)". That is enforced on the server, and deliberately not here:
 * `readClientCalendar` calls `GET /portal/projects/:id/content-calendar`, which
 * applies the shared-revision filter to the *query*. A client read therefore
 * cannot receive an unshared draft title, and the totals it renders —
 * `totalInWindow`, `unscheduled.total` — are counts of the filtered set, not
 * counts of everything minus the rows this screen chose to hide. Hiding rows in
 * a browser would still leak the number, which is the leak §6.5 names.
 *
 * It is read-only by construction: no writes, no staff fields, no destination
 * labels, no owner ids, no raw provider errors. Moving a placement is the
 * agency's action, so no control for it exists in this scope.
 *
 * ## Opening a piece is not offered here yet
 *
 * The portal has no content detail screen in this build (`/client/projects/:id/
 * content` is a stub that says as much), so event titles are **not** links: a
 * click that lands on "not available in this build" is worse than a title that
 * plainly is not a link. The moment that screen exists, `hrefFor` is the one
 * line that turns them back into links.
 *
 * The client sees a placement on a channel with no connected provider — email,
 * paid ads, organic social — labelled as delivered by a person, and never an
 * automated Send or Launch control, because there is nothing behind one.
 */

const FILTER_DEFAULTS = {
  from: '',
  to: '',
  tz: '',
  type: 'all',
  channel: 'all',
  state: 'all',
  view: '',
};

const FILTER_ALL = 'all';

function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function currentMonthKey(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }).slice(0, 7);
}

/**
 * §3.4: a date is only correct together with the zone it was read in. The
 * month or week the reader is looking at is formatted in the *effective* zone
 * (their own, unless the window pinned one) rather than a hardcoded UTC — a
 * UTC-only label can name a different month from the one whose dates are
 * listed underneath it.
 */
function windowLabel(from: string, to: string, view: string, timeZone: string): string {
  if (view === 'week') {
    const short = (date: string) =>
      new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone,
      });
    return `${short(from)} – ${short(to)}`;
  }
  return new Date(`${from}T12:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone,
  });
}

export default function ClientContentCalendarPage() {
  return (
    <Suspense fallback={<CalendarSkeleton />}>
      <ClientCalendarView />
    </Suspense>
  );
}

function CalendarSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

function ClientCalendarView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [result, setResult] = useState<CalendarReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const browserZone = useMemo(() => resolveTimeZone(), []);
  const timezone = filters.tz.trim() || browserZone;

  const window = useMemo(() => {
    if (filters.from && filters.to) return { from: filters.from, to: filters.to };
    return monthWindow(currentMonthKey(timezone));
  }, [filters.from, filters.to, timezone]);

  // The project name only feeds the scope banner, so its failure is not the
  // page's failure: a client whose project list cannot be read still has a
  // usable calendar.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const projects = await listPortalProjectSummaries({ signal: controller.signal });
        setProject(projects.find((row) => row.id === projectId) ?? null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setProject(null);
      }
    })();
    return () => controller.abort();
  }, [projectId]);

  const query = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      timezone,
      type: filters.type === FILTER_ALL ? undefined : filters.type,
      channel: filters.channel === FILTER_ALL ? undefined : filters.channel,
      state: filters.state === FILTER_ALL ? undefined : filters.state,
    }),
    [window.from, window.to, timezone, filters.type, filters.channel, filters.state],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setError(null);
        setResult(await readClientCalendar(projectId, query, { signal }));
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
      const next = await readClientCalendar(projectId, { ...query, cursor });
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
      setActionError(
        clientActionMessage(caught, 'More calendar entries could not be loaded. Nothing else has changed.'),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, query, result?.page.nextCursor]);

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

  return (
    <div className="space-y-6">
      {project ? (
        <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          ...(project ? [{ label: project.name, href: `/client/projects/${projectId}` }] : []),
          { label: 'Content calendar' },
        ]}
        title="Content calendar"
        context="What we plan to publish for you, and when. Only content we have shared with you appears here."
      />

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => void load()}
          notFoundReason="missing-or-private"
          showServerMessage={false}
        />
      ) : (
        <>
          {actionError ? (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-table text-danger-foreground">
              {actionError}
            </p>
          ) : null}

          {/* No `hrefFor` and no `actions`: this scope has neither a content
              detail to open nor any write to offer. */}
          <ContentCalendar
            scope="client"
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
            windowLabel={windowLabel(window.from, window.to, filters.view, timezone)}
            onClearFilters={() =>
              setFilters({ type: FILTER_ALL, channel: FILTER_ALL, state: FILTER_ALL })
            }
            filters={
              <ClientFilterBar
                value={filters}
                onChange={setFilters}
                browserZone={browserZone}
                windowTimezone={result?.window.timezone}
              />
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * The client's filters.
 *
 * The same controls as the staff screen minus two, and the two omissions are
 * the point: there is no **owner** filter, because which of our staff is
 * assigned to a piece is internal, and no **project** filter, because this
 * calendar is already one project. A filter that only ever returns internal ids
 * is not a control a client should be offered.
 */
function ClientFilterBar({
  value,
  onChange,
  browserZone,
  windowTimezone,
}: {
  value: typeof FILTER_DEFAULTS;
  onChange: (patch: Partial<typeof FILTER_DEFAULTS>) => void;
  browserZone: string;
  windowTimezone?: string;
}) {
  const selects: { key: keyof typeof FILTER_DEFAULTS; label: string; options: { value: string; label: string }[] }[] = [
    {
      key: 'type',
      label: 'Content type',
      options: CALENDAR_CONTENT_TYPES.map((type) => ({ value: type, label: CONTENT_TYPE_LABELS[type] })),
    },
    { key: 'channel', label: 'Channel', options: CALENDAR_CHANNEL_OPTIONS },
    {
      key: 'state',
      label: 'Status',
      options: SCHEDULE_STATES.map((state) => ({ value: state, label: SCHEDULE_STATE_LABELS[state] })),
    },
  ];

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
      {selects.map((select) => (
        <div key={select.key} className="min-w-[10rem] space-y-1.5">
          <label htmlFor={`client-filter-${select.key}`} className="text-meta text-muted-foreground">
            {select.label}
          </label>
          <select
            id={`client-filter-${select.key}`}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-table"
            value={value[select.key]}
            onChange={(event) => onChange({ [select.key]: event.target.value })}
          >
            <option value={FILTER_ALL}>All</option>
            {select.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      <div className="min-w-[10rem] space-y-1.5">
        <label htmlFor="client-filter-tz" className="text-meta text-muted-foreground">
          Timezone
        </label>
        <input
          id="client-filter-tz"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-table"
          value={value.tz}
          placeholder={browserZone}
          onChange={(event) => onChange({ tz: event.target.value })}
        />
      </div>

      <p className="text-meta text-muted-foreground">
        {windowTimezone ? `Dates are read in ${windowTimezone}.` : null}
      </p>
    </div>
  );
}
