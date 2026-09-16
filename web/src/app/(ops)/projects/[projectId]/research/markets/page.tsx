'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  getMarketVisibility,
  getResearchScope,
  type MarketVisibility,
  type MarketVisibilityRow,
  type ResearchScope,
} from '@/services/research-library';

/**
 * SP03 — Markets.
 *
 * design_plan.md §4.3: *"SERP market breakdown and AEO market slices in
 * **distinct panels**"*, and the report family's rule for this screen:
 * *"do not present differing methodologies as comparable numbers."*
 *
 * The two panels below are the whole point of the screen, and they are never
 * merged, ordered by one another, or drawn on a shared axis:
 *
 *  - **Panel 1 — SERP market breakdown.** Search positions: how many tracked
 *    keywords were ranked at all, and the average organic position across those
 *    that were. A position measurement.
 *  - **Panel 2 — AEO market slices.** Counted AI-answer presence: how many
 *    tracked keywords produced an AI Overview in that market, and how many of
 *    those named the client. An occurrence count over keywords.
 *
 * They have different denominators (`keywordsRanked` vs `keywordsTracked`) and
 * they measure different things. A market can rank well and never be named in an
 * answer, or be named in answers while ranking nowhere — collapsing them into
 * one "visibility" figure would hide exactly that.
 *
 * **What this screen cannot do.** The rollup reads each keyword's *latest*
 * captured result across the market's trackers, and those captures may come
 * from different snapshots taken at different times. design_plan tracks an
 * aligned-snapshot view as G13; until it exists, the panel says so rather than
 * implying the numbers came from one moment.
 */
