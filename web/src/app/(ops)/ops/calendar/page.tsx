'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatDate, formatNumber, resolveTimeZone } from '@/lib/format';
import {
  CALENDAR_RANGE_PRESETS,
  listPortfolioReports,
  listPortfolioWork,
  rangeForPreset,
  toCalendarEntries,
  undatedWorkCount,
  type CalendarEntry,
  type CalendarRangePresetKey,
} from '@/services/calendar';
import { updateWorkItem, WORK_ITEM_STATUS_LABEL } from '@/services/delivery-plan';
import type { WorkRow } from '@/services/operations';

/**
 * OP13 — Team calendar.
 *
 * design_plan.md §4.2: *"Work due dates, reviews, releases, automated runs,
 * timezone, drag-to-reschedule alternative form"*, support "N G06/G07; three
 * schedule readers can seed a limited run-only view".
 *
 * What this screen deliberately is **not**: a month grid. §4.2 asks for a
 * schedule, and a grid would have to place undated work somewhere, imply that a
 * date with nothing on it has nothing on it, and pick a first day of week. A
 * single chronological list with the window stated in words says exactly what
 * is known.
 *
 * Three rules decide the details:
 *
 * 1. **Timezone is explicit, not ambient.** Every timestamp goes through
 *    `Timestamp`, which always names its zone, and the page states which zone it
 *    is resolving "today" in. Stored due dates were resolved server-side against
 *    each project's engagement timezone, so the page says that too — a due date
 *    that lands on a different calendar day for the reader is a real possibility
 *    and the reader should know why.
 * 2. **The window is a local filter, and says so.** Neither portfolio endpoint
 *    accepts a date range, so the window applies to the rows loaded on this page.
 *    The count of loaded rows versus the server's total is on screen.
 * 3. **Drag is not the only way, and is not implemented.** §4.2 asks for a
 *    "drag-to-reschedule alternative form" — the *form* is the accessible path
 *    and is what this screen builds: an explicit date field and an explicit save
 *    per work item. Nothing here depends on a pointer gesture, and nothing
 *    reschedules implicitly.
 */
type Filters = {
  q: string;
  kind: string;
  status: string;
  scope: string;
  range: string;
  page: number;
};

const FILTER_DEFAULTS: Filters = {
  q: '',
  kind: FILTER_ALL,
  status: FILTER_ALL,
  scope: FILTER_ALL,
  range: 'all',
  page: 1,
};

const PAGE_SIZE = 100;

/**
 * `useUrlState` reads `useSearchParams`, which suspends during a static
 * prerender. The boundary sits outside the component that calls the hook, so
 * the route builds as client-rendered rather than failing the export.
 */
export default function TeamCalendarPage() {
  return (
    <Suspense fallback={<CalendarSkeleton />}>
      <TeamCalendarView />
    </Suspense>
  );
}

function CalendarSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function TeamCalendarView() {
  const [filters, setFilters] = useUrlState<Filters>(FILTER_DEFAULTS);

  const [work, setWork] = useState<WorkRow[]>([]);
  const [workTotal, setWorkTotal] = useState(0);
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof listPortfolioReports>>['items']>(
    [],
  );
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  /** Resolved after mount: the server's zone is not the viewer's zone. */
  const [zone, setZone] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<string | null>(null);

  useEffect(() => {
    setZone(resolveTimeZone());
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setLoading(true);
        const [workPage, reportPage] = await Promise.all([
          listPortfolioWork({ page: filters.page, pageSize: PAGE_SIZE }, { signal }),
          listPortfolioReports({ page: 1, pageSize: PAGE_SIZE }, { signal }),
        ]);
        setWork(workPage.items);
        setWorkTotal(workPage.total);
        setReleases(reportPage.items);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [filters.page],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const allEntries = useMemo(() => toCalendarEntries(work, releases), [work, releases]);

  const { windowFrom, windowTo } = useMemo(() => {
    const range = rangeForPreset(filters.range as CalendarRangePresetKey);
    return {
      windowFrom: range.from ? new Date(range.from).getTime() : null,
      windowTo: range.to ? new Date(range.to).getTime() : null,
    };
  }, [filters.range]);

  const entries = useMemo(() => {
    const search = filters.q.trim().toLowerCase();
    return allEntries.filter((entry) => {
      if (filters.kind !== FILTER_ALL && entry.kind !== filters.kind) return false;
      if (filters.status !== FILTER_ALL && entry.status !== filters.status) return false;
      if (filters.scope !== FILTER_ALL) {
        const hasClient = Boolean(entry.clientId);
        if (filters.scope === 'client' && !hasClient) return false;
        if (filters.scope === 'internal' && hasClient) return false;
      }
      const at = new Date(entry.date).getTime();
      if (windowFrom !== null && at < windowFrom) return false;
      if (windowTo !== null && at > windowTo) return false;
      if (search) {
        const haystack = [
          entry.title,
          entry.projectName,
          entry.clientName ?? '',
          entry.status,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }, [allEntries, filters, windowFrom, windowTo]);

  const groups = useMemo(() => groupByDay(entries, zone), [entries, zone]);

  const isFiltered =
    filters.kind !== FILTER_ALL ||
    filters.status !== FILTER_ALL ||
    filters.scope !== FILTER_ALL ||
    filters.range !== 'all' ||
    filters.q.trim() !== '';

  const undated = undatedWorkCount(work);

  async function onReschedule(row: WorkRow, dueOn: string) {
    setRescheduling(row.id);
    try {
      await updateWorkItem(row.projectId, row.id, { dueOn });
      await load();
    } finally {
      setRescheduling(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Operator workspace', href: '/ops' }]}
        title="Calendar"
        context="Dated commitments across the portfolio: work due dates and report releases."
        status={
          zone ? (
            <span className="text-meta text-muted-foreground">
              Displayed in {zone}
            </span>
          ) : undefined
        }
      />

      <Card>
        <CardContent className="space-y-2 pt-6 text-table">
          <p>
            <strong className="font-medium">Timezone.</strong> Every date and time below is shown
            with its zone ({zone ?? 'resolving…'}), and &ldquo;today&rdquo; is resolved in that same
            zone. A work item&apos;s stored due date was resolved server-side against its project&apos;s
            engagement timezone — never a browser clock — so a date that falls on a different day
            for you than for the assignee is expected, not a bug.
          </p>
          <p className="text-muted-foreground">
            <strong className="font-medium text-foreground">Window.</strong>{' '}
            {filters.range === 'all'
              ? 'No window is applied.'
              : `The window applies to the rows loaded on this page${
                  windowFrom ? ` from ${formatDate(new Date(windowFrom).toISOString(), { timeZone: zone ?? undefined })}` : ''
                }${windowTo ? ` until ${formatDate(new Date(windowTo).toISOString(), { timeZone: zone ?? undefined })}` : ''}.`}{' '}
            Neither portfolio endpoint accepts a date range, so this is a local filter over{' '}
            {formatNumber(work.length)} loaded work item{work.length === 1 ? '' : 's'} out of{' '}
            {formatNumber(workTotal)} matching on the server.
          </p>
          {undated > 0 ? (
            <p className="text-muted-foreground">
              {formatNumber(undated)} work item{undated === 1 ? '' : 's'} in this read{' '}
              {undated === 1 ? 'has' : 'have'} no due date, so {undated === 1 ? 'it is' : 'they are'}{' '}
              not on the calendar below. They are real commitments with no date, not zero-dated
              ones.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => void load()}
          preserveNotice="Nothing on this page modifies a schedule except the explicit reschedule form."
        />
      ) : null}

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        controls={[
          {
            kind: 'select',
            key: 'kind',
            label: 'Entry type',
            allLabel: 'All dated entries',
            options: [
              { value: 'work', label: 'Work due dates' },
              { value: 'release', label: 'Report releases' },
            ],
          },
          {
            kind: 'select',
            key: 'status',
            label: 'Status',
            allLabel: 'Any status',
            options: [
              ...Object.entries(WORK_ITEM_STATUS_LABEL).map(([value, label]) => ({ value, label })),
              { value: 'draft', label: 'Report: draft' },
              { value: 'in-review', label: 'Report: in review' },
              { value: 'approved', label: 'Report: approved' },
              { value: 'released', label: 'Report: released' },
              { value: 'withdrawn', label: 'Report: withdrawn' },
            ],
          },
          {
            kind: 'select',
            key: 'scope',
            label: 'Reach',
            allLabel: 'Client and internal',
            options: [
              { value: 'client', label: 'Client-facing' },
              { value: 'internal', label: 'Internal only' },
            ],
          },
          {
            kind: 'select',
            key: 'range',
            label: 'Window',
            allLabel: 'Everything on file',
            options: CALENDAR_RANGE_PRESETS.filter((preset) => preset.key !== 'all').map(
              (preset) => ({ value: preset.key, label: preset.label }),
            ),
          },
        ]}
        searchPlaceholder="Search title, project or client…"
        summary={
          <>
            Showing {formatNumber(entries.length)} of {formatNumber(allEntries.length)} dated entries
            loaded
            {isFiltered ? ' — filters apply to the rows loaded on this page.' : '.'}
          </>
        }
      />

      {loading && allEntries.length === 0 ? (
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : entries.length === 0 ? (
        allEntries.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <EmptyState
                variant="not-measured"
                subject="dated commitments in this portfolio"
                prerequisite="work items with a due date, or released reports"
                layout="panel"
              >
                <p>
                  Neither reader returned a dated entry. That is not the same as an empty calendar:
                  work without a due date is not on a calendar at all, and the count above says how
                  many such items this read contains.
                </p>
              </EmptyState>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <EmptyState
                variant="no-results"
                onClearFilters={() =>
                  setFilters({
                    q: '',
                    kind: FILTER_ALL,
                    status: FILTER_ALL,
                    scope: FILTER_ALL,
                    range: 'all',
                  })
                }
                layout="panel"
              />
            </CardContent>
          </Card>
        )
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`day-${group.key}`}>
              <h2
                id={`day-${group.key}`}
                className="mb-2 flex flex-wrap items-baseline gap-3 text-subsection font-semibold"
              >
                {group.label}
                <span className="text-meta font-normal text-muted-foreground">
                  {formatNumber(group.entries.length)} entr
                  {group.entries.length === 1 ? 'y' : 'ies'}
                </span>
              </h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
                {group.entries.map((entry) => (
                  <li key={entry.id} className="p-4">
                    <CalendarRow
                      entry={entry}
                      zone={zone ?? undefined}
                      rescheduling={rescheduling === entry.work?.id}
                      onReschedule={onReschedule}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {workTotal > work.length ? (
        <div className="flex flex-wrap items-center gap-3 text-table">
          <span className="text-muted-foreground">
            Showing {formatNumber(work.length)} of {formatNumber(workTotal)} work items — the reader
            is paginated, so the window applies to this page only.
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={filters.page <= 1}
            onClick={() => setFilters({ page: Math.max(1, filters.page - 1) }, { push: true })}
          >
            Previous page
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={filters.page * PAGE_SIZE >= workTotal}
            onClick={() => setFilters({ page: filters.page + 1 }, { push: true })}
          >
            Next page
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Review meetings</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              variant="not-measured"
              subject="a dated, cross-project review schedule"
              prerequisite="a portfolio-level approvals or review-meeting reader (design_plan G06/G14)"
              layout="panel"
            >
              <p>
                Approvals are readable per project (<code className="text-meta">
                  /projects/:id/approvals
                </code>
                ), each with its own due date, but no endpoint lists them across projects. So this
                calendar cannot say when reviews fall — which means the schedule above is
                incomplete by exactly that much.
              </p>
              <p>
                To see the reviews you do own, open a project&apos;s approvals list. Nothing here
                implies there are none.
              </p>
            </EmptyState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Automated runs</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              variant="not-measured"
              subject="a portfolio-wide automated-run schedule"
              prerequisite="an aggregate cadence reader (design_plan G07)"
              layout="panel"
            >
              <p>
                Cadence rules are readable one project at a time (
                <code className="text-meta">/projects/:id/cadences</code>), each with its own{' '}
                <code className="text-meta">nextRunAt</code> in its own timezone. Nothing aggregates
                them, so the plan&apos;s note stands: three separate schedule readers can seed a
                limited run-only view, and that view does not exist yet.
              </p>
              <p>
                §7.3 also warns against promising a clock time before G07 lands — a saved schedule
                is not proof of a running worker. Per-project cadence state, last error and last
                success are on each project&apos;s monitoring screen.
              </p>
            </EmptyState>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CalendarRow({
  entry,
  zone,
  rescheduling,
  onReschedule,
}: {
  entry: CalendarEntry;
  zone?: string;
  rescheduling: boolean;
  onReschedule: (row: WorkRow, dueOn: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [dueOn, setDueOn] = useState(() => (entry.date ? entry.date.slice(0, 10) : ''));
  const [formError, setFormError] = useState<string | null>(null);

  const tone: StatusTone =
    entry.kind === 'release'
      ? entry.status === 'released'
        ? 'success'
        : entry.status === 'withdrawn'
          ? 'warning'
          : 'neutral'
      : entry.status === 'verified'
        ? 'success'
        : entry.status === 'blocked'
          ? 'danger'
          : entry.status === 'review'
            ? 'warning'
            : entry.status === 'active'
              ? 'info'
              : 'neutral';

  const statusLabel =
    entry.kind === 'release'
      ? entry.status.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
      : (WORK_ITEM_STATUS_LABEL[entry.status as keyof typeof WORK_ITEM_STATUS_LABEL] ??
        entry.status);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entry.work) return;
    setFormError(null);
    if (!dueOn) {
      setFormError('Choose a due date, or cancel to leave it unchanged.');
      return;
    }
    try {
      await onReschedule(entry.work, dueOn);
      setEditing(false);
    } catch (caught) {
      const error = toApiError(caught);
      setFormError(
        error.kind === 'conflict'
          ? error.message
          : 'The new date was not saved. The item still has its previous due date.',
      );
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              tone={entry.kind === 'release' ? 'info' : 'neutral'}
              label={entry.kind === 'release' ? 'Report release' : 'Work due'}
            />
            <span className="text-table font-medium">{entry.title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
            <Timestamp value={entry.date} timeZone={zone} />
            <Link href={`/projects/${entry.projectId}`} className="underline underline-offset-4">
              {entry.projectName}
            </Link>
            {entry.clientName ? <span>{entry.clientName}</span> : <span>Internal project</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {entry.overdue ? <StatusPill tone="danger" label="Overdue" /> : null}
          <StatusPill tone={tone} label={statusLabel} />
        </div>
      </div>

      {entry.work ? (
        <div className="space-y-2">
          {editing ? (
            <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor={`due-${entry.work.id}`}>New due date</Label>
                <Input
                  id={`due-${entry.work.id}`}
                  name={`due-${entry.work.id}`}
                  type="date"
                  value={dueOn}
                  onChange={(event) => setDueOn(event.target.value)}
                  aria-describedby={`due-${entry.work.id}-help`}
                />
              </div>
              <Button type="submit" size="sm" disabled={rescheduling}>
                {rescheduling ? 'Saving…' : 'Save due date'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setFormError(null);
                }}
                disabled={rescheduling}
              >
                Cancel
              </Button>
              <p id={`due-${entry.work.id}-help`} className="w-full text-meta text-muted-foreground">
                The date is resolved end-of-day in the project&apos;s engagement timezone, by the
                server. This form is the alternative to dragging: it states the value, states where
                it applies, and only saves when you say so.
              </p>
              {formError ? (
                <p className="w-full text-meta text-danger-foreground" role="alert">
                  {formError}
                </p>
              ) : null}
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Reschedule
              </Button>
              <Link
                href={`/projects/${entry.projectId}/work/${entry.work.id}`}
                className="text-meta underline underline-offset-4"
              >
                Open the work item
              </Link>
              <span className="text-meta text-muted-foreground">
                {entry.discipline ? `${entry.discipline} · ` : ''}
                {entry.priority ? `${entry.priority} priority` : ''}
              </span>
            </div>
          )}
        </div>
      ) : entry.report ? (
        <Link
          href={`/projects/${entry.projectId}/reports/${entry.report.slug}`}
          className="text-meta underline underline-offset-4"
        >
          Open the report
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Groups dated entries by the calendar day they fall on **in the resolved
 * zone**, so a heading and the timestamps under it cannot disagree.
 */
function groupByDay(
  entries: readonly CalendarEntry[],
  zone: string | null,
): Array<{ key: string; label: string; entries: CalendarEntry[] }> {
  const groups = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.date, zone);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()].map(([key, dayEntries]) => ({
    key,
    label: formatDate(dayEntries[0].date, { timeZone: zone ?? undefined }),
    entries: dayEntries,
  }));
}

/** `YYYY-MM-DD` for the instant, in the given zone (or the viewer's). */
function dayKey(iso: string, zone: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  try {
    // en-CA yields YYYY-MM-DD, which sorts and keys predictably.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: zone ?? undefined,
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}
