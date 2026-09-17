import { AlertTriangle, Clock, ListChecks, ShieldQuestion } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { StatusPill } from '@/components/patterns/StatusPill';
import { formatPercent, notMeasuredLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CoverageIssue, CoverageSummary } from '@/types';

export type CoveragePanelVariant = 'full' | 'compact';

export interface CoveragePanelProps {
  /** Expected vs successful checks plus the sources that did not complete. */
  summary: CoverageSummary;
  /**
   * `full` is the standalone §3.3 panel; `compact` is the same information
   * rendered as tight text for embedding in a `MetricTile` or a table row.
   * Both variants name every failed and deferred source with its reason —
   * compact is smaller, never less complete.
   */
  variant?: CoveragePanelVariant;
  /** Defaults to "Evidence coverage". */
  title?: string;
  /** Optional next-run action (§3.3), e.g. a link to the run configurator. */
  action?: React.ReactNode;
  /** Extra context for why sources failed or were deferred, shown above the
   *  lists — e.g. "Vendor outage 3 Sep; retried automatically." */
  contextNote?: React.ReactNode;
  className?: string;
}

// §4.3: "Evidence manifest → Sources and dates". The panel lists which sources
// answered and when; that is what its title now says.
const DEFAULT_TITLE = 'Sources and dates';

interface CoverageCounts {
  expected: number;
  successful: number;
  failed: CoverageIssue[];
  deferred: CoverageIssue[];
  /** successful / expected as 0–100, or `null` when no checks were agreed. */
  percent: number | null;
  /**
   * True when the summary claims every agreed check succeeded while also
   * naming a source that did not complete. That input cannot produce a clean
   * "100%" reading, so the panel says so instead of printing one.
   */
  contradictory: boolean;
}

/**
 * Normalises a `CoverageSummary` once, so every render path below works from
 * the same numbers and the same contradiction check.
 */
function readCounts(summary: CoverageSummary): CoverageCounts {
  const expected = Number.isFinite(summary.expectedCount) ? Math.max(0, summary.expectedCount) : 0;
  const successful = Number.isFinite(summary.successfulCount) ? Math.max(0, summary.successfulCount) : 0;
  const failed = summary.failed ?? [];
  const deferred = summary.deferred ?? [];
  const incomplete = failed.length + deferred.length;

  return {
    expected,
    successful,
    failed,
    deferred,
    percent: expected > 0 ? Math.min(100, (successful / expected) * 100) : null,
    contradictory: incomplete > 0 && (expected === 0 || successful >= expected),
  };
}

function issueListLabel(kind: 'failed' | 'deferred', count: number): string {
  const noun = `source${count === 1 ? '' : 's'}`;
  // §4.3: a status is described by what happened, not by the internal state
  // name. "failed" reads as a verdict about the client's data; "did not report"
  // describes the measurement.
  return kind === 'failed' ? `${count} ${noun} did not report` : `${count} ${noun} still to report`;
}

/**
 * §3.3 Coverage panel — expected versus successful checks, with every failed
 * and deferred source named alongside its reason.
 *
 * Contract: a run is never summarised as a clean percentage on its own. If a
 * source failed or was deferred, its name and reason are rendered here, and a
 * summary whose counts contradict its own issue list is flagged rather than
 * rounded up to "100%". §3.5 "Partial audit" also forbids labelling the whole
 * run healthy, which is why the panel distinguishes failed (a failure) from
 * deferred (accepted, not measured) instead of merging them.
 *
 * Server-renderable: the only optional interactivity is the `action` slot the
 * caller supplies, so screens can use this inside server components.
 */
