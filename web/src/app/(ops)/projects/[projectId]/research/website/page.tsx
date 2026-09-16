'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TechnicalScoreHistory } from '@/components/charts/TechnicalScoreHistory';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunConfigurator } from '@/components/patterns/RunConfigurator';
import { RunStatusStrip } from '@/components/patterns/RunStatusStrip';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { ComparableBaseline, CoverageSummary, RunStatus } from '@/types';
import { getProjectDetail, type ProjectDetailWire } from '@/services/projects';
import {
  findingReason,
  getTechnicalAudit,
  getTechnicalTrend,
  listTechnicalAudits,
  runTechnicalAudit,
  getTechnicalAuditJob,
  technicalCheckLabel,
  type AuditRunSummary,
  type PipelineJobStatus,
  type TechnicalAuditDetail,
  type TechnicalPageRow,
  type TechnicalTrendPoint,
} from '@/services/research';

/**
 * TA01 — Website health.
 *
 * design_plan.md §4.3: *"Latest technical score, checks, worst pages, coverage,
 * history, start audit"*, under the audit-hub family contract: *"Source/
 * readiness strip, selected run and freshness, limited headline metrics,
 * chart/table tabs, prioritized evidence; **run configuration is a deliberate
 * drawer/page, never triggered on tab load**."*
 *
 * Three decisions this page is built around:
 *
 *  1. **Nothing runs on load.** Every request here is a read. Starting a run
 *     happens in the "Start audit" drawer, which shows the target, the checks
 *     and the outstanding page-budget gap before anyone commits.
 *  2. **A delta appears only against a comparable run.** The previous run is
 *     passed to `MetricTile` as a `ComparableBaseline` only when it audited the
 *     same target URL — the comparison key for this metric set. Otherwise the
 *     tile shows the value with no change figure at all (§3.5 "No comparison
 *     baseline"), which is the conservative answer.
 *  3. **Coverage is stated, not summarised.** The run's own check results give
 *     expected versus returned; anything that errored or never ran is named with
 *     its reason, so a partial run cannot read as a clean score (§3.5).
 *  4. **The history chart breaks where the runs are not comparable.** The score
 *     series is split at every change of `targetUrl`, on the same comparison
 *     key the tile's delta uses, and each break is named in text (§6.4). Its
 *     values are also carried by a table directly under it, so the chart is
 *     never the only way to read them (§3.4).
 */

/** Stable reference: `useUrlState` decodes only declared keys. */
const TAB_DEFAULTS = { tab: 'pages' };

