'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { reportStatusLabel, reportStatusTone } from '@/lib/status-tones';
import { getProject } from '@/services/projects';
import {
  coverageFromManifest,
  listEvidenceManifests,
  listProjectReportRows,
  type EvidenceManifestView,
  type ReportLibraryRow,
} from '@/services/reports';

/**
 * RP01 — Report library.
 *
 * design_plan.md §4.4: *"Title/date/score/coverage/public sharing, open,
 * generate; target type/period/review states"*, in the portfolio/library
 * layout family (§4): title/action, summary strip, filter bar, sortable table,
 * selected row opens routed detail, destructive actions in a row menu.
 *
 * Two things this screen is careful about:
 *
 *  1. **Editorial state and public sharing are two columns, never one.**
 *     §6.4 and RP04's own row say it: `visibility: public` is not a QA state.
 *     A report can be released to its client with no public link, and a draft
 *     can carry one. Merging them into a single "status" column is the exact
 *     mistake G05 exists to prevent, so they are read from two separate fields
 *     and rendered in two separate columns.
 *
 *  2. **Coverage is per-report, and it comes from the pinned manifest.** The
 *     list route does not carry coverage, and inventing it from a score would
 *     be a fabricated completeness claim. Each report's evidence manifest
 *     records the expected/succeeded/failed/pending counts for the sources it
 *     actually drew on, so coverage is rendered from that — and a report whose
 *     manifest was never pinned says so explicitly rather than showing 100%.
 *
 * Filters live in the URL, so a copied link reproduces the view.
 */
export default function ReportLibraryPage() {
  // `useSearchParams` forces a client-side bailout during prerendering, so the
  // URL-reading part sits behind its own boundary (same shape as AU01).
  return (
    <Suspense fallback={<ReportLibrarySkeleton />}>
      <ReportLibrary />
    </Suspense>
  );
}

/** Must be a stable reference: it is what tells the chips what "filtered" means. */
const FILTER_DEFAULTS = { q: '', state: FILTER_ALL, link: FILTER_ALL };

const STATE_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'in-review', label: 'In review' },
  { value: 'approved', label: 'Approved' },
  { value: 'released', label: 'Released' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const LINK_OPTIONS = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Anyone with link' },
];

