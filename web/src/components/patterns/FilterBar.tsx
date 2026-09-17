'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { UrlStateShape, UrlStateValue } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * §3.3 / §10.1 FilterBar — search, filter controls, and a saved-view slot,
 * driven by URL state so a copied link reproduces the view.
 *
 * Filter state is `UrlStateShape` from `@/lib/url-state`, which is the same
 * vocabulary `useUrlState` encodes into the query string. The wiring is two
 * lines at the call site, and `FilterBar` stays a controlled component so a
 * screen can read the filters it needs for its fetch:
 *
 * ```tsx
 * const FILTER_DEFAULTS = { q: '', status: 'all', owner: 'all', attention: false };
 *
 * const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
 *
 * <FilterBar
 *   defaults={FILTER_DEFAULTS}   // stable reference: not an inline literal
 *   value={filters}
 *   onChange={setFilters}        // writes the URL
 *   controls={[
 *     { kind: 'select', key: 'status', label: 'Status', options: STATUS_OPTIONS },
 *     { kind: 'select', key: 'owner', label: 'Owner', options: OWNER_OPTIONS },
 *     { kind: 'toggle', key: 'attention', label: 'Needs attention' },
 *   ]}
 *   savedViews={<SavedViewPicker />}
 * />
 * ```
 *
 * Search is debounced (§10.1: filter changes are local state with no hidden
 * paid work behind them, but a request per keystroke would still burn the
 * global 100 req/min budget), and an exact `Enter`/blur flushes immediately.
 *
 * `defaults` is required because it is what makes the active-filter chips
 * possible: a chip can only say "you are looking at a filtered list" if it
 * knows which values differ from unfiltered.
 */

/** One option in a select filter; `value` is what lands in the URL. */
export interface FilterOption {
  value: string;
  label: string;
}

/**
 * A filter control. Every `key` must exist in the screen's `defaults` object —
 * `useUrlState` only decodes keys it was told about, so an unknown key would
 * silently vanish from a copied link.
 */
export type FilterControl =
  | {
      kind: 'select';
      key: string;
      label: string;
      options: FilterOption[];
      /** Label for the "no filter" option. Its value is always `all`, which is
       *  therefore the expected default for this key. */
      allLabel?: string;
    }
  | {
      kind: 'text';
      key: string;
      label: string;
      placeholder?: string;
    }
  | {
      kind: 'toggle';
      key: string;
      label: string;
      /** Extra explanation, e.g. "Only projects with an open blocker". */
      description?: string;
    };

/** The `all` sentinel used by select controls for "no filter applied". */
export const FILTER_ALL = 'all';

export interface FilterBarProps<T extends UrlStateShape = UrlStateShape> {
  /** The unfiltered defaults, matching the object given to `useUrlState`.
   *  Must be a stable reference (a module constant or a `useMemo`). */
  defaults: T;
  value: T;
  /**
   * Patches the filter state. Typed as `Partial<T>` so `useUrlState`'s setter
   * can be passed directly — including its optional `{ push }` second
   * argument, which filters should normally leave off so a filter change
   * replaces rather than stacks history entries.
   */
  onChange: (patch: Partial<T>, opts?: { push?: boolean }) => void;
  controls: FilterControl[];
  /** The key the search box writes to. Defaults to `q`. */
  searchKey?: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Hide the search box entirely for a bar that only filters. */
  hideSearch?: boolean;
  /** Debounce for the search box, in milliseconds. Defaults to 300. */
  searchDebounceMs?: number;
  /** The saved-view slot: a picker, a "save this view" control, or both. */
  savedViews?: ReactNode;
  /** Trailing slot for read-only context, e.g. "Showing 24 of 310". */
  summary?: ReactNode;
  className?: string;
}

