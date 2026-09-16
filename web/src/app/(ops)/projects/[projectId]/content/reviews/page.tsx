'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApprovalCard } from '@/components/patterns/ApprovalCard';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import type { ApprovalItem } from '@/types';
import {
  decideApproval,
  listClaims,
  listContentApprovals,
  listRevisionChecks,
  type ApprovalRequest,
  type ClaimRow,
  type CopyCheckReport,
  type RevisionCheckResult,
} from '@/services/content';

/**
 * CT05 — Editorial reviews.
 *
 * design_plan.md §4.4: *"Internal review queue, claim/source violations, client
 * approval status."* §4's approvals family is the layout contract: *"Decision
 * summary, exact artifact/version preview, change summary, evidence and
 * discussion; sticky approve/request-changes actions with confirmation of
 * scope; read-only after recorded decision."*
 *
 * Three facts this screen refuses to blur:
 *
 *  1. **A decision binds to a revision.** `revision` travels with every
 *     decision and must match the request's own `artifactRevision`; a request
 *     with no recorded revision renders as undecidable rather than letting a
 *     decision attach itself to nothing.
 *  2. **Review records belong to one revision.** The claim/source checks are
 *     fetched per revision, on request, and the screen says which revision they
 *     were run against. They are read through the operator-only route, so a
 *     role that cannot read them is told so instead of shown a blank panel.
 *  3. **A recorded decision is read-only.** Only pending and changes-requested
 *     requests render decision controls; everything else shows its outcome.
 */

