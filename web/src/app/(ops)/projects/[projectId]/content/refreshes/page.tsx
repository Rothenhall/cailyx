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
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, formatPercent, notMeasuredLabel } from '@/lib/format';
import {
  DEFAULT_DECLINE_PCT,
  DEFAULT_MIN_REFERRING_DOMAINS,
  SLEEPER_STATUSES,
  SLEEPER_STATUS_LABELS,
  createSleeperPage,
  deleteSleeperPage,
  getRefreshSummary,
  importSleeperPages,
  listSleeperPages,
  markRefreshed,
  updateSleeperPage,
  type RefreshSummary,
  type SleeperPage,
  type SleeperStatus,
} from '@/services/refreshes';

/**
 * CT08 — Content refreshes.
 *
 * design_plan.md §4.4: *"Import GSC CSV/TSV or manual page, decline/backlink
 * thresholds, status, before/after dateModified."* §5.9 supplies the two rules
 * this screen exists to keep straight:
 *
 *  1. *"classify against default ≥20% decline and ≥3 referring domains;
 *     **missing data is unproven**"* — a page with no decline figure and no
 *     referring-domain count is not a page that failed, so `unproven` gets its
 *     own pill and its own tone rather than being folded into "not a sleeper".
 *     The thresholds travel with the request, so the screen always shows which
 *     pair produced the label it is displaying.
 *  2. *"Current date movement is a submitted/audited ledger signal, not proof
 *     traffic improved"* — the before/after `dateModified` pair is shown as
 *     evidence the page moved, and the copy never upgrades it into a result.
 *
 * The import route is throttled to five calls a minute, so it is an explicit
 * dialog action with its own result (`upserted` / `skipped`), never a retry
 * loop.
 */

const FILTER_DEFAULTS = {
  q: '',
  minDeclinePct: DEFAULT_DECLINE_PCT,
  minReferringDomains: DEFAULT_MIN_REFERRING_DOMAINS,
  status: 'all',
};

const STATUS_OPTIONS = SLEEPER_STATUSES.map((status) => ({
  value: status,
  label: SLEEPER_STATUS_LABELS[status],
}));

