'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, CircleAlert, CircleSlash, CircleHelp, MinusCircle } from 'lucide-react';
import type { ApiError } from '@/lib/api';
import { formatCredits, formatCurrency, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { RunEstimate, RunParameter, RunPrerequisite } from '@/types';
import { Button } from '@/components/ui/button';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { Timestamp } from '@/components/patterns/Timestamp';

/**
 * §3.3 RunConfigurator — prerequisites, parameters, observed configuration
 * availability, estimated requests/cost, and an explicit start action.
 *
 * §10.4's "scan/generation" row is the acceptance criteria this file exists to
 * satisfy: *prerequisites, scope/cost, explicit start, double-submit protection,
 * timeout reconciliation.* Each maps to something concrete below:
 *
 *  - **prerequisites / scope / cost** are all rendered before the button, and
 *    an unmet blocking prerequisite disables start *with the reason named*;
 *  - **explicit start** is a labelled button that names the mutation, never a
 *    side effect of submitting a form or visiting a screen;
 *  - **double-submit protection** is a ref guard plus a disabled button, and it
 *    outlives the request: after a start is accepted the control stays disabled
 *    rather than inviting a duplicate paid run;
 *  - **timeout reconciliation** means a lost response never triggers a silent
 *    retry. The form says the outcome is unknown and offers to check the run
 *    status instead (§10.3: "Never blindly retry paid generation").
 *
 * `RunEstimate` keeps `costCredits` and `costCurrency` as separate rows for the
 * same reason `lib/format.ts` keeps them as separate formatters: credits are not
 * money, and a total that adds them is a lie.
 */

/** §3.5's connection states, as distinct cases rather than one boolean. */
export type ConfigAvailability =
  /** Connected and verified by a successful run. */
  | 'available'
  /** Connected but never exercised — §3.5: "Configured; last successful run
   *  unknown". Never renders as a green tick. */
  | 'unverified'
  /** Connected, but no resource chosen for this project — §3.5: "Choose the
   *  site/property for this project". */
  | 'unmapped'
  /** Not configured at all. */
  | 'unavailable';

export interface ObservedConfiguration {
  label: string;
  availability: ConfigAvailability;
  /** Server-supplied detail, shown verbatim. */
  detail?: string;
  /** ISO 8601 — the last successful run against this resource, if known. */
  lastSuccessfulRunAt?: string;
  /** Where to resolve an unmapped/unavailable configuration. */
  actionLabel?: string;
  actionHref?: string;
}

/**
 * A `RunPrerequisite` plus the one fact this component needs that the shared
 * type does not carry. `RunPrerequisite` in `@/types` is deliberately minimal;
 * this extends it locally rather than editing the shared vocabulary.
 */
export interface ConfiguratorPrerequisite extends RunPrerequisite {
  /** Whether an unmet prerequisite blocks the start action. Defaults to
   *  `true`; set `false` for an advisory precondition worth stating but not
   *  worth blocking on. */
  blocking?: boolean;
}

/**
 * Renders a `RunEstimate` as separate, clearly-labelled lines: requests,
 * credits, and money in its own currency. There is no combined total, because
 * there is no unit that could express one.
 *
 * Exported so `ConfirmDialog` shows the same cost the same way — the rule that
 * credits are never currency should not be re-implemented per component.
 */
export function RunEstimateSummary({
  estimate,
  className,
}: {
  estimate?: RunEstimate;
  className?: string;
}) {
  if (!estimate) {
    return (
      <p className={cn('text-table text-muted-foreground', className)}>
        The server did not return an estimate for this configuration, so no cost can be shown before
        you start.
      </p>
    );
  }

  const hasAnything =
    estimate.requests !== undefined ||
    estimate.costCredits !== undefined ||
    estimate.costCurrency !== undefined;

  if (!hasAnything) {
    return (
      <p className={cn('text-table text-muted-foreground', className)}>
        The server did not return an estimate for this configuration, so no cost can be shown before
        you start.
      </p>
    );
  }

  return (
    <dl className={cn('grid gap-1 text-table', className)}>
      {estimate.requests !== undefined && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Estimated requests</dt>
          <dd className="font-medium text-foreground">
            {formatNumber(estimate.requests)} requests
          </dd>
        </div>
      )}

      {/* Credits. Never rendered with a currency symbol (lib/format.ts). */}
      {estimate.costCredits !== undefined && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Estimated cost in credits</dt>
          <dd className="font-medium text-foreground">{formatCredits(estimate.costCredits)}</dd>
        </div>
      )}

      {/* Money. A separate row from credits, always with its own currency. */}
      {estimate.costCurrency !== undefined && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Estimated vendor cost</dt>
          <dd className="font-medium text-foreground">
            {estimate.currencyCode
              ? formatCurrency(estimate.costCurrency, estimate.currencyCode)
              : // No currency code means no honest way to format the amount:
                // defaulting to USD would misreport another client's currency.
                `${formatNumber(estimate.costCurrency)} (currency not supplied)`}
          </dd>
        </div>
      )}
    </dl>
  );
}