export default function ContentReviewsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const session = useSession();

  const [requests, setRequests] = useState<ApprovalRequest[] | null>(null);
  const [blockedClaims, setBlockedClaims] = useState<ClaimRow[] | null>(null);
  const [claimsError, setClaimsError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checksByRequest, setChecksByRequest] = useState<
    Record<string, RevisionCheckResult[] | { error: ReturnType<typeof toApiError> }>
  >({});

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await listContentApprovals(projectId, {}, { signal });
        setRequests(result.requests);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  const loadClaims = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setClaimsError(null);
        setBlockedClaims(await listClaims(projectId, 'blocked', { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setClaimsError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    void loadClaims(controller.signal);
    return () => controller.abort();
  }, [load, loadClaims]);

  /**
   * Decisions are admin/delivery-lead only (design_plan §2.2). Rather than
   * render a control that would 403, the role is checked here and the
   * restricted path is explained in text (§3.5 "Insufficient role").
   */
  const canDecide =
    session.user?.type === 'operator' &&
    (session.user.role === 'admin' || session.user.role === 'delivery-lead');

  const internalQueue = useMemo(
    () =>
      (requests ?? []).filter(
        (request) =>
          request.reviewerType === 'operator' &&
          (request.status === 'pending' || request.status === 'changes-requested'),
      ),
    [requests],
  );

  const clientRequests = useMemo(
    () => (requests ?? []).filter((request) => request.reviewerType === 'client'),
    [requests],
  );

  const closedRequests = useMemo(
    () =>
      (requests ?? []).filter(
        (request) =>
          request.status === 'cancelled' ||
          request.status === 'invalidated' ||
          request.status === 'approved',
      ),
    [requests],
  );

  async function onDecide(
    request: ApprovalRequest,
    decision: 'approved' | 'changes-requested',
  ) {
    if (request.artifactRevision === null) return;
    setBusyId(request.id);
    setActionError(null);
    try {
      await decideApproval(projectId, request.id, {
        decision,
        revision: request.artifactRevision,
      });
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function onLoadChecks(request: ApprovalRequest) {
    if (!request.revisionId) return;
    setBusyId(request.id);
    try {
      const result = await listRevisionChecks(request.revisionId);
      setChecksByRequest((current) => ({ ...current, [request.id]: result.results }));
    } catch (caught) {
      setChecksByRequest((current) => ({ ...current, [request.id]: { error: toApiError(caught) } }));
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Editorial reviews" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!requests) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Editorial reviews"
        context={
          requests.length === 0
            ? 'No approval request has been raised for content in this project.'
            : `${internalQueue.length} awaiting internal review · ${clientRequests.length} with the client`
        }
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
                void loadClaims();
              }}
            >
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {actionError ? (
        <ErrorState
          error={actionError}
          layout="inline"
          preserveNotice="The decision was not recorded."
          fieldIdPrefix="decision-"
        />
      ) : null}

      {!canDecide && session.status === 'authenticated' ? (
        <EmptyState
          variant="insufficient-role"
          restrictedAction="record a content review decision"
          permittedPath="Reading the queue and its evidence is still open to you; ask a delivery lead or an admin to record the decision."
        />
      ) : null}

      <Tabs defaultValue="internal">
        <TabsList>
          <TabsTrigger value="internal">
            Internal queue{internalQueue.length > 0 ? ` (${internalQueue.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="client">
            Client approval{clientRequests.length > 0 ? ` (${clientRequests.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="violations">
            Claim &amp; source violations
            {blockedClaims && blockedClaims.length > 0 ? ` (${blockedClaims.length})` : ''}
          </TabsTrigger>
        </TabsList>

        {/* ── Internal queue ─────────────────────────────────────────── */}
        <TabsContent value="internal" className="space-y-4">
          {internalQueue.length === 0 ? (
            <EmptyState variant="not-measured" subject="internal review requests">
              Nothing is waiting on an internal decision. A request appears here when it is raised
              against a specific content revision.
            </EmptyState>
          ) : (
            internalQueue.map((request) => (
              <div key={request.id} className="space-y-3">
                <ApprovalCard
                  item={toApprovalItem(request)}
                  timeZone={undefined}
                  allowedDecisions={['approved', 'changes-requested']}
                  href={
                    request.artifactId
                      ? `/projects/${projectId}/content/${request.artifactId}`
                      : undefined
                  }
                  onDecide={
                    canDecide && request.artifactRevision !== null
                      ? (decision) => {
                          // `pending` is excluded by the component's own type,
                          // so only rejection needs filtering here — this
                          // screen does not offer outright rejection.
                          if (decision === 'rejected') return;
                          return onDecide(request, decision);
                        }
                      : undefined
                  }
                >
                  <RequestFacts request={request} />
                </ApprovalCard>

                {request.artifactRevision === null ? (
                  <Alert>
                    <AlertTitle>This request cannot be decided as it stands</AlertTitle>
                    <AlertDescription>
                      No artifact revision is recorded on it, and a decision must bind to the exact
                      version that was reviewed. Re-raise the request against a revision.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <ReviewRecords
                  request={request}
                  busy={busyId === request.id}
                  value={checksByRequest[request.id]}
                  onLoad={() => void onLoadChecks(request)}
                />
              </div>
            ))
          )}
        </TabsContent>

        {/* ── Client approval ────────────────────────────────────────── */}
        <TabsContent value="client" className="space-y-4">
          <p className="text-table text-muted-foreground">
            A client-facing request is bound to one revision, so a later revision invalidates it
            rather than carrying consent forward. Review must not expose internal prompts, costs,
            private notes or unrelated drafts.
          </p>

          {clientRequests.length === 0 ? (
            <EmptyState variant="not-measured" subject="client approval requests">
              No content has been sent to the client for a decision. Approval requests are raised by
              an operator against a specific revision.
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {clientRequests.map((request) => (
                <li key={request.id}>
                  <Card>
                    <CardHeader className="flex-row items-start justify-between space-y-0">
                      <div className="min-w-0 space-y-1">
                        <CardTitle className="text-table font-medium">{request.title}</CardTitle>
                        <p className="text-meta text-muted-foreground">
                          {request.artifactRevision !== null
                            ? `Revision ${request.artifactRevision} under review`
                            : 'No revision recorded on this request'}
                          {request.dueAt ? ' · due ' : ''}
                          {request.dueAt ? <Timestamp value={request.dueAt} /> : null}
                        </p>
                      </div>
                      <StatusPill
                        label={approvalStatusLabel(request.status)}
                        tone={approvalStatusTone(request.status)}
                      />
                    </CardHeader>
                    <CardContent className="space-y-2 pt-2 text-table">
                      <RequestFacts request={request} />
                      {request.invalidatedReason ? (
                        <p className="text-meta text-warning-foreground">
                          Invalidated: {request.invalidatedReason}
                        </p>
                      ) : null}
                      <Link
                        href={`/projects/${projectId}/content/${request.artifactId}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        Open the artifact at this revision
                      </Link>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        {/* ── Violations ─────────────────────────────────────────────── */}
        <TabsContent value="violations" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Blocked claims</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                A claim is blocked when it hits a banned phrase or states a rate without provenance.
                A blocked claim can never be approved — it has to be rewritten or given a graded
                source first.
              </p>

              {claimsError ? (
                <ErrorState
                  error={claimsError}
                  layout="inline"
                  onRetry={() => void loadClaims()}
                  preserveNotice="The approval queues above are unaffected."
                />
              ) : null}

              {blockedClaims && blockedClaims.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  No claim is currently blocked in this project.
                </p>
              ) : null}

              {blockedClaims && blockedClaims.length > 0 ? (
                <ul className="divide-y divide-border">
                  {blockedClaims.map((claim) => (
                    <li key={claim.id} className="space-y-1 py-3">
                      <p className="text-table text-foreground">{claim.statement}</p>
                      <p className="text-meta text-muted-foreground">
                        {claim.grade
                          ? `Grade ${claim.grade}`
                          : 'No grade recorded — an ungraded number cannot be approved'}
                        {claim.sourceUrl ? ` · source ${claim.sourceUrl}` : ' · no source attached'}
                      </p>
                      <ClaimViolations report={claim.disciplineCheck ?? null} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Per-revision review records</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-2">
              <p className="text-meta text-muted-foreground">
                Claim and source checks are stored against one exact revision, which is what makes
                them meaningful as evidence: a check that passed on revision 2 says nothing about
                revision 3. Open a request in the internal queue and load its records to see them.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {closedRequests.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Decided and withdrawn requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-2">
            <p className="text-meta text-muted-foreground">
              Read-only, kept for the record: a withdrawn request is never deleted.
            </p>
            <ul className="divide-y divide-border">
              {closedRequests.map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 text-table"
                >
                  <span className="min-w-0">
                    {request.title}
                    <span className="ml-2 text-meta text-muted-foreground">
                      {request.artifactRevision !== null
                        ? `revision ${request.artifactRevision}`
                        : 'no revision recorded'}
                    </span>
                  </span>
                  <StatusPill
                    label={approvalStatusLabel(request.status)}
                    tone={approvalStatusTone(request.status)}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────

function RequestFacts({ request }: { request: ApprovalRequest }) {
  return (
    <dl className="grid gap-1 text-table sm:grid-cols-2">
      <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
        <dt className="text-muted-foreground">Requested by</dt>
        <dd className="text-foreground">{request.requestedBy}</dd>
      </div>
      <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
        <dt className="text-muted-foreground">Reviewer</dt>
        <dd className="text-foreground">
          {request.requiredReviewerId ?? 'Not stated'}
        </dd>
      </div>
      <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
        <dt className="text-muted-foreground">Raised</dt>
        <dd className="text-foreground">
          <Timestamp value={request.createdAt} />
        </dd>
      </div>
      <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
        <dt className="text-muted-foreground">Delay consequence</dt>
        {/* §3.3: an unstated consequence renders as "not stated", never as a blank. */}
        <dd className="text-foreground">Not stated on this request</dd>
      </div>
      {request.detail ? (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">What is being asked</dt>
          <dd className="text-foreground">{request.detail}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The stored review records for one revision, loaded on request.
 *
 * Read through an operator-only, admin/delivery-lead-restricted route, so a
 * 403 is an expected outcome rather than a bug — it is rendered as an explicit
 * restriction with no retry control (the same rule `ErrorState` enforces).
 */
function ReviewRecords({
  request,
  busy,
  value,
  onLoad,
}: {
  request: ApprovalRequest;
  busy: boolean;
  value: RevisionCheckResult[] | { error: ReturnType<typeof toApiError> } | undefined;
  onLoad: () => void;
}) {
  if (!request.revisionId) {
    return (
      <p className="text-meta text-muted-foreground">
        This request does not name a stored revision, so there is no revision to attach review
        records to.
      </p>
    );
  }

  if (!value) {
    return (
      <Button variant="outline" size="sm" onClick={onLoad} disabled={busy} aria-busy={busy}>
        {busy ? 'Loading records…' : 'Load claim/source review records'}
      </Button>
    );
  }

  if (!Array.isArray(value)) {
    return (
      <ErrorState
        error={value.error}
        layout="inline"
        restrictedAction="read this revision's review records"
        permittedPath="An admin or delivery lead can read them."
      />
    );
  }

  if (value.length === 0) {
    return (
      <p className="text-table text-muted-foreground">
        No claim or source check is stored against this revision. Nothing was reviewed.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {value.map((check) => (
        <li key={check.id} className="space-y-1 p-3 text-table">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{check.checkKind}</span>
            <StatusPill
              label={check.status}
              tone={check.status === 'passed' ? 'success' : 'warning'}
            />
            <span className="text-meta text-muted-foreground">
              {check.checkedVia === 'automated' ? 'Automated check' : 'Human check'} ·{' '}
              <Timestamp value={check.createdAt} />
            </span>
          </div>
          {check.detail ? <p className="text-muted-foreground">{check.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** The deterministic check report, when a claim carries one. */
function ClaimViolations({ report }: { report: CopyCheckReport | null }) {
  if (!report) return null;
  return (
    <div className="text-meta text-muted-foreground">
      {report.banned.length > 0 ? (
        <p>Banned phrase: {report.banned.map((hit) => hit.phrase).join(', ')}</p>
      ) : null}
      {report.numericClaims.length > 0 ? (
        <p>{report.numericClaims.length} numeric statement(s) need a graded source</p>
      ) : null}
      {report.singleRunRate ? <p>States a rate without multi-run provenance</p> : null}
      {report.violations.length > 0 ? <p>{report.violations.join(' ')}</p> : null}
    </div>
  );
}

// ── Mapping ─────────────────────────────────────────────────────────────

/**
 * G10's request → §3.3's `ApprovalItem`.
 *
 * The version string is the largest element on the card by contract, so it is
 * written as the exact artifact revision and says so when none was recorded
 * rather than inventing a version.
 */
function toApprovalItem(request: ApprovalRequest): ApprovalItem {
  return {
    id: request.id,
    version:
      request.artifactRevision !== null
        ? `Revision ${request.artifactRevision}`
        : 'No revision recorded',
    requestor: request.requestedBy,
    reviewer: request.requiredReviewerId ?? undefined,
    dueDate: request.dueAt ?? undefined,
    decisionRequested: request.detail ?? request.title,
    // G10 does not record what happens on overrun, so the card must say
    // "not stated" rather than leave an inviting blank.
    delayConsequence: undefined,
    decision:
      request.status === 'approved'
        ? 'approved'
        : request.status === 'changes-requested'
          ? 'changes-requested'
          : 'pending',
  };
}

function approvalStatusLabel(status: ApprovalRequest['status']): string {
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

function approvalStatusTone(status: ApprovalRequest['status']) {
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
