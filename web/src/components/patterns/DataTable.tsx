'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Columns3,
  Inbox,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

/** §10.5 "Validate outbound link schemes" — only http(s) and app-relative
 *  targets become links, so a row href from API data cannot smuggle a
 *  `javascript:` payload into an anchor. */
function safeHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('/')) return href;
  return /^https?:\/\//i.test(href) ? href : undefined;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  /** `ColumnDef.key` of the sorted column. */
  key: string;
  direction: SortDirection;
}

export type ColumnAlign = 'left' | 'center' | 'right';

/**
 * One column of a `DataTable`. `accessor` is the value behind the column —
 * what the default cell renders, what sorting compares and what search
 * matches — so a column is usually one line of configuration.
 */
export interface ColumnDef<T> {
  /** Stable identifier: used for sort state, column visibility and React keys. */
  key: string;
  header: React.ReactNode;
  /** The value behind the column. Omitted when `render` supplies everything. */
  accessor?: (row: T) => unknown;
  /** Enables the sort control in this header. */
  sortable?: boolean;
  align?: ColumnAlign;
  /** Custom cell content. Replaces the default rendering of `accessor`. */
  render?: (row: T) => React.ReactNode;
  /** Column width, applied as `width` + `minWidth` (a number is px). */
  width?: string | number;
  /** Sort key when `accessor` is not directly comparable (e.g. a formatted
   *  string that should sort by the underlying date). */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Extra text matched by the search box beyond the accessor value. */
  searchText?: (row: T) => string;
  /** What a null/undefined accessor value renders as. Defaults to §3.5's
   *  "Not measured yet", so an empty cell never reads as zero. */
  emptyLabel?: string;
  /** Starts hidden; the reader can re-enable it from the columns menu. */
  defaultHidden?: boolean;
  /** Never offered in the columns menu (e.g. a row-actions column). */
  alwaysVisible?: boolean;
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableFilterOption {
  /** Value passed to the filter's `match`/`getValue`. */
  value: string;
  label: string;
}

/** A toolbar filter. Unlike the search box it is an explicit choice, so the
 *  reader can always see and clear which slice they are looking at. */
export interface DataTableFilter<T> {
  id: string;
  label: string;
  options: DataTableFilterOption[];
  /** Custom predicate. Defaults to comparing `getValue`, or the accessor of
   *  the column whose `key` equals this filter's `id`. */
  match?: (row: T, value: string) => boolean;
  /** The row's value for this filter, when it is not a column accessor. */
  getValue?: (row: T) => string;
}

/**
 * Server-supplied pagination. When present the table does **not** slice rows
 * itself: it reports the page it is on and lets the caller fetch. Local
 * search/filters then only cover the rows currently loaded, and the table says
 * so rather than implying a global result (§10.5).
 */
export interface DataTablePagination {
  /** 1-based. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Total matching records, when the server reports it. */
  totalRows?: number;
  /** True while the next page is in flight; disables the controls. */
  isFetching?: boolean;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<ColumnDef<T>>;
  /** The rows for the current page/filter the caller has loaded. */
  rows: ReadonlyArray<T>;
  /** Stable row identity, required for selection and row detail. */
  getRowId: (row: T) => string;
  /** Accessible name of the table itself, rendered as a screen-reader-only
   *  caption so the table is announced with what it contains. */
  caption?: string;
  /** Accessible name of the horizontally scrolling region. Defaults to
   *  `caption`, then "Data table". */
  ariaLabel?: string;

  /** Renders the search box. Pass a predicate to search beyond the accessors. */
  searchable?: boolean | ((row: T, query: string) => boolean);
  searchPlaceholder?: string;
  filters?: ReadonlyArray<DataTableFilter<T>>;

  /** Adds a leading selection column. Selection is controlled when
   *  `selectedIds` is passed, uncontrolled otherwise. */
  selectable?: boolean;
  selectedIds?: readonly string[];
  defaultSelectedIds?: readonly string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Renders the batch controls shown while rows are selected. */
  bulkActions?: (selectedIds: readonly string[]) => React.ReactNode;
  /** Accessible name for a row's checkbox. Defaults to the row id. */
  selectRowLabel?: (row: T) => string;

  /** Controlled sort. Pass `null` to control the table into an unsorted state. */
  sort?: SortState | null;
  defaultSort?: SortState;
  onSortChange?: (sort: SortState | null) => void;

