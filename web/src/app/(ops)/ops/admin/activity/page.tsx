'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { Download, Info, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import {
  ACTIVITY_ACTIONS,
  exportActivity,
  listActivity,
  type ActivityAction,
  type ActivityEvent,
} from '@/services/admin';

/**
 * OP19 — Activity audit.
 *
 * design_plan.md §4.2: *"Actor/action/client/time/result, security/release/
 * budget changes, export."* The module behind it (G15) is the **append-only**
 * activity/provenance/audit trail, and the controller has *no write route at
 * all* — deliberately, because an HTTP endpoint that took actor and result from
 * a request body would let a caller forge the record it is supposed to be
 * evidence of.
 *
 * Three consequences for this screen, none of them negotiable:
 *
 *  1. **No edit and no delete control.** There is no endpoint to call, and the
 *     screen does not imply one exists.
 *  2. **Failures are in the list.** A `result: 'failure'` row is not filtered
 *     out and not hidden behind a disclosure — it is the reason a log like this
 *     exists. `Failures only` narrows *to* them; nothing narrows them away by
 *     default.
 *  3. **What is rendered is what the API returned.** Actor, origin and result
 *     come from the server; nothing here is inferred from a summary string.
 *
 * Security, release and budget changes are all rows in this same log; they are
 * narrowed by the action and resource filters rather than split across screens,
 * because a filter that hides a category is how a change goes unnoticed. The
 * resource-type options are built from the events actually loaded — inventing
 * a vocabulary of resource types here would offer filters that match nothing.
 */

const FILTER_DEFAULTS = {
  q: '',
  action: FILTER_ALL,
  resourceType: FILTER_ALL,
  result: FILTER_ALL,
  scope: 'all',
};

/** Readable action labels. The wire values stay the filter's option values. */
const ACTION_LABEL: Record<ActivityAction, string> = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted',
  released: 'Released',
  approved: 'Approved',
  rejected: 'Rejected',
  published: 'Published',
  sent: 'Sent',
  started: 'Started',
  cancelled: 'Cancelled',
  granted: 'Access granted',
  revoked: 'Access revoked',
  'logged-in': 'Signed in',
};

/**
 * The three change classes §4.2 names, expressed over the action vocabulary
 * that actually exists — so the quick filters match real rows instead of a
 * guessed resource-type list.
 */
const CATEGORY_ACTIONS: Record<string, ActivityAction[]> = {
  security: ['granted', 'revoked', 'logged-in'],
  release: ['released', 'published', 'approved', 'rejected'],
  write: ['created', 'updated', 'deleted'],
};

export default function AdminActivityPage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<ActivitySkeleton />}>
      <ActivityScreen />
    </Suspense>
  );
}

function ActivitySkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

