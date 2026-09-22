'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApprovalCard } from '@/components/patterns/ApprovalCard';
import { EmptyState } from '@/components/patterns/EmptyState';
import { artifactTypeLabel } from '@/lib/format';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import {
  decidePortalApproval,
  listPortalApprovals,
  type PortalApprovalRequest,
} from '@/services/approvals';
// Two different things share the name `ApprovalDecision`: the API's decision
// *record* (id, author, timestamp) and the view model's decision *value*
// (approved / changes-requested / rejected / pending). The pattern component
// speaks the latter, so it is aliased here to keep them distinguishable.
import type { ApprovalDecision as ViewDecision, ApprovalItem } from '@/types';

/**
 * CP09 — Approvals.
 *
 * design_plan.md §4.5: *"Pending/decided requests, deadline, version,
 * approve/request changes with…"*
 *
 * Three rules from §5 and §10.4 are implemented here:
 *
 *  1. **The exact version is on the card.** `ApprovalCard` requires it, and it
 *     is populated from `artifactRevision` — never a label like "latest".
 *     Approving "the article" is not a thing this screen allows.
 *  2. **A 409 means the version moved.** The server invalidates a request whose
 *     revision advanced. This page surfaces that as "this changed under you,
 *     reload" rather than retrying the decision against a version the client
 *     never read.
 *  3. **The delay consequence is stated.** §3.3 requires the card to say what
 *     happens if no decision is made — here it is derived from the due date,
 *     and when there is no due date the card says so instead of implying
 *     urgency.
 *
 * The client surface takes no ids: the backend scopes from the session, so
 * there is nothing here to tamper with.
 */
