'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  ASSET_TYPE_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  createRecommendedAssets,
  listContentBriefs,
  listGaps,
  listTopicSuggestions,
  type ContentBrief,
  type GapRow,
  type GrowthAsset,
  type TopicSuggestion,
} from '@/services/content';

/**
 * CT01 — Content opportunities.
 *
 * design_plan.md §4.4: *"Priority keyword topics/ad angles plus gap-derived
 * asset recommendations; generate briefs."* §5.8 Stage A adds the two
 * disclosures this screen must carry: keyword priority is *"a disclosed
 * formula, not proof of conversion potential"*, and the recommendations are
 * **gap-derived** — which means the screen has to be honest about the case
 * where no gap analysis has ever run.
 *
 * That last point is the reason this page has two distinct `not-measured`
 * states instead of one empty table:
 *
 *  - **No keyword topics** — the topics endpoint answers `[]` when no
 *    keyword-research set has completed. An empty list here is "nothing has
 *    been measured", not "there are no opportunities".
 *  - **No gaps** — `gap-analysis` returns an empty set with an empty id when it
 *    has never run. Rendering that as "no recommendations" would tell an
 *    operator their project has no problems, which is the opposite of true.
 *
 * §10.4: the brief-creating write is an explicit, confirmed action with its
 * scope, effect and cost stated first. Nothing here runs on page load.
 */

const FILTER_DEFAULTS = {
  category: 'all',
  status: 'all',
};

const GAP_CATEGORY_OPTIONS = [
  { value: 'issue', label: 'Issue' },
  { value: 'gap', label: 'Gap' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'risk', label: 'Risk' },
  { value: 'strength', label: 'Strength' },
];

const GAP_STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
];

