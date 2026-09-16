'use client';

import { useEffect, useRef } from 'react';

export interface UsePollingOptions {
  /** Whether polling should run at all. Pass `false` for a terminal run
   *  state (`completed`/`failed`) or when the run isn't currently visible —
   *  the hook does nothing until this flips to `true`, and stops the moment
   *  it flips back to `false`. */
  active: boolean;
  onPoll: () => void | Promise<void>;
  /** Interval while the run is fresh. design_plan.md §10.3: "~5s". */
  fastIntervalMs?: number;
  /** Backed-off interval range once a run has been active for a while.
   *  §10.3: "backing off to 15-30s". A random value in this range is picked
   *  per tick so many open tabs don't all poll in lockstep. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Number of fast ticks before backing off. Default 6 (~30s at 5s/tick). */
  fastTicks?: number;
}

/**
 * Polls `onPoll` on the cadence design_plan.md §10.3 specifies for a
 * visible, active run: fast at first, backing off over time, paused
 * whenever the tab is hidden (`document.visibilitychange`), and reconciled
 * with one immediate call the moment the tab regains focus. Stops entirely
 * once `active` is false — a terminal run state must not keep polling.
 *
 * IMPORTANT — the 100 req/min/IP backend limit: this hook polls once per
 * mount. A portfolio/list screen showing N active runs must NOT mount one
 * `usePolling` per row; that fans out to N requests per tick. Instead, poll
 * a single aggregate endpoint (e.g. "active runs for this client") from one
 * call site — typically the list/portfolio container — and pass the
 * per-row status down as props. Reserve one `usePolling` call per mounted
 * single-run detail view.
 */
export function usePolling({
  active,
  onPoll,
  fastIntervalMs = 5000,
  backoffMinMs = 15000,
  backoffMaxMs = 30000,
  fastTicks = 6,
}: UsePollingOptions): void {
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let tickCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const nextDelay = () => {
      if (tickCount < fastTicks) return fastIntervalMs;
      return backoffMinMs + Math.random() * (backoffMaxMs - backoffMinMs);
    };

    const schedule = () => {
      if (cancelled || document.hidden) return;
      timer = setTimeout(async () => {
        if (cancelled) return;
        tickCount += 1;
        await onPollRef.current();
        schedule();
      }, nextDelay());
    };

    const handleVisibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      // Reconcile immediately on refocus, then resume the schedule.
      void onPollRef.current();
      if (!timer) schedule();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    if (!document.hidden) schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [active, fastIntervalMs, backoffMinMs, backoffMaxMs, fastTicks]);
}
