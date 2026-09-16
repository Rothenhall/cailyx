'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { reportStatusLabel, reportStatusTone } from '@/lib/status-tones';
import { getReportCenter, type ReportRow } from '@/services/operations';

/**
 * OP14 — Report center.
 *
 * design_plan.md §4.2: "Cross-client report list, pending QA/release, due
 * reports, delivery."
 *
 * Two columns here are deliberately separate and must stay that way:
 *
 *   - **`status`** is the editorial state (draft → in-review → approved →
 *     released). It answers "is this safe to send?".
 *   - **`visibility`** is whether a public link exists. It answers "can anyone
 *     with the URL read this?" — a different question entirely.
 *
 * design_plan G05 requires those not be conflated, and specifically warns
 * against reusing `visibility` as a QA state. Showing them as two columns is
 * how that rule survives contact with a screen.
 *
 * This reads `GET /operations/reports`, which is server-paginated and scoped
 * to the caller's assignments. G14 exists so this does not fan out per client.
 */
export default function ReportCenterPage() {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const page = await getReportCenter({ pageSize: 100 }, { signal });
      setRows(page.items);
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

  const columns = useMemo<ReadonlyArray<ColumnDef<ReportRow>>>(
    () => [
      {
        key: 'title',
        header: 'Report',
        accessor: (row) => row.title,
        sortable: true,
        render: (row) => <div className="truncate font-medium">{row.title}</div>,
      },
      {
        key: 'client',
        header: 'Client',
        accessor: (row) => row.clientName,
        sortable: true,
        width: 170,
        emptyLabel: 'No client',
        render: (row) =>
          row.clientName ? (
            <div className="min-w-0">
              <div className="truncate">{row.clientName}</div>
              <div className="truncate text-meta text-muted-foreground">{row.projectName}</div>
            </div>
          ) : null,
        searchText: (row) => `${row.title} ${row.clientName ?? ''} ${row.projectName}`,
      },
      {
        key: 'status',
        header: 'Editorial state',
        accessor: (row) => row.status,
        sortable: true,
        width: 140,
        render: (row) => (
          <StatusPill label={reportStatusLabel(row.status)} tone={reportStatusTone(row.status)} />
        ),
      },
      {
        key: 'visibility',
        header: 'Public link',
        accessor: (row) => row.visibility,
        width: 120,
        render: (row) =>
          row.visibility === 'public' ? (
            <StatusPill label="Anyone with link" tone="warning" />
          ) : (
            <span className="text-meta text-muted-foreground">Private</span>
          ),
      },
      {
        key: 'score',
        header: 'Score',
        accessor: (row) => row.scoreTotal,
        sortable: true,
        align: 'right',
        width: 90,
        render: (row) => <span className="font-semibold tabular-nums">{row.scoreTotal}</span>,
      },
      {
        key: 'releasedAt',
        header: 'Released',
        accessor: (row) => row.releasedAt,
        sortable: true,
        width: 150,
        emptyLabel: 'Not released',
        render: (row) =>
          row.releasedAt ? <Timestamp value={row.releasedAt} dateOnly /> : null,
      },
      {
        key: 'createdAt',
        header: 'Created',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 150,
        defaultHidden: true,
        render: (row) => <Timestamp value={row.createdAt} dateOnly />,
      },
      {
        key: 'open',
        header: '',
        width: 90,
        alwaysVisible: true,
        render: (row) => (
          <Link
            href={`/reports/${row.slug}`}
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open
          </Link>
        ),
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const pendingRelease = rows.filter(
    (row) => row.status !== 'released' && row.status !== 'withdrawn',
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        context={
          rows.length === 0
            ? 'No reports yet.'
            : pendingRelease > 0
              ? `${rows.length} reports · ${pendingRelease} not yet released`
              : `${rows.length} reports, all released.`
        }
      />

      {rows.length === 0 ? (
        <EmptyState variant="no-reports" runExists={false} />
      ) : (
        <DataTable
          caption="Report center"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          searchable
          searchPlaceholder="Search reports…"
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          filters={[
            {
              id: 'status',
              label: 'Editorial state',
              options: [
                { value: 'draft', label: 'Draft' },
                { value: 'in-review', label: 'In review' },
                { value: 'approved', label: 'Approved' },
                { value: 'released', label: 'Released' },
                { value: 'withdrawn', label: 'Withdrawn' },
              ],
              getValue: (row) => row.status,
            },
            {
              id: 'visibility',
              label: 'Public link',
              options: [
                { value: 'private', label: 'Private' },
                { value: 'public', label: 'Anyone with link' },
              ],
              getValue: (row) => row.visibility,
            },
          ]}
          emptyState={<EmptyState variant="no-results" />}
        />
      )}
    </div>
  );
}
