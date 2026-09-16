'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendChart, type TrendDatum } from '@/components/charts/TrendChart';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
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
import type { CoverageSummary, RunStatus } from '@/types';
import { getProjectDetail, type ProjectDetailWire } from '@/services/projects';
import {
  getGoogleReadiness,
  getSearchConsoleSummary,
  getSeoAudit,
  getSeoAuditJob,
  listSeoAudits,
  runSeoAudit,
  type AuditRunSummary,
  type GoogleReadiness,
  type PipelineJobStatus,
  type SearchConsoleSummary,
  type SeoAuditDetail,
} from '@/services/research';

/**
 * SE01 — Search performance.
 *
 * design_plan.md §4.3: *"GSC summary + SEO audit history, clicks/impressions/
 * CTR/position, queries/pages, opportunities"*, under the audit-hub contract:
 * run configuration is a deliberate drawer, never a side effect of rendering.
 *
 * Two facts this page keeps separate, because conflating them is how an
 * operator draws the wrong conclusion:
 *
 *  1. **The live GSC read and a stored audit are different measurements over
 *     different windows.** The tiles above come from a rolling live read of
 *     Search Console and carry that window and its date range; the run history
 *     below lists stored runs and their own `windowDays`. Neither is presented
 *     as the other, and no delta is drawn between them — Google reports the
 *     most recent days incompletely, so the two windows are not comparable.
 *  2. **A connection, a mapped resource and a readable resource are three
 *     states (§4 connections family).** An unmapped project is told to choose a
 *     site; a disconnected one is told to connect. Neither reads as "no data".
 *  3. **Only a real series is charted.** The live read returns one total per
 *     metric for its window and no daily rows, so it is not charted at all; the
 *     per-day charts come from the newest stored run, which did store a date
 *     breakdown, and each carries its own table (§3.4).
 */

/** Window in days, kept as a string so the URL round-trips exactly. */
const WINDOW_DEFAULTS = { days: '28' };

const WINDOW_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '28', label: 'Last 28 days' },
  { value: '90', label: 'Last 90 days' },
];

/** GSC reports a rolling 1–90 day window; the backend rejects anything else. */
function clampDays(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 28;
  return Math.min(90, Math.max(1, Math.round(parsed)));
}

