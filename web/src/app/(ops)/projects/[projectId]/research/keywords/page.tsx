'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatCurrency, formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  getPriorityKeywords,
  getResearchScope,
  listKeywordSets,
  runKeywordResearch,
  type KeywordRow,
  type KeywordSet,
  type PriorityKeyword,
  type PriorityKeywordsResult,
  type ResearchScope,
} from '@/services/research-library';

/**
 * KW01 — Keyword research.
 *
 * design_plan.md §4.3: *"Seeds, locale/language, related terms, set history,
 * volume/CPC/competition, priorities"*.
 *
 * **The provenance rule this page exists to keep.** Every volume, CPC and
 * competition figure on this screen is **third-party vendor data** — a licensed
 * keyword-data API's estimate of what advertisers pay and how much demand
 * exists. It is not a measurement of this client's traffic, and it is not a
 * measurement of anything Cailyx observed. §1.5's separation of concepts
 * applies: these are demand estimates, not outcomes, and the page labels them
 * as vendor estimates at the column, not only in a footnote.
 *
 * Two more specifics the backend states and this screen repeats rather than
 * flattens:
 *
 *  - **Competition is advertiser-competition pressure, not organic ranking
 *    difficulty.** The data source has no such metric. Relabelling it would
 *    invent one.
 *  - **The priority order is a disclosed formula, not proof of conversion
 *    potential** — its weights are shown alongside the ranking, and keywords
 *    with no volume data are listed separately instead of being dropped.
 */
/**
 * `setId` defaults to the `all` sentinel rather than `''`, because `FilterBar`'s
 * select control always offers its "no filter" option under that value — a
 * different default would render a select whose value matches no option.
 */
const FILTER_DEFAULTS = { setId: 'all', minVolume: 0, q: '' };

/** Stable reference: `useUrlState` decodes against it on every render. */
const TAB_DEFAULTS = { tab: 'keywords' };

