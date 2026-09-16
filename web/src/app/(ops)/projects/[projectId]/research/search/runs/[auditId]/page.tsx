'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChangeComparison } from '@/components/patterns/ChangeComparison';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunStatusStrip } from '@/components/patterns/RunStatusStrip';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import type { ChangeComparisonData, CoverageSummary } from '@/types';
import {
  compareSeoAudit,
  getSeoAudit,
  listSeoAudits,
  submitSeoSitemaps,
  type AuditDelta,
  type AuditRunSummary,
  type SeoAuditDetail,
  type SeoComparison,
  type SeoFinding,
  type SeoPageRow,
  type SeoQueryRow,
} from '@/services/research';

/**
 * SE02 — SEO run detail.
 *
 * design_plan.md §4.3: *"Run findings, queries/pages, comparison, sitemap
 * actions, window and connection"*, under the run/evidence-detail contract:
 * *"Sticky scope/run header, status or comparison pair, section index, evidence
 * table, detail drawer; raw answer/check behind disclosure; copy
 * URL/reproduction text with clear source."*
 *
 * Three rules this screen is built to keep:
 *
 *  1. **The window is part of every number.** Search Console answers a rolling
 *     window, so the run's own `windowDays` and its two date endpoints are
 *     stated next to the metrics. A comparison is only drawn when both runs
 *     read the same window length — the comparison key for this metric set —
 *     and is withheld with the reason when they did not.
 *  2. **Un-inspected is not "not indexed".** This run URL-inspects a bounded
 *     number of pages; a page outside that budget has no indexing state, and
 *     the coverage panel reports it as deferred rather than as a problem.
 *  3. **Submitting sitemaps is an explicit action with a previewed effect.**
 *     It is behind `ConfirmDialog`, and its result is reported as what Google
 *     accepted, not as a re-crawl.
 */

type OpenEvidence =
  | { kind: 'finding'; finding: SeoFinding }
  | { kind: 'page'; page: SeoPageRow }
  | { kind: 'query'; query: SeoQueryRow };

