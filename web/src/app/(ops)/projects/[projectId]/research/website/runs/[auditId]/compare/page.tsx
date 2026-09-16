'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChangeComparison, type ChangeDirection } from '@/components/patterns/ChangeComparison';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { ChangeComparisonData } from '@/types';
import {
  getTechnicalComparison,
  getTechnicalTrend,
  type AuditDelta,
  type TechnicalComparison,
  type TechnicalTrendPoint,
} from '@/services/research';

/**
 * TA03 — Technical comparison.
 *
 * design_plan.md §4.3: *"Score/metric deltas, added/removed/improved/regressed
 * pages, baseline labels"*. §6.4 (G13) is the rule that shapes it: **a
 * difference between two runs measured under different conditions is not a
 * measured change**, so `ChangeComparison` withholds the delta entirely unless
 * the caller asserts comparability.
 *
 * The comparison key available for a technical run is the **target URL** — the
 * backend does not return a comparability flag, so this screen derives the
 * assertion from the two runs' recorded targets (read from the trend series,
 * which carries `targetUrl` per run) and answers conservatively when either run
 * cannot be identified. Every `ChangeComparison` therefore either states a
 * change it can stand behind, or states that no change is being claimed.
 */

/** One row of the page-churn table — a page and how it moved. */
interface PageChangeRow {
  url: string;
  change: 'added' | 'removed' | 'improved' | 'regressed';
  from: number | null;
  to: number | null;
}