export interface RunConfiguratorProps {
  /** Names the mutation in the button — "Start SEO audit", not "Start". */
  startLabel: string;
  prerequisites: ConfiguratorPrerequisite[];
  /** The parameters this run will use. Read-only here: configuration is an
   *  onboarding concern, and an editable field would need its own save story. */
  parameters?: RunParameter[];
  /** What the run will actually cover (sites, pages, date window). §10.4
   *  requires scope to be visible before a scan starts. */
  scope?: ReactNode;
  configuration?: ObservedConfiguration[];
  estimate?: RunEstimate;
  /** Issues the start request. Rejections are shown verbatim; a rejection does
   *  not re-enable the button into a retry loop. */
  onStart: () => void | Promise<void>;
  /**
   * Optional confirmation gate, run on the start click **before** any state
   * changes. Resolve `true` to proceed; resolve `false` (or reject) to abort —
   * nothing is sent, the control returns to idle, and no "accepted" claim is
   * made. §8.2's "Update AI results" needs the operator to be shown what will
   * be checked and what it is allowed to cost *between* the click and the
   * spend; a screen can do that by opening its own dialog from here.
   */
  beforeStart?: () => Promise<boolean>;
  /** Called after the server accepted the start, so the screen can navigate to
   *  the run. */
  onStarted?: () => void;
  /** Milliseconds to wait for `onStart` before treating the response as lost.
   *  Defaults to 60 000. */
  startTimeoutMs?: number;
  /** Offered after a lost response, so the operator can reconcile stored
   *  history rather than start a duplicate run. */
  onReconcile?: () => void;
  reconcileHref?: string;
  /** A start failure, rendered verbatim in place. */
  error?: ApiError | null;
  /** True when the server already reports a run for this configuration —
   *  §10.3: the durable job ledger is server state, not component memory. */
  runInFlight?: boolean;
  /** IANA zone for configuration timestamps. */
  timeZone?: string;
  className?: string;
}

type StartState = 'idle' | 'starting' | 'accepted' | 'lost';

const AVAILABILITY_CONFIG: Record<
  ConfigAvailability,
  { icon: typeof Check; label: string; className: string }
> = {
  available: { icon: Check, label: 'Available', className: 'text-success' },
  // Never a tick: connected is not the same as proven working (§3.5).
  unverified: {
    icon: CircleHelp,
    label: 'Configured; last successful run unknown',
    className: 'text-warning',
  },
  unmapped: { icon: CircleAlert, label: 'No resource chosen', className: 'text-warning' },
  unavailable: { icon: CircleSlash, label: 'Not configured', className: 'text-muted-foreground' },
};

/**
 * The run configuration form: what is required, what will happen, what it will
 * cost, and one explicit button that starts it.
 *
 * Start is disabled while any *blocking* prerequisite is unmet, and the
 * blocking ones are named next to the button — a disabled control with no
 * stated reason is not an acceptable answer to "why can't I start this?".
 */