export default function SeoRunPage() {
  const { projectId, auditId } = useParams<{ projectId: string; auditId: string }>();

  const [audit, setAudit] = useState<SeoAuditDetail | null>(null);
  const [comparison, setComparison] = useState<SeoComparison | null>(null);
  const [runs, setRuns] = useState<AuditRunSummary[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<OpenEvidence | null>(null);

  const [sitemapOpen, setSitemapOpen] = useState(false);
  const [sitemapResult, setSitemapResult] = useState<string[] | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [auditResult, comparisonResult, listResult] = await Promise.all([
          getSeoAudit(projectId, auditId, { signal }),
          compareSeoAudit(projectId, auditId, { signal }),
          // Both runs' window lengths live on the list rows, and the window is
          // this metric set's comparison key.
          listSeoAudits(projectId, { signal }),
        ]);
        setAudit(auditResult);
        setComparison(comparisonResult);
        setRuns(listResult.audits);
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

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);

  /** Whether the two runs may be compared, and what changed in the key. */
  const comparability = useMemo((): { compatible: boolean; note: string } => {
    if (!comparison?.previousAuditId) {
      return { compatible: false, note: 'There is no previous run to compare against.' };
    }
    const current = runById.get(comparison.currentAuditId);
    const previous = runById.get(comparison.previousAuditId);
    if (!current || !previous) {
      return {
        compatible: false,
        note:
          'One of the two runs is no longer in this project\'s run list, so its window length cannot be ' +
          'confirmed. Without it the two readings are not known to cover the same period.',
      };
    }
    const currentWindow = current.windowDays;
    const previousWindow = previous.windowDays;
    if (typeof currentWindow !== 'number' || typeof previousWindow !== 'number') {
      return {
        compatible: false,
        note: 'The window length of one of the two runs was not recorded, so the readings cannot be aligned.',
      };
    }
    if (currentWindow !== previousWindow) {
      return {
        compatible: false,
        note: `The reporting window changed between these runs: ${previousWindow} days → ${currentWindow} days. Search Console returns totals for the window it was asked for, so a longer window is a larger period being counted — not an improvement.`,
      };
    }
    return { compatible: true, note: '' };
  }, [comparison, runById]);

  const coverage = useMemo((): CoverageSummary | null => {
    if (!audit) return null;
    const inspected = audit.pages.filter((page) => page.coverageState !== null);
    const notInspected = audit.pages.filter((page) => page.coverageState === null);
    return {
      expectedCount: audit.pages.length,
      successfulCount: inspected.length,
      failed: audit.pages
        .filter((page) => page.coverageState !== null && page.issues.length > 0)
        .slice(0, 25)
        .map((page) => ({
          name: page.url,
          reason: page.issues.map((issue) => `${issue.code}: ${issue.detail}`).join(' ') ||
            'An issue was recorded without a detail string.',
        })),
      deferred: notInspected.slice(0, 25).map((page) => ({
        name: page.url,
        reason:
          'Reported by Search Console for this window but outside the run\'s URL-inspection budget, so its indexing state was not measured.',
      })),
    };
  }, [audit]);

  const findingColumns: ReadonlyArray<ColumnDef<SeoFinding>> = [
    {
      key: 'severity',
      header: 'Severity',
      accessor: (row) => row.severity,
      sortable: true,
      width: 110,
      render: (row) => <StatusPill label={titleCase(row.severity)} tone={severityTone(row.severity)} />,
    },
    {
      key: 'status',
      header: 'Result',
      accessor: (row) => row.status,
      sortable: true,
      width: 110,
      render: (row) => <StatusPill label={findingStatusLabel(row.status)} tone={findingStatusTone(row.status)} />,
    },
    {
      key: 'title',
      header: 'Finding',
      accessor: (row) => row.title,
      sortable: true,
      render: (row) => <span className="block max-w-[30rem] text-foreground">{row.title}</span>,
    },
    {
      key: 'affected',
      header: 'Affected',
      accessor: (row) => row.count,
      sortable: true,
      align: 'right',
      width: 100,
      render: (row) => <span className="tabular-nums">{formatNumber(row.count)}</span>,
    },
    {
      key: 'evidence',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'finding', finding: row })}>
          Evidence
        </Button>
      ),
    },
  ];

  const queryColumns: ReadonlyArray<ColumnDef<SeoQueryRow>> = [
    {
      key: 'query',
      header: 'Query',
      accessor: (row) => row.query,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[24rem] truncate" title={row.query}>
          {row.query}
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
      key: 'position',
      header: 'Position',
      accessor: (row) => row.position,
      sortable: true,
      align: 'right',
      width: 110,
      render: (row) => <span className="tabular-nums">{row.position.toFixed(1)}</span>,
    },
    {
      key: 'positionDelta',
      header: 'Position change',
      accessor: (row) => row.positionDelta,
      sortable: true,
      align: 'right',
      width: 150,
      // §3.5 — a query with no earlier reading has no movement, which is not
      // the same as "moved zero places".
      emptyLabel: 'No earlier reading',
      render: (row) =>
        row.positionDelta === null ? null : (
          <span className="tabular-nums">
            {row.positionDelta > 0 ? '+' : ''}
            {row.positionDelta.toFixed(1)}
          </span>
        ),
    },
    {
      key: 'opportunities',
      header: 'Flagged',
      accessor: (row) => row.opportunities.join(', '),
      width: 180,
      emptyLabel: 'Nothing flagged',
      render: (row) =>
        row.opportunities.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.opportunities.map((flag) => (
              <StatusPill key={flag} label={opportunityLabel(flag)} tone="info" />
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">Nothing flagged</span>
        ),
    },
    {
      key: 'evidence',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'query', query: row })}>
          Evidence
        </Button>
      ),
    },
  ];

  const pageColumns: ReadonlyArray<ColumnDef<SeoPageRow>> = [
    {
      key: 'url',
      header: 'Page',
      accessor: (row) => row.url,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[26rem] truncate font-mono text-meta" title={row.url}>
          {row.url}
        </span>
      ),
    },
    {
      key: 'coverageState',
      header: 'Indexing state',
      accessor: (row) => row.coverageState,
      width: 220,
      emptyLabel: 'Not inspected in this run',
      render: (row) =>
        row.coverageState ? (
          <span className="text-table">{row.coverageState}</span>
        ) : (
          <span className="text-muted-foreground">Not inspected in this run</span>
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
      key: 'issues',
      header: 'Issues',
      accessor: (row) => row.issues.map((issue) => issue.code).join(', '),
      width: 100,
      align: 'right',
      render: (row) =>
        row.issues.length > 0 ? (
          <span className="tabular-nums">{formatNumber(row.issues.length)}</span>
        ) : (
          <span className="text-muted-foreground">None found</span>
        ),
    },
    {
      key: 'evidence',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'page', page: row })}>
          Evidence
        </Button>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="SEO run" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!audit) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const comparableDeltas = comparison
    ? comparison.deltas.filter(
        (d): d is AuditDelta & { previous: number; current: number } =>
          d.previous !== null && d.current !== null,
      )
    : [];
  const previousRun = comparison?.previousAuditId ? runById.get(comparison.previousAuditId) : undefined;

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          projectName: 'This project',
          domain: audit.siteUrl,
          mode: 'live',
          runLabel: `Run ${audit.id}`,
        }}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/research/search`}>Back to search performance</Link>
            </Button>
          </>
        }
      />

      <PageHeader
        title="SEO run"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{audit.siteUrl}</span>
            <span>
              Window {audit.windowDays} days · started <Timestamp value={audit.createdAt} />
            </span>
            <span>
              Triggered by <span className="font-mono">{audit.triggeredBy}</span>
            </span>
          </span>
        }
        status={<StatusPill label={`Score ${audit.score ?? notMeasuredLabel()}`} tone="neutral" />}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <nav aria-label="Sections of this run" className="text-table">
        <ol className="flex flex-wrap gap-x-4 gap-y-1">
          {[
            { href: '#coverage', label: 'Coverage and window' },
            { href: '#findings', label: 'Findings' },
            { href: '#queries', label: 'Queries' },
            { href: '#pages', label: 'Pages' },
            { href: '#comparison', label: 'Comparison' },
            { href: '#sitemaps', label: 'Sitemaps' },
          ].map((section) => (
            <li key={section.href}>
              <a href={section.href} className="text-primary underline-offset-4 hover:underline">
                {section.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <section id="coverage" aria-labelledby="coverage-heading">
        <h2 id="coverage-heading" className="sr-only">
          Coverage and window
        </h2>
        <div className="space-y-4">
          <RunStatusStrip
            run={{
              id: audit.id,
              status: audit.pages.length === 0 ? 'partial' : 'completed',
              startedAt: audit.createdAt,
            }}
            detail={
              <div className="space-y-1">
                <p>
                  This run read a rolling {audit.windowDays}-day window of Search Console for{' '}
                  <span className="font-mono">{audit.siteUrl}</span>, and URL-inspected{' '}
                  {formatNumber(audit.pagesInspected)} of the {formatNumber(audit.pages.length)} URLs the
                  window reported.
                </p>
                <p className="text-muted-foreground">
                  Search Console reports the two most recent days incompletely, so the run&rsquo;s end date
                  lags today by design. Google also caps what a single Search Analytics query returns, so
                  the query and page tables below are the highest-impression rows for the window, not every
                  row.
                </p>
              </div>
            }
          >
            {coverage ? (
              <CoveragePanel
                summary={coverage}
                title="URL inspection coverage"
                contextNote={
                  <span>
                    &ldquo;Issues&rdquo; below count only the pages this run inspected. A page outside the
                    inspection budget has no recorded indexing state — that is deferred, not failed.
                  </span>
                }
              />
            ) : null}
          </RunStatusStrip>
        </div>
      </section>

      <section id="findings" aria-labelledby="findings-heading">
        <Card>
          <CardHeader>
            <CardTitle id="findings-heading" className="text-subsection">
              Findings
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {audit.findings.length === 0 ? (
              <p className="text-table text-muted-foreground">
                This run recorded no findings. That means every check it performed passed, not that no
                check was performed — the coverage panel above states how many ran.
              </p>
            ) : (
              <DataTable
                caption="Findings from this SEO run"
                columns={findingColumns}
                rows={audit.findings}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'severity', direction: 'asc' }}
                minTableWidth="60rem"
                filters={[
                  {
                    id: 'severity',
                    label: 'Severity',
                    options: [
                      { value: 'critical', label: 'Critical' },
                      { value: 'high', label: 'High' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'low', label: 'Low' },
                    ],
                    getValue: (row) => row.severity,
                  },
                  {
                    id: 'status',
                    label: 'Result',
                    options: [
                      { value: 'fail', label: 'Failed' },
                      { value: 'warn', label: 'Warning' },
                      { value: 'pass', label: 'Passed' },
                    ],
                    getValue: (row) => row.status,
                  },
                ]}
                emptyState={<EmptyState variant="no-results" />}
              />
            )}
          </CardContent>
        </Card>
      </section>

      <section id="queries" aria-labelledby="queries-heading">
        <Card>
          <CardHeader>
            <CardTitle id="queries-heading" className="text-subsection">
              Queries
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {audit.queries.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="query rows"
                prerequisite="Search Console returned no queries with impressions in this window."
              />
            ) : (
              <>
                <DataTable
                  caption="Queries in this run's window"
                  columns={queryColumns}
                  rows={audit.queries}
                  getRowId={(row) => row.id ?? row.query}
                  defaultSort={{ key: 'impressions', direction: 'desc' }}
                  minTableWidth="72rem"
                  filters={[
                    {
                      id: 'flagged',
                      label: 'Flagged',
                      options: [
                        { value: 'flagged', label: 'Has an opportunity flag' },
                        { value: 'clear', label: 'Nothing flagged' },
                      ],
                      getValue: (row) => (row.opportunities.length > 0 ? 'flagged' : 'clear'),
                    },
                  ]}
                  emptyState={<EmptyState variant="no-results" />}
                />
                <p className="mt-2 text-meta text-muted-foreground">
                  Position change is against the same-length window immediately before this one. Filters
                  apply to the rows this endpoint returned.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      <section id="pages" aria-labelledby="pages-heading">
        <Card>
          <CardHeader>
            <CardTitle id="pages-heading" className="text-subsection">
              Pages
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {audit.pages.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="page rows"
                prerequisite="Search Console returned no page rows for this window."
              />
            ) : (
              <DataTable
                caption="Pages in this run's window"
                columns={pageColumns}
                rows={audit.pages}
                getRowId={(row) => row.url}
                defaultSort={{ key: 'impressions', direction: 'desc' }}
                minTableWidth="72rem"
                filters={[
                  {
                    id: 'inspection',
                    label: 'Inspection',
                    options: [
                      { value: 'inspected', label: 'Inspected' },
                      { value: 'not-inspected', label: 'Outside the budget' },
                    ],
                    getValue: (row) => (row.coverageState ? 'inspected' : 'not-inspected'),
                  },
                  {
                    id: 'issues',
                    label: 'Issues',
                    options: [
                      { value: 'with', label: 'Has issues' },
                      { value: 'without', label: 'No issues found' },
                    ],
                    getValue: (row) => (row.issues.length > 0 ? 'with' : 'without'),
                  },
                ]}
                emptyState={<EmptyState variant="no-results" />}
              />
            )}
          </CardContent>
        </Card>
      </section>

      <section id="comparison" aria-labelledby="comparison-heading" className="space-y-3">
        <h2 id="comparison-heading" className="text-subsection font-semibold text-foreground">
          Comparison
        </h2>

        {!comparison?.previousAuditId ? (
          <Card>
            <CardContent className="pt-6">
              <EmptyState variant="no-comparison-baseline" />
            </CardContent>
          </Card>
        ) : (
          <>
            <p className="text-table text-muted-foreground">
              Baseline run <span className="font-mono">{comparison.previousAuditId}</span>
              {previousRun?.createdAt ? (
                <>
                  {' '}
                  (<Timestamp value={previousRun.createdAt} />)
                </>
              ) : null}{' '}
              — {previousRun?.windowDays !== undefined ? `${previousRun.windowDays}-day window` : 'window not recorded'}.
            </p>

            {comparableDeltas.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {comparableDeltas.map((delta) => (
                  <ChangeComparison
                    key={delta.metric}
                    data={buildComparisonData(delta, comparison, comparability.compatible)}
                    changeMode={delta.metric === 'ctr' ? 'percentage-points' : 'absolute'}
                    direction={delta.higherIsBetter ? 'higher-is-better' : 'lower-is-better'}
                    methodologyNote={comparability.compatible ? undefined : <p>{comparability.note}</p>}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <EmptyState
                    variant="not-measured"
                    subject="a comparable metric"
                    prerequisite="both runs must have measured the same metric for a change to exist."
                  />
                </CardContent>
              </Card>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">Keywords entering page 1</CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  {comparison.queryChanges.enteredPage1.length === 0 ? (
                    <p className="text-table text-muted-foreground">
                      No query moved onto page 1 of the results since the baseline run. A query with no
                      earlier reading is not counted here as an entry.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {comparison.queryChanges.enteredPage1.map((row) => (
                        <li key={row.query} className="flex items-center justify-between gap-4 py-2">
                          <span className="min-w-0 truncate text-table">{row.query}</span>
                          <span className="whitespace-nowrap text-table tabular-nums">
                            {row.from === null ? 'No earlier reading' : row.from.toFixed(1)} → {row.to.toFixed(1)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">Keywords leaving page 1</CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  {comparison.queryChanges.leftPage1.length === 0 ? (
                    <p className="text-table text-muted-foreground">
                      No query dropped off page 1 since the baseline run.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {comparison.queryChanges.leftPage1.map((row) => (
                        <li key={row.query} className="flex items-center justify-between gap-4 py-2">
                          <span className="min-w-0 truncate text-table">{row.query}</span>
                          <span className="whitespace-nowrap text-table tabular-nums">
                            {row.from.toFixed(1)} → {row.to === null ? 'No longer reported' : row.to.toFixed(1)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">Page-level change</CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <ChangeList
                    label="Improved in the rankings"
                    rows={comparison.pageChanges.improved.map((p) => ({
                      key: p.url,
                      text: p.url,
                      detail: `${p.from.toFixed(1)} → ${p.to.toFixed(1)}`,
                    }))}
                  />
                  <ChangeList
                    label="Regressed in the rankings"
                    rows={comparison.pageChanges.regressed.map((p) => ({
                      key: p.url,
                      text: p.url,
                      detail: `${p.from.toFixed(1)} → ${p.to.toFixed(1)}`,
                    }))}
                  />
                  <ChangeList
                    label="Newly indexed"
                    rows={comparison.pageChanges.nowIndexed.map((url) => ({ key: url, text: url }))}
                  />
                  <ChangeList
                    label="Lost index coverage"
                    rows={comparison.pageChanges.lostIndex.map((url) => ({ key: url, text: url }))}
                  />
                  <ChangeList
                    label="Issues resolved"
                    rows={comparison.pageChanges.nowClean.map((url) => ({ key: url, text: url }))}
                  />
                  <ChangeList
                    label="No longer reported"
                    rows={comparison.pageChanges.dropped.map((url) => ({ key: url, text: url }))}
                  />
                </div>
                <p className="mt-3 text-meta text-muted-foreground">
                  These lists are the backend&rsquo;s own comparison of the two runs&rsquo; stored rows.
                  Index-coverage changes are only counted for pages both runs actually inspected, so a page
                  outside a run&rsquo;s budget never reads as having lost coverage.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </section>

      <section id="sitemaps" aria-labelledby="sitemaps-heading">
        <Card>
          <CardHeader>
            <CardTitle id="sitemaps-heading" className="text-subsection">
              Sitemaps
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            <p className="text-table text-muted-foreground">
              Re-submitting the property&rsquo;s sitemaps tells Google to look at them again. It is the one
              action this run can take, and it does not fetch or index anything by itself.
            </p>
            {sitemapResult ? (
              sitemapResult.length > 0 ? (
                <p role="status" className="text-table text-foreground">
                  Google accepted the submission of {sitemapResult.length} sitemap
                  {sitemapResult.length === 1 ? '' : 's'}: {sitemapResult.join(', ')}. Acceptance is the
                  attempt; it is not a re-crawl, and it does not change the results above.
                </p>
              ) : (
                <p role="status" className="text-table text-warning-foreground">
                  The request completed but Google accepted no sitemap. Check the property&rsquo;s sitemap
                  list in Search Console.
                </p>
              )
            ) : null}
            <Button variant="outline" onClick={() => setSitemapOpen(true)}>
              Re-submit sitemaps
            </Button>
          </CardContent>
        </Card>
      </section>

      <ConfirmDialog
        open={sitemapOpen}
        onOpenChange={setSitemapOpen}
        title="Re-submit this property's sitemaps"
        confirmLabel="Submit sitemaps"
        targetLabel="Search Console property"
        target={audit.siteUrl}
        effect={
          <p>
            Google is asked to fetch and re-read the sitemaps already registered for this property. No
            page is crawled by Cailyx, nothing in this run&rsquo;s results is recalculated, and no new audit
            is started.
          </p>
        }
        scope={<p>This affects the property {audit.siteUrl} only.</p>}
        onConfirm={async () => {
          const result = await submitSeoSitemaps(projectId);
          setSitemapResult(result.submitted);
        }}
      >
        <p className="text-meta text-muted-foreground">
          If no sitemap is registered for the property, Google returns a conflict and nothing is submitted.
        </p>
      </ConfirmDialog>

      <EvidenceDrawer
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title={evidenceTitle(open)}
        source={{
          name: 'SEO audit run · Google Search Console',
          capturedAt: audit.createdAt,
          runId: audit.id,
          url: audit.siteUrl,
        }}
        observed={evidenceObserved(open)}
        interpretation={
          open?.kind === 'finding'
            ? open.finding.recommendedFix
            : open?.kind === 'page'
              ? 'The indexing state, fetch state and canonical above are what Google reported when this URL was inspected.'
              : null
        }
        interpretationKind="derived"
        raw={
          open?.kind === 'finding' && open.finding.fixArtifact
            ? { label: 'Paste-ready fix', text: open.finding.fixArtifact }
            : open?.kind === 'page'
              ? {
                  label: 'Raw page record',
                  text: JSON.stringify(
                    {
                      url: open.page.url,
                      coverageState: open.page.coverageState,
                      indexingState: open.page.indexingState,
                      robotsTxtState: open.page.robotsTxtState,
                      pageFetchState: open.page.pageFetchState,
                      googleCanonical: open.page.googleCanonical,
                      userCanonical: open.page.userCanonical,
                      lastCrawlTime: open.page.lastCrawlTime,
                      richResults: open.page.richResults,
                      issues: open.page.issues,
                    },
                    null,
                    2,
                  ),
                }
              : open?.kind === 'query'
                ? {
                    label: 'Raw query record',
                    text: JSON.stringify(
                      {
                        query: open.query.query,
                        clicks: open.query.clicks,
                        impressions: open.query.impressions,
                        ctr: open.query.ctr,
                        position: open.query.position,
                        positionDelta: open.query.positionDelta,
                        impressionsDelta: open.query.impressionsDelta,
                        clicksDelta: open.query.clicksDelta,
                        topPage: open.query.topPage,
                        opportunities: open.query.opportunities,
                      },
                      null,
                      2,
                    ),
                  }
                : undefined
        }
        provenance="measured"
      />
    </div>
  );
}

/** One page-change bucket: the count, then the URLs themselves (capped). */
function ChangeList({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ key: string; text: string; detail?: string }>;
}) {
  const CAP = 10;
  return (
    <div>
      <h3 className="text-table font-medium text-foreground">
        {label} <span className="tabular-nums text-muted-foreground">({formatNumber(rows.length)})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-meta text-muted-foreground">None.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {rows.slice(0, CAP).map((row) => (
            <li key={row.key} className="flex items-baseline justify-between gap-3 text-meta">
              <span className="min-w-0 truncate font-mono" title={row.text}>
                {row.text}
              </span>
              {row.detail ? <span className="whitespace-nowrap tabular-nums">{row.detail}</span> : null}
            </li>
          ))}
          {rows.length > CAP ? (
            <li className="text-meta text-muted-foreground">and {rows.length - CAP} more</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function evidenceTitle(open: OpenEvidence | null): string {
  if (!open) return 'Evidence';
  switch (open.kind) {
    case 'finding':
      return `Finding: ${open.finding.title}`;
    case 'page':
      return 'Page inspection evidence';
    case 'query':
      return `Query: ${open.query.query}`;
  }
}

function evidenceObserved(open: OpenEvidence | null): ReactNode {
  if (!open) return null;
  switch (open.kind) {
    case 'finding':
      return (
        <div className="space-y-2">
          <p>{open.finding.detail}</p>
          <p className="text-meta text-muted-foreground">
            {open.finding.count} URL{open.finding.count === 1 ? '' : 's'} affected
            {open.finding.affected.length > 0 ? `: ${open.finding.affected.slice(0, 10).join(', ')}` : ''}
            {open.finding.affected.length > 10 ? ` and ${open.finding.affected.length - 10} more` : ''}.
          </p>
          {open.finding.action ? (
            <p className="text-meta text-muted-foreground">{open.finding.action}</p>
          ) : null}
        </div>
      );
    case 'page':
      return (
        <dl className="grid gap-1">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Indexing state</dt>
            <dd>{open.page.coverageState ?? 'Not inspected in this run'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Verdict</dt>
            <dd>{open.page.indexVerdict ?? notMeasuredLabel()}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">robots.txt</dt>
            <dd>{open.page.robotsTxtState ?? notMeasuredLabel()}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Fetch state</dt>
            <dd>{open.page.pageFetchState ?? notMeasuredLabel()}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Google canonical</dt>
            <dd className="min-w-0 truncate text-right font-mono text-meta">
              {open.page.googleCanonical ?? notMeasuredLabel()}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Declared canonical</dt>
            <dd className="min-w-0 truncate text-right font-mono text-meta">
              {open.page.userCanonical ?? notMeasuredLabel()}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Last crawl</dt>
            <dd>
              {open.page.lastCrawlTime ? <Timestamp value={open.page.lastCrawlTime} dateOnly /> : notMeasuredLabel()}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Rich results</dt>
            <dd>{open.page.richResults.length > 0 ? open.page.richResults.join(', ') : 'None found'}</dd>
          </div>
        </dl>
      );
    case 'query':
      return (
        <dl className="grid gap-1">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Clicks</dt>
            <dd>{formatNumber(open.query.clicks)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Impressions</dt>
            <dd>{formatNumber(open.query.impressions)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Average position</dt>
            <dd>{open.query.position.toFixed(1)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Top page</dt>
            <dd className="min-w-0 truncate text-right font-mono text-meta">
              {open.query.topPage ?? notMeasuredLabel()}
            </dd>
          </div>
        </dl>
      );
  }
}

function buildComparisonData(
  delta: AuditDelta & { previous: number; current: number },
  comparison: SeoComparison,
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
  };
}

/** Units for the delta registry the SEO service reports. */
function unitFor(metric: string): string {
  switch (metric) {
    case 'score':
      return '/ 100';
    case 'ctr':
      // The service already scales CTR to a percentage before diffing it.
      return '%';
    case 'position':
      return 'places';
    case 'page1':
    case 'strikingDistance':
      return 'queries';
    case 'criticalIssues':
    case 'notIndexed':
      return 'checks';
    default:
      return '';
  }
}

function findingStatusLabel(status: string): string {
  switch (status) {
    case 'fail':
      return 'Failed';
    case 'warn':
      return 'Warning';
    case 'pass':
      return 'Passed';
    default:
      return status;
  }
}

function findingStatusTone(status: string): StatusTone {
  switch (status) {
    case 'fail':
      return 'danger';
    case 'warn':
      return 'warning';
    case 'pass':
      return 'success';
    default:
      return 'neutral';
  }
}

function severityTone(severity: string): StatusTone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'high':
      return 'warning';
    case 'medium':
      return 'info';
    case 'low':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** The issue/opportunity codes the SEO rubric emits, in words. */
function opportunityLabel(code: string): string {
  switch (code) {
    case 'striking-distance':
      return 'Striking distance';
    case 'low-ctr':
      return 'Low CTR for its position';
    case 'cannibalization':
      return 'Multiple pages ranking';
    case 'declining':
      return 'Declining';
    case 'new-entry':
      return 'New entry';
    default:
      return code;
  }
}

function titleCase(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
