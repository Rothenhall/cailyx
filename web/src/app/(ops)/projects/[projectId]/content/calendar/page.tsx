'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import {
  ASSET_TYPE_LABELS,
  CONTENT_ASSET_TYPES,
  listContentApprovals,
  listGrowthAssets,
  listPublishDestinations,
  type ApprovalRequest,
  type GrowthAsset,
  type PublishDestination,
} from '@/services/content';

/**
 * CT06 — Content calendar.
 *
 * design_plan.md §4.4 lists this screen's target contents as *"audience/channel/
 * campaign schedule, owners, approval readiness, publication destination"* and
 * its support column says plainly: **N G06/G09/G11**. There is no schedule
 * store in this build, so the honest screen is two things side by side:
 *
 *  1. **What is genuinely known** — each content asset's approval state, bound
 *     to the revision the client was asked about, and the project's publish
 *     destinations with their real connection state.
 *  2. **What is not** — audience, channel, campaign, owner and scheduled date
 *     for each item. Those are named as unavailable with the prerequisites that
 *     would supply them, rather than rendered as an empty calendar that reads
 *     like "nothing is planned".
 *
 * A calendar with invented slots would be the single most misleading screen in
 * this set, so it is deliberately not drawn.
 */

const FILTER_DEFAULTS = {
  q: '',
  assetType: 'all',
  approval: 'all',
};

const ASSET_TYPE_OPTIONS = CONTENT_ASSET_TYPES.map((type) => ({
  value: type,
  label: ASSET_TYPE_LABELS[type],
}));

const APPROVAL_OPTIONS = [
  { value: 'approved', label: 'Approved for publication' },
  { value: 'pending', label: 'Awaiting a decision' },
  { value: 'changes-requested', label: 'Changes requested' },
  { value: 'none', label: 'No request raised' },
];

interface ReadinessRow {
  asset: GrowthAsset;
  clientApproval: ApprovalRequest | null;
}

