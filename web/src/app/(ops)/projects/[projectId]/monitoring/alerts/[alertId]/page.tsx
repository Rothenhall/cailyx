'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { listOperators } from '@/services/admin';
import {
  ALERT_KIND_LABEL,
  ALERT_TRIAGE_STATUS_LABEL,
  acknowledgeAlert,
  assignAlert,
  getAlert,
  readAlertEvidence,
  resolveAlert,
  type AlertDto,
  type AlertKind,
  type AlertTriageStatus,
} from '@/services/monitoring';
import type { SafeUser } from '@/services/types';

/**
 * MO02 — Alert detail.
 *
 * design_plan.md §4.4: *"Kind/severity/evidence, source runs, triage/assignee/
 * resolve target behavior"*.
 *
 * **The triage controls are a state machine, and the server owns it.** §10.4
 * forbids rendering a control that will be refused, and `resolved` is terminal
 * for this episode — the backend answers 409 for a second resolve, and a later
 * firing of the same condition opens a *new* alert rather than re-opening this
 * one. So every control on this page is gated on `lifecycle.actions`, which is
 * computed server-side from the transition table:
 *
 * | Status | Acknowledge | Assign | Resolve |
 * |---|---|---|---|
 * | new | yes | yes | yes |
 * | acknowledged | no | yes | yes |
 * | assigned | yes | yes | yes |
 * | resolved / dismissed | no | no | no |
 *
 * The two consequences this page draws from that:
 *
 *  - a terminal alert renders **no** transition controls at all, and says why;
 *  - `canAcknowledge` is false on an already-acknowledged alert, so the button
 *    is not offered — a second acknowledgement by the same operator would be
 *    idempotent but a different operator's would be a conflict.
 *
 * Two smaller rules: an alert's `status` with no lifecycle row reads as `new`
 * and `occurrences` as 1, which the page states rather than presenting as
 * triage history; and a resolution is a decision about the response, never a
 * claim that the underlying measurement was re-verified.
 */

