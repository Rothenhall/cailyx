'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Ban, CheckCircle2, CircleAlert, Clock, Loader2, XCircle } from 'lucide-react';
import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { RunStatus, RunSummary } from '@/types';
import {
  RUN_STATUS_LABEL,
  StatusPill,
  runStatusTone,
} from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';

/**
 * §3.3 RunStatusStrip — queued / running / partial / completed / failed, with
 * the named stage, counts *when the backend supplied them*, and the previous
 * run's results still readable underneath.
 *
 * Three rules from the plan are load-bearing here and are enforced in the code
 * rather than left to call sites:
 *
 *  1. **No simulated progress.** §3.4 forbids progress animation that implies
 *     measured completion, so no indeterminate bar is ever drawn. The bar below
 *     is determinate and only appears when `RunStage.counts` exists — the type
 *     note on `RunStage` says counts are optional for exactly this reason.
 *  2. **A partial run never reads healthy.** The strip labels it "not a
 *     complete run" and keeps the failed/deferred detail visible instead of
 *     collapsing to a green tick.
 *  3. **The last successful data stays readable.** While a run is queued,
 *     running or failed, whatever `children` holds is presented as the last
 *     successful run's results — explicitly attributed, never passed off as the
 *     new run's output.
 */

/** The previous successful run, cited when the current run has produced
 *  nothing yet. */
export interface LastSuccessfulRun {
  id: string;
  /** ISO 8601 completion instant. */
  completedAt: string;
  /** Optional friendly label, e.g. "September visibility report". */
  label?: string;
  /** Link to that run's results. */
  href?: string;
}

export interface RunStatusStripProps {
  run: RunSummary;
  /** The last run that actually completed successfully. Pass it whenever the
   *  current run is in flight so the strip can attribute the results below. */
  lastSuccessful?: LastSuccessfulRun;
  /** Failed or deferred checks for a partial run, plus anything else that must
   *  stay visible. §3.5: "Display successful evidence plus failed/deferred
   *  checks; never label the whole run healthy." */
  detail?: ReactNode;
  /** The results themselves — the last successful run's data while a new run
   *  is in flight. */
  children?: ReactNode;
  /** A run that overruns this many minutes adds the §3.5 "taking longer than
   *  expected" note. Omit to say nothing about duration. */
  expectedMinutes?: number;
  /** IANA zone for every timestamp on the strip (e.g. the engagement zone). */
  timeZone?: string;
  className?: string;
}

const STATUS_ICON: Record<RunStatus, typeof Clock> = {
  queued: Clock,
  running: Loader2,
  partial: CircleAlert,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
};

const STATUS_ICON_CLASS: Record<RunStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-info',
  partial: 'text-warning',
  completed: 'text-success',
  failed: 'text-danger',
  // Muted: a stopped run is a fact to record, not an alarm to raise.
  cancelled: 'text-muted-foreground',
};

/** Statuses where a run has produced no new results yet, so the previous
 *  successful run is what the reader is looking at. `partial` is deliberately
 *  absent: a partial run *has* produced evidence of its own. `cancelled` is
 *  included because a stopped run usually produced nothing worth reading, so
 *  the previous successful run remains the thing being displayed. */
const IN_FLIGHT: readonly RunStatus[] = ['queued', 'running', 'failed', 'cancelled'];

/**
 * The status strip for one run. Renders the status, the named stage (only if
 * the server named one), counts only if the server supplied them, and the
 * results below with an explicit note about which run they came from.
 */
