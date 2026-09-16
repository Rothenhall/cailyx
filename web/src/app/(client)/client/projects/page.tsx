'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { ArrowRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import { onboardingStatusTone } from '@/lib/status-tones';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';

/**
 * CP02 — My projects.
 *
 * design_plan.md §4.5: *"Own domains, onboarding stage, latest report
 * score/date, select."*
 *
 * Four things this page is careful about:
 *
 *  1. **"Own" is the server's word, not this page's.** `/api/portal/projects`
 *     filters on the session's `clientId`, so there is nothing here to filter
 *     wrongly and no client selector to get wrong (§2.3: "Client navigation
 *     never contains an all-clients selector").
 *  2. **The date column is the latest *report* date.** The API field is named
 *     `lastAuditAt`, but it is set from `Report.createdAt` — §4.5 flags this
 *     explicitly. Printing it as "Last audit" would claim an audit happened
 *     when what happened was a report.
 *  3. **A project with no report shows no score**, never `0`. The backend sends
 *     `latestScore: null` and `DataTable` renders a null accessor as
 *     "Not measured yet" (§3.5).
 *  4. **Onboarding is not engagement status.** `onboardingStatus` is the day-1
 *     pipeline's progress and is orthogonal to the service the client bought;
 *     this screen only has the former to show, so it says only that.
 *
 * The filters live in the URL (§3.2), so a copied link reproduces the view.
 */
const FILTER_DEFAULTS = {
  q: '',
  setup: FILTER_ALL,
  report: FILTER_ALL,
};

const SETUP_OPTIONS = [
  { value: 'completed', label: 'Setup complete' },
  { value: 'running', label: 'Setup running' },
  { value: 'pending', label: 'Setup not started' },
  { value: 'failed', label: 'Setup stopped' },
];

const REPORT_OPTIONS = [
  { value: 'scored', label: 'Has a reported score' },
  { value: 'none', label: 'No report yet' },
];

const COLUMNS: ColumnDef<PortalProjectSummary>[] = [
  {
    key: 'name',
    header: 'Project',
    accessor: (row) => row.name,
    sortable: true,
    render: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: 'domain',
    header: 'Domain',
    accessor: (row) => row.domain,
    sortable: true,
    render: (row) => <span className="font-mono text-meta">{row.domain}</span>,
  },
  {
    key: 'setup',
    header: 'Setup',
    accessor: (row) => row.onboardingStatus ?? '',
    sortable: true,
    render: (row) => (
      <span className="flex items-center gap-2">
        <StatusPill
          label={setupLabel(row)}
          tone={row.onboardingStatus ? onboardingStatusTone(row.onboardingStatus) : 'unmeasured'}
        />
        {row.onboardingStep ? (
          <span className="text-meta text-muted-foreground">{row.onboardingStep}</span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'latestScore',
    header: 'Latest report score',
    accessor: (row) => row.latestScore,
    sortable: true,
    align: 'right',
    // A null accessor renders "Not measured yet" — never 0 (§3.5).
    render: (row) =>
      typeof row.latestScore === 'number' ? (
        <span className="tabular-nums">
          {formatNumber(row.latestScore)}
          {row.latestBand ? (
            <span className="ml-2 text-meta text-muted-foreground">{row.latestBand}</span>
          ) : null}
        </span>
      ) : (
        <span className="text-meta text-unmeasured-foreground">Not measured yet</span>
      ),
    sortValue: (row) => row.latestScore,
  },
  {
    key: 'reportedAt',
    // Named for what the timestamp is. See the note at the top of this file.
    header: 'Latest report',
    accessor: (row) => row.lastAuditAt,
    sortable: true,
    emptyLabel: 'No report yet',
    render: (row) =>
      row.lastAuditAt ? (
        <Timestamp value={row.lastAuditAt} dateOnly />
      ) : (
        <span className="text-meta text-muted-foreground">No report yet</span>
      ),
    sortValue: (row) => row.lastAuditAt,
  },
  {
    key: 'open',
    header: 'Open',
    alwaysVisible: true,
    render: (row) => (
      <Link
        href={`/client/projects/${row.id}`}
        className="inline-flex items-center gap-1 text-table text-primary underline-offset-4 hover:underline"
      >
        Select
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
      </Link>
    ),
  },
];

export default function ClientProjectsPage() {
  // `useSearchParams` (through `useUrlState`) forces a client-side bailout
  // during prerendering, so the URL-reading part sits behind its own boundary.
  return (
    <Suspense fallback={<ProjectsSkeleton />}>
      <ProjectsScreen />
    </Suspense>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-12 rounded-lg" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function ProjectsScreen() {
  const [projects, setProjects] = useState<PortalProjectSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      setProjects(await listPortalProjectSummaries({ signal }));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rows = useMemo(() => {
    if (!projects) return [];
    const query = filters.q.trim().toLowerCase();
    return projects.filter((project) => {
      if (query) {
        const haystack = `${project.name} ${project.domain}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (filters.setup !== FILTER_ALL && project.onboardingStatus !== filters.setup) return false;
      if (filters.report === 'scored' && typeof project.latestScore !== 'number') return false;
      if (filters.report === 'none' && typeof project.latestScore === 'number') return false;
      return true;
    });
  }, [projects, filters]);

  const isFiltered =
    filters.q.trim() !== '' ||
    filters.setup !== FILTER_DEFAULTS.setup ||
    filters.report !== FILTER_DEFAULTS.report;

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Your projects" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!projects) {
    return <ProjectsSkeleton />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your projects"
        context={
          projects.length === 0
            ? 'Websites we are measuring for you.'
            : `${projects.length} project${projects.length === 1 ? '' : 's'} · each with its own domain and reporting.`
        }
      />

      {projects.length === 0 ? (
        // §3.5 — the client variant of this state names who to ask, because a
        // client cannot create a project.
        <EmptyState variant="no-projects" audience="client" />
      ) : (
        <>
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            controls={[
              { kind: 'select', key: 'setup', label: 'Setup', options: SETUP_OPTIONS, allLabel: 'Any setup state' },
              { kind: 'select', key: 'report', label: 'Reporting', options: REPORT_OPTIONS, allLabel: 'Any reporting' },
            ]}
            searchPlaceholder="Search by name or domain"
            summary={
              isFiltered ? `Showing ${rows.length} of ${projects.length}` : `Showing all ${projects.length}`
            }
          />

          <DataTable
            columns={COLUMNS}
            rows={rows}
            getRowId={(row) => row.id}
            caption="Your projects, with domain, setup state and latest report"
            rowHref={(row) => `/client/projects/${row.id}`}
            linkColumnKey="name"
            emptyState={
              isFiltered ? (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() =>
                    setFilters({ q: '', setup: FILTER_ALL, report: FILTER_ALL })
                  }
                />
              ) : (
                <EmptyState variant="no-projects" audience="client" />
              )
            }
            minTableWidth="52rem"
          />

          <p className="text-meta text-muted-foreground">
            A project with no report yet has no score — that is not a score of
            zero. Scores appear once a report has been generated for it.
          </p>
        </>
      )}
    </div>
  );
}

function setupLabel(project: PortalProjectSummary): string {
  switch (project.onboardingStatus) {
    case 'completed':
      return 'Setup complete';
    case 'running':
      return 'Setting up';
    case 'failed':
      return 'Setup stopped';
    case 'pending':
      return 'Setup not started';
    default:
      return 'Setup state not reported';
  }
}
