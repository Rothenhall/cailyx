'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, BellRing, Info, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { ApiError } from '@/lib/api';
import {
  ALERT_KIND_LABEL,
  ALERT_TRIAGE_STATUS_LABEL,
  getMonitoringDelta,
  getMonitoringSnapshot,
  listAlerts,
  runMonitoringCheck,
  type AlertDto,
  type AlertKind,
  type AlertTriageStatus,
  type MonitorDelta,
  type MonitorSnapshot,
} from '@/services/monitoring';

/**
 * MO01 — Monitoring.
 *
 * design_plan.md §4.4: *"Snapshot, score delta, observation counts, alert feed,
 * freshness, check now"*, support "E; meaningful cohort trends G13".
 *
 * **Nothing runs on load.** §10.4 requires a scan to declare its prerequisites,
 * its scope, an explicit start and double-submit protection — so "Check now" is
 * a deliberate confirmation that names what will be compared and what will be
 * written. There is no effect on this page that fires a check.
 *
 * Three data rules that this page is careful about:
 *
 *  1. **The snapshot is a point-in-time read, and it says when.** §10.3's
 *     freshness rule, plus §6.3's warning that the snapshot's cohort ("the
 *     latest completed run") is **not** the same as a pooled measurement
 *     summary. The page names the cohort rather than presenting the figures as
 *     a general truth about the project.
 *  2. **A delta is not a trend.** `GET /monitoring/delta` returns the two
 *     values and their difference but **no run identifiers, dates or rubric
 *     versions** — §6.4's comparison key. Without the key this page reports the
 *     server's arithmetic and explicitly does not label it an improvement or a
 *     decline, and gives no `ComparableBaseline` to `MetricTile` (which is
 *     exactly the §3.5 "no comparison baseline" state rather than a claim that
 *     the movement was measured).
 *  3. **A null rate is not a zero rate.** §6.3: "If observations=0, render
 *     'Not measured'". Every nullable figure goes through `MetricTile` with a
 *     null value, never a coerced 0.
 */

