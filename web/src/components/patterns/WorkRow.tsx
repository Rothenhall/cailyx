'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertOctagon, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkItem } from '@/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  StatusPill,
  WORK_STATUS_LABEL,
  workStatusTone,
} from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';

/**
 * §3.3 Work row — deliverable, owner, due, status, blocker, linked evidence,
 * next action.
 *
 * §3.4 requires the responsive swap: "Mobile <768 px: single column, … cards
 * for work lists." A `<tr>` cannot become a `<div>`, so the swap is done by the
 * container, not by `WorkRow` itself:
 *
 *  - `WorkRow` is the desktop (≥768 px) row and must sit inside a `<TableBody>`;
 *  - `WorkCard` is the <768 px presentation of the same facts;
 *  - **`WorkList` is the entry point that picks between them**, rendering a
 *    real semantic table above the breakpoint and cards below it, and it is
 *    what screens should normally use.
 *
 * The switch is CSS (`md:` variants), not a media-query hook, so there is no
 * hydration mismatch and no flash of the wrong layout.
 */

/** Only `http(s)` and same-origin-relative links are rendered as links. §10.5
 *  requires outbound link schemes to be validated; an evidence URL that came
 *  back as `javascript:` or `data:` is displayed as text instead. */
function isSafeHref(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith('/')) return true;
  try {
    const url = new URL(href, 'https://cailyx.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * An item is overdue when its due date is in the past and it is not done.
 * Resolved after mount rather than during render: "today" depends on the
 * viewer's clock and timezone, and computing it on the server would risk a
 * hydration mismatch for a purely informational marker.
 */
function useIsOverdue(item: WorkItem): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!item.dueDate || item.status === 'done') {
      setOverdue(false);
      return;
    }
    const due = new Date(item.dueDate);
    if (Number.isNaN(due.getTime())) {
      setOverdue(false);
      return;
    }
    setOverdue(due.getTime() < Date.now());
  }, [item.dueDate, item.status]);
  return overdue;
}

interface DueCellProps {
  item: WorkItem;
  timeZone?: string;
  className?: string;
}

/** Due date, named when it is overdue — never color alone (§3.4). */
function DueCell({ item, timeZone, className }: DueCellProps) {
  const overdue = useIsOverdue(item);
  if (!item.dueDate) {
    return <span className={cn('text-muted-foreground', className)}>No due date</span>;
  }
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      <Timestamp value={item.dueDate} dateOnly timeZone={timeZone} />
      {overdue && <span className="text-meta font-medium text-danger-foreground">Overdue</span>}
    </span>
  );
}

/** Evidence link. Falls back to plain text when the URL scheme is unusable. */
function EvidenceCell({ item }: { item: WorkItem }) {
  if (!item.evidenceHref) {
    return <span className="text-muted-foreground">No evidence linked</span>;
  }
  if (!isSafeHref(item.evidenceHref)) {
    // §4.5: an important limitation must not be hidden behind a tooltip. The
    // reason is visible text, not a `title` only.
    return (
      <span className="text-muted-foreground">
        Evidence link unavailable — the stored link is not a usable address
      </span>
    );
  }
  return (
    <a
      href={item.evidenceHref}
      className="inline-flex items-center gap-1 text-primary underline underline-offset-4"
      {...(item.evidenceHref.startsWith('/')
        ? {}
        : { target: '_blank', rel: 'noreferrer noopener' })}
    >
      <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
      Evidence
    </a>
  );
}

export interface WorkRowProps {
  item: WorkItem;
  /** IANA zone for the due date; defaults to the viewer's. */
  timeZone?: string;
  /** Makes the deliverable a control that opens the work item. */
  onOpen?: (item: WorkItem) => void;
  /** A per-row menu. §3.2: destructive actions belong here, not in a primary
   *  button. Rendered only by `WorkList`, which also renders the header cell. */
  actions?: ReactNode;
  className?: string;
}

/**
 * One desktop work row. Use `WorkList` unless you are hand-building a table
 * with `WorkTableHead` — the columns must match or the table misreads.
 */
export function WorkRow({ item, timeZone, onOpen, actions, className }: WorkRowProps) {
  return (
    <TableRow className={className}>
      <TableCell className="min-w-[14rem] font-medium text-foreground">
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="text-left underline-offset-4 hover:underline"
          >
            {item.deliverable}
          </button>
        ) : (
          item.deliverable
        )}
      </TableCell>
      <TableCell className="text-table text-muted-foreground">{item.owner}</TableCell>
      <TableCell className="whitespace-nowrap text-table">
        <DueCell item={item} timeZone={timeZone} />
      </TableCell>
      <TableCell>
        <StatusPill label={WORK_STATUS_LABEL[item.status]} tone={workStatusTone(item.status)} />
      </TableCell>
      <TableCell className="min-w-[10rem] text-table">
        {item.blocker ? (
          <span className="inline-flex items-start gap-1.5 text-danger-foreground">
            <AlertOctagon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {item.blocker}
          </span>
        ) : (
          <span className="text-muted-foreground">No blocker</span>
        )}
      </TableCell>
      <TableCell className="text-table">
        <EvidenceCell item={item} />
      </TableCell>
      <TableCell className="min-w-[10rem] text-table text-foreground">
        {item.nextAction ?? <span className="text-muted-foreground">Nothing outstanding</span>}
      </TableCell>
      {actions && <TableCell className="text-right">{actions}</TableCell>}
    </TableRow>
  );
}