export default function TechnicalComparisonPage() {
  const { projectId, auditId } = useParams<{ projectId: string; auditId: string }>();

  const [comparison, setComparison] = useState<TechnicalComparison | null>(null);
  const [trend, setTrend] = useState<TechnicalTrendPoint[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [comparisonResult, trendResult] = await Promise.all([
          getTechnicalComparison(projectId, auditId, { signal }),
          // The trend series is what carries each run's target URL, which is
          // the comparability key this screen needs but the comparison and the
          // audit list do not both return.
          getTechnicalTrend(projectId, { signal, limit: 200 }),
        ]);
        setComparison(comparisonResult);
        setTrend(trendResult.history);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, auditId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const byId = useMemo(() => new Map(trend.map((point) => [point.auditId, point])), [trend]);

  /** Whether the two runs may be compared at all, and why not when they may not. */
  const comparability = useMemo((): { compatible: boolean; note: string } => {
    if (!comparison?.previousAuditId) {
      return { compatible: false, note: 'There is no previous run to compare against.' };
    }
    const current = byId.get(comparison.currentAuditId);
    const previous = byId.get(comparison.previousAuditId);
    if (!current || !previous) {
      return {
        compatible: false,
        note:
          'One of the two runs is not in this project\'s score history, so its target URL cannot be ' +
          'confirmed. Without that, the difference between them is not known to be a measurement of change.',
      };
    }
    if (current.targetUrl !== previous.targetUrl) {
      return {
        compatible: false,
        note: `The audited target changed between these runs: ${previous.targetUrl} → ${current.targetUrl}. A different target is a different measurement, so the score movement is withheld rather than reported as improvement or decline.`,
      };
    }
    return { compatible: true, note: '' };
  }, [comparison, byId]);

  const pageRows = useMemo((): PageChangeRow[] => {
    if (!comparison) return [];
    const { added, removed, improved, regressed } = comparison.pageChanges;
    return [
      ...added.map((url): PageChangeRow => ({ url, change: 'added', from: null, to: null })),
      ...removed.map((url): PageChangeRow => ({ url, change: 'removed', from: null, to: null })),
      ...improved.map((p): PageChangeRow => ({ url: p.url, change: 'improved', from: p.from, to: p.to })),
      ...regressed.map((p): PageChangeRow => ({ url: p.url, change: 'regressed', from: p.from, to: p.to })),
    ];
  }, [comparison]);

  const columns: ReadonlyArray<ColumnDef<PageChangeRow>> = [
    {
      key: 'url',
      header: 'Page',
      accessor: (row) => row.url,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[34rem] truncate font-mono text-meta" title={row.url}>
          {row.url}
        </span>
      ),
    },
    {
      key: 'change',
      header: 'Change',
      accessor: (row) => row.change,
      sortable: true,
      width: 140,
      render: (row) => <span className="text-table">{changeLabel(row.change)}</span>,
    },
    {
      key: 'from',
      header: 'Before',
      accessor: (row) => row.from,
      align: 'right',
      width: 100,
      emptyLabel: 'Not in the earlier run',
      render: (row) =>
        row.from !== null ? <span className="tabular-nums">{formatNumber(row.from)}</span> : null,
    },
    {
      key: 'to',
      header: 'After',
      accessor: (row) => row.to,
      align: 'right',
      width: 100,
      emptyLabel: 'Not in this run',
      render: (row) => (row.to !== null ? <span className="tabular-nums">{formatNumber(row.to)}</span> : null),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Technical comparison" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!comparison) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const currentPoint = byId.get(comparison.currentAuditId);
  const previousPoint = comparison.previousAuditId ? byId.get(comparison.previousAuditId) : undefined;

  /**
   * Metrics the two runs both measured. A metric one side never produced is
   * not a change — it is a first measurement, and it is listed separately
   * below rather than drawn as a delta from nothing.
   */
  const comparableDeltas = comparison.deltas.filter(
    (d): d is AuditDelta & { previous: number; current: number } => d.previous !== null && d.current !== null,
  );
  const firstMeasurements = comparison.deltas.filter((d) => d.previous === null);

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          projectName: 'This project',
          domain: currentPoint?.targetUrl ?? previousPoint?.targetUrl,
          mode: 'live',
          runLabel: `Run ${comparison.currentAuditId}`,
        }}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/website/runs/${comparison.currentAuditId}`}>
                Open this run
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/website`}>Back to website health</Link>
            </Button>
          </>
        }
      />

      <PageHeader
        title="Technical comparison"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Baseline run <span className="font-mono">{comparison.previousAuditId ?? 'none'}</span>
            </span>
            {comparison.previousAt ? (
              <span>
                <Timestamp value={comparison.previousAt} />
              </span>
            ) : null}
            <span>
              Current run <span className="font-mono">{comparison.currentAuditId}</span>
            </span>
            <span>
              <Timestamp value={comparison.currentAt} />
            </span>
          </span>
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {!comparison.previousAuditId ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="no-comparison-baseline"
              action={{
                label: 'Open the run',
                href: `/projects/${projectId}/research/website/runs/${comparison.currentAuditId}`,
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {!comparability.compatible ? (
            <Alert>
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>No change figure is claimed</AlertTitle>
              <AlertDescription>{comparability.note}</AlertDescription>
            </Alert>
          ) : null}

          <section aria-labelledby="metrics-heading" className="space-y-3">
            <h2 id="metrics-heading" className="text-subsection font-semibold text-foreground">
              Metric movements
            </h2>

            {comparableDeltas.length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <EmptyState
                    variant="not-measured"
                    subject="a comparable metric"
                    prerequisite="both runs must have measured the same metric for a change to exist."
                  />
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {comparableDeltas.map((delta) => (
                  <ChangeComparison
                    key={delta.metric}
                    data={buildComparisonData(delta, comparison, comparability.compatible)}
                    changeMode="absolute"
                    direction={directionFor(delta)}
                    formatValue={(value, unit) =>
                      `${formatNumber(value)}${unit ? ` ${unit}` : ''}`
                    }
                    methodologyNote={
                      comparability.compatible ? undefined : <p>{comparability.note}</p>
                    }
                  />
                ))}
              </div>
            )}

            {firstMeasurements.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">
                    Measured for the first time in this run
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  <ul className="divide-y divide-border">
                    {firstMeasurements.map((delta) => (
                      <li key={delta.metric} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="text-table text-foreground">{delta.label}</span>
                        <span className="text-table tabular-nums">
                          {delta.current !== null ? formatNumber(delta.current) : notMeasuredLabel()}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-meta text-muted-foreground">
                    The earlier run produced no value for these metrics, so there is nothing to compare
                    them against. They are listed as first measurements rather than drawn as an increase.
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </section>

          <section aria-labelledby="pages-heading" className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle id="pages-heading" className="text-subsection">
                  Page-level change
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {pageRows.length === 0 ? (
                  <p className="text-table text-muted-foreground">
                    No page was added, removed, improved or regressed between these two runs. That is a
                    real result — the inventory is unchanged on the metric this backend diffs, not an
                    absence of data.
                  </p>
                ) : (
                  <DataTable
                    caption="Pages added, removed, improved or regressed between the two runs"
                    columns={columns}
                    rows={pageRows}
                    getRowId={(row) => `${row.change}-${row.url}`}
                    minTableWidth="52rem"
                    filters={[
                      {
                        id: 'change',
                        label: 'Change',
                        options: [
                          { value: 'added', label: 'Added' },
                          { value: 'removed', label: 'Removed' },
                          { value: 'improved', label: 'Improved' },
                          { value: 'regressed', label: 'Regressed' },
                        ],
                        getValue: (row) => row.change,
                      },
                    ]}
                    emptyState={<EmptyState variant="no-results" />}
                  />
                )}
                <p className="mt-2 text-meta text-muted-foreground">
                  &ldquo;Improved&rdquo; and &ldquo;regressed&rdquo; are per-page score movements of any
                  size, ordered by the size of the swing. A page present in only one of the two runs is
                  listed as added or removed rather than as a movement.
                </p>
              </CardContent>
            </Card>
          </section>

          {/*
            §6.4 requires the deployments inside the window to be listed as
            context. This backend keeps no deployment record, so the section
            states that plainly instead of leaving a reader to assume the
            window was quiet.
          */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Deployments in this window</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <p className="text-table text-muted-foreground">
                Cailyx has no record of site deployments or changes for this project, so none can be
                listed between these two runs. The comparison above therefore cannot say whether the
                site changed while it was being measured. Deployment tracking against work items is
                design_plan G06.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <p className="text-meta text-muted-foreground">
        This screen is a comparison of two stored runs. It does not start a run, and it does not change
        either run&rsquo;s stored results.
      </p>
    </div>
  );
}

/**
 * The two sides of one metric, in `ChangeComparison`'s shape.
 *
 * `methodologyCompatible` is passed through as the literal boolean the caller
 * derived — never as a truthy value — so a run pair whose comparability could
 * not be established renders with the delta withheld.
 */
function buildComparisonData(
  delta: AuditDelta & { previous: number; current: number },
  comparison: TechnicalComparison,
  compatible: boolean,
): ChangeComparisonData {
  return {
    before: {
      id: comparison.previousAuditId ?? 'unknown previous run',
      date: comparison.previousAt ?? comparison.currentAt,
      value: delta.previous,
    },
    after: {
      id: comparison.currentAuditId,
      date: comparison.currentAt,
      value: delta.current,
    },
    unit: unitFor(delta.metric),
    methodologyCompatible: compatible,
    // No deployment ledger exists to read from (design_plan G06); the section
    // further down states that rather than showing an empty list here.
  };
}

/**
 * The unit a metric is expressed in. The backend's delta registry carries a
 * `higherIsBetter` flag but no unit, so this is the presentation layer's own
 * table — keyed on the stable metric keys the backend documents.
 */
function unitFor(metric: string): string {
  switch (metric) {
    case 'lcp':
    case 'inp':
      return 'ms';
    case 'cls':
      return '';
    case 'composite':
    case 'agentReadiness':
    case 'lighthousePerformance':
    case 'lighthouseSeo':
    case 'lighthouseAccessibility':
    case 'pageAverageScore':
      return '/ 100';
    case 'openFailures':
      return 'checks';
    case 'sitemapUrls':
    case 'pagesWithoutJsonLd':
    case 'pagesBadTitle':
    case 'pagesBadMeta':
    case 'blockedBots':
      return 'pages';
    case 'sitemapStaleDays':
      return 'days';
    default:
      return '';
  }
}

function directionFor(delta: AuditDelta): ChangeDirection {
  return delta.higherIsBetter ? 'higher-is-better' : 'lower-is-better';
}

function changeLabel(change: PageChangeRow['change']): string {
  switch (change) {
    case 'added':
      return 'Added since the baseline';
    case 'removed':
      return 'Removed since the baseline';
    case 'improved':
      return 'Score improved';
    case 'regressed':
      return 'Score regressed';
  }
}
