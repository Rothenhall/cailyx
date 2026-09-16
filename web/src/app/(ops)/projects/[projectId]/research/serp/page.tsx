'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import type { ApiError } from '@/lib/api';
import {
  createSerpTracker,
  deleteSerpTracker,
  getResearchScope,
  listSerpTrackers,
  type ResearchScope,
  type SerpDevice,
  type SerpProvider,
  type SerpTracker,
} from '@/services/research-library';

/**
 * SP01 — Search trackers.
 *
 * design_plan.md §4.3: *"Tracker list/new, keywords, location/language/device/
 * provider, capture budget"*.
 *
 * Two words this screen uses carefully, because the backend does:
 *
 *  - **Capture, not "run a search".** The data comes from a **licensed SERP
 *    data API**. Cailyx never drives a browser against Google and never
 *    generates queries, clicks or impressions as a user — it reads a paid data
 *    feed. The copy says so; a screenshot of a SERP is not what happens here.
 *  - **Provider.** A tracker records which feed produced its snapshots. The
 *    offline `fixture` provider exists for testing and is gated behind a server
 *    flag, so a tracker on it is labelled as not being real search data.
 *
 * The capture budget is **server-side**. The cap is applied by the capture
 * endpoint itself, which stops at it and reports how many queries went unrun —
 * so this screen does not show a client-computed number next to a button that
 * might exceed it.
 */
export default function SearchTrackersPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [trackers, setTrackers] = useState<SerpTracker[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scope, setScope] = useState<ResearchScope | null>(null);
  const [scopeReadFailed, setScopeReadFailed] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SerpTracker | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [result] = await Promise.all([
          listSerpTrackers(projectId, { signal }),
          getResearchScope(projectId, { signal })
            .then(setScope)
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === 'AbortError') return;
              setScopeReadFailed(true);
            }),
        ]);
        setTrackers(result);
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

  async function handleDelete(tracker: SerpTracker) {
    setActionError(null);
    try {
      await deleteSerpTracker(projectId, tracker.id);
      setPendingDelete(null);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Search trackers" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!trackers) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const keywordTotal = trackers.reduce((sum, tracker) => sum + (tracker.queries?.length ?? 0), 0);

  const columns: ReadonlyArray<ColumnDef<SerpTracker>> = [
    {
      key: 'name',
      header: 'Tracker',
      accessor: (row) => row.name,
      sortable: true,
      width: 220,
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'market',
      header: 'Market',
      accessor: (row) => `${row.locationName} / ${row.languageCode}`,
      sortable: true,
      width: 220,
      cellClassName: 'whitespace-normal',
      render: (row) => (
        <span className="text-meta">
          {row.locationName} · {row.languageCode}
        </span>
      ),
    },
    {
      key: 'device',
      header: 'Device',
      accessor: (row) => row.device,
      sortable: true,
      width: 110,
      render: (row) => <span className="capitalize">{row.device}</span>,
    },
    {
      key: 'provider',
      header: 'Data provider',
      accessor: (row) => row.provider,
      sortable: true,
      width: 200,
      cellClassName: 'whitespace-normal',
      render: (row) =>
        row.provider === 'fixture' ? (
          <ProvenanceBadge kind="unmeasured" label="Offline fixture — not real search data" />
        ) : (
          <ProvenanceBadge kind="measured" label={`Licensed SERP feed: ${row.provider}`} />
        ),
    },
    {
      key: 'keywords',
      header: 'Tracked keywords',
      accessor: (row) => row.queries?.length ?? null,
      sortable: true,
      align: 'right',
      width: 170,
      emptyLabel: 'Not counted',
      render: (row) =>
        row.queries ? <span className="tabular-nums">{row.queries.length}</span> : null,
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => (
        <StatusPill label={trackerStatusLabel(row.status)} tone={trackerStatusTone(row.status)} />
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      accessor: (row) => row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.createdAt} />,
    },
    {
      key: 'actions',
      header: '',
      width: 190,
      alwaysVisible: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <a
            href={`/projects/${projectId}/research/serp/${row.id}`}
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open
          </a>
          <Button variant="ghost" size="sm" onClick={() => setPendingDelete(row)}>
            Delete
          </Button>
        </div>
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
          { label: 'Search trackers' },
        ]}
        title="Search trackers"
        context={
          <>
            {trackers.length} tracker{trackers.length === 1 ? '' : 's'} ·{' '}
            {keywordTotal} tracked keyword{keywordTotal === 1 ? '' : 's'} across all markets
          </>
        }
        primaryAction={{ label: 'New tracker', onClick: () => setCreateOpen(true) }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`/projects/${projectId}/research/markets`}>Market breakdown</a>
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

      <Alert>
        <AlertTitle>How results are obtained</AlertTitle>
        <AlertDescription>
          A capture reads a <strong>licensed SERP data feed</strong> for every tracked keyword and
          analyses the response for the client&rsquo;s best organic position, whether an AI Overview
          appeared and named the client, and which named competitors showed up. Cailyx never drives a
          browser against Google and never generates queries, clicks or impressions as a user.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Capture budget</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-2 text-table">
          <p className="text-muted-foreground">
            Every capture is bounded by a <strong>USD cap applied on the server</strong>. When the
            cap is reached the capture stops, marks the snapshot partial, and names how many keywords
            went unrun — so a large tracker cannot quietly spend without limit.
          </p>
          <p className="text-meta text-muted-foreground">
            The cap is a server configuration value, not a figure this screen computes, which is why
            no number is shown next to the capture action. Each snapshot stores the vendor&rsquo;s own
            reported charge, and it is shown per capture on the tracker screen.
          </p>
          <p className="text-meta text-muted-foreground">
            Set up one tracker per market to populate the market breakdown. A market with no tracker
            simply does not appear there — that is not measured, not zero visibility.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Trackers</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="SERP trackers"
            columns={columns}
            rows={trackers}
            getRowId={(row) => row.id}
            defaultSort={{ key: 'createdAt', direction: 'desc' }}
            minTableWidth="80rem"
            searchable
            rowDetail={(row) => (
              <div className="space-y-1 text-table">
                <p className="text-muted-foreground">
                  {row.queries?.length ?? 0} tracked keyword
                  {(row.queries?.length ?? 0) === 1 ? '' : 's'} in this tracker.
                </p>
                {row.queries && row.queries.length > 0 ? (
                  <p className="text-meta text-muted-foreground">
                    {row.queries
                      .slice(0, 12)
                      .map((query) => query.keyword)
                      .join(' · ')}
                    {row.queries.length > 12 ? ` · +${row.queries.length - 12} more` : ''}
                  </p>
                ) : null}
                <p className="text-meta text-muted-foreground">
                  Capture history and per-keyword results are on the tracker screen.
                </p>
              </div>
            )}
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="Search tracking"
                prerequisite="No tracker exists for this project. A tracker is a named set of keywords plus the market, language and device the positions are read in."
                action={{ label: 'New tracker', onClick: () => setCreateOpen(true) }}
              />
            }
          />
        </CardContent>
      </Card>

      <CreateTrackerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={() => {
          setCreateOpen(false);
          void load();
        }}
        onError={setActionError}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete tracker"
        confirmLabel="Delete tracker"
        destructive
        targetLabel="Tracker"
        target={pendingDelete ? `${pendingDelete.name} (${pendingDelete.locationName})` : ''}
        effect={
          <>
            The tracker, its tracked keywords and <strong>every captured snapshot</strong> under it
            are deleted. Rank history cannot be recovered from this screen.
          </>
        }
        scope={
          <>
            Only this tracker is affected. Other trackers for this project, and the market breakdown
            built from them, are unchanged.
          </>
        }
        onConfirm={async () => {
          if (pendingDelete) await handleDelete(pendingDelete);
        }}
        onReload={() => void load()}
      />
    </div>
  );
}

function CreateTrackerDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: () => void;
  onError: (error: ApiError) => void;
}) {
  const [name, setName] = useState('');
  const [keywordText, setKeywordText] = useState('');
  const [locationName, setLocationName] = useState('United States');
  const [languageCode, setLanguageCode] = useState('en');
  const [device, setDevice] = useState<SerpDevice>('desktop');
  const [provider, setProvider] = useState<SerpProvider>('dataforseo');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const keywords = keywordText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      await createSerpTracker(projectId, {
        name: name.trim(),
        keywords,
        locationName: locationName.trim() || undefined,
        languageCode: languageCode.trim() || undefined,
        device,
        provider,
      });
      setName('');
      setKeywordText('');
      onCreated();
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
          <DialogTitle>New search tracker</DialogTitle>
          <DialogDescription>
            A named set of keywords plus the market, language and device their positions are read in.
            Creating the tracker does not capture anything — results come from an explicit capture on
            the tracker screen.
          </DialogDescription>
        </DialogHeader>

        {formError ? (
          <ErrorState
            error={formError}
            layout="inline"
            providerName="the SERP data provider"
            preserveNotice="Nothing was created."
          />
        ) : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sp-name">Tracker name (required)</Label>
            <Input
              id="sp-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="e.g. UK — core service terms"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sp-keywords">Keywords (required, one per line)</Label>
            <Textarea
              id="sp-keywords"
              value={keywordText}
              onChange={(event) => setKeywordText(event.target.value)}
              rows={5}
              placeholder={'ai visibility audit\nanswer engine optimization'}
            />
            <p className="text-meta text-muted-foreground">
              {keywords.length === 0
                ? 'At least one keyword is required.'
                : `${keywords.length} keyword${keywords.length === 1 ? '' : 's'}. The server accepts up to 300 per tracker and de-duplicates them.`}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sp-location">Market</Label>
              <Input
                id="sp-location"
                value={locationName}
                onChange={(event) => setLocationName(event.target.value)}
                maxLength={120}
                placeholder="e.g. United Kingdom"
              />
              <p className="text-meta text-muted-foreground">
                One tracker per market is what makes the market breakdown meaningful.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-language">Language code</Label>
              <Input
                id="sp-language"
                value={languageCode}
                onChange={(event) => setLanguageCode(event.target.value)}
                maxLength={8}
                placeholder="en"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sp-device">Device</Label>
              <Select value={device} onValueChange={(value) => setDevice(value as SerpDevice)}>
                <SelectTrigger id="sp-device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desktop">Desktop</SelectItem>
                  <SelectItem value="mobile">Mobile</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                Positions differ between devices; the snapshot records which was used.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sp-provider">Data provider</Label>
              <Select value={provider} onValueChange={(value) => setProvider(value as SerpProvider)}>
                <SelectTrigger id="sp-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dataforseo">Licensed SERP feed</SelectItem>
                  <SelectItem value="fixture">Offline fixture (testing only)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                The offline fixture is not real search data and is only available when the server
                explicitly enables it.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={saving || name.trim() === '' || keywords.length === 0}
          >
            {saving ? 'Creating…' : 'Create tracker'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function trackerStatusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'archived':
      return 'neutral';
    default:
      return 'unmeasured';
  }
}

function trackerStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'archived':
      return 'Archived';
    default:
      return `Unrecognized: ${status}`;
  }
}