export function RunStatusStrip({
  run,
  lastSuccessful,
  detail,
  children,
  expectedMinutes,
  timeZone,
  className,
}: RunStatusStripProps) {
  const Icon = STATUS_ICON[run.status];
  const inFlight = IN_FLIGHT.includes(run.status);
  const counts = run.stage?.counts;
  const percentComplete =
    counts && counts.total > 0
      ? Math.min(100, Math.max(0, (counts.completed / counts.total) * 100))
      : undefined;

  // A live clock is only needed for the "longer than expected" note. It starts
  // undefined so the server and first client render agree, then ticks slowly:
  // this is a duration hint, not a progress meter, so 30s granularity is
  // plenty and it cannot be mistaken for a polling indicator.
  const [now, setNow] = useState<number>();
  const watchDuration = inFlight && expectedMinutes !== undefined;
  useEffect(() => {
    if (!watchDuration) {
      setNow(undefined);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [watchDuration, run.id]);

  const overrun = useMemo(() => {
    if (!watchDuration || now === undefined || expectedMinutes === undefined) return false;
    const startedAt = new Date(run.startedAt).getTime();
    if (Number.isNaN(startedAt)) return false;
    return now - startedAt > expectedMinutes * 60_000;
  }, [watchDuration, now, expectedMinutes, run.startedAt]);

  // §3.4: announce state changes, not every polling tick. Only the status and
  // the stage name go in the live region — never the counts, which change on
  // each poll and would turn the strip into a screen-reader metronome.
  const announcement = `Run ${RUN_STATUS_LABEL[run.status].toLowerCase()}${
    run.stage ? `. Stage: ${run.stage.name}` : ''
  }.`;

  return (
    <section
      aria-label="Run status"
      className={cn(
        'rounded-lg border border-border bg-surface p-4',
        // A partial or failed run carries its own tint so it cannot read as
        // healthy at a glance.
        run.status === 'partial' && 'border-warning/30 bg-warning-subtle',
        run.status === 'failed' && 'border-danger/30 bg-danger-subtle',
        className,
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Icon
            aria-hidden="true"
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              STATUS_ICON_CLASS[run.status],
              // motion-safe only: §3.4 requires honoring reduced-motion, and a
              // spinner is activity, not measured progress.
              run.status === 'running' && 'motion-safe:animate-spin',
            )}
          />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label={RUN_STATUS_LABEL[run.status]} tone={runStatusTone(run.status)} />
              {run.stage && (
                <span className="text-table text-foreground">
                  <span className="text-muted-foreground">Stage:</span> {run.stage.name}
                </span>
              )}
              {!run.stage && run.status === 'queued' && (
                <span className="text-table text-muted-foreground">Waiting to start</span>
              )}
            </div>

            {/* Counts only when the server sent them. Absent counts mean
                "unknown", which is rendered as silence — never as 0%. */}
            {counts && (
              <p className="text-table text-foreground">
                {formatNumber(counts.completed)} of {formatNumber(counts.total)}
                <span className="text-muted-foreground">
                  {' '}
                  ({formatPercent(percentComplete ?? 0)} of this stage)
                </span>
              </p>
            )}
            {counts && percentComplete !== undefined && (
              <div aria-hidden="true" className="h-1 w-full max-w-xs rounded-full bg-surface-sunken">
                <div
                  className="h-1 rounded-full bg-info"
                  style={{ width: `${percentComplete}%` }}
                />
              </div>
            )}

            <p className="text-meta text-muted-foreground">
              Started <Timestamp value={run.startedAt} timeZone={timeZone} />
              {run.completedAt && (
                <>
                  {' · '}
                  Finished <Timestamp value={run.completedAt} timeZone={timeZone} />
                </>
              )}
            </p>
          </div>
        </div>

        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>

      {run.status === 'partial' && (
        <p className="mt-3 text-table text-warning-foreground">
          This run did not complete in full. Successful evidence is shown together with the checks
          that failed or were deferred — treat the run as incomplete, not as a healthy result.
        </p>
      )}

      {overrun && (
        <p className="mt-3 text-table text-foreground">
          This run is taking longer than expected. It is safe to leave this page and come back —
          Cailyx will not start a second run for you, and the last known state stays visible here.
        </p>
      )}

      {detail && <div className="mt-3 space-y-2 text-table">{detail}</div>}

      {children && (
        <div className={cn('space-y-3', inFlight && lastSuccessful && 'mt-4')}>
          {showingPreviousResults(inFlight, lastSuccessful) && lastSuccessful && (
            <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-meta text-muted-foreground">
              {run.status === 'failed'
                ? 'This run failed, so nothing here has been replaced.'
                : 'This run has not produced results yet.'}{' '}
              Everything below is from the last successful run
              {lastSuccessful.label ? ` — ${lastSuccessful.label}` : ''} (run{' '}
              <span className="font-mono">{lastSuccessful.id}</span>, finished{' '}
              <Timestamp value={lastSuccessful.completedAt} timeZone={timeZone} />
              {lastSuccessful.href && (
                <>
                  {' · '}
                  <Link
                    href={lastSuccessful.href}
                    className="text-primary underline underline-offset-4"
                  >
                    Open that run
                  </Link>
                </>
              )}
              ).
            </p>
          )}
          <div
            aria-label={
              showingPreviousResults(inFlight, lastSuccessful) && lastSuccessful
                ? `Results from the last successful run (${lastSuccessful.id})`
                : 'Results from this run'
            }
            role="region"
          >
            {children}
          </div>
        </div>
      )}
    </section>
  );
}

/** True when the results on screen belong to a previous run. `partial` is
 *  excluded on purpose: a partial run's own evidence is what is displayed. */
function showingPreviousResults(
  inFlight: boolean,
  lastSuccessful: LastSuccessfulRun | undefined,
): boolean {
  return inFlight && Boolean(lastSuccessful);
}