export function CoveragePanel({
  summary,
  variant = 'full',
  title = DEFAULT_TITLE,
  action,
  contextNote,
  className,
}: CoveragePanelProps) {
  const counts = readCounts(summary);
  const { expected, successful, failed, deferred, percent, contradictory } = counts;
  const incompleteCount = failed.length + deferred.length;

  if (variant === 'compact') {
    return (
      <div className={cn('text-meta', className)}>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
          <ListChecks aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium text-foreground">{title}</span>
          {percent === null ? (
            // Never "0%" — no checks were agreed, so coverage is unmeasured.
            <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
          ) : (
            <>
              <span>
                {successful} of {expected} checks
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatPercent(percent)}</span>
            </>
          )}
          {failed.length > 0 ? <StatusPill label={issueListLabel('failed', failed.length)} tone="danger" /> : null}
          {deferred.length > 0 ? (
            <StatusPill label={issueListLabel('deferred', deferred.length)} tone="warning" />
          ) : null}
        </p>

        {contextNote ? <div className="mt-1 text-unmeasured-foreground">{contextNote}</div> : null}

        {contradictory ? <ContradictionNote counts={counts} /> : null}

        {incompleteCount > 0 ? (
          <div className="mt-1.5 space-y-1.5">
            {failed.length > 0 ? <IssueList kind="failed" issues={failed} /> : null}
            {deferred.length > 0 ? <IssueList kind="deferred" issues={deferred} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  const topStatus = contradictory
    ? { label: 'Counts need review', tone: 'warning' as const }
    : failed.length > 0
      ? { label: 'Partial coverage', tone: 'warning' as const }
      : deferred.length > 0
        ? { label: 'Complete, with deferrals', tone: 'info' as const }
        : expected === 0
          ? { label: 'Not measured', tone: 'unmeasured' as const }
          : { label: 'All agreed checks complete', tone: 'success' as const };

  const headline =
    expected === 0
      ? 'No checks were agreed for this measurement, so coverage cannot be reported as a percentage.'
      : `${successful} of ${expected} agreed ${expected === 1 ? 'check' : 'checks'} returned evidence.`;

  return (
    <section
      aria-label={title}
      className={cn('rounded-lg border border-border bg-surface p-4', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-body font-semibold text-foreground">
            <ListChecks aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            {title}
          </h3>
          <p className="mt-1 text-table text-muted-foreground">{headline}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={topStatus.label} tone={topStatus.tone} />
          {action}
        </div>
      </div>

      {percent === null ? (
        <p className="mt-3 text-table text-unmeasured-foreground">{notMeasuredLabel()}</p>
      ) : (
        <div className="mt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span
              className={cn(
                'text-subsection font-semibold',
                contradictory || failed.length > 0 ? 'text-warning-foreground' : 'text-foreground',
              )}
            >
              {formatPercent(percent)}
            </span>
            <span className="text-meta text-muted-foreground">
              {successful} of {expected} checks
            </span>
          </div>
          <Progress
            className="mt-1.5 h-2"
            value={percent}
            aria-label={`Coverage: ${successful} of ${expected} agreed checks returned evidence`}
          />
        </div>
      )}

      {contextNote ? <div className="mt-3 text-table text-muted-foreground">{contextNote}</div> : null}

      {contradictory ? <ContradictionNote counts={counts} /> : null}

      {incompleteCount > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {failed.length > 0 ? <IssueList kind="failed" issues={failed} /> : null}
          {deferred.length > 0 ? <IssueList kind="deferred" issues={deferred} /> : null}
        </div>
      ) : expected > 0 ? (
        <p className="mt-3 text-table text-muted-foreground">
          No failed or deferred sources were reported.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The §3.3 requirement is "failed/deferred sources and why", so each row is
 * name *and* reason — never a count on its own.
 */
function IssueList({ kind, issues }: { kind: 'failed' | 'deferred'; issues: CoverageIssue[] }) {
  const isFailed = kind === 'failed';
  const Icon = isFailed ? AlertTriangle : Clock;
  const heading = isFailed
    ? 'Sources that did not report'
    : 'Sources still to report (agreed, not measured yet)';

  return (
    <div>
      <h4
        className={cn(
          'flex items-center gap-1.5 text-meta font-semibold',
          isFailed ? 'text-danger-foreground' : 'text-warning-foreground',
        )}
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {heading}
      </h4>
      <ul className="mt-1.5 space-y-1">
        {issues.map((issue) => (
          <li key={`${kind}-${issue.name}`} className="flex gap-2 text-table">
            <span
              aria-hidden="true"
              className={cn(
                'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                isFailed ? 'bg-danger' : 'bg-warning',
              )}
            />
            <span className="min-w-0">
              <span className="font-medium text-foreground">{issue.name}</span>
              <span className="text-muted-foreground"> — {issue.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Rendered when the summary reports success for every agreed check while also
 * naming sources that did not complete. Printing the percentage alone here
 * would hide a failed source, which §3.3 forbids, so the panel states the
 * conflict and tells the reader what to do about it.
 */
function ContradictionNote({ counts }: { counts: CoverageCounts }) {
  const named = [...counts.failed, ...counts.deferred].map((issue) => issue.name).join(', ');
  return (
    <div className="mt-3 flex gap-2 rounded-md border border-warning/40 bg-warning-subtle p-2.5 text-table text-warning-foreground">
      <ShieldQuestion aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        This measurement reports{' '}
        <strong className="font-semibold">all agreed checks successful</strong> but also names {named} as
        not completed. Treat the coverage figure above as incomplete until this measurement&rsquo;s own
        counts are reconciled.
      </p>
    </div>
  );
}
