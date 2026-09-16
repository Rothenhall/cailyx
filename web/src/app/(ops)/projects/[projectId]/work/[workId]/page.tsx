'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  ACCEPTANCE_CHECK_STATUSES,
  WORK_CATEGORY_LABEL,
  WORK_DISCIPLINE_LABEL,
  WORK_ITEM_STATUS_LABEL,
  WORK_PRIORITY_LABEL,
  addAcceptanceCheck,
  blockWorkItem,
  getWorkItem,
  listWorkItems,
  setAcceptanceCheck,
  submitWorkItem,
  unblockWorkItem,
  verifyWorkItem,
  type AcceptanceCheck,
  type AcceptanceCheckStatus,
  type Verification,
  type WorkCategory,
  type WorkDiscipline,
  type WorkItem,
  type WorkItemDetail,
  type WorkItemStatus,
  type WorkPriority,
} from '@/services/delivery-plan';
import { ApiError } from '@/lib/api';

/**
 * PJ09 — Work detail.
 *
 * design_plan.md §4.3: *"Outcome, acceptance checks, evidence,
 * estimate/owner/reviewer, dependencies, activity"*, support "N G06".
 *
 * Three rules from the brief decide almost every choice on this page:
 *
 * 1. **Verification is evidence, not a checkbox.** A `Verification` row records
 *    the source URL, the run id and type, the artifact, the observed time and
 *    the reviewer. All five are shown, and the record form collects them. A
 *    rejection **reopens** the work item — the server moves it back to `active`
 *    — so the screen reads the returned status instead of assuming the item
 *    stayed in review.
 * 2. **`clientVisible` is a server field.** It gates what the client portal
 *    returns. It is displayed as a fact about the record, with a sentence
 *    saying so; this screen never presents it as a toggle that changes what the
 *    client sees, because that would be a UI claim about server behaviour.
 * 3. **`internalNotes` is never client-facing.** It is rendered in its own
 *    block, labelled internal, and the label says what would have to happen for
 *    a client to see it — which is nothing, because the field is stripped by
 *    construction on every portal route.
 *
 * The activity section is derived from the work item's own log. `submit` appends
 * a timestamped entry to the description rather than writing to a separate
 * table, so this screen parses those entries out and labels the section as what
 * it is — the record the server keeps — instead of presenting a synthesized
 * audit trail as if it were a table.
 */
