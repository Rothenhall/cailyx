'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, History, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApprovalCard } from '@/components/patterns/ApprovalCard';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill, approvalDecisionTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { getPortalApproval, type ApprovalRequestDetail } from '@/services/approvals';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import type { ApprovalItem } from '@/types';

/**
 * CP10 — Approval detail.
 *
 * design_plan.md §4.5: *"Exact report/content/plan version, evidence, changes,
 * decision history."*
 *
 * The rule this screen exists for is decision **history**, and it is a rule
 * about storage, not presentation: decisions are immutable, and a later decision
 * **supersedes** the earlier one instead of overwriting it (`supersededBy` is set
 * on the old row, a new row is created). So this page renders every decision in
 * order, marking which one is the current head. Showing only the latest would
 * erase the fact that a reviewer changed their mind — and when a client
 * approved v2 and later requested changes on v3, that history is the record of
 * what actually happened.
 *
 * The other half of the contract is that an approval binds to an **exact
 * version**. The revision is the largest fact on the card, and the request's
 * `revision` echo is what the API uses to refuse a decision made against a
 * version the reader never saw.
 *
 * Deliberately read-only: §4.5 gives the decision controls to CP09, and the
 * client approval adapter in this build does not send the revision the API
 * requires to accept one (see the note in the page body). Offering a button
 * here that the API rejects would be worse than saying where the decision
 * happens.
 */
