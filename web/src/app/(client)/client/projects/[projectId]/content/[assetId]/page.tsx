'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApprovalCard } from '@/components/patterns/ApprovalCard';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { contentTypeLabel, humanizeLabel } from '@/lib/format';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  decidePortalApproval,
  listPortalApprovals,
  type PortalApprovalRequest,
} from '@/services/approvals';
import { getPortalContent, type PortalContentDetail } from '@/services/portal';

/**
 * CP08 — one shared piece, client side (plan §13.5).
 *
 * The single most important behaviour on this page is what it *defaults to*:
 * the latest **shared** revision, never the latest internal draft. That choice
 * is made on the server — the detail projection is built from revisions with
 * `clientVisible` set — so there is no code path here that could show an
 * unshared draft, and no query parameter that could ask for one.
 *
 * The second is what is absent: no prompt, no model, no token count, no
 * temperature, no provider route, no cost, no internal editorial state and no
 * staff identity. Those fields are not in the response shape, so this page
 * cannot render them, and no future edit to this file can add them without a
 * server change.
 *
 * The decision itself is delegated to the existing approval flow: a review
 * request binds to one exact revision, `decidePortalApproval` sends that
 * revision number back, and the server rejects a mismatch with a 409 rather
 * than transferring consent to a version the client never read.
 */

