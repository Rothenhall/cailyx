'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ChangeComparison } from '@/components/patterns/ChangeComparison';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import type { ApiError } from '@/lib/api';
import type { ChangeComparisonData } from '@/types';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  backlinksComparisonKey,
  getLatestBacklinksSummary,
  listBacklinksSummaries,
  refreshBacklinks,
  type BacklinkSample,
  type BacklinksSummary,
} from '@/services/authority';

/**
 * AT05 — Backlinks.
 *
 * design_plan.md §4.4: *"Snapshot status/counts/domains/top links, comparison
 * context, refresh"*. §5.9 fixes what a snapshot may claim:
 *
 * > pull explicit snapshots, display status and sample limitations.
 * > **Referring-domain count is evidence from the provider, not the Authority
 * > rubric score.**
 *
 * And §6.3 fixes the sample:
 *
 * > Backlinks/domains | Provider snapshot with sample of top links |
 * > Timestamp, target and partial status; **sample is not full inventory**.
 *
 * Three rules, then:
 *
 *  1. **The comparison is withheld, and the reason is named.** Two pulls have
 *     no recorded comparison key (no query period, no sample size, no provider
 *     method version), so `backlinksComparisonKey` reports a methodology break
 *     and `ChangeComparison` renders the two values with no delta and no
 *     direction arrow — §6.4's "do not draw an unqualified improvement arrow".
 *  2. **A partial snapshot is not a smaller complete one.** `status` is read,
 *     `error` is shown verbatim, and the failed part is named.
 *  3. **Every count is separate and nullable.** A count the provider did not
 *     return renders as not-measured through `MetricTile`, never as 0 —
 *     because "we were not told" and "there are none" are different answers.
 */

