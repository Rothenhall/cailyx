'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { decodeUrlState, encodeUrlState, type UrlStateShape } from '@/lib/url-state';

/**
 * Keeps a screen's filters/selected run/selected tab in the URL, per
 * design_plan.md §3.2 and §10.3: a copied link must reproduce the same view.
 *
 * Usage:
 * ```ts
 * const [state, setState] = useUrlState({ status: 'all', owner: 'all', tab: 'overview' });
 * setState({ status: 'blocked' }); // merges, pushes a new URL, keeps other keys
 * ```
 *
 * Navigation replaces history by default (filter changes should not pile up
 * "back" entries); pass `push: true` for state changes that are a real
 * navigation step (e.g. selecting a different run to view).
 */
export function useUrlState<T extends UrlStateShape>(
  defaults: T,
): [T, (patch: Partial<T>, opts?: { push?: boolean }) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => decodeUrlState(searchParams, defaults), [searchParams, defaults]);

  const setState = useCallback(
    (patch: Partial<T>, opts: { push?: boolean } = {}) => {
      const next = { ...state, ...patch } as T;
      const params = encodeUrlState(next, defaults, searchParams);
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (opts.push) router.push(url);
      else router.replace(url);
    },
    [state, defaults, searchParams, pathname, router],
  );

  return [state, setState];
}
