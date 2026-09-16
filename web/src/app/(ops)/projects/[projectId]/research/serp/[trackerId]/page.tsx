'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  addSerpQueries,
  captureSerpSnapshot,
  getResearchScope,
  getSerpSnapshot,
  getSerpTracker,
  listSerpSnapshots,
  parseJsonColumn,
  removeSerpQuery,
  type LocalPackEntry,
  type ResearchScope,
  type SerpQuery,
  type SerpResult,
  type SerpSnapshot,
  type SerpSnapshotDetail,
  type SerpTracker,
} from '@/services/research-library';

/**
 * SP02 — Search snapshot.
 *
 * design_plan.md §4.3: *"Queries, capture history/detail, ranks, AI Overview/
 * local pack, competitors"*.
 *
 * **This screen exists to keep two measurements apart**, and §1.5 names the
 * pair explicitly: a *search position* is where the client's page ranked in the
 * organic results for a keyword; an *AI-answer rate* is a count of answers that
 * mentioned the client. They are over different populations — organic result
 * slots versus generated answers — and adding them, averaging them, or drawing
 * them on one axis produces a number that means nothing.
 *
 * So they are two panels, with two headings, two denominators and no shared
 * total:
 *
 *  - **Search positions** — `subjectRank` per keyword, out of the organic
 *    results for that keyword. Better is a *lower* number.
 *  - **AI Overview presence** — counts of how many tracked keywords produced an
 *    AI Overview at all, and how many of those named the client. That is a
 *    count **over tracked keywords**, not the AEO rate: the AEO rate is counted
 *    over collected answers on the AI-visibility screens, and calling this one
 *    by that name is exactly the confusion §1.5 warns about.
 *
 * Local pack gets its own panel for the same reason, and because it is gated:
 * when a market's business type makes a local-pack question meaningless the
 * backend returns `applicable: false` and this screen renders "not applicable"
 * rather than "0 of 0 found".
 */
const VIEW_DEFAULTS = { snapshot: '' };