export default function ClientApprovalDetailPage() {
  const params = useParams<{ approvalId: string }>();
  const approvalId = params.approvalId;

  const [request, setRequest] = useState<ApprovalRequestDetail | null>(null);
  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [detail, projects] = await Promise.all([
          getPortalApproval(approvalId, { signal }),
          listPortalProjectSummaries({ signal }),
        ]);
        setRequest(detail);
        setProject(projects.find((entry) => entry.id === detail.projectId) ?? null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [approvalId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Approval request" />
        {/* A request that is not this client's returns 404, the same as one that
            does not exist — so both render the same copy. */}
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" />
      </div>
    );
  }

  if (!request) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  // Newest first. Only the head row (no supersededBy) is the current decision.
  const history = [...request.decisions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const currentDecision = history.find((decision) => decision.supersededBy === null) ?? null;
  const supersededCount = history.filter((decision) => decision.supersededBy !== null).length;
  const artifactHref = artifactDestination(request.artifactType, request.projectId);

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project?.name,
          domain: project?.domain,
          mode: 'live',
          runLabel: request.artifactRevision !== null ? `revision ${request.artifactRevision}` : undefined,
        }}
      />

      <PageHeader
        breadcrumbs={[
          { label: 'Approvals', href: '/client/approvals' },
          { label: request.title },
        ]}
        title={request.title}
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{humanize(request.artifactType)}</span>
            <span className="font-mono text-meta">
              {request.artifactRevision !== null
                ? `revision ${request.artifactRevision}`
                : 'version not recorded'}
            </span>
            {request.dueAt ? (
              <span>
                Decided by <Timestamp value={request.dueAt} dateOnly />
              </span>
            ) : (
              <span className="text-muted-foreground">No deadline set</span>
            )}
          </span>
        }
        status={
          <StatusPill
            label={requestStatusLabel(request.status)}
            tone={approvalDecisionTone(mapDecision(request.status))}
          />
        }
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link href="/client/approvals">
              <ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" />
              All approvals
            </Link>
          </Button>
        }
      />

      {request.status === 'invalidated' ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>This request was superseded</AlertTitle>
          <AlertDescription>
            {request.invalidatedReason ??
              'A newer version of this artifact was created after this request, so a decision on it would no longer apply.'}
            {request.invalidatedAt ? (
              <>
                {' '}
                Recorded <Timestamp value={request.invalidatedAt} dateOnly />.
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── The exact version ──────────────────────────────────────────── */}
      <ApprovalCard
        item={toApprovalItem(request)}
        // No onDecide here on purpose — see the page note. The card renders its
        // decision state and the exact version, which is what this screen owes.
        href={artifactHref ?? undefined}
      >
        <div className="space-y-1 text-table">
          <p>
            An approval applies to <span className="font-medium">this version</span> only. If a
            newer version is created afterwards, this decision does not carry
            over and a new request is sent.
          </p>
          {request.revisionId ? (
            <p className="font-mono text-meta text-muted-foreground">
              Revision record: {request.revisionId}
            </p>
          ) : (
            <p className="text-meta text-muted-foreground">
              No separate revision record was stored for this request.
            </p>
          )}
        </div>
      </ApprovalCard>

      {/* ── What you are being asked about ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">What this is about</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="whitespace-pre-wrap text-body">
            {request.detail ??
              `Review this ${request.artifactType} and either approve it or ask for changes.`}
          </p>

          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-meta text-muted-foreground">Requested</dt>
              <dd className="text-table">
                <Timestamp value={request.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Last updated</dt>
              <dd className="text-table">
                <Timestamp value={request.updatedAt} />
              </dd>
            </div>
          </dl>

          <Alert>
            <Info aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>What is not on this page</AlertTitle>
            <AlertDescription>
              <p>
                This request carries the version under review and its decision
                history, but no field-level diff of what changed since the last
                version, and no separate evidence bundle. Where the artifact
                lives is below — that is where its content is.
              </p>
              {artifactHref ? (
                <p className="mt-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={artifactHref}>Open the {request.artifactType}</Link>
                  </Button>
                </p>
              ) : (
                <p className="mt-2">
                  {request.artifactType === 'claim'
                    ? 'A claim has no client-facing screen in this build, so its text is only available through the request above or by asking your delivery team.'
                    : 'This artifact type has no client-facing screen in this build.'}
                </p>
              )}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* ── Decision history ───────────────────────────────────────────── */}
      <section aria-labelledby="history-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="history-heading" className="text-subsection font-semibold tracking-tight">
            Decision history
          </h2>
          <span className="text-meta text-muted-foreground">
            {history.length} decision{history.length === 1 ? '' : 's'}
            {supersededCount > 0 ? ` · ${supersededCount} superseded` : ''}
          </span>
        </div>

        <Card>
          <CardContent className="py-4">
            {history.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="a decision on this request"
                prerequisite="Nobody has decided yet. The decision controls are on the approvals list."
              />
            ) : (
              <ol className="space-y-4">
                {history.map((decision) => (
                  <li key={decision.id} className="border-l-2 border-border pl-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        label={decision.decision === 'approved' ? 'Approved' : 'Changes requested'}
                        tone={decision.decision === 'approved' ? 'success' : 'info'}
                      />
                      {decision.supersededBy === null ? (
                        <span className="text-meta font-medium">Current decision</span>
                      ) : (
                        <span className="text-meta text-muted-foreground">
                          Superseded by a later decision
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-table">
                      <span className="text-muted-foreground">
                        {decision.decidedByType === 'client' ? 'You' : 'Your delivery team'}
                      </span>{' '}
                      · <Timestamp value={decision.createdAt} />
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {decision.decidedRevision !== null
                        ? `Made against revision ${decision.decidedRevision}`
                        : 'The revision reviewed was not recorded on this decision'}
                      {decision.decidedRevision !== null &&
                      request.artifactRevision !== null &&
                      decision.decidedRevision !== request.artifactRevision
                        ? ` — the request is now bound to revision ${request.artifactRevision}.`
                        : ''}
                    </p>
                    {decision.comment ? (
                      <p className="mt-1 whitespace-pre-wrap text-table">{decision.comment}</p>
                    ) : (
                      <p className="mt-1 text-meta text-muted-foreground">
                        No comment was left with this decision.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}

            <p className="mt-4 flex items-start gap-2 text-meta text-muted-foreground">
              <History aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Decisions are kept as recorded. A later decision supersedes an
                earlier one rather than replacing it, so this list is the whole
                history of what was asked and answered — including changes of
                mind.
              </span>
            </p>
          </CardContent>
        </Card>
      </section>

      <p className="text-meta text-muted-foreground">
        {request.status === 'pending' || request.status === 'changes-requested' ? (
          <>
            This request is waiting on a decision. Approving and requesting
            changes happen on the{' '}
            <Link href="/client/approvals" className="text-primary underline underline-offset-4">
              approvals list
            </Link>
            , where the decision is recorded against the revision shown there.
          </>
        ) : (
          <>
            Decided{' '}
            {currentDecision ? (
              <>
                <Timestamp value={currentDecision.createdAt} dateOnly /> — see the history above.
              </>
            ) : (
              'and closed.'
            )}
          </>
        )}
      </p>
    </div>
  );
}

function artifactDestination(artifactType: string, projectId: string): string | null {
  switch (artifactType) {
    case 'report':
      return '/client/reports';
    case 'content':
      return `/client/projects/${projectId}/content`;
    case 'plan':
    case 'cycle':
      return `/client/projects/${projectId}/plan`;
    default:
      return null;
  }
}

function requestStatusLabel(status: string): string {
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
      return 'Superseded';
    default:
      return status;
  }
}

function mapDecision(status: string): ApprovalItem['decision'] {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'changes-requested':
      return 'changes-requested';
    case 'cancelled':
    case 'invalidated':
      return 'rejected';
    default:
      return 'pending';
  }
}

/**
 * The §3.3 approval view model.
 *
 * The version label is built from the real revision number, and when the
 * backend recorded none this says so — a fabricated "v1" is exactly what would
 * let somebody approve the wrong thing.
 */
function toApprovalItem(request: ApprovalRequestDetail): ApprovalItem {
  return {
    id: request.id,
    version:
      request.artifactRevision !== null
        ? `${humanize(request.artifactType)} · revision ${request.artifactRevision}`
        : `${humanize(request.artifactType)} · version not recorded`,
    requestor: 'Your delivery team',
    reviewer: undefined,
    dueDate: request.dueAt ?? undefined,
    decisionRequested:
      request.detail ?? `Review this ${request.artifactType} and either approve it or ask for changes.`,
    delayConsequence: request.dueAt
      ? 'If this is not decided by the due date, the work it blocks may slip.'
      : 'No deadline has been set for this decision.',
    decision: mapDecision(request.status),
  };
}

function humanize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
