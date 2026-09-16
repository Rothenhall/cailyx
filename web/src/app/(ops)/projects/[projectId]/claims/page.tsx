'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  CLAIM_CHECK_LABEL,
  CLAIM_GRADE_LABEL,
  isBlockingCheck,
  listClaims,
  type Claim,
  type ClaimGrade,
} from '@/services/claims';

/**
 * CL01 — Claim library.
 *
 * design_plan.md §4.4: *"Draft/blocked/approved statements, grade, source list,
 * checks, approve/add source."* The claims layout is the portfolio/library
 * family: filter bar, sortable table, row opens a routed detail.
 *
 * The one thing this screen must not do is present a **blocked** claim as
 * merely low-quality. A claim whose discipline check returned `banned-phrase`,
 * `ungraded-number` or `single-run-rate` can never be approved — the server
 * refuses it outright — so it is toned as a refusal, not as a caution, and the
 * grade column says "ungraded" rather than showing a letter it does not have.
 *
 * Filtering is local over the rows the server returned: the route takes a
 * status filter but no pagination, so §10.5's rule applies — local filters
 * cover only the returned records, and no global total is implied.
 */
export default function ClaimLibraryPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setClaims(await listClaims(projectId, undefined, { signal }));
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

  const columns = useMemo<ReadonlyArray<ColumnDef<Claim>>>(
    () => [
      {
        key: 'statement',
        header: 'Claim',
        accessor: (row) => row.statement,
        sortable: true,
        render: (row) => <div className="min-w-0 max-w-[36rem] text-wrap">{row.statement}</div>,
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        sortable: true,
        width: 120,
        render: (row) => <StatusPill label={claimStatusLabel(row.status)} tone={claimStatusTone(row.status)} />,
      },
      {
        key: 'grade',
        header: 'Grade',
        accessor: (row) => row.grade,
        sortable: true,
        width: 110,
        // §3.5 — an ungraded claim is not a C. Missing is not the lowest value.
        emptyLabel: 'Ungraded',
        render: (row) =>
          row.grade ? (
            <span title={CLAIM_GRADE_LABEL[row.grade]} className="font-semibold">
              {row.grade}
            </span>
          ) : null,
      },
      {
        key: 'check',
        header: 'Discipline check',
        accessor: (row) => row.checkResult,
        sortable: true,
        width: 220,
        render: (row) => (
          <StatusPill
            label={CLAIM_CHECK_LABEL[row.checkResult]}
            tone={checkTone(row.checkResult)}
          />
        ),
      },
      {
        key: 'source',
        header: 'Source',
        accessor: (row) => row.sourceName,
        width: 200,
        emptyLabel: 'No source attached',
        render: (row) =>
          row.sourceUrl ? (
            <a
              href={row.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-primary underline underline-offset-4"
            >
              {row.sourceName ?? row.sourceUrl}
            </a>
          ) : row.sourceName ? (
            <span>{row.sourceName}</span>
          ) : null,
      },
      {
        key: 'createdAt',
        header: 'Added',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 150,
        defaultHidden: true,
        render: (row) => <Timestamp value={row.createdAt} dateOnly />,
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Claims" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!claims) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const blocked = claims.filter((claim) => isBlockingCheck(claim.checkResult)).length;
  const ungraded = claims.filter((claim) => claim.grade === null).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Claims"
        context={
          claims.length === 0
            ? 'No claims registered.'
            : [
                `${claims.length} claim${claims.length === 1 ? '' : 's'}`,
                blocked > 0 ? `${blocked} blocked by the discipline check` : null,
                ungraded > 0 ? `${ungraded} ungraded` : null,
              ]
                .filter(Boolean)
                .join(' · ')
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      {claims.length === 0 ? (
        <EmptyState
          variant="no-records"
          subject="claims"
          action={{
            label: 'Return to content',
            href: `/projects/${projectId}/content`,
          }}
        />
      ) : (
        <DataTable
          caption="Claim library"
          columns={columns}
          rows={claims}
          getRowId={(row) => row.id}
          searchable
          searchPlaceholder="Search statements…"
          rowHref={(row) => `/projects/${projectId}/claims/${row.id}`}
          linkColumnKey="statement"
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          filters={[
            {
              id: 'status',
              label: 'Status',
              options: [
                { value: 'draft', label: 'Draft' },
                { value: 'approved', label: 'Approved' },
                { value: 'blocked', label: 'Blocked' },
              ],
              getValue: (row) => row.status,
            },
            {
              id: 'grade',
              label: 'Grade',
              options: [
                { value: 'A', label: 'Grade A' },
                { value: 'B', label: 'Grade B' },
                { value: 'C', label: 'Grade C' },
                { value: '', label: 'Ungraded' },
              ],
              getValue: (row) => row.grade ?? '',
            },
          ]}
          emptyState={<EmptyState variant="no-results" />}
        />
      )}

      <p className="text-meta text-muted-foreground">
        A claim graded C rests on a single source. Two independent sources raise
        it to B automatically; only the project&rsquo;s own n≥5 measurement earns
        an A. Claims blocked by the discipline check cannot be approved.
      </p>
    </div>
  );
}

function claimStatusLabel(status: Claim['status']): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'blocked':
      return 'Blocked';
    default:
      return 'Draft';
  }
}

function claimStatusTone(status: Claim['status']): 'success' | 'danger' | 'unmeasured' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'blocked':
      return 'danger';
    default:
      return 'unmeasured';
  }
}

/** A refusal is a danger; a passing check is success; pending is neither. */
function checkTone(result: Claim['checkResult']): 'success' | 'danger' | 'warning' {
  if (result === 'passed') return 'success';
  if (isBlockingCheck(result)) return 'danger';
  return 'warning';
}

/** Re-exported for CL02 so the two screens cannot drift on the vocabulary. */
export type { ClaimGrade };
