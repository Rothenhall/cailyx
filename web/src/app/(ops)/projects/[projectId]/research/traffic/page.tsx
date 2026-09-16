'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Info, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, formatPercent } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { getProjectDetail, type ProjectDetailWire } from '@/services/projects';
import {
  getAnalyticsSummary,
  getAttributionSummary,
  getGoogleReadiness,
  listAttribution,
  type AnalyticsSummary,
  type AttributionResponse,
  type AttributionSummary,
  type GoogleReadiness,
} from '@/services/research';

/**
 * SE03 — Traffic and acquisition.
 *
 * design_plan.md §4.3: *"GA4 totals/channels/pages; separate self-reported
 * attribution tab"*.
 *
 * The two tabs are **different kinds of data**, and keeping them visibly apart
 * is the whole reason the plan separates them:
 *
 *  - **Measured (GA4).** Sessions, users, views, engagement and channel/page
 *    breakdowns, read from the mapped GA4 property over a rolling window. Every
 *    number carries its window and its property, and the tile provenance is
 *    `measured`.
 *  - **Self-reported.** What buyers typed into a "how did you find us" form on
 *    the client's own site. It is a small, biased, non-random sample of the
 *    people who chose to answer, and it is labelled `operator-supplied` rather
 *    than dressed as an acquisition channel. It is the one number analytics
 *    systematically misses — AI assistants send referrals that arrive as
 *    "direct" — and it is worth reading *as* self-report, not as traffic.
 *
 * The two are never added, averaged or plotted on one axis.
 */

/** Window in days, kept as a string so the URL round-trips exactly. */
const WINDOW_DEFAULTS = { days: '28', tab: 'measured' };

const WINDOW_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '28', label: 'Last 28 days' },
  { value: '90', label: 'Last 90 days' },
];

function clampDays(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 28;
  return Math.min(90, Math.max(1, Math.round(parsed)));
}

/** The closed source set the capture form offers, in words. */
const SOURCE_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  copilot: 'Copilot',
  'other-ai': 'Another AI assistant',
  search: 'Search engine',
  social: 'Social media',
  referral: 'Referral or link',
  other: 'Something else',
};