export default function MonitoringPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [delta, setDelta] = useState<MonitorDelta | null>(null);
  const [alerts, setAlerts] = useState<AlertDto[] | null>(null);
  const [nothingToMonitor, setNothingToMonitor] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [checkError, setCheckError] = useState<ApiError | null>(null);
  const [confirmingCheck, setConfirmingCheck] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setNothingToMonitor(false);
        /**
         * The snapshot 404s when neither scoring nor measurement has run. That
         * is a state §3.5 names, not a page failure, so it is caught here and
         * the rest of the page still renders.
         */
        try {
          setSnapshot(await getMonitoringSnapshot(projectId, { signal }));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
          const apiError = toApiError(caught);
          if (apiError.kind === 'not-found') {
            setSnapshot(null);
            setNothingToMonitor(true);
          } else {
            throw caught;
          }
        }
        setDelta(await getMonitoringDelta(projectId, { signal }));
        setAlerts(await listAlerts(projectId, { limit: 50 }, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoaded(true);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const scoreDelta = delta?.score ?? null;
  const measurementDelta = delta?.measurement ?? null;

  /**
   * What a check would actually compare, so the confirmation can name it.
   * A check with only one run of a kind finds nothing in that kind — that is a
   * fact about the inputs, not a reason to hide the button.
   */
  const comparableInputs = useMemo(() => {
    const parts: Array<{ label: string; met: boolean; detail: string }> = [];
    parts.push({
      label: 'Two score runs to compare',
      met: scoreDelta?.before !== null && scoreDelta !== null,
      detail:
        scoreDelta === null
          ? 'No score run has been recorded for this project.'
          : scoreDelta.before === null
            ? 'Only one score run exists, so there is no earlier run to compare against.'
            : `Comparing ${formatNumber(scoreDelta.before)} with ${formatNumber(scoreDelta.after ?? 0)}.`,
    });
    parts.push({
      label: 'Two measurement runs to compare',
      met: measurementDelta?.observationsBefore !== null && measurementDelta !== null,
      detail:
        measurementDelta === null
          ? 'No completed measurement run has been recorded for this project.'
          : measurementDelta.observationsBefore === null
            ? 'Only one completed measurement run exists, so there is no observation-count trend.'
            : `Comparing ${formatNumber(measurementDelta.observationsBefore)} with ${formatNumber(
                measurementDelta.observationsAfter ?? 0,
              )} observations.`,
    });
    return parts;
  }, [scoreDelta, measurementDelta]);

  async function confirmCheck() {
    setCheckError(null);
    setCheckResult(null);
    try {
      const findings = await runMonitoringCheck(projectId);
      setCheckResult(
        findings.length === 0
          ? 'The check ran and found no regression crossing a threshold. No alert was raised or updated.'
          : `The check found ${findings.length} regression${findings.length === 1 ? '' : 's'}. Alerts that were already open for the same condition were updated rather than duplicated.`,
      );
      await load();
    } catch (caught) {
      setCheckError(toApiError(caught));
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Monitoring" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const alertColumns: ReadonlyArray<ColumnDef<AlertDto>> = [
    {
      key: 'severity',
      header: 'Severity',
      accessor: (row) => row.severity,
      sortable: true,
      width: 120,
      render: (row) => <StatusPill label={row.severity} tone={severityTone(row.severity)} />,
    },
    {
      key: 'kind',
      header: 'Kind',
      accessor: (row) => row.kind,
      sortable: true,
      width: 190,
      render: (row) => ALERT_KIND_LABEL[row.kind as AlertKind] ?? row.kind,
    },
    {
      key: 'message',
      header: 'What changed',
      accessor: (row) => row.message,
      render: (row) => <span className="text-table">{row.message}</span>,
    },
    {
      key: 'status',
      header: 'Triage',
      accessor: (row) => row.lifecycle.status,
      sortable: true,
      width: 150,
      render: (row) => (
        <StatusPill
          label={ALERT_TRIAGE_STATUS_LABEL[row.lifecycle.status] ?? row.lifecycle.status}
          tone={triageTone(row.lifecycle.status)}
        />
      ),
    },
    {
      key: 'occurrences',
      header: 'Seen',
      accessor: (row) => row.lifecycle.occurrences,
      sortable: true,
      align: 'right',
      width: 100,
      render: (row) => (
        <span className="tabular-nums">{formatNumber(row.lifecycle.occurrences)}×</span>
      ),
    },
    {
      key: 'lastSeenAt',
      header: 'Last seen',
      accessor: (row) => row.lifecycle.lastSeenAt ?? row.createdAt,
      sortable: true,
      width: 200,
      render: (row) => <Timestamp value={row.lifecycle.lastSeenAt ?? row.createdAt} />,
    },
    {
      key: 'open',
      header: '',
      width: 90,
      alwaysVisible: true,
      render: (row) => (
        <a
          href={`/projects/${projectId}/monitoring/alerts/${row.id}`}
          className="text-table text-primary underline-offset-4 hover:underline"
        >
          Open
        </a>
      ),
    },
  ];

  const openAlerts = (alerts ?? []).filter(
    (alert) => alert.lifecycle.status !== 'resolved' && alert.lifecycle.status !== 'dismissed',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        context={
          nothingToMonitor ? (
            'Nothing has been measured for this project yet.'
          ) : delta ? (
            <>
              Last read <Timestamp value={delta.checkedAt} />
            </>
          ) : undefined
        }
        primaryAction={{
          label: 'Check now',
          onClick: () => {
            setCheckResult(null);
            setConfirmingCheck(true);
          },
        }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {checkResult ? (
        <Alert role="status">
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{checkResult}</AlertDescription>
        </Alert>
      ) : null}

      {checkError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{checkError.message}</AlertDescription>
        </Alert>
      ) : null}

      {nothingToMonitor ? (
        <EmptyState
          variant="not-measured"
          subject="this project's monitoring snapshot"
          prerequisite="run a score or complete a measurement run"
        >
          <p>
            Monitoring re-reads measurements other modules produced. Nothing has produced one yet,
            so there is no score, no mention rate and no observation count to watch. The alert feed
            below is still shown, because a check can raise an alert about a run that failed even
            before any score exists.
          </p>
        </EmptyState>
      ) : snapshot ? (
        <>
          {/* ── Freshness ───────────────────────────────────────────── */}
          <Card>
            <CardHeader className="space-y-2">
              <CardTitle className="text-subsection">Latest snapshot</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Point-in-time read" tone="neutral" />
                <ProvenanceBadge kind="measured" />
                <Timestamp value={snapshot.takenAt} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-table text-muted-foreground">
                These figures are the latest completed runs for this project, read at the time
                above. They are not a pooled summary across every run ever recorded, and they are
                not a reporting-period figure — a later run changes them without changing anything
                already reported.
              </p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-4">
                <div>
                  <dt className="text-meta text-muted-foreground">Score run</dt>
                  <dd className="mt-0.5">
                    {snapshot.scoreRunId ? (
                      <span className="break-all font-mono text-meta">{snapshot.scoreRunId}</span>
                    ) : (
                      <span className="text-muted-foreground">{notMeasuredLabel()}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-muted-foreground">Rubric band</dt>
                  <dd className="mt-0.5">
                    {snapshot.scoreBand ?? (
                      <span className="text-muted-foreground">{notMeasuredLabel()}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-muted-foreground">Observations read</dt>
                  <dd className="mt-0.5 tabular-nums">{formatNumber(snapshot.observations)}</dd>
                </div>
                <div>
                  <dt className="text-meta text-muted-foreground">Crawler hits</dt>
                  <dd className="mt-0.5 tabular-nums">{formatNumber(snapshot.crawlerHits)}</dd>
                </div>
              </dl>
              <p className="text-meta text-muted-foreground">
                This response identifies the score run it read but not the measurement run the two
                rates came from, so those figures cannot be linked to their run from here. The run
                centre lists the runs themselves.
              </p>
            </CardContent>
          </Card>

          {/* ── Metrics ─────────────────────────────────────────────── */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {/*
              The score tile is rendered only when there is no earlier run to
              compare against. With two or more runs the comparison card below
              carries the value instead, because a tile with no asserted
              baseline would print §3.5's "First measurement" — which is false
              once a second run exists.
            */}
            {scoreDelta?.before === null || scoreDelta === null ? (
              <MetricTile
                label="Rubric score"
                value={snapshot.scoreTotal}
                runLabel={snapshot.scoreRunId ? `Score run ${shortId(snapshot.scoreRunId)}` : undefined}
                sourceDate={{ date: snapshot.takenAt, sourceName: 'Monitoring snapshot' }}
                provenance="measured"
                note={
                  snapshot.scoreBand
                    ? `Band: ${snapshot.scoreBand}. “Recommended” is a rubric label, not a promise an engine recommends the brand.`
                    : undefined
                }
              />
            ) : (
              <Card className="p-4">
                <h3 className="text-meta text-muted-foreground">Rubric score</h3>
                <p className="mt-1 text-kpi font-semibold tabular-nums">
                  {formatNumber(scoreDelta.after ?? 0)}
                </p>
                <p className="mt-1 text-meta text-muted-foreground">
                  {snapshot.scoreBand ? `Band: ${snapshot.scoreBand}` : 'Band not recorded'}
                </p>
                <p className="mt-2 text-meta text-muted-foreground">
                  Compared with an earlier run below.
                </p>
              </Card>
            )}

            <MetricTile
              label="Mention rate"
              value={snapshot.mentionRate}
              unit="%"
              runLabel="Latest completed measurement run"
              sourceDate={{ date: snapshot.takenAt, sourceName: 'Monitoring snapshot' }}
              provenance="measured"
              note={
                snapshot.mentionRate === null
                  ? 'No completed measurement run has produced a mention rate, or the latest one observed nothing.'
                  : undefined
              }
            />
            <MetricTile
              label="Citation rate"
              value={snapshot.citationRate}
              unit="%"
              runLabel="Latest completed measurement run"
              sourceDate={{ date: snapshot.takenAt, sourceName: 'Monitoring snapshot' }}
              provenance="measured"
              note={
                snapshot.citationRate === null
                  ? 'No completed measurement run has produced a citation rate, or the latest one observed nothing.'
                  : undefined
              }
            />
            <MetricTile
              label="Crawler hits"
              value={snapshot.crawlerHits}
              unit="hits"
              sourceDate={{ date: snapshot.takenAt, sourceName: 'Monitoring snapshot' }}
              provenance="measured"
              note="Hits by ingested bots. A hit does not prove indexing, citation or training inclusion (§6.3)."
            />
          </div>

          {/* ── Deltas ──────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="space-y-2">
              <CardTitle className="text-subsection">Change since the previous run</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <ProvenanceBadge kind="derived" label="Server-computed difference" />
                {delta ? <Timestamp value={delta.checkedAt} /> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-5 pt-2">
              {/*
                §6.4 requires a comparison key to draw a qualified change. The
                delta route returns the two values and their difference but not
                the runs they came from, so no comparability is asserted here
                and the direction is not labelled.
              */}
              <div
                role="note"
                className="flex gap-2 rounded-md border border-border-strong bg-surface-sunken p-3 text-table text-muted-foreground"
              >
                <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium text-foreground">
                    These differences are shown without a comparability claim.
                  </p>
                  <p className="mt-1">
                    A qualified change needs a comparison key: which runs were compared, their
                    dates, and the rubric or query-set versions behind them. This endpoint returns
                    the two values and their difference only, so the page reports the server&rsquo;s
                    arithmetic and does not call the movement an improvement or a decline.
                  </p>
                </div>
              </div>

              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-2">
                  <h3 className="text-table font-medium text-foreground">Rubric score</h3>
                  {scoreDelta === null ? (
                    <p className="text-table text-muted-foreground">
                      No score run has been recorded, so there is nothing to compare.
                    </p>
                  ) : scoreDelta.before === null ? (
                    <p className="text-table text-muted-foreground">
                      Only one score run exists. The current value is {formatNumber(scoreDelta.after ?? 0)};
                      a comparison appears once a second run completes.
                    </p>
                  ) : (
                    <dl className="space-y-1 text-table">
                      <ComparisonRow label="Earlier run" value={formatNumber(scoreDelta.before)} />
                      <ComparisonRow label="Latest run" value={formatNumber(scoreDelta.after ?? 0)} />
                      <ComparisonRow
                        label="Difference (points)"
                        value={
                          scoreDelta.change === null
                            ? notMeasuredLabel()
                            : `${scoreDelta.change > 0 ? '+' : ''}${formatNumber(scoreDelta.change)}`
                        }
                      />
                    </dl>
                  )}
                </div>

                <div className="space-y-2">
                  <h3 className="text-table font-medium text-foreground">Observation counts</h3>
                  {measurementDelta === null ? (
                    <p className="text-table text-muted-foreground">
                      No completed measurement run has been recorded, so there are no observation
                      counts to compare.
                    </p>
                  ) : measurementDelta.observationsBefore === null ? (
                    <p className="text-table text-muted-foreground">
                      Only one completed measurement run exists, with{' '}
                      {formatNumber(measurementDelta.observationsAfter ?? 0)} observations. A trend
                      appears once a second run completes.
                    </p>
                  ) : (
                    <dl className="space-y-1 text-table">
                      <ComparisonRow
                        label="Earlier run"
                        value={`${formatNumber(measurementDelta.observationsBefore)} observations`}
                      />
                      <ComparisonRow
                        label="Latest run"
                        value={`${formatNumber(measurementDelta.observationsAfter ?? 0)} observations`}
                      />
                    </dl>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* ── Alert feed ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-subsection">Alerts</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={`${formatNumber(openAlerts.length)} open`}
              tone={openAlerts.length > 0 ? 'warning' : 'neutral'}
            />
            <span className="text-meta text-muted-foreground">
              Ordered by when the condition was last seen, so a regression that is still firing
              stays at the top.
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {alerts === null || alerts.length === 0 ? (
            /*
              Neither `no-results` (this list is unfiltered) nor `not-measured`
              (a check may have run and simply found nothing) is the right
              §3.5 variant for "no alert has been raised", so the fact is stated
              directly. See the build report: a `no-alerts` variant is needed.
            */
            <div className="flex items-start gap-2 text-table text-muted-foreground">
              <BellRing aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                No alert has been raised for this project
                {delta ? (
                  <>
                    {' '}
                    as of the last check at <Timestamp value={delta.checkedAt} />
                  </>
                ) : null}
                . A check compares the two latest runs against the score and mention-rate
                thresholds and raises an alert when one crosses; silence means nothing crossed,
                not that monitoring is switched off.
              </p>
            </div>
          ) : (
            <DataTable
              caption="Monitoring alerts"
              columns={alertColumns}
              rows={alerts}
              getRowId={(row) => row.id}
              defaultSort={{ key: 'lastSeenAt', direction: 'desc' }}
              emptyState={<EmptyState variant="no-results" />}
              minTableWidth="72rem"
            />
          )}
        </CardContent>
      </Card>

      {/*
        §10.4: an explicit start that names its scope and what it writes.
        Double-submit is handled by the dialog staying open and the request
        being awaited before it closes.
      */}
      <ConfirmDialog
        open={confirmingCheck}
        onOpenChange={setConfirmingCheck}
        title="Run a monitoring check?"
        confirmLabel="Run check"
        targetLabel="Scope"
        target="The two latest score runs and measurement runs on this project"
        effect={
          <div className="space-y-2">
            <p>
              Reads the latest runs already stored and compares them against the alert thresholds:
              a score drop of at least 10 points, and a mention-rate drop of at least 15 percentage
              points. It writes alert rows for anything that crossed.
            </p>
            <p>
              A regression that already has an open alert is folded into that alert rather than
              added as a second one, so running the check twice does not create duplicates.
            </p>
          </div>
        }
        onConfirm={confirmCheck}
        onConfirmed={() => setConfirmingCheck(false)}
      >
        <div className="space-y-2">
          <h4 className="text-table font-medium text-foreground">What this check can compare</h4>
          <ul className="space-y-2">
            {comparableInputs.map((input) => (
              <li key={input.label} className="flex items-start gap-2 text-table">
                <StatusPill
                  label={input.met ? 'Available' : 'Not available'}
                  tone={input.met ? 'success' : 'unmeasured'}
                />
                <span>
                  <span className="font-medium text-foreground">{input.label}</span>
                  <span className="block text-meta text-muted-foreground">{input.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-meta text-muted-foreground">
            A check still runs when one of these is unavailable — it simply finds nothing of that
            kind.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

function ComparisonRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
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
      return 'info';
    case 'acknowledged':
      return 'info';
    default:
      return 'warning';
  }
}