export default function WebsiteHealthPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useUrlState(TAB_DEFAULTS);

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [audits, setAudits] = useState<AuditRunSummary[] | null>(null);
  const [trend, setTrend] = useState<TechnicalTrendPoint[] | null>(null);
  /** The history read's own failure, kept apart from the page's. */
  const [trendError, setTrendError] = useState<ApiError | null>(null);
  const [latest, setLatest] = useState<TechnicalAuditDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [startOpen, setStartOpen] = useState(false);

  /** The job this page queued, kept in server vocabulary rather than memory. */
  const [job, setJob] = useState<{ id: string; startedAt: string; status: PipelineJobStatus } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setTrendError(null);
        const [projectResult, listResult] = await Promise.all([
          getProjectDetail(projectId, { signal }),
          listTechnicalAudits(projectId, { signal }),
        ]);
        setProject(projectResult);
        setAudits(listResult.audits);

        // The score history the chart draws. It is a read of stored runs, so it
        // can never start one — the whole page stays read-only on load
        // (§4 audit-hub contract).
        //
        // Read separately from the calls above: a failed history read is not a
        // reason to hide the run tiles, and it is certainly not a reason to
        // render the chart as "not measured", which would claim the runs do not
        // exist. It gets its own error state inside its own card.
        try {
          setTrend((await getTechnicalTrend(projectId, { signal, limit: 30 })).history);
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
          setTrend(null);
          setTrendError(toApiError(caught));
        }

        // The worst-pages inventory is the only thing that needs the detail
        // call; it is a read of the newest run, never a trigger for a new one.
        const newest = listResult.audits[0];
        if (newest) {
          setLatest(await getTechnicalAudit(projectId, newest.id, { signal }));
        } else {
          setLatest(null);
        }
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

  const checkJob = useCallback(async () => {
    if (!job) return;
    try {
      setJobError(null);
      const status = await getTechnicalAuditJob(projectId, job.id);
      setJob((current) => (current ? { ...current, status } : current));
      // A finished job means the run row now exists — re-read the history so
      // the new run appears without the operator reloading the page.
      if (status.status === 'completed' || status.status === 'failed') await load();
    } catch (caught) {
      setJobError(toApiError(caught).message);
    }
  }, [job, projectId, load]);

  const newest = audits?.[0] ?? null;
  const previous = audits?.[1] ?? null;

  /**
   * The previous run, but only as a baseline when both runs audited the same
   * target. `targetUrl` is the comparison key for this metric set: a run
   * against a different host or path is a different measurement, and treating
   * it as a baseline would turn a scope change into a performance decline.
   */
  const baseline = useMemo((): ComparableBaseline | undefined => {
    if (!newest || !previous) return undefined;
    if (typeof newest.score !== 'number' || typeof previous.score !== 'number') return undefined;
    if (!newest.createdAt || !previous.createdAt) return undefined;
    if (newest.targetUrl !== previous.targetUrl) return undefined;
    return {
      comparable: true,
      value: previous.score,
      runId: previous.id,
      runDate: previous.createdAt,
      label: 'Previous run on the same target',
    };
  }, [newest, previous]);

  const coverage = useMemo((): CoverageSummary | null => {
    if (!latest) return null;
    const findings = latest.findings;
    return {
      expectedCount: findings.length,
      // `pass` and `fail` both mean the check returned a verdict. `error` and
      // `not-run` did not, and are named below rather than counted as results.
      successfulCount: findings.filter((f) => f.status === 'pass' || f.status === 'fail').length,
      failed: findings
        .filter((f) => f.status === 'error')
        .map((f) => ({ name: technicalCheckLabel(f.type), reason: findingReason(f) })),
      deferred: findings
        .filter((f) => f.status === 'not-run')
        .map((f) => ({ name: technicalCheckLabel(f.type), reason: findingReason(f) })),
    };
  }, [latest]);

  const pageColumns: ReadonlyArray<ColumnDef<TechnicalPageRow>> = [
    {
      key: 'url',
      header: 'Page',
      accessor: (row) => row.url,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[32rem] truncate font-mono text-meta" title={row.url}>
          {row.url}
        </span>
      ),
    },
    {
      key: 'score',
      header: 'Page score',
      accessor: (row) => row.score,
      sortable: true,
      align: 'right',
      width: 110,
      // §3.5 — an unscored page is not a page that scored zero.
      emptyLabel: 'Not scored',
      render: (row) =>
        typeof row.score === 'number' ? (
          <span className="font-semibold tabular-nums">{formatNumber(row.score)}</span>
        ) : null,
    },
    {
      key: 'issues',
      header: 'Issues',
      accessor: (row) => row.issues.join(', '),
      width: 90,
      align: 'right',
      render: (row) =>
        row.issues.length > 0 ? (
          <span className="tabular-nums">{formatNumber(row.issues.length)}</span>
        ) : (
          <span className="text-muted-foreground">None found</span>
        ),
    },
    {
      key: 'status',
      header: 'Fetch',
      accessor: (row) => row.status,
      width: 90,
      render: (row) => (
        <span className="tabular-nums">
          {row.status > 0 ? row.status : 'Fetch failed'}
        </span>
      ),
    },
  ];

  const historyColumns: ReadonlyArray<ColumnDef<AuditRunSummary>> = [
    {
      key: 'createdAt',
      header: 'Run',
      accessor: (row) => row.createdAt ?? '',
      sortable: true,
      width: 220,
      render: (row) =>
        row.createdAt ? (
          <Timestamp value={row.createdAt}  />
        ) : (
          <span className="text-muted-foreground">Time not recorded</span>
        ),
    },
    {
      key: 'score',
      header: 'Score',
      accessor: (row) => row.score,
      sortable: true,
      align: 'right',
      width: 100,
      emptyLabel: 'Not scored',
      render: (row) =>
        typeof row.score === 'number' ? (
          <span className="font-semibold tabular-nums">{formatNumber(row.score)}</span>
        ) : null,
    },
    {
      key: 'status',
      header: 'Run status',
      accessor: (row) => row.status,
      width: 140,
      render: (row) => <StatusPill label={runLabel(row.status)} tone={runTone(row.status)} />,
    },
    {
      key: 'open',
      header: '',
      width: 120,
      alwaysVisible: true,
      render: (row) => (
        <Link
          href={`/projects/${projectId}/research/website/runs/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open run
        </Link>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Website health" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!audits || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  /**
   * A queued job is a run in flight. The strip keeps the last successful run's
   * results readable underneath it and states which run they came from, so
   * nothing on this page can be mistaken for the new run's output (§3.5).
   */
  const stripRun =
    job && job.status.status !== 'completed'
      ? {
          id: job.id,
          status: jobStatusToRunStatus(job.status.status),
          startedAt: job.startedAt,
        }
      : null;

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project.name,
          domain: project.domain,
          mode: 'live',
          runLabel: newest?.createdAt ? `Last run ${newest.createdAt.slice(0, 10)}` : undefined,
        }}
      />

      <PageHeader
        title="Website health"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{project.domain}</span>
            {newest?.createdAt ? (
              <span>
                Latest run <Timestamp value={newest.createdAt}  />
              </span>
            ) : (
              <span className="text-muted-foreground">No run yet</span>
            )}
          </span>
        }
        status={
          newest ? <StatusPill label={runLabel(newest.status)} tone={runTone(newest.status)} /> : undefined
        }
        primaryAction={{ label: 'Start audit', onClick: () => setStartOpen(true) }}
        secondaryActions={
          <>
            {newest ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/research/website/runs/${newest.id}`}>
                  Open latest run
                </Link>
              </Button>
            ) : null}
            {audits.length > 1 && newest ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/research/website/runs/${newest.id}/compare`}>
                  Compare
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      {audits.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="a technical audit"
              prerequisite="the project needs a domain, and a run has to be started deliberately — nothing here starts one on its own."
              action={{ label: 'Start the first audit', onClick: () => setStartOpen(true) }}
            />
          </CardContent>
        </Card>
      ) : (
        <RunStatusStrip
          run={
            stripRun ?? {
              id: newest!.id,
              status: runStatus(newest!.status),
              startedAt: newest!.createdAt ?? new Date().toISOString(),
              completedAt: newest!.completedAt ?? undefined,
            }
          }
          lastSuccessful={
            newest?.completedAt
              ? { id: newest.id, completedAt: newest.completedAt, href: `/projects/${projectId}/research/website/runs/${newest.id}` }
              : undefined
          }
          detail={
            job ? (
              <div className="space-y-2">
                <p className="text-table text-foreground">
                  Queued job <span className="font-mono">{job.id}</span> — status{' '}
                  <span className="font-mono">{job.status.status}</span>
                  {job.status.error ? `: ${job.status.error}` : ''}.
                </p>
                {jobError ? <p className="text-table text-danger-foreground">{jobError}</p> : null}
                <Button variant="outline" size="sm" onClick={() => void checkJob()}>
                  Check job status
                </Button>
              </div>
            ) : null
          }
          expectedMinutes={5}
          
        >
          <div className="space-y-6">
            {coverage && (coverage.failed?.length ?? 0) + (coverage.deferred?.length ?? 0) > 0 ? (
              <Alert>
                <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                <AlertTitle>Some checks did not return a result</AlertTitle>
                <AlertDescription>
                  The successful evidence is shown below, together with every check that errored or
                  never ran. Treat this run as incomplete rather than healthy.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile
                label="Overall technical score"
                value={typeof newest!.score === 'number' ? newest!.score : null}
                unit="/ 100"
                runLabel={`Run ${newest!.id}`}
                runHref={`/projects/${projectId}/research/website/runs/${newest!.id}`}
                sourceDate={
                  newest!.createdAt ? { date: newest!.createdAt, sourceName: 'Technical audit run' } : undefined
                }
                
                baseline={baseline}
                direction="higher-is-better"
                provenance="measured"
                note={
                  baseline
                    ? undefined
                    : 'No comparable previous run for this target, so no change is shown.'
                }
              />
              <MetricTile
                label="Pages crawled"
                value={latest ? latest.pagesCrawled : null}
                unit="pages"
                runLabel={`Run ${newest!.id}`}
                runHref={`/projects/${projectId}/research/website/runs/${newest!.id}`}
                
                provenance="measured"
              />
              <MetricTile
                label="Failing checks"
                value={latest ? latest.findings.filter((f) => f.status === 'fail').length : null}
                unit="checks"
                runLabel={`Run ${newest!.id}`}
                runHref={`/projects/${projectId}/research/website/runs/${newest!.id}`}
                
                direction="lower-is-better"
                provenance="measured"
              />
              <MetricTile
                label="Coverage"
                value={coverage && coverage.expectedCount > 0 ? coverage.successfulCount : null}
                unit={`of ${coverage?.expectedCount ?? 0}`}
                coverage={coverage ?? undefined}
                
                provenance="measured"
              />
            </div>

            {coverage ? (
              <CoveragePanel
                summary={coverage}
                title="Check coverage for this run"
                action={
                  <Button variant="outline" size="sm" onClick={() => setStartOpen(true)}>
                    Start another run
                  </Button>
                }
                contextNote={
                  latest && latest.pagesCrawled > 0
                    ? `The page inventory covers the ${formatNumber(latest.pagesCrawled)} sitemap URLs this run fetched. design_plan G19 lists page-budget forwarding as an open gap — a per-run crawl budget is accepted by the request but is not yet applied.`
                    : undefined
                }
              />
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">Latest run detail</CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {/* §3.4: the tab is in the URL so a copied link reproduces it.
                    Radix owns the roving focus and aria wiring. */}
                <Tabs value={tab.tab} onValueChange={(value) => setTab({ tab: value })}>
                  <TabsList>
                    <TabsTrigger value="pages">Worst pages</TabsTrigger>
                    <TabsTrigger value="history">History</TabsTrigger>
                  </TabsList>
                  <TabsContent value="pages">
                    {latest && latest.pages.length > 0 ? (
                      <DataTable
                        caption="Pages in the newest run, worst score first"
                        columns={pageColumns}
                        rows={latest.pages}
                        getRowId={(row) => row.url}
                        defaultSort={{ key: 'score', direction: 'asc' }}
                        minTableWidth="48rem"
                        emptyState={<EmptyState variant="no-results" />}
                      />
                    ) : (
                      <EmptyState
                        variant="not-measured"
                        subject="a per-page inventory"
                        prerequisite="the run's sitemap crawl must fetch at least one URL."
                      />
                    )}
                  </TabsContent>
                  <TabsContent value="history">
                    <DataTable
                      caption="Technical audit run history"
                      columns={historyColumns}
                      rows={audits}
                      getRowId={(row) => row.id}
                      defaultSort={{ key: 'createdAt', direction: 'desc' }}
                      emptyState={<EmptyState variant="no-results" />}
                    />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </RunStatusStrip>
      )}

      {/*
        The score history is the one figure on this page that spans runs, so it
        sits outside the strip describing the newest one. It is broken at every
        change of `targetUrl` — the same comparison key the tile delta above
        uses — so the tile and the line cannot disagree about which runs are
        comparable (§6.4).
      */}
      {trendError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Score history</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ErrorState
              error={trendError}
              layout="inline"
              onRetry={() => void load()}
              preserveNotice="Everything else on this page was read successfully; only the score history failed."
            />
          </CardContent>
        </Card>
      ) : trend && trend.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Score history</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <TechnicalScoreHistory
              history={trend}
              emptyState={
                <EmptyState
                  variant="not-measured"
                  subject="a score history"
                  prerequisite="at least one technical audit has to finish with a score before a series exists."
                />
              }
              note={`The ${formatNumber(trend.length)} most recent scored run(s). The history tab above lists every run, including any older than this window. Nothing on this page starts a run — use “Start audit” above.`}
            />
          </CardContent>
        </Card>
      ) : null}

      {/*
        Run configuration is a deliberate drawer (§4 audit-hub contract). It is
        never opened by a tab load, and nothing in it fires until the operator
        presses the one start button, which owns its own double-submit guard.
      */}
      <Sheet open={startOpen} onOpenChange={setStartOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto bg-surface sm:max-w-xl">
          <SheetHeader className="space-y-2 text-left">
            <SheetTitle>Start a technical audit</SheetTitle>
            <SheetDescription className="text-table text-muted-foreground">
              Five checks run against this project&rsquo;s own domain. Nothing has been started yet.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-5">
            <RunConfigurator
              startLabel="Start technical audit"
              prerequisites={[
                {
                  label: 'Project domain is set',
                  met: Boolean(project.domain),
                  detail: project.domain
                    ? `The audit targets ${project.domain} — resolved by the server, not typed here.`
                    : 'Set the project domain before running a technical audit.',
                },
                {
                  label: 'Per-run page budget (design_plan G19)',
                  met: false,
                  blocking: false,
                  detail:
                    'The request accepts a page budget of 1–1000, but it is not yet forwarded to the queued job, so no budget control is offered here.',
                },
              ]}
              parameters={[
                { key: 'target', label: 'Target URL', value: project.domain },
                {
                  key: 'checks',
                  label: 'Checks',
                  value: 'robots.txt · CDN probe · JS render · Core Web Vitals · schema · sitemap · page inventory',
                },
              ]}
              scope={
                <p>
                  Every sitemap URL found at {project.domain} is fetched and scored, plus the five
                  site-level checks. Runs are rate-limited to three per minute.
                </p>
              }
              onStart={async () => {
                const queued = await runTechnicalAudit(projectId);
                setJob({
                  id: queued.jobId,
                  startedAt: new Date().toISOString(),
                  status: { status: 'waiting' },
                });
              }}
              onStarted={() => setStartOpen(false)}
              onReconcile={() => void checkJob()}
              reconcileHref={`/projects/${projectId}/runs`}
              
              runInFlight={Boolean(stripRun)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * `TechnicalAudit` has no `status` column — a row is only ever written once
 * the run finishes, so the list endpoint sends none. `AuditRunSummary.status`
 * is typed as required because AEO's row genuinely carries one across its
 * async lifecycle, but a technical-audit row reaching this page always means
 * "a completed run exists"; there is no persisted in-progress or failed state
 * to report here (an in-flight run is tracked separately, through `job`).
 * Treating a missing status as `completed` rather than indexing into it is
 * what keeps that difference from crashing the page.
 */
function runTone(
  status: string | undefined,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'unmeasured' {
  switch (status ?? 'completed') {
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

function runLabel(status: string | undefined): string {
  const value = status ?? 'completed';
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * The audit row's own status vocabulary into `RunStatus`. An unknown string
 * maps to `queued`, which claims the least; a missing one (see above) maps to
 * `completed`, which is the only state a stored row can actually be in.
 */
function runStatus(status: string | undefined): RunStatus {
  const value = status ?? 'completed';
  switch (value) {
    case 'completed':
    case 'partial':
    case 'failed':
    case 'running':
    case 'cancelled':
      return value;
    default:
      return 'queued';
  }
}

/** The pipeline queue's status vocabulary into `RunStatus`. */
function jobStatusToRunStatus(status: PipelineJobStatus['status']): RunStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'running';
    case 'not_found':
      return 'failed';
    default:
      return 'queued';
  }
}