export default function KeywordResearchPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [sets, setSets] = useState<KeywordSet[] | null>(null);
  const [activeSet, setActiveSet] = useState<KeywordSet | null>(null);
  const [priority, setPriority] = useState<PriorityKeywordsResult | null>(null);
  const [priorityMissing, setPriorityMissing] = useState(false);
  const [priorityError, setPriorityError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const [tabState, setTabState] = useUrlState(TAB_DEFAULTS);
  const tab = tabState.tab;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const loadHistory = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [history] = await Promise.all([
          listKeywordSets(projectId, undefined, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setSets(history);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [loadHistory]);

  /** The set in view: the one in the URL, else the most recent one on file. */
  const activeSetId = filters.setId !== 'all' ? filters.setId : sets?.[0]?.id ?? '';

  useEffect(() => {
    if (!activeSetId) {
      setActiveSet(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const [result] = await listKeywordSets(
          projectId,
          { setId: activeSetId, minVolume: filters.minVolume > 0 ? filters.minVolume : undefined },
          { signal: controller.signal },
        );
        setActiveSet(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setActionError(toApiError(caught));
      }
    })();
    return () => controller.abort();
  }, [projectId, activeSetId, filters.minVolume]);

  useEffect(() => {
    if (!activeSetId) {
      setPriority(null);
      setPriorityMissing(true);
      return;
    }
    const controller = new AbortController();
    setPriorityError(null);
    void (async () => {
      try {
        const result = await getPriorityKeywords(
          projectId,
          { setId: activeSetId, limit: 50 },
          { signal: controller.signal },
        );
        setPriority(result);
        setPriorityMissing(false);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const apiError = toApiError(caught);
        // 404 here is the documented "no eligible set", not a failure to hide.
        if (apiError.kind === 'not-found') {
          setPriority(null);
          setPriorityMissing(true);
        } else {
          setPriorityError(apiError);
        }
      }
    })();
    return () => controller.abort();
  }, [projectId, activeSetId]);

  const keywords = useMemo(() => {
    const rows = activeSet?.keywords ?? [];
    const query = filters.q.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => row.keyword.includes(query));
  }, [activeSet, filters.q]);

  const relatedCount = (activeSet?.keywords ?? []).filter((row) => row.isRelated).length;

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Keyword research" />
        <ErrorState error={error} onRetry={() => void loadHistory()} />
      </div>
    );
  }

  if (!sets) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const keywordColumns: ReadonlyArray<ColumnDef<KeywordRow>> = [
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
      key: 'origin',
      header: 'Origin',
      accessor: (row) => (row.isRelated ? 'related' : 'seed'),
      sortable: true,
      width: 170,
      render: (row) =>
        row.isRelated ? (
          <ProvenanceBadge kind="derived" label="Related suggestion" />
        ) : (
          <ProvenanceBadge kind="operator-supplied" label="Your seed" />
        ),
    },
    {
      key: 'searchVolume',
      header: 'Search volume (vendor estimate)',
      accessor: (row) => row.searchVolume,
      sortable: true,
      align: 'right',
      width: 230,
      // No volume data is a gap in the vendor's coverage, not a zero.
      emptyLabel: 'No volume data',
      render: (row) =>
        row.searchVolume === null ? null : (
          <span className="tabular-nums">{formatNumber(row.searchVolume)}</span>
        ),
    },
    {
      key: 'competition',
      header: 'Advertiser competition (vendor)',
      accessor: (row) => row.competitionIndex ?? row.competition ?? '',
      sortable: true,
      align: 'right',
      width: 230,
      emptyLabel: 'No competition data',
      render: (row) => (
        <span className="text-meta">
          {row.competition ?? 'not bucketed'}
          {row.competitionIndex !== null ? (
            <span className="ml-1 tabular-nums text-muted-foreground">
              ({row.competitionIndex}/100)
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'cpc',
      header: 'Cost per click (vendor, USD)',
      accessor: (row) => row.cpc,
      sortable: true,
      align: 'right',
      width: 220,
      emptyLabel: 'No CPC data',
      render: (row) =>
        row.cpc === null ? null : (
          <span className="tabular-nums">{formatCurrency(row.cpc, 'USD')}</span>
        ),
    },
    {
      key: 'bidRange',
      header: 'Top-of-page bid range',
      accessor: (row) => row.lowTopOfPageBid,
      sortable: true,
      align: 'right',
      width: 200,
      emptyLabel: 'No bid data',
      render: (row) => {
        if (row.lowTopOfPageBid === null && row.highTopOfPageBid === null) return null;
        return (
          <span className="tabular-nums text-meta">
            {row.lowTopOfPageBid === null ? '—' : formatCurrency(row.lowTopOfPageBid, 'USD')} to{' '}
            {row.highTopOfPageBid === null ? '—' : formatCurrency(row.highTopOfPageBid, 'USD')}
          </span>
        );
      },
    },
    {
      key: 'isLongTail',
      header: 'Long tail',
      accessor: (row) => (row.isLongTail ? 'yes' : 'no'),
      sortable: true,
      width: 120,
      render: (row) => (
        <span className="text-meta">
          {row.isLongTail ? 'Yes (4+ words)' : 'No'}
        </span>
      ),
    },
  ];

  const priorityColumns: ReadonlyArray<ColumnDef<PriorityKeyword>> = [
    {
      key: 'priorityScore',
      header: 'Priority score',
      accessor: (row) => row.priorityScore,
      sortable: true,
      align: 'right',
      width: 150,
      render: (row) => (
        <span className="font-semibold tabular-nums">{formatNumber(row.priorityScore)}</span>
      ),
    },
    {
      key: 'keyword',
      header: 'Keyword',
      accessor: (row) => row.keyword,
      sortable: true,
      cellClassName: 'whitespace-normal',
      render: (row) => <span className="font-medium">{row.keyword}</span>,
    },
    {
      key: 'searchVolume',
      header: 'Volume (vendor)',
      accessor: (row) => row.searchVolume,
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: 'No volume data',
      render: (row) =>
        row.searchVolume === null ? null : (
          <span className="tabular-nums">{formatNumber(row.searchVolume)}</span>
        ),
    },
    {
      key: 'competitionIndex',
      header: 'Advertiser competition',
      accessor: (row) => row.competitionIndex,
      sortable: true,
      align: 'right',
      width: 200,
      emptyLabel: 'No competition data',
      render: (row) =>
        row.competitionIndex === null ? null : (
          <span className="tabular-nums">{row.competitionIndex}/100</span>
        ),
    },
    {
      key: 'cpc',
      header: 'CPC (vendor, USD)',
      accessor: (row) => row.cpc,
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: 'No CPC data',
      render: (row) =>
        row.cpc === null ? null : (
          <span className="tabular-nums">{formatCurrency(row.cpc, 'USD')}</span>
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
          { label: 'Keyword research' },
        ]}
        title="Keyword research"
        context={
          <>
            {sets.length} research set{sets.length === 1 ? '' : 's'} on file
            {activeSet
              ? ` · viewing ${activeSet.seedInput.length} seed${
                  activeSet.seedInput.length === 1 ? '' : 's'
                } from ${activeSet.locationName ?? 'no location set'}`
              : ''}
          </>
        }
        primaryAction={{ label: 'Research keywords', onClick: () => setResearchOpen(true) }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void loadHistory()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <Alert>
        <AlertTitle>Volume, CPC and competition here are a third party&rsquo;s estimates</AlertTitle>
        <AlertDescription>
          These figures come from a licensed keyword-data vendor. They are an estimate of how much
          search demand exists and what advertisers pay for it — they are <strong>not</strong> a
          measurement of this client&rsquo;s traffic, rankings or revenue, and Cailyx has not
          observed them. Nothing here is combined with a measured outcome, and the competition
          figure measures advertiser pressure, not how hard a keyword is to rank for organically:
          the data source has no organic-difficulty metric, so none is shown.
        </AlertDescription>
      </Alert>

      {actionError ? (
        <ErrorState error={actionError} layout="inline" onRetry={() => void loadHistory()} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Set history</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <SetHistoryTable
            sets={sets}
            activeSetId={activeSetId}
            onSelect={(set) => setFilters({ setId: set.id })}
          />
        </CardContent>
      </Card>

      {!activeSet ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="Keyword research"
              prerequisite="No research set exists for this project. A run pulls live volume, competition and CPC for your seed keywords and, by default, related long-tail suggestions."
              action={{ label: 'Research keywords', onClick: () => setResearchOpen(true) }}
            />
          </CardContent>
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={(value) => setTabState({ tab: value }, { push: true })}>
          <TabsList>
            <TabsTrigger value="keywords">Keywords ({activeSet.keywords.length})</TabsTrigger>
            <TabsTrigger value="priority">Priority order</TabsTrigger>
          </TabsList>

          <TabsContent value="keywords" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">
                  Seeds and expansions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-2">
                <dl className="grid gap-x-8 gap-y-2 text-table sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-meta text-muted-foreground">Seeds entered</dt>
                    <dd>{activeSet.seedInput.join(', ') || 'None recorded'}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Location</dt>
                    <dd>{activeSet.locationName ?? 'Not set — the vendor default was used'}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Language</dt>
                    <dd>{activeSet.languageCode ?? 'Not set — the vendor default was used'}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Related suggestions</dt>
                    <dd>
                      <span className="tabular-nums">{relatedCount}</span> of{' '}
                      <span className="tabular-nums">{activeSet.keywords.length}</span> rows
                    </dd>
                  </div>
                </dl>

                {activeSet.status === 'partial' ? (
                  <Alert>
                    <AlertTitle>Partial run — seed volumes saved, expansion failed</AlertTitle>
                    <AlertDescription>
                      {activeSet.error ??
                        'The related-keyword expansion call failed. The seed rows below are still the vendor’s real returned data.'}
                    </AlertDescription>
                  </Alert>
                ) : activeSet.status === 'failed' ? (
                  <Alert>
                    <AlertTitle>Run failed</AlertTitle>
                    <AlertDescription>
                      {activeSet.error ?? 'The vendor call did not return usable data.'}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <FilterBar
                  defaults={FILTER_DEFAULTS}
                  value={filters}
                  onChange={setFilters}
                  controls={[
                    {
                      kind: 'select',
                      key: 'setId',
                      label: 'Research set',
                      allLabel: 'Most recent set',
                      options: sets.map((set) => ({
                        value: set.id,
                        label: setLabel(set),
                      })),
                    },
                    {
                      kind: 'text',
                      key: 'q',
                      label: 'Keyword contains',
                      placeholder: 'filter the loaded rows',
                    },
                  ]}
                  summary={
                    filters.minVolume > 0
                      ? `Server-filtered to volume ≥ ${formatNumber(filters.minVolume)}`
                      : `Showing ${keywords.length} of ${activeSet.keywords.length}`
                  }
                />

                <DataTable
                  caption="Keywords in the research set"
                  columns={keywordColumns}
                  rows={keywords}
                  getRowId={(row) => row.id}
                  defaultSort={{ key: 'searchVolume', direction: 'desc' }}
                  minTableWidth="88rem"
                  emptyState={
                    filters.q !== '' ? (
                      <EmptyState
                        variant="no-results"
                        onClearFilters={() => setFilters({ ...FILTER_DEFAULTS })}
                      />
                    ) : (
                      <EmptyState
                        variant="not-measured"
                        subject="Keywords in this set"
                        prerequisite="The vendor returned no keyword rows for this set — check the run's error above."
                      />
                    )
                  }
                  toolbar={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setFilters({
                          minVolume: filters.minVolume > 0 ? 0 : 100,
                        })
                      }
                    >
                      {filters.minVolume > 0
                        ? 'Clear the volume floor'
                        : 'Only volume ≥ 100'}
                    </Button>
                  }
                />

                <p className="text-meta text-muted-foreground">
                  A blank volume cell means the vendor returned no volume for that keyword. That is a
                  gap in the vendor&rsquo;s coverage, not a keyword nobody searches for, and it is
                  never rendered as zero.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="priority" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-subsection">
                  Ranked by a disclosed formula
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-2">
                {priorityError ? (
                  <ErrorState
                    error={priorityError}
                    layout="inline"
                    onRetry={() => void loadHistory()}
                  />
                ) : priorityMissing || !priority ? (
                  <EmptyState
                    variant="not-measured"
                    subject="Keyword priority order"
                    prerequisite="The ranking reads a completed or partially-completed set. This project has none yet — run a research set first."
                    action={{ label: 'Research keywords', onClick: () => setResearchOpen(true) }}
                    layout="inline"
                  />
                ) : (
                  <>
                    <p className="text-table text-muted-foreground">
                      A deterministic ranking over the fields above: search volume, inverse
                      advertiser competition and CPC-derived commercial intent. It is a disclosed
                      formula, not proof of conversion potential — a high score means a keyword looks
                      commercially promising on vendor data, nothing more.
                    </p>
                    <dl className="flex flex-wrap gap-x-8 gap-y-2 text-meta">
                      <div>
                        <dt className="inline text-muted-foreground">Search volume weight: </dt>
                        <dd className="inline tabular-nums">
                          {formatNumber(priority.weights.volume * 100)}%
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted-foreground">
                          Inverse advertiser competition weight:{' '}
                        </dt>
                        <dd className="inline tabular-nums">
                          {formatNumber(priority.weights.competition * 100)}%
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted-foreground">
                          Commercial intent (CPC) weight:{' '}
                        </dt>
                        <dd className="inline tabular-nums">
                          {formatNumber(priority.weights.commercialIntent * 100)}%
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted-foreground">Ranked: </dt>
                        <dd className="inline">
                          <Timestamp value={priority.rankedAt} />
                        </dd>
                      </div>
                    </dl>

                    <DataTable
                      caption="Keywords in priority order"
                      columns={priorityColumns}
                      rows={priority.keywords}
                      getRowId={(row) => row.id}
                      defaultSort={{ key: 'priorityScore', direction: 'desc' }}
                      minTableWidth="70rem"
                      searchable
                      emptyState={
                        <EmptyState
                          variant="not-measured"
                          subject="Ranked keywords"
                          prerequisite="No keyword in this set had search-volume data, so nothing could be ranked. See the unranked rows below."
                          layout="inline"
                        />
                      }
                    />

                    <div>
                      <h3 className="text-table font-medium">
                        Excluded for having no volume data ({priority.unscored.length})
                      </h3>
                      <p className="mt-1 text-meta text-muted-foreground">
                        These are kept and listed rather than dropped: a missing vendor figure is not
                        a low one, and silently omitting them would make the ranking look complete.
                      </p>
                      {priority.unscored.length === 0 ? (
                        <p className="mt-1 text-meta text-muted-foreground">
                          Every keyword in this set had volume data.
                        </p>
                      ) : (
                        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta">
                          {priority.unscored.map((row) => (
                            <li key={row.id}>{row.keyword}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <ResearchDialog
        open={researchOpen}
        onOpenChange={setResearchOpen}
        projectId={projectId}
        onDone={() => {
          setResearchOpen(false);
          void loadHistory();
        }}
        onError={setActionError}
      />
    </div>
  );
}

function SetHistoryTable({
  sets,
  activeSetId,
  onSelect,
}: {
  sets: KeywordSet[];
  activeSetId: string;
  onSelect: (set: KeywordSet) => void;
}) {
  const columns: ReadonlyArray<ColumnDef<KeywordSet>> = [
    {
      key: 'createdAt',
      header: 'Run',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 210,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => <StatusPill label={runStatusLabel(row.status)} tone={runStatusTone(row.status)} />,
    },
    {
      key: 'seeds',
      header: 'Seeds',
      accessor: (row) => row.seedInput.join(', '),
      cellClassName: 'whitespace-normal',
      emptyLabel: 'No seeds recorded',
    },
    {
      key: 'locale',
      header: 'Locale',
      accessor: (row) => `${row.locationName ?? 'default'} / ${row.languageCode ?? 'default'}`,
      width: 220,
    },
    {
      key: 'keywords',
      header: 'Keywords',
      accessor: (row) => row.keywords.length,
      sortable: true,
      align: 'right',
      width: 120,
      render: (row) => <span className="tabular-nums">{row.keywords.length}</span>,
    },
    {
      key: 'cost',
      header: 'Vendor charge',
      accessor: (row) => row.costUsd,
      sortable: true,
      align: 'right',
      width: 160,
      render: (row) => (
        <span className="tabular-nums">{formatCurrency(row.costUsd, 'USD')}</span>
      ),
    },
    {
      key: 'open',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) =>
        row.id === activeSetId ? (
          <span className="text-meta text-muted-foreground">In view</span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onSelect(row)}>
            View set
          </Button>
        ),
    },
  ];

  return (
    <DataTable
      caption="Keyword research set history"
      columns={columns}
      rows={sets}
      getRowId={(row) => row.id}
      defaultSort={{ key: 'createdAt', direction: 'desc' }}
      minTableWidth="76rem"
      rowDetail={(row) =>
        row.error ? (
          <p className="text-table">
            <span className="text-muted-foreground">Run error:</span>{' '}
            <span className="evidence">{row.error}</span>
          </p>
        ) : (
          <p className="text-table text-muted-foreground">
            Completed cleanly. Finished{' '}
            {row.finishedAt ? <Timestamp value={row.finishedAt} /> : 'time not recorded'}.
          </p>
        )
      }
      emptyState={
        <EmptyState
          variant="not-measured"
          subject="Keyword research history"
          prerequisite="No keyword research has been run for this project. It is a paid vendor call, so it only runs when you start it."
          layout="inline"
        />
      }
    />
  );
}

function ResearchDialog({
  open,
  onOpenChange,
  projectId,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [seedText, setSeedText] = useState('');
  const [locationName, setLocationName] = useState('');
  const [languageCode, setLanguageCode] = useState('');
  const [includeRelated, setIncludeRelated] = useState(true);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const seeds = seedText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  async function submit() {
    setRunning(true);
    setFormError(null);
    try {
      await runKeywordResearch(projectId, {
        keywords: seeds,
        locationName: locationName.trim() || undefined,
        languageCode: languageCode.trim() || undefined,
        includeRelated,
      });
      setSeedText('');
      onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(apiError);
      onError(apiError);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        setFormError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Research keywords</DialogTitle>
          <DialogDescription>
            Pulls live search volume, advertiser competition and CPC for your seed keywords, plus
            related long-tail suggestions. This is a <strong>paid vendor call</strong> and runs
            immediately — it is never triggered by opening a screen.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="the keyword data vendor"
            preserveNotice="Nothing was stored."
          />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="kw-seeds">Seed keywords (required, one per line)</Label>
            <Textarea
              id="kw-seeds"
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
              rows={5}
              placeholder={'ai visibility audit\nanswer engine optimization\ngeo for saas'}
            />
            <p className="text-meta text-muted-foreground">
              {seeds.length === 0
                ? 'At least one seed is required.'
                : `${seeds.length} seed${seeds.length === 1 ? '' : 's'} entered. They are trimmed, lowercased and de-duplicated before the vendor call.`}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="kw-location">Location</Label>
              <Input
                id="kw-location"
                value={locationName}
                onChange={(event) => setLocationName(event.target.value)}
                placeholder="e.g. United Kingdom"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kw-language">Language code</Label>
              <Input
                id="kw-language"
                value={languageCode}
                onChange={(event) => setLanguageCode(event.target.value)}
                placeholder="e.g. en"
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div>
              <Label htmlFor="kw-related">Include related and long-tail expansion</Label>
              <p className="mt-1 text-meta text-muted-foreground">
                One extra vendor call over the first 20 seeds. Turning it off is cheaper and returns
                only your seeds&rsquo; own figures.
              </p>
            </div>
            <Switch id="kw-related" checked={includeRelated} onCheckedChange={setIncludeRelated} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={running || seeds.length === 0}>
            {running ? 'Researching…' : 'Run keyword research'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function setLabel(set: KeywordSet): string {
  const first = set.seedInput[0] ?? 'no seeds';
  const extra = set.seedInput.length > 1 ? ` +${set.seedInput.length - 1}` : '';
  return `${first}${extra}`;
}

function runStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'unmeasured';
  }
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'partial':
      return 'Partial';
    case 'failed':
      return 'Failed';
    case 'pending':
      return 'Pending';
    default:
      return `Unrecognized: ${status}`;
  }
}
