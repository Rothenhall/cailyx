'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar, FILTER_ALL } from '@/components/patterns/FilterBar';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  GAP_ACTIONS,
  GAP_ACTION_LABEL,
  GAP_CATEGORIES,
  GAP_CATEGORY_LABEL,
  GAP_DIMENSIONS,
  GAP_DIMENSION_LABEL,
  GAP_STATUS_LABEL,
  GAP_STATUSES,
  QUADRANT_LABELS,
  getGapMatrix,
  listGaps,
  syncGaps,
  type Gap,
  type GapMatrix,
  type GapStatus,
  type ImpactEffortQuadrant,
} from '@/services/planning';

/**
 * PJ05 — Priorities.
 *
 * design_plan.md §4.3: *"Classified gaps, category/action/dimension, priority
 * inputs, impact/effort view, details"*, support "E gap endpoints; team work
 * conversion G06".
 *
 * Three things this screen is careful about, all of them consequences of what
 * a gap actually is:
 *
 * 1. **A gap is a classification, not a measurement.** It is derived from some
 *    other module's stored finding, which is why every row carries a provenance
 *    badge of `derived` and a `sourceType:sourceId` pair you can follow. The
 *    screen never presents a gap's score as an observed fact.
 * 2. **Auto-assigned versus overridden is a first-class fact.** Every axis
 *    (dimension, action, category) and the score itself carry an
 *    `*AutoAssigned` flag. A re-sync will overwrite the automatic ones and
 *    preserve the overridden ones, so a reader who cannot tell them apart
 *    cannot predict what today's list becomes tomorrow. The columns say which
 *    is which.
 * 3. **Nothing here compares across gaps that were measured differently.** The
 *    priority score is a portfolio input (1–5 manual bands), the impact/effort
 *    pair is a quadrant input, and they are shown as separate columns rather
 *    than combined. §1.5's rule that separate concepts must not become one
 *    score applies here as much as anywhere.
 */
type Filters = {
  q: string;
  dimension: string;
  action: string;
  category: string;
  status: string;
  view: string;
};

const FILTER_DEFAULTS: Filters = {
  q: '',
  dimension: FILTER_ALL,
  action: FILTER_ALL,
  category: FILTER_ALL,
  status: FILTER_ALL,
  view: 'list',
};