export default function BacklinksPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [latest, setLatest] = useState<BacklinksSummary | null>(null);
  const [history, setHistory] = useState<BacklinksSummary[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [confirmingRefresh, setConfirmingRefresh] = useState(false);
  const [sampleLimit, setSampleLimit] = useState('10');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [nextLatest, nextHistory] = await Promise.all([
          getLatestBacklinksSummary(projectId, { signal }),
          listBacklinksSummaries(projectId, { signal }),
        ]);
        setLatest(nextLatest);
        setHistory(nextHistory);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoaded(true);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * The snapshot immediately before the latest one.
   *
   * Located by id rather than by position, so the pair compared is always the
   * latest snapshot and its predecessor even if the two reads disagree about
   * ordering — a comparison drawn from the wrong pair would be a silent error.
   */
  const previous = useMemo(() => {
    if (!history || !latest) return null;
    const index = history.findIndex((row) => row.id === latest.id);
    return index >= 0 ? (history[index + 1] ?? null) : null;
  }, [history, latest]);

  /**
   * The comparison between the two newest snapshots.
   *
   * It is built only when both snapshots reported a backlink count at all —
   * otherwise there is nothing to place side by side — and it is always
   * declared not comparable, because the snapshot row records no comparison
   * key. See `backlinksComparisonKey`.
   */
  const comparison = useMemo<{
    data: ChangeComparisonData;
    reason: string;
  } | null>(() => {
    if (!latest || !previous) return null;
    if (latest.backlinks === null || previous.backlinks === null) return null;
    const key = backlinksComparisonKey(previous, latest);
    return {
      reason: key.reason,
      data: {
        before: { id: previous.id, date: previous.createdAt, value: previous.backlinks },
        after: { id: latest.id, date: latest.createdAt, value: latest.backlinks },
        unit: 'backlinks',
        methodologyCompatible: false,
      },
    };
  }, [latest, previous]);

  async function confirmRefresh() {
    setRefreshing(true);
    setActionError(null);
    try {
      const parsedLimit = Number(sampleLimit);
      await refreshBacklinks(projectId, {
        sampleLimit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      });
      await load();
      setConfirmingRefresh(false);
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setRefreshing(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Backlinks" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const sampleColumns: ReadonlyArray<ColumnDef<BacklinkSample>> = [
    {
      key: 'urlFrom',
      header: 'Linking page',
      accessor: (row) => row.urlFrom,
      sortable: true,
      render: (row) =>
        row.urlFrom ? (
          <span className="break-all">{row.urlFrom}</span>
        ) : (
          // The provider returns an empty string when it omits the source.
          <span className="text-muted-foreground">Not supplied by the provider</span>
        ),
    },
    {
      key: 'anchor',
      header: 'Anchor',
      accessor: (row) => row.anchor,
      width: 200,
      emptyLabel: 'No anchor text',
    },
    {
      key: 'dofollow',
      header: 'Link',
      accessor: (row) => (row.dofollow ? 'dofollow' : 'nofollow'),
      width: 110,
      render: (row) => (
        <StatusPill
          label={row.dofollow ? 'Dofollow' : 'Nofollow'}
          tone={row.dofollow ? 'success' : 'neutral'}
        />
      ),
    },
    {
      key: 'domainFromRank',
      header: 'Source authority',
      accessor: (row) => row.domainFromRank,
      sortable: true,
      align: 'right',
      width: 150,
      emptyLabel: 'Not rated',
      render: (row) =>
        row.domainFromRank === null ? null : (
          <span className="tabular-nums">{formatNumber(row.domainFromRank)}</span>
        ),
    },
    {
      key: 'firstSeen',
      header: 'First seen',
      accessor: (row) => row.firstSeen,
      sortable: true,
      width: 190,
      emptyLabel: 'Not recorded',
      render: (row) => (row.firstSeen ? <Timestamp value={row.firstSeen} dateOnly /> : null),
    },
    {
      key: 'lastSeen',
      header: 'Last seen',
      accessor: (row) => row.lastSeen,
      sortable: true,
      width: 190,
      emptyLabel: 'Not recorded',
      render: (row) => (row.lastSeen ? <Timestamp value={row.lastSeen} dateOnly /> : null),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backlinks"
        context={
          latest
            ? `Snapshot for ${latest.target}`
            : 'No snapshot has been pulled for this project yet.'
        }
        primaryAction={{
          label: 'Pull a fresh snapshot',
          onClick: () => setConfirmingRefresh(true),
        }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {!latest ? (
        <EmptyState
          variant="not-measured"
          subject="backlink data"
          prerequisite="Pull a snapshot, which needs live provider calls enabled and provider credentials configured"
        >
          <p>
            Backlink counts come from an external provider. Nothing has been pulled for this
            project, so there is no count, no referring-domain figure and no sample to show.
          </p>
        </EmptyState>
      ) : (
        <>
          {/* ── Snapshot status ─────────────────────────────────────── */}
          <Card>
            <CardHeader className="space-y-2">
              <CardTitle className="text-subsection">Latest snapshot</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label={latest.status} tone={snapshotTone(latest.status)} />
                <ProvenanceBadge kind="measured" label="From the provider" />
                <span className="text-meta text-muted-foreground">Target: {latest.target}</span>
                <Timestamp value={latest.createdAt} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              {latest.status !== 'completed' ? (
                <Alert variant={latest.status === 'failed' ? 'destructive' : undefined}>
                  {latest.status === 'partial' ? (
                    <Info aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                  )}
                  <AlertTitle>
                    {latest.status === 'failed'
                      ? 'This snapshot produced no data'
                      : 'This snapshot is incomplete'}
                  </AlertTitle>
                  <AlertDescription>
                    {latest.error ??
                      'The provider did not return a complete snapshot, so some figures below are missing.'}
                    {latest.status === 'partial'
                      ? ' The figures that were returned are shown as recorded; the missing ones are not zero.'
                      : null}
                  </AlertDescription>
                </Alert>
              ) : null}

              <p className="text-table text-muted-foreground">
                These counts are the provider&rsquo;s evidence about this domain. They are not the
                Authority dimension of the rubric score, and the referring-domain count here is not
                a substituted rubric value.
              </p>

              {latest.costUsd > 0 ? (
                <p className="text-meta text-muted-foreground">
                  Provider cost recorded for this snapshot:{' '}
                  {formatCurrency(latest.costUsd, 'USD')}. Cost is recorded per snapshot and is not
                  an estimate of the next pull.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* ── Counts ──────────────────────────────────────────────── */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label="Backlinks"
              value={latest.backlinks}
              unit="links"
              runLabel="Latest backlinks snapshot"
              sourceDate={{ date: latest.createdAt, sourceName: 'Backlinks provider' }}
              provenance="measured"
              note="Total links the provider counts, including links from pages it has not sampled here."
            />
            <MetricTile
              label="Referring domains"
              value={latest.referringDomains}
              unit="domains"
              runLabel="Latest backlinks snapshot"
              sourceDate={{ date: latest.createdAt, sourceName: 'Backlinks provider' }}
              provenance="measured"
              note="Provider evidence, not the Authority rubric score (§5.9)."
            />
            <MetricTile
              label="Referring pages"
              value={latest.referringPages}
              unit="pages"
              runLabel="Latest backlinks snapshot"
              sourceDate={{ date: latest.createdAt, sourceName: 'Backlinks provider' }}
              provenance="measured"
            />
            <MetricTile
              label="Broken backlinks"
              value={latest.brokenBacklinks}
              unit="links"
              runLabel="Latest backlinks snapshot"
              sourceDate={{ date: latest.createdAt, sourceName: 'Backlinks provider' }}
              provenance="measured"
              note="Links to this domain that the provider reports as broken."
            />
          </div>

          {/* ── Comparison ──────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Comparison with the previous snapshot</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {!previous ? (
                <EmptyState variant="no-comparison-baseline">
                  <p>
                    Only one snapshot exists for this project. A second pull produces the pair this
                    section would compare.
                  </p>
                </EmptyState>
              ) : comparison ? (
                <ChangeComparison
                  data={comparison.data}
                  methodologyNote={<p>{comparison.reason}</p>}
                />
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="a backlink-count comparison"
                  prerequisite="Two snapshots that both reported a backlink count"
                >
                  <p>
                    One of the two most recent snapshots did not report a backlink count, so there
                    are no two figures to place side by side.
                  </p>
                </EmptyState>
              )}
            </CardContent>
          </Card>

          {/* ── Distribution ────────────────────────────────────────── */}
          <DistributionSection summary={latest} />

          {/* ── Sample ──────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Top backlinks sample</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              {latest.topBacklinks.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="the backlink sample"
                  prerequisite="A snapshot whose sample step completed"
                >
                  <p>
                    {latest.status === 'partial' || latest.status === 'failed'
                      ? 'The sample step of this snapshot did not complete, so no individual links were recorded.'
                      : 'This snapshot was pulled with the sample step skipped, so it recorded counts only.'}
                  </p>
                </EmptyState>
              ) : (
                <>
                  <Alert>
                    <Info aria-hidden="true" className="h-4 w-4" />
                    <AlertTitle>This is a sample, not the full inventory</AlertTitle>
                    <AlertDescription>
                      The provider returns the highest-authority links it knows of, up to the
                      limit requested for this pull. A link that is missing from this table is not
                      evidence that the link does not exist.
                    </AlertDescription>
                  </Alert>
                  <DataTable
                    caption="Sampled backlinks"
                    columns={sampleColumns}
                    rows={latest.topBacklinks}
                    getRowId={(row) => `${row.urlFrom}|${row.urlTo}|${row.firstSeen ?? ''}`}
                    defaultSort={{ key: 'domainFromRank', direction: 'desc' }}
                    emptyState={<EmptyState variant="no-results" />}
                    minTableWidth="68rem"
                  />
                </>
              )}
            </CardContent>
          </Card>

          {/* ── History ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Snapshot history</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <DataTable
                caption="Backlinks snapshot history"
                columns={[
                  {
                    key: 'createdAt',
                    header: 'Pulled',
                    accessor: (row) => row.createdAt,
                    sortable: true,
                    width: 200,
                    render: (row) => <Timestamp value={row.createdAt} />,
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    accessor: (row) => row.status,
                    sortable: true,
                    width: 130,
                    render: (row) => <StatusPill label={row.status} tone={snapshotTone(row.status)} />,
                  },
                  {
                    key: 'target',
                    header: 'Target',
                    accessor: (row) => row.target,
                    width: 220,
                  },
                  {
                    key: 'backlinks',
                    header: 'Backlinks',
                    accessor: (row) => row.backlinks,
                    sortable: true,
                    align: 'right',
                    width: 120,
                    render: (row) =>
                      row.backlinks === null ? null : (
                        <span className="tabular-nums">{formatNumber(row.backlinks)}</span>
                      ),
                  },
                  {
                    key: 'referringDomains',
                    header: 'Referring domains',
                    accessor: (row) => row.referringDomains,
                    sortable: true,
                    align: 'right',
                    width: 160,
                    render: (row) =>
                      row.referringDomains === null ? null : (
                        <span className="tabular-nums">{formatNumber(row.referringDomains)}</span>
                      ),
                  },
                  {
                    key: 'error',
                    header: 'Problem',
                    accessor: (row) => row.error,
                    render: (row) => <span className="text-meta">{row.error}</span>,
                    emptyLabel: '—',
                  },
                ]}
                rows={history ?? []}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'createdAt', direction: 'desc' }}
                emptyState={<EmptyState variant="not-measured" subject="snapshot history" />}
                minTableWidth="70rem"
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* Paid and provider-backed: confirmed with the documented cost range. */}
      <ConfirmDialog
        open={confirmingRefresh}
        onOpenChange={(open) => {
          if (!open && !refreshing) setConfirmingRefresh(false);
        }}
        title="Pull a fresh backlinks snapshot?"
        confirmLabel="Pull snapshot"
        targetLabel="Project target"
        target={latest?.target ?? 'the project’s own domain'}
        effect={
          <div className="space-y-2">
            <p>
              Makes two provider calls — one for the summary figures and one for the sample of
              individual links — and stores the result as a new snapshot. It does not replace or
              edit earlier snapshots.
            </p>
            <p>
              The provider documents the pair of calls as costing roughly $0.03–0.06. Cailyx does
              not hold an estimate for this configuration, so that is the provider&rsquo;s
              published range rather than a quoted price.
            </p>
          </div>
        }
        onConfirm={confirmRefresh}
        onConfirmed={() => setConfirmingRefresh(false)}
      >
        <div className="space-y-2">
          <Label htmlFor="sample-limit">Links to sample</Label>
          <Input
            id="sample-limit"
            type="number"
            min={0}
            max={100}
            value={sampleLimit}
            onChange={(event) => setSampleLimit(event.target.value)}
          />
          <p className="text-meta text-muted-foreground">
            Between 0 and 100, defaulting to 10. Setting 0 skips the sample call: the snapshot then
            records counts only, and the top-links table will say so.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The provider's distributions.
 *
 * Each one is a `{value: count}` object that the provider may or may not have
 * returned. A missing object is reported as not measured; an empty object is
 * reported as an empty breakdown, because those are different answers.
 */
function DistributionSection({ summary }: { summary: BacklinksSummary }) {
  const distributions: Array<{ label: string; data: Record<string, number> | null }> = [
    { label: 'By top-level domain', data: summary.referringLinksTld },
    { label: 'By link type', data: summary.referringLinksTypes },
    { label: 'By link attribute', data: summary.referringLinksAttributes },
    { label: 'By platform', data: summary.referringLinksPlatformTypes },
    { label: 'By country', data: summary.referringLinksCountries },
  ];

  const present = distributions.filter((entry) => entry.data !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">Referring link breakdown</CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        {present.length === 0 ? (
          <EmptyState
            variant="not-measured"
            subject="the referring-link breakdown"
            prerequisite="A snapshot whose summary call returned distributions"
          />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {present.map((entry) => (
              <div key={entry.label} className="space-y-2">
                <h3 className="text-table font-medium text-foreground">{entry.label}</h3>
                {Object.keys(entry.data ?? {}).length === 0 ? (
                  <p className="text-meta text-muted-foreground">
                    The provider returned this breakdown with no entries.
                  </p>
                ) : (
                  <ul className="space-y-1 text-table">
                    {Object.entries(entry.data ?? {})
                      .sort(([, a], [, b]) => b - a)
                      .slice(0, 8)
                      .map(([key, value]) => (
                        <li key={key} className="flex items-baseline justify-between gap-4">
                          <span className="truncate text-muted-foreground">{key}</span>
                          <span className="tabular-nums">{formatNumber(value)}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-meta text-muted-foreground">
          Distributions describe the links the provider counted for this target, in the same sample
          the counts above come from.
        </p>
      </CardContent>
    </Card>
  );
}

function snapshotTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'pending':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}
