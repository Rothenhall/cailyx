'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunStatusStrip } from '@/components/patterns/RunStatusStrip';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { usePolling } from '@/hooks/usePolling';
import { formatNumber } from '@/lib/format';
import { getClient } from '@/services/clients';
import {
  getOnboardingRun,
  listRuns,
  onboardingStageLabel,
  resumeOnboardingRun,
  type JobRun,
  type JobStep,
  type OnboardingRunView,
} from '@/services/jobs';
import { getProject } from '@/services/projects';
import type { CoverageIssue, CoverageSummary, RunStatus } from '@/types';

/**
 * OP07 — Onboarding run.
 *
 * design_plan.md §4.2: *"Named stage, elapsed time, artifacts produced,
 * partial-result warnings, report link"*, support "P: status/step E; step
 * ledger/retry/cancel G07".
 *
 * The rule that decides this screen's whole shape is the one §4 states for the
 * onboarding family: **"current progress screen uses named stages without
 * invented ETA/percentage."** So:
 *
 *  - There is **no progress bar**. `RunStatusStrip` only draws one when the
 *    server supplies stage counts, and this screen deliberately does not
 *    supply any: the run's real numbers are *steps settled out of steps
 *    defined*, which is a different denominator from "how much of this stage is
 *    done", and labelling the one as the other would be the invention the plan
 *    forbids. The counts are stated as text instead.
 *  - There is **no ETA**. Elapsed time is measured, not projected: it is the
 *    distance from the recorded start to now, refreshed on the poll.
 *  - The stage shown is the server's own stage name, never a number this page
 *    derived from step position.
 *
 * Everything else follows §3.5's partial-run rule: a stage that failed is
 * named with its error, the successful stages stay visible, and the run is
 * never rounded up to "complete".
 */
