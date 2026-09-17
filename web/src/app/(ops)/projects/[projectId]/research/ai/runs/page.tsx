'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { listAeoAudits, type AuditRunSummary } from '@/services/research';

/**
 * AE01b — AI visibility run administration (staff).
 *
 * P13 (platform_improvement_plan.md §8.1) merged the former AE01 hub into the
 * client-facing "AI visibility" screen at `/research/ai`, which now serves
 * Summary / Customer questions / History from one composed read. §8.1 is
 * explicit that "raw run administration remains staff detail" rather than the
 * main view — this is that detail: the full list of every `AeoAudit` row,
 * including in-flight and failed ones the composed read does not surface.
 *
 * Two things are deliberate, carried over from the pre-merge hub:
 *
 *  1. **Nothing runs on load.** The page reads. Starting a run happens on
 *     `/research/ai/new`, where its engines, repeats and credit estimate can be
 *     shown before anyone commits to spending (§10.4's scan/generation row).
 *  2. **No rates are computed here.** The headline metric in this package is a
 *     *rate over counted answers* with a coverage denominator, not a position.
 *     This list does not have the observation counts, so it shows the run's
 *     stored score and links out rather than deriving a percentage from
 *     something it cannot see.
 */
export default function AiVisibilityRunsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [runs, setRuns] = useState<AuditRunSummary[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await listAeoAudits(projectId, { signal });
        setRuns(result.audits);
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

  const columns: ReadonlyArray<ColumnDef<AuditRunSummary>> = [
    {
      key: 'createdAt',
      header: 'Run',
      accessor: (row) => row.createdAt ?? '',
      sortable: true,
      width: 200,
      render: (row) =>
        row.createdAt ? <Timestamp value={row.createdAt} /> : <span className="text-muted-foreground">Time not recorded</span>,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 140,
      render: (row) => <StatusPill label={row.status} tone={runTone(row.status)} />,
    },
    {
      key: 'score',
      header: 'Score',
      accessor: (row) => row.score,
      sortable: true,
      align: 'right',
      width: 100,
      // §3.5 — an unscored run is not a zero score.
      emptyLabel: 'Not scored',
      render: (row) =>
        typeof row.score === 'number' ? (
          <span className="font-semibold tabular-nums">{row.score}</span>
        ) : null,
    },
    {
      key: 'band',
      header: 'Band',
      accessor: (row) => row.band,
      width: 130,
      emptyLabel: '—',
    },
    {
      key: 'open',
      header: '',
      width: 100,
      alwaysVisible: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/research/ai/runs/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open run
        </a>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI visibility runs (staff)" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!runs) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const incomplete = runs.filter(
    (run) => run.status !== 'completed' && run.status !== 'failed',
  );

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: 'This project', mode: 'live' }} />

      <PageHeader
        breadcrumbs={[{ label: 'AI visibility', href: `/projects/${projectId}/research/ai` }, { label: 'Runs (staff)' }]}
        title="AI visibility runs (staff)"
        context={`${runs.length} run${runs.length === 1 ? '' : 's'} on file — raw run administration; clients see the composed Summary/Customer questions/History views at AI visibility.`}
        primaryAction={{ label: 'Run setup', href: `/projects/${projectId}/research/ai/new` }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {incomplete.length > 0 ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>{incomplete.length} run did not complete</AlertTitle>
          <AlertDescription>
            Its partial evidence is still readable. A run that answered only some
            of its prompts reports thin coverage, and no significance is claimed
            from it.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Runs</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {runs.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="AI visibility"
              prerequisite="An AEO run needs an approved prompt set and a configured engine."
              action={{
                label: 'Set up the first run',
                href: `/projects/${projectId}/research/ai/new`,
              }}
            />
          ) : (
            <DataTable
              caption="AI visibility runs"
              columns={columns}
              rows={runs}
              getRowId={(row) => row.id}
              defaultSort={{ key: 'createdAt', direction: 'desc' }}
              filters={[
                {
                  id: 'status',
                  label: 'Status',
                  options: [
                    { value: 'completed', label: 'Completed' },
                    { value: 'partial', label: 'Partial' },
                    { value: 'failed', label: 'Failed' },
                  ],
                  getValue: (row) => row.status,
                },
              ]}
              emptyState={<EmptyState variant="no-results" />}
            />
          )}
        </CardContent>
      </Card>

      <p className="text-meta text-muted-foreground">
        Rates shown in a run are counted over answers that actually came back.
        A run with few successful answers reports its coverage and makes no
        claim of significance.
      </p>
    </div>
  );
}

/** Local tone map for the audit statuses this endpoint actually returns. */
function runTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'unmeasured' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    case 'queued':
    case 'pending':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}