function ActivityScreen() {
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [pages, setPages] = useState<
    Array<{ cursor?: string; events: ActivityEvent[]; nextCursor: string | null }>
  >([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      action: filters.action === FILTER_ALL ? undefined : (filters.action as ActivityAction),
      resourceType: filters.resourceType === FILTER_ALL ? undefined : filters.resourceType,
    }),
    [filters.action, filters.resourceType],
  );

  const loadFirstPage = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      try {
        setError(null);
        const result = await listActivity({ ...query, limit: 100 }, { signal });
        setPages([{ events: result.events, nextCursor: result.nextCursor }]);
        setPageIndex(0);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setIsLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage]);

  /** Cursor paging: a page is fetched once and then kept, so back is instant. */
  const onPageChange = useCallback(
    async (nextPage: number) => {
      if (nextPage < pages.length) {
        setPageIndex(nextPage);
        return;
      }
      const last = pages[pages.length - 1];
      if (!last?.nextCursor) return;
      setIsLoading(true);
      try {
        setError(null);
        const result = await listActivity({ ...query, limit: 100, cursor: last.nextCursor });
        setPages((current) => [
          ...current,
          { cursor: last.nextCursor ?? undefined, events: result.events, nextCursor: result.nextCursor },
        ]);
        setPageIndex(pages.length);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setIsLoading(false);
      }
    },
    [pages, query],
  );

  const loaded = useMemo(() => pages.flatMap((page) => page.events), [pages]);
  const currentPage = useMemo(() => pages[pageIndex]?.events ?? [], [pages, pageIndex]);

  const resourceTypeOptions = useMemo(() => {
    const seen = new Set(loaded.map((event) => event.resourceType).filter(Boolean));
    return [...seen].sort().map((type) => ({ value: type, label: type }));
  }, [loaded]);

  const visible = useMemo(() => {
    const search = filters.q.trim().toLowerCase();
    const categoryActions = CATEGORY_ACTIONS[filters.scope];
    return currentPage.filter((event) => {
      if (filters.result !== FILTER_ALL && event.result !== filters.result) return false;
      if (filters.scope !== 'all' && categoryActions && !categoryActions.includes(event.action)) {
        return false;
      }
      if (!search) return true;
      return [
        event.actorLabel,
        event.actorId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.summary,
        event.clientId,
        event.projectId,
        event.requestId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
  }, [currentPage, filters.q, filters.result, filters.scope]);

  const hasMore = Boolean(pages[pages.length - 1]?.nextCursor);

  async function onExport() {
    setExportNotice(null);
    try {
      const result = await exportActivity({
        action: query.action,
        resourceType: query.resourceType,
      });
      const blob = new Blob([JSON.stringify(result.events, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cailyx-activity-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportNotice(
        `Exported ${result.events.length} event${result.events.length === 1 ? '' : 's'} for the current filters.`,
      );
    } catch (caught) {
      setError(toApiError(caught));
    }
  }

  const columns = useMemo<ReadonlyArray<ColumnDef<ActivityEvent>>>(
    () => [
      {
        key: 'createdAt',
        header: 'When',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.createdAt} />,
      },
      {
        key: 'actor',
        header: 'Actor',
        accessor: (row) => row.actorLabel ?? row.actorId ?? row.actorType,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate">
              {row.actorLabel ?? (
                <span className="text-muted-foreground">Name not recorded</span>
              )}
            </div>
            <div className="truncate text-meta text-muted-foreground">
              {/* The actor *type* is a fact in its own right: a scheduler is
                  not a person, and an unnamed system actor must not read as
                  one. */}
              {row.actorType}
              {row.actorId ? ` · ${row.actorId}` : ''}
            </div>
          </div>
        ),
        searchText: (row) => `${row.actorLabel ?? ''} ${row.actorId ?? ''} ${row.actorType}`,
      },
      {
        key: 'action',
        header: 'Action',
        accessor: (row) => row.action,
        sortable: true,
        width: 150,
        render: (row) => <span>{ACTION_LABEL[row.action] ?? row.action}</span>,
      },
      {
        key: 'resource',
        header: 'Resource',
        accessor: (row) => row.resourceType,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono text-meta">{row.resourceType}</div>
            <div className="truncate text-meta text-muted-foreground">
              {row.resourceId ?? 'No id recorded'}
              {row.resourceVersion ? ` · v${row.resourceVersion}` : ''}
            </div>
          </div>
        ),
        searchText: (row) => `${row.resourceType} ${row.resourceId ?? ''}`,
      },
      {
        key: 'scope',
        header: 'Client / project',
        accessor: (row) => row.clientId ?? row.projectId ?? '',
        render: (row) => (
          <div className="min-w-0 text-meta">
            <div className="truncate">{row.clientId ?? 'No client recorded'}</div>
            <div className="truncate text-muted-foreground">
              {row.projectId ?? 'No project recorded'}
            </div>
          </div>
        ),
        searchText: (row) => `${row.clientId ?? ''} ${row.projectId ?? ''}`,
      },
      {
        key: 'result',
        header: 'Result',
        accessor: (row) => row.result,
        sortable: true,
        width: 120,
        render: (row) => (
          <StatusPill
            label={row.result === 'success' ? 'Succeeded' : 'Failed'}
            tone={row.result === 'success' ? 'success' : 'danger'}
          />
        ),
      },
      {
        key: 'origin',
        header: 'Origin',
        accessor: (row) => row.origin,
        width: 110,
        defaultHidden: true,
        render: (row) => <span className="text-muted-foreground">{row.origin}</span>,
      },
      {
        key: 'clientVisible',
        header: 'Visible to client',
        accessor: (row) => (row.clientVisible ? 'yes' : 'no'),
        width: 140,
        defaultHidden: true,
        render: (row) => (
          <span className="text-muted-foreground">{row.clientVisible ? 'Yes' : 'Internal only'}</span>
        ),
      },
    ],
    [],
  );

  if (error?.kind === 'forbidden') {
    return (
      <div className="space-y-6">
        <PageHeader title="Activity history" />
        <EmptyState
          variant="insufficient-role"
          restrictedAction="read the organization audit log"
          permittedPath="A project's own activity history is visible to admins and delivery leads; ask one of them, or an administrator."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Activity history" />
        <ErrorState error={error} onRetry={() => void loadFirstPage()} />
      </div>
    );
  }

  if (isLoading && pages.length === 0) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity history"
        context="Every recorded action, newest first — including the ones that failed."
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void onExport()}>
            <Download aria-hidden="true" className="mr-2 h-4 w-4" />
            Export these filters
          </Button>
        }
      />

      {/*
        Stated rather than implied: this screen is read-only because the
        backend offers no write route, not because a control was left out.
      */}
      <Alert>
        <Info aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>This log is append-only</AlertTitle>
        <AlertDescription>
          Events are written by the code paths that perform the action, and there
          is no endpoint that edits or deletes one. Failures are shown alongside
          successes for the same reason. The export covers the current filters up
          to the server&rsquo;s 5,000-event cap — anything past it is omitted
          rather than silently truncated mid-set.
        </AlertDescription>
      </Alert>

      {exportNotice ? (
        <Alert>
          <AlertDescription>{exportNotice}</AlertDescription>
        </Alert>
      ) : null}

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        controls={[
          {
            kind: 'select',
            key: 'scope',
            label: 'Change class',
            options: [
              { value: 'security', label: 'Security and access' },
              { value: 'release', label: 'Release and approval' },
              {
                value: 'write',
                label: 'Records created, updated, deleted (budget policies included)',
              },
            ],
            allLabel: 'All changes',
          },
          {
            kind: 'select',
            key: 'action',
            label: 'Action',
            options: ACTIVITY_ACTIONS.map((action) => ({
              value: action,
              label: ACTION_LABEL[action],
            })),
            allLabel: 'All actions',
          },
          {
            kind: 'select',
            key: 'resourceType',
            label: 'Resource',
            options: resourceTypeOptions,
            allLabel: 'All resources',
          },
          {
            kind: 'select',
            key: 'result',
            label: 'Result',
            options: [
              { value: 'success', label: 'Succeeded' },
              { value: 'failure', label: 'Failed' },
            ],
            allLabel: 'Any result',
          },
        ]}
        summary={
          <>
            Page {pageIndex + 1} of {hasMore ? `${pages.length} loaded (more available)` : pages.length}
            {' · '}
            {visible.length} of {currentPage.length} on this page
          </>
        }
      />

      {/*
        The failure count is reported above the table, so a reader who filtered
        to successes can still see that failures exist on this page.
      */}
      {currentPage.some((event) => event.result === 'failure') ? (
        <Alert>
          <XCircle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>
            {currentPage.filter((event) => event.result === 'failure').length} failed action
            {currentPage.filter((event) => event.result === 'failure').length === 1 ? '' : 's'} on
            this page
          </AlertTitle>
          <AlertDescription>
            A failed action is recorded the same way a successful one is. Expand a
            row to read the actor, origin and request id the failure was logged
            against.
          </AlertDescription>
        </Alert>
      ) : null}

      <DataTable
        caption="Activity audit log"
        ariaLabel="Activity audit log"
        columns={columns}
        rows={visible}
        getRowId={(row) => row.id}
        minTableWidth="72rem"
        defaultSort={{ key: 'createdAt', direction: 'desc' }}
        pagination={{
          page: pageIndex + 1,
          // Only pages this screen has actually fetched are counted; the server
          // supplies a cursor, not a total, and a fabricated page count would be
          // worse than a short one.
          pageCount: pages.length + (hasMore ? 1 : 0),
          onPageChange: (page) => void onPageChange(page - 1),
          isFetching: isLoading,
        }}
        rowDetail={(row) => <ActivityDetail event={row} />}
        emptyState={
          loaded.length === 0 ? (
            // Nothing has been recorded at all. This is not a filtered list, so
            // "clear the filters" would send the reader looking for a control
            // that will not help.
            <EmptyState
              variant="not-measured"
              subject="activity events"
              prerequisite="Any operator action, scheduled run, or webhook delivery writes the first event."
            />
          ) : (
            <EmptyState variant="no-results" onClearFilters={() => setFilters(FILTER_DEFAULTS)} />
          )
        }
        isLoading={isLoading && pages.length === 0}
        onRetry={() => void loadFirstPage()}
      />
    </div>
  );
}

