'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { FilterBar } from '@/components/patterns/FilterBar';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  MENTION_DECAY_DAYS,
  MENTION_TARGET_STATUS_LABEL,
  checkMentionTarget,
  getMentionDecay,
  mentionState,
  type MentionDecayRow,
  type MentionState,
  type MentionTargetStatus,
} from '@/services/authority';

/**
 * AT04 — Mention health.
 *
 * design_plan.md §4.4: *"Target check freshness, ever-mentioned, days since
 * last sighting, decay alert, recheck"*. §5.9 calls the same thing "mention
 * maintenance … inspect check history and decay".
 *
 * **This screen exists to keep three different facts apart**, and every column
 * on it is built around that:
 *
 * | The target… | `everMentioned` | `lastCheckedAt` | What may be said |
 * |---|---|---|---|
 * | has never been checked | false | null | nothing about its mention state |
 * | was checked, brand absent | false | a date | it was absent *at that check* |
 * | mentioned | true | a date | last seen at `lastMentionedAt` |
 *
 * The backend cannot express the difference on its own — its `stale` flag is
 * false in **all three** of the first, second and "mentioned recently" cases —
 * so this page reads `lastCheckedAt` and labels the unknown state as unknown.
 * Rendering "current" for a target nobody has ever looked at would be the
 * screen's mistake, not the API's.
 *
 * Two further rules:
 *
 *  - **Freshness is a timestamp, not a status.** The page shows *when* the last
 *    check ran, with its zone. It does not turn that into a red/green "fresh"
 *    badge, and §3.5's rule that staleness is not a failed result is why the
 *    decay column uses `warning` for a genuine decay and nothing at all for a
 *    missing measurement.
 *  - **The brand token is a stated input.** The decay route requires it, so the
 *    page cannot render this view without one and says which prerequisite is
 *    missing rather than showing an empty list.
 */

const FILTER_DEFAULTS = {
  /** Shared with AT03: the string the checks look for. */
  brand: '',
  mention: 'all',
  status: 'all',
  q: '',
};

const MENTION_FILTER_OPTIONS = [
  { value: 'ever-mentioned', label: 'Mentioned at least once' },
  { value: 'checked-absent', label: 'Checked, brand not present' },
  { value: 'never-checked', label: 'Never checked' },
  { value: 'stale', label: `Decayed (${MENTION_DECAY_DAYS}+ days)` },
];

const STATUS_FILTER_OPTIONS = ['new', 'contacted', 'replied', 'placed', 'rejected'].map(
  (status) => ({
    value: status,
    label: MENTION_TARGET_STATUS_LABEL[status as MentionTargetStatus],
  }),
);