export default function TrafficPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [state, setState] = useUrlState(WINDOW_DEFAULTS);
  const days = clampDays(state.days);
  const tab = state.tab === 'self-reported' ? 'self-reported' : 'measured';

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [readiness, setReadiness] = useState<GoogleReadiness | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [summary, setSummary] = useState<AttributionSummary | null>(null);
  const [responses, setResponses] = useState<AttributionResponse[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [analyticsError, setAnalyticsError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setAnalyticsError(null);
        const [projectResult, readinessResult, attributionResult, responseResult] = await Promise.all([
          getProjectDetail(projectId, { signal }),
          getGoogleReadiness(projectId, 'analytics', { signal }),
          getAttributionSummary(projectId, { signal }),
          listAttribution(projectId, { signal, take: 200 }),
        ]);
        setProject(projectResult);
        setReadiness(readinessResult);
        setSummary(attributionResult);
        setResponses(responseResult);

        // GA4 is only read once a property is mapped: an unmapped read is a
        // guaranteed 404, and the prerequisite is the useful fact, not the
        // failure (§3.4 connections family).
        if (readinessResult.selected) {
          try {
            setAnalytics(await getAnalyticsSummary(projectId, days, { signal }));
          } catch (caught) {
            if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
            setAnalytics(null);
            setAnalyticsError(toApiError(caught));
          }
        } else {
          setAnalytics(null);
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

  const channelColumns: ReadonlyArray<ColumnDef<AnalyticsSummary['channels'][number]>> = [
    {
      key: 'key',
      header: 'Channel group',
      accessor: (row) => row.key,
      sortable: true,
      render: (row) => <span className="text-table text-foreground">{row.key}</span>,
    },
    {
      key: 'sessions',
      header: 'Sessions',
      accessor: (row) => row.sessions,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{formatNumber(row.sessions)}</span>,
    },
    {
      key: 'totalUsers',
      header: 'Users',
      accessor: (row) => row.totalUsers,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{formatNumber(row.totalUsers)}</span>,
    },
  ];

  const pageColumns: ReadonlyArray<ColumnDef<AnalyticsSummary['topPages'][number]>> = [
    {
      key: 'key',
      header: 'Page path',
      accessor: (row) => row.key,
      sortable: true,
      render: (row) => (
        <span className="block max-w-[28rem] truncate font-mono text-meta" title={row.key}>
          {row.key}
        </span>
      ),
    },
    {
      key: 'screenPageViews',
      header: 'Views',
      accessor: (row) => row.screenPageViews,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{formatNumber(row.screenPageViews)}</span>,
    },
    {
      key: 'sessions',
      header: 'Sessions',
      accessor: (row) => row.sessions,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{formatNumber(row.sessions)}</span>,
    },
  ];

  const responseColumns: ReadonlyArray<ColumnDef<AttributionResponse>> = [
    {
      key: 'createdAt',
      header: 'Received',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 200,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'source',
      header: 'Reported source',
      accessor: (row) => row.source,
      sortable: true,
      width: 200,
      render: (row) => <span className="text-table">{SOURCE_LABELS[row.source] ?? row.source}</span>,
    },
    {
      key: 'prompt',
      header: 'What they said they asked',
      accessor: (row) => row.prompt ?? '',
      emptyLabel: 'Not given',
      render: (row) =>
        row.prompt ? (
          <span className="block max-w-[26rem] truncate text-table">{row.prompt}</span>
        ) : null,
    },
    {
      key: 'page',
      header: 'Landing page',
      accessor: (row) => row.page ?? '',
      width: 220,
      emptyLabel: 'Not recorded',
      render: (row) =>
        row.page ? (
          <span className="block max-w-[18rem] truncate font-mono text-meta" title={row.page}>
            {row.page}
          </span>
        ) : null,
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Traffic and acquisition" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!summary || !responses || !project || !readiness) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const mappedProperty = readiness.selected?.resourceId ?? null;

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project.name,
          // The mapped GA4 property, not the project domain: GA4 keys on a
          // property id, and this tab's numbers come from that property.
          domain: mappedProperty ?? project.domain,
          mode: 'live',
          runLabel: tab === 'measured' ? `GA4 · last ${days} days` : 'Self-reported, all time',
        }}
      />

      <PageHeader
        title="Traffic and acquisition"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{mappedProperty ?? 'No GA4 property mapped'}</span>
            {analytics ? (
              <span>
                GA4 window {analytics.range.startDate} to {analytics.range.endDate}
              </span>
            ) : null}
          </span>
        }
        status={
          readiness.selected ? (
            <StatusPill label="GA4 mapped" tone="success" />
          ) : readiness.connected ? (
            <StatusPill label="Connected, no property chosen" tone="warning" />
          ) : (
            <StatusPill label="Not connected" tone="unmeasured" />
          )
        }
        secondaryActions={
          <>
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

      <FilterBar
        defaults={WINDOW_DEFAULTS}
        value={state}
        onChange={setState}
        hideSearch
        controls={[
          {
            kind: 'select',
            key: 'days',
            label: 'GA4 window',
            options: WINDOW_OPTIONS,
            allLabel: 'Last 28 days',
          },
        ]}
        summary={
          <span className="text-meta text-muted-foreground">
            The window applies to the GA4 tab only. Self-reported answers are a running record with no
            window.
          </span>
        }
      />

      <Tabs value={tab} onValueChange={(value) => setState({ tab: value })}>
        <TabsList>
          <TabsTrigger value="measured">Measured · GA4</TabsTrigger>
          <TabsTrigger value="self-reported">Self-reported · attribution form</TabsTrigger>
        </TabsList>

        <TabsContent value="measured" className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-subsection font-semibold text-foreground">Measured traffic</h2>
            <ProvenanceBadge kind="measured" />
          </div>

          {!readiness.connected ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="not-measured"
                  subject="Google Analytics traffic"
                  prerequisite="a Google account has to be connected before GA4 can be read"
                  action={{
                    label: 'Connect Google Analytics',
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
                  sourceName="Google Analytics"
                  action={{
                    label: 'Choose the property',
                    href: `/projects/${projectId}/connections/google/analytics`,
                  }}
                />
              </CardContent>
            </Card>
          ) : analyticsError ? (
            <ErrorState
              error={analyticsError}
              onRetry={() => void load()}
              providerName="Google Analytics"
              preserveNotice="The self-reported tab is unaffected by this read."
            />
          ) : analytics ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <MetricTile
                  label="Sessions"
                  value={analytics.totals.sessions}
                  unit="sessions"
                  windowLabel={`Last ${analytics.range.days} days`}
                  sourceDate={{ date: analytics.range.endDate, sourceName: 'Google Analytics 4' }}
                  provenance="measured"
                />
                <MetricTile
                  label="Users"
                  value={analytics.totals.totalUsers}
                  unit="users"
                  windowLabel={`Last ${analytics.range.days} days`}
                  sourceDate={{ date: analytics.range.endDate, sourceName: 'Google Analytics 4' }}
                  provenance="measured"
                />
                <MetricTile
                  label="Page views"
                  value={analytics.totals.screenPageViews}
                  unit="views"
                  windowLabel={`Last ${analytics.range.days} days`}
                  sourceDate={{ date: analytics.range.endDate, sourceName: 'Google Analytics 4' }}
                  provenance="measured"
                />
                <MetricTile
                  label="Engagement rate"
                  value={analytics.totals.engagementRate * 100}
                  unit="%"
                  windowLabel={`Last ${analytics.range.days} days`}
                  sourceDate={{ date: analytics.range.endDate, sourceName: 'Google Analytics 4' }}
                  provenance="measured"
                  direction="higher-is-better"
                />
                <MetricTile
                  label="Average session duration"
                  value={analytics.totals.averageSessionDuration}
                  unit="seconds"
                  windowLabel={`Last ${analytics.range.days} days`}
                  sourceDate={{ date: analytics.range.endDate, sourceName: 'Google Analytics 4' }}
                  provenance="measured"
                  formatValue={(value) => `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`}
                />
                {/* How much of the property's traffic the channel breakdown
                    actually accounts for — a read of the top 10 rows, not a
                    claim about the whole property. */}
                <MetricTile
                  label="Sessions in the top 10 channel groups"
                  value={analytics.channels.reduce((total, row) => total + row.sessions, 0)}
                  unit="sessions"
                  windowLabel={`Last ${analytics.range.days} days`}
                  provenance="derived"
                  note={`The channel and page tables below list the highest-volume 10 rows each; this is the sum of those rows (${formatPercent(
                    analytics.totals.sessions > 0
                      ? (analytics.channels.reduce((total, row) => total + row.sessions, 0) /
                          analytics.totals.sessions) *
                          100
                      : 0,
                  )} of the total sessions above), not a property-wide split.`}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-subsection">Channel groups</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-2">
                    {analytics.channels.length === 0 ? (
                      <p className="text-table text-muted-foreground">
                        GA4 returned no channel rows for this window. That is an empty result for the
                        window, not a failed read.
                      </p>
                    ) : (
                      <DataTable
                        caption="Sessions by GA4 default channel group"
                        columns={channelColumns}
                        rows={analytics.channels}
                        getRowId={(row) => row.key}
                        defaultSort={{ key: 'sessions', direction: 'desc' }}
                        emptyState={<EmptyState variant="no-results" />}
                      />
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-subsection">Top pages</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-2">
                    {analytics.topPages.length === 0 ? (
                      <p className="text-table text-muted-foreground">
                        GA4 returned no page rows for this window.
                      </p>
                    ) : (
                      <DataTable
                        caption="Most-viewed page paths in GA4 for this window"
                        columns={pageColumns}
                        rows={analytics.topPages}
                        getRowId={(row) => row.key}
                        defaultSort={{ key: 'screenPageViews', direction: 'desc' }}
                        minTableWidth="40rem"
                        emptyState={<EmptyState variant="no-results" />}
                      />
                    )}
                  </CardContent>
                </Card>
              </div>

              <p className="text-meta text-muted-foreground">
                GA4 attributes sessions to the channel group it recorded. Traffic that arrives from an AI
                assistant is usually recorded as direct or referral, which is why the self-reported tab
                exists — and why the two are never combined into one figure. No revenue, conversion value or
                outcome figure is shown here: joining GA4 to commercial outcomes is design_plan G13 and no
                endpoint provides it yet, so none is estimated or inferred.
              </p>
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="self-reported" className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-subsection font-semibold text-foreground">Self-reported attribution</h2>
            <ProvenanceBadge kind="operator-supplied" />
          </div>

          <Alert>
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>What people said, not what was measured</AlertTitle>
            <AlertDescription>
              These are answers typed into a &ldquo;how did you find us&rdquo; form on the client&rsquo;s
              own site. Only people who chose to answer appear here, so this is a non-random sample and its
              shares describe that sample — not the client&rsquo;s traffic. It is never added to, averaged
              with, or plotted against the GA4 figures on the other tab.
            </AlertDescription>
          </Alert>

          {summary.total === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState
                  variant="not-measured"
                  subject="self-reported attribution"
                  prerequisite="the capture form on the client's site has to receive its first response"
                >
                  <p className="text-table text-muted-foreground">
                    Cailyx records an answer through the public capture endpoint as soon as the form posts
                    one. Nothing on this page can create a response.
                  </p>
                </EmptyState>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricTile
                  label="Responses recorded"
                  value={summary.total}
                  unit="responses"
                  windowLabel="All time"
                  provenance="operator-supplied"
                  sourceDate={
                    summary.lastAt ? { date: summary.lastAt, sourceName: 'Most recent response' } : undefined
                  }
                  note={
                    summary.firstAt ? (
                      <>
                        First answer received <Timestamp value={summary.firstAt} />; most recent{' '}
                        <Timestamp value={summary.lastAt ?? summary.firstAt} />.
                      </>
                    ) : undefined
                  }
                />
                <MetricTile
                  label="Named an AI assistant"
                  value={summary.aiTotal}
                  unit="responses"
                  windowLabel="All time"
                  provenance="operator-supplied"
                />
                <MetricTile
                  label="Share naming an AI assistant"
                  value={summary.total > 0 ? summary.aiShare * 100 : null}
                  unit="%"
                  windowLabel="All time"
                  provenance="operator-supplied"
                  note="A share of the people who answered, not of site traffic."
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-subsection">Reported sources</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-2">
                    <ul className="divide-y divide-border">
                      {summary.bySource.map((row) => (
                        <li key={row.source} className="flex items-center justify-between gap-4 py-2">
                          <span className="text-table">{SOURCE_LABELS[row.source] ?? row.source}</span>
                          <span className="text-table tabular-nums">
                            {formatNumber(row.count)}{' '}
                            <span className="text-muted-foreground">
                              ({formatPercent(row.share * 100)} of answers)
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-subsection">Prompts buyers reported using</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-2">
                    {summary.prompts.length === 0 ? (
                      <p className="text-table text-muted-foreground">
                        No respondent wrote down what they asked. The source they picked is still recorded
                        above.
                      </p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {summary.prompts.map((row) => (
                          <li key={`${row.createdAt}-${row.prompt}`} className="space-y-0.5 py-2">
                            {/* Free text typed by a member of the public: shown
                                as text, never rendered as markup (§10.5). */}
                            <p className="text-table text-foreground">{row.prompt}</p>
                            <p className="text-meta text-muted-foreground">
                              {SOURCE_LABELS[row.source] ?? row.source} ·{' '}
                              <Timestamp value={row.createdAt} />
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">Responses</CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  <DataTable
                    caption="Self-reported attribution responses"
                    columns={responseColumns}
                    rows={responses}
                    getRowId={(row) => row.id}
                    defaultSort={{ key: 'createdAt', direction: 'desc' }}
                    minTableWidth="60rem"
                    filters={[
                      {
                        id: 'source',
                        label: 'Reported source',
                        options: summary.bySource.map((row) => ({
                          value: row.source,
                          label: SOURCE_LABELS[row.source] ?? row.source,
                        })),
                        getValue: (row) => row.source,
                      },
                    ]}
                    emptyState={<EmptyState variant="no-results" />}
                  />
                  <p className="mt-2 text-meta text-muted-foreground">
                    The {formatNumber(responses.length)} most recent responses are loaded; the endpoint caps
                    its page and server-side pagination is not available yet (design_plan G14). Filters
                    apply to the loaded rows only.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