export default function ContentOpportunitiesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [topics, setTopics] = useState<TopicSuggestion[] | null>(null);
  const [gaps, setGaps] = useState<{ analysisId: string; gaps: GapRow[] } | null>(null);
  const [briefs, setBriefs] = useState<ContentBrief[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [gapsError, setGapsError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [useLlm, setUseLlm] = useState(false);
  const [createdBriefs, setCreatedBriefs] = useState<GrowthAsset[] | null>(null);
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [topicRows, briefRows] = await Promise.all([
          listTopicSuggestions(projectId, { signal }),
          listContentBriefs(projectId, { latestOnly: true }, { signal }),
        ]);
        setTopics(topicRows);
        setBriefs(briefRows.briefs);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  const loadGaps = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setGapsError(null);
        setGaps(await listGaps(projectId, {}, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setGapsError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void loadGaps(controller.signal);
    return () => controller.abort();
  }, [load, loadGaps]);

  /**
   * The gaps that can actually become a brief: an open row with a
   * recommendation category and something to act on. A strength is not work,
   * and this mirrors the server's own actionability filter rather than
   * offering a count the create call would not honor.
   */
  const actionableGaps = useMemo(() => {
    if (!gaps) return [];
    return gaps.gaps.filter(
      (gap) =>
        gap.status === 'open' && gap.recommendationCategory !== null && gap.category !== 'strength',
    );
  }, [gaps]);

  const filteredGaps = useMemo(() => {
    return actionableGaps.filter((gap) => {
      if (filters.category !== 'all' && gap.category !== filters.category) return false;
      if (filters.status !== 'all' && gap.status !== filters.status) return false;
      return true;
    });
  }, [actionableGaps, filters]);

  const approvedBriefs = (briefs ?? []).filter((brief) => brief.status === 'approved');
  const gapsMeasured = gaps !== null && gaps.analysisId !== '';
  const topicsMeasured = topics !== null && topics.length > 0;

  async function onCreateBriefs() {
    setCreating(true);
    setActionError(null);
    try {
      const result = await createRecommendedAssets(projectId, {
        perCategoryLimit: 2,
        useLlm,
      });
      setCreatedBriefs(result.assets);
      setConfirmOpen(false);
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setCreating(false);
    }
  }

  const gapColumns: ReadonlyArray<ColumnDef<GapRow>> = [
    {
      key: 'title',
      header: 'Gap',
      accessor: (row) => row.title,
      sortable: true,
      width: 300,
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">{row.title}</p>
          <p className="text-meta text-muted-foreground">{row.description}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Read',
      accessor: (row) => row.category,
      sortable: true,
      width: 120,
    },
    {
      key: 'recommendationCategory',
      header: 'Recommendation',
      accessor: (row) =>
        row.recommendationCategory
          ? (RECOMMENDATION_CATEGORY_LABELS[row.recommendationCategory] ?? row.recommendationCategory)
          : null,
      width: 190,
      emptyLabel: 'Nothing to act on',
    },
    {
      key: 'priorityScore',
      header: 'Priority',
      accessor: (row) => row.priorityScore,
      sortable: true,
      align: 'right',
      width: 100,
      emptyLabel: 'Not scored',
    },
    {
      key: 'impactEffort',
      header: 'Impact / effort',
      accessor: (row) => row.impactScore,
      width: 140,
      render: (row) => (
        <span className="tabular-nums">
          {row.impactScore ?? notMeasuredLabel()} / {row.effortScore ?? notMeasuredLabel()}
        </span>
      ),
    },
  ];

  const topicColumns: ReadonlyArray<ColumnDef<TopicSuggestion>> = [
    {
      key: 'targetKeyword',
      header: 'Target query',
      accessor: (row) => row.targetKeyword,
      sortable: true,
      width: 220,
      render: (row) => <span className="font-medium text-foreground">{row.targetKeyword}</span>,
    },
    {
      key: 'priorityScore',
      header: 'Priority',
      accessor: (row) => row.priorityScore,
      sortable: true,
      align: 'right',
      width: 100,
    },
    {
      key: 'searchVolume',
      header: 'Search volume',
      accessor: (row) => row.searchVolume,
      sortable: true,
      align: 'right',
      width: 140,
      // §3.5 — a keyword with no volume data is unmeasured, never a
      // zero-volume keyword. A `render` replaces the default cell entirely, so
      // the explicit label has to be rendered here rather than left to
      // `emptyLabel`.
      render: (row) =>
        row.searchVolume === null ? (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        ) : (
          <span className="tabular-nums">{formatNumber(row.searchVolume)}</span>
        ),
    },
    {
      key: 'blogTopic',
      header: 'Article topic',
      accessor: (row) => row.blogTopic,
      width: 260,
    },
    {
      key: 'adAngle',
      header: 'Ad angle',
      accessor: (row) => row.adAngle,
      width: 320,
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content opportunities" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!topics || !gaps || !briefs) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content opportunities"
        context="Where the editorial plan comes from: the project's priority keyword topics, and the content work its open gaps imply."
        primaryAction={{
          label: 'Create briefs from gaps',
          onClick: () => setConfirmOpen(true),
          disabled: actionableGaps.length === 0,
          disabledReason: gapsMeasured
            ? 'No open, actionable gap has a recommendation category to build a brief from.'
            : 'Gap analysis has not run for this project, so there are no gap-derived recommendations yet.',
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content`}>Asset library</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void load();
                void loadGaps();
              }}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState
          error={actionError}
          layout="inline"
          preserveNotice="No brief was created by the failed attempt."
        />
      ) : null}

      {createdBriefs ? (
        <Alert>
          <AlertTitle>
            {createdBriefs.length === 0
              ? 'No brief was created'
              : `${createdBriefs.length} brief${createdBriefs.length === 1 ? '' : 's'} created`}
          </AlertTitle>
          <AlertDescription>
            {createdBriefs.length === 0 ? (
              <>
                Every open gap was already covered, or none had a recommendation category. Nothing
                was written — this is not an error.
              </>
            ) : (
              <>
                Grouped by type:{' '}
                {summarizeByType(createdBriefs)}.{' '}
                <Link
                  href={`/projects/${projectId}/content`}
                  className="underline underline-offset-4"
                >
                  Open the asset library
                </Link>{' '}
                to review them. They are briefs, not finished copy.
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Generation prerequisites ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Prerequisites for generation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-table text-muted-foreground">
            Generating a draft needs two things this screen can tell you the state of. It never
            starts the run itself — that happens on the generate screen, deliberately.
          </p>
          <ul className="space-y-2 text-table">
            <li className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-foreground">Priority keyword topics</span>
              <span className={topicsMeasured ? 'text-success' : 'text-unmeasured-foreground'}>
                {topicsMeasured
                  ? `met — ${topics?.length ?? 0} topic${(topics?.length ?? 0) === 1 ? '' : 's'} ranked`
                  : 'not met'}
              </span>
              {!topicsMeasured ? (
                <span className="text-muted-foreground">
                  — a keyword-research set must complete for this project before any topic can be
                  ranked. With no topics there is nothing to generate for.
                </span>
              ) : null}
            </li>
            <li className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-foreground">An approved content brief</span>
              <span className={approvedBriefs.length > 0 ? 'text-success' : 'text-unmeasured-foreground'}>
                {approvedBriefs.length > 0
                  ? `met — ${approvedBriefs.length} approved version${approvedBriefs.length === 1 ? '' : 's'}`
                  : 'not met'}
              </span>
              {approvedBriefs.length === 0 ? (
                <span className="text-muted-foreground">
                  — generation is bound to an approved brief and its exact version.{' '}
                  <Link
                    href={`/projects/${projectId}/content/generate`}
                    className="underline underline-offset-4"
                  >
                    Create and approve one on the generate screen
                  </Link>
                  .
                </span>
              ) : null}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* ── Keyword-derived topics ───────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Priority keyword topics and ad angles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {topicsMeasured ? (
            <>
              <p className="text-meta text-muted-foreground">
                The priority score is a disclosed weighted formula over search volume, advertiser
                competition and CPC. It ranks where to look first; it is not evidence of conversion
                potential.
              </p>
              <DataTable
                caption="Priority keyword topics"
                columns={topicColumns}
                rows={topics ?? []}
                getRowId={(row) => row.targetKeyword}
                defaultSort={{ key: 'priorityScore', direction: 'desc' }}
                minTableWidth="60rem"
                pageSize={25}
              />
            </>
          ) : (
            <EmptyState
              variant="not-measured"
              subject="priority keyword topics"
              prerequisite="a completed keyword-research run for this project"
            >
              Topics and ad angles are derived from the project&rsquo;s ranked keyword set. No set
              has been ranked yet, so this is an unmeasured state rather than an empty one.
            </EmptyState>
          )}
        </CardContent>
      </Card>

      {/* ── Gap-derived recommendations ──────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Recommended assets from open gaps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          {gapsError ? (
            <ErrorState
              error={gapsError}
              layout="inline"
              onRetry={() => void loadGaps()}
              notFoundReason="prerequisite"
            />
          ) : null}

          {!gapsError && !gapsMeasured ? (
            <EmptyState
              variant="not-measured"
              subject="gap-derived content recommendations"
              prerequisite="a gap analysis for this project, which classifies each audit finding into issue / gap / opportunity / strength / risk"
            >
              Recommendations are built by grouping open gaps by their recommendation category and
              mapping each to an asset type. With no gap analysis there is nothing to group — this
              is not an empty recommendation list.
            </EmptyState>
          ) : null}

          {gapsMeasured ? (
            <>
              <p className="text-table text-muted-foreground">
                {actionableGaps.length} of {gaps.gaps.length} classified finding
                {gaps.gaps.length === 1 ? '' : 's'} can carry a brief. Creating briefs groups the
                open ones by recommendation category and maps each category to its asset types — a
                technology gap produces no content asset, because a CRM gap is not a blog post.
              </p>

              <FilterBar
                defaults={FILTER_DEFAULTS}
                value={filters}
                onChange={setFilters}
                hideSearch
                controls={[
                  { kind: 'select', key: 'category', label: 'Read', options: GAP_CATEGORY_OPTIONS },
                  { kind: 'select', key: 'status', label: 'Status', options: GAP_STATUS_OPTIONS },
                ]}
                summary={`Showing ${filteredGaps.length} of ${actionableGaps.length} actionable`}
              />

              <DataTable
                caption="Actionable gaps"
                columns={gapColumns}
                rows={filteredGaps}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'priorityScore', direction: 'desc' }}
                minTableWidth="56rem"
                emptyState={
                  actionableGaps.length === 0 ? (
                    <EmptyState variant="not-measured" subject="actionable gaps">
                      The gap analysis has run and found nothing open with a recommendation
                      category. That is a measured result, not a missing one.
                    </EmptyState>
                  ) : (
                    <EmptyState
                      variant="no-results"
                      onClearFilters={() => setFilters(FILTER_DEFAULTS)}
                    />
                  )
                }
              />
            </>
          ) : null}
        </CardContent>
      </Card>

      {!gapsMeasured || actionableGaps.length === 0 ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Always remember the ceiling on these recommendations</AlertTitle>
          <AlertDescription>
            A gap being open does not make the asset it implies the right next piece of work, and a
            priority score is a formula&rsquo;s output rather than a promise. Whoever owns the
            editorial plan decides what gets written.
          </AlertDescription>
        </Alert>
      ) : null}

      {/*
        §10.4 name-the-mutation row: the exact effect, scope and cost are stated
        before the write, and the confirm label names the action. Brief creation
        is free unless the LLM refinement is switched on, and that is said
        plainly rather than buried in a tooltip.
      */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Create briefs from open gaps?"
        confirmLabel="Create briefs"
        targetLabel="Source"
        target={`${actionableGaps.length} open, actionable gap${actionableGaps.length === 1 ? '' : 's'}`}
        effect={
          <>
            One brief is created per gap × mapped asset type, up to two gaps per recommendation
            category. A brief is a title and an angle — no finished copy is written, and nothing is
            published. Briefs are added alongside any that already exist.
          </>
        }
        scope="This project only."
        onConfirm={onCreateBriefs}
        onConfirmed={() => setConfirmOpen(false)}
      >
        <div className="mt-4 flex items-start justify-between gap-4 rounded-md border border-border bg-surface-sunken p-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="refine-briefs">Refine each brief with a model call</Label>
            <p className="text-meta text-muted-foreground">
              One language-model call per brief, and it may cost money. This build returns no
              pre-flight estimate for brief refinement, so the cost cannot be shown before you
              confirm. Without a configured provider the whole request fails with a 503 before
              anything is written.
            </p>
          </div>
          <Switch
            id="refine-briefs"
            checked={useLlm}
            onCheckedChange={setUseLlm}
            disabled={creating}
          />
        </div>
        {creating ? (
          <p className="mt-3 text-table text-muted-foreground" role="status">
            Creating briefs. Do not submit this again.
          </p>
        ) : null}
      </ConfirmDialog>

      <p className="text-meta text-muted-foreground">
        Keyword priority and gap priority are both ranking aids, not forecasts. Neither is measured
        outcome data.
      </p>
    </div>
  );
}

/** "3 Article / guide, 1 FAQ / knowledge" — a type roll-up of what was just created. */
function summarizeByType(assets: GrowthAsset[]): string {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const label = ASSET_TYPE_LABELS[asset.assetType] ?? asset.assetType;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(', ');
}