  /** Controlled column visibility. */
  hiddenColumns?: readonly string[];
  onHiddenColumnsChange?: (hiddenColumns: string[]) => void;

  /** Expands an accessible detail row beneath the record (§3.3 "row detail"). */
  rowDetail?: (row: T) => React.ReactNode;
  /** Makes the row open its routed detail screen. The link is rendered inside
   *  `linkColumnKey` (the first visible column by default) so the row is
   *  reachable by keyboard; the row click itself is a pointer convenience. */
  rowHref?: (row: T) => string;
  /** Which column carries the `rowHref` link. */
  linkColumnKey?: string;
  /** Pointer-only row activation. Prefer `rowHref` when a detail screen exists. */
  onRowClick?: (row: T) => void;

  /** Server pagination. Mutually exclusive with `pageSize`. */
  pagination?: DataTablePagination;
  /** Client-side paging of the rows handed in. */
  pageSize?: number;

  /** Shown when the request failed. Takes precedence over the empty state —
   *  a failed request can never be rendered as "no data" (§3.5). */
  error?: Error | string | null;
  /** Retry control shown with the error state. */
  onRetry?: () => void;
  /** Overrides the default empty state. */
  emptyState?: React.ReactNode;
  /** Copy for the default empty state, e.g. "No projects yet". */
  emptyMessage?: string;