export interface WorkCardProps {
  item: WorkItem;
  timeZone?: string;
  onOpen?: (item: WorkItem) => void;
  actions?: ReactNode;
  className?: string;
}

/** One <768 px work card — the same facts as `WorkRow`, stacked. */
export function WorkCard({ item, timeZone, onOpen, actions, className }: WorkCardProps) {
  return (
    <article
      className={cn(
        'space-y-2 rounded-lg border border-border bg-surface p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-table font-medium text-foreground">
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="text-left underline-offset-4 hover:underline"
            >
              {item.deliverable}
            </button>
          ) : (
            item.deliverable
          )}
        </h3>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={WORK_STATUS_LABEL[item.status]} tone={workStatusTone(item.status)} />
        <DueCell item={item} timeZone={timeZone} />
      </div>

      <dl className="grid gap-1 text-table">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="text-foreground">{item.owner}</dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted-foreground">Evidence</dt>
          <dd>
            <EvidenceCell item={item} />
          </dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted-foreground">Next action</dt>
          <dd className="text-foreground">
            {item.nextAction ?? <span className="text-muted-foreground">Nothing outstanding</span>}
          </dd>
        </div>
      </dl>

      {item.blocker && (
        <p className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-table text-danger-foreground">
          <AlertOctagon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {/* §4.5: "use text/icon plus color for every status", and a raw
                state word is not client vocabulary. "Waiting on" says which
                state it is without naming the internal one. */}
            <span className="font-medium">Waiting on: </span>
            {item.blocker}
          </span>
        </p>
      )}
    </article>
  );
}

/** The column headings for `WorkRow`. Rendered by `WorkList`; exported so a
 *  hand-built table can stay in sync with `WorkRow`'s columns. */
export function WorkTableHead({ hasActions = false }: { hasActions?: boolean }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead scope="col">Deliverable</TableHead>
        <TableHead scope="col">Owner</TableHead>
        <TableHead scope="col">Due</TableHead>
        <TableHead scope="col">Status</TableHead>
        <TableHead scope="col">Blocker</TableHead>
        <TableHead scope="col">Evidence</TableHead>
        <TableHead scope="col">Next action</TableHead>
        {hasActions && (
          <TableHead scope="col" className="text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        )}
      </TableRow>
    </TableHeader>
  );
}

export interface WorkListProps {
  items: WorkItem[];
  timeZone?: string;
  onOpen?: (item: WorkItem) => void;
  /** Per-row actions, e.g. a `DropdownMenu` (keep destructive items there). */
  rowActions?: (item: WorkItem) => ReactNode;
  /**
   * Rendered when `items` is empty. Deliberately not defaulted: only the
   * screen knows whether the list is empty because nothing exists, because a
   * run has not finished, or because a filter excluded everything — and §3.5
   * gives each of those its own copy. Pass the matching `EmptyState` variant.
   */
  emptyState?: ReactNode;
  /** Accessible name for the scrollable table region (§3.4). */
  label?: string;
  /** An optional caption, e.g. the filter scope this list reflects. */
  caption?: ReactNode;
  className?: string;
}

/**
 * The responsive work list: a semantic table at ≥768 px and cards below it.
 * This is the component screens should use — it is what makes `WorkRow`
 * "become a card" on mobile.
 */
export function WorkList({
  items,
  timeZone,
  onOpen,
  rowActions,
  emptyState,
  label = 'Work items',
  caption,
  className,
}: WorkListProps) {
  if (items.length === 0) return <>{emptyState}</>;

  return (
    <div className={className}>
      {caption && <div className="mb-2 text-meta text-muted-foreground">{caption}</div>}

      {/* ≥768 px — a real table, scrollable in a labeled region. */}
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="table-scroll-region hidden rounded-lg border border-border bg-surface md:block"
      >
        <Table>
          <WorkTableHead hasActions={Boolean(rowActions)} />
          <TableBody>
            {items.map((item) => (
              <WorkRow
                key={item.id}
                item={item}
                timeZone={timeZone}
                onOpen={onOpen}
                actions={rowActions?.(item)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* <768 px — cards, one column (§3.4). */}
      <ul className="space-y-3 md:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <WorkCard
              item={item}
              timeZone={timeZone}
              onOpen={onOpen}
              actions={rowActions?.(item)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
