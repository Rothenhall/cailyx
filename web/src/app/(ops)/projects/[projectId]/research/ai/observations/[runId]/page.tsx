'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { CoverageSummary } from '@/types';
import {
  AEO_MIN_RUN_COUNT,
  AEO_SURFACE_LABELS,
  getMeasurementRun,
  type MeasurementObservation,
  type MeasurementRunDetail,
} from '@/services/research';

/**
 * AE04 — Answer evidence.
 *
 * design_plan.md §4.3: *"Prompt, answer, mention/citation extraction,
 * competitors, timestamp/model/market; raw observation list"*.
 *
 * §5.6 step 10 is the rule this screen implements: *"Inspect raw answers and
 * citations before promoting a claim. Verify completed observations per prompt;
 * requested `n=5` alone does not prove five successful responses."*
 *
 * So this screen does two things and refuses to do a third:
 *
 *  1. it states the coverage — how many answers were requested and how many
 *     arrived — from the run's own counters;
 *  2. it lists **per prompt** how many answers actually came back against the
 *     requested n, because that is the check the plan asks for;
 *  3. it shows each raw answer verbatim in the evidence drawer, as escaped
 *     text (§10.5), with the extraction (mentioned / cited / competitors)
 *     beside it. **It computes no rate of its own** — a rate belongs on the run
 *     screen with its denominator, not on a page showing individual answers.
 */

