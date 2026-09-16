'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { clientStatusLabel, clientStatusTone } from '@/lib/status-tones';
import { listClients } from '@/services/clients';
import type { ClientSummary } from '@/services/types';

/**
 * OP02 — Clients.
 *
 * design_plan.md §4.2: a "searchable client table, status, owner, project
 * count, score provenance". The layout family (§4) calls for "title/action,
 * summary strip, filter bar, sortable table; selected row opens routed detail;
 * retain search/filter/scroll on return".
 *
 * One warning is carried into the column definition below. This list's score
 * is the **highest latest project score**, not an aggregate health score —
 * G14 (line 1683) requires it be labelled as such, so the column header says
 * so rather than showing an unqualified "Score".
 *
 * Filtering here is local over the rows the server returned. G14 adds server
 * pagination and filters; until this deployment answers on that contract,
 * §10.5 applies: "local filters cover only returned records; no fabricated
 * global totals." The count shown is therefore the number of loaded rows, and
 * it is labelled as such.
 */

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      setClients(await listClients({ signal }));
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

  const columns = useMemo<ReadonlyArray<ColumnDef<ClientSummary>>>(
    () => [
      {
        key: 'name',
        header: 'Client',
        accessor: (row) => row.name,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.name}</div>
            {row.contactEmail ? (
              <div className="truncate text-meta text-muted-foreground">{row.contactEmail}</div>
            ) : null}
          </div>
        ),
        searchText: (row) => `${row.name} ${row.contactName ?? ''} ${row.contactEmail ?? ''}`,
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        sortable: true,
        width: 120,
        render: (row) => (
          <StatusPill label={clientStatusLabel(row.status)} tone={clientStatusTone(row.status)} />
        ),
      },
      {
        key: 'projects',
        header: 'Projects',
        accessor: (row) => row.projectCount,
        sortable: true,
        align: 'right',
        width: 100,
      },
      {
        key: 'score',
        // Labelled honestly: this is a project score, not client health.
        header: 'Highest project score',
        accessor: (row) => row.latestScore,
        sortable: true,
        align: 'right',
        width: 170,
        sortValue: (row) => row.latestScore,
        // The accessor returning null renders the §3.5 "not measured" label
        // via DataTable's own default, rather than a 0 that reads as a score.
        emptyLabel: 'Not measured',
        render: (row) =>
          typeof row.latestScore === 'number' ? (
            <span className="font-semibold tabular-nums">{row.latestScore}</span>
          ) : null,
      },
      {
        key: 'owner',
        header: 'Owner',
        accessor: (row) => row.ownerUserId,
        width: 130,
        render: (row) =>
          row.ownerUserId ? (
            <span className="text-muted-foreground">Assigned</span>
          ) : (
            // §3.5 — an unassigned client is actionable, not blank.
            <span className="text-muted-foreground">No owner</span>
          ),
      },
      {
        key: 'createdAt',
        header: 'Client since',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 150,
        defaultHidden: true,
        render: (row) => <Timestamp value={row.createdAt} dateOnly />,
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Clients" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!clients) {
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
        title="Clients"
        context={
          clients.length === 0
            ? 'No clients yet.'
            : `${clients.length} client${clients.length === 1 ? '' : 's'}.`
        }
        primaryAction={{
          label: 'Add client',
          href: '/ops/clients/new',
          icon: <Plus aria-hidden="true" className="mr-2 h-4 w-4" />,
        }}
      />

      {clients.length === 0 ? (
        <EmptyState
          variant="no-projects"
          audience="operator"
          onCreate={() => {
            window.location.href = '/ops/clients/new';
          }}
        />
      ) : (
        <DataTable
          caption="Clients"
          columns={columns}
          rows={clients}
          getRowId={(row) => row.id}
          searchable
          searchPlaceholder="Search clients…"
          rowHref={(row) => `/ops/clients/${row.id}`}
          linkColumnKey="name"
          defaultSort={{ key: 'name', direction: 'asc' }}
          filters={[
            {
              id: 'status',
              label: 'Status',
              options: [
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
                { value: 'churned', label: 'Churned' },
              ],
              getValue: (row) => row.status,
            },
          ]}
          emptyState={<EmptyState variant="no-results" />}
        />
      )}
    </div>
  );
}
