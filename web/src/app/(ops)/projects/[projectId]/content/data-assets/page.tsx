'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  BRAND_ALIGNMENTS,
  BRAND_ALIGNMENT_LABELS,
  DATA_ASSET_STATUSES,
  DATA_ASSET_STATUS_LABELS,
  createDataAsset,
  listDataAssets,
  updateDataAsset,
  type DataAsset,
  type DataAssetStatus,
} from '@/services/data-assets';

/**
 * CT09 — Research / data assets.
 *
 * design_plan.md §4.4: *"Brand alignment, methodology, sample size,
 * planned/fielding/published, source URL."* §5.9 sets the ceiling on what any
 * of it means: *"Current API is a ledger, not a survey platform or dataset
 * warehouse. Add research review before making numeric claims."*
 *
 * That sentence is why this screen is explicit about two things a reader would
 * otherwise assume:
 *
 *  - **A sample size here is a declared design size.** Nothing in Cailyx counts
 *    responses, so the tile says "declared", not "collected".
 *  - **A methodology note is a precondition, not a nicety.** A numeric claim
 *    without a method cannot pass claims discipline downstream, so an asset
 *    missing one is flagged as a gap in the plan rather than shown as fine.
 */

const FILTER_DEFAULTS = {
  q: '',
  brandAlignment: 'all',
  status: 'all',
};

const STATUS_OPTIONS = DATA_ASSET_STATUSES.map((status) => ({
  value: status,
  label: DATA_ASSET_STATUS_LABELS[status],
}));

const ALIGNMENT_OPTIONS = BRAND_ALIGNMENTS.map((alignment) => ({
  value: alignment,
  label: BRAND_ALIGNMENT_LABELS[alignment],
}));