export function RunConfigurator({
  startLabel,
  prerequisites,
  parameters,
  scope,
  configuration,
  estimate,
  onStart,
  beforeStart,
  onStarted,
  startTimeoutMs = 60_000,
  onReconcile,
  reconcileHref,
  error,
  runInFlight = false,
  timeZone,
  className,
}: RunConfiguratorProps) {
  const [startState, setStartState] = useState<StartState>('idle');
  const [startError, setStartError] = useState<ApiError | null>(null);
  // A ref, not state: two clicks in the same tick must not both pass the guard.
  const inFlightRef = useRef(false);

  // Blocking prerequisites keep their original index so the "why can't I
  // start?" message can link to the row that explains it (§3.4).
  const blockers = prerequisites
    .map((prerequisite, index) => ({ prerequisite, index }))
    .filter(({ prerequisite }) => !prerequisite.met && prerequisite.blocking !== false);
  const blocked = blockers.length > 0;
  const busy = startState === 'starting';
  const activeError = startError ?? error ?? null;
  const startDisabled =
    blocked || busy || runInFlight || startState === 'accepted' || startState === 'lost';

  const handleStart = useCallback(async () => {
    if (inFlightRef.current || blocked || runInFlight) return;
    // The guard is taken before the confirmation opens, so a second click while
    // the dialog is up cannot open a second one or start twice.
    inFlightRef.current = true;

    if (beforeStart) {
      let proceed = false;
      try {
        proceed = await beforeStart();
      } catch {
        proceed = false;
      }
      // A declined confirmation leaves the control exactly as it was: idle, no
      // request sent, and no "accepted" state that would claim otherwise.
      if (!proceed) {
        inFlightRef.current = false;
        return;
      }
    }

    setStartError(null);
    setStartState('starting');

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // The request may still be running server-side. We deliberately do not
      // retry: §10.3 forbids blindly retrying paid generation.
      setStartState('lost');
    }, startTimeoutMs);

    try {
      await onStart();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        setStartState('accepted');
        onStarted?.();
      }
    } catch (cause) {
      // A cancelled request is a deliberate navigation, not a failure to show.
      const aborted = cause instanceof DOMException && cause.name === 'AbortError';
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        setStartState('idle');
        if (!aborted) setStartError(toApiError(cause));
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [beforeStart, blocked, onStart, onStarted, runInFlight, startTimeoutMs]);

  return (
    <div className={cn('space-y-5 rounded-lg border border-border bg-surface p-5', className)}>
      <div className="space-y-3">
        <h3 className="text-subsection font-semibold text-foreground">Prerequisites</h3>
        {prerequisites.length === 0 ? (
          <p className="text-table text-muted-foreground">This run has no prerequisites.</p>
        ) : (
          <ul className="space-y-2">
            {prerequisites.map((prerequisite, index) => (
              <li
                key={`${prerequisite.label}-${index}`}
                id={`prerequisite-${index}`}
                className="flex items-start gap-2 text-table"
              >
                {prerequisite.met ? (
                  <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <MinusCircle
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      prerequisite.blocking === false
                        ? 'text-unmeasured'
                        : 'text-danger',
                    )}
                  />
                )}
                <span className="min-w-0">
                  <span className="text-foreground">{prerequisite.label}</span>
                  {!prerequisite.met && prerequisite.blocking === false && (
                    <span className="text-muted-foreground"> (advisory)</span>
                  )}
                  {/* §3.4: required/outstanding state is textual, not color-only. */}
                  <span className="text-muted-foreground">
                    {' — '}
                    {prerequisite.met ? 'met' : 'not met'}
                  </span>
                  {prerequisite.detail && (
                    <span className="block text-muted-foreground">{prerequisite.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {scope && (
        <div className="space-y-3">
          <h3 className="text-subsection font-semibold text-foreground">Scope</h3>
          <div className="text-table text-foreground">{scope}</div>
        </div>
      )}

      {parameters && parameters.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-subsection font-semibold text-foreground">Parameters</h3>
          <dl className="grid gap-1 text-table sm:grid-cols-2">
            {parameters.map((parameter) => (
              <div key={parameter.key} className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                <dt className="text-muted-foreground">{parameter.label}</dt>
                <dd className="truncate font-medium text-foreground" title={parameter.value}>
                  {parameter.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {configuration && configuration.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-subsection font-semibold text-foreground">
            Observed configuration
          </h3>
          <ul className="space-y-2">
            {configuration.map((entry) => {
              const config = AVAILABILITY_CONFIG[entry.availability];
              const Icon = config.icon;
              return (
                <li key={entry.label} className="flex items-start gap-2 text-table">
                  <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0', config.className)} />
                  <span className="min-w-0">
                    <span className="text-foreground">{entry.label}</span>
                    <span className="text-muted-foreground"> — {entry.detail ?? config.label}</span>
                    {entry.lastSuccessfulRunAt && (
                      <span className="block text-meta text-muted-foreground">
                        Last successful run{' '}
                        <Timestamp value={entry.lastSuccessfulRunAt} timeZone={timeZone} />
                      </span>
                    )}
                    {entry.actionHref && (
                      <span className="block">
                        <Link
                          href={entry.actionHref}
                          className="text-meta text-primary underline underline-offset-4"
                        >
                          {entry.actionLabel ?? 'Resolve'}
                        </Link>
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-subsection font-semibold text-foreground">
          Estimated requests and cost
        </h3>
        <RunEstimateSummary estimate={estimate} />
      </div>

      {/* A start failure from the caller (e.g. the configuration became invalid
          after a refetch) and a failure this component caught are shown the
          same way; the caught one wins so the most recent outcome is on top. */}
      {activeError && <ErrorState error={activeError} layout="inline" />}

      {blocked && (
        <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-table text-danger-foreground">
          {startLabel} is unavailable until these are resolved:{' '}
          {blockers.map(({ prerequisite, index }, position) => (
            <span key={prerequisite.label}>
              {position > 0 && ', '}
              <a href={`#prerequisite-${index}`} className="underline underline-offset-4">
                {prerequisite.label}
              </a>
            </span>
          ))}
          .
        </p>
      )}

      {runInFlight && startState === 'idle' && (
        <p className="text-table text-foreground">
          A run is already in progress for this configuration. Cailyx will not start a second one
          from here.
        </p>
      )}

      {startState === 'accepted' && (
        <p className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-table text-info-foreground">
          Start request accepted. Progress is shown in the run status — this form will not start a
          second run.
        </p>
      )}

      {startState === 'lost' && (
        <div className="space-y-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-table text-warning-foreground">
          <p>
            No response came back within {Math.round(startTimeoutMs / 1000)} seconds. The run may
            have started anyway, so Cailyx will not start another one automatically.
          </p>
          <div className="flex flex-wrap gap-2">
            {reconcileHref && (
              <Button asChild variant="outline" size="sm">
                <Link href={reconcileHref}>Check run status</Link>
              </Button>
            )}
            {onReconcile && (
              <Button type="button" variant="outline" size="sm" onClick={onReconcile}>
                Check run status
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                // Two deliberate steps back to a start: this only re-enables
                // the button; the operator still has to press it again after
                // confirming nothing is running.
                setStartState('idle');
              }}
            >
              I checked — allow starting again
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button
          type="button"
          onClick={() => void handleStart()}
          disabled={startDisabled}
          aria-busy={busy}
        >
          {busy ? `${startLabel}…` : startLabel}
        </Button>
        <span className="text-meta text-muted-foreground">
          {busy
            ? 'Sending the start request. Do not submit this again.'
            : 'This starts a real run and may consume credits.'}
        </span>
      </div>
    </div>
  );
}
