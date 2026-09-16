'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { DataTable } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useSession } from '@/hooks/useSession';
import { notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import {
  CADENCE_FREQUENCIES,
  CADENCE_FREQUENCY_LABEL,
  CADENCE_TASK_KIND_LABEL,
  cadenceNeedsDayOfMonth,
  cadenceNeedsDayOfWeek,
  getMonitoringSchedule,
  isCadencePaused,
  isCadenceNotStarted,
  isCadenceSkip,
  listCadences,
  putCadence,
  runCadenceNow,
  setMonitoringSchedule,
  MONITORING_CADENCES,
  MONITORING_CADENCE_LABEL,
  type CadenceFrequency,
  type CadenceRule,
  type MonitoringCadence,
  type MonitoringSchedule,
  type TickOutcome,
} from '@/services/monitoring';

/**
 * MO03 — Cadence settings.
 *
 * design_plan.md §4.4: *"Technical/SEO/monitoring cadence separately, last
 * run/error/next due; target full program schedule"*. Support: "P three
 * schedules E; orchestration G07".
 *
 * **The three schedules are per task kind and independent** — a weekly web
 * audit says nothing about the monitoring check — so each is shown with its own
 * state, its own last result and its own next due time, and nothing is
 * aggregated into a single "project schedule" that does not exist.
 *
 * The read is the part that must be right; four rules govern it:
 *
 *  1. **A paused rule is not a failed one.** `pausedAt !== null` renders as
 *     "Paused", with the time it was paused. It is a deliberate stop, so it is
 *     never tinted as a fault and never shares a column with `lastError`.
 *  2. **A skipped tick is a quiet skip by design.** When a prerequisite is
 *     unmet the backend writes `lastStatus: 'skipped'` and puts the reason in
 *     `lastError`; §10.4's rule that an unmet prerequisite is *reported* rather
 *     than allowed to fail nightly is why that text is surfaced here in the
 *     informational tone it deserves. Only a status that is genuinely a fault
 *     gets the error tone — `'queued-not-started'` means a run was created that
 *     no worker picked up, which is worth an operator's attention.
 *  3. **No next run is not "never".** A manual-only or unconfigured rule has
 *     `nextRunAt: null`, which is rendered as "Not scheduled" — not as a date,
 *     and not as a fault.
 *  4. **The monitoring cadence is a different system, and it says so.** It is
 *     not a cadence rule — `monitoring` is not a valid task kind and
 *     `GET /cadences/monitoring` answers 400 — so it is read from its own route
 *     and labelled, including the fact that it shares one stored row with the
 *     technical-audit schedule.
 */

export default function CadenceSettingsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const session = useSession();

  const [rules, setRules] = useState<CadenceRule[] | null>(null);
  const [schedule, setSchedule] = useState<MonitoringSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [tickResult, setTickResult] = useState<TickOutcome | null>(null);
  const [runningKind, setRunningKind] = useState<string | null>(null);
  const [confirmingRun, setConfirmingRun] = useState<CadenceRule | null>(null);
  const [overridePrerequisites, setOverridePrerequisites] = useState(false);

  const canEdit = session.user?.role === 'admin' || session.user?.role === 'delivery-lead';

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [nextRules, nextSchedule] = await Promise.all([
          listCadences(projectId, { signal }),
          getMonitoringSchedule(projectId, { signal }).catch((caught) => {
            if (caught instanceof DOMException && caught.name === 'AbortError') throw caught;
            return null;
          }),
        ]);
        setRules(nextRules);
        setSchedule(nextSchedule);
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

  const ruleFor = useCallback(
    (taskKind: string) => (rules ?? []).find((rule) => rule.taskKind === taskKind) ?? null,
    [rules],
  );

  async function confirmRunNow() {
    if (!confirmingRun) return;
    const rule = confirmingRun;
    setRunningKind(rule.taskKind);
    setActionError(null);
    try {
      const outcome = await runCadenceNow(projectId, rule.taskKind, {
        overridePrerequisites: overridePrerequisites || undefined,
      });
      setTickResult(outcome);
      setConfirmingRun(null);
      setOverridePrerequisites(false);
      await load();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setRunningKind(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Cadence settings" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!loaded || !rules) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const programRules = rules.filter(
    (rule) => rule.taskKind !== 'technical-audit' && rule.taskKind !== 'seo-audit',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cadence settings"
        context="Each task kind has its own rule. One rule's state does not affect another's."
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {tickResult ? (
        <Alert role="status" variant={tickOutcomeVariant(tickResult.outcome)}>
          {tickResult.outcome === 'started' ? (
            <Info aria-hidden="true" className="h-4 w-4" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          )}
          <AlertTitle>{tickOutcomeTitle(tickResult)}</AlertTitle>
          <AlertDescription>
            {tickResult.reason ??
              'The run was created and handed to a worker. It does not change when the next scheduled run is due.'}
            {tickResult.jobRunId ? (
              <span className="mt-1 block">
                Run <span className="font-mono">{tickResult.jobRunId}</span>
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      ) : null}

      {!canEdit ? (
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>You can read these schedules but not change them</AlertTitle>
          <AlertDescription>
            Changing a cadence, pausing a rule and running one out of band are all restricted to
            administrators and delivery leads. Everything on this page is shown as stored.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── Technical audit ─────────────────────────────────────────── */}
      <CadenceCard
        title="Website health check"
        taskKind="technical-audit"
        rule={ruleFor('technical-audit')}
        projectId={projectId}
        canEdit={canEdit}
        timeZone={ruleFor('technical-audit')?.timezone}
        onChanged={load}
        onRunNow={setConfirmingRun}
        running={runningKind === 'technical-audit'}
        onError={setActionError}
      />

      {/* ── SEO audit ───────────────────────────────────────────────── */}
      <CadenceCard
        title="Search performance audit"
        taskKind="seo-audit"
        rule={ruleFor('seo-audit')}
        projectId={projectId}
        canEdit={canEdit}
        timeZone={ruleFor('seo-audit')?.timezone}
        onChanged={load}
        onRunNow={setConfirmingRun}
        running={runningKind === 'seo-audit'}
        onError={setActionError}
      />

      {/* ── Monitoring ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-subsection">Monitoring check</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={schedule?.active ? 'Scheduled' : 'Manual only'}
              tone={schedule?.active ? 'success' : 'neutral'}
            />
            <span className="text-meta text-muted-foreground">Pre-G07 monitoring schedule</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          {schedule === null ? (
            <EmptyState
              variant="not-measured"
              subject="the monitoring schedule"
              prerequisite="The schedule route did not return a configuration"
              layout="inline"
            />
          ) : (
            <>
              <div
                role="note"
                className="flex gap-2 rounded-md border border-border bg-surface-sunken p-3 text-table text-muted-foreground"
              >
                <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Monitoring is not one of the cadence task kinds — <code>monitoring</code> is not a
                  valid kind, so this schedule is stored and read on its own route. It shares a
                  single stored configuration row with the website health check, so changing this
                  cadence can affect that one too.
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-4">
                <div>
                  <dt className="text-meta text-muted-foreground">Cadence</dt>
                  <dd className="mt-0.5 capitalize">{schedule.cadence}</dd>
                </div>
                <div>
                  <dt className="text-meta text-muted-foreground">Next due</dt>
                  <dd className="mt-0.5">
                    {schedule.nextRunAt ? (
                      <Timestamp value={schedule.nextRunAt} />
                    ) : (
                      <span className="text-muted-foreground">Not scheduled</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-muted-foreground">Last run</dt>
                  <dd className="mt-0.5">
                    {schedule.lastRunAt ? (
                      <Timestamp value={schedule.lastRunAt} />
                    ) : (
                      <span className="text-muted-foreground">
                        {schedule.lastRunAt === null ? 'No run recorded' : notMeasuredLabel()}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-muted-foreground">Last error</dt>
                  <dd className="mt-0.5">
                    {schedule.lastError ? (
                      <span className="text-danger-foreground">{schedule.lastError}</span>
                    ) : (
                      <span className="text-muted-foreground">None recorded</span>
                    )}
                  </dd>
                </div>
              </dl>

              {canEdit ? (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="monitoring-cadence">Set the monitoring cadence</Label>
                    <Select
                      value={schedule.cadence}
                      onValueChange={(value) => {
                        void (async () => {
                          setActionError(null);
                          try {
                            setSchedule(
                              await setMonitoringSchedule(projectId, value as MonitoringCadence),
                            );
                          } catch (caught) {
                            setActionError(toApiError(caught));
                          }
                        })();
                      }}
                    >
                      <SelectTrigger id="monitoring-cadence" className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MONITORING_CADENCES.map((cadence) => (
                          <SelectItem key={cadence} value={cadence}>
                            {MONITORING_CADENCE_LABEL[cadence]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    Saving here changes the schedule immediately. Selecting manual only removes the
                    repeatable job.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── The rest of the program ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">The rest of the program</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <p className="text-table text-muted-foreground">
            These task kinds have cadence rules too. They are listed because a missing schedule is a
            state rather than a missing row — a kind that has never been configured appears here
            with its defaults.
          </p>
          <DataTable
            caption="Cadence rules for the remaining task kinds"
            columns={[
              {
                key: 'taskKind',
                header: 'Task kind',
                accessor: (row) => CADENCE_TASK_KIND_LABEL[row.taskKind] ?? row.taskKind,
                sortable: true,
                render: (row) => (
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">
                      {CADENCE_TASK_KIND_LABEL[row.taskKind] ?? row.taskKind}
                    </div>
                    <div className="font-mono text-meta text-muted-foreground">{row.taskKind}</div>
                  </div>
                ),
              },
              {
                key: 'configured',
                header: 'Rule',
                accessor: (row) => (row.configured ? 'configured' : 'defaults'),
                width: 130,
                render: (row) => (
                  <StatusPill
                    label={row.configured ? 'Configured' : 'Defaults only'}
                    tone={row.configured ? 'info' : 'neutral'}
                  />
                ),
              },
              {
                key: 'frequency',
                header: 'Frequency',
                accessor: (row) => row.frequency,
                sortable: true,
                width: 150,
                render: (row) => (
                  <CadenceStatePill rule={row} />
                ),
              },
              {
                key: 'lastRunAt',
                header: 'Last run',
                accessor: (row) => row.lastRunAt,
                sortable: true,
                width: 200,
                emptyLabel: 'No run recorded',
                render: (row) => (row.lastRunAt ? <Timestamp value={row.lastRunAt} /> : null),
              },
              {
                key: 'lastError',
                header: 'Last result',
                render: (row) => <LastResultCell rule={row} />,
              },
              {
                key: 'nextRunAt',
                header: 'Next due',
                accessor: (row) => row.nextRunAt,
                sortable: true,
                width: 200,
                emptyLabel: 'Not scheduled',
                render: (row) => (row.nextRunAt ? <Timestamp value={row.nextRunAt} /> : null),
              },
              {
                key: 'run',
                header: '',
                width: 110,
                alwaysVisible: true,
                render: (row) =>
                  canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={runningKind === row.taskKind || isCadencePaused(row)}
                      title={
                        isCadencePaused(row)
                          ? 'A paused rule cannot be ticked. Unpause it first.'
                          : undefined
                      }
                      onClick={() => {
                        setOverridePrerequisites(false);
                        setConfirmingRun(row);
                      }}
                    >
                      Run now
                    </Button>
                  ) : null,
              },
            ]}
            rows={programRules}
            getRowId={(row) => row.taskKind}
            defaultSort={{ key: 'taskKind', direction: 'asc' }}
            emptyState={<EmptyState variant="no-results" />}
            minTableWidth="76rem"
          />
        </CardContent>
      </Card>

      {/* A tick is an explicit action; an unmet prerequisite is an explicit choice. */}
      <ConfirmDialog
        open={confirmingRun !== null}
        onOpenChange={(open) => {
          if (!open && runningKind === null) setConfirmingRun(null);
        }}
        title="Run this cadence now?"
        confirmLabel="Run now"
        targetLabel="Rule"
        target={
          confirmingRun
            ? `${CADENCE_TASK_KIND_LABEL[confirmingRun.taskKind] ?? confirmingRun.taskKind} (${confirmingRun.taskKind})`
            : ''
        }
        effect={
          <div className="space-y-2">
            <p>
              Starts a run of this task kind out of band, with the same rules as an automatic tick.
              It does not move the schedule: the next due time stays as it is.
            </p>
            <p>
              {confirmingRun?.prerequisites.length
                ? `This rule requires ${confirmingRun.prerequisites.join(', ')} to be ready. An unmet prerequisite skips the tick by design rather than failing it.`
                : 'This rule declares no prerequisites.'}
            </p>
          </div>
        }
        onConfirm={confirmRunNow}
        onConfirmed={() => setConfirmingRun(null)}
      >
        <div className="flex items-start gap-3">
          <Checkbox
            id="override-prerequisites"
            checked={overridePrerequisites}
            onCheckedChange={(checked) => setOverridePrerequisites(checked === true)}
          />
          <div className="space-y-1">
            <Label htmlFor="override-prerequisites">
              Run even if the prerequisites are not ready
            </Label>
            <p className="text-meta text-muted-foreground">
              Without this, a rule with an unmet prerequisite is refused so the unmet prerequisite
              cannot be missed. Choosing it records that you accepted the risk.
            </p>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}

/**
 * One program cadence: its state, its last result, its next due time, and — for
 * an operator allowed to change it — its schedule.
 */
function CadenceCard({
  title,
  taskKind,
  rule,
  projectId,
  canEdit,
  timeZone,
  onChanged,
  onRunNow,
  running,
  onError,
}: {
  title: string;
  taskKind: string;
  rule: CadenceRule | null;
  projectId: string;
  canEdit: boolean;
  timeZone?: string;
  onChanged: () => Promise<void>;
  onRunNow: (rule: CadenceRule) => void;
  running: boolean;
  onError: (error: ApiError | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [frequency, setFrequency] = useState<CadenceFrequency>('off');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [hour, setHour] = useState('3');
  const [timezone, setTimezone] = useState('UTC');
  const [paused, setPaused] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!rule || !editing) return;
    setFrequency((rule.frequency as CadenceFrequency) ?? 'off');
    setDayOfWeek(String(rule.dayOfWeek ?? 1));
    setDayOfMonth(String(rule.dayOfMonth ?? 1));
    setHour(String(rule.hour ?? 3));
    setTimezone(rule.timezone || 'UTC');
    setPaused(rule.pausedAt !== null);
  }, [rule, editing]);

  if (!rule) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">{title}</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <EmptyState
            variant="not-measured"
            subject={`the ${title.toLowerCase()} cadence`}
            prerequisite="The cadence list did not include this task kind"
            layout="inline"
          />
        </CardContent>
      </Card>
    );
  }

  async function save() {
    setSaving(true);
    onError(null);
    try {
      await putCadence(projectId, taskKind, {
        frequency,
        dayOfWeek: cadenceNeedsDayOfWeek(frequency) ? Number(dayOfWeek) : undefined,
        dayOfMonth: cadenceNeedsDayOfMonth(frequency) ? Number(dayOfMonth) : undefined,
        hour: Number(hour),
        timezone,
        paused,
      });
      await onChanged();
      setEditing(false);
    } catch (caught) {
      onError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  const pausedNow = isCadencePaused(rule);

  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle className="text-subsection">{title}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <CadenceStatePill rule={rule} />
          {rule.prerequisites.length > 0 ? (
            <span className="text-meta text-muted-foreground">
              Requires {rule.prerequisites.join(', ')}
            </span>
          ) : (
            <span className="text-meta text-muted-foreground">No prerequisites declared</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-2">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-table sm:grid-cols-4">
          <div>
            <dt className="text-meta text-muted-foreground">Schedule</dt>
            <dd className="mt-0.5">{describeSchedule(rule)}</dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Last run</dt>
            <dd className="mt-0.5">
              {rule.lastRunAt ? (
                <Timestamp value={rule.lastRunAt} timeZone={timeZone} />
              ) : (
                <span className="text-muted-foreground">No run recorded</span>
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-meta text-muted-foreground">Last result</dt>
            <dd className="mt-0.5">
              <LastResultCell rule={rule} />
            </dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Next due</dt>
            <dd className="mt-0.5">
              {rule.nextRunAt ? (
                <Timestamp value={rule.nextRunAt} timeZone={timeZone} />
              ) : (
                <span className="text-muted-foreground">
                  {pausedNow ? 'Paused — no next run' : 'Not scheduled'}
                </span>
              )}
            </dd>
          </div>
        </dl>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={running || pausedNow}
              title={pausedNow ? 'A paused rule cannot be ticked. Unpause it first.' : undefined}
              onClick={() => onRunNow(rule)}
            >
              {running ? 'Running…' : 'Run now'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={running}
              onClick={() => setEditing((current) => !current)}
            >
              {editing ? 'Close schedule editor' : 'Edit schedule'}
            </Button>
            {pausedNow ? (
              <span className="text-meta text-muted-foreground">
                A paused rule does not tick. Unpause it to let it run again.
              </span>
            ) : null}
          </div>
        ) : null}

        {canEdit && editing ? (
          <div className="space-y-4 rounded-md border border-border bg-surface-sunken p-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor={`${taskKind}-frequency`}>Frequency</Label>
                <Select
                  value={frequency}
                  onValueChange={(value) => setFrequency(value as CadenceFrequency)}
                >
                  <SelectTrigger id={`${taskKind}-frequency`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CADENCE_FREQUENCIES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {CADENCE_FREQUENCY_LABEL[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {cadenceNeedsDayOfWeek(frequency) ? (
                <div className="space-y-2">
                  <Label htmlFor={`${taskKind}-dow`}>Day of week</Label>
                  <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                    <SelectTrigger id={`${taskKind}-dow`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                        (day, index) => (
                          <SelectItem key={day} value={String(index)}>
                            {day}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-meta text-muted-foreground">
                    A weekly schedule needs the day it runs on.
                  </p>
                </div>
              ) : null}

              {cadenceNeedsDayOfMonth(frequency) ? (
                <div className="space-y-2">
                  <Label htmlFor={`${taskKind}-dom`}>Day of month</Label>
                  <Input
                    id={`${taskKind}-dom`}
                    type="number"
                    min={1}
                    max={31}
                    value={dayOfMonth}
                    onChange={(event) => setDayOfMonth(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    A month shorter than this day fires on its last day.
                  </p>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor={`${taskKind}-hour`}>Hour (0–23)</Label>
                <Input
                  id={`${taskKind}-hour`}
                  type="number"
                  min={0}
                  max={23}
                  value={hour}
                  onChange={(event) => setHour(event.target.value)}
                  disabled={frequency === 'off'}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${taskKind}-tz`}>Timezone</Label>
                <Input
                  id={`${taskKind}-tz`}
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  placeholder="Europe/London"
                  disabled={frequency === 'off'}
                />
                <p className="text-meta text-muted-foreground">
                  An IANA zone. The hour above is local to it.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id={`${taskKind}-paused`}
                checked={paused}
                onCheckedChange={(checked) => setPaused(checked === true)}
              />
              <div className="space-y-1">
                <Label htmlFor={`${taskKind}-paused`}>Pause this rule</Label>
                <p className="text-meta text-muted-foreground">
                  A pause keeps the schedule and stops the rule ticking. It never cancels a run
                  already in flight, and it is not a failure — the rule is simply not running.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save schedule'}
              </Button>
              <Button variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <span className="text-meta text-muted-foreground">
                Saving replaces this rule and recomputes its next due time in the timezone above.
              </span>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The rule's schedule in words. Nothing here is inferred from a null field. */
function describeSchedule(rule: CadenceRule): string {
  if (rule.frequency === 'off') return 'Manual only — never ticks on its own';
  const at = `${String(rule.hour).padStart(2, '0')}:00`;
  if (cadenceNeedsDayOfWeek(rule.frequency)) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = rule.dayOfWeek === null ? 'a day that was not recorded' : days[rule.dayOfWeek];
    return `${CADENCE_FREQUENCY_LABEL[rule.frequency as CadenceFrequency] ?? rule.frequency} on ${day} at ${at} (${rule.timezone})`;
  }
  if (cadenceNeedsDayOfMonth(rule.frequency)) {
    const day = rule.dayOfMonth === null ? 'a day that was not recorded' : `day ${rule.dayOfMonth}`;
    return `${CADENCE_FREQUENCY_LABEL[rule.frequency as CadenceFrequency] ?? rule.frequency} on ${day} at ${at} (${rule.timezone})`;
  }
  return `${CADENCE_FREQUENCY_LABEL[rule.frequency as CadenceFrequency] ?? rule.frequency} at ${at} (${rule.timezone})`;
}

/** Configured, paused, manual-only, or simply present with defaults. */
function CadenceStatePill({ rule }: { rule: CadenceRule }) {
  if (!rule.configured) {
    return <StatusPill label="Not configured — manual only" tone="neutral" />;
  }
  if (isCadencePaused(rule)) {
    return <StatusPill label="Paused" tone="neutral" />;
  }
  if (rule.frequency === 'off' || !rule.enabled) {
    return <StatusPill label="Manual only" tone="neutral" />;
  }
  return <StatusPill label={CADENCE_FREQUENCY_LABEL[rule.frequency as CadenceFrequency] ?? rule.frequency} tone="success" />;
}

/**
 * The last tick's result.
 *
 * The tone is chosen by what actually happened, not by whether `lastError` is
 * set: a skipped tick is the designed response to an unmet prerequisite, and
 * reporting it as an error every night is exactly what the cadence design
 * avoids.
 */
function LastResultCell({ rule }: { rule: CadenceRule }) {
  if (rule.lastStatus === null) {
    return (
      <span className="text-meta text-muted-foreground">This rule has not ticked yet.</span>
    );
  }
  if (isCadenceSkip(rule.lastStatus)) {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Skipped" tone="info" />
        <div className="text-meta text-muted-foreground">
          {rule.lastError ?? 'The rule skipped this tick.'} A skip is recorded rather than raised,
          so an unmet prerequisite does not fail every night.
        </div>
      </div>
    );
  }
  if (isCadenceNotStarted(rule.lastStatus)) {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Created, not started" tone="warning" />
        <div className="text-meta text-muted-foreground">
          {rule.lastError ??
            'A run was created for this tick but no worker picked it up.'}
        </div>
      </div>
    );
  }
  if (rule.lastStatus === 'duplicate') {
    return (
      <div className="space-y-0.5">
        <StatusPill label="Already ran for this slot" tone="neutral" />
        <div className="text-meta text-muted-foreground">
          {rule.lastError ?? 'A run already existed for this schedule slot.'}
        </div>
      </div>
    );
  }
  if (rule.lastError) {
    return (
      <div className="space-y-0.5">
        <StatusPill label={rule.lastStatus} tone="danger" />
        <div className="text-meta text-danger-foreground">{rule.lastError}</div>
      </div>
    );
  }
  return <StatusPill label={rule.lastStatus} tone="success" />;
}

function tickOutcomeTitle(outcome: TickOutcome): string {
  switch (outcome.outcome) {
    case 'started':
      return outcome.reason ? 'A run was created but not started' : 'The run was started';
    case 'duplicate':
      return 'A run already existed for this schedule slot';
    case 'skipped':
      return 'The tick was skipped';
    case 'not_due':
      return 'The rule is not due';
    case 'locked':
      return 'A run of this kind is already in flight';
    default:
      return 'The tick returned an outcome this page does not model';
  }
}

function tickOutcomeVariant(outcome: TickOutcome['outcome']): 'default' | 'destructive' | undefined {
  if (outcome === 'started' || outcome === 'not_due' || outcome === 'duplicate') return 'default';
  if (outcome === 'locked') return 'destructive';
  return undefined;
}

