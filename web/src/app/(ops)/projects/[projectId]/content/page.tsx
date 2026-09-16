'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import {
  ASSET_TYPE_LABELS,
  CONTENT_ASSET_TYPES,
  isGeneratable,
  listContentBriefs,
  listGrowthAssets,
  type ContentBrief,
  type GrowthAsset,
} from '@/services/content';

/**
 * CT02 — Content library.
 *
 * design_plan.md §4.4: *"Filter nine asset types; distinguish brief-only from
 * generated content; status, keyword, source gap/model."*
 *
 * The load-bearing distinction on this screen is the second clause, and §5.8's
 * asset table is what decides it:
 *
 *  - **Brief only** is a complete, intended outcome for seven of the nine
 *    types. They are not "waiting to be generated" — the generator does not
 *    cover them at all, and a human writes them through the approved external
 *    editorial process. Saying "not generated yet" for those would be a false
 *    promise, so the cell says which of the two it is.
 *  - **Generated** means a real draft exists (`content !== null`), and the
 *    model that wrote it is named.
 *
 * Filters live in the URL (§3.2/§10.1), so a link reproduces the exact slice.
 */

const FILTER_DEFAULTS = {
  q: '',
  assetType: 'all',
  status: 'all',
  content: 'all',
};

const ASSET_TYPE_OPTIONS = CONTENT_ASSET_TYPES.map((type) => ({
  value: type,
  label: ASSET_TYPE_LABELS[type],
}));

const STATUS_OPTIONS = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'published', label: 'Published' },
];

const CONTENT_OPTIONS = [
  { value: 'generated', label: 'Generated draft' },
  { value: 'brief-only', label: 'Brief only' },
];

