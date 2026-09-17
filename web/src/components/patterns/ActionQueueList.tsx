'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';

/**
 * The full "needs your action" queue (§5.6) — the screen behind Overview's
 * three cards, shared by the staff and client surfaces so the two can never
 * present the same queue differently.
 *
 * Three rules from §5.6 that this component deliberately encodes:
 *
 *  - **An item is never completed by opening it.** Each row offers a link to
 *    the record that raised it and nothing else — there is no "done" control
 *    here, because the only thing that resolves an item is resolving its
 *    source.
 *  - **Order is the server's.** `panel.order` is rendered as delivered and is
 *    never re-sorted client-side, so overdue-first holds identically wherever
 *    the queue appears.
 *  - **The count is the true total**, not the number of rows a capped response
 *    happened to include. `total` is shown against the rendered length, so a
 *    truncated queue says so rather than quietly looking complete.
 *
 * `CompletionCondition` is rendered for every row: "what has to happen for this
 * to go away" is the question a reader actually has.
 */

export interface ActionQueueEntry {
  sourceType: string;
  sourceId: string;
  title: string;
  reason: string;
  deadline: string | null;
  severity: 'overdue' | 'blocking' | 'normal';
  destination: string;
  completionCondition: string;
  currentVersion: string;
  createdAt: string;
}

/** §5.6's severity wording — text plus colour, never colour alone. */
export function actionSeverityLabel(severity: ActionQueueEntry['severity']): string {
  switch (severity) {
    case 'overdue':
      return 'Overdue';
    case 'blocking':
      return 'Blocking others';
    default:
      return 'Requested';
  }
}

export function actionSeverityTone(severity: ActionQueueEntry['severity']): StatusTone {
  switch (severity) {
    case 'overdue':
      return 'danger';
    case 'blocking':
      return 'warning';
    default:
      return 'info';
  }
}

export function ActionQueueList({
  items,
  total,
  emptyCopy,
}: {
  items: ReadonlyArray<ActionQueueEntry>;
  total: number;
  emptyCopy: React.ReactNode;
}) {
  if (items.length === 0) {
    return <div className="text-table text-muted-foreground">{emptyCopy}</div>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={`${item.sourceType}:${item.sourceId}`} className="space-y-2 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-table font-medium">{item.title}</span>
                  <StatusPill
                    tone={actionSeverityTone(item.severity)}
                    label={actionSeverityLabel(item.severity)}
                  />
                </div>
                <p className="text-table text-muted-foreground">{item.reason}</p>
                <p className="text-meta text-muted-foreground">
                  Completes when {item.completionCondition}
                  {item.deadline ? (
                    <>
                      {' · '}due <Timestamp value={item.deadline} dateOnly />
                    </>
                  ) : null}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={item.destination}>Open</Link>
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {total > items.length ? (
        // The honest truncation notice. Without it a capped read would read as
        // "this is everything", which is exactly what §5.6 forbids.
        <p className="text-meta text-muted-foreground">
          Showing {items.length} of {total} waiting items. Resolving the ones above updates this
          list.
        </p>
      ) : null}
    </div>
  );
}