export default function PrioritiesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [filters, setFilters] = useUrlState<Filters>(FILTER_DEFAULTS);

  const [gaps, setGaps] = useState<Gap[] | null>(null);
  /** Empty string means no gap analysis row exists yet — a real distinct state. */
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<GapMatrix | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const serverFilters = useMemo(
    () => ({
      dimension: filters.dimension === FILTER_ALL ? undefined : filters.dimension,
      action: filters.action === FILTER_ALL ? undefined : filters.action,
      category: filters.category === FILTER_ALL ? undefined : filters.category,
      status: filters.status === FILTER_ALL ? undefined : filters.status,
    }),
    [filters.dimension, filters.action, filters.category, filters.status],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setLoading(true);
        const [list, matrixResult] = await Promise.all([
          listGaps(projectId, serverFilters, { signal }),
          getGapMatrix(projectId, { signal }),
        ]);
        setGaps(list.gaps);
        setAnalysisId(list.id);
        setMatrix(matrixResult);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [projectId, serverFilters],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rows = useMemo(() => {
    const list = gaps ?? [];
    const search = filters.q.trim().toLowerCase();
    if (!search) return list;
    return list.filter((gap) =>
      `${gap.title} ${gap.description} ${gap.sourceType} ${gap.status}`
        .toLowerCase()
        .includes(search),
    );
  }, [gaps, filters.q]);

  const isFiltered =
    filters.dimension !== FILTER_ALL ||
    filters.action !== FILTER_ALL ||
    filters.category !== FILTER_ALL ||
    filters.status !== FILTER_ALL ||
    filters.q.trim() !== '';

  const counts = useMemo(() => {
    const list = gaps ?? [];
    const open = list.filter((gap) => gap.status === 'open').length;
    const actionable = list.filter((gap) => gap.category !== 'strength');
    const scored = actionable.filter((gap) => gap.priorityScore !== null);
    return {
      total: list.length,
      open,
      quickWins: list.filter((gap) => gap.quadrant === 'quick-win').length,
      scoredCount: scored.length,
    };
  }, [gaps]);

  async function onSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncNotice(null);
    setSyncError(null);
    try {
      const result = await syncGaps(projectId);
      setSyncNotice(
        `Re-classified: ${formatNumber(result.created)} new, ${formatNumber(result.updated)} updated, ${formatNumber(result.pruned)} removed. Operator overrides were preserved.`,
      );
      await load();
    } catch (caught) {
      setSyncError(toApiError(caught).message);
    } finally {
      setSyncing(false);
    }
  }

  const columns: ColumnDef<Gap>[] = [
    {
      key: 'title',
      header: 'Finding',
      accessor: (row) => row.title,
      sortable: true,
      // `linkColumnKey="title"` below already wraps this cell in the row's
      // link — rendering another <Link> here would nest an <a> inside an <a>.
      render: (row) => <span>{row.title}</span>,
      searchText: (row) => `${row.title} ${row.description}`,
    },
    {
      key: 'category',
      header: 'Category',
      accessor: (row) => row.category,
      sortable: true,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusPill
            tone={categoryTone(row.category)}
            label={GAP_CATEGORY_LABEL[row.category as keyof typeof GAP_CATEGORY_LABEL] ?? row.category}
          />
          {/* The override state is stated in text, not implied by colour. */}
          <span className="text-meta text-muted-foreground">
            {row.categoryAutoAssigned ? 'auto' : 'set by an operator'}
          </span>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      accessor: (row) => row.action,
      sortable: true,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{GAP_ACTION_LABEL[row.action as keyof typeof GAP_ACTION_LABEL] ?? row.action}</span>
          <span className="text-meta text-muted-foreground">
            {row.actionAutoAssigned ? 'auto' : 'set by an operator'}
          </span>
        </span>
      ),
    },
    {
      key: 'dimension',
      header: 'Dimension',
      accessor: (row) => row.dimension,
      sortable: true,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>
            {GAP_DIMENSION_LABEL[row.dimension as keyof typeof GAP_DIMENSION_LABEL] ?? row.dimension}
          </span>
          <span className="text-meta text-muted-foreground">
            {row.dimensionAutoAssigned ? 'auto' : 'set by an operator'}
          </span>
        </span>
      ),
    },
    {
      key: 'impact',
      header: 'Impact',
      accessor: (row) => row.impactScore,
      sortable: true,
      align: 'right',
      // A strength has no impact score by construction — "not measured" is the
      // right reading, and 0 would be a claim.
      emptyLabel: notMeasuredLabel(),
      render: (row) => renderBand(row.impactScore, row.scoreAutoAssigned),
    },
    {
      key: 'effort',
      header: 'Effort',
      accessor: (row) => row.effortScore,
      sortable: true,
      align: 'right',
      emptyLabel: notMeasuredLabel(),
      render: (row) => renderBand(row.effortScore, row.scoreAutoAssigned),
    },
    {
      key: 'quadrant',
      header: 'Quadrant',
      accessor: (row) => row.quadrant,
      sortable: true,
      emptyLabel: 'No quadrant (nothing to prioritise)',
      render: (row) =>
        row.quadrant ? (
          QUADRANT_LABELS[row.quadrant as ImpactEffortQuadrant] ?? row.quadrant
        ) : (
          <span className="text-meta text-muted-foreground">No quadrant</span>
        ),
    },
    {
      key: 'priorityScore',
      header: 'Priority score',
      accessor: (row) => row.priorityScore,
      sortable: true,
      align: 'right',
      emptyLabel: notMeasuredLabel(),
      render: (row) =>
        row.priorityScore === null ? (
          <span className="text-meta text-muted-foreground">{notMeasuredLabel()}</span>
        ) : (
          <span className="tabular-nums">{formatNumber(row.priorityScore)}</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      render: (row) => (
        <StatusPill
          tone={row.status === 'resolved' ? 'success' : row.status === 'in-progress' ? 'info' : 'neutral'}
          label={GAP_STATUS_LABEL[row.status as GapStatus] ?? row.status}
        />
      ),
    },
    {
      key: 'source',
      header: 'Source',
      accessor: (row) => `${row.sourceType}:${row.sourceId}`,
      render: (row) => (
        <span className="block max-w-[22ch] truncate font-mono text-meta" title={`${row.sourceType}:${row.sourceId}`}>
          {row.sourceType}
        </span>
      ),
      searchText: (row) => `${row.sourceType} ${row.sourceId}`,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Priorities' },
        ]}
        title="Priorities"
        context="Findings classified from the latest stored audit evidence, with their priority inputs."
        status={<ProvenanceBadge kind="derived" label="Derived from stored findings" />}
        primaryAction={{
          label: syncing ? 'Re-classifying…' : 'Re-classify from stored findings',
          onClick: () => void onSync(),
          disabled: syncing,
          disabledReason: syncing
            ? 'A re-classification is already in flight.'
            : undefined,
        }}
      />

      <p className="text-table text-muted-foreground">
        Re-classifying is read-only: it reads what the audit modules have already stored and regroups
        it. It never starts a scan, a crawl or a paid call, and it preserves axes an operator has
        overridden.
      </p>

      {syncNotice ? (
        <Alert>
          <AlertDescription>{syncNotice}</AlertDescription>
        </Alert>
      ) : null}

      {syncError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Re-classification failed</AlertTitle>
          <AlertDescription>{syncError}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => void load()}
          preserveNotice="Nothing on this page modifies findings except the explicit re-classify action."
        />
      ) : null}

      {loading && !gaps ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <MetricTile
              label="Classified findings"
              value={counts.total}
              note="Rows currently classified from stored evidence."
            />
            <MetricTile
              label="Still open"
              value={counts.open}
              note="Not yet marked in-progress or resolved."
            />
            <MetricTile
              label="Quick wins"
              value={counts.quickWins}
              note="High impact against low effort, as classified."
            />
            <MetricTile
              label="With a priority score"
              value={counts.scoredCount}
              unit={`of ${formatNumber(counts.total)}`}
              note="The rest have no PR/outreach bands set yet — that is unmeasured, not zero."
            />
          </div>

          <Tabs
            value={filters.view}
            onValueChange={(value) => setFilters({ view: value })}
          >
            <TabsList>
              <TabsTrigger value="list">List</TabsTrigger>
              <TabsTrigger value="matrix">Impact / effort view</TabsTrigger>
            </TabsList>

            <TabsContent value="list" className="space-y-4 pt-4">
              <FilterBar
                defaults={FILTER_DEFAULTS}
                value={filters}
                onChange={setFilters}
                controls={[
                  {
                    kind: 'select',
                    key: 'category',
                    label: 'Category',
                    allLabel: 'All categories',
                    options: GAP_CATEGORIES.map((value) => ({
                      value,
                      label: GAP_CATEGORY_LABEL[value],
                    })),
                  },
                  {
                    kind: 'select',
                    key: 'action',
                    label: 'Action',
                    allLabel: 'All actions',
                    options: GAP_ACTIONS.map((value) => ({
                      value,
                      label: GAP_ACTION_LABEL[value],
                    })),
                  },
                  {
                    kind: 'select',
                    key: 'dimension',
                    label: 'Dimension',
                    allLabel: 'All dimensions',
                    options: GAP_DIMENSIONS.map((value) => ({
                      value,
                      label: GAP_DIMENSION_LABEL[value],
                    })),
                  },
                  {
                    kind: 'select',
                    key: 'status',
                    label: 'Status',
                    allLabel: 'Any status',
                    options: GAP_STATUSES.map((value) => ({
                      value,
                      label: GAP_STATUS_LABEL[value],
                    })),
                  },
                ]}
                searchPlaceholder="Search title, description or source…"
                summary={
                  <>
                    {formatNumber(rows.length)} of {formatNumber(counts.total)} classified findings.
                    Category, action, dimension and status are applied by the server; the search box
                    filters the rows already loaded.
                  </>
                }
              />

              <DataTable<Gap>
                columns={columns}
                rows={rows}
                getRowId={(row) => row.id}
                caption="Classified gaps"
                minTableWidth="76rem"
                error={error ? error.message : null}
                onRetry={() => void load()}
                rowHref={(row) => `/projects/${projectId}/priorities/${row.id}`}
                linkColumnKey="title"
                emptyState={
                  analysisId === '' ? (
                    <EmptyState
                      variant="not-measured"
                      subject="gap classification for this project"
                      prerequisite="a re-classification run against stored audit findings"
                      action={{ label: 'Re-classify from stored findings', onClick: () => void onSync() }}
                      layout="inline"
                    >
                      <p>
                        No gap analysis row exists for this project yet, so nothing has been
                        classified. That is why the list is empty — not because no problems were
                        found.
                      </p>
                    </EmptyState>
                  ) : isFiltered ? (
                    <EmptyState
                      variant="no-results"
                      onClearFilters={() =>
                        setFilters({
                          q: '',
                          dimension: FILTER_ALL,
                          action: FILTER_ALL,
                          category: FILTER_ALL,
                          status: FILTER_ALL,
                        })
                      }
                      layout="inline"
                    />
                  ) : (
                    <EmptyState
                      variant="not-measured"
                      subject="classifiable findings"
                      prerequisite="a completed audit module that produced findings to classify"
                      layout="inline"
                    >
                      <p>
                        Classification ran and produced no findings, which usually means no audit
                        module has stored results yet. Running an audit is what gives this screen
                        something to classify.
                      </p>
                    </EmptyState>
                  )
                }
              />
            </TabsContent>

            <TabsContent value="matrix" className="space-y-4 pt-4">
              <p className="text-table text-muted-foreground">
                Quadrants are computed by the server from the impact and effort bands — they are
                never stored independently, so an override of either band moves the item honestly.
                Strengths do not appear here: there is nothing to prioritise fixing.
              </p>

              {!matrix || matrix.total === 0 ? (
                <Card>
                  <CardContent className="pt-6">
                    <EmptyState
                      variant="not-measured"
                      subject="the impact/effort matrix"
                      prerequisite="gaps with both an impact and an effort band"
                      layout="panel"
                    >
                      <p>
                        No gap currently carries both bands. Strengths never carry them by
                        construction, and a finding whose bands have not been classified cannot be
                        placed in a quadrant.
                      </p>
                    </EmptyState>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {matrix.quadrants.map((quadrant) => (
                    <Card key={quadrant.quadrant}>
                      <CardHeader className="flex-row items-center justify-between space-y-0">
                        <CardTitle className="text-subsection">
                          {QUADRANT_LABELS[quadrant.quadrant] ?? quadrant.quadrant}
                        </CardTitle>
                        <span className="text-meta text-muted-foreground">
                          {formatNumber(quadrant.count)}
                        </span>
                      </CardHeader>
                      <CardContent>
                        {quadrant.gaps.length === 0 ? (
                          <p className="text-table text-muted-foreground">
                            No findings in this quadrant.
                          </p>
                        ) : (
                          <ul className="divide-y divide-border">
                            {quadrant.gaps.map((gap) => (
                              <li key={gap.id}>
                                <Link
                                  href={`/projects/${projectId}/priorities/${gap.id}`}
                                  className="flex items-center justify-between gap-3 py-2 text-table underline-offset-4 hover:underline"
                                >
                                  <span className="min-w-0 truncate">{gap.title}</span>
                                  <span className="shrink-0 text-meta text-muted-foreground">
                                    impact {gap.impactScore ?? '—'} / effort{' '}
                                    {gap.effortScore ?? '—'}
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Converting a finding into work</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState
                variant="not-measured"
                subject="one-action conversion from a finding to a work item"
                prerequisite="a work-item create that records the gap as its source (design_plan G06)"
                layout="panel"
              >
                <p>
                  The work-item contract already carries <code className="text-meta">sourceType</code>{' '}
                  and <code className="text-meta">sourceId</code> for exactly this purpose, so the
                  link will be recorded in the data model — but there is no screen that performs the
                  conversion in one action yet.
                </p>
                <p>
                  Today, create the work item from the project&apos;s cycle board and record the
                  finding&apos;s id in its <em>source</em> field. The finding id is on each row above.
                </p>
                <p className="pt-1">
                  <Link href={`/projects/${projectId}/cycles`} className="underline underline-offset-4">
                    Open the cycle board
                  </Link>
                </p>
              </EmptyState>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** A 1–5 band, with its override state made explicit. */
function renderBand(value: number | null, autoAssigned: boolean) {
  if (value === null) {
    return <span className="text-meta text-muted-foreground">{notMeasuredLabel()}</span>;
  }
  return (
    <span className="whitespace-nowrap tabular-nums">
      {formatNumber(value)}
      <span className="ml-1 text-meta text-muted-foreground">
        {autoAssigned ? 'auto' : 'operator'}
      </span>
    </span>
  );
}

function categoryTone(category: string): 'danger' | 'warning' | 'info' | 'success' | 'neutral' {
  switch (category) {
    case 'issue':
      return 'danger';
    case 'risk':
      return 'warning';
    case 'gap':
    case 'opportunity':
      return 'info';
    case 'strength':
      return 'success';
    default:
      return 'neutral';
  }
}
