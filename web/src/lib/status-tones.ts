import type { StatusTone } from '@/components/patterns/StatusPill';
import type { ClientStatus, OnboardingStatus, ProjectStatus } from '@/services/types';

/**
 * One status → tone map for the whole app.
 *
 * `design_plan.md` §3.1 asks for "restrained pills for statuses", and §3.3
 * expects the same status to read the same way wherever it appears. Keeping
 * the mapping here means a screen cannot independently decide that `paused`
 * is amber on one page and gray on another.
 *
 * The judgment each mapping encodes is about **what the reader should do**, not
 * about severities of failure:
 *
 *  - `active` / `retainer` are steady states, so they are neutral rather than
 *    green. A green "active" every day trains people to stop reading it.
 *  - `paused` is amber because someone needs to decide whether to resume.
 *  - `churned` and `failed` are the two genuinely terminal bad states.
 *  - `pending` setup is neutral, not a warning: work simply has not started.
 */

export function clientStatusTone(status: ClientStatus | string): StatusTone {
  switch (status) {
    case 'active':
      return 'neutral';
    case 'paused':
      return 'warning';
    case 'churned':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function clientStatusLabel(status: ClientStatus | string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'churned':
      return 'Churned';
    default:
      return status;
  }
}

/** The engagement lifecycle — what the client has bought. */
export function projectStatusTone(status: ProjectStatus | string): StatusTone {
  switch (status) {
    case 'scorecard':
      return 'info';
    case 'diagnostic':
      return 'info';
    case 'sprint':
    case 'retainer':
      return 'neutral';
    case 'archived':
      return 'unmeasured';
    default:
      return 'neutral';
  }
}

export function projectStatusLabel(status: ProjectStatus | string): string {
  switch (status) {
    case 'scorecard':
      return 'Scorecard';
    case 'diagnostic':
      return 'Diagnostic';
    case 'sprint':
      return 'Sprint';
    case 'retainer':
      return 'Retainer';
    case 'archived':
      return 'Archived';
    default:
      return status;
  }
}

/**
 * Day-1 pipeline progress. Orthogonal to the engagement lifecycle above —
 * a retainer can still be running its setup pipeline.
 */
export function onboardingStatusTone(status: OnboardingStatus | string): StatusTone {
  switch (status) {
    case 'pending':
      return 'unmeasured';
    case 'running':
      return 'info';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'unmeasured';
  }
}

/**
 * Audit/research run states, for the technical, SEO and AI-visibility hubs.
 *
 * These live here rather than as a local `runTone` per screen because three
 * separate screens had already grown their own copy, and two of them had drifted
 * (`partial` toned `danger` on one, `warning` on another). A partial run is a
 * warning — real evidence came back, just not all of it — never a failure.
 *
 * Vocabulary is the union of what the audit routes return; unknown values fall
 * back to neutral rather than guessing.
 */
export function auditRunStatusTone(status: string): StatusTone {
  switch (status) {
    case 'completed':
    case 'complete':
    case 'succeeded':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
    case 'error':
      return 'danger';
    case 'running':
    case 'active':
      return 'info';
    // Queued and never-run are both "nothing has happened yet", which is not a
    // fault and not a result — the `unmeasured` token, same as a missing metric.
    case 'queued':
    case 'pending':
    case 'not_started':
      return 'unmeasured';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function auditRunStatusLabel(status: string): string {
  switch (status) {
    case 'not_started':
      return 'Not started';
    case 'in_progress':
      return 'In progress';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1).replace(/[_-]/g, ' ');
  }
}

/** Report editorial state (G05). */
export function reportStatusTone(status: string): StatusTone {
  switch (status) {
    case 'draft':
      return 'unmeasured';
    case 'in-review':
      return 'info';
    case 'approved':
      return 'success';
    case 'released':
      return 'success';
    case 'withdrawn':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function reportStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'in-review':
      return 'In review';
    case 'approved':
      return 'Approved';
    case 'released':
      return 'Released';
    case 'withdrawn':
      return 'Withdrawn';
    default:
      return status;
  }
}

/**
 * Cycle lifecycle (G06) — `planning → committed → active → review → closed`.
 * `planning` is neutral rather than a warning: a cycle with nothing committed
 * yet is a normal, expected state, not a problem to flag.
 */
export function cycleStatusTone(status: string): StatusTone {
  switch (status) {
    case 'planning':
      return 'unmeasured';
    case 'committed':
      return 'info';
    case 'active':
      return 'neutral';
    case 'review':
      return 'warning';
    case 'closed':
      return 'success';
    default:
      return 'neutral';
  }
}

export function cycleStatusLabel(status: string): string {
  switch (status) {
    case 'planning':
      return 'Planning';
    case 'committed':
      return 'Committed';
    case 'active':
      return 'Active';
    case 'review':
      return 'Review';
    case 'closed':
      return 'Closed';
    default:
      return status;
  }
}