export default function ContentLibraryPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [assets, setAssets] = useState<GrowthAsset[] | null>(null);
  const [briefs, setBriefs] = useState<ContentBrief[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [briefsError, setBriefsError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await listGrowthAssets(projectId, {}, { signal });
        setAssets(result.assets);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  const loadBriefs = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setBriefsError(null);
        const result = await listContentBriefs(projectId, { latestOnly: true }, { signal });
        setBriefs(result.briefs);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setBriefsError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void loadBriefs(controller.signal);
    return () => controller.abort();
  }, [load, loadBriefs]);

  const filtered = useMemo(() => {
    if (!assets) return [];
    const query = filters.q.trim().toLowerCase();
    return assets.filter((asset) => {
      if (filters.assetType !== 'all' && asset.assetType !== filters.assetType) return false;
      if (filters.status !== 'all' && asset.status !== filters.status) return false;
      if (filters.content === 'generated' && !asset.content) return false;
      if (filters.content === 'brief-only' && asset.content) return false;
      if (!query) return true;
      return [asset.title, asset.brief, asset.targetKeyword ?? '', asset.generationModel ?? '']
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [assets, filters]);

  const filtersActive =
    filters.q !== FILTER_DEFAULTS.q ||
    filters.assetType !== FILTER_DEFAULTS.assetType ||
    filters.status !== FILTER_DEFAULTS.status ||
    filters.content !== FILTER_DEFAULTS.content;

  const columns: ReadonlyArray<ColumnDef<GrowthAsset>> = [
    {
      key: 'title',
      header: 'Asset',
      accessor: (row) => row.title,
      sortable: true,
      width: 280,
      render: (row) => (
        <div className="min-w-0">
          <Link
            href={`/projects/${projectId}/content/${row.id}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {row.title}
          </Link>
          <p className="text-meta text-muted-foreground">{row.brief}</p>
        </div>
      ),
    },
    {
      key: 'assetType',
      header: 'Type',
      accessor: (row) => ASSET_TYPE_LABELS[row.assetType],
      sortable: true,
      width: 190,
    },
    {
      key: 'content',
      header: 'Content',
      accessor: (row) => (row.content ? 'generated' : 'brief-only'),
      sortable: true,
      width: 210,
      render: (row) =>
        row.content ? (
          <div className="space-y-1">
            <StatusPill label="Generated draft" tone="info" />
            <p className="text-meta text-muted-foreground">
              {row.generationModel ?? 'Model not recorded'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <StatusPill label="Brief only" tone="unmeasured" />
            <p className="text-meta text-muted-foreground">
              {/* §5.8's table: seven types are brief-only by design, not pending. */}
              {isGeneratable(row.assetType)
                ? 'No draft generated yet — generate from an approved brief.'
                : 'Not machine-generated; this type is written externally.'}
            </p>
          </div>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => (
        <StatusPill label={assetStatusLabel(row.status)} tone={assetStatusTone(row.status)} />
      ),
    },
    {
      key: 'targetKeyword',
      header: 'Keyword',
      accessor: (row) => row.targetKeyword,
      sortable: true,
      width: 180,
      emptyLabel: 'No keyword attached',
    },
    {
      key: 'source',
      header: 'Source',
      accessor: (row) => (row.sourceGapId ? `gap:${row.sourceGapId}` : row.source),
      width: 170,
      // A brief built from a gap and a brief written by hand are different
      // provenance, and the design plan asks for the source to be visible.
      render: (row) => (
        <span className="text-meta text-muted-foreground">
          {row.sourceGapId ? 'From a gap' : 'No source gap'} · {row.source}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      accessor: (row) => row.updatedAt,
      sortable: true,
      width: 180,
      render: (row) => <Timestamp value={row.updatedAt} />,
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!assets) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const generated = assets.filter((asset) => asset.content !== null).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content"
        context={
          assets.length === 0
            ? 'No content assets have been created for this project yet.'
            : `${assets.length} asset${assets.length === 1 ? '' : 's'} · ${generated} with a generated draft · ${
                assets.length - generated
              } brief only`
        }
        primaryAction={{
          label: 'Generate content',
          href: `/projects/${projectId}/content/generate`,
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content/opportunities`}>Opportunities</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void load();
                void loadBriefs();
              }}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        controls={[
          { kind: 'select', key: 'assetType', label: 'Asset type', options: ASSET_TYPE_OPTIONS },
          { kind: 'select', key: 'status', label: 'Status', options: STATUS_OPTIONS },
          { kind: 'select', key: 'content', label: 'Content', options: CONTENT_OPTIONS },
        ]}
        summary={`Showing ${filtered.length} of ${assets.length}`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Asset library</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Content assets"
            columns={columns}
            rows={filtered}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'updatedAt', direction: 'desc' }}
            minTableWidth="64rem"
            emptyState={
              filtersActive ? (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() => setFilters(FILTER_DEFAULTS)}
                />
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="content assets"
                  prerequisite="create recommended assets from the content opportunities screen, or generate an article from an approved brief"
                  action={{
                    label: 'Open content opportunities',
                    href: `/projects/${projectId}/content/opportunities`,
                  }}
                >
                  Nine asset types can be tracked here. Seven of them are brief-only by design —
                  a brief is the deliverable, and a human writes the copy.
                </EmptyState>
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Content briefs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-meta text-muted-foreground">
            A brief is the instruction set generation is bound to. A version is never rewritten once
            approved — editing an approved brief creates a new version instead, so a job that
            recorded a version keeps pointing at the instructions it used.
          </p>

          {briefsError ? (
            <ErrorState
              error={briefsError}
              layout="inline"
              onRetry={() => void loadBriefs()}
              preserveNotice="The asset library above is unaffected."
            />
          ) : null}

          {!briefs && !briefsError ? <Skeleton className="h-24 rounded-xl" /> : null}

          {briefs && briefs.length === 0 ? (
            <p className="text-table text-muted-foreground">
              No instruction-set brief has been created yet. Generation needs an approved brief —
              you can create one on the generate screen.
            </p>
          ) : null}

          {briefs && briefs.length > 0 ? (
            <ul className="divide-y divide-border">
              {briefs.map((brief) => (
                <li
                  key={brief.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-table font-medium text-foreground">
                      {brief.title}
                      <span className="ml-2 text-meta text-muted-foreground">v{brief.version}</span>
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {ASSET_TYPE_LABELS[brief.assetType]}
                      {brief.targetQuery ? ` · targets “${brief.targetQuery}”` : ''}
                      {brief.approvedAt ? ' · approved ' : ''}
                      {brief.approvedAt ? <Timestamp value={brief.approvedAt} dateOnly /> : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill label={briefStatusLabel(brief.status)} tone={briefStatusTone(brief.status)} />
                    <Link
                      href={`/projects/${projectId}/content/generate?briefId=${brief.id}`}
                      className="text-table text-primary underline-offset-4 hover:underline"
                    >
                      {brief.status === 'approved' ? 'Generate from this brief' : 'Open in generate'}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/** The asset lifecycle, as its own tone map rather than a borrowed one. */
function assetStatusTone(status: string): StatusTone {
  switch (status) {
    case 'published':
      return 'success';
    case 'in-progress':
      return 'info';
    case 'recommended':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function assetStatusLabel(status: string): string {
  switch (status) {
    case 'recommended':
      return 'Recommended';
    case 'in-progress':
      return 'In progress';
    case 'published':
      return 'Published';
    default:
      return status;
  }
}

function briefStatusTone(status: ContentBrief['status']): StatusTone {
  switch (status) {
    case 'approved':
      return 'success';
    case 'draft':
      return 'unmeasured';
    case 'archived':
      return 'neutral';
  }
}

function briefStatusLabel(status: ContentBrief['status']): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'draft':
      return 'Draft';
    case 'archived':
      return 'Archived';
  }
}
