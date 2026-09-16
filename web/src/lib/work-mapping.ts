import type { WorkItem as WorkListViewItem } from '@/types';
import type { WorkRow as WorkRowDto } from '@/services/operations';

/**
 * Maps the backend's work-item vocabulary onto the §3.3 view model.
 *
 * Two vocabularies exist and they are deliberately different sizes:
 *
 *   backend  backlog | committed | active | review | blocked | verified | cancelled
 *   view     not-started | in-progress | blocked | in-review | done
 *
 * The view model is the one an operator reads, so several backend states
 * collapse into one label — but only where the distinction does not change
 * what the reader should do. `verified` and `committed` both mean "this is
 * settled", so both read as `done`; `backlog` and `committed` differ in the
 * *workflow*, not in whether anyone has started, so both read as `not-started`.
 *
 * The mapping lives here rather than in a screen so all work lists agree, and
 * so the collapsed cases are visible in one place to anyone auditing them.
 */

export function toViewWorkStatus(status: string): WorkListViewItem['status'] {
  switch (status) {
    case 'active':
      return 'in-progress';
    case 'review':
      return 'in-review';
    case 'blocked':
      return 'blocked';
    case 'verified':
      return 'done';
    // `cancelled` is deliberately not mapped to `done`: cancelled work was not
    // delivered, and showing it as completed would overstate what shipped.
    // It reads as not-started so it never inflates a completion count.
    case 'cancelled':
    case 'backlog':
    case 'committed':
    default:
      return 'not-started';
  }
}

/**
 * Converts an operations `WorkRowDto` into the §3.3 `WorkItem` the `WorkList`
 * pattern renders.
 *
 * `evidenceHref` is left undefined rather than pointed at a guessed URL: the
 * operations row carries no evidence link today, and inventing one would put a
 * dead link on every row. `WorkRow` renders "No evidence linked" for that case.
 */
export function toWorkListItem(row: WorkRowDto): WorkListViewItem {
  return {
    id: row.id,
    deliverable: row.title,
    owner: row.assigneeId ? 'Assigned' : 'Unassigned',
    dueDate: row.dueAt ?? undefined,
    status: toViewWorkStatus(row.status),
    // A blocked row's reason is not in this DTO; the work-detail screen holds
    // it. Saying nothing is better than writing "Blocked" as the reason.
    blocker: undefined,
    evidenceHref: undefined,
    nextAction: undefined,
  };
}

export function toWorkListItems(rows: readonly WorkRowDto[]): WorkListViewItem[] {
  return rows.map(toWorkListItem);
}