export default function SearchSnapshotPage() {
  const params = useParams<{ projectId: string; trackerId: string }>();
  const { projectId, trackerId } = params;

  const [tracker, setTracker] = useState<SerpTracker | null>(null);
  const [snapshots, setSnapshots] = useState<SerpSnapshot[] | null>(null);
  const [detail, setDetail] = useState<SerpSnapshotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const [view, setView] = useUrlState(VIEW_DEFAULTS);
  const selectedSnapshotId = view.snapshot;

  const [captureConfirm, setCaptureConfirm] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureResult, setCaptureResult] = useState<{
    status: string;
    queriesRun: number;
    costUsd: number;
    note: string | null;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<SerpQuery | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [trackerResult, snapshotsResult] = await Promise.all([
          getSerpTracker(projectId, trackerId, { signal }),
          listSerpSnapshots(projectId, trackerId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setTracker(trackerResult);
        setSnapshots(snapshotsResult);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, trackerId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const activeSnapshotId = selectedSnapshotId || snapshots?.[0]?.id || '';

  useEffect(() => {
    if (!activeSnapshotId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    void (async () => {
      try {
        const result = await getSerpSnapshot(projectId, trackerId, activeSnapshotId, {
          signal: controller.signal,
        });
        setDetail(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setActionError(toApiError(caught));
      } finally {
        setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [projectId, trackerId, activeSnapshotId]);

  const results = useMemo(() => detail?.results ?? [], [detail]);
  const ranked = results.filter((row) => row.subjectRank !== null);
  const withAiOverview = results.filter((row) => row.aiOverviewPresent);
  const aiOverviewMentioning = withAiOverview.filter((row) => row.aiOverviewMentionsSubject);
  const localApplicable = results.filter((row) => row.localPackApplicable);
  const localPresent = localApplicable.filter((row) => row.localPackPresent === true);

  async function handleCapture() {
    setCapturing(true);
    setActionError(null);
    setCaptureResult(null);
    try {
      const rollup = await captureSerpSnapshot(projectId, trackerId, {
        provider: tracker?.provider === 'fixture' ? 'fixture' : 'dataforseo',
      });
      setCaptureResult(rollup);
      setCaptureConfirm(false);
      setView({ snapshot: rollup.snapshotId }, { push: true });
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setCapturing(false);
    }
  }

  async function handleRemoveQuery(query: SerpQuery) {
    setActionError(null);
    try {
      await removeSerpQuery(projectId, trackerId, query.id);
      setPendingRemove(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Search snapshot" />
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      </div>
    );
  }

  if (!tracker || !snapshots) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const positionColumns: ReadonlyArray<ColumnDef<SerpResult>> = [
    {
      key: 'keyword',
      header: 'Keyword',
      accessor: (row) => row.keyword,
      sortable: true,
      width: 260,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.keyword}</span>,
    },
    {
      key: 'subjectRank',
      header: 'Organic position',
      accessor: (row) => row.subjectRank,
      sortable: true,
      align: 'right',
      width: 170,
      // Not ranking in the first page is a position we did not observe, not a
      // position of zero.
      emptyLabel: 'Not in the captured results',
      render: (row) =>
        row.subjectRank === null ? null : (
          <span className="font-semibold tabular-nums">#{row.subjectRank}</span>
        ),
    },
    {
      key: 'subjectUrl',
      header: 'Ranking page',
      accessor: (row) => row.subjectUrl,
      width: 300,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No page ranked for this keyword',
      render: (row) => (row.subjectUrl ? <SafeLink href={row.subjectUrl} /> : null),
    },
    {
      key: 'featuredSnippet',
      header: 'Featured snippet holder',
      accessor: (row) => row.featuredSnippetDomain,
      width: 210,
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No featured snippet on this result',
    },
    {
      key: 'topDomains',
      header: 'First-page domains seen',
      accessor: (row) => parseJsonColumn<unknown[]>(row.topDomains, 'array')?.length ?? null,
      sortable: true,
      align: 'right',
      width: 180,
      emptyLabel: 'Not recorded',
      render: (row) => {
        const domains = parseJsonColumn<Array<{ domain?: string; rank?: number }>>(row.topDomains, 'array');
        if (domains === null) return null;
        return <span className="tabular-nums">{domains.length}</span>;
      },
    },
    {
      key: 'competitors',
      header: 'Named competitors seen',
      accessor: (row) => parseJsonColumn<string[]>(row.competitorsSeen, 'array')?.length ?? null,
      align: 'right',
      width: 200,
      emptyLabel: 'None recorded',
      render: (row) => {
        const names = parseJsonColumn<string[]>(row.competitorsSeen, 'array');
        if (names === null) return null;
        if (names.length === 0) {
          return <span className="text-meta text-muted-foreground">none</span>;
        }
        return <span className="text-meta">{names.join(', ')}</span>;
      },
    },
  ];

  const aiOverviewColumns: ReadonlyArray<ColumnDef<SerpResult>> = [
    {
      key: 'keyword',
      header: 'Keyword',
      accessor: (row) => row.keyword,
      sortable: true,
      width: 300,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.keyword}</span>,
    },
    {
      key: 'present',
      header: 'AI Overview shown',
      accessor: (row) => (row.aiOverviewPresent ? 'yes' : 'no'),
      sortable: true,
      width: 190,
      render: (row) => (
        <StatusPill
          label={row.aiOverviewPresent ? 'Shown' : 'Not shown'}
          tone={row.aiOverviewPresent ? 'info' : 'neutral'}
        />
      ),
    },
    {
      key: 'mentions',
      header: 'Named the client',
      accessor: (row) => (row.aiOverviewMentionsSubject ? 'yes' : 'no'),
      sortable: true,
      width: 190,
      render: (row) =>
        row.aiOverviewPresent ? (
          <StatusPill
            label={row.aiOverviewMentionsSubject ? 'Named' : 'Not named'}
            tone={row.aiOverviewMentionsSubject ? 'success' : 'unmeasured'}
          />
        ) : (
          <span className="text-meta text-muted-foreground">No overview to be named in</span>
        ),
    },
    {
      key: 'sources',
      header: 'Distinct sources cited',
      accessor: (row) => row.sourceCount,
      sortable: true,
      align: 'right',
      width: 190,
    },
  ];

  const localPackColumns: ReadonlyArray<ColumnDef<SerpResult>> = [
    {
      key: 'keyword',
      header: 'Keyword',
      accessor: (row) => row.keyword,
      sortable: true,
      width: 280,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.keyword}</span>,
    },
    {
      key: 'applicable',
      header: 'Local pack relevant',
      accessor: (row) => (row.localPackApplicable ? 'yes' : 'no'),
      sortable: true,
      width: 190,
      render: (row) =>
        row.localPackApplicable ? (
          <StatusPill label="Relevant" tone="neutral" />
        ) : (
          <ProvenanceBadge kind="unmeasured" label="Not applicable" />
        ),
    },
    {
      key: 'present',
      header: 'Client in the pack',
      accessor: (row) => (row.localPackApplicable ? (row.localPackPresent ? 'yes' : 'no') : null),
      sortable: true,
      width: 190,
      emptyLabel: 'Not applicable',
      render: (row) => {
        if (!row.localPackApplicable) {
          return (
            <span className="text-meta text-muted-foreground">
              {row.localPackReason ?? 'A local pack is not a meaningful result for this business.'}
            </span>
          );
        }
        if (row.localPackPresent === null) {
          return (
            <span className="text-meta text-unmeasured-foreground">
              No local pack appeared for this keyword
            </span>
          );
        }
        return (
          <StatusPill
            label={row.localPackPresent ? 'Present' : 'Not present'}
            tone={row.localPackPresent ? 'success' : 'neutral'}
          />
        );
      },
    },
    {
      key: 'rank',
      header: 'Rank in pack',
      accessor: (row) => row.localPackRank,
      sortable: true,
      align: 'right',
      width: 140,
      emptyLabel: 'Not in the pack',
      render: (row) =>
        row.localPackRank === null ? null : (
          <span className="tabular-nums">{row.localPackRank}</span>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <ScopeBanner
        sticky
        scope={{
          clientName: scope?.clientName ?? undefined,
          domain: scope?.domain,
          market: `${tracker.locationName} · ${tracker.languageCode} · ${tracker.device}`,
          projectName: scope?.projectName,
          runLabel: detail
            ? `Snapshot captured ${detail.capturedAt}`
            : 'No snapshot selected',
          mode: 'live',
        }}
      />
      {scopeReadFailed ? (
        <p className="text-meta text-muted-foreground">
          The project context could not be read, so the client name is not shown above. The market
          and device come from the tracker itself.
        </p>
      ) : null}

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          ...(scope ? [{ label: scope.projectName, href: `/projects/${projectId}` }] : []),
          { label: 'Search trackers', href: `/projects/${projectId}/research/serp` },
          { label: tracker.name },
        ]}
        title={tracker.name}
        context={
          <>
            {tracker.locationName} · {tracker.languageCode} ·{' '}
            <span className="capitalize">{tracker.device}</span> ·{' '}
            {tracker.queries?.length ?? 0} tracked keyword
            {(tracker.queries?.length ?? 0) === 1 ? '' : 's'}
          </>
        }
        status={
          tracker.provider === 'fixture' ? (
            <ProvenanceBadge kind="unmeasured" label="Offline fixture — not real search data" />
          ) : (
            <ProvenanceBadge kind="measured" label={`Licensed SERP feed: ${tracker.provider}`} />
          )
        }
        primaryAction={{
          label: capturing ? 'Capturing…' : 'Capture snapshot',
          onClick: () => setCaptureConfirm(true),
          disabled: capturing || (tracker.queries?.length ?? 0) === 0,
          disabledReason:
            'A tracker with no keywords has nothing to capture — add at least one keyword first.',
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
              Add keywords
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void load()} />
      ) : null}

      {captureResult ? (
        <Alert>
          <AlertTitle>
            Capture {captureResult.status} — {captureResult.queriesRun} keyword
            {captureResult.queriesRun === 1 ? '' : 's'} read
          </AlertTitle>
          <AlertDescription>
            <p className="text-table">
              Vendor charge for this snapshot: ${captureResult.costUsd.toFixed(4)}
            </p>
            {captureResult.note ? <p className="mt-1 text-meta">{captureResult.note}</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Capture history</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Captured snapshots"
            columns={[
              {
                key: 'capturedAt',
                header: 'Captured',
                accessor: (row) => row.capturedAt,
                sortable: true,
                width: 210,
                render: (row) => <Timestamp value={row.capturedAt} />,
              },
              {
                key: 'status',
                header: 'Status',
                accessor: (row) => row.status,
                sortable: true,
                width: 130,
                render: (row) => (
                  <StatusPill label={snapshotStatusLabel(row.status)} tone={snapshotStatusTone(row.status)} />
                ),
              },
              {
                key: 'queriesRun',
                header: 'Keywords read',
                accessor: (row) => row.queriesRun,
                sortable: true,
                align: 'right',
                width: 160,
                render: (row) => <span className="tabular-nums">{row.queriesRun}</span>,
              },
              {
                key: 'costUsd',
                header: 'Vendor charge',
                accessor: (row) => row.costUsd,
                sortable: true,
                align: 'right',
                width: 160,
                render: (row) => <span className="tabular-nums">${row.costUsd.toFixed(4)}</span>,
              },
              {
                key: 'note',
                header: 'Note',
                accessor: (row) => row.note,
                cellClassName: 'whitespace-normal',
                emptyLabel: 'No note',
                render: (row) => (row.note ? <span className="evidence">{row.note}</span> : null),
              },
              {
                key: 'open',
                header: '',
                width: 120,
                alwaysVisible: true,
                render: (row) =>
                  row.id === activeSnapshotId ? (
                    <span className="text-meta text-muted-foreground">In view</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setView({ snapshot: row.id }, { push: true })}
                    >
                      View
                    </Button>
                  ),
              },
            ] satisfies ReadonlyArray<ColumnDef<SerpSnapshot>>}
            rows={snapshots}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'capturedAt', direction: 'desc' }}
            minTableWidth="70rem"
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="Captured snapshots"
                prerequisite="This tracker has never been captured. A capture reads the licensed SERP feed for every tracked keyword and is bounded by a server-side USD cap."
                action={{ label: 'Capture snapshot', onClick: () => setCaptureConfirm(true) }}
                layout="inline"
              />
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Tracked keywords</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <QueryTable
            queries={tracker.queries ?? []}
            resultsByKeyword={new Map(results.map((row) => [row.keyword, row]))}
            onRemove={setPendingRemove}
          />
        </CardContent>
      </Card>

      {!detail ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="Per-keyword results"
              prerequisite={
                snapshots.length === 0
                  ? 'No snapshot has been captured for this tracker yet.'
                  : 'Select a snapshot above to read its per-keyword results.'
              }
            />
          </CardContent>
        </Card>
      ) : detailLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Search positions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="measured" label="Organic result positions" />
                <span className="text-meta text-muted-foreground">
                  Snapshot captured <Timestamp value={detail.capturedAt} /> · positions read with{' '}
                  <span className="capitalize">{tracker.device}</span>
                </span>
              </div>
              <p className="text-table text-muted-foreground">
                A position is where the client&rsquo;s page appeared in the organic results for that
                keyword.{' '}
                <strong>
                  {ranked.length} of {results.length}
                </strong>{' '}
                tracked keywords had a client page in the captured results. Lower is better, and a
                keyword with no position is reported as &ldquo;{notMeasuredLabel().toLowerCase()}
                &rdquo; — never as position zero.
              </p>
              <p className="text-meta text-muted-foreground">
                These are search positions. They are a different measurement from the counted
                AI-answer figures in the next panel: one is a slot in a ranked list of links, the
                other is a tally of generated answers. Nothing here adds the two together.
              </p>
              <DataTable
                caption="Organic positions per keyword"
                columns={positionColumns}
                rows={results}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'subjectRank', direction: 'asc' }}
                minTableWidth="84rem"
                searchable
                rowDetail={(row) => <ResultDetail row={row} />}
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="Per-keyword positions"
                    prerequisite="This snapshot stored no per-keyword results."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">AI Overview presence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="measured" label="Counted from the same capture" />
                <span className="text-meta text-muted-foreground">
                  Counted over tracked keywords, in this one snapshot
                </span>
              </div>
              <dl className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-border p-3">
                  <dt className="text-meta text-muted-foreground">
                    Tracked keywords with an AI Overview
                  </dt>
                  <dd className="mt-1 text-kpi tabular-nums">
                    {withAiOverview.length} of {results.length}
                  </dd>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <dt className="text-meta text-muted-foreground">
                    Of those, how many named the client
                  </dt>
                  <dd className="mt-1 text-kpi tabular-nums">
                    {aiOverviewMentioning.length} of {withAiOverview.length}
                  </dd>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <dt className="text-meta text-muted-foreground">
                    Keywords with no AI Overview
                  </dt>
                  <dd className="mt-1 text-kpi tabular-nums">
                    {results.length - withAiOverview.length}
                  </dd>
                </div>
              </dl>
              <Alert>
                <AlertTitle>These counts are not an AEO rate</AlertTitle>
                <AlertDescription>
                  This is a tally over <strong>tracked keywords in this snapshot</strong>. The AEO
                  rate in design_plan §1.5 is counted over <strong>collected answers</strong> on the
                  AI-visibility screens — a different denominator over a different population. The
                  two are never combined, and neither is a ranking.
                </AlertDescription>
              </Alert>
              <DataTable
                caption="AI Overview presence per keyword"
                columns={aiOverviewColumns}
                rows={results}
                getRowId={(row) => `ai-${row.id}`}
                defaultSort={{ key: 'present', direction: 'desc' }}
                minTableWidth="64rem"
                searchable
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="AI Overview presence"
                    prerequisite="This snapshot stored no per-keyword results."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Local pack</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-table text-muted-foreground">
                Whether a local pack is a meaningful result depends on the kind of business, so the
                backend gates this per query:{' '}
                {localApplicable.length === 0
                  ? 'no keyword in this snapshot had a local-pack question asked of it.'
                  : `${localPresent.length} of ${localApplicable.length} applicable keywords showed the client in the pack.`}
              </p>
              <p className="text-meta text-muted-foreground">
                A keyword where a local pack is not relevant is reported as not applicable with its
                reason, never as &ldquo;0 of 0 found&rdquo; — which would read as a fabricated zero.
              </p>
              <DataTable
                caption="Local pack presence per keyword"
                columns={localPackColumns}
                rows={results}
                getRowId={(row) => `local-${row.id}`}
                defaultSort={{ key: 'keyword', direction: 'asc' }}
                minTableWidth="70rem"
                searchable
                rowDetail={(row) => <LocalPackDetail row={row} />}
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="Local pack presence"
                    prerequisite="This snapshot stored no per-keyword results."
                    layout="inline"
                  />
                }
              />
            </CardContent>
          </Card>
        </>
      )}

      <AddKeywordsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        trackerId={trackerId}
        trackerName={tracker.name}
        existingCount={tracker.queries?.length ?? 0}
        onAdded={() => {
          setAddOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <ConfirmDialog
        open={captureConfirm}
        onOpenChange={setCaptureConfirm}
        title="Capture a new snapshot"
        confirmLabel="Capture snapshot"
        targetLabel="Tracker"
        target={`${tracker.name} (${tracker.locationName} · ${tracker.device})`}
        effect={
          <>
            Reads the licensed SERP feed for all {tracker.queries?.length ?? 0} tracked keyword
            {(tracker.queries?.length ?? 0) === 1 ? '' : 's'} and stores a new snapshot. This{' '}
            <strong>costs money at the data provider</strong>; the server stops the capture at its
            own USD cap and reports any keywords left unrun.
          </>
        }
        scope={
          <>
            Existing snapshots are not modified — rank history is kept so a change over time stays
            visible. Nothing on the client&rsquo;s site is touched and no search traffic is
            generated.
          </>
        }
        onConfirm={handleCapture}
        onReload={() => void load()}
      />

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="Remove a tracked keyword"
        confirmLabel="Remove keyword"
        destructive
        targetLabel="Keyword"
        target={pendingRemove?.keyword ?? ''}
        effect={
          <>
            The keyword stops being tracked and is removed from the tracker. Results already captured
            under it stay in past snapshots; it simply will not appear in the next capture.
          </>
        }
        scope={<>Only this tracker is affected.</>}
        onConfirm={async () => {
          if (pendingRemove) await handleRemoveQuery(pendingRemove);
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

function QueryTable({
  queries,
  resultsByKeyword,
  onRemove,
}: {
  queries: SerpQuery[];
  resultsByKeyword: Map<string, SerpResult>;
  onRemove: (query: SerpQuery) => void;
}) {
  const columns: ReadonlyArray<ColumnDef<SerpQuery>> = [
    {
      key: 'keyword',
      header: 'Keyword',
      accessor: (row) => row.keyword,
      sortable: true,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.keyword}</span>,
    },
    {
      key: 'latest',
      header: 'In the selected snapshot',
      accessor: (row) => (resultsByKeyword.has(row.keyword) ? 'captured' : 'missing'),
      width: 240,
      render: (row) =>
        resultsByKeyword.has(row.keyword) ? (
          <StatusPill label="Result stored" tone="success" />
        ) : (
          <StatusPill label="No result stored" tone="unmeasured" />
        ),
    },
    {
      key: 'addedAt',
      header: 'Added',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'actions',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="ghost" size="sm" onClick={() => onRemove(row)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <DataTable
      caption="Tracked keywords"
      columns={columns}
      rows={queries}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'keyword', direction: 'asc' }}
      minTableWidth="58rem"
      searchable
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Tracked keywords"
          prerequisite="This tracker has no keywords, so a capture would have nothing to read."
          layout="inline"
        />
      }
    />
  );
}

function ResultDetail({ row }: { row: SerpResult }) {
  const domains = parseJsonColumn<Array<{ domain?: string; rank?: number }>>(row.topDomains, 'array');
  const competitors = parseJsonColumn<string[]>(row.competitorsSeen, 'array');

  return (
    <div className="space-y-2 text-table">
      <p className="text-meta text-muted-foreground">
        Captured <Timestamp value={row.capturedAt} /> · {row.rawItemCount} raw items returned ·{' '}
        {row.sourceCount} distinct sources cited across features
      </p>
      {domains === null ? (
        <p className="text-meta text-unmeasured-foreground">
          The first-page domain list stored for this keyword could not be read.
        </p>
      ) : (
        <div>
          <h4 className="text-meta font-medium text-foreground">First-page domains</h4>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta">
            {domains.slice(0, 20).map((entry) => (
              <li key={`${entry.domain}-${entry.rank}`}>
                #{entry.rank ?? '—'} {entry.domain ?? 'domain not recorded'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {competitors && competitors.length > 0 ? (
        <p className="text-meta">
          <span className="text-muted-foreground">Named competitors appearing:</span>{' '}
          {competitors.join(', ')}
        </p>
      ) : null}
      {row.featuredSnippetDomain ? (
        <p className="text-meta">
          <span className="text-muted-foreground">Featured snippet held by:</span>{' '}
          {row.featuredSnippetDomain}
        </p>
      ) : null}
    </div>
  );
}

function LocalPackDetail({ row }: { row: SerpResult }) {
  const entries = parseJsonColumn<LocalPackEntry[]>(row.localPackEntries, 'array');
  return (
    <div className="space-y-2 text-table">
      {row.localPackReason ? (
        <p className="text-meta text-muted-foreground">{row.localPackReason}</p>
      ) : null}
      {entries === null ? (
        <p className="text-meta text-unmeasured-foreground">
          The stored local-pack entries could not be read.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          No local pack appeared for this keyword, so no businesses were listed.
        </p>
      ) : (
        <div>
          <h4 className="text-meta font-medium text-foreground">Businesses the pack showed</h4>
          <ol className="mt-1 space-y-0.5 text-meta">
            {entries.map((entry, index) => (
              <li key={`${entry.domain ?? entry.title ?? 'entry'}-${index}`}>
                {index + 1}. {entry.title ?? 'Untitled'}
                {entry.domain ? ` — ${entry.domain}` : ''}
                {entry.rating !== null ? ` · rating ${entry.rating}` : ''}
                {entry.reviewCount !== null ? ` (${formatNumber(entry.reviewCount)} reviews)` : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function AddKeywordsDialog({
  open,
  onOpenChange,
  projectId,
  trackerId,
  trackerName,
  existingCount,
  onAdded,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  trackerId: string;
  trackerName: string;
  existingCount: number;
  onAdded: () => void;
  onError: (error: ApiError) => void;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const keywords = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      await addSerpQueries(projectId, trackerId, keywords);
      setText('');
      onAdded();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add tracked keywords</DialogTitle>
          <DialogDescription>
            Adds keywords to {trackerName}. Existing keywords are skipped — the server de-duplicates
            — and the tracker has a hard cap of 300 keywords, past which the request is rejected.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            preserveNotice="The tracker's existing keywords are unchanged."
          />
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="sp2-keywords">Keywords (required, one per line)</Label>
          <Textarea
            id="sp2-keywords"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
          />
          <p className="text-meta text-muted-foreground">
            {existingCount} keyword{existingCount === 1 ? '' : 's'} already tracked ·{' '}
            {keywords.length} new entr{keywords.length === 1 ? 'y' : 'ies'} in this box.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || keywords.length === 0}>
            {saving ? 'Adding…' : 'Add keywords'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SafeLink({ href }: { href: string }) {
  const isSafe = href.startsWith('/') || /^https?:\/\//i.test(href);
  if (!isSafe) {
    return <span className="evidence">{href} (not a link: unsupported URL scheme)</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-primary underline-offset-4 hover:underline"
    >
      <ExternalLink aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
      {href}
    </a>
  );
}

function snapshotStatusTone(status: string): StatusTone {
  switch (status) {
    case 'complete':
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

function snapshotStatusLabel(status: string): string {
  switch (status) {
    case 'complete':
      return 'Complete';
    case 'partial':
      return 'Partial — cap or failures';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Running';
    default:
      return `Unrecognized: ${status}`;
  }
}
