'use client';

import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The table alternative every chart on this app ships with.
 *
 * design_plan.md §3.4, in one line: *"Chart tables provide the same information
 * without relying on hover or color."* That sentence is a requirement on the
 * screen, not a suggestion about the chart: a chart whose values can only be
 * read by hovering a mark, or by telling two hues apart, has not been built.
 *
 * So this is not an optional "table view" toggle — every chart component in
 * this directory renders one of these directly below its plot, carrying the
 * same rows the plot drew. A chart with no table is incomplete work.
 *
 * @module components/charts/ChartTable
 */

export interface ChartTableColumn<Row> {
  /** Stable key for React and for the column's `<th>`. */
  key: string;
  header: string;
  /** Numeric columns are right-aligned so digits line up (§3.1 tabular-nums). */
  align?: 'left' | 'right';
  /** The cell content for one row. Values must come from the row, not be recomputed. */
  render: (row: Row) => ReactNode;
}

export interface ChartTableProps<Row> {
  /**
   * The table's accessible name. State what is tabulated and which chart it
   * stands in for, e.g. "Technical score by run — the same values as the chart
   * above".
   */
  caption: string;
  columns: ReadonlyArray<ChartTableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  getRowKey: (row: Row) => string;
  /**
   * Named exceptions the plot could not draw: a value that was never measured,
   * or a run that is not comparable to the one before it. §3.5 requires these
   * to be stated in text — a gap in a line says "something is missing" but not
   * what.
   */
  notes?: ReactNode;
  className?: string;
}

/**
 * A semantic table carrying a chart's own values.
 *
 * The scroller is the labelled, focusable region §3.4 asks for ("data tables
 * can scroll in a labeled region"), and the caption is carried the same way
 * `patterns/DataTable` carries it — screen-reader only, with the same sentence
 * as the region's name — so a chart table and a screen table are announced
 * identically. The visible explanation of *why* a table sits under a chart
 * belongs in the chart's own note, not in a caption repeated on every table.
 */
export function ChartTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  notes,
  className,
}: ChartTableProps<Row>) {
  return (
    <div className={cn('space-y-2', className)}>
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  scope="col"
                  className={column.align === 'right' ? 'text-right' : undefined}
                >
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={getRowKey(row)}>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className={column.align === 'right' ? 'text-right tabular-nums' : undefined}
                  >
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {notes ? <div className="space-y-1 text-meta text-muted-foreground">{notes}</div> : null}
    </div>
  );
}
