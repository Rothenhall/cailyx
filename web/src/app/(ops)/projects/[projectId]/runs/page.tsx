'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunStatusStrip } from '@/components/patterns/RunStatusStrip';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatCredits, formatCurrency } from '@/lib/format';
import { cancelRun, listRuns, retryRun, type JobRun } from '@/services/jobs';

/**
 * PJ11 — Run center.
 *
 * design_plan.md §4.3: "Audits/research by status/provider/time, in-flight
 * details, cost a…" and §3.3's run status strip.
 *
 * Three rules drive this page, all from §10.3/§10.4:
 *
 *  1. **Partial is a first-class outcome.** A run where 3 of 5 engines answered
 *     shows its real coverage rather than a green "completed". The backend
 *     computes `coverage`; this page renders it through `CoveragePanel` so a
 *     failed source is always named with its reason.
 *  2. **Actions are server-computed.** `run.actions.canRetry` /
 *     `canCancel` and their blocked reasons come from the server, because only
 *     it knows what the run has already spent. The buttons never guess.
 *  3. **Cancelling is honest.** The confirmation names what the run has already
 *     cost and states that the spend is not returned.
 *
 * Costs are shown in two separate units. `costUsd` and `costCredits` are never
 * summed, per §6.3 — credits are a provider unit, not currency.
 */
export default function RunCenterPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setRuns(await listRuns(projectId, { limit: 100 }, { signal }));
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

  async function onRetry(run: JobRun) {
    setBusyRunId(run.id);
    setActionError(null);
    try {
      await retryRun(projectId, run.id);
      await load();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The retry could not be started.',
      );
    } finally {
      setBusyRunId(null);
    }
  }

  async function onCancel(run: JobRun) {
    setBusyRunId(run.id);
    setActionError(null);
    try {
      await cancelRun(projectId, run.id);
      await load();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The run could not be cancelled.',
      );
    } finally {
      setBusyRunId(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Runs" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!runs) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  const active = runs.filter((run) => run.status === 'running' || run.status === 'queued');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        context={
          runs.length === 0
            ? 'Nothing has run for this project yet.'
            : [
                `${runs.length} run${runs.length === 1 ? '' : 's'}`,
                active.length > 0 ? `${active.length} in flight` : null,
              ]
                .filter(Boolean)
                .join(' · ')
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="background runs"
          prerequisite="Starting an audit or research run from its own screen creates the first one."
        />
      ) : (
        <div className="space-y-4">
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              busy={busyRunId === run.id}
              onRetry={() => void onRetry(run)}
              onCancel={() => void onCancel(run)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  busy,
  onRetry,
  onCancel,
}: {
  run: JobRun;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="min-w-0 space-y-2">
          <CardTitle className="text-table font-medium capitalize">
            {run.taskKind.replace(/-/g, ' ')}
          </CardTitle>
          {/* §3.3 — named stage, keeping last-known state readable. The
              heartbeat-stale condition gets its own line rather than being
              folded into the status, because a run that says "running" while
              its worker is dead is the case an operator must not miss. */}
          <RunStatusStrip
            run={{
              id: run.id,
              status: run.status,
              startedAt: run.startedAt ?? run.createdAt,
              completedAt: run.finishedAt ?? undefined,
              stage: run.stage ? { name: run.stage } : undefined,
            }}
          />
          {run.heartbeatStale ? (
            <p className="text-meta font-medium text-warning-foreground">
              This run reports as running but has not sent a heartbeat recently.
              It may have stopped without recording a result.
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!run.actions.canRetry || busy}
            title={run.actions.retryBlockedReason ?? undefined}
            onClick={onRetry}
          >
            <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!run.actions.canCancel || busy}
            title={run.actions.cancelBlockedReason ?? undefined}
            onClick={() => setConfirmCancel(true)}
          >
            <XCircle aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            Cancel
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* A blocked action's reason is shown in the open, not only on hover —
            §3.5 wants the reader told why, not left guessing. */}
        {!run.actions.canRetry && run.actions.retryBlockedReason ? (
          <p className="text-meta text-muted-foreground">
            Retry unavailable: {run.actions.retryBlockedReason}
          </p>
        ) : null}
        {!run.actions.canCancel && run.actions.cancelBlockedReason ? (
          <p className="text-meta text-muted-foreground">
            Cancel unavailable: {run.actions.cancelBlockedReason}
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-4">
          <Fact label="Started">
            {run.startedAt ? <Timestamp value={run.startedAt} /> : <span className="text-muted-foreground">Not started</span>}
          </Fact>
          <Fact label="Attempt">
            {run.attempt} of {run.maxAttempts}
          </Fact>
          <Fact label="Cost">
            {/* Two units, never combined. */}
            <span className="flex flex-wrap items-baseline gap-x-2">
              {run.costUsd > 0 ? <span>{formatCurrency(run.costUsd, 'USD')}</span> : null}
              {run.costCredits > 0 ? (
                <span className="text-meta text-muted-foreground">
                  {formatCredits(run.costCredits)}
                </span>
              ) : null}
              {run.costUsd === 0 && run.costCredits === 0 ? (
                <span className="text-muted-foreground">No cost recorded</span>
              ) : null}
            </span>
          </Fact>
          <Fact label="Trigger">{run.trigger}</Fact>
        </dl>

        {/* §3.3 coverage — expected vs successful, with every failure named. */}
        <CoveragePanel
          summary={{
            expectedCount: run.coverage.total,
            successfulCount: run.coverage.succeeded,
            failed: run.steps
              ?.filter((step) => step.status === 'failed')
              .map((step) => ({ name: step.name, reason: step.error ?? 'No reason recorded' })),
            deferred: run.steps
              ?.filter((step) => step.status === 'skipped')
              .map((step) => ({ name: step.name, reason: step.error ?? 'Skipped' })),
          }}
        />

        {run.error ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      {/*
        §10.4 delete/cascade row: name the exact target and effect, and do not
        imply an undo. The confirmation states what has already been spent,
        because a cancellation does not return it.
      */}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        target={`${run.taskKind} run from ${new Date(run.createdAt).toLocaleDateString()}`}
        effect={
          run.reversible
            ? 'The run will stop. Work not yet started will not happen.'
            : 'The run will stop. Some work in this run cannot be undone, and any cost already incurred is not returned.'
        }
        targetLabel="Run"
        confirmLabel="Cancel run"
        destructive
        onConfirm={onCancel}
        onConfirmed={() => setConfirmCancel(false)}
      />
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
