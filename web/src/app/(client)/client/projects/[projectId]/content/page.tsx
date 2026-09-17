'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { contentTypeLabel, humanizeLabel } from '@/lib/format';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  listPortalContent,
  listPortalProjectSummaries,
  type PortalContentItem,
  type PortalProjectSummary,
} from '@/services/portal';

/**
 * CP08 — Content, client side (plan §13.5).
 *
 * This screen lists **only pieces that have at least one explicitly shared
 * revision**. That is not a filter applied here: the portal endpoint is built
 * from a projection that cannot return an unshared piece, so "nothing of yours
 * is ready" and "your team is still working" stay distinguishable, and a
 * client never learns that a private draft exists by watching it appear and
 * disappear.
 *
 * Two deliberate absences:
 *
 *  - **No internal vocabulary.** There is no editorial state, no owner, no
 *    internal review status, no prompt or provider metadata — none of those
 *    fields exist in the response shape, so no future screen can leak them by
 *    accident.
 *  - **No client-side filtering.** The portal list route takes no filter
 *    parameters, and a filter applied in the browser would make the count
 *    describe a different set than the rows. The list is what the server
 *    returned, and the count says how many that is.
 *
 * The review itself does not live here: a review request arrives as an approval
 * bound to one exact revision, and the detail page below routes the decision
 * through that flow.
 */

export default function ClientContentPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null | undefined>(undefined);
  const [items, setItems] = useState<PortalContentItem[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, content] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          listPortalContent(projectId, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setItems(content);
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

  const columns = useMemo<ReadonlyArray<ColumnDef<PortalContentItem>>>(
    () => [
      {
        key: 'title',
        header: 'Content',
        accessor: (row) => row.title,
        sortable: true,
        width: 320,
        render: (row) => (
          <Link
            href={`/client/projects/${projectId}/content/${row.assetId}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {row.title}
          </Link>
        ),
      },
      {
        key: 'assetType',
        header: 'Type',
        accessor: (row) => row.assetType,
        sortable: true,
        width: 160,
        render: (row) => (
          <span className="text-table text-muted-foreground">{contentTypeLabel(row.assetType)}</span>
        ),
      },
      {
        key: 'review',
        header: 'Your review',
        accessor: (row) => row.clientReviewState,
        sortable: true,
        width: 200,
        render: (row) => (
          <StatusPill
              label={REVIEW_LABEL[row.clientReviewState] ?? humanizeLabel(row.clientReviewState)}
              tone={reviewTone(row.clientReviewState)}
            />
        ),
      },
      {
        key: 'publication',
        header: 'Publication',
        accessor: (row) => row.publicationStatus,
        sortable: true,
        width: 180,
        render: (row) => (
          <StatusPill
            label={PUBLICATION_LABEL[row.publicationStatus] ?? humanizeLabel(row.publicationStatus)}
            tone={publicationTone(row.publicationStatus)}
          />
        ),
      },
      {
        key: 'updatedAt',
        header: 'Updated',
        accessor: (row) => row.updatedAt,
        sortable: true,
        width: 160,
        render: (row) => <Timestamp value={row.updatedAt} />,
      },
    ],
    [projectId],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (project === undefined || items === null) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (project === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" />
        <EmptyState
          variant="not-measured"
          subject="this project"
          prerequisite="It is not one of the projects on your account."
          action={{ label: 'Back to your projects', href: '/client/projects' }}
        />
      </div>
    );
  }

  const awaitingReview = items.filter((item) => item.clientReviewState === 'awaiting-review').length;

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Content' },
        ]}
        title="Content"
        context={
          items.length === 0
            ? 'Nothing has been shared with you yet.'
            : `${items.length} piece${items.length === 1 ? '' : 's'} shared with you${
                awaitingReview > 0
                  ? ` · ${awaitingReview} waiting on your review`
                  : ''
              }.`
        }
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href="/client/approvals">
              <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4" />
              Approvals
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Shared with you</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <DataTable
            caption="Content shared with you"
            columns={columns}
            rows={items}
            getRowId={(row) => row.assetId}
            defaultSort={{ key: 'updatedAt', direction: 'desc' }}
            minTableWidth="56rem"
            emptyState={
              <EmptyState
                variant="not-measured"
                subject="shared content"
                prerequisite="Your delivery team shares a piece with you when it is ready for you to read — a draft being written is not one of these."
              >
                When something is shared it appears here with the exact version you are being shown,
                and any review request arrives in Approvals.
              </EmptyState>
            }
          />
        </CardContent>
      </Card>

      <p className="text-meta text-muted-foreground">
        Only content your team has deliberately shared is listed here, and only the version they
        shared — an internal draft in progress is never shown, and a newer internal revision does
        not replace what you were shown until it is shared with you.
      </p>
    </div>
  );
}

const REVIEW_LABEL: Record<string, string> = {
  'not-shared': 'Shared, not yet sent for review',
  'awaiting-review': 'Waiting on your review',
  'changes-requested': 'You asked for changes',
  approved: 'You approved it',
  'expired-superseded': 'Superseded by a newer version',
};

const PUBLICATION_LABEL: Record<string, string> = {
  unscheduled: 'Not scheduled yet',
  planned: 'Planned',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Live',
  failed: 'Publishing failed',
};

function reviewTone(state: string): StatusTone {
  if (state === 'approved') return 'success';
  if (state === 'changes-requested') return 'warning';
  if (state === 'awaiting-review') return 'info';
  return 'neutral';
}

function publicationTone(state: string): StatusTone {
  if (state === 'published') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'scheduled' || state === 'publishing') return 'info';
  return 'neutral';
}