export default function MarketsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [data, setData] = useState<MarketVisibility | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result] = await Promise.all([
          getMarketVisibility(projectId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setData(result);
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

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Markets" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const serpColumns: ReadonlyArray<ColumnDef<MarketVisibilityRow>> = [
    {
      key: 'location',
      header: 'Market',
      accessor: (row) => row.location,
      sortable: true,
      width: 220,
      render: (row) => <span className="font-medium">{row.location}</span>,
    },
    {
      key: 'trackers',
      header: 'Trackers feeding this market',
      accessor: (row) => row.trackers.join(', '),
      width: 260,
      cellClassName: 'whitespace-normal',
    },
    {
      key: 'keywordsTracked',
      header: 'Keywords tracked',
      accessor: (row) => row.keywordsTracked,
      sortable: true,
      align: 'right',
      width: 170,
      render: (row) => <span className="tabular-nums">{formatNumber(row.keywordsTracked)}</span>,
    },
    {
      key: 'keywordsRanked',
      header: 'Keywords with a position',
      accessor: (row) => row.keywordsRanked,
      sortable: true,
      align: 'right',
      width: 210,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.keywordsRanked)} of {formatNumber(row.keywordsTracked)}
        </span>
      ),
    },
    {
      key: 'averageRank',
      header: 'Average organic position',
      accessor: (row) => row.averageRank,
      sortable: true,
      align: 'right',
      width: 220,
      // A market where nothing ranked has no average — not an average of zero.
      emptyLabel: 'No keyword ranked in this market',
      render: (row) =>
        row.averageRank === null ? null : (
          <span className="tabular-nums">#{row.averageRank}</span>
        ),
    },
  ];

  const aeoColumns: ReadonlyArray<ColumnDef<MarketVisibilityRow>> = [
    {
      key: 'location',
      header: 'Market',
      accessor: (row) => row.location,
      sortable: true,
      width: 220,
      render: (row) => <span className="font-medium">{row.location}</span>,
    },
    {
      key: 'aiOverviewKeywords',
      header: 'Keywords with an AI Overview',
      accessor: (row) => row.aiOverviewKeywords,
      sortable: true,
      align: 'right',
      width: 230,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.aiOverviewKeywords)} of {formatNumber(row.keywordsTracked)}
        </span>
      ),
    },
    {
      key: 'aiOverviewMentioned',
      header: 'Of those, naming the client',
      accessor: (row) => row.aiOverviewMentioned,
      sortable: true,
      align: 'right',
      width: 230,
      render: (row) => (
        <span className="tabular-nums">
          {row.aiOverviewKeywords === 0
            ? 'No overview to be named in'
            : `${formatNumber(row.aiOverviewMentioned)} of ${formatNumber(row.aiOverviewKeywords)}`}
        </span>
      ),
    },
    {
      key: 'delta',
      header: 'Overviews that did not name the client',
      accessor: (row) => row.aiOverviewKeywords - row.aiOverviewMentioned,
      sortable: true,
      align: 'right',
      width: 250,
      render: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.aiOverviewKeywords - row.aiOverviewMentioned)}
        </span>
      ),
    },
  ];

  const localPackColumns: ReadonlyArray<ColumnDef<MarketVisibilityRow>> = [
    {
      key: 'location',
      header: 'Market',
      accessor: (row) => row.location,
      sortable: true,
      width: 220,
      render: (row) => <span className="font-medium">{row.location}</span>,
    },
    {
      key: 'applicable',
      header: 'Local pack relevant',
      accessor: (row) => (row.localPack.applicable ? 'yes' : 'no'),
      sortable: true,
      width: 200,
      render: (row) =>
        row.localPack.applicable ? (
          <StatusPill label="Relevant" tone="neutral" />
        ) : (
          <ProvenanceBadge kind="unmeasured" label="Not applicable" />
        ),
    },
    {
      key: 'presence',
      header: 'Keywords with the client in the pack',
      accessor: (row) => (row.localPack.applicable ? row.localPack.keywordsPresent : null),
      sortable: true,
      align: 'right',
      width: 240,
      emptyLabel: 'Not applicable',
      render: (row) => {
        if (!row.localPack.applicable) {
          return (
            <span className="text-meta text-muted-foreground">
              A local pack is not a meaningful result for this market&rsquo;s business type.
            </span>
          );
        }
        return (
          <span className="tabular-nums">
            {formatNumber(row.localPack.keywordsPresent)} of{' '}
            {formatNumber(row.localPack.keywordsChecked)}
          </span>
        );
      },
    },
  ];

  const competitorColumns: ReadonlyArray<ColumnDef<MarketVisibilityRow>> = [
    {
      key: 'location',
      header: 'Market',
      accessor: (row) => row.location,
      sortable: true,
      width: 220,
      render: (row) => <span className="font-medium">{row.location}</span>,
    },
    {
      key: 'topCompetitors',
      header: 'Named competitors most often in the results',
      accessor: (row) => row.topCompetitors.length,
      sortable: true,
      width: 480,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'None recorded',
      render: (row) =>
        row.topCompetitors.length === 0 ? (
          <span className="text-meta text-muted-foreground">
            No named competitor appeared on this market&rsquo;s tracked keywords.
          </span>
        ) : (
          <ul className="text-meta">
            {row.topCompetitors.map((entry) => (
              <li key={entry.name}>
                {entry.name} — appeared on{' '}
                <span className="tabular-nums">{formatNumber(entry.keywordsAppearedIn)}</span>{' '}
                tracked keyword
                {entry.keywordsAppearedIn === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          projectName: scope?.projectName,
          mode: 'live',
        }}
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client and domain are not shown above.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Search trackers', href: `/projects/${projectId}/research/serp` },
          { label: 'Markets' },
        ]}
        title="Markets"
        context={`${data.markets.length} market${data.markets.length === 1 ? '' : 's'} with at least one tracker`}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <Alert>
        <AlertTitle>Two measurements, two panels, never one figure</AlertTitle>
        <AlertDescription>
          Search positions and AI-answer presence are counted over different things. Panel 1 reports
          where the client ranked in organic results; panel 2 counts AI Overview occurrences and
          whether the client was named in them. They are not averaged, summed, or ranked against
          each other here, and there is no combined &ldquo;visibility&rdquo; score on this page —
          design_plan §1.5 keeps these as separate concepts over separate populations.
        </AlertDescription>
      </Alert>

      <Alert>
        <AlertTitle>Capture times are not aligned across this rollup</AlertTitle>
        <AlertDescription>
          Each market rolls up <strong>each keyword&rsquo;s latest captured result</strong>, and those
          results may come from snapshots captured at different times. A market can therefore mix
          readings taken days apart. An aligned-snapshot view is tracked as G13 and is not built; this
          page states the limitation rather than implying the figures share one capture time.
        </AlertDescription>
      </Alert>

      <p className="text-meta text-muted-foreground">{data.note}</p>

      {data.markets.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="Market breakdown"
              prerequisite="This rollup groups each tracker's already-captured results by the tracker's market. With no SERP tracker for this project there is nothing to group — a market with no tracker is not measured, not zero visibility."
              action={{
                label: 'Create a tracker',
                href: `/projects/${projectId}/research/serp`,
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                Panel 1 — SERP market breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="measured" label="Search positions" />
                <span className="text-meta text-muted-foreground">
                  A position measurement, per market. Lower is better.
                </span>
              </div>
              <p className="text-table text-muted-foreground">
                How many tracked keywords had a client page in the captured organic results, and the
                average position across those that did. A keyword with no position is excluded from
                the average rather than counted as a large number, which is why the two counts
                differ.
              </p>
              <DataTable
                caption="SERP breakdown by market"
                columns={serpColumns}
                rows={data.markets}
                getRowId={(row) => `serp-${row.location}`}
                defaultSort={{ key: 'keywordsTracked', direction: 'desc' }}
                minTableWidth="72rem"
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="SERP breakdown"
                    prerequisite="No tracker has captured results yet."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Panel 2 — AEO market slices</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="measured" label="Counted AI Overview presence" />
                <span className="text-meta text-muted-foreground">
                  An occurrence count over tracked keywords, per market. Not a position.
                </span>
              </div>
              <p className="text-table text-muted-foreground">
                How many of the market&rsquo;s tracked keywords produced an AI Overview at all, and
                how many of those named the client. The denominator here is{' '}
                <strong>tracked keywords</strong>, not collected answers — the AEO rate in §1.5 is
                counted over answers on the AI-visibility screens, and the two are different
                figures.
              </p>
              <DataTable
                caption="AI Overview slices by market"
                columns={aeoColumns}
                rows={data.markets}
                getRowId={(row) => `aeo-${row.location}`}
                defaultSort={{ key: 'aiOverviewMentioned', direction: 'desc' }}
                minTableWidth="72rem"
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="AEO market slices"
                    prerequisite="No tracker has captured results yet."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Panel 3 — Local pack by market</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-table text-muted-foreground">
                A separate panel because it is separately gated: whether a local pack is a meaningful
                result depends on the business type the client was classified as. A market where it
                is not meaningful reports not applicable with that reason, never &ldquo;0 of 0
                found&rdquo;.
              </p>
              <DataTable
                caption="Local pack presence by market"
                columns={localPackColumns}
                rows={data.markets}
                getRowId={(row) => `local-${row.location}`}
                minTableWidth="66rem"
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="Local pack presence"
                    prerequisite="No tracker has captured results yet."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Panel 4 — Competitors by market</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                From the same captured results: how often each named competitor appeared on that
                market&rsquo;s tracked keywords. This is an appearance count over SERP results, not
                an AI-answer share-of-voice figure — the two live on different screens and are not
                combined.
              </p>
              <DataTable
                caption="Competitor appearances by market"
                columns={competitorColumns}
                rows={data.markets}
                getRowId={(row) => `rivals-${row.location}`}
                minTableWidth="64rem"
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="Competitors by market"
                    prerequisite="No tracker has captured results yet."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>

          <p className="text-meta text-muted-foreground">
            A market whose average position reads &ldquo;{notMeasuredLabel().toLowerCase()}&rdquo; has
            keywords tracked but none with a client page in the captured results. A market that has
            no tracker at all does not appear on this page — that is not measured, not zero
            visibility.
          </p>
        </>
      )}
    </div>
  );
}