export default function ContentCalendarPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [assets, setAssets] = useState<GrowthAsset[] | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[] | null>(null);
  const [destinations, setDestinations] = useState<PublishDestination[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [destinationsError, setDestinationsError] = useState<ReturnType<typeof toApiError> | null>(
    null,
  );
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [assetResult, approvalResult] = await Promise.all([
          listGrowthAssets(projectId, {}, { signal }),
          listContentApprovals(projectId, {}, { signal }),
        ]);
        setAssets(assetResult.assets);
        setApprovals(approvalResult.requests);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  const loadDestinations = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setDestinationsError(null);
        const result = await listPublishDestinations(projectId, { signal });
        setDestinations(result.destinations);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setDestinationsError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void loadDestinations(controller.signal);
    return () => controller.abort();
  }, [load, loadDestinations]);

  /**
   * Each asset's client-facing approval, if one exists.
   *
   * The server marks an approval invalidated when the artifact moves past the
   * revision it was raised against, so its `status` is the authoritative
   * readiness signal — this screen does not re-derive that from a revision
   * number it would have to fetch per row.
   */
  const rows: ReadinessRow[] = useMemo(() => {
    if (!assets) return [];
    const byArtifact = new Map<string, ApprovalRequest>();
    for (const request of approvals ?? []) {
      if (request.reviewerType !== 'client') continue;
      const existing = byArtifact.get(request.artifactId);
      if (!existing || existing.createdAt < request.createdAt) {
        byArtifact.set(request.artifactId, request);
      }
    }
    return assets.map((asset) => ({
      asset,
      clientApproval: byArtifact.get(asset.id) ?? null,
    }));
  }, [assets, approvals]);

  const filtered = useMemo(() => {
    const query = filters.q.trim().toLowerCase();
    return rows.filter((row) => {
      if (filters.assetType !== 'all' && row.asset.assetType !== filters.assetType) return false;
      if (filters.approval === 'none' && row.clientApproval !== null) return false;
      if (
        filters.approval !== 'all' &&
        filters.approval !== 'none' &&
        row.clientApproval?.status !== filters.approval
      ) {
        return false;
      }
      if (!query) return true;
      return row.asset.title.toLowerCase().includes(query);
    });
  }, [rows, filters]);

  const filtersActive =
    filters.q !== FILTER_DEFAULTS.q ||
    filters.assetType !== FILTER_DEFAULTS.assetType ||
    filters.approval !== FILTER_DEFAULTS.approval;

  const columns: ReadonlyArray<ColumnDef<ReadinessRow>> = [
    {
      key: 'title',
      header: 'Asset',
      accessor: (row) => row.asset.title,
      sortable: true,
      width: 280,
      render: (row) => (
        <div className="min-w-0">
          <Link
            href={`/projects/${projectId}/content/${row.asset.id}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {row.asset.title}
          </Link>
          <p className="text-meta text-muted-foreground">
            {ASSET_TYPE_LABELS[row.asset.assetType]}
          </p>
        </div>
      ),
    },
    {
      key: 'lifecycle',
      header: 'Lifecycle',
      accessor: (row) => row.asset.status,
      sortable: true,
      width: 130,
      render: (row) => (
        <StatusPill
          label={
            row.asset.status === 'published'
              ? 'Published'
              : row.asset.status === 'in-progress'
                ? 'In progress'
                : 'Recommended'
          }
          tone={
            row.asset.status === 'published'
              ? 'success'
              : row.asset.status === 'in-progress'
                ? 'info'
                : 'neutral'
          }
        />
      ),
    },
    {
      key: 'approval',
      header: 'Client approval',
      accessor: (row) => row.clientApproval?.status ?? 'none',
      sortable: true,
      width: 220,
      render: (row) =>
        row.clientApproval ? (
          <div className="space-y-1">
            <StatusPill
              label={approvalLabel(row.clientApproval.status)}
              tone={approvalTone(row.clientApproval.status)}
            />
            <p className="text-meta text-muted-foreground">
              {row.clientApproval.artifactRevision !== null
                ? `Revision ${row.clientApproval.artifactRevision} under review`
                : 'No revision recorded'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <StatusPill label="No request raised" tone="unmeasured" />
            <p className="text-meta text-muted-foreground">
              Nobody has asked the client to decide on this asset.
            </p>
          </div>
        ),
    },
    {
      key: 'destination',
      header: 'Publication destination',
      accessor: () => null,
      width: 200,
      // No per-item destination binding exists in this build. Saying so is the
      // only honest cell here; a blank would read as "not set, set it".
      emptyLabel: 'Not assignable yet',
      render: () => (
        <span className="text-meta text-muted-foreground">
          No per-item destination binding exists in this build. Destinations are project-level —
          see below.
        </span>
      ),
    },
    {
      key: 'schedule',
      header: 'Schedule',
      accessor: () => null,
      width: 200,
      emptyLabel: 'No schedule store',
      render: () => (
        <span className="text-meta text-muted-foreground">
          Audience, channel, campaign, owner and publish date are not recorded anywhere in this
          build.
        </span>
      ),
    },
    {
      key: 'publishedUrl',
      header: 'Live URL',
      accessor: (row) => row.asset.assetUrl,
      width: 180,
      // A `render` replaces the default cell, so every branch — including "no
      // URL recorded" — is rendered explicitly rather than left blank.
      render: (row) =>
        row.asset.assetUrl && /^https?:\/\//i.test(row.asset.assetUrl) ? (
          <a
            href={row.asset.assetUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-table text-primary underline-offset-4 hover:underline"
          >
            Open page
          </a>
        ) : row.asset.assetUrl ? (
          // §10.5: an unsupported scheme is shown as text, never as a link.
          <span className="text-meta text-muted-foreground">
            Recorded as “{row.asset.assetUrl}” — not an http(s) address, so it is not linked.
          </span>
        ) : (
          <span className="text-unmeasured-foreground">No URL recorded</span>
        ),
    },
    {
      key: 'publishedAt',
      header: 'Recorded published',
      accessor: (row) => row.asset.publishedAt,
      sortable: true,
      width: 180,
      render: (row) =>
        row.asset.publishedAt ? (
          <Timestamp value={row.asset.publishedAt} />
        ) : (
          <span className="text-unmeasured-foreground">Not published</span>
        ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content calendar" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!assets || !approvals) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content calendar"
        context="Publication readiness and destinations. A scheduled editorial calendar is not available in this build."
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
                void loadDestinations();
              }}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {/*
        §3.5's rule for an unsupported target: say what is missing and what
        would supply it. An empty month grid would be read as "nothing planned",
        which is a different and false claim.
      */}
      <Card className="border-unmeasured/40">
        <CardHeader>
          <CardTitle className="text-subsection">The editorial schedule is not available yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-table text-foreground">
            Nothing on this screen is a planned date. Cailyx does not yet store an audience,
            channel, campaign, owner or publish date for a content asset, so a calendar drawn from
            it would be invented rather than read.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-table text-muted-foreground">
            <li>
              <strong className="text-foreground">Audience, channel and campaign</strong> — an
              editorial plan that assigns each asset to one. Not built.
            </li>
            <li>
              <strong className="text-foreground">Owner and due date</strong> — work-item scheduling,
              which lives outside content. Not built.
            </li>
            <li>
              <strong className="text-foreground">Publication destination per item</strong> —
              destinations exist at project level (below), but nothing binds an asset to one, and
              nothing schedules a push.
            </li>
          </ul>
          <p className="text-table text-muted-foreground">
            Until then, the workable process is: approve the revision here, publish it by hand in the
            CMS or ad tool, then record the live URL on the asset.
          </p>
        </CardContent>
      </Card>

      <FilterBar
        defaults={FILTER_DEFAULTS}
        value={filters}
        onChange={setFilters}
        controls={[
          { kind: 'select', key: 'assetType', label: 'Asset type', options: ASSET_TYPE_OPTIONS },
          { kind: 'select', key: 'approval', label: 'Client approval', options: APPROVAL_OPTIONS },
        ]}
        summary={`Showing ${filtered.length} of ${rows.length}`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Publication readiness</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Content publication readiness"
            columns={columns}
            rows={filtered}
            getRowId={(row) => row.asset.id}
            defaultSort={{ key: 'publishedAt', direction: 'desc' }}
            minTableWidth="72rem"
            emptyState={
              filtersActive ? (
                <EmptyState variant="no-results" onClearFilters={() => setFilters(FILTER_DEFAULTS)} />
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="content ready for publication"
                  prerequisite="content assets, from the opportunities screen or a generated batch"
                  action={{
                    label: 'Open content opportunities',
                    href: `/projects/${projectId}/content/opportunities`,
                  }}
                />
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Publish destinations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <p className="text-meta text-muted-foreground">
            Progress copies and published URLs are kept apart on purpose: a stored draft, an
            external edit and a live page are three different facts.
          </p>

          {destinationsError ? (
            <ErrorState
              error={destinationsError}
              layout="inline"
              onRetry={() => void loadDestinations()}
              preserveNotice="The readiness table above is unaffected."
            />
          ) : null}

          {!destinations && !destinationsError ? <Skeleton className="h-24 rounded-xl" /> : null}

          {destinations && destinations.length === 0 ? (
            <EmptyState
              variant="source-unmapped"
              sourceName="a publishing destination"
              action={{
                label: 'Check service connections',
                href: `/projects/${projectId}/connections`,
              }}
            >
              No CMS, social, email or ad destination has been declared for this project, so no
              publication can be recorded against one yet.
            </EmptyState>
          ) : null}

          {destinations && destinations.length > 0 ? (
            <ul className="divide-y divide-border">
              {destinations.map((destination) => (
                <li key={destination.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-table font-medium text-foreground">
                      {destination.label}
                    </span>
                    <span className="text-meta text-muted-foreground">
                      {destination.providerLabel} · {destination.providerKind}
                    </span>
                    <StatusPill
                      label={destinationStatusLabel(destination.status)}
                      tone={destinationStatusTone(destination.status)}
                    />
                    {!destination.providerImplemented ? (
                      <ProvenanceBadge kind="unmeasured" label="No adapter in this build" />
                    ) : null}
                  </div>
                  <p className="text-meta text-muted-foreground">
                    {destination.resourceLabel ?? destination.resourceId ?? 'No resource chosen'}
                    {' · '}
                    {destination.credentialConfigured
                      ? 'Credential resolves'
                      : 'No resolving credential on file'}
                    {destination.lastTestedAt ? (
                      <>
                        {' · last tested '}
                        <Timestamp value={destination.lastTestedAt} />
                      </>
                    ) : (
                      ' · never tested'
                    )}
                  </p>
                  {destination.lastError ? (
                    <p className="text-meta text-danger-foreground">{destination.lastError}</p>
                  ) : null}
                  {destination.revokedAt ? (
                    <p className="text-meta text-muted-foreground">
                      Revoked <Timestamp value={destination.revokedAt} />
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <Alert>
            <AlertTitle>Ad copy is not an activated campaign</AlertTitle>
            <AlertDescription>
              Generating ad text never starts a campaign. An ad needs its own destination, format
              constraints, an explicit campaign and budget choice, and a separate activation
              approval — none of which a content asset carries.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

function approvalLabel(status: ApprovalRequest['status']): string {
  switch (status) {
    case 'pending':
      return 'Decision pending';
    case 'approved':
      return 'Approved';
    case 'changes-requested':
      return 'Changes requested';
    case 'cancelled':
      return 'Cancelled';
    case 'invalidated':
      return 'Invalidated';
  }
}

function approvalTone(status: ApprovalRequest['status']) {
  switch (status) {
    case 'pending':
      return 'warning' as const;
    case 'approved':
      return 'success' as const;
    case 'changes-requested':
      return 'info' as const;
    case 'cancelled':
      return 'neutral' as const;
    case 'invalidated':
      return 'warning' as const;
  }
}

function destinationStatusLabel(status: string): string {
  switch (status) {
    case 'unconfigured':
      return 'Declared, not connected';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Error';
    case 'revoked':
      return 'Revoked';
    default:
      return status;
  }
}

function destinationStatusTone(status: string) {
  switch (status) {
    case 'connected':
      return 'success' as const;
    case 'error':
      return 'danger' as const;
    case 'revoked':
      return 'unmeasured' as const;
    case 'unconfigured':
      return 'warning' as const;
    default:
      return 'neutral' as const;
  }
}