export default function ContentRefreshesPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [pages, setPages] = useState<SleeperPage[] | null>(null);
  const [summary, setSummary] = useState<RefreshSummary | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [importOpen, setImportOpen] = useState(false);
  const [manageTarget, setManageTarget] = useState<SleeperPage | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [pageRows, summaryRow] = await Promise.all([
          listSleeperPages(
            projectId,
            {
              minDeclinePct: filters.minDeclinePct,
              minReferringDomains: filters.minReferringDomains,
              status: filters.status === 'all' ? undefined : (filters.status as SleeperStatus),
            },
            { signal },
          ),
          getRefreshSummary(projectId, { signal }),
        ]);
        setPages(pageRows);
        setSummary(summaryRow);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, filters.minDeclinePct, filters.minReferringDomains, filters.status],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filtered = useMemo(() => {
    if (!pages) return [];
    const query = filters.q.trim().toLowerCase();
    if (!query) return pages;
    return pages.filter((page) =>
      [page.url, page.label ?? '', page.notes ?? ''].join(' ').toLowerCase().includes(query),
    );
  }, [pages, filters.q]);

  const unproven = useMemo(
    () => (pages ?? []).filter((page) => page.sleeperStatus === 'unproven').length,
    [pages],
  );

  const columns: ReadonlyArray<ColumnDef<SleeperPage>> = [
    {
      key: 'url',
      header: 'Page',
      accessor: (row) => row.url,
      sortable: true,
      width: 300,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-table font-medium text-foreground" title={row.url}>
            {row.label ?? row.url}
          </p>
          <p className="truncate text-meta text-muted-foreground" title={row.url}>
            {row.url}
          </p>
        </div>
      ),
    },
    {
      key: 'trafficDeclinePct',
      header: 'Traffic decline',
      accessor: (row) => row.trafficDeclinePct,
      sortable: true,
      align: 'right',
      width: 150,
      // Missing data is unproven, never a 0% decline (§5.9). A `render`
      // replaces the default cell, so the label is rendered explicitly.
      render: (row) =>
        row.trafficDeclinePct === null ? (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        ) : (
          <span className="tabular-nums">{formatPercent(row.trafficDeclinePct)}</span>
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
        row.referringDomains === null ? (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        ) : (
          <span className="tabular-nums">{formatNumber(row.referringDomains)}</span>
        ),
    },
    {
      key: 'classification',
      header: 'Classification',
      accessor: (row) => row.sleeperStatus,
      sortable: true,
      width: 160,
      render: (row) => (
        <StatusPill label={classificationLabel(row.sleeperStatus)} tone={classificationTone(row.sleeperStatus)} />
      ),
    },
    {
      key: 'status',
      header: 'Refresh status',
      accessor: (row) => row.status,
      sortable: true,
      width: 140,
      render: (row) => (
        <StatusPill label={SLEEPER_STATUS_LABELS[row.status]} tone={statusTone(row.status)} />
      ),
    },
    {
      key: 'dateModified',
      header: 'dateModified before → after',
      accessor: (row) => row.dateModifiedBefore,
      width: 260,
      // §5.9: the pair is evidence the refresh shipped, not proof traffic moved.
      render: (row) => (
        <span className="text-meta text-muted-foreground">
          {row.dateModifiedBefore ?? 'Not captured'}
          {' → '}
          {row.dateModifiedAfter ?? 'not yet recorded'}
        </span>
      ),
    },
    {
      key: 'refreshedAt',
      header: 'Shipped',
      accessor: (row) => row.refreshedAt,
      sortable: true,
      width: 180,
      render: (row) =>
        row.refreshedAt ? (
          <Timestamp value={row.refreshedAt} />
        ) : (
          <span className="text-unmeasured-foreground">Not shipped</span>
        ),
    },
    {
      key: 'manage',
      header: '',
      width: 110,
      alwaysVisible: true,
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setManageTarget(row)}>
          Manage
        </Button>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content refreshes" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!pages || !summary) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content refreshes"
        context="Sleeper pages: still-linked content that has lost a meaningful share of its traffic, and the refresh work that follows."
        primaryAction={{ label: 'Import or add pages', onClick: () => setImportOpen(true) }}
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
          preserveNotice="Nothing on this page was changed by the failed request."
        />
      ) : null}

      {/* ── Summary ────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Pages tracked"
          value={summary.total}
          unit="pages"
          provenance="measured"
          note="Candidates imported or added by hand for this project."
        />
        <MetricTile
          label="Refreshes shipped"
          value={summary.refreshed}
          unit="pages"
          provenance="measured"
          note="Pages whose refresh has been recorded as shipped."
        />
        <MetricTile
          label="Visible dateModified moved"
          value={summary.dateModifiedMoved}
          unit="pages"
          provenance="measured"
          note="Evidence the shipped change reached the page. It is not evidence that traffic recovered."
        />
        <MetricTile
          label="Unproven"
          // No candidate at all is unmeasured, not zero — the tile says so itself.
          value={summary.total === 0 ? null : unproven}
          unit="pages"
          provenance={summary.total === 0 ? 'unmeasured' : 'measured'}
          note={
            summary.total === 0
              ? 'No page has been imported yet, so nothing has been classified.'
              : `Missing a decline figure or a referring-domain count against the current thresholds (${formatPercent(
                  filters.minDeclinePct,
                )} / ${formatNumber(filters.minReferringDomains)}).`
          }
        />
      </div>

      <Alert>
        <AlertTitle>What a refresh proves, and what it does not</AlertTitle>
        <AlertDescription>
          Recording a new <code>dateModified</code> is an audited ledger signal that the page moved.
          It is not proof that traffic improved — that needs an independent before/after measurement
          over a comparable window, which this screen does not compute.
        </AlertDescription>
      </Alert>

      {/* ── Thresholds and filters ─────────────────────────────────── */}
      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        searchPlaceholder="Search page, label or note"
        controls={[
          {
            kind: 'text',
            key: 'minDeclinePct',
            label: 'Min decline %',
            placeholder: String(DEFAULT_DECLINE_PCT),
          },
          {
            kind: 'text',
            key: 'minReferringDomains',
            label: 'Min referring domains',
            placeholder: String(DEFAULT_MIN_REFERRING_DOMAINS),
          },
          { kind: 'select', key: 'status', label: 'Refresh status', options: STATUS_OPTIONS },
        ]}
        summary={`Showing ${filtered.length} of ${pages.length} · classifying at ≥${formatPercent(
          filters.minDeclinePct,
        )} decline and ≥${formatNumber(filters.minReferringDomains)} referring domains`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Sleeper candidates</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Content refresh candidates"
            columns={columns}
            rows={filtered}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'trafficDeclinePct', direction: 'desc' }}
            minTableWidth="76rem"
            emptyState={
              pages.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="content refresh candidates"
                  prerequisite="a page import (a Search Console CSV/TSV export) or a page added by hand"
                  action={{ label: 'Import or add pages', onClick: () => setImportOpen(true) }}
                >
                  Nothing has been imported or entered for this project, so no page has been
                  classified as a sleeper.
                </EmptyState>
              ) : (
                <EmptyState
                  variant="no-results"
                  onClearFilters={() =>
                    setFilters({
                      q: '',
                      status: 'all',
                    })
                  }
                />
              )
            }
          />
        </CardContent>
      </Card>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={projectId}
        onDone={async () => {
          await load();
        }}
        onError={setActionError}
      />

      {manageTarget ? (
        <ManagePageDialog
          page={manageTarget}
          onOpenChange={(open) => {
            if (!open) setManageTarget(null);
          }}
          onSave={async (patch) => {
            setActionError(null);
            try {
              await updateSleeperPage(projectId, manageTarget.id, patch);
              setManageTarget(null);
              await load();
            } catch (caught) {
              setActionError(toApiError(caught));
            }
          }}
          onMarkRefreshed={async (input) => {
            setActionError(null);
            try {
              await markRefreshed(projectId, manageTarget.id, input);
              setManageTarget(null);
              await load();
            } catch (caught) {
              setActionError(toApiError(caught));
            }
          }}
          onDelete={async () => {
            setActionError(null);
            try {
              await deleteSleeperPage(projectId, manageTarget.id);
              setManageTarget(null);
              await load();
            } catch (caught) {
              setActionError(toApiError(caught));
            }
          }}
        />
      ) : null}
    </div>
  );
}