export default function DataAssetsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [assets, setAssets] = useState<DataAsset[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DataAsset | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setAssets(await listDataAssets(projectId, { signal }));
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

  const filtered = useMemo(() => {
    if (!assets) return [];
    const query = filters.q.trim().toLowerCase();
    return assets.filter((asset) => {
      if (filters.brandAlignment !== 'all' && asset.brandAlignment !== filters.brandAlignment) {
        return false;
      }
      if (filters.status !== 'all' && asset.status !== filters.status) return false;
      if (!query) return true;
      return [asset.title, asset.methodologyNote ?? '', asset.assetUrl ?? '']
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [assets, filters]);

  const filtersActive =
    filters.q !== FILTER_DEFAULTS.q ||
    filters.brandAlignment !== FILTER_DEFAULTS.brandAlignment ||
    filters.status !== FILTER_DEFAULTS.status;

  const published = (assets ?? []).filter(
    (asset) => asset.status === 'published' && asset.publishedAt !== null,
  ).length;
  const fielding = (assets ?? []).filter((asset) => asset.status === 'fielding').length;
  const missingMethodology = (assets ?? []).filter(
    (asset) => !asset.methodologyNote || asset.methodologyNote.trim().length === 0,
  ).length;

  const columns: ReadonlyArray<ColumnDef<DataAsset>> = [
    {
      key: 'title',
      header: 'Asset',
      accessor: (row) => row.title,
      sortable: true,
      width: 300,
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">{row.title}</p>
          <p className="text-meta text-muted-foreground">
            Added <Timestamp value={row.createdAt} />
          </p>
        </div>
      ),
    },
    {
      key: 'brandAlignment',
      header: 'Brand alignment',
      accessor: (row) => BRAND_ALIGNMENT_LABELS[row.brandAlignment] ?? row.brandAlignment,
      sortable: true,
      width: 170,
      render: (row) => (
        <span className="text-table">
          {BRAND_ALIGNMENT_LABELS[row.brandAlignment] ?? row.brandAlignment}
          {row.brandAlignment === 'brand-named' ? (
            <span className="block text-meta text-muted-foreground">
              The brand appears in the asset&rsquo;s own name.
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'methodologyNote',
      header: 'Methodology',
      accessor: (row) => row.methodologyNote,
      width: 320,
      emptyLabel: 'No methodology recorded',
      render: (row) =>
        row.methodologyNote ? (
          <span className="text-table text-foreground">{row.methodologyNote}</span>
        ) : (
          <span className="text-table text-warning-foreground">
            No method recorded — a numeric claim from this asset cannot be substantiated yet.
          </span>
        ),
    },
    {
      key: 'surveySize',
      header: 'Sample size (declared)',
      accessor: (row) => row.surveySize,
      sortable: true,
      align: 'right',
      width: 180,
      // Nothing here collects responses; an absent size is unmeasured, not
      // zero. A `render` replaces the default cell, so the label is explicit.
      render: (row) =>
        row.surveySize === null ? (
          <span className="text-unmeasured-foreground">Not declared</span>
        ) : (
          <span className="tabular-nums">{formatNumber(row.surveySize)}</span>
        ),
    },
    {
      key: 'status',
      header: 'Lifecycle',
      accessor: (row) => row.status,
      sortable: true,
      width: 140,
      render: (row) => (
        <StatusPill label={DATA_ASSET_STATUS_LABELS[row.status]} tone={statusTone(row.status)} />
      ),
    },
    {
      key: 'publishedAt',
      header: 'Published',
      accessor: (row) => row.publishedAt,
      sortable: true,
      width: 180,
      render: (row) =>
        row.publishedAt ? (
          <Timestamp value={row.publishedAt} />
        ) : (
          <span className="text-unmeasured-foreground">Not published</span>
        ),
    },
    {
      key: 'assetUrl',
      header: 'Source URL',
      accessor: (row) => row.assetUrl,
      width: 200,
      render: (row) =>
        row.assetUrl && /^https?:\/\//i.test(row.assetUrl) ? (
          <a
            href={row.assetUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open published asset
          </a>
        ) : row.assetUrl ? (
          // §10.5 — an unsupported scheme renders as text, never as a link.
          <span className="text-meta text-muted-foreground">
            “{row.assetUrl}” is not an http(s) address, so it is not linked.
          </span>
        ) : (
          <span className="text-unmeasured-foreground">No URL recorded</span>
        ),
    },
    {
      key: 'edit',
      header: '',
      width: 90,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setEditTarget(row)}>
          Edit
        </Button>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Research & data assets" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!assets) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-60" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Research & data assets"
        context="Original research the brand can be cited for — what it is, how it was produced, and where it lives."
        primaryAction={{ label: 'Add a data asset', onClick: () => setCreateOpen(true) }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <ErrorState
          error={actionError}
          layout="inline"
          preserveNotice="The ledger below is unchanged."
        />
      ) : null}

      <Alert>
        <AlertTitle>This is a ledger, not a research tool</AlertTitle>
        <AlertDescription>
          Cailyx records what the research is, how it will be produced and where it was published.
          It does not field surveys, store datasets or verify a number for you. Every figure entered
          here is supplied by a person, and a numeric claim needs its method recorded before it can
          be substantiated anywhere downstream.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Assets tracked"
          value={assets.length}
          unit="assets"
          provenance="operator-supplied"
          note="Every row here was entered by a person; none is machine-collected."
          evidence={
            <a
              href="#data-assets-table"
              className="text-meta text-primary underline-offset-4 hover:underline"
            >
              Open the ledger
            </a>
          }
        />
        <MetricTile
          label="Fielding"
          value={fielding}
          unit="assets"
          provenance="operator-supplied"
          note="Marked as collecting data now. Cailyx does not observe that work."
        />
        <MetricTile
          label="Published"
          value={published}
          unit="assets"
          provenance="operator-supplied"
          note="Published with a date recorded."
        />
        <MetricTile
          label="Missing a methodology note"
          value={assets.length === 0 ? null : missingMethodology}
          unit="assets"
          provenance={assets.length === 0 ? 'unmeasured' : 'derived'}
          note={
            assets.length === 0
              ? 'Nothing has been added yet, so there is nothing to check.'
              : 'Counted from the rows on this screen. Without a method, a number from these assets cannot be turned into a claim.'
          }
        />
      </div>

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        searchPlaceholder="Search title, method or URL"
        controls={[
          { kind: 'select', key: 'brandAlignment', label: 'Brand alignment', options: ALIGNMENT_OPTIONS },
          { kind: 'select', key: 'status', label: 'Lifecycle', options: STATUS_OPTIONS },
        ]}
        summary={`Showing ${filtered.length} of ${assets.length}`}
      />

      <div id="data-assets-table">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Data asset ledger</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <DataTable
              caption="Data assets"
              columns={columns}
              rows={filtered}
              getRowId={(row) => row.id}
              defaultSort={{ key: 'publishedAt', direction: 'desc' }}
              minTableWidth="76rem"
              emptyState={
                filtersActive ? (
                  <EmptyState
                    variant="no-results"
                    onClearFilters={() => setFilters(FILTER_DEFAULTS)}
                  />
                ) : (
                  <EmptyState
                    variant="not-measured"
                    subject="original research assets"
                    prerequisite="a research plan — an asset is created here before any data exists for it"
                    action={{ label: 'Add a data asset', onClick: () => setCreateOpen(true) }}
                  >
                    Nothing has been tracked yet. A row is a commitment to produce a piece of
                    original research, not evidence that one exists.
                  </EmptyState>
                )
              }
            />
          </CardContent>
        </Card>
      </div>

      <CreateDataAssetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onError={setActionError}
        onCreate={async (input) => {
          await createDataAsset(projectId, input);
          setCreateOpen(false);
          await load();
        }}
      />

      {editTarget ? (
        <EditDataAssetDialog
          asset={editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          onError={setActionError}
          onSave={async (patch) => {
            await updateDataAsset(projectId, editTarget.id, patch);
            setEditTarget(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Create ──────────────────────────────────────────────────────────────

function CreateDataAssetDialog({
  open,
  onOpenChange,
  onCreate,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    title: string;
    brandAlignment?: (typeof BRAND_ALIGNMENTS)[number];
    methodologyNote?: string;
    surveySize?: number;
  }) => Promise<void>;
  onError: (error: ReturnType<typeof toApiError>) => void;
}) {
  const [title, setTitle] = useState('');
  const [alignment, setAlignment] = useState<(typeof BRAND_ALIGNMENTS)[number]>('brand-named');
  const [methodology, setMethodology] = useState('');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const submitting = useRef(false);

  async function submit() {
    if (submitting.current || title.trim().length < 3) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        brandAlignment: alignment,
        ...(methodology.trim() ? { methodologyNote: methodology.trim() } : {}),
        ...(size.trim() ? { surveySize: Number(size) } : {}),
      });
      setTitle('');
      setMethodology('');
      setSize('');
    } catch (caught) {
      const apiError = toApiError(caught);
      setError(apiError);
      onError(apiError);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a data asset</DialogTitle>
          <DialogDescription>
            A plan for a piece of original research. Creating the row does not produce any data — it
            is where the method and the sample size are written down before anyone cites them.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState
            error={error}
            layout="inline"
            // Field links must land on this dialog's own inputs.
            fieldIdPrefix="asset-"
            preserveNotice="What you typed is still here."
          />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="asset-title">Title</Label>
            <Input
              id="asset-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="The 2026 AI Visibility Benchmarks Report"
            />
            <p className="text-meta text-muted-foreground">At least 3 characters.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="asset-alignment">Brand alignment</Label>
            <Select
              value={alignment}
              onValueChange={(value) => setAlignment(value as (typeof BRAND_ALIGNMENTS)[number])}
            >
              <SelectTrigger id="asset-alignment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BRAND_ALIGNMENTS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {BRAND_ALIGNMENT_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">
              A brand-named asset — one whose own name carries the brand — earns citations more
              reliably than one that is merely about the brand&rsquo;s subject.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="asset-methodology">Methodology note</Label>
            <Textarea
              id="asset-methodology"
              rows={4}
              value={methodology}
              onChange={(event) => setMethodology(event.target.value)}
              placeholder="How the data will be collected, from whom, over what window."
            />
            <p className="text-meta text-muted-foreground">
              Strongly recommended at creation. A number without a method is a number nobody can
              check.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="asset-size">Declared sample size (optional)</Label>
            <Input
              id="asset-size"
              type="number"
              min={0}
              inputMode="numeric"
              value={size}
              onChange={(event) => setSize(event.target.value)}
            />
            <p className="text-meta text-muted-foreground">
              The size you intend to field. Nothing here counts actual responses, so leave it empty
              rather than guessing.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || title.trim().length < 3}
            aria-busy={busy}
          >
            {busy ? 'Creating…' : 'Create asset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────

function EditDataAssetDialog({
  asset,
  onOpenChange,
  onSave,
  onError,
}: {
  asset: DataAsset;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: {
    title?: string;
    brandAlignment?: (typeof BRAND_ALIGNMENTS)[number];
    methodologyNote?: string;
    surveySize?: number;
    assetUrl?: string;
    status?: DataAssetStatus;
  }) => Promise<void>;
  onError: (error: ReturnType<typeof toApiError>) => void;
}) {
  const [title, setTitle] = useState(asset.title);
  const [alignment, setAlignment] = useState(asset.brandAlignment);
  const [methodology, setMethodology] = useState(asset.methodologyNote ?? '');
  const [size, setSize] = useState(asset.surveySize === null ? '' : String(asset.surveySize));
  const [status, setStatus] = useState<DataAssetStatus>(asset.status);
  const [assetUrl, setAssetUrl] = useState(asset.assetUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const publishingWithoutUrl =
    status === 'published' && assetUrl.trim().length === 0 && asset.assetUrl === null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{asset.title}</DialogTitle>
          <DialogDescription>
            Lifecycle moves planned → fielding → published. Marking an asset published stamps the
            date; the URL is where a reader would find it.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState
            error={error}
            layout="inline"
            fieldIdPrefix="edit-"
            preserveNotice="Your edits are still here."
          />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="edit-status">Lifecycle</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as DataAssetStatus)}>
                <SelectTrigger id="edit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATA_ASSET_STATUSES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {DATA_ASSET_STATUS_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-alignment">Brand alignment</Label>
              <Select
                value={alignment}
                onValueChange={(value) => setAlignment(value as (typeof BRAND_ALIGNMENTS)[number])}
              >
                <SelectTrigger id="edit-alignment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BRAND_ALIGNMENTS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {BRAND_ALIGNMENT_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-methodology">Methodology note</Label>
            <Textarea
              id="edit-methodology"
              rows={4}
              value={methodology}
              onChange={(event) => setMethodology(event.target.value)}
            />
            {methodology.trim().length === 0 ? (
              <p className="text-meta text-warning-foreground">
                With no method recorded, any number from this asset is unusable as a claim.
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="edit-size">Declared sample size</Label>
              <Input
                id="edit-size"
                type="number"
                min={0}
                value={size}
                onChange={(event) => setSize(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-url">Source URL</Label>
              <Input
                id="edit-url"
                value={assetUrl}
                onChange={(event) => setAssetUrl(event.target.value)}
                placeholder="https://example.com/research/…"
                aria-describedby={publishingWithoutUrl ? 'edit-url-warning' : undefined}
              />
              {publishingWithoutUrl ? (
                <p id="edit-url-warning" className="text-meta text-warning-foreground">
                  Marking this published without a URL leaves no way to check the claim it will be
                  cited for.
                </p>
              ) : null}
            </div>
          </div>

          <dl className="grid gap-1 border-t border-border pt-3 text-meta text-muted-foreground">
            <div className="flex justify-between gap-4">
              <dt>Published date on file</dt>
              <dd>
                {asset.publishedAt ? <Timestamp value={asset.publishedAt} /> : notMeasuredLabel()}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Added</dt>
              <dd>
                <Timestamp value={asset.createdAt} />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt>Recorded by</dt>
              <dd>
                <ProvenanceBadge kind="operator-supplied" />
              </dd>
            </div>
          </dl>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setBusy(true);
              setError(null);
              void onSave({
                title: title.trim(),
                brandAlignment: alignment,
                methodologyNote: methodology,
                status,
                assetUrl,
                ...(size.trim() ? { surveySize: Number(size) } : {}),
              })
                .catch((caught) => {
                  const apiError = toApiError(caught);
                  setError(apiError);
                  onError(apiError);
                })
                .finally(() => setBusy(false));
            }}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? 'Saving…' : 'Save asset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function statusTone(status: DataAssetStatus) {
  switch (status) {
    case 'planned':
      return 'unmeasured' as const;
    case 'fielding':
      return 'info' as const;
    case 'published':
      return 'success' as const;
  }
}