export default function SearchPerformancePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [windowState, setWindowState] = useUrlState(WINDOW_DEFAULTS);
  const days = clampDays(windowState.days);

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [readiness, setReadiness] = useState<GoogleReadiness | null>(null);
  const [summary, setSummary] = useState<SearchConsoleSummary | null>(null);
  const [audits, setAudits] = useState<AuditRunSummary[] | null>(null);
  const [latestRun, setLatestRun] = useState<SeoAuditDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [summaryError, setSummaryError] = useState<ApiError | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [job, setJob] = useState<{ id: string; startedAt: string; status: PipelineJobStatus } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setSummaryError(null);
        const [projectResult, readinessResult, listResult] = await Promise.all([
          getProjectDetail(projectId, { signal }),
          getGoogleReadiness(projectId, 'search-console', { signal }),
          listSeoAudits(projectId, { signal }),
        ]);
        setProject(projectResult);
        setReadiness(readinessResult);
        setAudits(listResult.audits);

        // Only read Search Console once a site is actually mapped to this
        // project: an unmapped read is a guaranteed 404, and reporting that as
        // a failure would hide the real prerequisite (§3.5).
        if (readinessResult.selected) {
          try {
            setSummary(await getSearchConsoleSummary(projectId, days, { signal }));
          } catch (caught) {
            if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
            setSummary(null);
            setSummaryError(toApiError(caught));
          }
        } else {
          setSummary(null);
        }

        // The newest stored run, read for its coverage block only.
        const newest = listResult.audits[0];
        if (newest) {
          try {
            setLatestRun(await getSeoAudit(projectId, newest.id, { signal }));
          } catch {
            setLatestRun(null);
          }
        } else {
          setLatestRun(null);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, days],
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
      const status = await getSeoAuditJob(projectId, job.id);
      setJob((current) => (current ? { ...current, status } : current));
      if (status.status === 'completed' || status.status === 'failed') await load();
    } catch (caught) {
      setJobError(toApiError(caught).message);
    }
  }, [job, projectId, load]);

  /**
   * URL-inspection coverage for the newest stored run.
   *
   * `pagesInspected` is how many URLs this run actually inspected against the
   * per-run budget; the pages list is what Search Console reported for the
   * window. A page with no `coverageState` was never inspected — that is a
   * deferred check, and it is named as one rather than being reported as "not
   * indexed", which is a different and much stronger claim.
   */
  const coverage = useMemo((): CoverageSummary | null => {
    if (!latestRun) return null;
    const pages = latestRun.pages;
    const inspected = pages.filter((page) => page.coverageState !== null);
    const notInspected = pages.filter((page) => page.coverageState === null);
    const withIssues = inspected.filter((page) => page.issues.length > 0);
    return {
      expectedCount: pages.length,
      successfulCount: inspected.length,
      failed: withIssues.slice(0, 25).map((page) => ({
        name: page.url,
        reason:
          page.issues
            .map((issue) => `${issue.code}: ${issue.detail}`)
            .join(' ') || 'An issue was recorded without a detail string.',
      })),
      deferred: notInspected.slice(0, 25).map((page) => ({
        name: page.url,
        reason:
          'Search Console reported this URL for the window, but it fell outside this run\'s URL-inspection budget, so its indexing state was not measured.',
      })),
    };
  }, [latestRun]);

  /**
   * The per-day series inside the newest stored run.
   *
   * The **live** Search Console read on this page returns one total per metric
   * for the whole window and no daily breakdown, so it cannot be charted — a
   * single point is not a series, and drawing one would be inventing data. The
   * daily series that does exist is the one the SEO audit stored, which is why
   * these charts are labelled with that run and its window rather than with the
   * filter above: the two cover different periods and are not interchangeable.
   *
   * `at` is UTC midnight and `label` keeps the reported day verbatim, so a
   * viewer west of UTC still sees the day Google reported rather than the one
   * before it (§6.3: the window's dates are the source's, not the reader's).
   */
  const dailySeries = useMemo(() => {
    const rows = latestRun?.metrics?.timeseries ?? [];
    return rows
      .map((row) => ({ date: row.date, at: Date.parse(`${row.date}T00:00:00Z`), clicks: row.clicks, impressions: row.impressions }))
      .filter((row) => Number.isFinite(row.at));
  }, [latestRun]);

  const clicksPoints = useMemo<TrendDatum[]>(
    () =>
      dailySeries.map((row) => ({
        id: `clicks-${row.date}`,
        at: row.at,
        value: row.clicks,
        segment: 0,
        label: row.date,
      })),
    [dailySeries],
  );

  const impressionPoints = useMemo<TrendDatum[]>(
    () =>
      dailySeries.map((row) => ({
        id: `impressions-${row.date}`,
        at: row.at,
        value: row.impressions,
        segment: 0,
        label: row.date,
      })),
    [dailySeries],
  );

  const auditColumns: ReadonlyArray<ColumnDef<AuditRunSummary>> = [
    {
      key: 'createdAt',
      header: 'Run',
      accessor: (row) => row.createdAt ?? '',
      sortable: true,
      width: 200,
      render: (row) =>
        row.createdAt ? (
          <Timestamp value={row.createdAt} />
        ) : (
          <span className="text-muted-foreground">Time not recorded</span>
        ),
    },
    {
      key: 'score',
      header: 'SEO score',
      accessor: (row) => row.score,
      sortable: true,
      align: 'right',
      width: 110,
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
      // `SeoAudit` has no `status` column — see the note on `runTone` below —
      // so every stored row means "completed" and this must not read as blank.
      render: (row) => <StatusPill label={runLabel(row.status)} tone={runTone(row.status)} />,
    },
    {
      key: 'open',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Link
          href={`/projects/${projectId}/research/search/runs/${row.id}`}
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
        <PageHeader title="Search performance" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!audits || !project || !readiness) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const mappedSite = readiness.selected?.resourceId ?? null;
  const stripRun =
    job && job.status.status !== 'completed'
      ? { id: job.id, status: jobStatusToRunStatus(job.status.status), startedAt: job.startedAt }
      : null;

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project.name,
          // The mapped Search Console property can differ from the project
          // domain (a sc-domain property, or a subdirectory). The banner shows
          // the property actually being read, not an assumption.
          domain: mappedSite ?? project.domain,
          mode: 'live',
          runLabel: `Live window · last ${days} days`,
        }}
      />

      <PageHeader
        title="Search performance"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{mappedSite ?? 'No site mapped'}</span>
            {summary ? (
              <span>
                Search Console window {summary.range.startDate} to {summary.range.endDate}
              </span>
            ) : null}
          </span>
        }
        status={
          readiness.selected ? (
            <StatusPill label="Search Console mapped" tone="success" />
          ) : readiness.connected ? (
            <StatusPill label="Connected, no site chosen" tone="warning" />
          ) : (
            <StatusPill label="Not connected" tone="unmeasured" />
          )
        }
        primaryAction={{ label: 'Start SEO audit', onClick: () => setStartOpen(true) }}
        secondaryActions={
          <>
            {audits[0] ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/research/search/runs/${audits[0].id}`}>
                  Open latest run
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/connections`}>Connections</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      {/* The window applies to the live read only; it is in the URL so a copied
          link reproduces the same view (§3.2). */}
      <FilterBar
        defaults={WINDOW_DEFAULTS}
        value={windowState}
        onChange={setWindowState}
        hideSearch
        controls={[
          {
            kind: 'select',
            key: 'days',
            label: 'Search Console window',
            options: WINDOW_OPTIONS,
            allLabel: 'Last 28 days',
          },
        ]}
        summary={
          <span className="text-meta text-muted-foreground">
            Google reports the two most recent days incompletely; stored runs account for that lag.
          </span>
        }
      />

      {/* Four distinct states: not connected, connected but unmapped, read
          failed, and read succeeded. None of them is rendered as another. */}
      {!readiness.connected ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="Search Console performance"
              prerequisite="a Google account has to be connected before Search Console can be read"
              action={{
                label: 'Connect Search Console',
                href: `/projects/${projectId}/connections`,
              }}
            />
          </CardContent>
        </Card>
      ) : !readiness.selected ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="source-unmapped"
              sourceName="Google Search Console"
              action={{
                label: 'Choose the site',
                href: `/projects/${projectId}/connections/google/search-console`,
              }}
            />
          </CardContent>
        </Card>
      ) : summaryError ? (
        <ErrorState
          error={summaryError}
          onRetry={() => void load()}
          providerName="Google Search Console"
          preserveNotice="The stored SEO runs below are unaffected by this read."
        />
      ) : summary ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Clicks"
            value={summary.totals.clicks}
            unit="clicks"
            windowLabel={`Last ${summary.range.days} days`}
            sourceDate={{ date: summary.range.endDate, sourceName: 'Google Search Console' }}
            provenance="measured"
            note="A live read of Search Console, not a stored run."
          />
          <MetricTile
            label="Impressions"
            value={summary.totals.impressions}
            unit="impressions"
            windowLabel={`Last ${summary.range.days} days`}
            sourceDate={{ date: summary.range.endDate, sourceName: 'Google Search Console' }}
            provenance="measured"
          />
          <MetricTile
            label="Click-through rate"
            value={summary.totals.ctr * 100}
            unit="%"
            windowLabel={`Last ${summary.range.days} days`}
            sourceDate={{ date: summary.range.endDate, sourceName: 'Google Search Console' }}
            provenance="measured"
            direction="higher-is-better"
          />
          <MetricTile
            label="Average position"
            value={summary.totals.position}
            unit="position"
            windowLabel={`Last ${summary.range.days} days`}
            sourceDate={{ date: summary.range.endDate, sourceName: 'Google Search Console' }}
            provenance="measured"
            direction="lower-is-better"
          />
        </div>
      ) : null}

      {summary ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Top queries in this window</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {summary.topQueries.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  Search Console returned no query rows for this window. That is an empty result for the
                  window, not a failed read.
                </p>
              ) : (
                <DataTable
                  caption="Top queries reported by Search Console for this window"
                  columns={keyMetricColumns('Query')}
                  rows={summary.topQueries}
                  getRowId={(row) => `q-${row.key}`}
                  emptyState={<EmptyState variant="no-results" />}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Top pages in this window</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {summary.topPages.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  Search Console returned no page rows for this window.
                </p>
              ) : (
                <DataTable
                  caption="Top pages reported by Search Console for this window"
                  columns={keyMetricColumns('Page')}
                  rows={summary.topPages}
                  getRowId={(row) => `p-${row.key}`}
                  emptyState={<EmptyState variant="no-results" />}
                />
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/*
        Clicks and impressions are two measures of very different scale, so they
        are drawn as two charts rather than one plot with two y-scales: a shared
        axis across them would invent a correlation between the lines.

        Both come from the newest STORED run, not from the live read above —
        the tiles read the window selected in the filter, this reads the window
        that run was configured with, and Google reports the most recent days
        incompletely. The two are different measurements and neither is
        presented as the other.
      */}
      {latestRun ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Clicks per day, from the latest stored run</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <TrendChart
                seriesLabel="Clicks"
                points={clicksPoints}
                // Search Console dates are calendar days, not instants: the
                // axis is anchored in UTC so the day label cannot drift.
                timeZone="UTC"
                formatValue={(value) => `${formatNumber(value)} clicks`}
                formatAxisTick={(value) => formatNumber(value)}
                description={
                  <>
                    The {latestRun.windowDays}-day window this run ({latestRun.id}) read, ending{' '}
                    <Timestamp value={latestRun.createdAt} />. Each point is one calendar day exactly
                    as Search Console reported it, not shifted into a viewer&rsquo;s timezone. The
                    window filter above does not move this chart.
                  </>
                }
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="a daily clicks series"
                    prerequisite="the run's Search Analytics read has to return a date breakdown before a series exists — this one stored no daily rows."
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                Impressions per day, from the latest stored run
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <TrendChart
                seriesLabel="Impressions"
                points={impressionPoints}
                timeZone="UTC"
                formatValue={(value) => `${formatNumber(value)} impressions`}
                formatAxisTick={(value) => formatNumber(value)}
                description={
                  <>
                    The same window, the same days and the same mapped property as the clicks chart.
                    Impressions run several orders of magnitude above clicks, so the two are drawn as
                    separate charts rather than against two y-scales on one plot: two scales can be
                    aligned at any angle, and that choice alone would invent a relationship between
                    the lines.
                  </>
                }
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="a daily impressions series"
                    prerequisite="the run's Search Analytics read has to return a date breakdown before a series exists — this one stored no daily rows."
                  />
                }
              />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <RunStatusStrip
        run={
          stripRun ?? {
            id: audits[0]?.id ?? 'none',
            status: audits[0] ? runStatus(audits[0].status) : 'queued',
            startedAt: audits[0]?.createdAt ?? new Date().toISOString(),
            completedAt: audits[0]?.completedAt ?? undefined,
          }
        }
        lastSuccessful={
          audits[0]?.completedAt
            ? {
                id: audits[0].id,
                completedAt: audits[0].completedAt,
                href: `/projects/${projectId}/research/search/runs/${audits[0].id}`,
              }
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
        {coverage && latestRun ? (
          <CoveragePanel
            summary={coverage}
            title="URL inspection coverage in the latest run"
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${projectId}/research/search/runs/${latestRun.id}`}>
                  Open that run
                </Link>
              </Button>
            }
            contextNote={
              <span>
                The latest stored run read a {latestRun.windowDays}-day window ending{' '}
                <Timestamp value={latestRun.createdAt} />. Search Console reports every URL with traffic;
                this run inspected {formatNumber(latestRun.pagesInspected)} of them, which is the coverage
                the per-URL indexing results actually have.
              </span>
            }
          />
        ) : null}
      </RunStatusStrip>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">SEO audit history</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {audits.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="an SEO audit"
              prerequisite="Search Console must be mapped to this project, and a run has to be started deliberately."
              action={{ label: 'Start the first audit', onClick: () => setStartOpen(true) }}
            />
          ) : (
            <DataTable
              caption="Stored SEO audit runs"
              columns={auditColumns}
              rows={audits}
              getRowId={(row) => row.id}
              defaultSort={{ key: 'createdAt', direction: 'desc' }}
              // No status filter: `SeoAudit` has no `status` column (see the
              // note on `runTone` below), so every stored row is "completed"
              // — offering "Partial"/"Failed" options here would filter
              // against a state that can never actually appear.
              emptyState={<EmptyState variant="no-results" />}
            />
          )}
        </CardContent>
      </Card>

      <Sheet open={startOpen} onOpenChange={setStartOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto bg-surface sm:max-w-xl">
          <SheetHeader className="space-y-2 text-left">
            <SheetTitle>Start an SEO audit</SheetTitle>
            <SheetDescription className="text-table text-muted-foreground">
              Reads Search Console for the mapped site and stores a scored run. Nothing has been started
              yet.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-5">
            <RunConfigurator
              startLabel="Start SEO audit"
              prerequisites={[
                {
                  label: 'Google Search Console is connected',
                  met: readiness.connected,
                  detail: readiness.connected
                    ? 'An account has granted access.'
                    : 'Connect Search Console before running an SEO audit.',
                },
                {
                  label: 'A Search Console site is mapped to this project',
                  met: Boolean(readiness.selected),
                  detail: readiness.selected
                    ? `Reading ${readiness.selected.resourceId}.`
                    : 'The audit reads a mapped property, not any property the account can see.',
                },
                {
                  label: 'The window used here is the live filter value',
                  met: true,
                  blocking: false,
                  detail: `This start uses the ${days}-day window selected on the page, within the accepted 7–90 day range.`,
                },
              ]}
              parameters={[
                { key: 'site', label: 'Mapped site', value: readiness.selected?.resourceId ?? 'None' },
                { key: 'window', label: 'Window', value: `${days} days` },
                {
                  key: 'reads',
                  label: 'Reads',
                  value: 'Search Analytics (totals, queries, pages, dates) · URL Inspection · Sitemaps',
                },
              ]}
              scope={
                <p>
                  Search Console is read for {readiness.selected?.resourceId ?? 'the mapped site'} over the
                  last {days} days, with the same-length preceding window read for comparison. Up to 40
                  URLs are then URL-inspected individually.
                </p>
              }
              onStart={async () => {
                const queued = await runSeoAudit(projectId, { windowDays: days });
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

/** Shared column set for the two Search Console top-N tables. */
function keyMetricColumns(keyHeader: string): ReadonlyArray<ColumnDef<SearchConsoleSummary['topQueries'][number]>> {
  return [
    {
      key: 'key',
      header: keyHeader,
      accessor: (row) => row.key,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[26rem] truncate" title={row.key}>
          {row.key}
        </span>
      ),
    },
    {
      key: 'clicks',
      header: 'Clicks',
      accessor: (row) => row.clicks,
      sortable: true,
      align: 'right',
      width: 100,
      render: (row) => <span className="tabular-nums">{formatNumber(row.clicks)}</span>,
    },
    {
      key: 'impressions',
      header: 'Impressions',
      accessor: (row) => row.impressions,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{formatNumber(row.impressions)}</span>,
    },
    {
      key: 'ctr',
      header: 'CTR',
      accessor: (row) => row.ctr,
      sortable: true,
      align: 'right',
      width: 90,
      render: (row) => <span className="tabular-nums">{(row.ctr * 100).toFixed(1)}%</span>,
    },
    {
      key: 'position',
      header: 'Avg position',
      accessor: (row) => row.position,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{row.position.toFixed(1)}</span>,
    },
  ];
}

/**
 * `SeoAudit` has no `status` column — a row is only ever written once the
 * run finishes, so the list endpoint sends none, even though
 * `AuditRunSummary.status` is typed as required (it is, genuinely, for AEO's
 * row). A stored SEO audit reaching this page always means "completed"; there
 * is no persisted in-progress or failed state to report — an in-flight run is
 * tracked separately, through `job`.
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
    default:
      return 'unmeasured';
  }
}

function runLabel(status: string | undefined): string {
  const value = status ?? 'completed';
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

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

function jobStatusToRunStatus(status: PipelineJobStatus['status']): RunStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'not_found':
      return 'failed';
    case 'active':
      return 'running';
    default:
      return 'queued';
  }
}