export default function ClientApprovalsPage() {
  const [requests, setRequests] = useState<PortalApprovalRequest[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const result = await listPortalApprovals({ signal });
      setRequests(result.requests);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onDecide(request: PortalApprovalRequest, decision: ViewDecision) {
    if (decision === 'pending') return;

    // A request with no pinned revision cannot be decided at all: the server
    // requires the revision the client confirms they read, and there is nothing
    // to send. Saying so beats a request that would 400.
    if (typeof request.artifactRevision !== 'number') {
      setActionError(
        'This request does not name a version, so a decision cannot be recorded against it. Ask your delivery team to resend it.',
      );
      return;
    }

    setActionError(null);
    try {
      await decidePortalApproval(request.id, {
        decision: decision === 'approved' ? 'approved' : 'changes-requested',
        // The version actually on screen. The server compares it and 409s on a
        // mismatch, which is what stops a decision made against a stale page
        // from being recorded against a newer revision.
        revision: request.artifactRevision,
      });
      await load();
    } catch (caught) {
      const isConflict =
        caught && typeof caught === 'object' && 'kind' in caught && caught.kind === 'conflict';
      setActionError(
        isConflict
          ? 'This item changed after you opened it, so your decision was not recorded. Reload to see the current version before deciding.'
          : clientActionMessage(caught, 'Your decision could not be recorded.'),
      );
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Approvals" />
        <ErrorState error={error} onRetry={() => void load()} showServerMessage={false} />
      </div>
    );
  }

  if (!requests) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  const pending = requests.filter((request) => request.status === 'pending');
  const decided = requests.filter((request) => request.status !== 'pending');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        context={
          requests.length === 0
            ? 'Nothing is waiting on you.'
            : pending.length > 0
              ? `${pending.length} waiting on you, ${decided.length} already decided`
              : `${decided.length} decided, nothing pending`
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {requests.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="approval requests"
          prerequisite="Your delivery team sends one when a piece of work is ready for your review."
        />
      ) : (
        <>
          <ApprovalSummary requests={requests} />

          {pending.length > 0 ? (
            <section aria-labelledby="pending-heading" className="space-y-4">
              <h2 id="pending-heading" className="text-subsection font-semibold tracking-tight">
                Waiting on you
              </h2>
              {pending.map((request) => (
                <ApprovalCard
                  key={request.id}
                  item={toApprovalItem(request)}
                  href={`/client/approvals/${request.id}`}
                  onDecide={(decision) => onDecide(request, decision)}
                />
              ))}
            </section>
          ) : null}

          {decided.length > 0 ? (
            <section aria-labelledby="decided-heading" className="space-y-4">
              <h2 id="decided-heading" className="text-subsection font-semibold tracking-tight">
                Decided
              </h2>
              {decided.map((request) => (
                <div key={request.id}>
                  {request.status === 'invalidated' ? (
                    <Alert className="mb-2">
                      <AlertTriangle aria-hidden="true" className="h-4 w-4" />
                      <AlertTitle>This was superseded</AlertTitle>
                      <AlertDescription>
                        {request.invalidatedReason ??
                          'A newer version was created after this request, so it no longer applies. A fresh request will follow.'}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <ApprovalCard
                    item={toApprovalItem(request)}
                    href={`/client/approvals/${request.id}`}
                  />
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}

      <p className="text-meta text-muted-foreground">
        An approval applies to the exact version shown. If a newer version is
        created afterwards, the approval does not carry over — a new request
        will be sent. See{' '}
        <Link href="/client/messages" className="underline underline-offset-4">
          messages
        </Link>{' '}
        if anything is unclear.
      </p>
    </div>
  );
}

/**
 * Maps the API shape onto the §3.3 view model.
 *
 * The version label is built from the real revision number. When the backend
 * has no revision recorded, this says so plainly rather than inventing "v1" —
 * a fabricated version label is exactly what would let someone approve the
 * wrong thing.
 */
function toApprovalItem(request: PortalApprovalRequest): ApprovalItem {
  const revision =
    typeof request.artifactRevision === 'number' ? `revision ${request.artifactRevision}` : null;

  return {
    id: request.id,
    version: revision
      ? `${artifactTypeLabel(request.artifactType)} · ${revision}`
      : `${artifactTypeLabel(request.artifactType)} · version not recorded`,
    requestor: 'Your delivery team',
    reviewer: undefined,
    dueDate: request.dueAt ?? undefined,
    decisionRequested:
      request.detail ??
      `Review this ${artifactTypeLabel(request.artifactType).toLowerCase()} and either approve it or ask for changes.`,
    // §3.3 requires the consequence of delay. Saying "no deadline" is honest;
    // inventing urgency the backend did not set is not.
    delayConsequence: request.dueAt
      ? 'If this is not decided by the due date, the work it blocks may slip.'
      : 'No deadline has been set for this decision.',
    decision: mapDecision(request.status),
  };
}

/**
 * Where this queue stands, as a proportion rather than a sentence.
 *
 * One stacked bar for a small part-to-whole, with a 2px surface gap between
 * segments so adjacent fills stay distinct. The segments use the reserved
 * status tones and every one is labelled with its count beneath — the colour
 * is never the only thing carrying the state (§3.4).
 */
function ApprovalSummary({ requests }: { requests: PortalApprovalRequest[] }) {
  const groups = [
    {
      key: 'pending',
      label: 'Waiting on you',
      fill: 'bg-warning',
      count: requests.filter((r) => r.status === 'pending').length,
    },
    {
      key: 'approved',
      label: 'Approved',
      fill: 'bg-success',
      count: requests.filter((r) => r.status === 'approved').length,
    },
    {
      key: 'changes',
      label: 'Changes requested',
      fill: 'bg-info',
      count: requests.filter((r) => r.status === 'changes-requested').length,
    },
    {
      key: 'closed',
      label: 'Closed',
      fill: 'bg-unmeasured',
      count: requests.filter((r) => r.status === 'cancelled' || r.status === 'invalidated').length,
    },
  ].filter((group) => group.count > 0);

  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (total === 0) return null;

  return (
    <Card className="route-enter">
      <CardContent className="py-5">
        <div className="flex gap-0.5" role="img" aria-label={groups.map((g) => `${g.label}: ${g.count}`).join(', ')}>
          {groups.map((group) => (
            <div
              key={group.key}
              className={`h-2 rounded-full ${group.fill} transition-[width] duration-slow ease-out`}
              style={{ width: `${(group.count / total) * 100}%` }}
            />
          ))}
        </div>
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          {groups.map((group) => (
            <div key={group.key} className="flex items-center gap-2">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${group.fill}`} />
              <dt className="text-meta text-muted-foreground">{group.label}</dt>
              <dd className="text-table font-semibold tabular-nums">{group.count}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function mapDecision(status: PortalApprovalRequest['status']): ApprovalItem['decision'] {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'changes-requested':
      return 'changes-requested';
    case 'cancelled':
    case 'invalidated':
      // Both mean the request no longer stands. `rejected` is the closest view
      // state; the banner above explains which it actually was.
      return 'rejected';
    default:
      return 'pending';
  }
}