  isLoading?: boolean;
  /** Extra toolbar controls (e.g. an "Export" or "New project" button). */
  toolbar?: React.ReactNode;
  /** Forces a minimum table width so the region scrolls instead of squashing
   *  columns, e.g. "60rem". */
  minTableWidth?: string;
  className?: string;
}

type SortableValue = string | number | boolean | Date | null | undefined;

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function compareValues(a: SortableValue, b: SortableValue): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function widthStyle(width: string | number | undefined): React.CSSProperties | undefined {
  if (width === undefined) return undefined;
  const value = typeof width === 'number' ? `${width}px` : width;
  return { width: value, minWidth: value };
}

function alignClass(align: ColumnAlign | undefined): string | undefined {
  if (align === 'right') return 'text-right';
  if (align === 'center') return 'text-center';
  return undefined;
}

function headerLabel<T>(column: ColumnDef<T>): string {
  return typeof column.header === 'string' ? column.header : column.key;
}

/** Radix `Select` refuses an empty item value, so "no filter" needs a token. */
const ANY_OPTION = '__any__';

/**
 * §3.3 Data table — the one table for the whole app: portfolio libraries,
 * evidence lists, work lists and report indexes all use this component with a
 * column config, so search, sort, filter, column visibility, keyboard access,
 * empty/error states, row detail and pagination are solved once (§5.5 of the
 * build plan).
 *
 * Two rules are enforced here rather than left to call sites:
 *  - the empty state and the error state are separate props, and the error
 *    always wins. A request that failed can never render as "no records yet".
 *    When rows are already loaded and only the refresh failed, the last known
 *    rows stay on screen under an explicit banner (§3.5 "Run takes longer than
 *    expected": show last known state).
 *  - when the caller supplies server pagination, search and filters apply to
 *    the loaded page only, and the table says so instead of implying a global
 *    result it did not compute (§10.5).
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  ariaLabel,
  searchable = false,
  searchPlaceholder = 'Search',
  filters,
  selectable = false,
  selectedIds,
  defaultSelectedIds,
  onSelectionChange,
  bulkActions,
  selectRowLabel,
  sort,
  defaultSort,
  onSortChange,
  hiddenColumns,
  onHiddenColumnsChange,
  rowDetail,
  rowHref,
  linkColumnKey,
  onRowClick,
  pagination,
  pageSize,
  error,
  onRetry,
  emptyState,
  emptyMessage = 'No records yet',
  isLoading = false,
  toolbar,
  minTableWidth,
  className,
}: DataTableProps<T>) {
  const [query, setQuery] = React.useState('');
  const [filterValues, setFilterValues] = React.useState<Record<string, string>>({});
  const [clientPage, setClientPage] = React.useState(1);
  const [internalSort, setInternalSort] = React.useState<SortState | null>(defaultSort ?? null);
  const [internalSelection, setInternalSelection] = React.useState<readonly string[]>(defaultSelectedIds ?? []);
  const [internalHidden, setInternalHidden] = React.useState<readonly string[]>(() =>
    columns.filter((column) => column.defaultHidden).map((column) => column.key),
  );
  const [expandedRowIds, setExpandedRowIds] = React.useState<readonly string[]>([]);
  const detailRowId = React.useId();
  const router = useRouter();

  const sortControlled = sort !== undefined;
  const activeSort = sortControlled ? (sort ?? null) : internalSort;
  const selectionControlled = selectedIds !== undefined;
  // Memoised so the array identity is stable for the memos below whether the
  // caller or the table owns the state.
  const activeSelection = React.useMemo(
    () => (selectionControlled ? (selectedIds ?? []) : internalSelection),
    [selectionControlled, selectedIds, internalSelection],
  );
  const selectedSet = React.useMemo(() => new Set(activeSelection), [activeSelection]);
  const visibilityControlled = hiddenColumns !== undefined;
  const activeHidden = React.useMemo(
    () => (visibilityControlled ? (hiddenColumns ?? []) : internalHidden),
    [visibilityControlled, hiddenColumns, internalHidden],
  );

  const visibleColumns = React.useMemo(() => {
    const visible = columns.filter((column) => !activeHidden.includes(column.key));
    // A table with no columns is unusable; fall back rather than render an
    // empty grid if a caller hides everything.
    return visible.length > 0 ? visible : columns.slice(0, 1);
  }, [columns, activeHidden]);

  const activeFilterCount = filters?.filter((filter) => Boolean(filterValues[filter.id])).length ?? 0;

  const processedRows = React.useMemo(() => {
    let result = [...rows];

    for (const filter of filters ?? []) {
      const value = filterValues[filter.id];
      if (!value) continue;
      const column = columns.find((candidate) => candidate.key === filter.id);
      result = result.filter((row) => {
        if (filter.match) return filter.match(row, value);
        if (filter.getValue) return filter.getValue(row) === value;
        if (column?.accessor) return String(column.accessor(row)) === value;
        // Nothing to match against: the filter is a caller bug, and silently
        // dropping every row would look like a genuine empty result.
        return true;
      });
    }

    const trimmed = query.trim();
    if (trimmed && searchable) {
      const lower = trimmed.toLowerCase();
      result = result.filter((row) => {
        if (typeof searchable === 'function') return searchable(row, trimmed);
        return columns.some((column) => {
          const extra = column.searchText?.(row);
          if (extra && extra.toLowerCase().includes(lower)) return true;
          const value = column.accessor?.(row);
          if (isEmptyValue(value)) return false;
          return String(value).toLowerCase().includes(lower);
        });
      });
    }

    if (activeSort) {
      const column = columns.find((candidate) => candidate.key === activeSort.key);
      if (column) {
        const read = (row: T): SortableValue => {
          const raw = column.sortValue ? column.sortValue(row) : column.accessor?.(row);
          if (raw === null || raw === undefined) return raw;
          if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
          if (raw instanceof Date) return raw;
          // Anything else (an object accessor) still sorts, by its string form,
          // rather than throwing during render.
          return String(raw);
        };
        result.sort((a, b) => {
          const aValue = read(a);
          const bValue = read(b);
          // Empty values stay last in both directions: a missing measurement
          // is not the smallest measurement.
          if (isEmptyValue(aValue) || isEmptyValue(bValue)) {
            if (isEmptyValue(aValue) && isEmptyValue(bValue)) return 0;
            return isEmptyValue(aValue) ? 1 : -1;
          }
          const comparison = compareValues(aValue, bValue);
          return activeSort.direction === 'asc' ? comparison : -comparison;
        });
      }
    }

    return result;
  }, [rows, columns, filters, filterValues, query, searchable, activeSort]);

  const clientPageSize = pagination ? undefined : pageSize;
  const clientPageCount = clientPageSize
    ? Math.max(1, Math.ceil(processedRows.length / clientPageSize))
    : 1;
  const safeClientPage = Math.min(clientPage, clientPageCount);
  const pagedRows = clientPageSize
    ? processedRows.slice((safeClientPage - 1) * clientPageSize, safeClientPage * clientPageSize)
    : processedRows;

  const pageInfo: DataTablePagination | undefined = pagination
    ? pagination
    : clientPageSize
      ? {
          page: safeClientPage,
          pageCount: clientPageCount,
          onPageChange: setClientPage,
          totalRows: processedRows.length,
        }
      : undefined;

  const hasError = Boolean(error);
  const errorMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const errorReplacesRows = hasError && rows.length === 0;

  const linkColumn = linkColumnKey ?? visibleColumns[0]?.key;
  const columnCount = visibleColumns.length + (selectable ? 1 : 0) + (rowDetail ? 1 : 0);
  const regionLabel = ariaLabel ?? caption ?? 'Data table';
  const showToolbar = Boolean(searchable) || Boolean(filters?.length) || Boolean(toolbar) || columns.length > 1;

  function resetPage() {
    setClientPage(1);
  }

  function toggleSort(column: ColumnDef<T>) {
    const next: SortState | null =
      activeSort?.key !== column.key
        ? { key: column.key, direction: 'asc' }
        : activeSort.direction === 'asc'
          ? { key: column.key, direction: 'desc' }
          : // Third activation clears the sort and returns the caller's order.
            null;
    if (!sortControlled) setInternalSort(next);
    onSortChange?.(next);
  }

  function setSelection(next: string[]) {
    if (!selectionControlled) setInternalSelection(next);
    onSelectionChange?.(next);
  }

  function toggleRowSelection(id: string, checked: boolean) {
    const next = new Set(activeSelection);
    if (checked) next.add(id);
    else next.delete(id);
    setSelection([...next]);
  }

  function toggleAllOnPage(checked: boolean) {
    const pageIds = pagedRows.map(getRowId);
    const next = new Set(activeSelection);
    for (const id of pageIds) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    setSelection([...next]);
  }

  function toggleColumn(key: string) {
    const isHidden = activeHidden.includes(key);
    // Never hide the last visible column: an empty grid is not a view.
    if (!isHidden && visibleColumns.length <= 1) return;
    const next = isHidden ? activeHidden.filter((item) => item !== key) : [...activeHidden, key];
    if (!visibilityControlled) setInternalHidden(next);
    onHiddenColumnsChange?.(next);
  }

  function toggleRowDetail(id: string) {
    setExpandedRowIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  const pageIds = pagedRows.map(getRowId);
  const selectedOnPage = pageIds.filter((id) => selectedSet.has(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const someOnPageSelected = selectedOnPage > 0 && !allOnPageSelected;

  function renderDefaultCell(column: ColumnDef<T>, row: T): React.ReactNode {
    if (column.render) return column.render(row);
    const value = column.accessor?.(row);
    if (isEmptyValue(value)) {
      // Empty is not zero (§3.5): the default is the explicit "not measured"
      // label, overridable per column for non-measurement fields.
      return <span className="text-unmeasured-foreground">{column.emptyLabel ?? notMeasuredLabel()}</span>;
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
  }

  return (
    <div className="flex flex-col gap-2">
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {searchable ? (
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  resetPage();
                }}
                placeholder={searchPlaceholder}
                aria-label={caption ? `Search ${caption}` : 'Search table'}
                className="h-9 pl-8"
              />
            </div>
          ) : null}

          {filters?.map((filter) => (
            <Select
              key={filter.id}
              value={filterValues[filter.id] ?? ANY_OPTION}
              onValueChange={(value) => {
                setFilterValues((current) => ({ ...current, [filter.id]: value === ANY_OPTION ? '' : value }));
                resetPage();
              }}
            >
              <SelectTrigger className="h-9 w-full sm:w-48" aria-label={filter.label}>
                <SelectValue placeholder={filter.label} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_OPTION}>{`All ${filter.label.toLowerCase()}`}</SelectItem>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {toolbar}
            {columns.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    <Columns3 className="h-4 w-4" aria-hidden="true" />
                    Columns
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {columns
                    .filter((column) => !column.alwaysVisible)
                    .map((column) => {
                      const isHidden = activeHidden.includes(column.key);
                      return (
                        <DropdownMenuCheckboxItem
                          key={column.key}
                          checked={!isHidden}
                          // Keep the menu open so several columns can be toggled
                          // in one visit.
                          onSelect={(event) => event.preventDefault()}
                          onCheckedChange={() => toggleColumn(column.key)}
                          disabled={!isHidden && visibleColumns.length <= 1}
                        >
                          {headerLabel(column)}
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      ) : null}

      {pagination && (query || activeFilterCount > 0) ? (
        <p className="text-meta text-muted-foreground">
          Search and filters apply to the {formatNumber(rows.length)} rows loaded on this page; totals are
          reported by the server.
        </p>
      ) : null}

      {hasError && !errorReplacesRows ? (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Could not refresh this table</AlertTitle>
          <AlertDescription>
            <p>
              The rows below are the last data that loaded and may be out of date.
              {errorMessage ? ` ${errorMessage}` : ''}
            </p>
            {onRetry ? (
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {bulkActions && selectedSet.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
          <span className="text-table font-medium text-foreground">
            {formatNumber(selectedSet.size)} selected
          </span>
          {bulkActions(activeSelection)}
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelection([])}>
            Clear selection
          </Button>
        </div>
      ) : null}

      {/* §3.4: a horizontally scrolling table is a labeled, focusable region. */}
      <div
        role="region"
        aria-label={regionLabel}
        aria-busy={isLoading || undefined}
        tabIndex={0}
        className={cn(
          'table-scroll-region rounded-lg border border-border bg-surface',
          // `ui/table` wraps the table in its own overflow container; the
          // region above must be the scroller for keyboard scrolling to work.
          '[&>div]:overflow-visible',
          className,
        )}
      >
        <Table className="text-table" style={minTableWidth ? { minWidth: minTableWidth } : undefined}>
          {caption ? <TableCaption className="sr-only">{caption}</TableCaption> : null}

          <TableHeader className="bg-surface-sunken">
            <TableRow className="hover:bg-transparent">
              {selectable ? (
                <TableHead className="w-10 pr-0">
                  <Checkbox
                    checked={allOnPageSelected ? true : someOnPageSelected ? 'indeterminate' : false}
                    onCheckedChange={(checked) => toggleAllOnPage(checked === true)}
                    aria-label="Select all rows on this page"
                  />
                </TableHead>
              ) : null}

              {rowDetail ? (
                <TableHead className="w-10">
                  <span className="sr-only">Row detail</span>
                </TableHead>
              ) : null}

              {visibleColumns.map((column) => {
                const isActive = activeSort?.key === column.key;
                // §3.4 semantic tables: the sorted state is exposed on the
                // header cell itself, not only in the icon.
                const ariaSort: 'ascending' | 'descending' | 'none' | undefined = column.sortable
                  ? isActive
                    ? activeSort?.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                  : undefined;
                return (
                  <TableHead
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={widthStyle(column.width)}
                    className={cn(alignClass(column.align), column.headerClassName)}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className="inline-flex w-full items-center gap-1 rounded-sm text-left font-medium hover:text-foreground focus-visible:outline-none"
                        title={`Sort by ${headerLabel(column)}`}
                      >
                        <span className="truncate">{column.header}</span>
                        <SortIcon
                          active={Boolean(isActive)}
                          direction={isActive ? activeSort?.direction : undefined}
                        />
                      </button>
                    ) : (
                      <span className="truncate">{column.header}</span>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>

          <TableBody>
            {errorReplacesRows ? (
              // The error state is its own branch: it can never fall through to
              // the empty state, so a failed request is never shown as
              // "no records".
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="p-0">
                  <div role="alert" className="flex flex-col items-start gap-3 p-6">
                    <div className="flex items-center gap-2 text-danger-foreground">
                      <TriangleAlert className="h-5 w-5" aria-hidden="true" />
                      <p className="text-body font-semibold">This table could not be loaded</p>
                    </div>
                    <p className="text-table text-muted-foreground">
                      The request failed, so there is no data to show. This is not an empty result.
                      {errorMessage ? ` ${errorMessage}` : ''}
                    </p>
                    {onRetry ? (
                      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        Try again
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ) : isLoading && rows.length === 0 ? (
              Array.from({ length: 3 }).map((_, rowIndex) => (
                <TableRow key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
                  {Array.from({ length: columnCount }).map((__, cellIndex) => (
                    <TableCell key={`skeleton-${rowIndex}-${cellIndex}`}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : pagedRows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="p-0">
                  {emptyState ?? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                      <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                      <p className="text-table font-medium text-foreground">{emptyMessage}</p>
                      {query || activeFilterCount > 0 ? (
                        <p className="text-meta text-muted-foreground">
                          Nothing matches the current search and filters.
                        </p>
                      ) : null}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              pagedRows.map((row) => {
                const id = getRowId(row);
                const isSelected = selectedSet.has(id);
                const isExpanded = expandedRowIds.includes(id);
                const href = rowHref ? safeHref(rowHref(row)) : undefined;
                const detailId = `${detailRowId}-${id}`;

                return (
                  <React.Fragment key={id}>
                    <TableRow
                      data-state={isSelected ? 'selected' : undefined}
                      className={cn((href || onRowClick) && 'cursor-pointer')}
                      onClick={
                        href || onRowClick
                          ? (event) => {
                              // Never hijack a click on a control inside the row.
                              const target = event.target;
                              if (target instanceof HTMLElement && target.closest('a,button,input,select,label')) {
                                return;
                              }
                              if (onRowClick) onRowClick(row);
                              else if (href) {
                                // Client-side navigation for app routes; a
                                // full navigation only for external targets.
                                if (href.startsWith('/')) router.push(href);
                                else window.location.assign(href);
                              }
                            }
                          : undefined
                      }
                    >
                      {selectable ? (
                        <TableCell className="pr-0">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) => toggleRowSelection(id, checked === true)}
                            aria-label={`Select ${selectRowLabel ? selectRowLabel(row) : id}`}
                          />
                        </TableCell>
                      ) : null}

                      {rowDetail ? (
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-expanded={isExpanded}
                            aria-controls={detailId}
                            onClick={() => toggleRowDetail(id)}
                          >
                            <ChevronRight
                              className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')}
                              aria-hidden="true"
                            />
                            <span className="sr-only">
                              {isExpanded ? 'Hide' : 'Show'} details for{' '}
                              {selectRowLabel ? selectRowLabel(row) : id}
                            </span>
                          </Button>
                        </TableCell>
                      ) : null}

                      {visibleColumns.map((column) => {
                        const content = renderDefaultCell(column, row);
                        return (
                          <TableCell
                            key={column.key}
                            style={widthStyle(column.width)}
                            className={cn(alignClass(column.align), column.cellClassName)}
                          >
                            {column.key === linkColumn && href ? (
                              <Link
                                href={href}
                                className="font-medium text-primary underline-offset-4 hover:underline"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {content}
                              </Link>
                            ) : (
                              content
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>

                    {rowDetail && isExpanded ? (
                      <TableRow id={detailId} className="bg-surface-sunken hover:bg-surface-sunken">
                        <TableCell colSpan={columnCount} className="p-4">
                          {rowDetail(row)}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {pageInfo ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-meta text-muted-foreground">
          <span aria-live="polite">
            {pageRangeLabel(pageInfo, pagedRows.length, clientPageSize)}
            {pageInfo.isFetching ? ' · Loading…' : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => pageInfo.onPageChange(pageInfo.page - 1)}
              disabled={pageInfo.page <= 1 || Boolean(pageInfo.isFetching)}
            >
              Previous
            </Button>
            <span>
              Page {formatNumber(pageInfo.page)} of {formatNumber(pageInfo.pageCount)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => pageInfo.onPageChange(pageInfo.page + 1)}
              disabled={pageInfo.page >= pageInfo.pageCount || Boolean(pageInfo.isFetching)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A range is only printed when the page size is actually known (client-side
 * paging). With server pagination the table does not know how many rows the
 * other pages hold, so it reports the page and the server's total rather than
 * computing a range that could be wrong.
 */
function pageRangeLabel(
  pageInfo: DataTablePagination,
  rowsOnPage: number,
  pageSize: number | undefined,
): string {
  const total = pageInfo.totalRows;
  if (total === undefined) return `Page ${formatNumber(pageInfo.page)} of ${formatNumber(pageInfo.pageCount)}`;
  if (total === 0) return 'No rows';
  if (pageSize === undefined) {
    return `Page ${formatNumber(pageInfo.page)} of ${formatNumber(pageInfo.pageCount)} · ${formatNumber(total)} rows`;
  }
  const first = (pageInfo.page - 1) * pageSize + 1;
  const last = Math.min(total, first + rowsOnPage - 1);
  return `Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)} rows`;
}

function SortIcon({ active, direction }: { active: boolean; direction?: SortDirection }) {
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <Icon
      aria-hidden="true"
      className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
    />
  );
}
