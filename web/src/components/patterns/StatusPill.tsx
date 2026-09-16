import { cn } from '@/lib/utils';
import type { ApprovalDecision, RunStatus, WorkStatus } from '@/types';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'unmeasured' | 'neutral';

const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-success-subtle text-success-foreground',
  warning: 'bg-warning-subtle text-warning-foreground',
  danger: 'bg-danger-subtle text-danger-foreground',
  info: 'bg-info-subtle text-info-foreground',
  unmeasured: 'bg-unmeasured-subtle text-unmeasured-foreground',
  neutral: 'bg-surface-sunken text-muted-foreground',
};

export interface StatusPillProps {
  label: string;
  tone: StatusTone;
  className?: string;
}

/** A restrained status pill (§3.1: "restrained pills for statuses"). Screens
 *  should reach for `runStatusTone`/`workStatusTone`/`approvalDecisionTone`
 *  below rather than choosing a tone ad hoc, so the same status always reads
 *  the same color across the app. */
export function StatusPill({ label, tone, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-meta font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

export function runStatusTone(status: RunStatus): StatusTone {
  switch (status) {
    case 'queued':
      return 'neutral';
    case 'running':
      return 'info';
    case 'partial':
      return 'warning';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'cancelled':
      // Neutral, not danger: someone chose to stop this run. Colouring it as a
      // fault would make a deliberate action look like a failure.
      return 'neutral';
  }
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  partial: 'Partial',
  completed: 'Completed',
  failed: 'Failed',
  // A stopped run is reported as cancelled, not failed: design_plan §10.4
  // requires it to be distinguishable from a fault.
  cancelled: 'Cancelled',
};

export function workStatusTone(status: WorkStatus): StatusTone {
  switch (status) {
    case 'not-started':
      return 'neutral';
    case 'in-progress':
      return 'info';
    case 'blocked':
      return 'danger';
    case 'in-review':
      return 'warning';
    case 'done':
      return 'success';
  }
}

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  'in-review': 'In review',
  done: 'Done',
};

export function approvalDecisionTone(decision: ApprovalDecision): StatusTone {
  switch (decision) {
    case 'pending':
      return 'warning';
    case 'approved':
      return 'success';
    case 'changes-requested':
      return 'info';
    case 'rejected':
      return 'danger';
  }
}

export const APPROVAL_DECISION_LABEL: Record<ApprovalDecision, string> = {
  pending: 'Decision pending',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  rejected: 'Rejected',
};