export default function OnboardingRunPage() {
  const params = useParams<{ clientId: string; projectId: string }>();
  const clientId = params.clientId;
  const projectId = params.projectId;

  const [view, setView] = useState<OnboardingRunView | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [clientName, setClientName] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [viewResult, runsResult] = await Promise.all([
        getOnboardingRun(projectId, { signal }),
        // The run list is what makes "the last successful run" citable rather
        // than guessed: the onboarding read only ever returns the newest run.
        listRuns(projectId, { taskKind: 'onboarding', limit: 10 }, { signal }).catch(() => []),
      ]);
      setView(viewResult);
      setRuns(runsResult);
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setError(null);
        setLoading(true);
        await load(controller.signal);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [load]);

  // Names are context, not the subject — a failure to read them must not take
  // the run screen down with it.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [client, project] = await Promise.all([
          getClient(clientId, { signal: controller.signal }).catch(() => null),
          getProject(projectId, { signal: controller.signal }).catch(() => null),
        ]);
        if (client) setClientName(client.name);
        if (project) setProjectName(project.name);
      } catch {
        /* names are optional context */
      }
    })();
    return () => controller.abort();
  }, [clientId, projectId]);

  const run = view?.run ?? null;
  const inFlight = run?.status === 'queued' || run?.status === 'running';

  usePolling({
    active: inFlight,
    onPoll: async () => {
      try {
        await load();
      } catch {
        // A failed poll keeps the last known state on screen (§3.5) rather than
        // blanking a run the operator is watching.
      }
    },
  });

  async function onResume() {
    if (!run || resuming) return;
    setResumeError(null);
    setResumeNotice(null);
    setResuming(true);
    try {
      const result = await resumeOnboardingRun(projectId, run.id);
      setResumeNotice(
        result.resumed
          ? `Advanced stage "${onboardingStageLabel(result.advancedStage ?? '')}". The run has been reloaded below.`
          : result.reason ?? 'Nothing was resumed.',
      );
      await load();
    } catch (caught) {
      const caughtError = toApiError(caught);
      // A 409 here is a state conflict the server explains exactly — finished,
      // already running, or out of retry budget. Its message is the answer.
      setResumeError(caughtError.message);
      await load().catch(() => undefined);
    } finally {
      setResuming(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]} title="Setup run" />
        <ErrorState
          error={error}
          notFoundReason="missing-or-private"
          onRetry={() => {
            setLoading(true);
            void load()
              .catch((caught) => setError(toApiError(caught)))
              .finally(() => setLoading(false));
          }}
        />
      </div>
    );
  }

  if (!view) return null;

  const steps = run?.steps ?? [];
  const failedSteps = steps.filter((step) => step.status === 'failed');
  const succeededSteps = steps.filter((step) => step.status === 'succeeded');
  const skippedSteps = steps.filter((step) => step.status === 'skipped');
  const lastSuccessful = runs.find((candidate) => candidate.status === 'completed' && candidate.id !== run?.id);

  const coverage: CoverageSummary | null = run
    ? {
        expectedCount: run.coverage.total,
        successfulCount: run.coverage.succeeded,
        failed: failedSteps.map(toCoverageIssue),
        deferred: skippedSteps.map(toCoverageIssue),
      }
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Clients', href: '/ops/clients' },
          ...(clientName ? [{ label: clientName, href: `/ops/clients/${clientId}` }] : []),
          { label: 'Setup run' },
        ]}
        title={projectName ? `Setting up ${projectName}` : 'Setup run'}
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Day-1 pipeline{' '}
              <span className="font-mono text-meta text-muted-foreground">{projectId}</span>
            </span>
            {view.legacy.onboardingStep ? (
              <span className="text-muted-foreground">
                Recorded step: {onboardingStageLabel(view.legacy.onboardingStep)}
              </span>
            ) : null}
          </span>
        }
        primaryAction={
          run && inFlight && view.executorAvailable
            ? {
                label: resuming ? 'Resuming…' : `Resume: ${descriptionOfNext(view)}`,
                onClick: () => void onResume(),
                disabled: resuming,
                disabledReason: resuming ? 'A resume is already in flight.' : undefined,
              }
            : undefined
        }
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}/runs`}>Open run center</Link>
          </Button>
        }
      />

      {resumeNotice ? (
        <Alert>
          <AlertTitle>Resume</AlertTitle>
          <AlertDescription>{resumeNotice}</AlertDescription>
        </Alert>
      ) : null}

      {resumeError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Resume did not advance the run</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{resumeError}</p>
            <p className="text-meta">
              Nothing was re-attempted. Resuming always continues from the first stage that did not
              succeed, and a stage that already succeeded is never re-run.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {!run ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="the day-1 setup pipeline for this project"
              prerequisite="Start the pipeline, or check the project's run list for a run created before the durable ledger existed"
              action={{
                label: 'Open the project run list',
                href: `/projects/${projectId}/runs`,
              }}
            >
              <p>
                The durable ledger has no onboarding run for this project. That is a state, not an
                error: a project created outside the client pipeline never gets one.
              </p>
              {view.legacy.onboardingStatus !== 'pending' ? (
                <p>
                  The older project record reports onboarding as{' '}
                  <strong className="font-medium">{view.legacy.onboardingStatus}</strong>
                  {view.legacy.onboardingError ? ` — ${view.legacy.onboardingError}` : ''}. It is
                  shown here for comparison; it is not a run record and carries no steps or
                  artifacts.
                </p>
              ) : null}
            </EmptyState>
          </CardContent>
        </Card>
      ) : (
        <>
          {run.startedAt ? (
            <RunStatusStrip
              run={{
                id: run.id,
                status: run.status as RunStatus,
                startedAt: run.startedAt,
                completedAt: run.finishedAt ?? undefined,
                // The named stage, never a number this page derived.
                stage: run.stage ? { name: onboardingStageLabel(run.stage) } : undefined,
              }}
              lastSuccessful={
                lastSuccessful
                  ? {
                      id: lastSuccessful.id,
                      completedAt: lastSuccessful.finishedAt ?? lastSuccessful.createdAt,
                      label: 'previous setup run',
                      href: `/projects/${projectId}/runs`,
                    }
                  : undefined
              }
              detail={
                <RunDetail
                  run={run}
                  succeeded={succeededSteps.length}
                  failed={failedSteps.length}
                  skipped={skippedSteps.length}
                  total={steps.length}
                  executorAvailable={view.executorAvailable}
                  resumeDisclosure={view.resumeDisclosure}
                />
              }
              timeZone={undefined}
            />
          ) : (
            <QueuedNotice run={run} />
          )}

          {coverage && coverage.expectedCount > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">Setup coverage</CardTitle>
              </CardHeader>
              <CardContent>
                <CoveragePanel
                  summary={coverage}
                  title="Pipeline stages"
                  contextNote={
                    run.coverage.disclosure ??
                    'Every stage that was attempted produced a result. Stages not yet reached are still pending.'
                  }
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Stages</CardTitle>
            </CardHeader>
            <CardContent>
              {steps.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="the run's stage list"
                  prerequisite="a run created with its step skeleton"
                  layout="inline"
                />
              ) : (
                <ol className="divide-y divide-border">
                  {steps.map((step) => (
                    <StageRow key={step.id} step={step} />
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Artifacts produced</CardTitle>
            </CardHeader>
            <CardContent>
              <Artifacts run={run} projectId={projectId} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** The server's own account of the run, plus the counts as text, never a bar. */
function RunDetail({
  run,
  succeeded,
  failed,
  skipped,
  total,
  executorAvailable,
  resumeDisclosure,
}: {
  run: JobRun;
  succeeded: number;
  failed: number;
  skipped: number;
  total: number;
  executorAvailable: boolean;
  resumeDisclosure: string;
}) {
  const [elapsed, setElapsed] = useState(() => elapsedLabel(run.startedAt, run.finishedAt));

  // Elapsed time is measured, not projected. It refreshes with the poll rather
  // than on a one-second timer — a number that ticks every second is a screen
  // reader metronome, which §3.4 forbids.
  useEffect(() => {
    setElapsed(elapsedLabel(run.startedAt, run.finishedAt));
  }, [run.startedAt, run.finishedAt, run.updatedAt, run.heartbeatAt]);

  return (
    <div className="space-y-3">
      {run.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>The run reported an error</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid gap-1 text-table sm:grid-cols-2">
        <Row label="Elapsed">{elapsed}</Row>
        <Row label="Stages settled">
          {`${formatNumber(succeeded + failed + skipped)} of ${formatNumber(total)}`}
        </Row>
        <Row label="Succeeded">{formatNumber(succeeded)}</Row>
        <Row label="Failed">{formatNumber(failed)}</Row>
        <Row label="Skipped">{formatNumber(skipped)}</Row>
        <Row label="Attempt">
          {`${formatNumber(run.attempt)} of ${formatNumber(run.maxAttempts)}`}
        </Row>
        {run.costUsd > 0 || run.costCredits > 0 ? (
          <>
            <Row label="Vendor cost">${run.costUsd.toFixed(2)}</Row>
            {/* Credits are a separate unit and are never summed with money. */}
            <Row label="Credits">{formatNumber(run.costCredits)}</Row>
          </>
        ) : null}
      </dl>

      <p className="text-table text-muted-foreground">{resumeDisclosure}</p>

      {!executorAvailable && run.status !== 'completed' ? (
        <p className="text-table text-muted-foreground">
          No executor for the next stage is registered in the running server process. Resume will
          report that rather than appear to advance a stage.
        </p>
      ) : null}
    </div>
  );
}

/** A run that exists but has not started. Deliberately not a status strip, so
 *  no "Started" line is drawn for a start that has not happened. */
function QueuedNotice({ run }: { run: JobRun }) {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill label="Queued" tone="neutral" />
          <span className="text-table">
            Created <Timestamp value={run.createdAt} />
          </span>
        </div>
        <p className="text-table text-muted-foreground">
          This run has been created and has not started. No stage is running, so there is no elapsed
          time to report yet.
        </p>
      </CardContent>
    </Card>
  );
}

function StageRow({ step }: { step: JobStep }) {
  const tone =
    step.status === 'succeeded'
      ? 'success'
      : step.status === 'failed'
        ? 'danger'
        : step.status === 'skipped'
          ? 'warning'
          : step.status === 'running'
            ? 'info'
            : 'neutral';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="text-table font-medium">{onboardingStageLabel(step.name)}</div>
        <div className="text-meta text-muted-foreground">{step.name}</div>
        {step.error ? (
          <p className="text-meta text-danger-foreground">{step.error}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {step.attempted > 0 ? (
          <span className="text-meta text-muted-foreground tabular-nums">
            {formatNumber(step.succeeded)} of {formatNumber(step.attempted)} items
          </span>
        ) : null}
        {step.startedAt ? <Timestamp value={step.startedAt} /> : null}
        <StatusPill label={STAGE_STATUS_LABEL[step.status] ?? step.status} tone={tone} />
      </div>
    </li>
  );
}

const STAGE_STATUS_LABEL: Record<JobStep['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

/**
 * What the run produced, key by key.
 *
 * Values are rendered as escaped text — never as markup — and an empty map is
 * an explicit empty state rather than a blank card, because "nothing has been
 * produced yet" is the fact the operator came here to learn.
 */
function Artifacts({ run, projectId }: { run: JobRun; projectId: string }) {
  const entries = Object.entries(run.artifacts ?? {});

  if (entries.length === 0) {
    return (
      <EmptyState
        variant="not-measured"
        subject="artifacts for this run"
        prerequisite="a stage that has produced output"
        layout="inline"
      >
        <p>
          The run has recorded no artifacts yet. A stage that fails produces none, and the stages
          after it are not reached.
        </p>
      </EmptyState>
    );
  }

  const reportLike = entries.filter(
    ([key]) => key.toLowerCase().includes('report') || key.toLowerCase().includes('slug'),
  );

  return (
    <div className="space-y-3">
      <dl className="grid gap-1 text-table">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-wrap justify-between gap-4 border-b border-border py-2 last:border-b-0">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="max-w-[60ch] break-words font-mono text-meta text-foreground">
              {renderArtifactValue(value)}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-table text-muted-foreground">
        {reportLike.length > 0
          ? 'The run recorded a report reference above.'
          : 'The run recorded no report reference. The first report is the pipeline’s last stage.'}{' '}
        <Link href={`/projects/${projectId}/reports`} className="underline underline-offset-4">
          Open this project&apos;s reports
        </Link>
        .
      </p>
    </div>
  );
}

/** Plain text only — a fetched value never becomes application markup (§10.5). */
function renderArtifactValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '(value could not be displayed)';
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function toCoverageIssue(step: JobStep): CoverageIssue {
  return {
    name: onboardingStageLabel(step.name),
    reason: step.error ?? 'No reason was recorded for this stage.',
  };
}

/** "1 h 12 m", "4 m 03 s", or "not started". Measured from the recorded start. */
function elapsedLabel(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return 'Not started';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return 'Not measured';
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(end) || end < start) return 'Not measured';

  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${formatNumber(hours)} h ${formatNumber(minutes)} m`;
  if (minutes > 0) return `${formatNumber(minutes)} m ${String(seconds).padStart(2, '0')} s`;
  return `${formatNumber(seconds)} s`;
}

/** Names the next stage for the resume button, so the action says what it does. */
function descriptionOfNext(view: OnboardingRunView): string {
  if (!view.nextStageLabel && !view.nextStage) return 'next stage';
  const label = view.nextStageLabel ?? onboardingStageLabel(view.nextStage ?? '');
  if (view.nextStagePosition === null) return label;
  return `${label} (stage ${formatNumber(view.nextStagePosition + 1)})`;
}