export default function WorkDetailPage() {
  const params = useParams<{ projectId: string; workId: string }>();
  const projectId = params.projectId;
  const workId = params.workId;

  const [item, setItem] = useState<WorkItemDetail | null>(null);
  const [siblings, setSiblings] = useState<WorkItem[]>([]);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [submitNote, setSubmitNote] = useState('');
  const [submitUrl, setSubmitUrl] = useState('');

  const [decision, setDecision] = useState<'accepted' | 'rejected'>('accepted');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [verifyRunId, setVerifyRunId] = useState('');
  const [verifyRunType, setVerifyRunType] = useState('');
  const [verifyArtifact, setVerifyArtifact] = useState('');
  const [verifyObservedAt, setVerifyObservedAt] = useState('');
  const [verifyNote, setVerifyNote] = useState('');

  const [newCheck, setNewCheck] = useState('');

  const [blockReason, setBlockReason] = useState('');
  const [blockedOn, setBlockedOn] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [detail, rows] = await Promise.all([
        getWorkItem(projectId, workId, { signal }),
        listWorkItems(projectId, undefined, { signal }).catch(() => []),
      ]);
      setItem(detail);
      setSiblings(rows);
    },
    [projectId, workId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setError(null);
        setLoading(true);
        await load(controller.signal);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [load]);

  const dependencies = useMemo(() => {
    if (!item) return [];
    const byId = new Map(siblings.map((row) => [row.id, row]));
    return item.dependsOn.map((id) => ({
      id,
      title: byId.get(id)?.title ?? null,
      status: byId.get(id)?.status ?? null,
    }));
  }, [item, siblings]);

  const activity = useMemo(() => parseActivity(item?.description ?? null), [item]);

  const acceptedVerification = item?.verifications.find((row) => row.decision === 'accepted') ?? null;

  async function run(action: () => Promise<void>, successMessage: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
    } catch (caught) {
      const apiError = toApiError(caught);
      setActionError(
        apiError.kind === 'forbidden'
          ? apiError.message
          : apiError.kind === 'conflict'
            ? apiError.message
            : `${apiError.message} Nothing was changed.`,
      );
      // A conflict means the server moved under us; re-read rather than guess.
      if (apiError.kind === 'conflict') await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Project', href: `/projects/${projectId}` }]}
          title="Work item"
        />
        <ErrorState error={error} notFoundReason="missing-or-private" onRetry={() => void load()} />
      </div>
    );
  }

  if (!item) return null;

  const status = item.status as WorkItemStatus;
  const isBlocked = status === 'blocked';
  const passedChecks = item.acceptanceChecks.filter((check) => check.status === 'passed').length;
  const failedChecks = item.acceptanceChecks.filter((check) => check.status === 'failed').length;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Work' },
        ]}
        title={item.title}
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {WORK_CATEGORY_LABEL[item.category as WorkCategory] ?? item.category} ·{' '}
              {WORK_DISCIPLINE_LABEL[item.discipline as WorkDiscipline] ?? item.discipline} ·{' '}
              {WORK_PRIORITY_LABEL[item.priority as WorkPriority] ?? item.priority} priority
            </span>
            {item.cycleId ? (
              <Link
                href={`/projects/${projectId}/cycles/${item.cycleId}`}
                className="underline underline-offset-4"
              >
                In a cycle
              </Link>
            ) : (
              <span className="text-muted-foreground">Not in a cycle</span>
            )}
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill
              tone={workStatusTone(status)}
              label={WORK_ITEM_STATUS_LABEL[status] ?? status}
            />
            <StatusPill
              tone={item.clientVisible ? 'info' : 'unmeasured'}
              label={item.clientVisible ? 'Client-visible' : 'Internal only'}
            />
          </span>
        }
      />

      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>The change was refused</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {isBlocked ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>This work is blocked</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{item.blockedReason ?? 'No reason was recorded.'}</p>
            {item.blockedOn ? (
              <p className="text-meta">Waiting on: {item.blockedOn}</p>
            ) : (
              <p className="text-meta">
                No responsible party was recorded, so a client-caused blocker cannot be told apart
                from an internal one.
              </p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Outcome ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Outcome</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="whitespace-pre-wrap text-body">
            {item.description?.trim() ? item.description : notMeasuredLabel()}
          </p>

          <dl className="grid gap-1 text-table sm:grid-cols-2">
            <Row label="Owner">
              {item.assigneeId ? (
                <span className="font-mono text-meta">{item.assigneeId}</span>
              ) : (
                // §3.5 — an unassigned commitment is a real, actionable state.
                <span className="text-muted-foreground">Unassigned</span>
              )}
            </Row>
            <Row label="Reviewer">
              {item.reviewerId ? (
                <span className="font-mono text-meta">{item.reviewerId}</span>
              ) : (
                <span className="text-muted-foreground">No reviewer assigned</span>
              )}
            </Row>
            <Row label="Estimated">
              {item.estimateHours === null ? (
                <span className="text-muted-foreground">{notMeasuredLabel()}</span>
              ) : (
                `${formatNumber(item.estimateHours)} h`
              )}
            </Row>
            <Row label="Actual">
              {item.actualHours === null ? (
                <span className="text-muted-foreground">{notMeasuredLabel()}</span>
              ) : (
                `${formatNumber(item.actualHours)} h`
              )}
            </Row>
            <Row label="Due">
              {item.dueAt ? (
                <Timestamp value={item.dueAt} />
              ) : (
                <span className="text-muted-foreground">No due date set</span>
              )}
            </Row>
            <Row label="Source">
              {item.sourceType ? (
                <span className="font-mono text-meta">
                  {item.sourceType}:{item.sourceId ?? '—'}
                </span>
              ) : (
                <span className="text-muted-foreground">No source recorded</span>
              )}
            </Row>
          </dl>

          <p className="text-meta text-muted-foreground">
            §7.2 asks for one named owner per commitment and a reviewer distinct from the author.
            Names are not resolved here: the operator directory is admin-only (G03), so this screen
            shows the recorded ids rather than a name it cannot verify.
          </p>
        </CardContent>
      </Card>

      {/* ── Client visibility and internal notes ────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Client visibility</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <StatusPill
              tone={item.clientVisible ? 'info' : 'unmeasured'}
              label={item.clientVisible ? 'Visible in the client portal' : 'Not visible to the client'}
            />
            <p className="text-table text-muted-foreground">
              This is a stored field on the record, set when the work was created or edited. The
              server decides what the client portal returns from it — this screen does not ask the
              client&apos;s session and so cannot be used to confirm what they currently see.
            </p>
          </CardContent>
        </Card>

        <Card className="border-warning">
          <CardHeader>
            <CardTitle className="text-subsection">
              Internal notes <span className="text-warning-foreground">— internal</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="whitespace-pre-wrap text-table">
              {item.internalNotes?.trim() ? item.internalNotes : notMeasuredLabel()}
            </p>
            <p className="text-meta text-warning-foreground">
              Never client-facing. The server omits this field entirely on client-scoped routes, so
              it cannot reach a client portal even if a screen asked for it.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Acceptance checks ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Acceptance checks</CardTitle>
          <span className="text-meta text-muted-foreground">
            {formatNumber(passedChecks)} passed · {formatNumber(failedChecks)} failed ·{' '}
            {formatNumber(item.acceptanceChecks.length)} total
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          {item.acceptanceChecks.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="acceptance checks for this work"
              prerequisite="checks defined when the work is scoped"
              layout="inline"
            >
              <p>
                Nothing has been defined to check. That is a gap in what &ldquo;done&rdquo; means for
                this item, not a pass — an unchecked deliverable is not an accepted one.
              </p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {item.acceptanceChecks.map((check) => (
                <AcceptanceCheckRow
                  key={check.id}
                  check={check}
                  projectId={projectId}
                  onChanged={() => void load()}
                />
              ))}
            </ul>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!newCheck.trim()) return;
              void run(
                () => addAcceptanceCheck(projectId, workId, newCheck.trim()).then(() => undefined),
                'Check added.',
              );
              setNewCheck('');
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="min-w-[16rem] flex-1 space-y-1.5">
              <Label htmlFor="newCheck">Add a check</Label>
              <Input
                id="newCheck"
                value={newCheck}
                onChange={(event) => setNewCheck(event.target.value)}
                placeholder="A condition that must hold for this to count as done"
              />
            </div>
            <Button type="submit" variant="outline" disabled={busy || !newCheck.trim()}>
              Add check
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ── Evidence ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Verification evidence</CardTitle>
          {acceptedVerification ? (
            <StatusPill tone="success" label="Verified with evidence" />
          ) : (
            <StatusPill tone="unmeasured" label="No accepted verification yet" />
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-table text-muted-foreground">
            A verification is a reviewer&apos;s observation, recorded with what was checked and
            when. It is not a checkbox: a rejection reopens this work item rather than closing it,
            and the record below is the history of those observations.
          </p>

          {item.verifications.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="verification evidence for this work"
              prerequisite="a reviewer recording what they observed"
              layout="inline"
            />
          ) : (
            <ol className="space-y-3">
              {item.verifications.map((verification) => (
                <VerificationRow key={verification.id} verification={verification} />
              ))}
            </ol>
          )}

          {/* Submit — only from active. */}
          {status === 'active' ? (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="text-table font-medium">Submit this work for review</h3>
              <p className="text-meta text-muted-foreground">
                Records what was delivered and, optionally, where it is visible. This moves the item
                to review; it does not accept it.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="submitNote">What was delivered</Label>
                <Textarea
                  id="submitNote"
                  value={submitNote}
                  onChange={(event) => setSubmitNote(event.target.value)}
                  rows={3}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="submitUrl">Live URL</Label>
                <Input
                  id="submitUrl"
                  value={submitUrl}
                  onChange={(event) => setSubmitUrl(event.target.value)}
                  inputMode="url"
                  placeholder="https://…"
                />
              </div>
              <Button
                onClick={() =>
                  void run(
                    () =>
                      submitWorkItem(projectId, workId, {
                        note: submitNote.trim() || undefined,
                        sourceUrl: submitUrl.trim() || undefined,
                      }).then(() => undefined),
                    'Submitted for review.',
                  )
                }
                disabled={busy}
              >
                Submit for review
              </Button>
            </div>
          ) : null}

          {/* Verify — from review, or to re-verify an already verified item. */}
          {status === 'review' || status === 'verified' ? (
            <div className="space-y-4 rounded-lg border border-border p-4">
              <h3 className="text-table font-medium">Record a verification</h3>

              <fieldset className="space-y-2">
                <legend className="text-table">Decision</legend>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={decision === 'accepted' ? 'default' : 'outline'}
                    aria-pressed={decision === 'accepted'}
                    onClick={() => setDecision('accepted')}
                  >
                    Accepted — the change is verified
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={decision === 'rejected' ? 'destructive' : 'outline'}
                    aria-pressed={decision === 'rejected'}
                    onClick={() => setDecision('rejected')}
                  >
                    Rejected — reopen the work
                  </Button>
                </div>
                {decision === 'rejected' ? (
                  <p className="text-meta text-danger-foreground">
                    A rejection returns this item to Active. It is not a terminal state and it does
                    not cancel the work.
                  </p>
                ) : null}
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="verifyUrl">Source URL</Label>
                  <Input
                    id="verifyUrl"
                    value={verifyUrl}
                    onChange={(event) => setVerifyUrl(event.target.value)}
                    inputMode="url"
                    placeholder="https://…"
                  />
                  <p className="text-meta text-muted-foreground">
                    Where the change is observable.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="verifyArtifact">Artifact checked</Label>
                  <Input
                    id="verifyArtifact"
                    value={verifyArtifact}
                    onChange={(event) => setVerifyArtifact(event.target.value)}
                    placeholder="The exact thing that was looked at"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="verifyRunId">Run id</Label>
                  <Input
                    id="verifyRunId"
                    value={verifyRunId}
                    onChange={(event) => setVerifyRunId(event.target.value)}
                    placeholder="The audit or measurement run that observed it"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="verifyRunType">Run type</Label>
                  <Input
                    id="verifyRunType"
                    value={verifyRunType}
                    onChange={(event) => setVerifyRunType(event.target.value)}
                    placeholder="e.g. technical-audit"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="verifyObservedAt">Observed at</Label>
                  <Input
                    id="verifyObservedAt"
                    type="datetime-local"
                    value={verifyObservedAt}
                    onChange={(event) => setVerifyObservedAt(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    Defaults to now when left blank. The time you record is the observation time,
                    not the time you are typing.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="verifyNote">
                  Note
                  {decision === 'rejected' ? (
                    <span className="ml-1 text-meta font-normal text-muted-foreground">
                      (required on a rejection)
                    </span>
                  ) : null}
                </Label>
                <Textarea
                  id="verifyNote"
                  value={verifyNote}
                  onChange={(event) => setVerifyNote(event.target.value)}
                  rows={3}
                />
              </div>

              <Button
                variant={decision === 'rejected' ? 'destructive' : 'default'}
                disabled={busy || (decision === 'rejected' && !verifyNote.trim())}
                onClick={() =>
                  void run(async () => {
                    await verifyWorkItem(projectId, workId, {
                      decision,
                      sourceUrl: verifyUrl.trim() || undefined,
                      runId: verifyRunId.trim() || undefined,
                      runType: verifyRunType.trim() || undefined,
                      artifact: verifyArtifact.trim() || undefined,
                      observedAt: verifyObservedAt
                        ? new Date(verifyObservedAt).toISOString()
                        : undefined,
                      note: verifyNote.trim() || undefined,
                    });
                  }, decision === 'accepted' ? 'Verification recorded.' : 'Rejection recorded — the work item has been reopened.')
                }
              >
                {decision === 'accepted' ? 'Record verification' : 'Reject and reopen'}
              </Button>
            </div>
          ) : (
            <p className="text-table text-muted-foreground">
              Verification is recorded against work in review (or to re-verify already-verified
              work). This item is currently{' '}
              {WORK_ITEM_STATUS_LABEL[status]?.toLowerCase() ?? status}.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Dependencies ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Dependencies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {dependencies.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="dependencies for this work"
              prerequisite="a work item that must finish first"
              layout="inline"
            >
              <p>
                Nothing is recorded as needing to finish before this. That is not proof that nothing
                does — it means no dependency has been declared.
              </p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {dependencies.map((dependency) => (
                <li key={dependency.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <Link
                    href={`/projects/${projectId}/work/${dependency.id}`}
                    className="text-table underline-offset-4 hover:underline"
                  >
                    {dependency.title ?? (
                      <span className="font-mono text-meta">{dependency.id}</span>
                    )}
                  </Link>
                  {dependency.status ? (
                    <StatusPill
                      tone={workStatusTone(dependency.status as WorkItemStatus)}
                      label={WORK_ITEM_STATUS_LABEL[dependency.status as WorkItemStatus] ?? dependency.status}
                    />
                  ) : (
                    <span className="text-meta text-muted-foreground">
                      This dependency is not in the project&apos;s loaded work list.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="text-meta text-muted-foreground">
            Dependencies are validated server-side: a set that would form a loop is rejected with a
            409 rather than being pre-checked here, because the graph the server validates is the one
            that is stored.
          </p>

          {isBlocked ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => unblockWorkItem(projectId, workId).then(() => undefined),
                  'Block cleared. The item returns to Active.',
                )
              }
            >
              Clear the block
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="text-table font-medium">Block this work</h3>
              <p className="text-meta text-muted-foreground">
                A blocked item keeps its place in the cycle. Record who it is waiting on, so a
                client-caused blocker is distinguishable from an internal one.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="blockReason">Reason (required)</Label>
                <Textarea
                  id="blockReason"
                  value={blockReason}
                  onChange={(event) => setBlockReason(event.target.value)}
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="blockedOn">Waiting on</Label>
                <Input
                  id="blockedOn"
                  value={blockedOn}
                  onChange={(event) => setBlockedOn(event.target.value)}
                  placeholder="A person or party, not a task"
                />
              </div>
              <Button
                variant="outline"
                disabled={busy || !blockReason.trim()}
                onClick={() =>
                  void run(
                    () =>
                      blockWorkItem(projectId, workId, {
                        blockedReason: blockReason.trim(),
                        blockedOn: blockedOn.trim() || undefined,
                      }).then(() => undefined),
                    'Work item blocked.',
                  )
                }
              >
                Record the block
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Activity ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {activity.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="a recorded activity log for this work item"
              prerequisite="a work-item activity ledger (design_plan G06)"
              layout="inline"
            >
              <p>
                A work item has no separate activity table today. The server appends submission
                entries to the description and records verifications as their own rows — both are
                shown above. Everything else (edits, status moves) is not recorded against the item.
              </p>
            </EmptyState>
          ) : (
            <ol className="divide-y divide-border">
              {activity.map((entry, index) => (
                <li key={`${entry.at ?? 'unknown'}-${index}`} className="space-y-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-table">
                    <span className="font-medium">{entry.label}</span>
                    {entry.at ? <Timestamp value={entry.at} /> : null}
                    {entry.by ? (
                      <span className="text-meta text-muted-foreground">
                        by <span className="font-mono">{entry.by}</span>
                      </span>
                    ) : null}
                  </div>
                  {entry.text ? <p className="text-table">{entry.text}</p> : null}
                </li>
              ))}
            </ol>
          )}

          <p className="text-meta text-muted-foreground">
            Derived from the work item&apos;s own description, which is where the server appends
            submission entries. It is the record as stored, not a reconstructed timeline.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AcceptanceCheckRow({
  check,
  projectId,
  onChanged,
}: {
  check: AcceptanceCheck;
  projectId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-table">{check.description}</p>
          <p className="text-meta text-muted-foreground">
            {check.checkedAt ? (
              <>
                Last set <Timestamp value={check.checkedAt} />
                {check.checkedBy ? ` by ${check.checkedBy}` : ''}
              </>
            ) : (
              'Not yet assessed'
            )}
            {check.note ? ` · ${check.note}` : ''}
          </p>
        </div>
        <StatusPill
          tone={
            check.status === 'passed' ? 'success' : check.status === 'failed' ? 'danger' : 'unmeasured'
          }
          label={
            check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Pending'
          }
        />
      </div>

      {error ? (
        <p className="text-meta text-danger-foreground" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1 space-y-1.5">
          <Label htmlFor={`check-note-${check.id}`} className="text-meta">
            Note (optional)
          </Label>
          <Input
            id={`check-note-${check.id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {ACCEPTANCE_CHECK_STATUSES.map((value: AcceptanceCheckStatus) => (
          <Button
            key={value}
            size="sm"
            variant={check.status === value ? 'default' : 'outline'}
            aria-pressed={check.status === value}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              setAcceptanceCheck(projectId, check.workItemId, check.id, {
                status: value,
                note: note.trim() || undefined,
              })
                .then(() => {
                  setBusy(false);
                  onChanged();
                })
                .catch((caught) => {
                  setBusy(false);
                  const apiError = caught instanceof ApiError ? caught : null;
                  setError(
                    apiError && apiError.message
                      ? apiError.message
                      : 'The check outcome was not recorded. It still has its previous state.',
                  );
                });
            }}
          >
            {value === 'passed' ? 'Pass' : value === 'failed' ? 'Fail' : 'Reset to pending'}
          </Button>
        ))}
      </div>
    </li>
  );
}

function VerificationRow({ verification }: { verification: Verification }) {
  const safe = isSafeHref(verification.sourceUrl);
  return (
    <li className="space-y-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          tone={verification.decision === 'accepted' ? 'success' : 'danger'}
          label={verification.decision === 'accepted' ? 'Accepted' : 'Rejected — reopened'}
        />
        {verification.observedAt ? (
          <span className="text-meta text-muted-foreground">
            Observed <Timestamp value={verification.observedAt} />
          </span>
        ) : (
          <span className="text-meta text-muted-foreground">Observation time not recorded</span>
        )}
        <span className="text-meta text-muted-foreground">
          Recorded <Timestamp value={verification.createdAt} />
        </span>
      </div>

      <dl className="grid gap-1 text-table sm:grid-cols-2">
        <Row label="Reviewer">
          {verification.reviewerId ? (
            <span className="font-mono text-meta">{verification.reviewerId}</span>
          ) : (
            <span className="text-muted-foreground">Not recorded</span>
          )}
        </Row>
        <Row label="Run type">
          {verification.runType ? (
            <span className="font-mono text-meta">{verification.runType}</span>
          ) : (
            <span className="text-muted-foreground">{notMeasuredLabel()}</span>
          )}
        </Row>
        <Row label="Run id">
          {verification.runId ? (
            <span className="break-all font-mono text-meta">{verification.runId}</span>
          ) : (
            <span className="text-muted-foreground">{notMeasuredLabel()}</span>
          )}
        </Row>
        <Row label="Artifact">
          {verification.artifact ? (
            verification.artifact
          ) : (
            <span className="text-muted-foreground">{notMeasuredLabel()}</span>
          )}
        </Row>
        <Row label="Source">
          {verification.sourceUrl ? (
            safe ? (
              <a
                href={verification.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all underline underline-offset-4"
              >
                {verification.sourceUrl}
              </a>
            ) : (
              // §10.5 — a scheme that is not http(s)/relative is shown as text.
              <span className="break-all font-mono text-meta">
                {verification.sourceUrl} (not a link: unsupported URL scheme)
              </span>
            )
          ) : (
            <span className="text-muted-foreground">{notMeasuredLabel()}</span>
          )}
        </Row>
      </dl>

      {verification.note ? <p className="text-table">{verification.note}</p> : null}
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** Only `http(s)` and same-origin relative URLs become links (§10.5). */
function isSafeHref(href: string | null | undefined): href is string {
  if (!href) return false;
  if (href.startsWith('/')) return true;
  try {
    const url = new URL(href, 'https://cailyx.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

interface ActivityEntry {
  label: string;
  at: string | null;
  by: string | null;
  text: string;
}

/**
 * Extracts the entries the server appends to a work item's description:
 * `[<label> <ISO timestamp> by <userId>] <note — url>`.
 *
 * Lines that do not match are left out rather than guessed at — the count of
 * unmatched lines is not shown as activity, because a free-text paragraph is not
 * an event.
 */
function parseActivity(description: string | null): ActivityEntry[] {
  if (!description) return [];
  const entries: ActivityEntry[] = [];
  const pattern = /^\[([^\]]+?)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+by\s+(\S+)\]\s*(.*)$/;
  for (const line of description.split('\n')) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    entries.push({ label: match[1], at: match[2], by: match[3], text: match[4] });
  }
  return entries;
}

function workStatusTone(status: WorkItemStatus): 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'unmeasured' {
  switch (status) {
    case 'verified':
      return 'success';
    case 'review':
      return 'warning';
    case 'blocked':
      return 'danger';
    case 'active':
      return 'info';
    case 'cancelled':
      return 'neutral';
    case 'backlog':
    case 'committed':
    default:
      return 'unmeasured';
  }
}