export default function ClientContentDetailPage() {
  const params = useParams<{ projectId: string; assetId: string }>();
  const { projectId, assetId } = params;

  const [detail, setDetail] = useState<PortalContentDetail | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [approvals, setApprovals] = useState<PortalApprovalRequest[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [content, requests] = await Promise.all([
          getPortalContent(projectId, assetId, { signal }),
          listPortalApprovals({ signal }),
        ]);
        setDetail(content);
        setApprovals(requests.requests);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId, assetId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The request that governs the revision on screen. Matched on the asset, the
  // project's content artifact type, and the exact revision number — a request
  // for a different revision is a different question and is not offered here.
  const reviewRequest = useMemo(() => {
    if (!detail || !approvals) return null;
    return (
      approvals.find(
        (request) =>
          request.artifactType === 'content' &&
          request.artifactId === detail.assetId &&
          request.artifactRevision === detail.revision.revision &&
          request.status === 'pending',
      ) ?? null
    );
  }, [detail, approvals]);

  const decide = useCallback(
    async (decision: 'approved' | 'changes-requested') => {
      if (!reviewRequest || !detail) return;
      setActionError(null);
      setNotice(null);
      try {
        await decidePortalApproval(reviewRequest.id, {
          decision,
          // The revision the client actually read. The server compares it and
          // refuses a mismatch — this is what stops an approval landing on a
          // newer draft.
          revision: detail.revision.revision,
        });
        setNotice(
          decision === 'approved'
            ? `Thank you — revision ${detail.revision.revision} is approved.`
            : `Recorded — your team has been asked to revise revision ${detail.revision.revision}.`,
        );
        await load();
      } catch (caught) {
        setActionError(
          clientActionMessage(caught, 'Your decision could not be recorded. Nothing has changed.'),
        );
      }
    },
    [reviewRequest, detail, load],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content" />
        <ErrorState
          error={error}
          onRetry={() => void load()}
          notFoundReason="missing-or-private"
          showServerMessage={false}
        />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: 'Content', href: `/client/projects/${projectId}/content` },
          { label: detail.title },
        ]}
        title={detail.title}
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{contentTypeLabel(detail.assetType)}</span>
            <span>Version {detail.revision.revision}</span>
            {detail.revision.sharedAt ? (
              <span>
                Shared <Timestamp value={detail.revision.sharedAt} />
              </span>
            ) : null}
          </span>
        }
        status={
          <StatusPill
            label={REVIEW_LABEL[detail.clientReviewState] ?? humanizeLabel(detail.clientReviewState)}
            tone={reviewTone(detail.clientReviewState)}
          />
        }
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href="/client/approvals">
              <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4" />
              All approvals
            </Link>
          </Button>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Your decision was not recorded</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                Revision {detail.revision.revision}
                {detail.revision.sharedAt ? (
                  <span className="ml-2 text-meta font-normal text-muted-foreground">
                    shared <Timestamp value={detail.revision.sharedAt} />
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {detail.revision.title ? (
                <h2 className="text-subsection font-semibold text-foreground">
                  {detail.revision.title}
                </h2>
              ) : null}
              {detail.revision.body ? (
                <pre
                  role="region"
                  tabIndex={0}
                  aria-label="The content of this draft"
                  className="max-h-[40rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-4 text-table leading-relaxed"
                >
                  {detail.revision.body}
                </pre>
              ) : (
                <p className="text-table text-muted-foreground">
                  This revision was shared without stored text. Ask your delivery team in messages if
                  you were expecting copy here.
                </p>
              )}
            </CardContent>
          </Card>

          {reviewRequest ? (
            <section aria-labelledby="review-heading" className="space-y-3">
              <h2 id="review-heading" className="text-subsection font-semibold tracking-tight">
                Waiting on you
              </h2>
              <ApprovalCard
                item={{
                  id: reviewRequest.id,
                  version: `revision ${detail.revision.revision}`,
                  requestor: 'Your delivery team',
                  reviewer: undefined,
                  dueDate: reviewRequest.dueAt ?? undefined,
                  decisionRequested:
                    reviewRequest.detail ??
                    'Read this revision and either approve it or ask for changes.',
                  delayConsequence: reviewRequest.dueAt
                    ? 'If this is not decided by the due date, the work it blocks may slip.'
                    : 'No deadline has been set for this decision.',
                  decision: 'pending',
                }}
                allowedDecisions={['approved', 'changes-requested']}
                onDecide={(decision) => decide(decision as 'approved' | 'changes-requested')}
              />
            </section>
          ) : detail.approvalStatus ? (
            <Alert>
              <Info aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>This revision has been decided</AlertTitle>
              <AlertDescription>
                Your {detail.approvalStatus === 'approved' ? 'approval' : 'request for changes'} on
                revision {detail.revision.revision} is recorded. If a newer revision is shared, it
                needs its own decision — an approval never carries over.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-table text-muted-foreground">
              Nothing is waiting on you for this revision. Your delivery team will send a review
              request when they want a decision on a specific version.
            </p>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Shared versions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {detail.history.length <= 1 ? (
                <p className="text-meta text-muted-foreground">
                  This is the only version that has been shared with you. Earlier working drafts are
                  not listed, because you were not shown them.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {detail.history.map((entry) => (
                    <li key={entry.revision} className="flex items-center justify-between gap-2 py-2">
                      <span className="text-table text-foreground">
                        Revision {entry.revision}
                        {entry.revision === detail.revision.revision ? ' · current' : ''}
                      </span>
                      <span className="text-meta text-muted-foreground">
                        {entry.sharedAt ? <Timestamp value={entry.sharedAt} dateOnly /> : 'shared'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-meta text-muted-foreground">
                Only versions shared with you appear here. A revision your team is still working on
                is not shown until it is shared.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Publication</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-table text-muted-foreground">
                Whether this piece is live is shown on the{' '}
                <Link
                  href={`/client/projects/${projectId}/content`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  content list
                </Link>{' '}
                — a review request and a publication are different events, and approving a revision
                does not by itself publish anything.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

const REVIEW_LABEL: Record<string, string> = {
  'not-shared': 'Shared with you',
  'awaiting-review': 'Waiting on your review',
  'changes-requested': 'You asked for changes',
  approved: 'You approved it',
  'expired-superseded': 'Superseded by a newer version',
};

function reviewTone(state: string): StatusTone {
  if (state === 'approved') return 'success';
  if (state === 'changes-requested') return 'warning';
  if (state === 'awaiting-review') return 'info';
  return 'neutral';
}