export default function AeoObservationsPage() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();

  const [run, setRun] = useState<MeasurementRunDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<MeasurementObservation | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setRun(await getMeasurementRun(projectId, runId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, runId],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  const observations = useMemo(() => run?.observations ?? [], [run]);

  /** Per-prompt completion: the check §5.6 step 10 asks for. */
  const byPrompt = useMemo(() => {
    const groups = new Map<
      string,
      { itemId: string; prompt: string; answers: number; mentioned: number; cited: number; competitors: Set<string> }
    >();
    for (const observation of observations) {
      let group = groups.get(observation.itemId);
      if (!group) {
        group = {
          itemId: observation.itemId,
          prompt: observation.prompt,
          answers: 0,
          mentioned: 0,
          cited: 0,
          competitors: new Set<string>(),
        };
        groups.set(observation.itemId, group);
      }
      group.answers += 1;
      if (observation.mentioned) group.mentioned += 1;
      if (observation.cited) group.cited += 1;
      for (const name of observation.competitors) group.competitors.add(name);
    }
    return [...groups.values()].sort((a, b) => a.prompt.localeCompare(b.prompt));
  }, [observations]);

  const coverage = useMemo((): CoverageSummary | null => {
    if (!run) return null;
    return {
      expectedCount: run.totalRequests,
      successfulCount: run.completedRequests,
      failed:
        run.failedRequests > 0
          ? [
              {
                name: `${formatNumber(run.failedRequests)} answer request(s)`,
                reason:
                  'The run recorded these as failed, but this endpoint does not name which prompt, engine or repeat each one was. Per-observation failure detail is design_plan G14.',
              },
            ]
          : [],
      // No deferred list: this endpoint reports requested/failed/completed
      // counts only, and inventing a deferred category from them would be a
      // guess about the run.
    };
  }, [run]);

  const thinPrompts = useMemo(
    () => byPrompt.filter((group) => group.answers < (run?.runCount ?? AEO_MIN_RUN_COUNT)),
    [byPrompt, run],
  );

  const observationColumns: ReadonlyArray<ColumnDef<MeasurementObservation>> = [
    {
      key: 'prompt',
      header: 'Prompt',
      accessor: (row) => row.prompt,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[26rem] truncate text-foreground" title={row.prompt}>
          {row.prompt}
        </span>
      ),
    },
    {
      key: 'runNumber',
      header: 'Repeat',
      accessor: (row) => row.runNumber,
      sortable: true,
      align: 'right',
      width: 90,
      render: (row) => <span className="tabular-nums">{formatNumber(row.runNumber)}</span>,
    },
    {
      key: 'mentioned',
      header: 'Named the client',
      accessor: (row) => (row.mentioned ? 'yes' : 'no'),
      sortable: true,
      width: 150,
      render: (row) => (
        <span className="text-table">{row.mentioned ? 'Named' : 'Not named'}</span>
      ),
    },
    {
      key: 'cited',
      header: 'Cited',
      accessor: (row) => (row.cited ? 'yes' : 'no'),
      sortable: true,
      width: 150,
      render: (row) =>
        row.cited ? (
          <span className="text-table">
            Cited
            {row.citedUrl ? (
              <span className="sr-only"> — {row.citedUrl}</span>
            ) : null}
            {row.position !== null ? (
              <span className="text-meta text-muted-foreground"> · #{row.position}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-table">Not cited</span>
        ),
    },
    {
      key: 'competitors',
      header: 'Competitors named',
      accessor: (row) => row.competitors.join(', '),
      width: 200,
      emptyLabel: 'None named',
      render: (row) =>
        row.competitors.length > 0 ? (
          <span className="block max-w-[16rem] truncate text-table" title={row.competitors.join(', ')}>
            {row.competitors.join(', ')}
          </span>
        ) : null,
    },
    {
      key: 'model',
      header: 'Model',
      accessor: (row) => row.model ?? '',
      width: 160,
      emptyLabel: 'Not recorded',
      render: (row) =>
        row.model ? <span className="font-mono text-meta">{row.model}</span> : null,
    },
    {
      key: 'createdAt',
      header: 'Captured',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 200,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'answer',
      header: '',
      width: 120,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setOpen(row)}>
          Read answer
        </Button>
      ),
    },
  ];

  const promptColumns: ReadonlyArray<ColumnDef<(typeof byPrompt)[number]>> = [
    {
      key: 'prompt',
      header: 'Prompt',
      accessor: (row) => row.prompt,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[30rem] truncate text-foreground" title={row.prompt}>
          {row.prompt}
        </span>
      ),
    },
    {
      key: 'answers',
      header: 'Answers returned',
      accessor: (row) => row.answers,
      sortable: true,
      align: 'right',
      width: 180,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.answers)}
          <span className="text-muted-foreground">
            {' '}
            of {formatNumber(run?.runCount ?? 0)} requested
          </span>
        </span>
      ),
    },
    {
      key: 'mentioned',
      header: 'Named the client',
      accessor: (row) => row.mentioned,
      sortable: true,
      align: 'right',
      width: 160,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.mentioned)} of {formatNumber(row.answers)}
          <span className="text-meta text-muted-foreground"> counted</span>
        </span>
      ),
    },
    {
      key: 'cited',
      header: 'Cited',
      accessor: (row) => row.cited,
      sortable: true,
      align: 'right',
      width: 150,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.cited)} of {formatNumber(row.answers)}
          <span className="text-meta text-muted-foreground"> counted</span>
        </span>
      ),
    },
    {
      key: 'competitors',
      header: 'Competitors seen',
      accessor: (row) => [...row.competitors].join(', '),
      width: 200,
      emptyLabel: 'None named',
      render: (row) =>
        row.competitors.size > 0 ? (
          <span className="block max-w-[16rem] truncate text-table" title={[...row.competitors].join(', ')}>
            {[...row.competitors].join(', ')}
          </span>
        ) : null,
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Answer evidence" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const surfaceLabel = AEO_SURFACE_LABELS[run.surface] ?? run.surface;

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          projectName: 'This project',
          market: run.geo || undefined,
          mode: 'live',
          runLabel: `Measurement run ${run.id}`,
        }}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}/research/ai`}>Back to AI visibility</Link>
          </Button>
        }
      />

      <PageHeader
        title="Answer evidence"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{surfaceLabel}</span>
            <span>
              Market <span className="font-mono">{run.geo}</span> · n={formatNumber(run.runCount)}
            </span>
            <span>
              Captured <Timestamp value={run.createdAt} />
            </span>
          </span>
        }
        status={<StatusPill label={run.status} tone={runStatusTone(run.status)} />}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {coverage ? (
        <CoveragePanel
          summary={coverage}
          title="Answers requested versus returned"
          contextNote={
            <span>
              The run asked for {formatNumber(run.totalRequests)} answers across its prompt matrix and
              received {formatNumber(run.completedRequests)}. Every figure on this page is read from the
              observations that were stored — nothing here is inferred from the number requested.
            </span>
          }
        />
      ) : null}

      {thinPrompts.length > 0 ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Some prompts returned fewer answers than requested — no significance is claimed</AlertTitle>
          <AlertDescription>
            {thinPrompts.length} prompt(s) returned fewer than the requested n={formatNumber(run.runCount)}{' '}
            answers: {thinPrompts.slice(0, 5).map((group) => group.prompt).join('; ')}
            {thinPrompts.length > 5 ? ` and ${thinPrompts.length - 5} more` : ''}. A requested repeat count is
            not a completed one, so the counts below describe the answers that came back and cannot stand in
            for the run&rsquo;s intended sample.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Completion by prompt</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {byPrompt.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="answers for this run"
              prerequisite="the run has to execute and store at least one observation."
            />
          ) : (
            <>
              <DataTable
                caption="Answers returned per prompt, against the requested repeats"
                columns={promptColumns}
                rows={byPrompt}
                getRowId={(row) => row.itemId}
                minTableWidth="64rem"
                filters={[
                  {
                    id: 'completion',
                    label: 'Completion',
                    options: [
                      { value: 'complete', label: `Reached n=${run.runCount}` },
                      { value: 'thin', label: `Below n=${run.runCount}` },
                    ],
                    getValue: (row) => (row.answers < run.runCount ? 'thin' : 'complete'),
                  },
                ]}
                emptyState={<EmptyState variant="no-results" />}
              />
              <p className="mt-2 text-meta text-muted-foreground">
                &ldquo;Named the client&rdquo; and &ldquo;cited&rdquo; are the deterministic extraction&rsquo;s
                per-answer flags. They are counts of individual answers, not rates — ratios belong on the run
                screen, where each one is shown with its denominator and coverage.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Raw observations</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {observations.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="raw answers"
              prerequisite="this run stored no observations, so there is nothing to read."
            />
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="measured" />
                <span className="text-meta text-muted-foreground">
                  Model output as returned. Rendered as escaped text, never as markup.
                </span>
              </div>
              <DataTable
                caption="Stored observations for this measurement run"
                columns={observationColumns}
                rows={observations}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'createdAt', direction: 'asc' }}
                minTableWidth="76rem"
                filters={[
                  {
                    id: 'mentioned',
                    label: 'Mention',
                    options: [
                      { value: 'yes', label: 'Named the client' },
                      { value: 'no', label: 'Did not name the client' },
                    ],
                    getValue: (row) => (row.mentioned ? 'yes' : 'no'),
                  },
                  {
                    id: 'cited',
                    label: 'Citation',
                    options: [
                      { value: 'yes', label: 'Cited the client' },
                      { value: 'no', label: 'Did not cite' },
                    ],
                    getValue: (row) => (row.cited ? 'yes' : 'no'),
                  },
                ]}
                emptyState={<EmptyState variant="no-results" />}
              />
              <p className="mt-2 text-meta text-muted-foreground">
                All {formatNumber(observations.length)} stored observations for this run are loaded. The
                endpoint returns the run&rsquo;s full observation set; a paginated observation endpoint is
                design_plan G14, so the filters above apply to the loaded rows only.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <EvidenceDrawer
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title={open ? `Answer ${open.runNumber}: ${open.prompt}` : 'Answer'}
        source={{
          name: `${surfaceLabel} · model ${open?.model ?? 'not recorded'}`,
          capturedAt: open?.createdAt ?? run.createdAt,
          runId: run.id,
          url: open?.citedUrl ?? undefined,
          query: open?.prompt,
        }}
        observed={
          open ? (
            <dl className="grid gap-1">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Client named</dt>
                <dd>{open.mentioned ? 'Yes' : 'No'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Client domain cited</dt>
                <dd>
                  {open.cited ? 'Yes' : 'No'}
                  {open.position !== null ? ` (rank ${open.position})` : ''}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Competitors named</dt>
                <dd className="min-w-0 text-right">
                  {open.competitors.length > 0 ? open.competitors.join(', ') : 'None'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Repeat</dt>
                <dd>
                  {open.runNumber} of {run.runCount}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Latency</dt>
                <dd>
                  {open.latencyMs === null ? notMeasuredLabel() : `${formatNumber(open.latencyMs)} ms`}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Cost</dt>
                <dd className="tabular-nums">
                  {open.costUsd === 0
                    ? 'No metered cost recorded'
                    : `${formatNumber(open.costUsd)} (provider charge, USD)`}
                </dd>
              </div>
            </dl>
          ) : null
        }
        interpretation={
          open ? (
            <p>
              These flags are the deterministic extraction over this one answer
              {open.characterization ? `, characterised as "${open.characterization}"` : ''}. A mention is
              evidence that the client was named in this answer; it is not evidence of a recommendation,
              and it says nothing about the answers this run did not receive.
            </p>
          ) : null
        }
        interpretationKind="derived"
        raw={
          open
            ? {
                label: 'Model answer (verbatim)',
                text: open.rawAnswer,
              }
            : undefined
        }
        provenance="measured"
        related={[{ label: `Measurement run ${run.id}`, kind: 'run' }]}
      />

      <p className="text-meta text-muted-foreground">
        Read the answers before promoting any of them into a claim: this screen exists so a rate can be
        checked against the text it was computed from. The rate itself, with its coverage and denominator,
        is on the run screen — not here, where a share over a handful of answers would read as a finding.
        {run.error ? ` Run error: ${run.error}` : ''}
      </p>
    </div>
  );
}

function runStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'unmeasured' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    default:
      return 'unmeasured';
  }
}