function valuesEqual(a: UrlStateValue, b: UrlStateValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/** The human label for an active filter value, for the chip row. */
function describeValue(control: FilterControl | undefined, raw: UrlStateValue): string {
  if (Array.isArray(raw)) return raw.join(', ');
  const value = raw === undefined ? '' : String(raw);
  if (control?.kind === 'select') {
    if (value === FILTER_ALL) return 'All';
    return control.options.find((option) => option.value === value)?.label ?? value;
  }
  if (control?.kind === 'toggle') return value === 'true' ? 'Yes' : 'No';
  // Free text (or a key with no declared control): show the value itself.
  return value;
}

/**
 * A computed-key patch cannot be *proven* to satisfy `Partial<T>`, so these
 * are asserted. The keys are not free-form: `useUrlState` only decodes keys
 * declared in `defaults`, which is why the props require every control key to
 * appear there.
 *
 * Declared at module scope so it is referentially stable — it is used inside
 * the debounce effect, where a per-render identity would restart the timer on
 * every parent render and the search would never flush.
 */
function asPatch<T extends UrlStateShape>(patch: UrlStateShape): Partial<T> {
  return patch as Partial<T>;
}

/**
 * The filter row for a library/portfolio screen: a debounced search box, the
 * declared filter controls, chips for whatever is currently filtering the
 * list, a clear-all control, and the saved-view slot.
 */
export function FilterBar<T extends UrlStateShape>({
  defaults,
  value,
  onChange,
  controls,
  searchKey = 'q',
  searchLabel = 'Search',
  searchPlaceholder,
  hideSearch = false,
  searchDebounceMs = 300,
  savedViews,
  summary,
  className,
}: FilterBarProps<T>) {
  // The parent may not memoize onChange; hold it in a ref so an unrelated
  // re-render cannot restart (and starve) the debounce timer.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const urlSearchValue = String(value[searchKey] ?? '');
  const [query, setQuery] = useState(urlSearchValue);
  const lastEmitted = useRef(urlSearchValue);

  // Follow the URL when it changes from outside this box — a chip removal, the
  // back button, or a saved view being applied.
  useEffect(() => {
    if (urlSearchValue !== lastEmitted.current) {
      lastEmitted.current = urlSearchValue;
      setQuery(urlSearchValue);
    }
  }, [urlSearchValue]);

  const flushSearch = (next: string) => {
    if (next === lastEmitted.current) return;
    lastEmitted.current = next;
    onChangeRef.current(asPatch<T>({ [searchKey]: next }));
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query === lastEmitted.current) return;
      lastEmitted.current = query;
      onChangeRef.current(asPatch<T>({ [searchKey]: query }));
    }, searchDebounceMs);
    return () => clearTimeout(timer);
  }, [query, searchDebounceMs, searchKey]);

  const controlByKey = new Map(controls.map((control) => [control.key, control]));

  const activeFilters: { key: string; label: string; description: string }[] = [];
  if (!hideSearch && urlSearchValue) {
    activeFilters.push({
      key: searchKey,
      label: searchLabel,
      description: `“${urlSearchValue}”`,
    });
  }
  for (const control of controls) {
    const current = value[control.key];
    const fallback = defaults[control.key];
    if (valuesEqual(current, fallback)) continue;
    activeFilters.push({
      key: control.key,
      label: control.label,
      description: describeValue(controlByKey.get(control.key), current),
    });
  }

  const clearKeys = activeFilters.map((filter) => filter.key);

  return (
    <div className={cn('space-y-3', className)}>
      <div
        role="search"
        aria-label="Filters"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3"
      >
        {!hideSearch && (
          <div className="min-w-[12rem] flex-1 space-y-1.5">
            <Label htmlFor="filter-bar-search" className="text-meta text-muted-foreground">
              {searchLabel}
            </Label>
            <div className="relative">
              <Input
                id="filter-bar-search"
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                className="pr-8"
                onChange={(event) => setQuery(event.target.value)}
                onBlur={() => flushSearch(query)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    flushSearch(query);
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setQuery('');
                    flushSearch('');
                  }}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {controls.map((control) => {
          const id = `filter-${control.key}`;
          if (control.kind === 'select') {
            const current = value[control.key];
            const selected = current === undefined ? FILTER_ALL : String(current);
            // Radix only fills a childless SelectValue once its items have
            // mounted, which never happens for a filter the user has not
            // opened. The label is computed here so the trigger is always
            // correct — including on the server's first render.
            const selectedLabel =
              selected === FILTER_ALL
                ? (control.allLabel ?? 'All')
                : (control.options.find((option) => option.value === selected)?.label ??
                  selected);
            return (
              <div key={control.key} className="min-w-[10rem] space-y-1.5">
                <Label htmlFor={id} className="text-meta text-muted-foreground">
                  {control.label}
                </Label>
                <Select
                  value={selected}
                  onValueChange={(next) => onChange(asPatch<T>({ [control.key]: next }))}
                >
                  <SelectTrigger id={id}>
                    <SelectValue>{selectedLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FILTER_ALL}>{control.allLabel ?? 'All'}</SelectItem>
                    {control.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          }

          if (control.kind === 'text') {
            return (
              <div key={control.key} className="min-w-[10rem] space-y-1.5">
                <Label htmlFor={id} className="text-meta text-muted-foreground">
                  {control.label}
                </Label>
                <Input
                  id={id}
                  value={String(value[control.key] ?? '')}
                  placeholder={control.placeholder}
                  onChange={(event) => onChange(asPatch<T>({ [control.key]: event.target.value }))}
                />
              </div>
            );
          }

          const checked = value[control.key] === true;
          return (
            <div key={control.key} className="flex items-start gap-2 pb-1.5">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(next) => onChange(asPatch<T>({ [control.key]: next === true }))}
              />
              <div className="space-y-0.5">
                <Label htmlFor={id} className="text-table font-normal">
                  {control.label}
                </Label>
                {control.description && (
                  <p className="text-meta text-muted-foreground">{control.description}</p>
                )}
              </div>
            </div>
          );
        })}

        {savedViews && <div className="ml-auto flex items-end gap-2">{savedViews}</div>}
      </div>

      {(activeFilters.length > 0 || summary) && (
        <div className="flex flex-wrap items-center gap-2">
          {activeFilters.map((filter) => (
            <span
              key={filter.key}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5 text-meta text-foreground"
            >
              <span className="text-muted-foreground">{filter.label}:</span>
              {filter.description}
              <button
                type="button"
                aria-label={`Remove the ${filter.label} filter`}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  // Reset to the default rather than deleting the key, so the
                  // URL and the decoded state stay in agreement.
                  if (filter.key === searchKey) {
                    setQuery('');
                    lastEmitted.current = '';
                  }
                  onChange(asPatch<T>({ [filter.key]: defaults[filter.key] }));
                }}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
          {activeFilters.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery('');
                lastEmitted.current = '';
                const reset: UrlStateShape = {};
                for (const key of clearKeys) reset[key] = defaults[key];
                onChange(asPatch<T>(reset));
              }}
            >
              Clear all filters
            </Button>
          )}
          {/* §4.5: the summary counts change as filters change, so it is a
              live region — a reader using a screen reader is told the result
              count changed rather than having to re-read the list. */}
          {summary && (
            <span
              role="status"
              aria-live="polite"
              className="ml-auto text-meta text-muted-foreground"
            >
              {summary}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