export default function AlertDetailPage() {
  const params = useParams<{ projectId: string; alertId: string }>();
  const projectId = params.projectId;
  const alertId = params.alertId;

  const session = useSession();

  const [alert, setAlert] = useState<AlertDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const [operators, setOperators] = useState<SafeUser[] | null>(null);
  const [operatorsUnavailable, setOperatorsUnavailable] = useState(false);
  const [resolution, setResolution] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setAlert(await getAlert(projectId, alertId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoaded(true);
      }
    },
    [projectId, alertId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * The operator directory for the assign control.
   *
   * `GET /users` is admin-only, so a delivery lead cannot resolve the assignee
   * list. That is a restriction to state, not a failure of this page: the
   * assign control renders its prerequisite instead of an empty dropdown that
   * would look like "there are no other operators".
   */
  useEffect(() => {
    if (session.status !== 'authenticated') return;
    if (session.user?.role !== 'admin') return;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await listOperators({ signal: controller.signal });
        setOperators(response.users);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setOperatorsUnavailable(true);
        setOperators([]);
      }
    })();
    return () => controller.abort();
  }, [session.status, session.user?.role]);

  const isAdmin = session.user?.role === 'admin';

  async function run(action: () => Promise<AlertDto>) {
    setBusy(true);
    setActionError(null);
    try {
      setAlert(await action());
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  const evidence = useMemo(() => (alert ? readAlertEvidence(alert) : null), [alert]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Alert" />
        <ErrorState
          error={error}
          notFoundReason="missing-or-private"
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!loaded || !alert) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const lifecycle = alert.lifecycle;
  const terminal = lifecycle.status === 'resolved' || lifecycle.status === 'dismissed';
  const kindLabel = ALERT_KIND_LABEL[alert.kind as AlertKind] ?? alert.kind;

  return (
    <div className="space-y-6">
      <PageHeader
        title={kindLabel}
        breadcrumbs={[
          { label: 'Monitoring', href: `/projects/${projectId}/monitoring` },
          { label: 'Alerts' },
          { label: kindLabel },
        ]}
        context={<span className="text-table">{alert.message}</span>}
        status={
          <>
            <StatusPill label={alert.severity} tone={severityTone(alert.severity)} />
            <StatusPill
              label={ALERT_TRIAGE_STATUS_LABEL[lifecycle.status]}
              tone={triageTone(lifecycle.status)}
            />
            <ProvenanceBadge kind="derived" label="Raised by a monitoring check" />
          </>
        }
        primaryAction={
          terminal
            ? undefined
            : lifecycle.actions.canAcknowledge
              ? {
                  label: busy ? 'Working…' : 'Acknowledge',
                  onClick: () => void run(() => acknowledgeAlert(projectId, alertId)),
                  disabled: busy,
                }
              : lifecycle.actions.canResolve
                ? { label: 'Resolve alert', href: '#resolve' }
                : undefined
        }
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* ── What this alert is ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">What was observed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table">{alert.message}</p>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-4">
            <div>
              <dt className="text-meta text-muted-foreground">Kind</dt>
              <dd className="mt-0.5">{kindLabel}</dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Severity</dt>
              <dd className="mt-0.5 capitalize">{alert.severity}</dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">First seen</dt>
              <dd className="mt-0.5">
                <Timestamp value={alert.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-meta text-muted-foreground">Last seen</dt>
              <dd className="mt-0.5">
                {lifecycle.lastSeenAt ? (
                  <Timestamp value={lifecycle.lastSeenAt} />
                ) : (
                  <span className="text-muted-foreground">Recorded on the alert itself</span>
                )}
              </dd>
            </div>
          </dl>

          {/* §4.4: the alert's scope note is part of its meaning, not a tooltip. */}
          <div
            role="note"
            className="flex gap-2 rounded-md border border-border bg-surface-sunken p-3 text-table text-muted-foreground"
          >
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{alert.scopeNote}</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Evidence ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Evidence and source runs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          {evidence && (evidence.before !== null || evidence.after !== null) ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-3">
              <div>
                <dt className="text-meta text-muted-foreground">Before</dt>
                <dd className="mt-0.5 tabular-nums">
                  {evidence.before === null ? notMeasuredLabel() : formatNumber(evidence.before)}
                </dd>
              </div>
              <div>
                <dt className="text-meta text-muted-foreground">After</dt>
                <dd className="mt-0.5 tabular-nums">
                  {evidence.after === null ? notMeasuredLabel() : formatNumber(evidence.after)}
                </dd>
              </div>
              <div>
                <dt className="text-meta text-muted-foreground">Difference recorded</dt>
                <dd className="mt-0.5 tabular-nums">
                  {evidence.change === null
                    ? notMeasuredLabel()
                    : `${evidence.change > 0 ? '+' : ''}${formatNumber(evidence.change)}`}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-table text-muted-foreground">
              This alert&rsquo;s payload records no two-value comparison, so no before and after
              figures are shown. Its kind is reported by its message above.
            </p>
          )}

          <div className="space-y-2">
            <h3 className="text-table font-medium text-foreground">Source runs</h3>
            {evidence && (evidence.beforeRunId || evidence.afterRunId) ? (
              <ul className="space-y-2 text-table">
                {evidence.beforeRunId ? (
                  <li className="flex flex-wrap items-baseline gap-2">
                    <span className="text-muted-foreground">Earlier run</span>
                    <span className="break-all font-mono text-meta">{evidence.beforeRunId}</span>
                  </li>
                ) : null}
                {evidence.afterRunId ? (
                  <li className="flex flex-wrap items-baseline gap-2">
                    <span className="text-muted-foreground">Later run</span>
                    <span className="break-all font-mono text-meta">{evidence.afterRunId}</span>
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="text-table text-muted-foreground">
                This alert names no source runs. A scheduled-run failure reports that a run failed
                without comparing two runs, which is why nothing is listed here.
              </p>
            )}
            <a
              href={`/projects/${projectId}/runs`}
              className="inline-block text-table text-primary underline-offset-4 hover:underline"
            >
              Open the run centre
            </a>
            <p className="text-meta text-muted-foreground">
              The run centre lists every run for this project with its status, cost and coverage.
              Run ids here are the ones recorded on the alert when it was raised.
            </p>
          </div>

          {evidence && evidence.extra.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-table font-medium text-foreground">
                Other recorded fields
              </h3>
              <dl className="space-y-1 text-table">
                {evidence.extra.map((entry) => (
                  <div key={entry.key} className="flex flex-wrap items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">{entry.key}</dt>
                    <dd className="break-all font-mono text-meta">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Triage ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-subsection">Triage</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={ALERT_TRIAGE_STATUS_LABEL[lifecycle.status]}
              tone={triageTone(lifecycle.status)}
            />
            <span className="text-meta text-muted-foreground">
              Seen {formatNumber(lifecycle.occurrences)}×
            </span>
            {!lifecycle.tracked ? (
              <span className="text-meta text-muted-foreground">
                No triage has been recorded yet, so this reads as new with a single occurrence.
              </span>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-2">
          {terminal ? (
            /*
              Terminal. No transition control is rendered, because every one of
              them would be refused: `resolved` has no outgoing transitions, and
              a later firing of the same condition raises a new alert.
            */
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Closed for this episode" tone="neutral" />
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-3">
                <div>
                  <dt className="text-meta text-muted-foreground">Resolved</dt>
                  <dd className="mt-0.5">
                    {lifecycle.resolvedAt ? (
                      <Timestamp value={lifecycle.resolvedAt} />
                    ) : (
                      <span className="text-muted-foreground">{notMeasuredLabel()}</span>
                    )}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-meta text-muted-foreground">What was decided</dt>
                  <dd className="mt-0.5">
                    {lifecycle.resolution ?? (
                      <span className="text-muted-foreground">No resolution text recorded.</span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="text-meta text-muted-foreground">
                Resolving records the decision about the response. It is not a claim that the
                underlying measurement was re-verified, and it does not prevent this condition from
                being reported again — if it fires later, a new alert is raised rather than
                re-opening this one.
              </p>
              {lifecycle.workItemId ? (
                <p className="text-meta text-muted-foreground">
                  Work opened in response: <span className="font-mono">{lifecycle.workItemId}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {/* Acknowledge */}
              <section className="space-y-2">
                <h3 className="text-table font-medium text-foreground">Acknowledge</h3>
                {lifecycle.actions.canAcknowledge ? (
                  <>
                    <p className="text-table text-muted-foreground">
                      Records that you have seen this alert, with your name and the time.
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => acknowledgeAlert(projectId, alertId))}
                    >
                      {busy ? 'Working…' : 'Acknowledge as seen'}
                    </Button>
                  </>
                ) : (
                  <p className="text-table text-muted-foreground">
                    {lifecycle.acknowledgedBy ? (
                      <>
                        Already acknowledged
                        {lifecycle.acknowledgedAt ? (
                          <>
                            {' '}
                            on <Timestamp value={lifecycle.acknowledgedAt} />
                          </>
                        ) : null}
                        . A second acknowledgement by someone else is refused, so it is not offered
                        here.
                      </>
                    ) : (
                      'The server will not accept an acknowledgement for this alert in its current state.'
                    )}
                  </p>
                )}
              </section>

              {/* Assign */}
              <section className="space-y-2">
                <h3 className="text-table font-medium text-foreground">Assignee</h3>
                {lifecycle.assigneeId ? (
                  <p className="text-table text-muted-foreground">
                    Assigned to <span className="font-mono text-meta">{lifecycle.assigneeId}</span>
                    {lifecycle.actions.canAssign
                      ? '. Assigning again replaces the current assignee.'
                      : null}
                  </p>
                ) : (
                  <p className="text-table text-muted-foreground">Nobody is assigned yet.</p>
                )}

                {!lifecycle.actions.canAssign ? (
                  <p className="text-table text-muted-foreground">
                    The server will not accept an assignment for this alert in its current state.
                  </p>
                ) : !isAdmin ? (
                  /*
                    `GET /users` is admin-only, so a non-admin cannot resolve an
                    operator id to choose from. Stating the restriction is the
                    honest answer; an empty dropdown would read as "there are no
                    operators", and typing a raw id is not a name a delivery lead
                    can be expected to know.
                  */
                  <EmptyState
                    variant="insufficient-role"
                    restrictedAction="assign this alert from here"
                    permittedPath="An administrator can assign it. You can still acknowledge and resolve it."
                    layout="inline"
                  />
                ) : operatorsUnavailable ? (
                  <p className="text-table text-muted-foreground">
                    The operator directory did not load, so there is no list of assignees to choose
                    from. Retrying is safe.
                  </p>
                ) : operators === null ? (
                  <Skeleton className="h-10 w-64" />
                ) : operators.length === 0 ? (
                  <p className="text-table text-muted-foreground">
                    The directory returned no operator accounts, so there is nobody to assign this
                    to.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="alert-assignee">Assign to</Label>
                      <Select value={assigneeId} onValueChange={setAssigneeId}>
                        <SelectTrigger id="alert-assignee" className="w-64">
                          <SelectValue placeholder="Choose an operator" />
                        </SelectTrigger>
                        <SelectContent>
                          {operators.map((operator) => (
                            <SelectItem key={operator.id} value={operator.id}>
                              {operator.name} · {operator.role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy || !assigneeId}
                      aria-describedby={!assigneeId ? 'alert-assignee-requirement' : undefined}
                      onClick={() =>
                        void run(async () => {
                          const updated = await assignAlert(projectId, alertId, assigneeId);
                          setAssigneeId('');
                          return updated;
                        })
                      }
                    >
                      {busy ? 'Working…' : 'Assign'}
                    </Button>
                    {!assigneeId ? (
                      <p id="alert-assignee-requirement" className="text-meta text-muted-foreground">
                        Choose an operator to enable assigning.
                      </p>
                    ) : null}
                  </div>
                )}
              </section>

              {/* Resolve */}
              <section id="resolve" className="space-y-2">
                <h3 className="text-table font-medium text-foreground">Resolve</h3>
                {lifecycle.actions.canResolve ? (
                  <>
                    <p className="text-table text-muted-foreground">
                      Closes this alert for this episode. Write what was decided or done — a
                      resolution with no statement of the response leaves the next reader unable to
                      tell a fix from a decision to accept the change.
                    </p>
                    <div className="space-y-2">
                      <Label htmlFor="alert-resolution">
                        What was decided <span className="text-danger-foreground">(required)</span>
                      </Label>
                      <Textarea
                        id="alert-resolution"
                        rows={4}
                        value={resolution}
                        onChange={(event) => setResolution(event.target.value)}
                        placeholder="What was investigated, and what the response is"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        disabled={busy || resolution.trim().length === 0}
                        aria-describedby={
                          resolution.trim().length === 0 ? 'alert-resolution-requirement' : undefined
                        }
                        onClick={() =>
                          void run(async () => {
                            const updated = await resolveAlert(projectId, alertId, {
                              resolution: resolution.trim(),
                            });
                            setResolution('');
                            return updated;
                          })
                        }
                      >
                        {busy ? 'Working…' : 'Resolve alert'}
                      </Button>
                      {resolution.trim().length === 0 ? (
                        <p id="alert-resolution-requirement" className="text-meta text-muted-foreground">
                          Enter what was decided to enable resolving.
                        </p>
                      ) : null}
                    </div>
                    <p className="text-meta text-muted-foreground">
                      Resolving is terminal for this episode. If the same condition fires again, a
                      new alert is raised rather than re-opening this one.
                    </p>
                  </>
                ) : (
                  <p className="text-table text-muted-foreground">
                    The server will not accept a resolution for this alert in its current state.
                  </p>
                )}
              </section>
            </>
          )}

          {lifecycle.workItemId && !terminal ? (
            <p className="text-meta text-muted-foreground">
              Work opened in response: <span className="font-mono">{lifecycle.workItemId}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function severityTone(severity: string): StatusTone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return 'neutral';
  }
}

function triageTone(status: AlertTriageStatus): StatusTone {
  switch (status) {
    case 'resolved':
      return 'success';
    case 'dismissed':
      return 'neutral';
    case 'assigned':
    case 'acknowledged':
      return 'info';
    default:
      return 'warning';
  }
}