function ReportLibrary() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const [rows, setRows] = useState<ReportLibraryRow[] | null>(null);
  const [manifests, setManifests] = useState<EvidenceManifestView[] | null>(null);
  const [project, setProject] = useState<{ name: string; domain: string } | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [reportRows, manifestRows, detail] = await Promise.all([
          listProjectReportRows(projectId, { signal }),
          listEvidenceManifests(projectId, { subjectType: 'report', limit: 100 }, { signal }),
          getProject(projectId, { signal }),
        ]);
        setRows(reportRows);
        setManifests(manifestRows);
        setProject({ name: detail.name, domain: detail.domain });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** The manifest a report pinned, if it managed to pin one. */
  const manifestByReport = useMemo(() => {
    const map = new Map<string, EvidenceManifestView>();
    for (const manifest of manifests ?? []) {
      if (manifest.subjectType !== 'report' || !manifest.subjectId) continue;
      // Newest first from the server, so the first one seen for a report wins.
      if (!map.has(manifest.subjectId)) map.set(manifest.subjectId, manifest);
    }
    return map;
  }, [manifests]);

  const filtered = useMemo(() => {
    const query = filters.q.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      if (filters.state !== FILTER_ALL && row.status !== filters.state) return false;
      if (filters.link !== FILTER_ALL && row.visibility !== filters.link) return false;
      if (!query) return true;
      return (
        row.title.toLowerCase().includes(query) || row.slug.toLowerCase().includes(query)
      );
    });
  }, [rows, filters]);

  const filtersActive =
    filters.q !== FILTER_DEFAULTS.q ||
    filters.state !== FILTER_DEFAULTS.state ||
    filters.link !== FILTER_DEFAULTS.link;

  const columns = useMemo<ReadonlyArray<ColumnDef<ReportLibraryRow>>>(
    () => [
      {
        key: 'title',
        header: 'Report',
        accessor: (row) => row.title,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.title}</div>
            <div className="truncate font-mono text-meta text-muted-foreground">{row.slug}</div>
          </div>
        ),
      },
      {
        key: 'createdAt',
        header: 'Prepared',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 150,
        render: (row) => <Timestamp value={row.createdAt} dateOnly />,
      },
      {
        key: 'scoreTotal',
        header: 'Score',
        accessor: (row) => row.scoreTotal,
        sortable: true,
        align: 'right',
        width: 150,
        render: (row) => (
          <div className="flex items-center justify-end gap-2">
            <span className="font-semibold tabular-nums">{row.scoreTotal}</span>
            <span className="text-meta text-muted-foreground">{row.scoreBand}</span>
          </div>
        ),
      },
      {
        key: 'coverage',
        header: 'Evidence coverage',
        width: 260,
        // Not sortable: it is a coverage summary, not a scalar, and sorting a
        // completeness figure next to a score invites reading it as one.
        render: (row) => {
          const manifest = manifestByReport.get(row.id);
          const summary = coverageFromManifest(manifest ?? null);
          if (!summary) {
            return (
              <div className="text-meta text-muted-foreground">
                Coverage not recorded for this snapshot.
                <div className="mt-0.5">
                  No evidence manifest is pinned, so how much of the agreed evidence
                  returned is unknown — not zero.
                </div>
              </div>
            );
          }
          return <CoveragePanel summary={summary} variant="compact" />;
        },
        searchText: (row) => {
          const summary = coverageFromManifest(manifestByReport.get(row.id) ?? null);
          if (!summary) return 'coverage not recorded';
          return `${summary.successfulCount}/${summary.expectedCount} sources`;
        },
      },
      {
        key: 'status',
        header: 'Editorial state',
        accessor: (row) => row.status,
        sortable: true,
        width: 150,
        render: (row) => (
          <div className="space-y-1">
            <StatusPill label={reportStatusLabel(row.status)} tone={reportStatusTone(row.status)} />
            <div className="text-meta text-muted-foreground">
              {row.releasedAt ? (
                <>
                  Released <Timestamp value={row.releasedAt} dateOnly />
                </>
              ) : (
                'Never released'
              )}
            </div>
          </div>
        ),
        emptyLabel: 'No editorial state recorded',
      },
      {
        key: 'visibility',
        header: 'Public link',
        accessor: (row) => row.visibility,
        sortable: true,
        width: 150,
        render: (row) =>
          row.visibility === 'public' ? (
            <div className="space-y-1">
              <StatusPill label="Anyone with link" tone="warning" />
              <div className="text-meta text-muted-foreground">
                No sign-in required to read it.
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <StatusPill label="Private" tone="neutral" />
              <div className="text-meta text-muted-foreground">No public URL exists.</div>
            </div>
          ),
      },
      {
        key: 'open',
        header: '',
        width: 80,
        alwaysVisible: true,
        render: (row) => (
          <Link
            href={`/projects/${projectId}/reports/${row.slug}`}
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open
          </Link>
        ),
      },
    ],
    [manifestByReport, projectId],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!rows || !manifests || !project) return <ReportLibrarySkeleton />;

  const publicCount = rows.filter((row) => row.visibility === 'public').length;
  const unreleasedCount = rows.filter(
    (row) => row.status !== 'released' && row.status !== 'withdrawn',
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: project.name, href: `/projects/${projectId}` },
          { label: 'Reports' },
        ]}
        title="Reports"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{project.domain}</span>
            <span className="text-meta text-muted-foreground">
              Each report is a frozen snapshot of the runs that existed when it was
              prepared. Later runs do not change it.
            </span>
          </span>
        }
        // One primary action (§3.2). "Generate" is where the decision is made,
        // and it leads to RP02 rather than firing from this list.
        primaryAction={{
          label: 'Prepare a report',
          href: `/projects/${projectId}/reports/new`,
        }}
      />

      {/* Summary strip. Counts are of the rows this screen loaded, and say so. */}
      {rows.length > 0 ? (
        <p className="text-table text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'report' : 'reports'} in this library ·{' '}
          {unreleasedCount} not released to the client · {publicCount} with a public link.
          {' '}
          Counts cover the loaded page, not the whole portfolio.
        </p>
      ) : null}

      {rows.length === 0 ? (
        // `runExists: false` — this library has no evidence that a report is
        // being prepared, and generation is synchronous, so there is no
        // in-flight state for this screen to be waiting on. §3.5 forbids the
        // "your first report is being prepared" wording without a run.
        <EmptyState
          variant="no-reports"
          runExists={false}
          action={{
            label: 'Prepare a report',
            href: `/projects/${projectId}/reports/new`,
          }}
        />
      ) : (
        <>
          <FilterBar
            defaults={FILTER_DEFAULTS}
            value={filters}
            onChange={setFilters}
            controls={[
              { kind: 'select', key: 'state', label: 'Editorial state', options: STATE_OPTIONS },
              { kind: 'select', key: 'link', label: 'Public link', options: LINK_OPTIONS },
            ]}
            searchLabel="Search reports"
            searchPlaceholder="Search by title or slug…"
            summary={
              filtersActive
                ? `Showing ${filtered.length} of ${rows.length} loaded reports`
                : `${rows.length} reports`
            }
          />

          <DataTable
            caption="Report library"
            columns={columns}
            rows={filtered}
            getRowId={(row) => row.id}
            rowHref={(row) => `/projects/${projectId}/reports/${row.slug}`}
            linkColumnKey="title"
            defaultSort={{ key: 'createdAt', direction: 'desc' }}
            pageSize={25}
            minTableWidth="72rem"
            // Search lives in the FilterBar so the query is part of the copied
            // link; a second search box here would filter the same rows twice.
            searchable={false}
            emptyState={
              filtersActive ? (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() => setFilters(FILTER_DEFAULTS)}
                />
              ) : (
                <EmptyState variant="no-reports" runExists={false} />
              )
            }
          />
        </>
      )}

      <p className="text-meta text-muted-foreground">
        Preparing a report is a generation, not a preview: it scores the project
        again, snapshots whatever evidence exists at that moment, and records the
        result. It is also not editorial review — a new report is private and
        readable by the client&apos;s portal, and the G05 review states
        (draft → in review → approved → released) are shown here when the backend
        records them.
      </p>
    </div>
  );
}

function ReportLibrarySkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-5 w-96" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