// ── Import / add ────────────────────────────────────────────────────────

function ImportDialog({
  open,
  onOpenChange,
  projectId,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onDone: () => Promise<void>;
  onError: (error: ReturnType<typeof toApiError>) => void;
}) {
  const [csv, setCsv] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [decline, setDecline] = useState('');
  const [referring, setReferring] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ upserted: number; skipped: number } | null>(null);
  const [dialogError, setDialogError] = useState<ReturnType<typeof toApiError> | null>(null);
  const submitting = useRef(false);

  async function onImport() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setDialogError(null);
    setResult(null);
    try {
      const importResult = await importSleeperPages(projectId, { text: csv });
      setResult(importResult);
      setCsv('');
      await onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setDialogError(apiError);
      onError(apiError);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function onAddManual() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setDialogError(null);
    try {
      await createSleeperPage(projectId, {
        url: url.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(decline.trim() ? { trafficDeclinePct: Number(decline) } : {}),
        ...(referring.trim() ? { referringDomains: Number(referring) } : {}),
      });
      setUrl('');
      setLabel('');
      setDecline('');
      setReferring('');
      await onDone();
    } catch (caught) {
      const apiError = toApiError(caught);
      setDialogError(apiError);
      onError(apiError);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import or add pages</DialogTitle>
          <DialogDescription>
            Rows are matched by URL inside this project, so re-importing the same export updates the
            figures rather than duplicating the page.
          </DialogDescription>
        </DialogHeader>

        {dialogError ? (
          <ErrorState
            error={dialogError}
            layout="inline"
            preserveNotice="The rows you pasted are still here."
          />
        ) : null}

        {result ? (
          <Alert>
            <AlertTitle>
              {result.upserted} row{result.upserted === 1 ? '' : 's'} imported
            </AlertTitle>
            <AlertDescription>
              {result.skipped > 0
                ? `${result.skipped} line${
                    result.skipped === 1 ? ' was' : 's were'
                  } skipped — a header row, or a line with no http(s) URL in it. They were counted rather than dropped silently.`
                : 'Nothing was skipped.'}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="import-csv">Search Console export (CSV or TSV)</Label>
            <Textarea
              id="import-csv"
              rows={6}
              value={csv}
              onChange={(event) => setCsv(event.target.value)}
              placeholder={'Page,Clicks,Decline %\nhttps://example.com/guide,120,38'}
              className="font-mono text-table"
            />
            <p className="text-meta text-muted-foreground">
              One row per line: the URL, then a decline percentage and optionally a
              referring-domain count. A header row is skipped automatically. Up to 500 rows per
              import.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onImport()}
              disabled={busy || csv.trim().length === 0}
              aria-busy={busy}
            >
              {busy ? 'Importing…' : 'Import rows'}
            </Button>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-subsection font-semibold text-foreground">Or add one page</h3>
            <p className="text-meta text-muted-foreground">
              Leave a figure empty when you do not have it. An empty decline is recorded as unproven
              rather than as no decline at all.
            </p>
            <div className="space-y-2">
              <Label htmlFor="manual-url">Page URL</Label>
              <Input
                id="manual-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/guide"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-label">Label (optional)</Label>
              <Input
                id="manual-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="manual-decline">Traffic decline %</Label>
                <Input
                  id="manual-decline"
                  type="number"
                  min={0}
                  max={100}
                  inputMode="decimal"
                  value={decline}
                  onChange={(event) => setDecline(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-referring">Referring domains</Label>
                <Input
                  id="manual-referring"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={referring}
                  onChange={(event) => setReferring(event.target.value)}
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onAddManual()}
              disabled={busy || url.trim().length < 9}
              aria-busy={busy}
            >
              Add page
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Manage one page ─────────────────────────────────────────────────────

function ManagePageDialog({
  page,
  onOpenChange,
  onSave,
  onMarkRefreshed,
  onDelete,
}: {
  page: SleeperPage;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: {
    status?: SleeperStatus;
    label?: string;
    trafficDeclinePct?: number;
    referringDomains?: number;
    notes?: string;
    dateModifiedBefore?: string;
  }) => Promise<void>;
  onMarkRefreshed: (input: { dateModifiedAfter: string; notes?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [status, setStatus] = useState<SleeperStatus>(page.status);
  const [label, setLabel] = useState(page.label ?? '');
  const [decline, setDecline] = useState(
    page.trafficDeclinePct === null ? '' : String(page.trafficDeclinePct),
  );
  const [referring, setReferring] = useState(
    page.referringDomains === null ? '' : String(page.referringDomains),
  );
  const [before, setBefore] = useState(page.dateModifiedBefore ?? '');
  const [notes, setNotes] = useState(page.notes ?? '');
  const [after, setAfter] = useState(page.dateModifiedAfter ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{page.label ?? page.url}</DialogTitle>
          <DialogDescription>
            Classification shown in the table is recomputed from the thresholds in the filter bar;
            it is not stored on the page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <dl className="grid gap-1 text-table sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
              <dt className="text-muted-foreground">Current classification</dt>
              <dd className="text-foreground">
                <StatusPill
                  label={classificationLabel(page.sleeperStatus)}
                  tone={classificationTone(page.sleeperStatus)}
                />
              </dd>
            </div>
            <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
              <dt className="text-muted-foreground">Added</dt>
              <dd className="text-foreground">
                <Timestamp value={page.createdAt} />
              </dd>
            </div>
          </dl>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="manage-status">Refresh status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as SleeperStatus)}>
                <SelectTrigger id="manage-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLEEPER_STATUSES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {SLEEPER_STATUS_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="manage-label">Label</Label>
              <Input id="manage-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manage-decline">Traffic decline %</Label>
              <Input
                id="manage-decline"
                type="number"
                min={0}
                max={100}
                value={decline}
                onChange={(event) => setDecline(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manage-referring">Referring domains</Label>
              <Input
                id="manage-referring"
                type="number"
                min={0}
                value={referring}
                onChange={(event) => setReferring(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manage-before">dateModified before the refresh</Label>
              <Input
                id="manage-before"
                value={before}
                onChange={(event) => setBefore(event.target.value)}
                placeholder="as the shipped page shows it"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manage-notes">Notes</Label>
              <Textarea
                id="manage-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
            <h3 className="text-table font-medium text-foreground">Record the refresh as shipped</h3>
            <p className="text-meta text-muted-foreground">
              Stores the new visible <code>dateModified</code> so &ldquo;the refresh actually moved
              the page&rdquo; stays auditable. It does not claim the page recovered.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-40 flex-1 space-y-2">
                <Label htmlFor="manage-after">dateModified after the refresh</Label>
                <Input
                  id="manage-after"
                  value={after}
                  onChange={(event) => setAfter(event.target.value)}
                  placeholder="e.g. 2026-09-14"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || after.trim().length < 4}
                onClick={() => {
                  setBusy(true);
                  void onMarkRefreshed({
                    dateModifiedAfter: after.trim(),
                    ...(notes.trim() ? { notes: notes.trim() } : {}),
                  }).finally(() => setBusy(false));
                }}
              >
                Record shipment
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete this page
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setBusy(true);
                void onSave({
                  status,
                  label,
                  notes,
                  dateModifiedBefore: before,
                  ...(decline.trim() ? { trafficDeclinePct: Number(decline) } : {}),
                  ...(referring.trim() ? { referringDomains: Number(referring) } : {}),
                }).finally(() => setBusy(false));
              }}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this refresh candidate?"
        confirmLabel="Delete page"
        targetLabel="Page"
        target={page.url}
        effect="The row, its figures and its dateModified evidence are permanently removed. This cannot be undone."
        destructive
        onConfirm={onDelete}
        onConfirmed={() => setConfirmDelete(false)}
      />
    </Dialog>
  );
}

// ── Maps ────────────────────────────────────────────────────────────────

function classificationLabel(status: SleeperPage['sleeperStatus']): string {
  switch (status) {
    case 'sleeper':
      return 'Sleeper';
    case 'not-sleeper':
      return 'Not a sleeper';
    case 'unproven':
      // Missing data is its own answer, not a failed classification.
      return 'Unproven';
  }
}

function classificationTone(status: SleeperPage['sleeperStatus']) {
  switch (status) {
    case 'sleeper':
      return 'warning' as const;
    case 'not-sleeper':
      return 'neutral' as const;
    case 'unproven':
      return 'unmeasured' as const;
  }
}

function statusTone(status: SleeperStatus) {
  switch (status) {
    case 'refreshed':
      return 'success' as const;
    case 'in-progress':
      return 'info' as const;
    case 'brief-sent':
      return 'warning' as const;
    case 'abandoned':
      return 'neutral' as const;
    case 'flagged':
      return 'unmeasured' as const;
  }
}
