'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { projectStatusLabel, projectStatusTone } from '@/lib/status-tones';
import { listProjects } from '@/services/projects';
import type { ProjectSummary } from '@/services/types';

/**
 * OP10 — All projects.
 *
 * design_plan.md §4.2: "Name/domain/lifecycle search, client link, artifacts,
 * archived projects."
 *
 * Archived projects are included rather than hidden, and are filterable —
 * §4.2 lists them as a column concern, and silently excluding them is how a
 * project appears to have vanished. The `archived` status is toned
 * `unmeasured` rather than `danger`: keeping a finished engagement on file is
 * not a failure.
 *
 * Note this screen lists a **bare array** from `GET /projects`, unlike the
 * clients list which is wrapped. That difference is normalized in the service
 * adapter rather than here.
 */
export default function AllProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      setProjects(await listProjects(undefined, { signal }));
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

  const columns = useMemo<ReadonlyArray<ColumnDef<ProjectSummary>>>(
    () => [
      {
        key: 'name',
        header: 'Project',
        accessor: (row) => row.name,
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.name}</div>
            <div className="truncate font-mono text-meta text-muted-foreground">{row.domain}</div>
          </div>
        ),
        searchText: (row) => `${row.name} ${row.domain}`,
      },
      {
        key: 'status',
        header: 'Lifecycle',
        accessor: (row) => row.status,
        sortable: true,
        width: 130,
        render: (row) => (
          <StatusPill
            label={projectStatusLabel(row.status)}
            tone={projectStatusTone(row.status)}
          />
        ),
      },
      {
        key: 'setup',
        header: 'Setup',
        accessor: (row) => row.onboardingStatus ?? 'pending',
        width: 170,
        render: (row) => {
          const status = row.onboardingStatus ?? 'pending';
          if (status === 'completed') {
            return <StatusPill label="Ready" tone="success" />;
          }
          if (status === 'failed') {
            return <StatusPill label="Setup failed" tone="danger" />;
          }
          if (status === 'running') {
            return (
              <StatusPill
                label={`Setting up${row.onboardingStep ? `: ${row.onboardingStep}` : ''}`}
                tone="info"
              />
            );
          }
          // Not started is a neutral fact, not a warning — §3.5 keeps an
          // outstanding prerequisite distinct from a failure.
          return <StatusPill label="Not started" tone="unmeasured" />;
        },
      },
      {
        key: 'score',
        header: 'Score',
        accessor: (row) => row.score,
        sortable: true,
        align: 'right',
        width: 100,
        sortValue: (row) => row.score,
        emptyLabel: 'Not measured',
        render: (row) =>
          typeof row.score === 'number' ? (
            <span className="font-semibold tabular-nums">{row.score}</span>
          ) : null,
      },
      {
        key: 'client',
        header: 'Client',
        accessor: (row) => row.clientId,
        width: 140,
        render: (row) =>
          row.clientId ? (
            <Link
              href={`/ops/clients/${row.clientId}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              View client
            </Link>
          ) : (
            // Projects created outside the client orchestrator have no client.
            // That is a real state, not a blank cell.
            <span className="text-muted-foreground">Not attached</span>
          ),
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Projects" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!projects) {
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
        title="Projects"
        context={
          projects.length === 0
            ? 'No projects yet.'
            : `${projects.length} project${projects.length === 1 ? '' : 's'}.`
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          variant="no-projects"
          audience="operator"
          onCreate={() => {
            window.location.href = '/ops/clients';
          }}
        />
      ) : (
        <DataTable
          caption="All projects"
          columns={columns}
          rows={projects}
          getRowId={(row) => row.id}
          searchable
          searchPlaceholder="Search by name or domain…"
          rowHref={(row) => `/projects/${row.id}`}
          linkColumnKey="name"
          defaultSort={{ key: 'name', direction: 'asc' }}
          filters={[
            {
              id: 'status',
              label: 'Lifecycle',
              options: [
                { value: 'scorecard', label: 'Scorecard' },
                { value: 'diagnostic', label: 'Diagnostic' },
                { value: 'sprint', label: 'Sprint' },
                { value: 'retainer', label: 'Retainer' },
                { value: 'archived', label: 'Archived' },
              ],
              getValue: (row) => row.status,
            },
            {
              id: 'setup',
              label: 'Setup',
              options: [
                { value: 'completed', label: 'Ready' },
                { value: 'running', label: 'Running' },
                { value: 'pending', label: 'Not started' },
                { value: 'failed', label: 'Failed' },
              ],
              getValue: (row) => row.onboardingStatus ?? 'pending',
            },
          ]}
          emptyState={<EmptyState variant="no-results" />}
        />
      )}
    </div>
  );
}