/**
 * The detail row: what was recorded, and the identifiers that let it be traced.
 * `changes` is already-redacted JSON written at record time; it renders as text,
 * never as markup (§10.5).
 */
function ActivityDetail({ event }: { event: ActivityEvent }) {
  const changeKeys = Object.keys(event.changes ?? {});
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-meta font-medium text-muted-foreground">Summary</h4>
        <p className="mt-1 text-table">
          {event.summary ?? 'No summary was recorded for this event.'}
        </p>
      </div>

      <div>
        <h4 className="text-meta font-medium text-muted-foreground">Recorded change</h4>
        {changeKeys.length === 0 ? (
          <p className="mt-1 text-table text-muted-foreground">
            No field-level change was recorded. That is not the same as &ldquo;nothing
            changed&rdquo; — it means this event carried no diff.
          </p>
        ) : (
          <dl className="mt-1 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {changeKeys.map((key) => (
              <div key={key}>
                <dt className="font-mono text-meta text-muted-foreground">{key}</dt>
                <dd className="text-table break-words">{formatChange(event.changes[key])}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-meta sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Event id</dt>
          <dd className="font-mono">{event.id}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Origin</dt>
          <dd>{event.origin}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Request id</dt>
          <dd className="font-mono">{event.requestId ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Job run id</dt>
          <dd className="font-mono">{event.jobRunId ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Client id</dt>
          <dd className="font-mono">{event.clientId ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Project id</dt>
          <dd className="font-mono">{event.projectId ?? 'Not recorded'}</dd>
        </div>
      </dl>
    </div>
  );
}

function formatChange(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'not recorded';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