export default function MentionHealthPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

  const [rows, setRows] = useState<MentionDecayRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busyTargetId, setBusyTargetId] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState<MentionDecayRow | null>(null);

  const brandToken = String(filters.brand ?? '').trim();
  const brandTokenUsable = brandToken.length >= 2;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!brandTokenUsable) {
        setRows([]);
        return;
      }
      try {
        setError(null);
        setRows(await getMentionDecay(projectId, brandToken, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, brandToken, brandTokenUsable],
  );

  useEffect(() => {
    if (!brandTokenUsable) {
      setRows([]);
      setError(null);
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, brandTokenUsable]);

  const summary = useMemo(() => {
    const counts = {
      everMentioned: 0,
      checkedAbsent: 0,
      neverChecked: 0,
      stale: 0,
    };
    for (const row of rows ?? []) {
      const state = mentionState(row);
      if (state === 'ever-mentioned') counts.everMentioned += 1;
      else if (state === 'checked-absent') counts.checkedAbsent += 1;
      else counts.neverChecked += 1;
      if (row.stale) counts.stale += 1;
    }
    return counts;
  }, [rows]);

  const query = String(filters.q ?? '').trim().toLowerCase();
  const visibleRows = useMemo(() => {
    return (rows ?? []).filter((row) => {
      const state = mentionState(row);
      if (filters.mention === 'stale') {
        if (!row.stale) return false;
      } else if (filters.mention !== 'all' && state !== filters.mention) {
        return false;
      }
      if (filters.status !== 'all' && row.status !== filters.status) return false;
      if (query && !row.url.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [rows, filters.mention, filters.status, query]);

  async function confirmRecheck() {
    if (!rechecking) return;
    const row = rechecking;
    setBusyTargetId(row.targetId);
    setActionError(null);
    try {
      await checkMentionTarget(projectId, row.targetId, brandToken);
      await load();
      setRechecking(null);
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusyTargetId(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Mention health" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  const columns: ReadonlyArray<ColumnDef<MentionDecayRow>> = [
    {
      key: 'url',
      header: 'Target',
      accessor: (row) => row.url,
      sortable: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/authority/targets/${row.targetId}`}
          className="break-all text-table text-primary underline-offset-4 hover:underline"
        >
          {row.url}
        </a>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      accessor: (row) => row.type,
      sortable: true,
      width: 110,
      render: (row) => <span className="capitalize">{row.type}</span>,
    },
    {
      key: 'status',
      header: 'Outreach',
      accessor: (row) => row.status,
      sortable: true,
      width: 130,
      render: (row) => (
        <StatusPill
          label={MENTION_TARGET_STATUS_LABEL[row.status as MentionTargetStatus] ?? row.status}
          tone="neutral"
        />
      ),
    },
    {
      key: 'mentionState',
      header: 'Mention state',
      width: 220,
      render: (row) => <MentionStateCell row={row} />,
    },
    {
      key: 'lastMentionedAt',
      header: 'Last seen',
      accessor: (row) => row.lastMentionedAt,
      sortable: true,
      width: 200,
      // Only a target that has actually been mentioned has a last-seen time.
      emptyLabel: 'No mention recorded',
      render: (row) => (row.lastMentionedAt ? <Timestamp value={row.lastMentionedAt} /> : null),
    },
    {
      key: 'daysSinceLastMention',
      header: 'Days since sighting',
      accessor: (row) => row.daysSinceLastMention,
      sortable: true,
      align: 'right',
      width: 150,
      emptyLabel: 'Not applicable',
      render: (row) =>
        row.daysSinceLastMention === null ? null : (
          <span className="tabular-nums">{formatNumber(row.daysSinceLastMention)}</span>
        ),
    },
    {
      key: 'lastCheckedAt',
      header: 'Last checked',
      accessor: (row) => row.lastCheckedAt,
      sortable: true,
      width: 200,
      // A timestamp is the honest answer here: a target that has never been
      // checked has no freshness to report, and "0 days" would be a lie.
      emptyLabel: 'Never checked',
      render: (row) => (row.lastCheckedAt ? <Timestamp value={row.lastCheckedAt} /> : null),
    },
    {
      key: 'decay',
      header: 'Decay',
      width: 200,
      render: (row) => <DecayCell row={row} />,
    },
    {
      key: 'actions',
      header: '',
      width: 120,
      alwaysVisible: true,
      render: (row) => (
        <Button
          variant="outline"
          size="sm"
          disabled={busyTargetId === row.targetId}
          onClick={() => setRechecking(row)}
        >
          Recheck
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mention health"
        context={
          rows === null && brandTokenUsable
            ? undefined
            : brandTokenUsable
              ? `${formatNumber(rows?.length ?? 0)} tracked target${(rows?.length ?? 0) === 1 ? '' : 's'}`
              : 'Waiting for a brand token'
        }
        secondaryActions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={!brandTokenUsable}
          >
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Brand token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="mentions-brand">
                Token to look for <span className="text-danger-foreground">(required)</span>
              </Label>
              <Input
                id="mentions-brand"
                value={String(filters.brand ?? '')}
                onChange={(event) => setFilters({ brand: event.target.value })}
                placeholder="Wave3Co"
              />
            </div>
          </div>
          <p className="text-meta text-muted-foreground">
            Decay is measured per brand token: a check only counts as a mention when the fetched
            page actually contains this string. It is kept in the URL so the view is reproducible.
          </p>
        </CardContent>
      </Card>

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {!brandTokenUsable ? (
        <EmptyState
          variant="not-measured"
          subject="mention decay"
          prerequisite="Enter the brand token above"
        >
          <p>
            Decay is a statement about whether the brand still appears on each tracked page. It
            cannot be read without knowing the exact string to look for, so nothing is shown here
            until one is supplied.
          </p>
        </EmptyState>
      ) : rows === null ? (
        <div className="space-y-4">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="mention decay"
          prerequisite="Record a target on the outreach screen"
        >
          <p>
            No mention targets are tracked for this project yet, so there is no decay to report.
          </p>
        </EmptyState>
      ) : (
        <>
          {/* ── The four states, counted separately ──────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">State of the tracked targets</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <ul className="flex flex-wrap gap-x-8 gap-y-3 text-table">
                <SummaryItem
                  label="Mentioned at least once"
                  value={summary.everMentioned}
                  tone="success"
                />
                <SummaryItem
                  label="Checked, brand not present"
                  value={summary.checkedAbsent}
                  tone="neutral"
                />
                <SummaryItem
                  label="Never checked"
                  value={summary.neverChecked}
                  tone="unmeasured"
                />
                <SummaryItem
                  label={`Decayed (${MENTION_DECAY_DAYS}+ days without a mention)`}
                  value={summary.stale}
                  tone="warning"
                />
              </ul>
              <p className="mt-3 text-meta text-muted-foreground">
                Never checked and checked-but-absent are counted separately on purpose. A target
                nobody has looked at has no mention evidence, so it cannot be counted with the ones
                where the brand was looked for and missing.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Targets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <FilterBar
                defaults={FILTER_DEFAULTS}
                value={filters}
                onChange={setFilters}
                controls={[
                  {
                    kind: 'select',
                    key: 'mention',
                    label: 'Mention state',
                    options: MENTION_FILTER_OPTIONS,
                  },
                  {
                    kind: 'select',
                    key: 'status',
                    label: 'Outreach status',
                    options: STATUS_FILTER_OPTIONS,
                  },
                ]}
                searchPlaceholder="Search target URL"
                summary={`Showing ${visibleRows.length} of ${rows.length}`}
              />
              <DataTable
                caption="Mention decay by target"
                columns={columns}
                rows={visibleRows}
                getRowId={(row) => row.targetId}
                defaultSort={{ key: 'daysSinceLastMention', direction: 'desc' }}
                emptyState={
                  <EmptyState
                    variant="no-results"
                    onClearFilters={() =>
                      setFilters({ mention: 'all', status: 'all', q: '', brand: brandToken })
                    }
                  />
                }
                minTableWidth="80rem"
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* A recheck is one fetch of one page, started deliberately per target. */}
      <ConfirmDialog
        open={rechecking !== null}
        onOpenChange={(open) => {
          if (!open) setRechecking(null);
        }}
        title="Check this target again?"
        confirmLabel="Run the check"
        targetLabel="Target"
        target={rechecking?.url ?? ''}
        effect={
          <p>
            Fetches this one page and records whether &ldquo;{brandToken || 'the brand token'}&rdquo;
            appears on it, with an excerpt. It appends a row to the target&rsquo;s check history and
            does not change the outreach status.
          </p>
        }
        onConfirm={confirmRecheck}
        onConfirmed={() => setRechecking(null)}
      />
    </div>
  );
}

/** The mention state, with the never-checked case stated rather than implied. */
function MentionStateCell({ row }: { row: MentionDecayRow }) {
  const state: MentionState = mentionState(row);
  if (state === 'ever-mentioned') {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Mentioned" tone="success" />
        <div className="text-meta text-muted-foreground">
          Seen at the most recent mention record.
        </div>
      </div>
    );
  }
  if (state === 'checked-absent') {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Not present when last checked" tone="neutral" />
        <div className="text-meta text-muted-foreground">
          Removed, or never there — this view cannot tell which.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <StatusPill label="Never checked" tone="unmeasured" />
      <div className="text-meta text-muted-foreground">
        Nothing is known about this target&rsquo;s mention state.
      </div>
    </div>
  );
}

/**
 * The decay finding.
 *
 * A never-checked target gets no decay verdict at all — the backend's `stale:
 * false` there means "not computed", and rendering it as "current" would turn a
 * missing measurement into a clean bill of health.
 */
function DecayCell({ row }: { row: MentionDecayRow }) {
  if (mentionState(row) === 'never-checked') {
    return (
      <ProvenanceBadge kind="unmeasured" label="No decay computed" />
    );
  }
  if (row.stale) {
    return (
      <div className="space-y-0.5">
        <StatusPill
          label={`No mention for ${formatNumber(row.daysSinceLastMention ?? 0)} days`}
          tone="warning"
        />
        <div className="text-meta text-muted-foreground">
          Past the {MENTION_DECAY_DAYS}-day threshold.
        </div>
      </div>
    );
  }
  if (mentionState(row) === 'checked-absent') {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Checked, no mention" tone="neutral" />
        <div className="text-meta text-muted-foreground">
          No mention has ever been found, so there is none to age.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <StatusPill label="Mention current" tone="success" />
      <div className="text-meta text-muted-foreground">
        Seen within the last {MENTION_DECAY_DAYS} days.
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'neutral' | 'unmeasured';
}) {
  return (
    <li className="flex items-baseline gap-2">
      <StatusPill label={label} tone={tone} />
      <span className="text-subsection font-semibold tabular-nums">{formatNumber(value)}</span>
    </li>
  );
}
